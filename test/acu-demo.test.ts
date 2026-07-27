import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startProxy, type ProxyHandle } from "../src/proxy.js";

type MockCall = { model?: string; stream?: boolean; prompt?: string };

let mockServer: Server;
let mockBaseUrl = "";
let proxy: ProxyHandle;
let oldHome: string | undefined;
let oldLedgerDir: string | undefined;
let oldOpenRouterBaseUrl: string | undefined;
let tmpHome = "";
const calls: MockCall[] = [];
const DEMO_TOKEN = "test-demo-token";
const BASIC_AUTH = `Basic ${Buffer.from(`demo:${DEMO_TOKEN}`).toString("base64")}`;

function completion(model: string, content: string) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

function startMockUpstream(): Promise<void> {
  mockServer = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      model?: string;
      stream?: boolean;
      messages?: Array<{ role: string; content: string }>;
    };
    const prompt = body.messages?.map((message) => message.content).join("\n") || "";
    calls.push({ model: body.model, stream: body.stream, prompt });

    if (prompt.includes("force quality fallback") && calls.filter((call) => call.prompt?.includes("force quality fallback")).length === 1) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(completion(body.model || "unknown", "not json")));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    const content = prompt.includes("JSON") || prompt.includes("quality fallback")
      ? JSON.stringify({ ok: true, model: body.model })
      : "ok";
    res.end(JSON.stringify(completion(body.model || "unknown", content)));
  });

  return new Promise((resolve) => {
    mockServer.listen(0, "127.0.0.1", () => {
      const port = (mockServer.address() as AddressInfo).port;
      mockBaseUrl = `http://127.0.0.1:${port}/v1`;
      resolve();
    });
  });
}

async function readFrontend(): Promise<string> {
  return readFile(join(process.cwd(), "public", "index.html"), "utf8");
}

async function readProxySource(): Promise<string> {
  return readFile(join(process.cwd(), "src", "proxy.ts"), "utf8");
}

async function loadApiPrefixHelper(): Promise<{
  resolve: (pathname: string, origin: string) => string;
  assertSafeTarget: (pathname: string, target: string) => void;
}> {
  const source = await readFile(join(process.cwd(), "public", "acu-api-prefix.js"), "utf8");
  const sandbox: Record<string, unknown> = {};
  runInNewContext(source, sandbox);
  return sandbox.AcuApiPrefix as {
    resolve: (pathname: string, origin: string) => string;
    assertSafeTarget: (pathname: string, target: string) => void;
  };
}

