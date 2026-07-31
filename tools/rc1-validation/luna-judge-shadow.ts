import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import { AcuJudgeClient, type RawNativeJudgeContext } from "../../src/acu/judge.js";
import { readAcuRuntimeConfig } from "../../src/acu/config.js";
import type { AcuDifficultyFactors, AcuJudgeResult } from "../../src/acu/types.js";

const { Client } = pg;
const PROFILE_ID = "lucen-cx006-value-dynamic:gpt-5.6-luna:responses";
const MODEL_ID = "gpt-5.6-luna";
const FACTORS: Array<keyof AcuDifficultyFactors> = [
  "reasoningDepth", "taskScope", "constraintDensity", "toolDependency", "verificationBurden", "contextBurden",
];

type HistoricalSample = {
  judge_evaluation_id: string;
  created_at: Date;
  difficulty_index: number;
  factors_json: AcuDifficultyFactors;
  web_intent: AcuJudgeResult["webIntent"];
  raw_request_token_estimate: string;
  latency_ms: number;
  actual_cost_usd: string;
  body_json: {
    rawNativeApiRequest: string;
    stateMetadata: Record<string, unknown>;
    rawRequestSha256: string;
  };
};

type ShadowSample = {
  judgeEvaluationId: string;
  createdAt: string;
  rawRequestTokenEstimate: number;
  rawRequestSha256: string;
  historical: {
    difficultyIndex: number;
    tier: string;
    factors: AcuDifficultyFactors;
    webIntent: string;
    latencyMs: number;
    effectiveCostCny: number;
  };
  luna?: {
    difficultyIndex: number;
    tier: string;
    factors: AcuDifficultyFactors;
    webIntent: string;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    nominalCostUsd: number;
    effectiveCostCny: number;
  };
  error?: { name: string; message: string };
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function tier(score: number): string {
  if (score < 27.5) return "low";
  if (score < 52.5) return "mid";
  if (score < 76.5) return "mid_high";
  return "high";
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? sorted.at(-1)!;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

async function main(): Promise<void> {
  const databaseUrl = required("ACU_SHADOW_DATABASE_URL");
  const sampleLimit = Math.max(1, Number.parseInt(process.env.ACU_SHADOW_SAMPLE_LIMIT ?? "12", 10));
  const outputPath = process.env.ACU_SHADOW_OUTPUT?.trim() || "reports/alpha-rc1/luna-judge-shadow.json";
  const database = new Client({ connectionString: databaseUrl });
  await database.connect();
  const rows = await database.query<HistoricalSample>(`
    WITH candidates AS (
      SELECT je.judge_evaluation_id, je.created_at, je.difficulty_index, je.factors_json,
             je.web_intent, je.raw_request_token_estimate, je.latency_ms, je.actual_cost_usd,
             p.body_json, ntile(4) OVER (ORDER BY je.raw_request_token_estimate) AS context_bucket
      FROM acu_judge_evaluations je
      JOIN acu_payloads p ON p.payload_id = je.input_payload_id
      WHERE je.judge_model = 'mimo-v2.5-pro'
        AND je.judge_status = 'live'
        AND je.difficulty_index IS NOT NULL
        AND p.body_json ? 'rawNativeApiRequest'
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY context_bucket ORDER BY created_at DESC) AS sample_rank
      FROM candidates
    )
    SELECT judge_evaluation_id, created_at, difficulty_index, factors_json, web_intent,
           raw_request_token_estimate, latency_ms, actual_cost_usd, body_json
    FROM ranked
    WHERE sample_rank <= CEIL($1::numeric / 4)
    ORDER BY raw_request_token_estimate DESC, created_at DESC
    LIMIT $1
  `, [sampleLimit]);
  await database.end();

  const config = readAcuRuntimeConfig({
    enabled: true,
    judgeModel: MODEL_ID,
    judgeProvider: "lucen_fixed_luna_shadow",
    judgeBaseUrl: required("ACU_SHADOW_LUNA_BASE_URL"),
    apiKey: required("ACU_SHADOW_LUNA_API_KEY"),
    timeoutMs: Number.parseInt(process.env.ACU_SHADOW_TIMEOUT_MS ?? "30000", 10),
    firstByteTimeoutMs: 0,
    maxContextTokens: 1_000_000,
    cachePath: process.env.ACU_SHADOW_CACHE_PATH ?? "/tmp/acu-luna-judge-shadow-cache.json",
  });
  const judge = new AcuJudgeClient(config);
  const samples: ShadowSample[] = [];
  for (const row of rows.rows) {
    const rawRequest = row.body_json.rawNativeApiRequest;
    const sha256 = createHash("sha256").update(rawRequest).digest("hex");
    const sample: ShadowSample = {
      judgeEvaluationId: row.judge_evaluation_id,
      createdAt: row.created_at.toISOString(),
      rawRequestTokenEstimate: Number(row.raw_request_token_estimate),
      rawRequestSha256: sha256,
      historical: {
        difficultyIndex: Number(row.difficulty_index),
        tier: tier(Number(row.difficulty_index)),
        factors: row.factors_json,
        webIntent: row.web_intent!,
        latencyMs: row.latency_ms,
        effectiveCostCny: Number(row.actual_cost_usd) * 7.2,
      },
    };
    if (sha256 !== row.body_json.rawRequestSha256) {
      sample.error = { name: "IntegrityError", message: "Persisted raw request SHA-256 does not match" };
      samples.push(sample);
      continue;
    }
    try {
      const rawNative: RawNativeJudgeContext = { rawRequest, stateMetadata: row.body_json.stateMetadata };
      const result = await judge.judge([], [], true, rawNative);
      sample.luna = {
        difficultyIndex: result.result.difficultyIndex,
        tier: tier(result.result.difficultyIndex),
        factors: result.result.factors,
        webIntent: result.result.webIntent!,
        latencyMs: result.latencyMs,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        cachedPromptTokens: result.cachedPromptTokens,
        nominalCostUsd: result.cost,
        effectiveCostCny: result.cost * 0.06,
      };
    } catch (error) {
      sample.error = {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      };
    }
    samples.push(sample);
    process.stderr.write(`${sample.judgeEvaluationId}: ${sample.luna ? `${sample.luna.latencyMs}ms` : sample.error?.message}\n`);
  }

  const valid = samples.filter((sample): sample is ShadowSample & { luna: NonNullable<ShadowSample["luna"]> } => Boolean(sample.luna));
  const difficultyDifferences = valid.map((sample) => Math.abs(sample.historical.difficultyIndex - sample.luna.difficultyIndex));
  const tierOrder = ["low", "mid", "mid_high", "high"];
  const factorMae = Object.fromEntries(FACTORS.map((factor) => [factor, mean(valid.map((sample) => (
    Math.abs(sample.historical.factors[factor] - sample.luna.factors[factor])
  )))]));
  const summary = {
    generatedAt: new Date().toISOString(),
    profileId: PROFILE_ID,
    modelId: MODEL_ID,
    contextPolicy: "full_native",
    requestedSamples: sampleLimit,
    samples: samples.length,
    successfulSamples: valid.length,
    jsonParseSuccessRate: samples.length ? valid.length / samples.length : null,
    difficultyIndexMae: mean(difficultyDifferences),
    primaryTierAgreementRate: valid.length
      ? valid.filter((sample) => sample.historical.tier === sample.luna.tier).length / valid.length : null,
    severeTierConflictRate: valid.length ? valid.filter((sample) => (
      Math.abs(tierOrder.indexOf(sample.historical.tier) - tierOrder.indexOf(sample.luna.tier)) >= 2
    )).length / valid.length : null,
    factorMae,
    webIntentAgreementRate: valid.length
      ? valid.filter((sample) => sample.historical.webIntent === sample.luna.webIntent).length / valid.length : null,
    latencyMs: { p50: percentile(valid.map((sample) => sample.luna.latencyMs), 0.5), p95: percentile(valid.map((sample) => sample.luna.latencyMs), 0.95) },
    timeoutRate: samples.length ? samples.filter((sample) => /timeout/i.test(sample.error?.message ?? "")).length / samples.length : null,
    nominalCostUsd: {
      average: mean(valid.map((sample) => sample.luna.nominalCostUsd)),
      p95: percentile(valid.map((sample) => sample.luna.nominalCostUsd), 0.95),
    },
  };
  const comparison = {
    mimo: {
      latencyMs: {
        p50: percentile(samples.map((sample) => sample.historical.latencyMs), 0.5),
        p95: percentile(samples.map((sample) => sample.historical.latencyMs), 0.95),
      },
      effectiveCostCny: {
        average: mean(samples.map((sample) => sample.historical.effectiveCostCny)),
        p95: percentile(samples.map((sample) => sample.historical.effectiveCostCny), 0.95),
      },
    },
    luna: {
      latencyMs: summary.latencyMs,
      effectiveCostCny: {
        average: mean(valid.map((sample) => sample.luna.effectiveCostCny)),
        p95: percentile(valid.map((sample) => sample.luna.effectiveCostCny), 0.95),
      },
    },
  };
  const differences = [...valid]
    .sort((left, right) => Math.abs(right.luna.difficultyIndex - right.historical.difficultyIndex)
      - Math.abs(left.luna.difficultyIndex - left.historical.difficultyIndex))
    .slice(0, 8)
    .map((sample) => ({
      judgeEvaluationId: sample.judgeEvaluationId,
      rawRequestTokenEstimate: sample.rawRequestTokenEstimate,
      mimoDifficultyIndex: sample.historical.difficultyIndex,
      lunaDifficultyIndex: sample.luna.difficultyIndex,
      difference: sample.luna.difficultyIndex - sample.historical.difficultyIndex,
      mimoWebIntent: sample.historical.webIntent,
      lunaWebIntent: sample.luna.webIntent,
    }));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify({ summary, comparison, differences, samples }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
