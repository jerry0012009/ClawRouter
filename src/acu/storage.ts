import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { AcuEvaluation } from "./types.js";

type SqlValue = string | number | bigint | null;
type Statement = {
  run: (...values: SqlValue[]) => unknown;
  get: (...values: SqlValue[]) => Record<string, unknown> | undefined;
  all: (...values: SqlValue[]) => Array<Record<string, unknown>>;
};
type Database = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
  close: () => void;
};
type DatabaseConstructor = new (path: string) => Database;

const require = createRequire(import.meta.url);

export type RoutingRecordMetadata = {
  sessionHash?: string;
  requestedModel?: string;
  actualModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  actualCost?: number;
  latencyMs?: number;
  finalStatus?: string;
  hadTools?: boolean;
  errorCategory?: string;
};

export type FeedbackInput = {
  requestId: string;
  accepted?: boolean;
  rating?: number;
  requiredUpgrade?: boolean;
  finalModel?: string;
};

export type OutcomeInput = {
  requestId: string;
  validatorResult?: string;
  testResult?: string;
  toolErrorCount?: number;
  retryCount?: number;
  modelSwitched?: boolean;
  userRetried?: boolean;
  outcomeScore?: number;
  outcomeSource: "explicit_user_feedback" | "validator" | "test_result" | "retry_signal" | "model_upgrade_signal";
};

function bool(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function quantile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
}

export function hashSession(value: string | undefined): string | undefined {
  return value ? createHash("sha256").update(value).digest("hex") : undefined;
}

