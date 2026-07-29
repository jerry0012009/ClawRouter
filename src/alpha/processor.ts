import type { IncomingHttpHeaders } from "node:http";
import { canonicalHash, record } from "./protocol/common.js";
import type { CanonicalEnvelope } from "./protocol/types.js";
import { AlphaDatabase } from "./database.js";
import { applyFailureEvidence, decideTrigger, type AlphaMode, type SegmentState, type TriggerDecision } from "./state-machine.js";
import { extractIncrementalEvents, type AlphaDomainEvent } from "./events.js";
import { matchSession, type SessionContinuityRecord } from "./identity.js";
import { buildAlphaJudgeContext } from "./judge-context.js";
import type { AlphaJudgeRun, AlphaJudgeRunner } from "./judge-runner.js";
import { AlphaRepository, alphaId, sha256, type AlphaProtocol } from "./repository.js";
import {
  resolveExplicitProfile,
  routeWithCurrentAcuFormula,
  type AlphaExecutionProfile,
  type AlphaRouteDecision,
} from "./routing.js";
import type { AlphaGatewayTrace, AlphaIngressContext, AlphaExecutionResolution } from "./gateway.js";
import type { NativeProviderAdapter } from "./provider.js";
import type { TrustedNewApiIdentity } from "./trusted-identity.js";
import { parseProviderUsage, sumCost } from "./usage.js";
import { getAcuModel } from "../acu/catalog.js";
import {
  createRecoveringProviderAdapter,
  type BufferedProviderFailure,
  type ProviderAttemptHandle,
} from "./execution.js";

const POLICY_VERSION = "alpha-p0-policy-v1";
const QUALITY_CURVE_VERSION = "acu-catalog-v0.1";
const PRICE_VERSION = "acu-catalog-v0.1";

type JsonObject = Record<string, unknown>;

export type AlphaProcessorOptions = {
  database: AlphaDatabase;
  profiles: AlphaExecutionProfile[];
  adapters: Map<string, NativeProviderAdapter>;
  judgeRunner: AlphaJudgeRunner;
  maxUnjudgedModelResponses?: number;
  expectedOutputTokens?: number;
};

export type AlphaResolutionContext = {
  logicalRequestId: string;
  attemptId?: string;
  attemptIndex?: number;
  requestPayloadId?: string;
  sessionId: string;
  taskId: string;
  segmentId: string;
  newapiUserId: string;
  newapiTokenId: string;
  newapiLogId: string;
  protocol: AlphaProtocol;
  selectedProfile: AlphaExecutionProfile;
  judgeCostUsd: string;
  requestBytes: number;
  replayed: boolean;
  routeSummary: {
    mode: string;
    difficulty?: number;
    candidateCount: number;
    selectedModel: string;
    routeReason: string;
    qualityUpperBoundModel?: string;
    estimatedCostReductionVsQualityUpperBoundUsd?: number;
  };
};

type PreparedState = {
  sessionId: string;
  taskId: string;
  segmentId: string;
  segment: SegmentState;
  decision: TriggerDecision;
  triggerEventId?: string;
  events: AlphaDomainEvent[];
  stateMetadata: JsonObject;
  taskBaseQualityTarget: number;
  capabilityEscalationFloor: number;
  effectiveQualityTarget: number;
  isNewTask: boolean;
  rootGoalText?: string;
};

