import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AcuJudgeClient, parseJudgeResult } from "../src/acu/judge.js";
import { readAcuRuntimeConfig } from "../src/acu/config.js";
import { createAcuJudgeRunner } from "../src/alpha/judge-runner.js";

const validJudgePayload = {
  difficulty_score_raw: 42,
  factors: {
    reasoning_depth: 4.2,
    task_scope: 4.2,
    constraint_density: 4.2,
    tool_dependency: 4.2,
    verification_burden: 4.2,
    context_burden: 4.2,
  },
  p_low: 0.2,
  p_mid: 0.6,
  p_mid_high: 0.15,
  p_high: 0.05,
  confidence: 0.9,
  signals: ["local_change"],
  explanation: "Local coding task.",
  webIntent: "not_required",
  webIntentConfidence: 0.98,
  webIntentReason: "The task only needs the local workspace.",
  webIntentEvidence: ["local_or_code_context"],
};

function judgeResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    id: "judge-fixture",
    model: "mimo-v2.5-pro",
    choices: [{ message: { content: JSON.stringify(validJudgePayload) } }],
    usage: { prompt_tokens: 1_000, completion_tokens: 100 },
    ...overrides,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function config() {
  const cachePath = `/tmp/acu-rc22-judge-${randomUUID()}.json`;
  return readAcuRuntimeConfig({
    enabled: true,
    apiKey: "primary-fixture",
    allowMock: true,
    judgeModel: "mimo-v2.5-pro",
    judgeProvider: "xiaomi_mimo",
    judgeBaseUrl: "https://mimo.invalid/v1",
    backupJudgeModel: "deepseek-v4-flash",
    backupJudgeProvider: "closeai",
    backupJudgeBaseUrl: "https://closeai.invalid/v1",
    backupApiKey: "backup-fixture",
    cachePath,
  });
}

function runner(primaryFetch: typeof fetch, backupFetch: typeof fetch) {
  const runtime = config();
  const primary = new AcuJudgeClient(runtime, primaryFetch);
  const backup = new AcuJudgeClient({
    ...runtime,
    judgeModel: "deepseek-v4-flash",
    judgeProvider: "closeai",
    judgeBaseUrl: "https://closeai.invalid/v1",
    apiKey: "backup-fixture",
    cachePath: runtime.cachePath?.replace(/\.json$/, "-backup.json"),
  }, backupFetch);
  return createAcuJudgeRunner({
    config: runtime,
    client: primary,
    backupClient: backup,
    backupCashCnyPerNominalUsd: 7.2,
    rulesDecision: {
      model: "fixture", tier: "SIMPLE", confidence: 1, method: "rules",
      reasoning: "fixture", costEstimate: 0, baselineCost: 0, savings: 0,
    },
  });
}

const runInput = {
  messages: [{ role: "user", content: "Fix one local line." }],
  tools: [],
  trigger: "new_task" as const,
  contextHash: "fixture-context",
  webIntentFallbackInput: { recentUserInputs: ["Fix one local line."] },
  rawNative: {
    stateMetadata: { sessionId: "session-fixture", phase: "execution", trigger: "new_task" },
    rawRequest: JSON.stringify({ model: "acu-auto", input: "Fix one local line." }),
  },
};

