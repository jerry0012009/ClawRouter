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
  visibleOutputTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  usageSource?: "upstream_usage" | "upstream_cost" | "response_text_estimate" | "max_token_estimate";
  usageRawKeys?: string[];
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  modelCallCost?: number;
  totalAcuCost?: number;
  executionProfileId?: string;
  thinkingMode?: "disabled" | "enabled" | "default";
  requestParameterApplied?: boolean;
  upstreamModel?: string;
};

export type RoutingAttemptInput = {
  model: string;
  upstream: string;
  status: "success" | "error" | "timeout" | "skipped";
  error_category?: string;
  latency_ms: number;
  billed_cost?: number;
  usage_source?: "upstream_usage" | "upstream_cost" | "response_text_estimate" | "max_token_estimate";
  attempt_type?: "initial" | "fallback" | "format_repair" | "quality_upgrade";
  execution_profile_id: string;
  thinking_mode: "disabled" | "enabled" | "default";
  request_parameter_applied: boolean;
  upstream_model?: string;
  reasoning_tokens?: number;
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
  executionProfileId?: string;
  outcomeSource: "explicit_user_feedback" | "validator" | "test_result" | "retry_signal" | "model_upgrade_signal";
};

export type ExecutionProfileHealth = {
  executionProfileId: string;
  sampleCount: number;
  recentSuccessRate: number | null;
  consecutiveFailures: number;
  consecutiveTimeouts: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  timeoutRate: number | null;
  rateLimitRate: number | null;
  serverErrorRate: number | null;
  lastSuccessAt: string | null;
  cooldownUntil: string | null;
  availability: "healthy" | "degraded" | "cooldown" | "unknown";
  priorityPenalty: number;
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
      CREATE TABLE IF NOT EXISTS routing_attempts (
        request_id TEXT NOT NULL REFERENCES routing_requests(request_id) ON DELETE CASCADE,
        attempt_index INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        upstream TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('success','error','timeout','skipped')),
        error_category TEXT,
        latency_ms INTEGER NOT NULL,
        billed_cost REAL,
        usage_source TEXT,
        attempt_type TEXT,
        execution_profile_id TEXT,
        thinking_mode TEXT,
        request_parameter_applied INTEGER,
        upstream_model TEXT,
        reasoning_tokens INTEGER,
        created_at TEXT NOT NULL,
        PRIMARY KEY(request_id, attempt_index)
      );
      CREATE TABLE IF NOT EXISTS execution_profile_health (
        execution_profile_id TEXT PRIMARY KEY,
        sample_count INTEGER NOT NULL,
        recent_success_rate REAL,
        consecutive_failures INTEGER NOT NULL,
        consecutive_timeouts INTEGER NOT NULL,
        p50_latency_ms REAL,
        p95_latency_ms REAL,
        timeout_rate REAL,
        rate_limit_rate REAL,
        server_error_rate REAL,
        last_success_at TEXT,
        cooldown_until TEXT,
        availability TEXT NOT NULL,
        priority_penalty REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routing_created ON routing_requests(created_at);
      CREATE INDEX IF NOT EXISTS idx_routing_hash ON routing_requests(context_sha256);
      CREATE INDEX IF NOT EXISTS idx_feedback_request ON user_feedback(request_id);
      CREATE INDEX IF NOT EXISTS idx_outcomes_request ON execution_outcomes(request_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_request ON routing_attempts(request_id);
    `);
    this.ensureColumn("routing_requests", "visible_output_tokens", "INTEGER");
    this.ensureColumn("routing_requests", "completion_tokens", "INTEGER");
    this.ensureColumn("routing_requests", "reasoning_tokens", "INTEGER");
    this.ensureColumn("routing_requests", "cached_input_tokens", "INTEGER");
    this.ensureColumn("routing_requests", "usage_source", "TEXT");
    this.ensureColumn("routing_requests", "usage_raw_keys", "TEXT");
    this.ensureColumn("routing_requests", "input_price_per_million", "REAL");
    this.ensureColumn("routing_requests", "output_price_per_million", "REAL");
    this.ensureColumn("routing_requests", "model_call_cost", "REAL");
    this.ensureColumn("routing_requests", "total_acu_cost", "REAL");
    this.ensureColumn("routing_attempts", "billed_cost", "REAL");
    this.ensureColumn("routing_attempts", "usage_source", "TEXT");
    this.ensureColumn("routing_requests", "execution_profile_id", "TEXT");
    this.ensureColumn("routing_requests", "thinking_mode", "TEXT");
    this.ensureColumn("routing_requests", "request_parameter_applied", "INTEGER");
    this.ensureColumn("routing_requests", "upstream_model", "TEXT");
    this.ensureColumn("routing_attempts", "attempt_type", "TEXT");
    this.ensureColumn("routing_attempts", "execution_profile_id", "TEXT");
    this.ensureColumn("routing_attempts", "thinking_mode", "TEXT");
    this.ensureColumn("routing_attempts", "request_parameter_applied", "INTEGER");
    this.ensureColumn("routing_attempts", "upstream_model", "TEXT");
    this.ensureColumn("routing_attempts", "reasoning_tokens", "INTEGER");
    this.ensureColumn("execution_outcomes", "execution_profile_id", "TEXT");
    chmodSync(path, 0o600);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
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
      error_category=COALESCE(?,error_category),
      visible_output_tokens=COALESCE(?,visible_output_tokens),
      completion_tokens=COALESCE(?,completion_tokens), reasoning_tokens=COALESCE(?,reasoning_tokens),
      cached_input_tokens=COALESCE(?,cached_input_tokens), usage_source=COALESCE(?,usage_source),
      usage_raw_keys=COALESCE(?,usage_raw_keys), input_price_per_million=COALESCE(?,input_price_per_million),
      output_price_per_million=COALESCE(?,output_price_per_million),
      model_call_cost=COALESCE(?,model_call_cost), total_acu_cost=COALESCE(?,total_acu_cost),
      execution_profile_id=COALESCE(?,execution_profile_id), thinking_mode=COALESCE(?,thinking_mode),
      request_parameter_applied=COALESCE(?,request_parameter_applied), upstream_model=COALESCE(?,upstream_model)
      WHERE request_id=?`).run(
      metadata.actualModel ?? null, metadata.inputTokens ?? null, metadata.outputTokens ?? null,
      metadata.actualCost ?? null, metadata.latencyMs ?? null, metadata.finalStatus ?? null,
      metadata.errorCategory ?? null, metadata.visibleOutputTokens ?? null,
      metadata.completionTokens ?? null, metadata.reasoningTokens ?? null,
      metadata.cachedInputTokens ?? null, metadata.usageSource ?? null,
      metadata.usageRawKeys ? JSON.stringify(metadata.usageRawKeys) : null,
      metadata.inputPricePerMillion ?? null, metadata.outputPricePerMillion ?? null,
      metadata.modelCallCost ?? null, metadata.totalAcuCost ?? null,
      metadata.executionProfileId ?? null, metadata.thinkingMode ?? null,
      bool(metadata.requestParameterApplied), metadata.upstreamModel ?? null, requestId,
    );
  }

  recordAttempts(requestId: string, attempts: RoutingAttemptInput[]): void {
    const statement = this.database.prepare(`INSERT INTO routing_attempts
      (request_id,attempt_index,model_id,upstream,status,error_category,latency_ms,billed_cost,usage_source,
       attempt_type,execution_profile_id,thinking_mode,request_parameter_applied,upstream_model,reasoning_tokens,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(request_id,attempt_index) DO UPDATE SET
        model_id=excluded.model_id,upstream=excluded.upstream,status=excluded.status,
        error_category=excluded.error_category,latency_ms=excluded.latency_ms,
        billed_cost=excluded.billed_cost,usage_source=excluded.usage_source,
        attempt_type=excluded.attempt_type,execution_profile_id=excluded.execution_profile_id,
        thinking_mode=excluded.thinking_mode,request_parameter_applied=excluded.request_parameter_applied,
        upstream_model=excluded.upstream_model,reasoning_tokens=excluded.reasoning_tokens`);
    attempts.forEach((attempt, index) => statement.run(
      requestId, index + 1, attempt.model, attempt.upstream, attempt.status,
      attempt.error_category ?? null, attempt.latency_ms, attempt.billed_cost ?? null,
      attempt.usage_source ?? null, attempt.attempt_type ?? "initial", attempt.execution_profile_id,
      attempt.thinking_mode, bool(attempt.request_parameter_applied), attempt.upstream_model ?? null,
      attempt.reasoning_tokens ?? null, new Date().toISOString(),
    ));
    for (const profileId of new Set(attempts.map((attempt) => attempt.execution_profile_id))) {
      this.refreshExecutionProfileHealth(profileId);
    }
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
    const storedProfile = this.database.prepare("SELECT execution_profile_id FROM routing_requests WHERE request_id=?")
      .get(input.requestId)?.execution_profile_id;
    const executionProfileId = input.executionProfileId
      ?? (typeof storedProfile === "string" ? storedProfile : undefined);
    this.database.prepare(`INSERT INTO execution_outcomes
      (request_id,validator_result,test_result,tool_error_count,retry_count,model_switched,user_retried,
       outcome_score,outcome_source,execution_profile_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.requestId, input.validatorResult ?? null, input.testResult ?? null, input.toolErrorCount ?? null,
      input.retryCount ?? null, bool(input.modelSwitched), bool(input.userRetried), input.outcomeScore ?? null,
      input.outcomeSource, executionProfileId ?? null, new Date().toISOString(),
    );
  }

  private refreshExecutionProfileHealth(executionProfileId: string): void {
    const rows = this.database.prepare(`SELECT status,error_category,latency_ms,created_at
      FROM routing_attempts WHERE execution_profile_id=?
      ORDER BY datetime(created_at) DESC,attempt_index DESC LIMIT 20`).all(executionProfileId);
    if (rows.length === 0) return;
    const statuses = rows.map((row) => String(row.status));
    const categories = rows.map((row) => String(row.error_category ?? ""));
    const latencies = rows.map((row) => Number(row.latency_ms)).filter(Number.isFinite);
    const recentFive = statuses.slice(0, 5);
    let consecutiveFailures = 0;
    let consecutiveTimeouts = 0;
    for (const row of rows) {
      if (row.status === "success") break;
      consecutiveFailures += 1;
    }
    for (const row of rows) {
      if (row.status !== "timeout") break;
      consecutiveTimeouts += 1;
    }
    const latestCreated = String(rows[0].created_at);
    const cooldownCandidate = consecutiveTimeouts >= 2
      ? new Date(new Date(latestCreated).getTime() + 60_000).toISOString() : null;
    const cooldownUntil = cooldownCandidate && Date.parse(cooldownCandidate) > Date.now()
      ? cooldownCandidate : null;
    const successRate = statuses.filter((status) => status === "success").length / statuses.length;
    const recentFiveRate = recentFive.filter((status) => status === "success").length / recentFive.length;
    const availability = cooldownUntil ? "cooldown"
      : recentFive.length >= 5 && recentFiveRate < 0.6 ? "degraded" : "healthy";
    const lastSuccess = rows.find((row) => row.status === "success")?.created_at;
    const ratio = (predicate: (index: number) => boolean): number => (
      rows.filter((_row, index) => predicate(index)).length / rows.length
    );
    this.database.prepare(`INSERT INTO execution_profile_health (
      execution_profile_id,sample_count,recent_success_rate,consecutive_failures,consecutive_timeouts,
      p50_latency_ms,p95_latency_ms,timeout_rate,rate_limit_rate,server_error_rate,last_success_at,
      cooldown_until,availability,priority_penalty,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(execution_profile_id) DO UPDATE SET
      sample_count=excluded.sample_count,recent_success_rate=excluded.recent_success_rate,
      consecutive_failures=excluded.consecutive_failures,consecutive_timeouts=excluded.consecutive_timeouts,
      p50_latency_ms=excluded.p50_latency_ms,p95_latency_ms=excluded.p95_latency_ms,
      timeout_rate=excluded.timeout_rate,rate_limit_rate=excluded.rate_limit_rate,
      server_error_rate=excluded.server_error_rate,last_success_at=excluded.last_success_at,
      cooldown_until=excluded.cooldown_until,availability=excluded.availability,
      priority_penalty=excluded.priority_penalty,updated_at=excluded.updated_at`).run(
      executionProfileId, rows.length, successRate, consecutiveFailures, consecutiveTimeouts,
      quantile(latencies, 0.5), quantile(latencies, 0.95),
      ratio((index) => statuses[index] === "timeout"),
      ratio((index) => categories[index] === "rate_limited"),
      ratio((index) => categories[index] === "server_error"),
      typeof lastSuccess === "string" ? lastSuccess : null, cooldownUntil, availability,
      availability === "cooldown" ? 1 : availability === "degraded" ? 0.25 : 0,
      new Date().toISOString(),
    );
  }

  getExecutionProfileHealth(executionProfileId: string): ExecutionProfileHealth {
    this.refreshExecutionProfileHealth(executionProfileId);
    const row = this.database.prepare("SELECT * FROM execution_profile_health WHERE execution_profile_id=?")
      .get(executionProfileId);
    if (!row) return {
      executionProfileId, sampleCount: 0, recentSuccessRate: null, consecutiveFailures: 0,
      consecutiveTimeouts: 0, p50LatencyMs: null, p95LatencyMs: null, timeoutRate: null,
      rateLimitRate: null, serverErrorRate: null, lastSuccessAt: null, cooldownUntil: null,
      availability: "unknown", priorityPenalty: 0,
    };
    return {
      executionProfileId,
      sampleCount: Number(row.sample_count),
      recentSuccessRate: row.recent_success_rate === null ? null : Number(row.recent_success_rate),
      consecutiveFailures: Number(row.consecutive_failures),
      consecutiveTimeouts: Number(row.consecutive_timeouts),
      p50LatencyMs: row.p50_latency_ms === null ? null : Number(row.p50_latency_ms),
      p95LatencyMs: row.p95_latency_ms === null ? null : Number(row.p95_latency_ms),
      timeoutRate: row.timeout_rate === null ? null : Number(row.timeout_rate),
      rateLimitRate: row.rate_limit_rate === null ? null : Number(row.rate_limit_rate),
      serverErrorRate: row.server_error_rate === null ? null : Number(row.server_error_rate),
      lastSuccessAt: typeof row.last_success_at === "string" ? row.last_success_at : null,
      cooldownUntil: typeof row.cooldown_until === "string" ? row.cooldown_until : null,
      availability: String(row.availability) as ExecutionProfileHealth["availability"],
      priorityPenalty: Number(row.priority_penalty),
    };
  }

  private executionProfileSummaries(
    requests: Array<Record<string, unknown>>,
    feedback: Array<Record<string, unknown>>,
    outcomes: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const profileIds = [...new Set(requests.map((row) => row.execution_profile_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
    return profileIds.map((executionProfileId) => {
      const profileRequests = requests.filter((row) => row.execution_profile_id === executionProfileId);
      const ids = new Set(profileRequests.map((row) => String(row.request_id)));
      const profileFeedback = feedback.filter((row) => ids.has(String(row.request_id)));
      const profileOutcomes = outcomes.filter((row) => ids.has(String(row.request_id)));
      const ratings = profileFeedback.map((row) => Number(row.rating)).filter(Number.isFinite);
      const validator = profileOutcomes.filter((row) => row.outcome_source === "validator" && row.validator_result);
      const values = (field: string) => profileRequests.map((row) => Number(row[field])).filter(Number.isFinite);
      const average = (items: number[]) => items.length ? items.reduce((sum, item) => sum + item, 0) / items.length : null;
      const difficulty = { low: 0, mid: 0, mid_high: 0, high: 0 };
      profileRequests.forEach((row) => {
        const value = Number(row.difficulty_score);
        difficulty[value < 30 ? "low" : value < 55 ? "mid" : value < 80 ? "mid_high" : "high"] += 1;
      });
      const upgrades = profileFeedback.filter((row) => row.required_upgrade !== null)
        .map((row) => Number(row.required_upgrade));
      return {
        executionProfileId,
        requestCount: profileRequests.length,
        difficultyDistribution: difficulty,
        averageUserRating: average(ratings),
        validatorPassRate: validator.length
          ? validator.filter((row) => row.validator_result === "pass").length / validator.length : null,
        averageCost: average(values("total_acu_cost")),
        averageReasoningTokens: average(values("reasoning_tokens")),
        latencyMs: { p50: quantile(values("latency_ms"), 0.5), p95: quantile(values("latency_ms"), 0.95) },
        upgradeRate: upgrades.length ? upgrades.filter((value) => value === 1).length / upgrades.length : null,
        independentCurveEligible: profileRequests.length >= 30,
        curveNotice: profileRequests.length < 30 ? "样本少于30条，不得拟合独立曲线。" : null,
        health: this.getExecutionProfileHealth(executionProfileId),
      };
    });
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
      executionProfileSummaries: this.executionProfileSummaries(requests, feedback, outcomes),
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
