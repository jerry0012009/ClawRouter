#!/usr/bin/env node
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAcuRuntimeConfig } from "../../src/acu/config.js";
import { AcuJudgeClient } from "../../src/acu/judge.js";
import { createAcuJudgeRunner } from "../../src/alpha/judge-runner.js";
import type { RoutingDecision } from "../../src/router/types.js";

if (!process.env.ACU_JUDGE_API_KEY?.trim()) throw new Error("ACU_JUDGE_API_KEY is required");

const temporary = await mkdtemp(join(tmpdir(), "acu-rc1-live-judge-"));
const config = readAcuRuntimeConfig({
  enabled: true,
  allowMock: true,
  cachePath: join(temporary, "real-cache.json"),
});
const rulesDecision: RoutingDecision = {
  model: "rules-safe-profile",
  tier: "COMPLEX",
  confidence: 0.8,
  method: "rules",
  reasoning: "RC1 controlled fallback validation",
  costEstimate: 0,
  baselineCost: 0,
  savings: 0,
};
const liveRunner = createAcuJudgeRunner({
  config,
  rulesDecision,
  client: new AcuJudgeClient(config),
});
const input = {
  messages: [{ role: "user", content: "RC1 live Judge cache validation: inspect a deterministic one-file bug and verify the fix." }],
  tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
  trigger: "new_task" as const,
  contextHash: "caller-context-is-recomputed-by-existing-client",
};
const live = await liveRunner.run(input);
const cached = await liveRunner.run(input);

const invalidFetch = (async () => new Response(JSON.stringify({
  id: "controlled-invalid-json",
  choices: [{ message: { content: "CONTROLLED_NON_JSON" } }],
  usage: { prompt_tokens: 12, completion_tokens: 4 },
}), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
const invalidConfig = { ...config, cachePath: join(temporary, "invalid-cache.json") };
const invalidRunner = createAcuJudgeRunner({
  config: invalidConfig,
  rulesDecision,
  client: new AcuJudgeClient(invalidConfig, invalidFetch),
});
const rulesFallback = await invalidRunner.run({ ...input, contextHash: "controlled-invalid-new-task" });
const recentEvaluation = await invalidRunner.run({
  ...input,
  trigger: "plan_finished",
  contextHash: "controlled-invalid-plan-finished",
  recentEvaluation: live,
});

console.log(JSON.stringify({
  schemaVersion: "acu-rc1-live-judge-validation-v1",
  live: {
    status: live.status,
    resultSource: live.resultSource,
    latencyMs: live.latencyMs,
    promptTokens: live.promptTokens,
    completionTokens: live.completionTokens,
    costUsd: live.costUsd,
    difficultyIndex: live.judge.difficultyIndex,
    entropy: live.entropy,
  },
  duplicateTrigger: {
    status: cached.status,
    resultSource: cached.resultSource,
    costUsd: cached.costUsd,
    sameDifficulty: cached.judge.difficultyIndex === live.judge.difficultyIndex,
  },
  controlledInvalidJson: {
    provider: "controlled_test_fetch",
    status: rulesFallback.status,
    resultSource: rulesFallback.resultSource,
    costUsd: rulesFallback.costUsd,
    nonBlockingResultPresent: Number.isFinite(rulesFallback.judge.difficultyIndex),
    errorCategory: rulesFallback.errorCategory,
  },
  recentEvaluation: {
    provider: "controlled_test_fetch",
    trigger: "plan_finished",
    status: recentEvaluation.status,
    resultSource: recentEvaluation.resultSource,
    costUsd: recentEvaluation.costUsd,
    sameDifficulty: recentEvaluation.judge.difficultyIndex === live.judge.difficultyIndex,
    errorCategory: recentEvaluation.errorCategory,
  },
}, null, 2));

if (live.status !== "live" || live.resultSource !== "upstream_live" || Number(live.costUsd) <= 0) process.exitCode = 1;
if (cached.status !== "cache_hit" || Number(cached.costUsd) !== 0) process.exitCode = 1;
if (rulesFallback.status !== "rules_fallback" || Number(rulesFallback.costUsd) !== 0) process.exitCode = 1;
if (recentEvaluation.status !== "recent_evaluation" || Number(recentEvaluation.costUsd) !== 0) process.exitCode = 1;