describe("ACU Router demo reliability", () => {
  beforeAll(async () => {
    oldHome = process.env.HOME;
    oldLedgerDir = process.env.ACU_LEDGER_DIR;
    oldOpenRouterBaseUrl = process.env.OPENROUTER_BASE_URL;
    tmpHome = await mkdtemp(join(tmpdir(), "acu-demo-"));
    process.env.HOME = tmpHome;
    process.env.ACU_LEDGER_DIR = join(tmpHome, "ledger");
    await startMockUpstream();
    process.env.OPENROUTER_BASE_URL = mockBaseUrl;
    proxy = await startProxy({
      apiKey: "test-openrouter-key",
      proxyApiKey: "test-proxy-key",
      proxyBaseUrl: mockBaseUrl,
      port: 0,
      cacheConfig: { enabled: false },
      demoAccessToken: DEMO_TOKEN,
    });
  });

  afterAll(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => mockServer?.close(() => resolve()));
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldLedgerDir === undefined) delete process.env.ACU_LEDGER_DIR;
    else process.env.ACU_LEDGER_DIR = oldLedgerDir;
    if (oldOpenRouterBaseUrl === undefined) delete process.env.OPENROUTER_BASE_URL;
    else process.env.OPENROUTER_BASE_URL = oldOpenRouterBaseUrl;
    if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
  });

  it("chat completion returns acu_trace", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", Authorization: BASIC_AUTH },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Say ok." }],
        max_tokens: 50,
        cache: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { acu_trace?: Record<string, unknown> };
    expect(body.acu_trace).toMatchObject({
      baseline_model: "claude-opus-4-7",
      attempt_count: 1,
      fallback_used: false,
      quality_fallback_used: false,
      validator: "none",
    });
    expect(typeof body.acu_trace?.estimated_cost).toBe("number");
  });

  it("repairs a deterministic JSON format failure with the same model", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", Authorization: BASIC_AUTH },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Return JSON for force quality fallback." }],
        response_format: { type: "json_object" },
        max_tokens: 50,
        cache: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { acu_trace?: Record<string, unknown> };
    expect(body.acu_trace).toMatchObject({
      validator_result: "pass",
      validator: "json_validator",
      validator_reason: "Valid JSON",
      quality_fallback_used: false,
      format_repair_used: true,
      format_repair_succeeded: true,
      fallback_used: false,
      attempt_count: 2,
    });
  });

  it("ledger summary counts cost, baseline, savings, and fallback", async () => {
    const res = await fetch(`${proxy.baseUrl}/ledger/summary?days=1`, {
      headers: { Authorization: BASIC_AUTH },
    });
    expect(res.status).toBe(200);
    const summary = await res.json() as {
      total_requests: number;
      total_cost: number;
      baseline_cost: number;
      savings: number;
      total_baseline_cost: number;
      total_savings: number;
      fallback_rate: number;
    };

    expect(summary.total_requests).toBeGreaterThanOrEqual(2);
    expect(summary.total_cost).toBeGreaterThan(0);
    expect(summary.total_baseline_cost).toBeGreaterThan(0);
    expect(summary.total_savings).toBeCloseTo(summary.total_baseline_cost - summary.total_cost, 12);
    expect(summary.baseline_cost).toBe(summary.total_baseline_cost);
    expect(summary.savings).toBe(summary.total_savings);
    expect(summary.fallback_rate).toBe(0);
  });

  it("does not run json validator for table-only prompts that reject JSON", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: BASIC_AUTH },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "请用表格列出三个优点，不要输出 JSON" }],
        max_tokens: 40,
        cache: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { acu_trace?: { validator: string; validator_result: string } };
    expect(body.acu_trace?.validator).toBe("none");
    expect(body.acu_trace?.validator_result).toBe("not_applicable");
  });

  it("supports /acu-router and /acu-router-dev prefixes", async () => {
    for (const prefix of ["/acu-router", "/acu-router-dev"]) {
      const health = await fetch(`${proxy.baseUrl}${prefix}/health`);
      expect(health.status, prefix).toBe(200);
      const models = await fetch(`${proxy.baseUrl}${prefix}/v1/models`);
      expect(models.status, prefix).toBe(200);
    }

    const chat = await fetch(`${proxy.baseUrl}/acu-router/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", Authorization: BASIC_AUTH },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Say ok via prefix." }],
        max_tokens: 50,
        cache: false,
      }),
    });
    expect(chat.status).toBe(200);
    expect((await chat.json() as { acu_trace?: unknown }).acu_trace).toBeTruthy();

    const ledger = await fetch(`${proxy.baseUrl}/acu-router/ledger/summary?days=1`, {
      headers: { Authorization: BASIC_AUTH },
    });
    expect(ledger.status).toBe(200);
  });

  it("serves the demo page through basic auth", async () => {
    const denied = await fetch(`${proxy.baseUrl}/acu-router/`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Basic");

    const allowed = await fetch(`${proxy.baseUrl}/acu-router/`, {
      headers: { Authorization: BASIC_AUTH },
    });
    expect(allowed.status).toBe(200);
    const html = await allowed.text();
    expect(html).toContain("模型能力与成本决策说明");
    expect(html).toContain("acu-integrated.js");
  });

  it("rejects unauthenticated destructive demo requests", async () => {
    const stats = await fetch(`${proxy.baseUrl}/stats`, { method: "DELETE" });
    expect(stats.status).toBe(401);

    const ledger = await fetch(`${proxy.baseUrl}/ledger`, { method: "DELETE" });
    expect(ledger.status).toBe(401);
  });

  it("integrated frontend consumes the ACU trace without embedding credentials", async () => {
    const html = await readFrontend();
    const main = await readFile(join(process.cwd(), "public", "acu-main.js"), "utf8");
    const integrated = await readFile(join(process.cwd(), "public", "acu-integrated.js"), "utf8");
    expect(html).toContain("acu-decision-module");
    expect(html).toContain("当前任务最高预计得分模型");
    expect(html).toContain("全部备选");
    expect(html).toContain("<span class=\"num\">04</span>");
    expect(html).toContain("<span class=\"num\">05</span>");
    expect(html).toContain("<span class=\"num\">06</span>");
    expect(html).toContain("Cost & Quality Ledger / 最近请求");
    expect(html).toContain("Model Catalog");
    expect(html).toContain("id=\"models-body\"");
    expect(html).not.toContain("真实数据闭环");
    expect(html.match(/id="feedback-row"/g)).toHaveLength(1);
    expect(main).toContain("/acu/api/plan");
    expect(main).toContain("acu_plan_id: plan.planId");
    expect(main).toContain("window.dispatchEvent(new CustomEvent('acu:evaluation'");
    expect(main).toContain("body.appendChild(row)");
    expect(main).toContain("Promise.allSettled");
    expect(main).toContain("exhaustedWithoutVisibleOutput");
    expect(main).toContain("已自动重试，成本含两次调用");
    expect(main).not.toContain("推理过程耗尽");
    expect(main).toContain("reasoning: 4096");
    expect(main).not.toContain("reasoning: 1200");
    expect(main).toContain("estimatedOutputTokensForTask");
    expect(main).toContain("planTask(messages, spec.threshold / 100, expectedOutputTokens)");
    expect(main).toContain("chatComplete(ROUTER_MODEL, messages, spec.threshold / 100, { acu_plan_id: plan.planId })");
    expect(main).not.toContain("max_tokens: maxTokens");
    expect(main).not.toContain("element.textContent = text || '(empty)'");
    expect(main).not.toContain("BASELINE_MODEL");
    expect(main).not.toContain("localStorage");
    expect(html).not.toContain("acu_demo_key");
    expect(html).not.toContain("demo_key");
    expect(html).not.toContain("X-ACU-Demo-Key");
    expect(integrated).toContain("function visibleModelIds()");
    expect(integrated).toContain("ACU推荐");
    expect(integrated).toContain("实际执行");
    expect(integrated).toContain("质量上界");
    expect(integrated).toContain("推荐模型${reason}，已切换");
    expect(integrated).toContain("质量复核后升级");
    expect(integrated).toContain("state.locked.size >= 3");
    expect(integrated).not.toContain("样本不足");
    expect(integrated).not.toContain("证据等级");
    expect(integrated).toContain("function displayLatencyMs");
  });

  it("resolves production and Dev API prefixes without allowing Dev to call production", async () => {
    const helper = await loadApiPrefixHelper();
    expect(helper.resolve("/acu-router-dev/", "https://example.test")).toBe("https://example.test/acu-router-dev");
    expect(helper.resolve("/acu-router/", "https://example.test")).toBe("https://example.test/acu-router");
    expect(() => helper.assertSafeTarget(
      "/acu-router-dev/acu",
      "https://example.test/acu-router/v1/chat/completions",
    )).toThrow("Dev page attempted to call production API.");
    expect(() => helper.assertSafeTarget(
      "/acu-router-dev/acu",
      "https://example.test/acu-router-dev/v1/chat/completions",
    )).not.toThrow();
  });

  it("does not add demo-only rate limiting on top of auth", async () => {
    const source = await readProxySource();
    expect(source).not.toContain("DEMO_RATE_LIMIT_PER_MINUTE");
    expect(source).not.toContain("enforceDemoRateLimit");
    expect(source).not.toContain("demoRateLimits");
  });
});
