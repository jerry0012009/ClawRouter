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
        messages?: Array<{ content?: string }>;
      };
      receivedModels.push(body.model);
      if (body.model === "deepseek-v4-flash") {
        const visible = JSON.stringify(body.messages);
        const content = visible.includes("JUDGE_FAILURE")
          ? "not valid judge json"
          : JSON.stringify({
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
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-phase2a",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
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
    expect(await page.text()).toContain("请求难度与模型估算达标率");

    const response = await fetch(`${proxy.baseUrl}/acu/api/catalog`, {
      headers: { Authorization: AUTHORIZATION },
    });
    expect(response.status).toBe(200);
    const catalog = await response.json() as { models: unknown[]; curves: Record<string, unknown[]> };
    expect(catalog.models.length).toBeGreaterThanOrEqual(8);
    expect(Object.values(catalog.curves).every((curve) => curve.length === 101)).toBe(true);
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
      judgeStatus: string;
      difficultyScore: number;
      recommendation: { recommended: { modelId: string; expectedTotalCost: number } };
    };
    expect(evaluation.judgeStatus).toBe("success");
    expect(evaluation.difficultyScore).toBeCloseTo(14, 10);
    expect(evaluation.recommendation.recommended.modelId).toBeTruthy();
    expect(evaluation.recommendation.recommended.expectedTotalCost).toBeGreaterThan(0);
  });

  it("routes an auto request through the Judge without a Completion call to the Judge model", async () => {
    receivedModels.length = 0;
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
      acu_trace?: { acu_demo?: { judgeStatus: string }; selected_model?: string };
    };
    expect(payload.acu_trace?.acu_demo?.judgeStatus).toBe("success");
    expect(receivedModels[0]).toBe("deepseek-v4-flash");
    expect(receivedModels).toHaveLength(2);
    expect(receivedModels[1]).toBe(payload.acu_trace?.selected_model);
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
