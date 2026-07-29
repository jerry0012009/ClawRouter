import { createHash, randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { SqlExecutor } from "./database.js";
import { sanitizeHeadersForPersistence, sanitizePayloadForPersistence } from "./secrets.js";

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
  providerRequestId?: string;
  errorCategory?: string;
  httpStatus?: number;
  usageSource?: string;
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

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export class AlphaRepository {
  constructor(private readonly database: SqlExecutor) {}

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
        ingress_idempotency_key,request_protocol,requested_model,status,had_tools,streaming,started_at,metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14)
       ON CONFLICT (newapi_user_id,ingress_idempotency_key) DO NOTHING RETURNING logical_request_id`,
      [input.logicalRequestId, input.newapiUserId, input.newapiTokenId ?? null,
        input.newapiLogId ?? null, input.sessionId, input.taskId, input.segmentId,
        input.ingressIdempotencyKey, input.requestProtocol, input.requestedModel,
        input.status ?? "pending", input.hadTools ?? false, input.streaming, json(input.metadata)],
    );
    if (result.rowCount === 1) return { logicalRequestId: input.logicalRequestId, inserted: true };
    const existing = await this.database.query<{ logical_request_id: string }>(
      "SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id=$1 AND ingress_idempotency_key=$2",
      [input.newapiUserId, input.ingressIdempotencyKey],
    );
    return { logicalRequestId: existing.rows[0].logical_request_id, inserted: false };
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
        sha256(serialized), input.isComplete, json(input.metadata)],
    );
  }

  async createAttempt(input: AttemptRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO acu_attempts
       (attempt_id,logical_request_id,attempt_index,attempt_kind,retry_owner,route_decision_id,
        judge_evaluation_id,execution_profile_id,requested_model,actual_model,provider,channel,
        provider_request_id,status,error_category,http_status,usage_source,actual_cost_usd,
        provider_billed,started_at,metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now(),$20)`,
      [input.attemptId, input.logicalRequestId, input.attemptIndex, input.attemptKind,
        input.retryOwner, input.routeDecisionId ?? null, input.judgeEvaluationId ?? null,
        input.executionProfileId ?? null, input.requestedModel ?? null, input.actualModel ?? null,
        input.provider, input.channel ?? null, input.providerRequestId ?? null, input.status,
        input.errorCategory ?? null, input.httpStatus ?? null, input.usageSource ?? null,
        input.actualCostUsd ?? "0", input.providerBilled ?? null, json(input.metadata)],
    );
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