function metadata(row: JsonObject | undefined): JsonObject {
  return record(row?.metadata_json) ?? {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown, fallback = 0): number {
  const valueAsNumber = Number(value);
  return Number.isFinite(valueAsNumber) ? valueAsNumber : fallback;
}

function routeDisplaySummary(
  requestedModel: string,
  selectedModel: string,
  judge: AlphaJudgeRun | undefined,
  route: AlphaRouteDecision | undefined,
  storedRoute?: JsonObject,
): AlphaResolutionContext["routeSummary"] {
  if (!route && modeForModel(requestedModel) !== "explicit" && storedRoute) {
    const candidates = Array.isArray(storedRoute.candidate_estimates_json)
      ? storedRoute.candidate_estimates_json.map(record).filter((item): item is JsonObject => Boolean(item))
      : [];
    const selected = candidates.find((candidate) => candidate.modelId === selectedModel);
    const qualityUpperBound = candidates.reduce<JsonObject | undefined>((best, candidate) => (
      !best || numberValue(candidate.conservativeScore) > numberValue(best.conservativeScore) ? candidate : best
    ), undefined);
    const formulaInputs = record(storedRoute.formula_inputs_json);
    const storedJudge = record(formulaInputs?.judge);
    const difficulty = Number(storedJudge?.difficultyIndex);
    return {
      mode: stringValue(storedRoute.mode) ?? requestedModel,
      difficulty: Number.isFinite(difficulty) ? difficulty : undefined,
      candidateCount: candidates.length,
      selectedModel,
      routeReason: (stringValue(storedRoute.route_explanation) ?? "Reused the segment's saved route decision.").slice(0, 240),
      qualityUpperBoundModel: stringValue(qualityUpperBound?.modelId),
      estimatedCostReductionVsQualityUpperBoundUsd: selected && qualityUpperBound
        ? Math.max(0, numberValue(qualityUpperBound.expectedTotalCost) - numberValue(selected.expectedTotalCost))
        : undefined,
    };
  }
  if (!route) {
    return {
      mode: "explicit",
      candidateCount: 0,
      selectedModel,
      routeReason: `Explicit model ${requestedModel}; Judge and automatic selection skipped.`,
    };
  }
  const selected = route.candidateEstimates.find((candidate) => candidate.modelId === selectedModel);
  const qualityUpperBound = route.candidateEstimates.reduce((best, candidate) => (
    !best || candidate.conservativeScore > best.conservativeScore ? candidate : best
  ), undefined as (typeof route.candidateEstimates)[number] | undefined);
  return {
    mode: requestedModel,
    difficulty: judge?.judge.difficultyIndex,
    candidateCount: route.candidateEstimates.length,
    selectedModel,
    routeReason: route.recommendation.reason.slice(0, 240),
    qualityUpperBoundModel: qualityUpperBound?.modelId,
    estimatedCostReductionVsQualityUpperBoundUsd: selected && qualityUpperBound
      ? Math.max(0, qualityUpperBound.expectedTotalCost - selected.expectedTotalCost)
      : undefined,
  };
}

function clientInfo(protocol: AlphaProtocol, headers: IncomingHttpHeaders): { name: string; version?: string } {
  const userAgent = Array.isArray(headers["user-agent"])
    ? headers["user-agent"][0]
    : headers["user-agent"] ?? "";
  if (protocol === "responses") {
    return { name: "codex", version: /codex_exec\/([^\s]+)/.exec(userAgent)?.[1] };
  }
  return { name: "claude-code", version: /claude-cli\/([^\s]+)/.exec(userAgent)?.[1] };
}

function clientSessionCandidate(envelope: CanonicalEnvelope, headers: IncomingHttpHeaders): string | undefined {
  const clientMetadata = record(envelope.raw.client_metadata);
  const header = headers["thread-id"] ?? headers["session-id"] ?? headers["x-claude-code-session-id"];
  return stringValue(clientMetadata?.session_id)
    ?? (Array.isArray(header) ? header[0] : header);
}

function sessionRecords(rows: JsonObject[]): SessionContinuityRecord[] {
  return rows.map((row) => {
    const rowMetadata = metadata(row);
    return {
      sessionId: String(row.session_id),
      newapiUserId: String(row.newapi_user_id),
      protocol: row.native_protocol as AlphaProtocol,
      historyItemHashes: Array.isArray(rowMetadata.historyItemHashes)
        ? rowMetadata.historyItemHashes.filter((item): item is string => typeof item === "string")
        : [],
      lastToolCallIds: Array.isArray(rowMetadata.lastToolCallIds)
        ? rowMetadata.lastToolCallIds.filter((item): item is string => typeof item === "string")
        : [],
      clientSessionCandidate: stringValue(rowMetadata.clientSessionCandidate),
    };
  });
}

function isExplicitNewGoal(events: AlphaDomainEvent[]): boolean {
  return events.some((item) => item.type === "human_message" && item.evidenceStrength === "high"
    && /\b(?:new task|switch (?:to )?(?:another|a new) task|reset the task|unrelated task)\b|新任务|换个任务|另一个任务|重置任务/i
      .test(String(item.metadata.text ?? "")));
}

function modeForModel(model: string): AlphaMode {
  if (model === "acu-auto") return "acu-auto";
  if (model === "acu-high") return "acu-high";
  return "explicit";
}

function rootGoal(events: AlphaDomainEvent[]): string | undefined {
  return stringValue(events.find((item) => item.type === "human_message" && item.evidenceStrength === "high")?.metadata.text);
}

function selectedProfileFromSegment(
  row: JsonObject | undefined,
  profiles: AlphaExecutionProfile[],
): AlphaExecutionProfile | undefined {
  const id = stringValue(row?.selected_execution_profile_id);
  return id ? profiles.find((profile) => profile.executionProfileId === id) : undefined;
}

function rewriteModel(rawBody: Uint8Array, model: string): Buffer {
  const parsed = JSON.parse(Buffer.from(rawBody).toString("utf8")) as JsonObject;
  return Buffer.from(JSON.stringify({ ...parsed, model }));
}

function responseContentType(headers: Record<string, string>): string {
  return headers["content-type"] ?? "application/octet-stream";
}

function staticResponseAdapter(payload: JsonObject): NativeProviderAdapter {
  const payloadMetadata = metadata(payload);
  const headers = new Headers(record(payloadMetadata.responseHeaders) as Record<string, string> | undefined);
  const body = typeof payload.body_text === "string"
    ? payload.body_text
    : JSON.stringify(payload.body_json ?? {});
  return {
    async execute() {
      return new Response(body, {
        status: numberValue(payloadMetadata.httpStatus, 200),
        headers,
      });
    },
  };
}

function updatePlanningMetadata(current: JsonObject, events: AlphaDomainEvent[]): JsonObject {
  let planningActive = current.planningActive === true;
  let activePlanHash = stringValue(current.activePlanHash);
  let activePlanComplete = current.activePlanComplete === true;
  for (const item of events) {
    if (item.type === "plan_started") planningActive = true;
    if (item.type === "plan_started" || item.type === "plan_updated") {
      activePlanHash = stringValue(item.metadata.planHash) ?? activePlanHash;
      if (item.metadata.complete === true) activePlanComplete = true;
    }
    if (item.type === "plan_finished") {
      planningActive = false;
      activePlanComplete = false;
    }
  }
  return { ...current, planningActive, activePlanHash, activePlanComplete };
}

export class AlphaRequestProcessor {
  private readonly maxUnjudged: number;
  private readonly expectedOutputTokens: number;

  constructor(private readonly options: AlphaProcessorOptions) {
    this.maxUnjudged = options.maxUnjudgedModelResponses ?? 16;
    this.expectedOutputTokens = options.expectedOutputTokens ?? 800;
  }

  private async prepareState(
    envelope: CanonicalEnvelope,
    identity: TrustedNewApiIdentity,
    ingress: AlphaIngressContext,
    mode: AlphaMode,
  ): Promise<PreparedState> {
    return this.options.database.transaction(async (client) => {
      const repository = new AlphaRepository(client);
      await repository.lockUserState(identity.newapiUserId);
      const info = clientInfo(envelope.protocol, ingress.headers);
      if (identity.clientVersion && identity.clientVersion !== "unknown") info.version = identity.clientVersion;
      const candidate = clientSessionCandidate(envelope, ingress.headers);
      const candidates = await repository.listSessionCandidates(identity.newapiUserId, envelope.protocol);
      const match = matchSession(sessionRecords(candidates), {
        newapiUserId: identity.newapiUserId,
        envelope,
        clientSessionCandidate: candidate,
      });
      let sessionId = match.sessionId;
      let sessionRow = sessionId ? candidates.find((row) => row.session_id === sessionId) : undefined;
      if (!sessionId) {
        sessionId = alphaId("ses");
        await repository.createSession({
          sessionId,
          newapiUserId: identity.newapiUserId,
          newapiTokenId: identity.newapiTokenId,
          clientName: info.name,
          clientVersion: info.version,
          nativeProtocol: envelope.protocol,
          continuityFingerprint: canonicalHash({ protocol: envelope.protocol, candidate }),
          historyPrefixHash: envelope.historyHash,
          toolSchemaFingerprint: canonicalHash(envelope.tools),
          lastToolCallId: envelope.toolCalls.at(-1)?.id,
          metadata: {},
        });
        sessionRow = undefined;
      }

      const previousHistoryLength = match.previousHistoryLength;
      let taskId = stringValue(sessionRow?.current_task_id);
      let taskRow = taskId ? await repository.getTask(taskId, identity.newapiUserId) : undefined;
      let segmentId = stringValue(sessionRow?.current_segment_id);
      let segmentRow = segmentId ? await repository.getSegment(segmentId, identity.newapiUserId) : undefined;
      if (taskId) await repository.lockTask(taskId, identity.newapiUserId);
      const segmentMetadata = metadata(segmentRow);
      const allEvents = extractIncrementalEvents(envelope, {
        previousHistoryLength,
        planningActive: segmentMetadata.planningActive === true,
        activePlanHash: stringValue(segmentMetadata.activePlanHash),
        activePlanComplete: segmentMetadata.activePlanComplete === true,
      });
      const newGoal = taskId !== undefined && isExplicitNewGoal(allEvents);
      let isNewTask = taskId === undefined || !taskRow || newGoal;
      const baseQualityTarget = mode === "acu-high" ? 92 : mode === "acu-auto" ? 80 : 0;
      if (isNewTask) {
        taskId = alphaId("task");
        await repository.createTask({
          taskId,
          sessionId,
          newapiUserId: identity.newapiUserId,
          rootGoalText: rootGoal(allEvents),
          rootGoalHash: rootGoal(allEvents) ? sha256(rootGoal(allEvents)!) : undefined,
          phase: "execution",
          baseQualityTarget,
          status: "active",
        });
        taskRow = await repository.getTask(taskId, identity.newapiUserId);
        segmentId = undefined;
        segmentRow = undefined;
      }
      if (!taskId || !taskRow) throw new Error("Unable to resolve Alpha task");

      const insertedEvents: AlphaDomainEvent[] = [];
      let triggerEventId: string | undefined;
      for (const item of allEvents) {
        const eventId = alphaId("evt");
        const stored = await repository.insertEvent({
          eventId,
          sessionId,
          taskId,
          segmentId,
          eventType: item.type,
          eventHash: item.hash,
          evidenceStrength: item.evidenceStrength,
          sourceProtocol: envelope.protocol,
          sourceClient: info.name,
          sourceClientVersion: info.version,
          toolCallId: item.toolCallId,
          failureSignature: item.failureSignature,
          failureSignatureVersion: item.failureSignature ? "failure-signature-v1" : undefined,
          metadata: item.metadata,
        });
        if (stored.inserted) {
          insertedEvents.push(item);
          triggerEventId ??= stored.eventId;
        }
      }

      const currentSegment: SegmentState | undefined = segmentId && segmentRow ? {
        segmentId,
        phase: String(segmentRow.phase ?? "execution"),
        acceptedModelResponsesSinceJudge: numberValue(segmentRow.accepted_responses_since_judge),
        planningActive: segmentMetadata.planningActive === true,
        failureCounters: record(segmentMetadata.failureCounters) as SegmentState["failureCounters"] ?? {},
      } : undefined;
      let decision = decideTrigger({
        mode,
        isNewTask,
        events: insertedEvents,
        segment: currentSegment,
        maxUnjudgedModelResponses: this.maxUnjudged,
      });
      const explicitProfile = mode === "explicit"
        ? selectedProfileFromSegment(segmentRow, this.options.profiles)
        : undefined;
      if (mode === "explicit" && explicitProfile && explicitProfile.modelId !== envelope.requestedModel) {
        decision = { ...decision, createSegment: true };
      }
      if (mode === "explicit" && insertedEvents.some((item) => ["human_message", "plan_started", "plan_finished"].includes(item.type))) {
        decision = { ...decision, createSegment: true };
      }

      const failureCounters = applyFailureEvidence(currentSegment?.failureCounters ?? {}, insertedEvents);
      let nextMetadata = updatePlanningMetadata(segmentMetadata, insertedEvents);
      nextMetadata = { ...nextMetadata, failureCounters };
      const capabilityFloor = numberValue(taskRow.capability_escalation_floor);
      const temporaryOverride = decision.temporaryPhaseOverride;
      const effectiveQualityTarget = Math.max(baseQualityTarget, capabilityFloor, temporaryOverride);
      if (!segmentId || !segmentRow || (decision.createSegment && !isNewTask)) {
        if (segmentId) await repository.supersedeActiveSegment(taskId, identity.newapiUserId);
        const previousSegmentId = segmentId;
        segmentId = alphaId("seg");
        await repository.createSegment({
          segmentId,
          taskId,
          newapiUserId: identity.newapiUserId,
          previousSegmentId,
          creationReason: isNewTask ? "task_start" : decision.reason,
          phase: decision.phase,
          taskBaseQualityTarget: baseQualityTarget,
          capabilityEscalationFloor: capabilityFloor,
          temporaryPhaseOverride: temporaryOverride,
          effectiveQualityTarget,
          metadata: nextMetadata,
        });
        segmentRow = await repository.getSegment(segmentId, identity.newapiUserId);
      } else {
        await repository.updateSegmentMetadata(segmentId, identity.newapiUserId, nextMetadata);
      }
      if (!segmentId || !segmentRow) throw new Error("Unable to resolve Alpha segment");

      const lastToolCallIds = envelope.toolCalls.slice(-16).map((call) => call.id);
      await repository.updateSessionState({
        sessionId,
        newapiUserId: identity.newapiUserId,
        currentTaskId: taskId,
        currentSegmentId: segmentId,
        historyPrefixHash: envelope.historyHash,
        lastToolCallId: lastToolCallIds.at(-1),
        metadata: {
          historyItemHashes: envelope.history.map((item) => canonicalHash(item)),
          lastToolCallIds,
          clientSessionCandidate: candidate,
        },
      });
      isNewTask = isNewTask || newGoal;
      return {
        sessionId,
        taskId,
        segmentId,
        segment: currentSegment ?? {
          segmentId,
          phase: decision.phase,
          acceptedModelResponsesSinceJudge: 0,
          planningActive: nextMetadata.planningActive === true,
          failureCounters,
        },
        decision,
        triggerEventId,
        events: insertedEvents,
        stateMetadata: nextMetadata,
        taskBaseQualityTarget: baseQualityTarget,
        capabilityEscalationFloor: capabilityFloor,
        effectiveQualityTarget,
        isNewTask,
        rootGoalText: stringValue(taskRow.root_goal_text),
      };
    });
  }

  private async judgeAndRoute(
    envelope: CanonicalEnvelope,
    identity: TrustedNewApiIdentity,
    state: PreparedState,
    rawBytes: number,
  ): Promise<{ profile: AlphaExecutionProfile; judge?: AlphaJudgeRun; route?: AlphaRouteDecision }> {
    const repository = new AlphaRepository(this.options.database);
    if (modeForModel(envelope.requestedModel) === "explicit") {
      const profile = resolveExplicitProfile(envelope.requestedModel, this.options.profiles, {
        protocol: envelope.protocol,
        requireTools: envelope.tools.length > 0,
        requireThinking: envelope.containsThinking,
        contextTokens: Math.ceil(rawBytes / 4),
      });
      if (state.decision.createSegment || !state.segment.segmentId) {
        const routeDecisionId = alphaId("route");
        await repository.saveRouteDecision({
          routeDecisionId,
          newapiUserId: identity.newapiUserId,
          segmentId: state.segmentId,
          mode: "explicit",
          policyVersion: `${POLICY_VERSION}:${identity.routingPolicyVersion}`,
          routingModelVersion: "explicit-model-v1",
          qualityCurveVersion: QUALITY_CURVE_VERSION,
          priceVersion: PRICE_VERSION,
          effectiveQualityTarget: 0,
          formulaInputs: {
            requestedModel: envelope.requestedModel,
            judgeCalls: 0,
            userRoutingPolicy: identity.routingPolicy,
            userRoutingPolicyVersion: identity.routingPolicyVersion,
          },
          candidateEstimates: [],
          paretoFrontier: [],
          selectedProfile: { ...profile },
          routeExplanation: "User-selected explicit model; Judge and ACU model selection skipped.",
        });
        await repository.updateSegmentDecision({
          segmentId: state.segmentId,
          newapiUserId: identity.newapiUserId,
          routeDecisionId,
          selectedExecutionProfileId: profile.executionProfileId,
          metadata: {
            ...state.stateMetadata,
            selectedProfile: profile,
            userRoutingPolicyVersion: identity.routingPolicyVersion,
          },
        });
      }
      return { profile };
    }

    const storedSegment = await repository.getSegment(state.segmentId, identity.newapiUserId);
    const storedProfile = selectedProfileFromSegment(storedSegment, this.options.profiles);
    const policyVersionMatches = metadata(storedSegment).userRoutingPolicyVersion === identity.routingPolicyVersion;
    const reused = storedProfile
      && policyVersionMatches
      && identity.routingPolicy !== "explicit_only"
      && (identity.routingPolicy !== "custom_allowlist" || identity.allowedModelIds.includes(storedProfile.modelId))
      ? storedProfile
      : undefined;
    if (!state.decision.runJudge && reused) return { profile: reused };

    const context = buildAlphaJudgeContext(envelope, {
      sessionId: state.sessionId,
      taskId: state.taskId,
      segmentId: state.segmentId,
      rootGoalText: state.rootGoalText,
      phase: state.decision.phase,
      trigger: state.decision.runJudge ? state.decision.reason : "safety_refresh",
      recentEvents: state.events,
      acceptedModelResponsesSinceJudge: state.segment.acceptedModelResponsesSinceJudge,
      taskBaseQualityTarget: state.taskBaseQualityTarget,
      capabilityEscalationFloor: state.capabilityEscalationFloor,
      temporaryPhaseOverride: state.decision.temporaryPhaseOverride,
    });
    const contextHash = canonicalHash(context.envelope);
    const previousJudge = record(metadata(storedSegment).judgeRun) as AlphaJudgeRun | undefined;
    const judge = await this.options.judgeRunner.run({
      messages: context.messages,
      tools: context.tools,
      trigger: state.decision.runJudge ? state.decision.reason : "safety_refresh",
      contextHash,
      recentEvaluation: previousJudge,
    });
    const route = routeWithCurrentAcuFormula({
      judge: judge.judge,
      judgeCost: Number(judge.costUsd),
      inputTokens: Math.ceil(rawBytes / 4),
      expectedOutputTokens: this.expectedOutputTokens,
      effectiveQualityTarget: state.effectiveQualityTarget,
      profiles: this.options.profiles,
      requirements: {
        protocol: envelope.protocol,
        requireTools: envelope.tools.length > 0,
        requireThinking: envelope.containsThinking,
        contextTokens: Math.ceil(rawBytes / 4),
        allowedModelIds: identity.routingPolicy === "all_routing_eligible"
          ? undefined
          : identity.routingPolicy === "custom_allowlist"
            ? identity.allowedModelIds
            : [],
      },
      routeDirection: state.decision.routeDirection,
      currentProfile: reused,
    });
    const judgeEvaluationId = alphaId("judge");
    const judgeIdempotencyKey = sha256([
      judge.policyVersion,
      judge.promptVersion,
      judge.model ?? "none",
      state.triggerEventId ?? `${state.decision.reason}:${state.segmentId}`,
      judge.contextHash,
    ].join("\n"));
    const storedJudge = await repository.saveJudgeEvaluation({
      judgeEvaluationId,
      newapiUserId: identity.newapiUserId,
      taskId: state.taskId,
      segmentId: state.segmentId,
      triggerEventId: state.triggerEventId,
      judgeIdempotencyKey,
      judgeStatus: judge.status,
      judgeResultSource: judge.resultSource,
      judgeModel: judge.model,
      judgeProvider: judge.provider,
      promptVersion: judge.promptVersion,
      policyVersion: judge.policyVersion,
      difficultyMethodVersion: judge.judge.difficultyMethodVersion,
      contextHash: judge.contextHash,
      contextTokenEstimate: BigInt(judge.contextTokenEstimate),
      contextTruncated: judge.contextTruncated,
      difficultyScoreRaw: judge.judge.difficultyScoreRaw,
      difficultyIndex: judge.judge.difficultyIndex,
      factors: { ...judge.judge.factors },
      probabilities: {
        pLow: judge.judge.pLow,
        pMid: judge.judge.pMid,
        pMidHigh: judge.judge.pMidHigh,
        pHigh: judge.judge.pHigh,
      },
      confidence: judge.judge.confidence,
      judgeEntropy: judge.entropy,
      evidenceTags: judge.judge.signals,
      explanation: judge.judge.explanation,
      promptTokens: BigInt(judge.promptTokens),
      completionTokens: BigInt(judge.completionTokens),
      latencyMs: judge.latencyMs,
      actualCostUsd: judge.costUsd,
      errorCategory: judge.errorCategory,
    });
    if (storedJudge.inserted) {
      const inputPayloadId = alphaId("payload");
      const outputPayloadId = alphaId("payload");
      await repository.savePayload({
        payloadId: inputPayloadId,
        newapiUserId: identity.newapiUserId,
        payloadKind: "judge_request",
        protocol: envelope.protocol,
        contentType: "application/json",
        body: {
          messages: context.messages,
          tools: context.tools,
          trigger: state.decision.reason,
          contextHash,
        },
        isComplete: true,
      });
      await repository.savePayload({
        payloadId: outputPayloadId,
        newapiUserId: identity.newapiUserId,
        payloadKind: "judge_response",
        protocol: envelope.protocol,
        contentType: "application/json",
        body: judge,
        isComplete: true,
      });
      await repository.attachJudgePayloads({
        judgeEvaluationId: storedJudge.judgeEvaluationId,
        newapiUserId: identity.newapiUserId,
        inputPayloadId,
        outputPayloadId,
      });
    }
    const routeDecisionId = alphaId("route");
    await repository.saveRouteDecision({
      routeDecisionId,
      newapiUserId: identity.newapiUserId,
      segmentId: state.segmentId,
      judgeEvaluationId: storedJudge.judgeEvaluationId,
      mode: envelope.requestedModel,
      policyVersion: `${POLICY_VERSION}:${identity.routingPolicyVersion}`,
      routingModelVersion: route.formulaVersion,
      qualityCurveVersion: QUALITY_CURVE_VERSION,
      priceVersion: PRICE_VERSION,
      effectiveQualityTarget: state.effectiveQualityTarget,
      formulaInputs: {
        judge: judge.judge,
        judgeCost: judge.costUsd,
        inputTokens: Math.ceil(rawBytes / 4),
        expectedOutputTokens: this.expectedOutputTokens,
        userRoutingPolicy: identity.routingPolicy,
        userRoutingPolicyVersion: identity.routingPolicyVersion,
        allowedModelIds: identity.allowedModelIds,
        configuredProfileCount: this.options.profiles.length,
        protocolProfileCount: this.options.profiles.filter((profile) => profile.protocols.includes(envelope.protocol)).length,
        initialCandidateModelCount: new Set(
          this.options.profiles
            .filter((profile) => profile.protocols.includes(envelope.protocol))
            .map((profile) => profile.modelId),
        ).size,
        hardFilteredProfileCount: route.candidateEstimates
          .reduce((count, estimate) => count + estimate.executionProfileIds.length, 0),
        hardFilteredCandidateModelCount: route.candidateEstimates.length,
        paretoFrontierCandidateCount: route.paretoFrontier.length,
        excludedProfiles: route.excludedProfiles,
      },
      candidateEstimates: route.candidateEstimates,
      paretoFrontier: route.paretoFrontier,
      selectedProfile: { ...route.selectedProfile },
      routeExplanation: route.recommendation.reason,
      fallbackSource: judge.status.includes("fallback") ? judge.resultSource : undefined,
    });
    await repository.updateSegmentDecision({
      segmentId: state.segmentId,
      newapiUserId: identity.newapiUserId,
      judgeEvaluationId: storedJudge.judgeEvaluationId,
      routeDecisionId,
      selectedExecutionProfileId: route.selectedProfile.executionProfileId,
      metadata: {
        ...state.stateMetadata,
        judgeRun: judge,
        selectedProfile: route.selectedProfile,
        userRoutingPolicyVersion: identity.routingPolicyVersion,
      },
    });
    return { profile: route.selectedProfile, judge, route };
  }

  private recoveryProfile(
    current: AlphaExecutionProfile,
    envelope: CanonicalEnvelope,
    mode: AlphaMode,
    rawBytes: number,
  ): AlphaExecutionProfile | undefined {
    if (mode === "explicit") return current;
    const equivalent = this.options.profiles.find((profile) => (
      profile.executionProfileId !== current.executionProfileId
      && profile.modelId === current.modelId
      && profile.enabled
      && profile.administratorAllowed
      && profile.health === "healthy"
      && profile.protocols.includes(envelope.protocol)
      && (!envelope.tools.length || profile.toolCallSupport)
      && (!envelope.containsThinking || profile.thinkingSupport)
      && profile.contextWindow >= Math.ceil(rawBytes / 4)
      && this.options.adapters.has(profile.executionProfileId)
    ));
    return equivalent ?? current;
  }

  private async recordProviderFailure(input: {
    identity: TrustedNewApiIdentity;
    state: PreparedState;
    logicalRequestId: string;
    attempt: ProviderAttemptHandle;
    protocol: AlphaProtocol;
    requestBytes: number;
    response?: BufferedProviderFailure;
    error?: unknown;
    latencyMs: number;
  }): Promise<void> {
    const repository = new AlphaRepository(this.options.database);
    const contentType = input.response ? responseContentType(input.response.headers) : undefined;
    const usage = input.response ? parseProviderUsage({
      protocol: input.protocol,
      body: input.response.body,
      contentType: contentType ?? "application/octet-stream",
      requestedModel: input.attempt.profile.modelId,
      requestBytes: input.requestBytes,
    }) : undefined;
    if (input.response) {
      await repository.savePayload({
        payloadId: alphaId("payload"),
        newapiUserId: input.identity.newapiUserId,
        logicalRequestId: input.logicalRequestId,
        attemptId: input.attempt.attemptId,
        payloadKind: contentType?.includes("text/event-stream") ? "provider_stream" : "provider_response",
        protocol: input.protocol,
        contentType,
        headers: input.response.headers,
        body: input.response.body.toString("utf8"),
        isComplete: true,
        metadata: { httpStatus: input.response.status },
      });
    }
    await repository.completeAttempt({
      attemptId: input.attempt.attemptId,
      status: "error",
      actualModel: usage?.actualModel ?? input.attempt.profile.modelId,
      providerRequestId: input.response?.headers["x-request-id"]
        ?? input.response?.headers["request-id"],
      errorCategory: "provider_error",
      httpStatus: input.response?.status,
      inputTokens: usage?.inputTokens,
      cachedInputTokens: usage?.cachedInputTokens,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.reasoningTokens,
      usageSource: usage?.usageSource,
      actualCostUsd: "0.0000000000",
      latencyMs: input.latencyMs,
      metadata: { error: input.error instanceof Error ? input.error.message : undefined },
    });
    await repository.insertEvent({
      eventId: alphaId("evt"),
      sessionId: input.state.sessionId,
      taskId: input.state.taskId,
      segmentId: input.state.segmentId,
      logicalRequestId: input.logicalRequestId,
      eventType: "provider_error",
      eventHash: sha256(`provider-error\n${input.logicalRequestId}\n${input.attempt.attemptIndex}`),
      evidenceStrength: "high",
      sourceProtocol: input.protocol,
      sourceClient: "acu",
      metadata: {
        attemptIndex: input.attempt.attemptIndex,
        provider: input.attempt.profile.provider,
        channel: input.attempt.profile.channel,
        httpStatus: input.response?.status,
      },
    });
  }

  private async startProviderAttempt(input: {
    identity: TrustedNewApiIdentity;
    state: PreparedState;
    logicalRequestId: string;
    envelope: CanonicalEnvelope;
    requestedModel: string;
    profile: AlphaExecutionProfile;
    attemptIndex: number;
    retryOwner: "acu" | "client";
    body: Buffer;
    routeDecisionId?: string;
    judgeEvaluationId?: string;
  }): Promise<ProviderAttemptHandle> {
    const adapter = this.options.adapters.get(input.profile.executionProfileId);
    if (!adapter) throw new Error(`No Provider adapter for ${input.profile.executionProfileId}`);
    const repository = new AlphaRepository(this.options.database);
    const attemptId = alphaId("att");
    const catalogModel = getAcuModel(input.profile.modelId);
    await repository.createAttempt({
      attemptId,
      logicalRequestId: input.logicalRequestId,
      attemptIndex: input.attemptIndex,
      attemptKind: "provider",
      retryOwner: input.retryOwner,
      routeDecisionId: input.routeDecisionId,
      judgeEvaluationId: input.judgeEvaluationId,
      provider: input.profile.provider,
      channel: input.profile.channel,
      executionProfileId: input.profile.executionProfileId,
      requestedModel: input.requestedModel,
      actualModel: input.profile.modelId,
      status: "started",
      inputPricePerMillion: catalogModel?.inputPricePerMillion?.toString(),
      outputPricePerMillion: catalogModel?.outputPricePerMillion?.toString(),
    });
    await repository.savePayload({
      payloadId: alphaId("payload"),
      newapiUserId: input.identity.newapiUserId,
      logicalRequestId: input.logicalRequestId,
      attemptId,
      payloadKind: "provider_request",
      protocol: input.envelope.protocol,
      contentType: "application/json",
      body: JSON.parse(input.body.toString("utf8")) as unknown,
      isComplete: true,
      metadata: { requestedModel: input.requestedModel, actualModel: input.profile.modelId },
    });
    if (input.attemptIndex > 1) {
      await repository.insertEvent({
        eventId: alphaId("evt"),
        sessionId: input.state.sessionId,
        taskId: input.state.taskId,
        segmentId: input.state.segmentId,
        logicalRequestId: input.logicalRequestId,
        eventType: "retry_attempt",
        eventHash: sha256(`retry-attempt\n${input.logicalRequestId}\n${input.attemptIndex}`),
        evidenceStrength: "high",
        sourceProtocol: input.envelope.protocol,
        sourceClient: "acu",
        metadata: {
          attemptIndex: input.attemptIndex,
          retryOwner: input.retryOwner,
          provider: input.profile.provider,
          channel: input.profile.channel,
        },
      });
    }
    return { attemptId, attemptIndex: input.attemptIndex, adapter, profile: input.profile };
  }

  async resolveExecution(
    envelope: CanonicalEnvelope,
    identity: TrustedNewApiIdentity,
    ingress: AlphaIngressContext,
  ): Promise<AlphaExecutionResolution> {
    const mode = modeForModel(envelope.requestedModel);
    const state = await this.prepareState(envelope, identity, ingress, mode);
    const result = await this.judgeAndRoute(envelope, identity, state, ingress.rawBody.byteLength);
    const repository = new AlphaRepository(this.options.database);
    const executionSegment = await repository.getSegment(state.segmentId, identity.newapiUserId);
    const routeDecisionId = stringValue(executionSegment?.route_decision_id);
    const judgeEvaluationId = stringValue(executionSegment?.judge_evaluation_id);
    const storedRoute = routeDecisionId
      ? await repository.getRouteDecision(routeDecisionId, identity.newapiUserId)
      : undefined;
    const ingressIdempotencyKey = sha256([
      identity.newapiUserId,
      state.sessionId,
      envelope.protocol,
      envelope.historyHash,
      envelope.requestedModel,
    ].join("\n"));
    const requestedLogicalRequestId = alphaId("req");
    const logical = await repository.createLogicalRequest({
      logicalRequestId: requestedLogicalRequestId,
      newapiUserId: identity.newapiUserId,
      newapiTokenId: identity.newapiTokenId,
      newapiLogId: identity.newapiLogId,
      sessionId: state.sessionId,
      taskId: state.taskId,
      segmentId: state.segmentId,
      ingressIdempotencyKey,
      requestProtocol: envelope.protocol,
      requestedModel: envelope.requestedModel,
      selectedProfileId: result.profile.executionProfileId,
      streaming: envelope.stream,
      hadTools: envelope.tools.length > 0,
      metadata: { requestId: identity.requestId },
    });
    const logicalRow = await repository.getLogicalRequest(logical.logicalRequestId, identity.newapiUserId);
    if (!logical.inserted && logicalRow?.status === "completed" && stringValue(logicalRow.response_payload_id)) {
      const payload = await repository.getPayload(String(logicalRow.response_payload_id), identity.newapiUserId);
      if (payload) {
        return {
          adapter: staticResponseAdapter(payload),
          requestedModel: envelope.requestedModel,
          actualModel: result.profile.modelId,
          provider: result.profile.provider,
          channel: result.profile.channel,
          context: {
            logicalRequestId: logical.logicalRequestId,
            sessionId: state.sessionId,
            taskId: state.taskId,
            segmentId: state.segmentId,
            newapiUserId: identity.newapiUserId,
            newapiTokenId: identity.newapiTokenId,
            newapiLogId: identity.newapiLogId,
            protocol: envelope.protocol,
            selectedProfile: result.profile,
            judgeCostUsd: result.judge?.costUsd ?? "0.0000000000",
            requestBytes: ingress.rawBody.byteLength,
            replayed: true,
            routeSummary: routeDisplaySummary(
              envelope.requestedModel,
              result.profile.modelId,
              result.judge,
              result.route,
              storedRoute,
            ),
          } satisfies AlphaResolutionContext,
        };
      }
    }
    const attemptIndex = await repository.nextProviderAttemptIndex(logical.logicalRequestId);
    if (attemptIndex > 2) throw new Error("Provider Attempt budget exhausted for logical request");
    let requestPayloadId: string | undefined;
    if (logical.inserted) {
      requestPayloadId = alphaId("payload");
      await repository.savePayload({
        payloadId: requestPayloadId,
        newapiUserId: identity.newapiUserId,
        logicalRequestId: logical.logicalRequestId,
        payloadKind: "client_request",
        protocol: envelope.protocol,
        contentType: "application/json",
        headers: ingress.headers,
        body: envelope.raw,
        isComplete: true,
      });
      await repository.attachRequestPayload(logical.logicalRequestId, identity.newapiUserId, requestPayloadId);
    }
    const providerBody = mode === "explicit" ? Buffer.from(ingress.rawBody) : rewriteModel(ingress.rawBody, result.profile.modelId);
    const initialAttempt = await this.startProviderAttempt({
      identity,
      state,
      logicalRequestId: logical.logicalRequestId,
      envelope,
      requestedModel: envelope.requestedModel,
      profile: result.profile,
      attemptIndex,
      retryOwner: logical.inserted ? "acu" : "client",
      body: providerBody,
      routeDecisionId,
      judgeEvaluationId,
    });
    const resolutionContext: AlphaResolutionContext = {
      logicalRequestId: logical.logicalRequestId,
      attemptId: initialAttempt.attemptId,
      attemptIndex,
      requestPayloadId,
      sessionId: state.sessionId,
      taskId: state.taskId,
      segmentId: state.segmentId,
      newapiUserId: identity.newapiUserId,
      newapiTokenId: identity.newapiTokenId,
      newapiLogId: identity.newapiLogId,
      protocol: envelope.protocol,
      selectedProfile: result.profile,
      judgeCostUsd: result.judge?.costUsd ?? "0.0000000000",
      requestBytes: ingress.rawBody.byteLength,
      replayed: false,
      routeSummary: routeDisplaySummary(
        envelope.requestedModel,
        result.profile.modelId,
        result.judge,
        result.route,
        storedRoute,
      ),
    };
    const adapter = createRecoveringProviderAdapter({
      initial: initialAttempt,
      maxAttempts: 2,
      selectRecoveryProfile: (profile) => this.recoveryProfile(
        profile,
        envelope,
        mode,
        ingress.rawBody.byteLength,
      ),
      recordFailedAttempt: async ({ attempt, response, error, latencyMs }) => {
        await this.recordProviderFailure({
          identity,
          state,
          logicalRequestId: logical.logicalRequestId,
          attempt,
          protocol: envelope.protocol,
          requestBytes: ingress.rawBody.byteLength,
          response,
          error,
          latencyMs,
        });
      },
      startRetry: async (profile, nextAttemptIndex) => {
        const next = await this.startProviderAttempt({
          identity,
          state,
          logicalRequestId: logical.logicalRequestId,
          envelope,
          requestedModel: envelope.requestedModel,
          profile,
          attemptIndex: nextAttemptIndex,
          retryOwner: "acu",
          body: providerBody,
          routeDecisionId,
          judgeEvaluationId,
        });
        resolutionContext.attemptId = next.attemptId;
        resolutionContext.attemptIndex = next.attemptIndex;
        resolutionContext.selectedProfile = next.profile;
        return next;
      },
      onSelected(attempt) {
        resolutionContext.attemptId = attempt.attemptId;
        resolutionContext.attemptIndex = attempt.attemptIndex;
        resolutionContext.selectedProfile = attempt.profile;
      },
    });
    return {
      adapter,
      requestedModel: envelope.requestedModel,
      actualModel: result.profile.modelId,
      provider: result.profile.provider,
      channel: result.profile.channel,
      body: providerBody,
      context: resolutionContext,
    };
  }

  private async createFinalUsageReport(input: {
    context: AlphaResolutionContext;
    actualModel: string;
    inputTokens?: bigint;
    cachedInputTokens?: bigint;
    outputTokens?: bigint;
    reasoningTokens?: bigint;
    providerCostUsd?: string;
    usageSource: string;
  }): Promise<void> {
    const providerCostUsd = input.providerCostUsd ?? "0.0000000000";
    const finalCost = sumCost(input.context.judgeCostUsd, providerCostUsd);
    await new AlphaRepository(this.options.database).createUsageReport({
      usageReportId: alphaId("usage"),
      logicalRequestId: input.context.logicalRequestId,
      reportIdempotencyKey: sha256(`${input.context.logicalRequestId}\nusage-final-v1`),
      newapiUserId: input.context.newapiUserId,
      newapiTokenId: input.context.newapiTokenId,
      newapiLogId: input.context.newapiLogId,
      actualModel: input.actualModel,
      provider: input.context.selectedProfile.provider,
      channel: input.context.selectedProfile.channel,
      inputTokens: input.inputTokens,
      cachedInputTokens: input.cachedInputTokens,
      outputTokens: input.outputTokens,
      reasoningTokens: input.reasoningTokens,
      judgeCostUsd: input.context.judgeCostUsd,
      providerCostUsd,
      failedBilledCostUsd: "0.0000000000",
      finalUserCostUsd: finalCost,
      costBreakdown: {
        judge: input.context.judgeCostUsd,
        provider: providerCostUsd,
        usageSource: input.usageSource,
        mode: input.context.routeSummary.mode,
        difficulty: input.context.routeSummary.difficulty,
        candidate_count: input.context.routeSummary.candidateCount,
        selected_model: input.context.routeSummary.selectedModel,
        route_reason: input.context.routeSummary.routeReason,
        quality_upper_bound_model: input.context.routeSummary.qualityUpperBoundModel,
        estimated_cost_reduction_vs_quality_upper_bound_usd:
          input.context.routeSummary.estimatedCostReductionVsQualityUpperBoundUsd,
      },
    });
  }

  async handleTrace(trace: AlphaGatewayTrace): Promise<void> {
    if (trace.status === "started") return;
    const context = trace.resolution.context as AlphaResolutionContext | undefined;
    if (!context || context.replayed || !context.attemptId) return;
    const repository = new AlphaRepository(this.options.database);
    const relay = trace.response;
    if (!relay) {
      await repository.completeAttempt({
        attemptId: context.attemptId,
        status: trace.status,
        errorCategory: trace.status === "cancelled" ? "client_cancelled" : "provider_error",
      });
      await repository.completeLogicalRequest({
        logicalRequestId: context.logicalRequestId,
        newapiUserId: context.newapiUserId,
        status: trace.status,
        errorCategory: trace.status === "cancelled" ? "client_cancelled" : "provider_error",
      });
      await this.createFinalUsageReport({
        context,
        actualModel: context.selectedProfile.modelId,
        usageSource: "unavailable",
      });
      return;
    }
    const contentType = relay.responseHeaders["content-type"] ?? "application/octet-stream";
    const usage = parseProviderUsage({
      protocol: context.protocol,
      body: relay.body,
      contentType,
      requestedModel: context.selectedProfile.modelId,
      requestBytes: context.requestBytes,
    });
    const success = relay.httpStatus >= 200 && relay.httpStatus < 300 && relay.complete;
    const status = relay.clientCancelled ? "cancelled" : success ? "success" : "error";
    const providerPayloadId = alphaId("payload");
    await repository.savePayload({
      payloadId: providerPayloadId,
      newapiUserId: context.newapiUserId,
      logicalRequestId: context.logicalRequestId,
      attemptId: context.attemptId,
      payloadKind: contentType.includes("text/event-stream") ? "provider_stream" : "provider_response",
      protocol: context.protocol,
      contentType,
      headers: relay.responseHeaders,
      body: relay.body.toString("utf8"),
      isComplete: relay.complete,
      metadata: { httpStatus: relay.httpStatus, responseHeaders: relay.responseHeaders },
    });
    const responsePayloadId = alphaId("payload");
    await repository.savePayload({
      payloadId: responsePayloadId,
      newapiUserId: context.newapiUserId,
      logicalRequestId: context.logicalRequestId,
      attemptId: context.attemptId,
      payloadKind: contentType.includes("text/event-stream") ? "client_stream" : "client_response",
      protocol: context.protocol,
      contentType,
      headers: relay.responseHeaders,
      body: relay.body.toString("utf8"),
      isComplete: relay.complete,
      metadata: { httpStatus: relay.httpStatus },
    });
    const providerRequestId = relay.responseHeaders["x-request-id"]
      ?? relay.responseHeaders["request-id"]
      ?? relay.responseHeaders["x-oneapi-request-id"];
    await repository.completeAttempt({
      attemptId: context.attemptId,
      status,
      actualModel: usage.actualModel ?? context.selectedProfile.modelId,
      providerRequestId,
      errorCategory: success ? undefined : relay.clientCancelled ? "client_cancelled" : "provider_error",
      httpStatus: relay.httpStatus,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      usageSource: usage.usageSource,
      actualCostUsd: success ? usage.providerCostUsd : "0.0000000000",
      providerBilled: success ? true : undefined,
      visibleOutputBytes: relay.visibleOutputBytes,
      metadata: { complete: relay.complete, clientCancelled: relay.clientCancelled },
    });
    await repository.completeLogicalRequest({
      logicalRequestId: context.logicalRequestId,
      newapiUserId: context.newapiUserId,
      status: success ? "completed" : status,
      acceptedAttemptId: success ? context.attemptId : undefined,
      responsePayloadId,
      errorCategory: success ? undefined : relay.clientCancelled ? "client_cancelled" : "provider_error",
    });
    if (success) await repository.incrementAcceptedResponses(context.segmentId, context.newapiUserId);
    if (success || (context.attemptIndex ?? 1) >= 2 || relay.clientCancelled) {
      await this.createFinalUsageReport({
        context,
        actualModel: usage.actualModel ?? context.selectedProfile.modelId,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        providerCostUsd: success ? usage.providerCostUsd : "0.0000000000",
        usageSource: usage.usageSource,
      });
    }
  }
}
