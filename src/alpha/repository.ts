import { createHash, randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { SqlExecutor } from "./database.js";
import { sanitizeHeadersForPersistence, sanitizePayloadForPersistence } from "./secrets.js";
import type { CircuitState, HealthSnapshot, ProviderErrorClass } from "./channel-health.js";

export type AlphaProtocol = "responses" | "messages" | "chat_completions";
export type AlphaIdPrefix = "ses" | "task" | "seg" | "evt" | "judge" | "route" | "req" | "att" | "payload" | "usage";

export function alphaId(prefix: AlphaIdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type SessionRecord = {
  sessionId: string;
  newapiUserId: string;
  newapiTokenId?: string;
  clientName: string;
  clientVersion?: string;
  nativeProtocol: AlphaProtocol;
  continuityFingerprint?: string;
  historyPrefixHash?: string;
  systemFingerprint?: string;
  toolSchemaFingerprint?: string;
  lastToolCallId?: string;
  metadata?: Record<string, unknown>;
};

export type TaskRecord = {
  taskId: string;
  sessionId: string;
  newapiUserId: string;
  rootGoalText?: string;
  rootGoalHash?: string;
  phase: string;
  baseQualityTarget: number;
  capabilityEscalationFloor?: number;
  status: string;
  metadata?: Record<string, unknown>;
};

export type SegmentRecord = {
  segmentId: string;
  taskId: string;
  newapiUserId: string;
  previousSegmentId?: string;
  creationReason: string;
  phase: string;
  status?: "active" | "superseded" | "completed" | "blocked";
  taskBaseQualityTarget: number;
  capabilityEscalationFloor?: number;
  temporaryPhaseOverride?: number;
  effectiveQualityTarget: number;
  metadata?: Record<string, unknown>;
};

export type EventRecord = {
  eventId: string;
  sessionId: string;
  taskId: string;
  segmentId?: string;
  logicalRequestId?: string;
  eventType: string;
  eventHash: string;
  evidenceStrength: string;
  sourceProtocol: AlphaProtocol;
  sourceClient: string;
  sourceClientVersion?: string;
  sourcePayloadId?: string;
  toolCallId?: string;
  failureSignature?: string;
  failureSignatureVersion?: string;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
};

export type LogicalRequestRecord = {
  logicalRequestId: string;
  newapiUserId: string;
  newapiTokenId?: string;
  newapiLogId?: string;
  sessionId: string;
  taskId: string;
  segmentId: string;
  ingressIdempotencyKey: string;
  requestProtocol: AlphaProtocol;
  requestedModel: string;
  requestPayloadId?: string;
  selectedProfileId?: string;
  streaming: boolean;
  status?: string;
  hadTools?: boolean;
  metadata?: Record<string, unknown>;
};

export type PayloadRecord = {
  payloadId: string;
  newapiUserId: string;
  logicalRequestId?: string;
  attemptId?: string;
  payloadKind: string;
  protocol?: AlphaProtocol;
  contentType?: string;
  headers?: Record<string, string | string[] | undefined>;
  body: unknown;
  isComplete: boolean;
  metadata?: Record<string, unknown>;
};

export type AttemptRecord = {
  attemptId: string;
  logicalRequestId: string;
  attemptIndex: number;
  attemptKind: "provider" | "judge";
  retryOwner: string;
  provider: string;
  status: string;
  routeDecisionId?: string;
  judgeEvaluationId?: string;
  executionProfileId?: string;
  requestedModel?: string;
  actualModel?: string;
  channel?: string;
  channelId?: string;
  networkEndpoint?: string;
  providerRequestId?: string;
  errorCategory?: string;
  httpStatus?: number;
  usageSource?: string;
  inputPricePerMillion?: string;
  outputPricePerMillion?: string;
  actualCostUsd?: string;
  providerBilled?: boolean;
  metadata?: Record<string, unknown>;
};

export type UsageReportRecord = {
  usageReportId: string;
  logicalRequestId: string;
  reportIdempotencyKey: string;
  newapiUserId: string;
  newapiTokenId?: string;
  newapiLogId?: string;
  actualModel?: string;
  provider?: string;
  channel?: string;
  inputTokens?: bigint;
  cachedInputTokens?: bigint;
  outputTokens?: bigint;
  reasoningTokens?: bigint;
  judgeCostUsd?: string;
  providerCostUsd?: string;
  failedBilledCostUsd?: string;
  finalUserCostUsd: string;
  costBreakdown: Record<string, unknown>;
};

export type PendingUsageReport = {
  usageReportId: string;
  logicalRequestId: string;
  reportIdempotencyKey: string;
  newapiUserId: string;
  newapiTokenId?: string;
  newapiLogId?: string;
  actualModel?: string;
  provider?: string;
  channel?: string;
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
  reasoningTokens: bigint;
  judgeCostUsd: string;
  providerCostUsd: string;
  failedBilledCostUsd: string;
  finalUserCostUsd: string;
  costBreakdown: Record<string, unknown>;
  sendAttemptCount: number;
};

export type JudgeEvaluationRecord = {
  judgeEvaluationId: string;
  newapiUserId: string;
  taskId: string;
  segmentId: string;
  triggerEventId?: string;
  judgeIdempotencyKey: string;
  judgeStatus: string;
  judgeResultSource: string;
  judgeModel?: string;
  judgeProvider?: string;
  promptVersion: string;
  policyVersion: string;
  difficultyMethodVersion: string;
  contextHash: string;
  contextTokenEstimate?: bigint;
  contextTruncated: boolean;
  difficultyScoreRaw?: number;
  difficultyIndex?: number;
  factors: Record<string, unknown>;
  probabilities: Record<string, unknown>;
  confidence?: number;
  judgeEntropy?: number;
  evidenceTags: unknown[];
  explanation?: string;
  promptTokens?: bigint;
  completionTokens?: bigint;
  latencyMs?: number;
  actualCostUsd?: string;
  errorCategory?: string;
};

export type RouteDecisionRecord = {
  routeDecisionId: string;
  newapiUserId: string;
  segmentId: string;
  judgeEvaluationId?: string;
  mode: string;
  policyVersion: string;
  routingModelVersion: string;
  qualityCurveVersion: string;
  priceVersion: string;
  effectiveQualityTarget: number;
  formulaInputs: Record<string, unknown>;
  candidateEstimates: unknown[];
  paretoFrontier: unknown[];
  selectedProfile: Record<string, unknown>;
  routeExplanation?: string;
  fallbackSource?: string;
};

function json(value: unknown): string {
  return JSON.stringify(sanitizePayloadForPersistence(value ?? {}));
}

function dateValue(value: unknown): Date | undefined {
  return value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
}

function healthSnapshot(row: Record<string, unknown>): HealthSnapshot {
  return {
    state: row.circuit_state as CircuitState,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    recentSuccessRate: Number(row.recent_success_rate ?? 1),
    cooldownUntil: dateValue(row.cooldown_until),
    lastAttemptAt: dateValue(row.last_attempt_at),
    lastSuccessAt: dateValue(row.last_success_at),
    lastFailureAt: dateValue(row.last_failure_at),
    firstTokenLatencyMs: row.first_token_latency_ms === null ? undefined : Number(row.first_token_latency_ms),
    totalLatencyMs: row.total_latency_ms === null ? undefined : Number(row.total_latency_ms),
    errorClass: row.error_class as ProviderErrorClass | undefined,
    httpStatus: row.http_status === null ? undefined : Number(row.http_status),
  };
}

function healthValues(channelId: string, providerId: string, value: HealthSnapshot): unknown[] {
  return [channelId, providerId, value.state, value.cooldownUntil ?? null, value.lastAttemptAt ?? null,
    value.lastSuccessAt ?? null, value.lastFailureAt ?? null, value.consecutiveFailures, value.recentSuccessRate,
    value.firstTokenLatencyMs ?? null, value.totalLatencyMs ?? null, value.errorClass ?? null, value.httpStatus ?? null];
}

export class AlphaRepository {
  constructor(private readonly database: SqlExecutor) {}

  async lockUserState(newapiUserId: string): Promise<void> {
    await this.database.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [newapiUserId]);
  }

  async lockTask(taskId: string, newapiUserId: string): Promise<void> {
    const result = await this.database.query(
      "SELECT task_id FROM acu_tasks WHERE task_id=$1 AND newapi_user_id=$2 FOR UPDATE",
      [taskId, newapiUserId],
    );
    if (result.rowCount !== 1) throw new Error("Task lock failed or crossed user scope");
  }

  async createSession(input: SessionRecord): Promise<void> {
    const now = new Date();
    await this.database.query(
      `INSERT INTO acu_sessions
       (session_id,newapi_user_id,newapi_token_id,client_name,client_version,native_protocol,
        continuity_fingerprint,history_prefix_hash,system_fingerprint,tool_schema_fingerprint,
        last_tool_call_id,last_activity_at,created_at,updated_at,metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12,$13)`,
      [input.sessionId, input.newapiUserId, input.newapiTokenId ?? null, input.clientName,
        input.clientVersion ?? null, input.nativeProtocol, input.continuityFingerprint ?? null,
        input.historyPrefixHash ?? null, input.systemFingerprint ?? null,
        input.toolSchemaFingerprint ?? null, input.lastToolCallId ?? null, now, json(input.metadata)],
    );
  }

  async listSessionCandidates(
    newapiUserId: string,
    protocol: AlphaProtocol,
    limit = 20,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT * FROM acu_sessions
       WHERE newapi_user_id=$1 AND native_protocol=$2
       ORDER BY updated_at DESC LIMIT $3`,
      [newapiUserId, protocol, limit],
    );
    return result.rows;
  }

  async updateSessionState(input: {
    sessionId: string;
    newapiUserId: string;
    currentTaskId: string;
    currentSegmentId: string;
    historyPrefixHash: string;
    lastToolCallId?: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const result = await this.database.query(
      `UPDATE acu_sessions SET current_task_id=$3,current_segment_id=$4,history_prefix_hash=$5,
       last_tool_call_id=$6,last_activity_at=now(),updated_at=now(),metadata_json=$7
       WHERE session_id=$1 AND newapi_user_id=$2`,
      [input.sessionId, input.newapiUserId, input.currentTaskId, input.currentSegmentId,
        input.historyPrefixHash, input.lastToolCallId ?? null, json(input.metadata)],
    );
    if (result.rowCount !== 1) throw new Error("Session update failed or crossed user scope");
  }

  async getTask(taskId: string, newapiUserId: string): Promise<Record<string, unknown> | undefined> {
    return this.findUserScoped("acu_tasks", "task_id", taskId, newapiUserId);
  }

  async getSegment(segmentId: string, newapiUserId: string): Promise<Record<string, unknown> | undefined> {
    return this.findUserScoped("acu_segments", "segment_id", segmentId, newapiUserId);
  }

  async createTask(input: TaskRecord): Promise<void> {
    const now = new Date();
    await this.database.query(
      `INSERT INTO acu_tasks
       (task_id,session_id,newapi_user_id,root_goal_text,root_goal_hash,phase,base_quality_target,
        capability_escalation_floor,status,created_at,updated_at,metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,
      [input.taskId, input.sessionId, input.newapiUserId, input.rootGoalText ?? null,
        input.rootGoalHash ?? null, input.phase, input.baseQualityTarget,
        input.capabilityEscalationFloor ?? 0, input.status, now, json(input.metadata)],
    );
  }

  async createSegment(input: SegmentRecord): Promise<void> {
    const now = new Date();
    await this.database.query(
      `INSERT INTO acu_segments
       (segment_id,task_id,newapi_user_id,previous_segment_id,creation_reason,phase,status,
        task_base_quality_target,capability_escalation_floor,temporary_phase_override,
        effective_quality_target,last_activity_at,created_at,metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13)`,
      [input.segmentId, input.taskId, input.newapiUserId, input.previousSegmentId ?? null,
        input.creationReason, input.phase, input.status ?? "active", input.taskBaseQualityTarget,
        input.capabilityEscalationFloor ?? 0, input.temporaryPhaseOverride ?? 0,
        input.effectiveQualityTarget, now, json(input.metadata)],
    );
  }

  async updateSegmentDecision(input: {
    segmentId: string;
    newapiUserId: string;
    judgeEvaluationId?: string;
    routeDecisionId?: string;
    selectedExecutionProfileId: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const result = await this.database.query(
      `UPDATE acu_segments SET judge_evaluation_id=$3,route_decision_id=$4,
       selected_execution_profile_id=$5,metadata_json=$6,last_activity_at=now()
       WHERE segment_id=$1 AND newapi_user_id=$2`,
      [input.segmentId, input.newapiUserId, input.judgeEvaluationId ?? null,
        input.routeDecisionId ?? null, input.selectedExecutionProfileId, json(input.metadata)],
    );
    if (result.rowCount !== 1) throw new Error("Segment decision update failed or crossed user scope");
  }

  async updateSegmentMetadata(
    segmentId: string,
    newapiUserId: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.database.query(
      `UPDATE acu_segments SET metadata_json=$3,last_activity_at=now()
       WHERE segment_id=$1 AND newapi_user_id=$2`,
      [segmentId, newapiUserId, json(value)],
    );
    if (result.rowCount !== 1) throw new Error("Segment metadata update failed or crossed user scope");
  }

  async incrementAcceptedResponses(segmentId: string, newapiUserId: string): Promise<number> {
    const result = await this.database.query<{ accepted_responses_since_judge: number }>(
      `UPDATE acu_segments SET accepted_responses_since_judge=accepted_responses_since_judge+1,
       last_activity_at=now() WHERE segment_id=$1 AND newapi_user_id=$2
       RETURNING accepted_responses_since_judge`,
      [segmentId, newapiUserId],
    );
    if (result.rowCount !== 1) throw new Error("Accepted response update failed or crossed user scope");
    return result.rows[0].accepted_responses_since_judge;
  }

  async supersedeActiveSegment(taskId: string, newapiUserId: string): Promise<void> {
    await this.database.query(
      `UPDATE acu_segments SET status='superseded',superseded_at=now()
       WHERE task_id=$1 AND newapi_user_id=$2 AND status='active'`,
      [taskId, newapiUserId],
    );
  }

  async insertEvent(input: EventRecord): Promise<{ eventId: string; inserted: boolean }> {
    const result = await this.database.query<{ event_id: string }>(
      `INSERT INTO acu_events
       (event_id,session_id,task_id,segment_id,logical_request_id,event_type,event_hash,
        evidence_strength,source_protocol,source_client,source_client_version,source_payload_id,
        tool_call_id,failure_signature,failure_signature_version,occurred_at,metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (session_id,event_hash) DO NOTHING RETURNING event_id`,
      [input.eventId, input.sessionId, input.taskId, input.segmentId ?? null,
        input.logicalRequestId ?? null, input.eventType, input.eventHash, input.evidenceStrength,
        input.sourceProtocol, input.sourceClient, input.sourceClientVersion ?? null,
        input.sourcePayloadId ?? null, input.toolCallId ?? null, input.failureSignature ?? null,
        input.failureSignatureVersion ?? null, input.occurredAt ?? new Date(), json(input.metadata)],
    );
    if (result.rowCount === 1) return { eventId: input.eventId, inserted: true };
    const existing = await this.database.query<{ event_id: string }>(
      "SELECT event_id FROM acu_events WHERE session_id=$1 AND event_hash=$2",
      [input.sessionId, input.eventHash],
    );
    return { eventId: existing.rows[0].event_id, inserted: false };
  }

  async createLogicalRequest(input: LogicalRequestRecord): Promise<{ logicalRequestId: string; inserted: boolean }> {
    const result = await this.database.query<{ logical_request_id: string }>(
      `INSERT INTO acu_logical_requests
       (logical_request_id,newapi_user_id,newapi_token_id,newapi_log_id,session_id,task_id,segment_id,
        ingress_idempotency_key,request_protocol,requested_model,request_payload_id,selected_profile_id,
        status,had_tools,streaming,started_at,metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16)
       ON CONFLICT (newapi_user_id,ingress_idempotency_key) DO NOTHING RETURNING logical_request_id`,
      [input.logicalRequestId, input.newapiUserId, input.newapiTokenId ?? null,
        input.newapiLogId ?? null, input.sessionId, input.taskId, input.segmentId,
        input.ingressIdempotencyKey, input.requestProtocol, input.requestedModel,
        input.requestPayloadId ?? null, input.selectedProfileId ?? null, input.status ?? "pending",
        input.hadTools ?? false, input.streaming, json(input.metadata)],
    );
    if (result.rowCount === 1) return { logicalRequestId: input.logicalRequestId, inserted: true };
    const existing = await this.database.query<{ logical_request_id: string }>(
      "SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id=$1 AND ingress_idempotency_key=$2",
      [input.newapiUserId, input.ingressIdempotencyKey],
    );
    return { logicalRequestId: existing.rows[0].logical_request_id, inserted: false };
  }

  async getLogicalRequest(logicalRequestId: string, newapiUserId: string): Promise<Record<string, unknown> | undefined> {
    return this.findUserScoped("acu_logical_requests", "logical_request_id", logicalRequestId, newapiUserId);
  }

  /** Admin-only lookup. Callers must enforce independent administrator authentication. */
  async getAdminLogicalRequestTrace(logicalRequestId: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.database.query<{ trace: Record<string, unknown> }>(
      `WITH requested AS (
         SELECT * FROM acu_logical_requests WHERE logical_request_id=$1
       )
       SELECT jsonb_build_object(
         'logical_request',to_jsonb(requested),
         'session',(SELECT to_jsonb(value) FROM acu_sessions value WHERE value.session_id=requested.session_id),
         'task',(SELECT to_jsonb(value) FROM acu_tasks value WHERE value.task_id=requested.task_id),
         'segments',COALESCE((
           SELECT jsonb_agg(to_jsonb(value) ORDER BY value.created_at,value.segment_id)
           FROM acu_segments value WHERE value.task_id=requested.task_id
         ),'[]'::jsonb),
         'events',COALESCE((
           SELECT jsonb_agg(to_jsonb(value) ORDER BY value.occurred_at,value.event_id)
           FROM acu_events value WHERE value.task_id=requested.task_id
         ),'[]'::jsonb),
         'judge_evaluations',COALESCE((
           SELECT jsonb_agg(to_jsonb(value) ORDER BY value.created_at,value.judge_evaluation_id)
           FROM acu_judge_evaluations value WHERE value.task_id=requested.task_id
         ),'[]'::jsonb),
         'route_decisions',COALESCE((
           SELECT jsonb_agg(to_jsonb(value) ORDER BY value.created_at,value.route_decision_id)
           FROM acu_route_decisions value
           JOIN acu_segments segment ON segment.segment_id=value.segment_id
           WHERE segment.task_id=requested.task_id
         ),'[]'::jsonb),
         'attempts',COALESCE((
           SELECT jsonb_agg(to_jsonb(value) ORDER BY value.attempt_index,value.attempt_kind,value.attempt_id)
           FROM acu_attempts value WHERE value.logical_request_id=requested.logical_request_id
         ),'[]'::jsonb),
         'payloads',COALESCE((
           SELECT jsonb_agg(to_jsonb(value) ORDER BY value.created_at,value.payload_id)
           FROM acu_payloads value
           WHERE value.logical_request_id=requested.logical_request_id
              OR value.payload_id IN (
                SELECT event.source_payload_id FROM acu_events event
                WHERE event.task_id=requested.task_id AND event.source_payload_id IS NOT NULL
                UNION
                SELECT judge.input_payload_id FROM acu_judge_evaluations judge
                WHERE judge.task_id=requested.task_id AND judge.input_payload_id IS NOT NULL
                UNION
                SELECT judge.output_payload_id FROM acu_judge_evaluations judge
                WHERE judge.task_id=requested.task_id AND judge.output_payload_id IS NOT NULL
              )
         ),'[]'::jsonb),
         'usage_report',(SELECT to_jsonb(value) FROM acu_usage_reports value
                         WHERE value.logical_request_id=requested.logical_request_id)
       ) AS trace
       FROM requested`,
      [logicalRequestId],
    );
    return result.rows[0]?.trace;
  }

  async nextProviderAttemptIndex(logicalRequestId: string): Promise<number> {
    const result = await this.database.query<{ next_index: number }>(
      `SELECT COALESCE(MAX(attempt_index),0)::int+1 AS next_index
       FROM acu_attempts WHERE logical_request_id=$1 AND attempt_kind='provider'`,
      [logicalRequestId],
    );
    return result.rows[0].next_index;
  }

  async attachRequestPayload(logicalRequestId: string, newapiUserId: string, payloadId: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE acu_logical_requests SET request_payload_id=$3
       WHERE logical_request_id=$1 AND newapi_user_id=$2`,
      [logicalRequestId, newapiUserId, payloadId],
    );
    if (result.rowCount !== 1) throw new Error("Request payload attachment failed or crossed user scope");
  }

  async completeLogicalRequest(input: {
    logicalRequestId: string;
    newapiUserId: string;
    status: string;
    acceptedAttemptId?: string;
    responsePayloadId?: string;
    errorCategory?: string;
  }): Promise<void> {
    const result = await this.database.query(
      `UPDATE acu_logical_requests SET status=$3,accepted_attempt_id=$4,response_payload_id=$5,
       error_category=$6,completed_at=now() WHERE logical_request_id=$1 AND newapi_user_id=$2`,
      [input.logicalRequestId, input.newapiUserId, input.status, input.acceptedAttemptId ?? null,
        input.responsePayloadId ?? null, input.errorCategory ?? null],
    );
    if (result.rowCount !== 1) throw new Error("Logical request completion failed or crossed user scope");
  }

  async saveJudgeEvaluation(input: JudgeEvaluationRecord): Promise<{ judgeEvaluationId: string; inserted: boolean }> {
    const result = await this.database.query<{ judge_evaluation_id: string }>(
      `INSERT INTO acu_judge_evaluations
       (judge_evaluation_id,newapi_user_id,task_id,segment_id,trigger_event_id,judge_idempotency_key,
        judge_status,judge_result_source,judge_model,judge_provider,prompt_version,policy_version,
        difficulty_method_version,context_hash,context_token_estimate,context_truncated,
        difficulty_score_raw,difficulty_index,factors_json,probabilities_json,confidence,judge_entropy,
        evidence_tags_json,explanation,prompt_tokens,completion_tokens,latency_ms,actual_cost_usd,
        error_category,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,now())
       ON CONFLICT (judge_idempotency_key) DO NOTHING RETURNING judge_evaluation_id`,
      [input.judgeEvaluationId, input.newapiUserId, input.taskId, input.segmentId,
        input.triggerEventId ?? null, input.judgeIdempotencyKey, input.judgeStatus,
        input.judgeResultSource, input.judgeModel ?? null, input.judgeProvider ?? null,
        input.promptVersion, input.policyVersion, input.difficultyMethodVersion, input.contextHash,
        input.contextTokenEstimate ?? null, input.contextTruncated, input.difficultyScoreRaw ?? null,
        input.difficultyIndex ?? null, json(input.factors), json(input.probabilities),
        input.confidence ?? null, input.judgeEntropy ?? null, json(input.evidenceTags),
        input.explanation ?? null, input.promptTokens ?? null, input.completionTokens ?? null,
        input.latencyMs ?? null, input.actualCostUsd ?? "0", input.errorCategory ?? null],
    );
    if (result.rowCount === 1) return { judgeEvaluationId: input.judgeEvaluationId, inserted: true };
    const existing = await this.database.query<{ judge_evaluation_id: string }>(
      "SELECT judge_evaluation_id FROM acu_judge_evaluations WHERE judge_idempotency_key=$1",
      [input.judgeIdempotencyKey],
    );
    return { judgeEvaluationId: existing.rows[0].judge_evaluation_id, inserted: false };
  }

  async attachJudgePayloads(input: {
    judgeEvaluationId: string;
    newapiUserId: string;
    inputPayloadId: string;
    outputPayloadId: string;
  }): Promise<void> {
    const result = await this.database.query(
      `UPDATE acu_judge_evaluations SET input_payload_id=$3,output_payload_id=$4
       WHERE judge_evaluation_id=$1 AND newapi_user_id=$2`,
      [input.judgeEvaluationId, input.newapiUserId, input.inputPayloadId, input.outputPayloadId],
    );
    if (result.rowCount !== 1) throw new Error("Judge payload attachment failed or crossed user scope");
  }

  async saveRouteDecision(input: RouteDecisionRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO acu_route_decisions
       (route_decision_id,newapi_user_id,segment_id,judge_evaluation_id,mode,policy_version,
        routing_model_version,quality_curve_version,price_version,effective_quality_target,
        formula_inputs_json,candidate_estimates_json,pareto_frontier_json,selected_profile_json,
        route_explanation,fallback_source,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())`,
      [input.routeDecisionId, input.newapiUserId, input.segmentId, input.judgeEvaluationId ?? null,
        input.mode, input.policyVersion, input.routingModelVersion, input.qualityCurveVersion,
        input.priceVersion, input.effectiveQualityTarget, json(input.formulaInputs),
        json(input.candidateEstimates), json(input.paretoFrontier), json(input.selectedProfile),
        input.routeExplanation ?? null, input.fallbackSource ?? null],
    );
  }

  async getRouteDecision(routeDecisionId: string, newapiUserId: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.database.query(
      "SELECT * FROM acu_route_decisions WHERE route_decision_id=$1 AND newapi_user_id=$2",
      [routeDecisionId, newapiUserId],
    );
    return result.rows[0];
  }

  async savePayload(input: PayloadRecord): Promise<void> {
    const sanitized = sanitizePayloadForPersistence(input.body);
    const bodyJson = typeof sanitized === "string" ? null : json(sanitized);
    const bodyText = typeof sanitized === "string" ? sanitized : null;
    const serialized = bodyText ?? bodyJson ?? "null";
    await this.database.query(
      `INSERT INTO acu_payloads
       (payload_id,newapi_user_id,logical_request_id,attempt_id,payload_kind,protocol,content_type,
        headers_sanitized_json,body_json,body_text,body_sha256,is_complete,retention_until,created_at,metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,now()+interval '90 days',now(),$13)`,
      [input.payloadId, input.newapiUserId, input.logicalRequestId ?? null, input.attemptId ?? null,
        input.payloadKind, input.protocol ?? null, input.contentType ?? null,
        json(sanitizeHeadersForPersistence(input.headers ?? {})), bodyJson, bodyText,
        sha256(serialized), input.isComplete, json(sanitizePayloadForPersistence(input.metadata ?? {}))],
    );
  }

  async getPayload(payloadId: string, newapiUserId: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.database.query(
      "SELECT * FROM acu_payloads WHERE payload_id=$1 AND newapi_user_id=$2",
      [payloadId, newapiUserId],
    );
    return result.rows[0];
  }

  async createAttempt(input: AttemptRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO acu_attempts
       (attempt_id,logical_request_id,attempt_index,attempt_kind,retry_owner,route_decision_id,
        judge_evaluation_id,execution_profile_id,requested_model,actual_model,provider,channel,
        provider_request_id,status,error_category,http_status,usage_source,actual_cost_usd,
        input_price_per_million,output_price_per_million,provider_billed,started_at,metadata_json,
        channel_id,network_endpoint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now(),$22,$23,$24)`,
      [input.attemptId, input.logicalRequestId, input.attemptIndex, input.attemptKind,
        input.retryOwner, input.routeDecisionId ?? null, input.judgeEvaluationId ?? null,
        input.executionProfileId ?? null, input.requestedModel ?? null, input.actualModel ?? null,
        input.provider, input.channel ?? null, input.providerRequestId ?? null, input.status,
        input.errorCategory ?? null, input.httpStatus ?? null, input.usageSource ?? null,
        input.actualCostUsd ?? "0", input.inputPricePerMillion ?? null,
        input.outputPricePerMillion ?? null, input.providerBilled ?? null,
        json(input.metadata), input.channelId ?? input.channel ?? null, input.networkEndpoint ?? null],
    );
  }

  async channelHealth(channelId: string): Promise<HealthSnapshot | undefined> {
    const result = await this.database.query<Record<string, unknown>>(
      "SELECT * FROM acu_channel_health WHERE channel_id=$1", [channelId],
    );
    return result.rows[0] ? healthSnapshot(result.rows[0]) : undefined;
  }

  async profileHealth(executionProfileId: string): Promise<(HealthSnapshot & { usageTrusted?: boolean; actualModelVerified?: boolean }) | undefined> {
    const result = await this.database.query<Record<string, unknown>>(
      "SELECT * FROM acu_provider_model_profile_health WHERE execution_profile_id=$1", [executionProfileId],
    );
    const row = result.rows[0];
    return row ? { ...healthSnapshot(row), usageTrusted: row.usage_trusted === true, actualModelVerified: row.actual_model_verified === true } : undefined;
  }

  async claimHalfOpenProbe(scope: "channel" | "profile", id: string): Promise<boolean> {
    const table = scope === "channel" ? "acu_channel_health" : "acu_provider_model_profile_health";
    const column = scope === "channel" ? "channel_id" : "execution_profile_id";
    const result = await this.database.query(
      `UPDATE ${table} SET circuit_state='half_open',half_open_probe_in_flight=true,
       cooldown_until=now()+interval '2 minutes',updated_at=now()
       WHERE ${column}=$1 AND (
         (circuit_state='open' AND cooldown_until IS NOT NULL AND cooldown_until<=now()) OR
         (circuit_state='half_open' AND (half_open_probe_in_flight=false OR cooldown_until<=now()))
       ) RETURNING ${column}`,
      [id],
    );
    return result.rowCount === 1;
  }

  async releaseHalfOpenProbe(scope: "channel" | "profile", id: string): Promise<void> {
    const table = scope === "channel" ? "acu_channel_health" : "acu_provider_model_profile_health";
    const column = scope === "channel" ? "channel_id" : "execution_profile_id";
    await this.database.query(
      `UPDATE ${table} SET half_open_probe_in_flight=false,cooldown_until=NULL,updated_at=now()
       WHERE ${column}=$1 AND circuit_state='half_open'`,
      [id],
    );
  }

  async saveChannelHealth(input: { channelId: string; providerId: string; snapshot: HealthSnapshot }): Promise<void> {
    await this.database.query(
      `INSERT INTO acu_channel_health
       (channel_id,provider_id,circuit_state,cooldown_until,last_attempt_at,last_success_at,last_failure_at,
        consecutive_failures,recent_success_rate,first_token_latency_ms,total_latency_ms,error_class,http_status,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
       ON CONFLICT (channel_id) DO UPDATE SET provider_id=excluded.provider_id,circuit_state=excluded.circuit_state,
        cooldown_until=excluded.cooldown_until,last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,
        last_failure_at=excluded.last_failure_at,consecutive_failures=excluded.consecutive_failures,
        recent_success_rate=excluded.recent_success_rate,first_token_latency_ms=excluded.first_token_latency_ms,
        total_latency_ms=excluded.total_latency_ms,error_class=excluded.error_class,http_status=excluded.http_status,
        half_open_probe_in_flight=false,updated_at=now()`,
      healthValues(input.channelId, input.providerId, input.snapshot),
    );
  }

  async saveProfileHealth(input: { executionProfileId: string; channelId: string; providerId: string;
    canonicalModelId: string; protocol: AlphaProtocol; snapshot: HealthSnapshot; usageTrusted: boolean;
    actualModelVerified: boolean; healthReason?: string }): Promise<void> {
    await this.database.query(
      `INSERT INTO acu_provider_model_profile_health
       (execution_profile_id,channel_id,provider_id,canonical_model_id,protocol,circuit_state,cooldown_until,
        last_attempt_at,last_success_at,last_failure_at,consecutive_failures,recent_success_rate,
        first_token_latency_ms,total_latency_ms,error_class,http_status,actual_model_verified,usage_trusted,health_reason,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
       ON CONFLICT (execution_profile_id) DO UPDATE SET circuit_state=excluded.circuit_state,
        cooldown_until=excluded.cooldown_until,last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,
        last_failure_at=excluded.last_failure_at,consecutive_failures=excluded.consecutive_failures,
        recent_success_rate=excluded.recent_success_rate,first_token_latency_ms=excluded.first_token_latency_ms,
        total_latency_ms=excluded.total_latency_ms,error_class=excluded.error_class,http_status=excluded.http_status,
        actual_model_verified=excluded.actual_model_verified,usage_trusted=excluded.usage_trusted,
        health_reason=excluded.health_reason,half_open_probe_in_flight=false,updated_at=now()`,
      [input.executionProfileId, input.channelId, input.providerId, input.canonicalModelId, input.protocol,
        input.snapshot.state, input.snapshot.cooldownUntil ?? null, input.snapshot.lastAttemptAt ?? null,
        input.snapshot.lastSuccessAt ?? null, input.snapshot.lastFailureAt ?? null,
        input.snapshot.consecutiveFailures, input.snapshot.recentSuccessRate,
        input.snapshot.firstTokenLatencyMs ?? null, input.snapshot.totalLatencyMs ?? null,
        input.snapshot.errorClass ?? null, input.snapshot.httpStatus ?? null,
        input.actualModelVerified, input.usageTrusted, input.healthReason ?? null],
    );
  }

  async completeAttempt(input: {
    attemptId: string;
    status: string;
    actualModel?: string;
    providerRequestId?: string;
    errorCategory?: string;
    httpStatus?: number;
    inputTokens?: bigint;
    cachedInputTokens?: bigint;
    outputTokens?: bigint;
    reasoningTokens?: bigint;
    usageSource?: string;
    actualCostUsd?: string;
    providerBilled?: boolean;
    latencyMs?: number;
    visibleOutputBytes?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const result = await this.database.query(
      `UPDATE acu_attempts SET status=$2,actual_model=$3,provider_request_id=$4,error_category=$5,
       http_status=$6,input_tokens=$7,cached_input_tokens=$8,output_tokens=$9,reasoning_tokens=$10,
       usage_source=$11,actual_cost_usd=$12,provider_billed=$13,latency_ms=$14,
       visible_output_bytes=$15,completed_at=now(),metadata_json=$16 WHERE attempt_id=$1`,
      [input.attemptId, input.status, input.actualModel ?? null, input.providerRequestId ?? null,
        input.errorCategory ?? null, input.httpStatus ?? null, input.inputTokens ?? 0n,
        input.cachedInputTokens ?? 0n, input.outputTokens ?? 0n, input.reasoningTokens ?? 0n,
        input.usageSource ?? null, input.actualCostUsd ?? "0", input.providerBilled ?? null,
        input.latencyMs ?? null, input.visibleOutputBytes ?? 0, json(input.metadata)],
    );
    if (result.rowCount !== 1) throw new Error("Attempt completion failed");
  }

  async createUsageReport(input: UsageReportRecord): Promise<{ usageReportId: string; inserted: boolean }> {
    const result = await this.database.query<{ usage_report_id: string }>(
      `INSERT INTO acu_usage_reports
       (usage_report_id,newapi_user_id,newapi_token_id,newapi_log_id,logical_request_id,
        report_idempotency_key,actual_model,provider,channel,input_tokens,cached_input_tokens,
        output_tokens,reasoning_tokens,judge_cost_usd,provider_cost_usd,failed_billed_cost_usd,
        final_user_cost_usd,cost_breakdown_json,status,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending',now())
       ON CONFLICT (report_idempotency_key) DO NOTHING RETURNING usage_report_id`,
      [input.usageReportId, input.newapiUserId, input.newapiTokenId ?? null,
        input.newapiLogId ?? null, input.logicalRequestId, input.reportIdempotencyKey,
        input.actualModel ?? null, input.provider ?? null, input.channel ?? null,
        input.inputTokens ?? 0n, input.cachedInputTokens ?? 0n, input.outputTokens ?? 0n,
        input.reasoningTokens ?? 0n, input.judgeCostUsd ?? "0", input.providerCostUsd ?? "0",
        input.failedBilledCostUsd ?? "0", input.finalUserCostUsd, json(input.costBreakdown)],
    );
    if (result.rowCount === 1) return { usageReportId: input.usageReportId, inserted: true };
    const existing = await this.database.query<{ usage_report_id: string }>(
      "SELECT usage_report_id FROM acu_usage_reports WHERE report_idempotency_key=$1",
      [input.reportIdempotencyKey],
    );
    return { usageReportId: existing.rows[0].usage_report_id, inserted: false };
  }

  async claimUsageReports(limit = 10): Promise<PendingUsageReport[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.database.query<{
      usage_report_id: string;
      logical_request_id: string;
      report_idempotency_key: string;
      newapi_user_id: string;
      newapi_token_id: string | null;
      newapi_log_id: string | null;
      actual_model: string | null;
      provider: string | null;
      channel: string | null;
      input_tokens: string;
      cached_input_tokens: string;
      output_tokens: string;
      reasoning_tokens: string;
      judge_cost_usd: string;
      provider_cost_usd: string;
      failed_billed_cost_usd: string;
      final_user_cost_usd: string;
      cost_breakdown_json: Record<string, unknown>;
      send_attempt_count: number;
    }>(
      `WITH candidates AS (
         SELECT usage_report_id FROM acu_usage_reports
         WHERE (status IN ('pending','failed') AND (next_send_at IS NULL OR next_send_at <= now()))
            OR (status='sending' AND next_send_at <= now())
         ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE acu_usage_reports AS reports
       SET status='sending',send_attempt_count=reports.send_attempt_count+1,
           next_send_at=now()+interval '5 minutes',last_error=NULL
       FROM candidates WHERE reports.usage_report_id=candidates.usage_report_id
       RETURNING reports.*`,
      [safeLimit],
    );
    return result.rows.map((row) => ({
      usageReportId: row.usage_report_id,
      logicalRequestId: row.logical_request_id,
      reportIdempotencyKey: row.report_idempotency_key,
      newapiUserId: row.newapi_user_id,
      newapiTokenId: row.newapi_token_id ?? undefined,
      newapiLogId: row.newapi_log_id ?? undefined,
      actualModel: row.actual_model ?? undefined,
      provider: row.provider ?? undefined,
      channel: row.channel ?? undefined,
      inputTokens: BigInt(row.input_tokens),
      cachedInputTokens: BigInt(row.cached_input_tokens),
      outputTokens: BigInt(row.output_tokens),
      reasoningTokens: BigInt(row.reasoning_tokens),
      judgeCostUsd: row.judge_cost_usd,
      providerCostUsd: row.provider_cost_usd,
      failedBilledCostUsd: row.failed_billed_cost_usd,
      finalUserCostUsd: row.final_user_cost_usd,
      costBreakdown: row.cost_breakdown_json,
      sendAttemptCount: row.send_attempt_count,
    }));
  }

  async acknowledgeUsageReport(usageReportId: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE acu_usage_reports SET status='acknowledged',sent_at=COALESCE(sent_at,now()),
       acknowledged_at=now(),next_send_at=NULL,last_error=NULL
       WHERE usage_report_id=$1 AND status='sending'`,
      [usageReportId],
    );
    if (result.rowCount !== 1) throw new Error("Usage report acknowledgment lost its sending claim");
  }

  async failUsageReport(usageReportId: string, error: string, retryAfterSeconds: number): Promise<void> {
    const safeDelay = Math.max(1, Math.min(3600, Math.trunc(retryAfterSeconds)));
    const result = await this.database.query(
      `UPDATE acu_usage_reports SET status='failed',last_error=$2,
       next_send_at=now()+($3::text || ' seconds')::interval
       WHERE usage_report_id=$1 AND status='sending'`,
      [usageReportId, error.slice(0, 2_000), safeDelay],
    );
    if (result.rowCount !== 1) throw new Error("Usage report failure update lost its sending claim");
  }

  async findUserScoped<R extends QueryResultRow>(
    table: "acu_sessions" | "acu_tasks" | "acu_segments" | "acu_logical_requests" | "acu_usage_reports",
    idColumn: string,
    id: string,
    newapiUserId: string,
  ): Promise<R | undefined> {
    const allowedIdColumns: Record<typeof table, string> = {
      acu_sessions: "session_id",
      acu_tasks: "task_id",
      acu_segments: "segment_id",
      acu_logical_requests: "logical_request_id",
      acu_usage_reports: "usage_report_id",
    };
    if (allowedIdColumns[table] !== idColumn) throw new Error("Unsupported scoped lookup");
    const result = await this.database.query<R>(
      `SELECT * FROM ${table} WHERE ${idColumn}=$1 AND newapi_user_id=$2`,
      [id, newapiUserId],
    );
    return result.rows[0];
  }
}