describe("RC2.2 Judge cutover", () => {
  it("supports a one-step rollback to the configured DeepSeek backup", () => {
    const previous = process.env.ACU_JUDGE_ROLLBACK_TO_BACKUP;
    process.env.ACU_JUDGE_ROLLBACK_TO_BACKUP = "true";
    try {
      expect(config()).toMatchObject({
        judgeModel: "deepseek-v4-flash",
        judgeProvider: "closeai",
        judgeBaseUrl: "https://closeai.invalid/v1",
        backupJudgeModel: undefined,
      });
    } finally {
      if (previous === undefined) delete process.env.ACU_JUDGE_ROLLBACK_TO_BACKUP;
      else process.env.ACU_JUDGE_ROLLBACK_TO_BACKUP = previous;
    }
  });

  it.each([79, 81, 256, 4096])("accepts an explanation of %i Unicode code points", (length) => {
    const result = parseJudgeResult(JSON.stringify({ ...validJudgePayload, explanation: "x".repeat(length) }));
    expect(Array.from(result.explanation)).toHaveLength(length);
    expect(result.explanationNormalized).toBe(false);
    expect(result.originalExplanationLength).toBe(length);
  });

  it("preserves a long explanation without invalidating routing fields", () => {
    const result = parseJudgeResult(JSON.stringify({ ...validJudgePayload, explanation: "界".repeat(4096) }));
    expect(Array.from(result.explanation)).toHaveLength(4096);
    expect(result.explanationNormalized).toBe(false);
    expect(result.originalExplanationLength).toBe(4096);
    expect(result.difficultyIndex).toBeGreaterThan(0);
    expect(result.webIntent).toBe("not_required");
  });

  it.each([
    ["array", ["reason", { detail: true }], '["reason",{"detail":true}]'],
    ["object", { reason: "fixture", weight: 2 }, '{"reason":"fixture","weight":2}'],
    ["null", null, ""],
  ])("normalizes non-critical %s explanation without invalidating the evaluation", (type, value, expected) => {
    const result = parseJudgeResult(JSON.stringify({ ...validJudgePayload, explanation: value }));
    expect(result.explanation).toBe(expected);
    expect(result.explanationNormalized).toBe(true);
    expect(result.originalExplanationType).toBe(type);
  });

  it("accepts an unbounded webIntentReason string while retaining strict routing fields", () => {
    const reason = "外部证据".repeat(2_000);
    const result = parseJudgeResult(JSON.stringify({ ...validJudgePayload, webIntentReason: reason }));
    expect(result.webIntentReason).toBe(reason);
    expect(result.difficultyIndex).toBeGreaterThan(0);
  });

  it("sends a complete roughly 200k-token native request without rewriting or truncation", async () => {
    const early = "EARLY_GOAL";
    const plan = "PLAN_STATE";
    const toolResult = "TOOL_RESULT";
    const latest = "LATEST_GOAL";
    const filler = "a".repeat(790_000);
    const rawRequest = JSON.stringify({
      model: "acu-auto",
      input: [early, filler, { type: "function_call_output", output: toolResult }, plan, latest],
      tools: [{ type: "function", name: "exec_command", description: "fixture tool" }],
    });
    let postedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return judgeResponse();
    });
    const client = new AcuJudgeClient(config(), fetchMock);
    const result = await client.judge([], [], true, {
      stateMetadata: { sessionId: "session-long", phase: "planning", trigger: "plan_started" },
      rawRequest,
    });
    const messages = postedBody?.messages as Array<{ role: string; content: string }>;
    const rawSection = messages[1].content.split("[RAW_NATIVE_API_REQUEST]\n")[1];
    expect(rawSection).toBe(rawRequest);
    expect(rawSection).toContain(early);
    expect(rawSection).toContain(plan);
    expect(rawSection).toContain(toolResult);
    expect(rawSection).toContain(latest);
    expect(rawSection.match(/fixture tool/g)).toHaveLength(1);
    expect(result.rawRequestBytes).toBe(Buffer.byteLength(rawRequest, "utf8"));
    expect(result.rawRequestTokenEstimate).toBeGreaterThan(190_000);
    expect(result.contextTruncated).toBe(false);
    expect(result.judgeContextSource).toBe("raw_native_request_v1");
  });

  it("observes but does not locally reject a roughly 700k-token native request", async () => {
    const rawRequest = JSON.stringify({ model: "acu-auto", input: `EARLY_${"a".repeat(2_800_000)}_LATEST` });
    let posted = "";
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      posted = String(init?.body);
      return judgeResponse();
    });
    const result = await new AcuJudgeClient(config(), fetchMock).judge([], [], true, {
      stateMetadata: { sessionId: "session-700k", phase: "execution", trigger: "new_task" },
      rawRequest,
    });
    const messages = (JSON.parse(posted) as { messages: Array<{ content: string }> }).messages;
    expect(messages[1].content.split("[RAW_NATIVE_API_REQUEST]\n")[1]).toBe(rawRequest);
    expect(result.rawRequestTokenEstimate).toBeGreaterThanOrEqual(700_000);
    expect(result.contextTruncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves an upstream context error and does not call an unverified-larger Backup", async () => {
    const upstreamBody = JSON.stringify({
      error: { type: "context_length_exceeded", message: "Maximum context length exceeded by 17 tokens" },
    });
    const primaryFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(upstreamBody, {
      status: 400,
      headers: { "content-type": "application/json", "x-request-id": "mimo-context-fixture" },
    }));
    const backupFetch = vi.fn<typeof fetch>();
    const result = await runner(primaryFetch, backupFetch).run(runInput);
    expect(backupFetch).not.toHaveBeenCalled();
    expect(result.terminalError?.type).toBe("judge_context_length_exceeded");
    expect(result.errorCategory).toBe("context_length_exceeded");
    expect(result.attempts[0]).toMatchObject({
      errorCategory: "context_length_exceeded",
      rawResponseBody: upstreamBody,
      backupEligible: false,
      backupReason: "backup_context_not_verified_larger_than_primary",
      upstreamRequestId: "mimo-context-fixture",
    });
  });

  it("preserves the raw HTTP 200 body and exact JSON parser error before one Backup", async () => {
    const raw = "not-json from fixture";
    const backupFetch = vi.fn<typeof fetch>().mockResolvedValue(judgeResponse({ model: "deepseek-v4-flash" }));
    const result = await runner(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(raw, { status: 200, headers: { "x-request-id": "bad-json" } })),
      backupFetch,
    ).run(runInput);
    expect(backupFetch).toHaveBeenCalledTimes(1);
    expect(result.attempts[0]).toMatchObject({
      errorCategory: "invalid_response",
      rawResponseBody: raw,
      parserExceptionType: "SyntaxError",
      backupEligible: true,
      backupReason: "primary_schema_or_json_invalid",
    });
    expect(result.attempts[0].parserExceptionMessage).toMatch(/JSON/);
  });

  it.each([
    ["non_json", () => new Response("not-json", { status: 200 })],
    ["http_429", () => new Response("rate limited", { status: 429 })],
    ["http_500", () => new Response("failed", { status: 500 })],
    ["timeout", () => Promise.reject(new DOMException("timed out", "AbortError"))],
  ])("uses DeepSeek Backup once for %s", async (_name, primaryResult) => {
    const primaryFetch = vi.fn<typeof fetch>().mockImplementation(async () => primaryResult() as Awaited<ReturnType<typeof fetch>>);
    const backupFetch = vi.fn<typeof fetch>().mockResolvedValue(judgeResponse({
      model: "deepseek-v4-flash",
    }));
    const result = await runner(primaryFetch, backupFetch).run(runInput);
    expect(primaryFetch).toHaveBeenCalledTimes(1);
    expect(backupFetch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("backup_live");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.map((attempt) => attempt.role)).toEqual(["primary", "backup"]);
  });

  it("does not invoke Backup when MiMo returns a different valid Difficulty", async () => {
    const primaryFetch = vi.fn<typeof fetch>().mockResolvedValue(judgeResponse({
      choices: [{ message: { content: JSON.stringify({
        ...validJudgePayload,
        difficulty_score_raw: 87,
        p_low: 0.01,
        p_mid: 0.04,
        p_mid_high: 0.2,
        p_high: 0.75,
      }) } }],
    }));
    const backupFetch = vi.fn<typeof fetch>();
    const result = await runner(primaryFetch, backupFetch).run(runInput);
    expect(result.status).toBe("live");
    expect(result.judge.difficultyScoreRaw).toBe(87);
    expect(backupFetch).not.toHaveBeenCalled();
    expect(result.attempts).toHaveLength(1);
  });

  it("uses the versioned midpoint estimate while retaining the full PAYG equivalent", async () => {
    const result = await runner(
      vi.fn<typeof fetch>().mockResolvedValue(judgeResponse()),
      vi.fn<typeof fetch>(),
    ).run(runInput);
    expect(result.costStatus).toBe("estimated_blended");
    expect(Number(result.officialPaygEquivalentCostCny)).toBeGreaterThan(0);
    expect(Number(result.costCny)).toBeCloseTo(Number(result.officialPaygEquivalentCostCny) * 0.5, 10);
    expect(result.attempts[0]).toMatchObject({
      costStatus: "estimated_blended",
      costSource: "midpoint_openrouter_payg_and_mimo99_plan_v1",
    });
  });
});
