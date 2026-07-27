import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startProxy, type ProxyHandle } from "../src/proxy.js";

let upstream: Server;
let proxy: ProxyHandle;
let temporaryDirectory = "";
const receivedModels: string[] = [];
const receivedRequests: Array<{ model: string; enable_thinking?: boolean }> = [];
const DEMO_TOKEN = "phase2a-demo-token";
const AUTHORIZATION = `Basic ${Buffer.from(`demo:${DEMO_TOKEN}`).toString("base64")}`;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    });
  });
}

describe("Phase 2A API and RulesStrategy fallback", () => {
  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "acu-phase2a-api-"));
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        model: string;
        enable_thinking?: boolean;
        messages?: Array<{ content?: string }>;
      };
      receivedModels.push(body.model);
      receivedRequests.push({ model: body.model, enable_thinking: body.enable_thinking });
      if (body.model === "deepseek-v4-flash") {
        const visible = JSON.stringify(body.messages);
        const content = visible.includes("JUDGE_FAILURE")
          ? "not valid judge json"
          : JSON.stringify({
            difficulty_score: 14,
            p_low: 0.7,
            p_mid: 0.2,
            p_mid_high: 0.08,
            p_high: 0.02,
            confidence: 0.88,
            signals: ["bounded_change"],
            explanation: "任务边界明确，主要是一次局部修改。",
          });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content } }],
          usage: { prompt_tokens: 500, completion_tokens: 80 },
        }));
        return;
      }
      const visible = JSON.stringify(body.messages);
      const content = visible.includes("QUALITY_REPAIR_ESCALATION")
        ? body.model === "qwen3.6-plus" ? "not json" : JSON.stringify({ ok: true })
        : "ok";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-phase2a",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }));
    });
    const baseUrl = await listen(upstream);
    proxy = await startProxy({
      apiKey: "test-openrouter-key",
      proxyApiKey: "test-proxy-key",
      proxyBaseUrl: baseUrl,
      port: 0,
      demoAccessToken: DEMO_TOKEN,
      cacheConfig: { enabled: false },
      acuRuntimeConfig: {
        enabled: true,
        apiKey: "test-deepseek-key",
        judgeBaseUrl: baseUrl,
        cachePath: join(temporaryDirectory, "judge-cache.json"),
        databasePath: join(temporaryDirectory, "acu-routing.db"),
        allowForceRefresh: true,
        shadowMode: false,
      },
    });
  });

  afterAll(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("serves the ACU frontend and complete model catalog", async () => {
    const page = await fetch(`${proxy.baseUrl}/acu`, { headers: { Authorization: AUTHORIZATION } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("成本 × 质量优化演示");

    const debugPage = await fetch(`${proxy.baseUrl}/acu-debug`, { headers: { Authorization: AUTHORIZATION } });
    expect(debugPage.status).toBe(200);
    expect(await debugPage.text()).toContain("请求难度与模型价值路由");

    for (const assetPath of ["/public/acu.css", "/public/acu.js", "/public/acu-api-prefix.js", "/acu/public/acu.css", "/acu/public/acu.js", "/acu-debug/public/acu.css", "/acu-debug/public/acu.js"]) {
      const asset = await fetch(`${proxy.baseUrl}${assetPath}`, { headers: { Authorization: AUTHORIZATION } });
      expect(asset.status, assetPath).toBe(200);
    }

    const response = await fetch(`${proxy.baseUrl}/acu/api/catalog`, {
      headers: { Authorization: AUTHORIZATION },
    });
    expect(response.status).toBe(200);
    const catalog = await response.json() as { models: Array<{ modelId: string }>; curves: Record<string, unknown[]> };
    expect(catalog.models.length).toBeGreaterThanOrEqual(8);
    expect(Object.values(catalog.curves).every((curve) => curve.length === 101)).toBe(true);
    for (const fallbackId of [
      "gemini-2.5-flash", "meta-llama/llama-4-maverick", "deepseek/deepseek-chat-v3-0324",
      "meta-llama/llama-3.3-70b-instruct", "qwen/qwen3-235b-a22b",
    ]) {
      expect(catalog.models.some((model) => model.modelId === fallbackId), fallbackId).toBe(true);
      expect(catalog.curves[fallbackId], fallbackId).toHaveLength(101);
    }

    const gallery = await fetch(`${proxy.baseUrl}/acu/curves`, {
      headers: { Authorization: AUTHORIZATION },
    });
    expect(gallery.status).toBe(200);
    expect(await gallery.text()).toContain("模型难度—预计得分图集");
  });

  it("evaluates the full API context and returns a cost-aware recommendation", async () => {
    const response = await fetch(`${proxy.baseUrl}/acu/api/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTHORIZATION },
      body: JSON.stringify({
        messages: [
          { role: "system", content: "Keep changes scoped." },
          { role: "user", content: "Update one documented setting." },
        ],
        quality_target: 0.7,
        expected_output_tokens: 400,
      }),
    });
    expect(response.status).toBe(200);
    const evaluation = await response.json() as {
      requestId: string;
      judgeStatus: string;
      difficultyScore: number;
      recommendation: { recommended: { modelId: string; expectedTotalCost: number } };
    };
    expect(evaluation.judgeStatus).toBe("live");
    expect(evaluation.difficultyScore).toBeCloseTo(14, 10);
    expect(evaluation.recommendation.recommended.modelId).toBeTruthy();
    expect(evaluation.recommendation.recommended.expectedTotalCost).toBeGreaterThan(0);

    const feedback = await fetch(`${proxy.baseUrl}/acu/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTHORIZATION },
      body: JSON.stringify({ request_id: evaluation.requestId, accepted: true, rating: 5, required_upgrade: false }),
    });
    expect(feedback.status).toBe(201);
    const summary = await fetch(`${proxy.baseUrl}/acu/api/data-summary`, { headers: { Authorization: AUTHORIZATION } });
    const data = await summary.json() as { realRequestCount: number; labeledRequestCount: number; sampleNotice: string };
    expect(data.realRequestCount).toBeGreaterThanOrEqual(1);
    expect(data.labeledRequestCount).toBeGreaterThanOrEqual(1);
    expect(data.sampleNotice).toContain("样本量较小");
  });

  it("bypasses only the Judge cache when force_judge_refresh is requested", async () => {
    const body = { messages: [{ role: "user", content: "A unique cache refresh check." }], expected_output_tokens: 40 };
    const call = (force = false) => fetch(`${proxy.baseUrl}/acu/api/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTHORIZATION },
      body: JSON.stringify({ ...body, force_judge_refresh: force }),
    }).then((response) => response.json()) as Promise<{ judgeStatus: string; contextSha256: string }>;
    const first = await call();
    const cached = await call();
    const refreshed = await call(true);
    expect(first.judgeStatus).toBe("live");
    expect(cached.judgeStatus).toBe("cache_hit");
    expect(refreshed.judgeStatus).toBe("live");
    expect(new Set([first.contextSha256, cached.contextSha256, refreshed.contextSha256]).size).toBe(1);
  });

  it("routes an auto request through the Judge without a Completion call to the Judge model", async () => {
    receivedModels.length = 0;
    receivedRequests.length = 0;
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTHORIZATION },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Make one small local edit." }],
        acu_quality_target: 0.7,
        max_tokens: 100,
        cache: false,
      }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      model?: string;
      acu_trace?: {
        acu_demo?: {
          judgeStatus: string;
          actualModel?: string;
          recommendationApplied?: boolean;
          recommendation: { recommended: { modelId: string } };
        };
        selected_model?: string;
        actual_model_used?: string;
        attempts?: Array<{ model: string; status: string; latency_ms: number }>;
        latency_breakdown?: { judge_latency_ms: number; upstream_latency_ms: number; total_router_latency_ms: number };
        usage_audit?: { usageSource: string; completionTokens: number; visibleOutputTokens: number; reasoningTokens: number; usageRawKeys: string[] };
        cost_audit?: { model_call_cost: number; judge_cost: number; total_acu_cost: number };
        execution_profile_id?: string;
        thinking_mode?: string;
        request_parameter_applied?: boolean;
        upstream_model?: string;
      };
    };
    expect(payload.acu_trace?.acu_demo?.judgeStatus).toBe("live");
    expect(receivedModels[0]).toBe("deepseek-v4-flash");
    expect(receivedModels).toHaveLength(2);
    expect(receivedModels[1]).toBe(payload.acu_trace?.selected_model);
    if (receivedModels[1] === "qwen3.6-plus") {
      expect(receivedRequests[1]?.enable_thinking).toBe(false);
      expect(payload.acu_trace?.execution_profile_id).toBe("qwen3.6-plus:non-thinking");
      expect(payload.acu_trace?.thinking_mode).toBe("disabled");
      expect(payload.acu_trace?.request_parameter_applied).toBe(true);
      expect(payload.acu_trace?.usage_audit?.reasoningTokens).toBe(0);
      expect(payload.acu_trace?.upstream_model).toBe("qwen3.6-plus");
    }
    expect(payload.acu_trace?.selected_model).toBe(payload.acu_trace?.acu_demo?.recommendation.recommended.modelId);
    expect(payload.acu_trace?.actual_model_used).toBe(payload.acu_trace?.selected_model);
    expect(payload.acu_trace?.acu_demo?.actualModel).toBe(payload.acu_trace?.actual_model_used);
    expect(payload.acu_trace?.acu_demo?.recommendationApplied).toBe(true);
    expect(payload.model).toBe(payload.acu_trace?.actual_model_used);
    expect(payload.acu_trace?.attempts).toEqual([
      expect.objectContaining({ model: payload.acu_trace?.actual_model_used, status: "success" }),
    ]);
    expect(payload.acu_trace?.latency_breakdown?.total_router_latency_ms).toBeGreaterThanOrEqual(
      payload.acu_trace?.latency_breakdown?.upstream_latency_ms ?? 0,
    );
    expect(payload.acu_trace?.usage_audit?.usageSource).toBe("upstream_usage");
    expect(payload.acu_trace?.usage_audit?.completionTokens).toBe(5);
    expect(payload.acu_trace?.usage_audit?.visibleOutputTokens).toBeGreaterThan(0);
    expect(payload.acu_trace?.cost_audit?.total_acu_cost).toBeGreaterThanOrEqual(
      payload.acu_trace?.cost_audit?.model_call_cost ?? 0,
    );
  });

  it("does not write explicit baseline requests into ACU routing records", async () => {
    const summary = () => fetch(`${proxy.baseUrl}/acu/api/data-summary`, { headers: { Authorization: AUTHORIZATION } })
      .then((response) => response.json()) as Promise<{ realRequestCount: number }>;
    const before = await summary();
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTHORIZATION },
      body: JSON.stringify({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "Baseline only." }] }),
    });
    expect(response.status).toBe(200);
    expect((await summary()).realRequestCount).toBe(before.realRequestCount);
  });

  it("repairs JSON with the same model before selecting a non-decreasing quality candidate", async () => {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTHORIZATION },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "QUALITY_REPAIR_ESCALATION: 只返回合法 JSON。" }],
        response_format: { type: "json_object" }, acu_quality_target: 0.7, max_tokens: 100, cache: false,
      }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { acu_trace?: {
      actual_model_used: string; quality_fallback_used: boolean; format_repair_used: boolean;
      attempts: Array<{ model: string; attempt_type: string; status: string }>;
      acu_demo: { recommendation: { estimates: Array<{ modelId: string; predictedScore: number }> } };
    } };
    const trace = payload.acu_trace!;
    expect(trace.format_repair_used).toBe(true);
    expect(trace.quality_fallback_used).toBe(true);
    expect(trace.attempts.map((attempt) => attempt.attempt_type)).toEqual(["initial", "format_repair", "quality_upgrade"]);
    expect(trace.attempts[1]).toMatchObject({ model: "qwen3.6-plus", status: "error" });
    const scores = new Map(trace.acu_demo.recommendation.estimates.map((estimate) => [estimate.modelId, estimate.predictedScore]));
    expect(scores.get(trace.actual_model_used)!).toBeGreaterThanOrEqual(scores.get("qwen3.6-plus")!);
  });

  it("keeps the request alive and reports RulesStrategy fallback on Judge errors", async () => {
    const response = await fetch(`${proxy.baseUrl}/acu/api/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTHORIZATION },
      body: JSON.stringify({
        messages: [{ role: "user", content: "JUDGE_FAILURE: still classify this safely." }],
      }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      judgeStatus: string;
      judge: { signals: string[] };
    };
    expect(payload.judgeStatus).toBe("rules_fallback");
    expect(payload.judge.signals).toContain("rules_strategy_fallback");
  });
});