export class AcuRoutingStore {
  private readonly database: Database;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    const sqlite = require("node:sqlite") as { DatabaseSync: DatabaseConstructor };
    this.database = new sqlite.DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS routing_requests (
        request_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        session_hash TEXT,
        context_sha256 TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        routing_model_version TEXT NOT NULL,
        judge_status TEXT NOT NULL CHECK(judge_status IN ('live','cache_hit','rules_fallback','live_error')),
        judge_model TEXT NOT NULL,
        judge_provider TEXT NOT NULL,
        difficulty_score REAL NOT NULL CHECK(difficulty_score BETWEEN 0 AND 100),
        p_low REAL NOT NULL, p_mid REAL NOT NULL, p_mid_high REAL NOT NULL, p_high REAL NOT NULL,
        judge_confidence REAL NOT NULL,
        judge_latency_ms INTEGER NOT NULL,
        judge_tokens INTEGER,
        judge_cost REAL NOT NULL,
        requested_model TEXT,
        recommended_model TEXT,
        actual_model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        actual_cost REAL,
        latency_ms INTEGER,
        final_status TEXT,
        had_tools INTEGER NOT NULL DEFAULT 0,
        error_category TEXT
      );
      CREATE TABLE IF NOT EXISTS model_candidate_scores (
        request_id TEXT NOT NULL REFERENCES routing_requests(request_id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        predicted_score REAL NOT NULL,
        conservative_score REAL NOT NULL,
        expected_call_cost REAL NOT NULL,
        expected_total_cost REAL NOT NULL,
        value_utility REAL NOT NULL,
        pareto_efficient INTEGER NOT NULL,
        selected INTEGER NOT NULL,
        PRIMARY KEY(request_id, model_id)
      );
      CREATE TABLE IF NOT EXISTS user_feedback (
        feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES routing_requests(request_id) ON DELETE CASCADE,
        accepted INTEGER,
        rating INTEGER CHECK(rating BETWEEN 1 AND 5),
        required_upgrade INTEGER,
        final_model TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_outcomes (
        outcome_id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES routing_requests(request_id) ON DELETE CASCADE,
        validator_result TEXT,
        test_result TEXT,
        tool_error_count INTEGER,
        retry_count INTEGER,
        model_switched INTEGER,
        user_retried INTEGER,
        outcome_score REAL,
        outcome_source TEXT NOT NULL CHECK(outcome_source IN ('explicit_user_feedback','validator','test_result','retry_signal','model_upgrade_signal')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routing_created ON routing_requests(created_at);
      CREATE INDEX IF NOT EXISTS idx_routing_hash ON routing_requests(context_sha256);
      CREATE INDEX IF NOT EXISTS idx_feedback_request ON user_feedback(request_id);
      CREATE INDEX IF NOT EXISTS idx_outcomes_request ON execution_outcomes(request_id);
    `);
    chmodSync(path, 0o600);
  }

  recordEvaluation(evaluation: AcuEvaluation, metadata: RoutingRecordMetadata = {}): void {
    const judgeTokens = evaluation.usageStatus === "not_applicable"
      ? null : evaluation.judgePromptTokens + evaluation.judgeCompletionTokens;
    this.database.prepare(`
      INSERT INTO routing_requests (
        request_id,created_at,session_hash,context_sha256,prompt_version,routing_model_version,
        judge_status,judge_model,judge_provider,difficulty_score,p_low,p_mid,p_mid_high,p_high,
        judge_confidence,judge_latency_ms,judge_tokens,judge_cost,requested_model,recommended_model,
        actual_model,input_tokens,output_tokens,actual_cost,latency_ms,final_status,had_tools,error_category
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET
        actual_model=COALESCE(excluded.actual_model,routing_requests.actual_model),
        input_tokens=COALESCE(excluded.input_tokens,routing_requests.input_tokens),
        output_tokens=COALESCE(excluded.output_tokens,routing_requests.output_tokens),
        actual_cost=COALESCE(excluded.actual_cost,routing_requests.actual_cost),
        latency_ms=COALESCE(excluded.latency_ms,routing_requests.latency_ms),
        final_status=COALESCE(excluded.final_status,routing_requests.final_status),
        error_category=COALESCE(excluded.error_category,routing_requests.error_category)
    `).run(
      evaluation.requestId, new Date().toISOString(), metadata.sessionHash ?? null, evaluation.contextSha256,
      evaluation.promptVersion, evaluation.routingModelVersion, evaluation.judgeStatus, evaluation.judgeModel,
      evaluation.judgeProvider, evaluation.difficultyScore, evaluation.judge.pLow, evaluation.judge.pMid,
      evaluation.judge.pMidHigh, evaluation.judge.pHigh, evaluation.judge.confidence, evaluation.judgeLatencyMs,
      judgeTokens, evaluation.judgeCost, metadata.requestedModel ?? null, evaluation.recommendation.recommended.modelId,
      metadata.actualModel ?? null, metadata.inputTokens ?? null, metadata.outputTokens ?? null,
      metadata.actualCost ?? null, metadata.latencyMs ?? null, metadata.finalStatus ?? null,
      bool(metadata.hadTools) ?? 0, metadata.errorCategory ?? evaluation.judgeErrorCategory ?? null,
    );
    const statement = this.database.prepare(`
      INSERT INTO model_candidate_scores (
        request_id,model_id,predicted_score,conservative_score,expected_call_cost,expected_total_cost,
        value_utility,pareto_efficient,selected
      ) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(request_id,model_id) DO UPDATE SET
        predicted_score=excluded.predicted_score,conservative_score=excluded.conservative_score,
        expected_call_cost=excluded.expected_call_cost,expected_total_cost=excluded.expected_total_cost,
        value_utility=excluded.value_utility,pareto_efficient=excluded.pareto_efficient,selected=excluded.selected
    `);
    for (const candidate of evaluation.recommendation.estimates) {
      statement.run(evaluation.requestId, candidate.modelId, candidate.predictedScore, candidate.conservativeScore,
        candidate.estimatedCallCost, candidate.expectedTotalCost, candidate.valueUtility,
        bool(candidate.paretoEfficient) ?? 0, candidate.modelId === evaluation.recommendation.recommended.modelId ? 1 : 0);
    }
    if (metadata.sessionHash) {
      const recent = this.database.prepare(`SELECT COUNT(*) AS n FROM routing_requests
        WHERE session_hash=? AND request_id<>? AND unixepoch(created_at)>=unixepoch('now')-600`).get(metadata.sessionHash, evaluation.requestId);
      if (Number(recent?.n ?? 0) > 0) {
        this.recordOutcome({ requestId: evaluation.requestId, retryCount: 1, userRetried: true, outcomeSource: "retry_signal" });
      }
    }
  }

  finalizeRequest(requestId: string, metadata: RoutingRecordMetadata): void {
    this.database.prepare(`UPDATE routing_requests SET
      actual_model=COALESCE(?,actual_model), input_tokens=COALESCE(?,input_tokens),
      output_tokens=COALESCE(?,output_tokens), actual_cost=COALESCE(?,actual_cost),
      latency_ms=COALESCE(?,latency_ms), final_status=COALESCE(?,final_status),
      error_category=COALESCE(?,error_category) WHERE request_id=?`).run(
      metadata.actualModel ?? null, metadata.inputTokens ?? null, metadata.outputTokens ?? null,
      metadata.actualCost ?? null, metadata.latencyMs ?? null, metadata.finalStatus ?? null,
      metadata.errorCategory ?? null, requestId,
    );
  }

  recordFeedback(input: FeedbackInput): void {
    if (input.rating !== undefined && (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)) {
      throw new Error("rating must be an integer from 1 to 5");
    }
    this.database.prepare(`INSERT INTO user_feedback
      (request_id,accepted,rating,required_upgrade,final_model,created_at) VALUES (?,?,?,?,?,?)`).run(
      input.requestId, bool(input.accepted), input.rating ?? null, bool(input.requiredUpgrade), input.finalModel ?? null, new Date().toISOString(),
    );
    this.recordOutcome({
      requestId: input.requestId, outcomeSource: "explicit_user_feedback",
      outcomeScore: input.rating === undefined ? undefined : input.rating / 5,
      modelSwitched: input.requiredUpgrade,
    });
  }

  recordOutcome(input: OutcomeInput): void {
    this.database.prepare(`INSERT INTO execution_outcomes
      (request_id,validator_result,test_result,tool_error_count,retry_count,model_switched,user_retried,outcome_score,outcome_source,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      input.requestId, input.validatorResult ?? null, input.testResult ?? null, input.toolErrorCount ?? null,
      input.retryCount ?? null, bool(input.modelSwitched), bool(input.userRetried), input.outcomeScore ?? null,
      input.outcomeSource, new Date().toISOString(),
    );
  }

  summary(): Record<string, unknown> {
    const requests = this.database.prepare("SELECT * FROM routing_requests").all();
    const feedback = this.database.prepare("SELECT * FROM user_feedback").all();
    const outcomes = this.database.prepare("SELECT * FROM execution_outcomes").all();
    const count = requests.length;
    const latencies = requests.filter((row) => row.judge_status === "live").map((row) => Number(row.judge_latency_ms)).filter(Number.isFinite);
    const group = (field: string): Record<string, number> => Object.fromEntries(
      [...new Set(requests.map((row) => String(row[field] ?? "unknown")))].sort().map((key) => [key, requests.filter((row) => String(row[field] ?? "unknown") === key).length]),
    );
    const difficultyDistribution = { low: 0, mid: 0, mid_high: 0, high: 0 };
    for (const row of requests) {
      const score = Number(row.difficulty_score);
      difficultyDistribution[score < 30 ? "low" : score < 55 ? "mid" : score < 80 ? "mid_high" : "high"] += 1;
    }
    const labeled = new Set([...feedback, ...outcomes].map((row) => String(row.request_id))).size;
    const ratings = feedback.map((row) => Number(row.rating)).filter(Number.isFinite);
    const accepted = feedback.filter((row) => row.accepted !== null);
    const upgrades = feedback.filter((row) => row.required_upgrade !== null);
    const requestsWithActualModel = requests.filter((row) => typeof row.actual_model === "string" && row.actual_model.length > 0);
    const bucketCounts = this.database.prepare(`SELECT c.model_id,
      CASE WHEN r.difficulty_score<30 THEN 'low' WHEN r.difficulty_score<55 THEN 'mid' WHEN r.difficulty_score<80 THEN 'mid_high' ELSE 'high' END AS difficulty_bucket,
      COUNT(DISTINCT r.request_id) AS n
      FROM model_candidate_scores c JOIN routing_requests r USING(request_id)
      WHERE EXISTS(SELECT 1 FROM user_feedback f WHERE f.request_id=r.request_id)
         OR EXISTS(SELECT 1 FROM execution_outcomes o WHERE o.request_id=r.request_id)
      GROUP BY c.model_id,difficulty_bucket ORDER BY c.model_id,difficulty_bucket`).all();
    return {
      generatedAt: new Date().toISOString(),
      realRequestCount: count,
      realJudgeRequestCount: requests.filter((row) => row.judge_status === "live").length,
      cacheHitRate: count ? requests.filter((row) => row.judge_status === "cache_hit").length / count : 0,
      rulesFallbackRate: count ? requests.filter((row) => row.judge_status === "rules_fallback").length / count : 0,
      judgeLatencyMs: { mean: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null, p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95) },
      difficultyDistribution,
      recommendedModelDistribution: group("recommended_model"),
      actualModelDistribution: group("actual_model"),
      recommendationActualAgreementRate: requestsWithActualModel.length
        ? requestsWithActualModel.filter((row) => row.recommended_model && row.recommended_model === row.actual_model).length / requestsWithActualModel.length
        : null,
      userSatisfactionRate: accepted.length ? accepted.filter((row) => Number(row.accepted) === 1).length / accepted.length : null,
      averageRating: ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null,
      upgradeRate: upgrades.length ? upgrades.filter((row) => Number(row.required_upgrade) === 1).length / upgrades.length : null,
      labeledRequestCount: labeled,
      effectiveLabeledOutcomeCount: labeled,
      modelDifficultyLabelCounts: bucketCounts,
      sampleNotice: count < 20 ? "当前样本量较小，仅用于产品验证。" : null,
    };
  }

  close(): void { this.database.close(); }
}

export function openAcuRoutingStore(path: string): AcuRoutingStore | null {
  try { return new AcuRoutingStore(path); }
  catch (error) {
    console.error(`[ClawRouter] ACU SQLite disabled: ${error instanceof Error ? error.message : "unknown error"}`);
    return null;
  }
}
