import type { IncomingHttpHeaders } from "node:http";
import { canonicalHash, record } from "./protocol/common.js";
import type { CanonicalEnvelope, WebIntentDecision } from "./protocol/types.js";
import { AlphaDatabase } from "./database.js";
import { applyFailureEvidence, decideTrigger, type AlphaMode, type SegmentState, type TriggerDecision } from "./state-machine.js";
import { extractIncrementalEvents, type AlphaDomainEvent } from "./events.js";
import { matchSession, type SessionContinuityRecord } from "./identity.js";
import { buildAlphaJudgeContext } from "./judge-context.js";
import type { AlphaJudgeRun, AlphaJudgeRunner } from "./judge-runner.js";
import { AlphaRepository, alphaId, sha256, type AlphaProtocol } from "./repository.js";
import {
  AlphaAdmissionError,
  exclusionCategory,
  resolveExplicitProfile,
  routeWithCurrentAcuFormula,
  type AlphaExecutionProfile,
  type AlphaRouteDecision,
} from "./routing.js";
import type { AlphaGatewayTrace, AlphaIngressContext, AlphaExecutionResolution } from "./gateway.js";
import type { NativeProviderAdapter } from "./provider.js";
import type { TrustedNewApiIdentity } from "./trusted-identity.js";
import { parseProviderUsage } from "./usage.js";
import { buildModelCurve, getAcuModel } from "../acu/catalog.js";
import { ACU_ROUTING_MODEL_VERSION } from "../acu/config.js";
import { AcuJudgeClientCancelledError, AcuJudgeContextLengthError } from "../acu/judge.js";
import { cashCnyPerNominalUsd, providerCostBreakdown, type ProviderEconomics } from "./provider-economics.js";
import {
  computeFirstModelEventDeadlineMs,
  createRecoveringProviderAdapter,
  type BufferedProviderFailure,
  type ProviderAttemptHandle,
  type ProviderRecoveryTarget,
} from "./execution.js";
import { applyAttemptOutcome, classifyAttemptOutcome, type AttemptOutcome, type HealthSnapshot } from "./channel-health.js";
import { estimateContextAdmission, effectiveContextCeiling } from "./context-admission.js";
import {
  classifyWebIntentFallback,
  isWebIntent,
  isWebIntentSource,
  withWebIntentSource,
} from "./web-intent.js";

const POLICY_VERSION = "alpha-p0-policy-v1";
const QUALITY_CURVE_VERSION = "acu-catalog-v0.1";
const PRICE_VERSION = "acu-catalog-v0.1";

type JsonObject = Record<string, unknown>;

export type AlphaProcessorOptions = {
  database: AlphaDatabase;
  profiles: AlphaExecutionProfile[];
  adapters: Map<string, NativeProviderAdapter>;
  networkAdapters?: Map<string, Array<{ endpoint: string; adapter: NativeProviderAdapter }>>;
  judgeRunner: AlphaJudgeRunner;
  judgeEconomics?: ProviderEconomics;
  expectedOutputTokens?: number;
  wakeProbe?: (executionProfileId?: string) => void;
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
  requestedModel: string;
  reasoningEffort?: string;
  selectedProfile: AlphaExecutionProfile;
  networkEndpoint?: string;
  judgeCostUsd: string;
  judgeCashCostCny: string;
  judgeInputTokens: number;
  judgeOutputTokens: number;
  judgeOfficialPaygEquivalentCost: string;
  judgeCostCurrency: string;
  judgeCostStatus: string;
  judgeCostSource: string;
  judgeProvider?: string;
  judgeModel?: string;
  judgeLatencyMs?: number;
  requestBytes: number;
  replayed: boolean;
  clientDeclaredWebTool: boolean;
  webIntent: CanonicalEnvelope["webIntent"];
  webIntentConfidence: number;
  webIntentReason: string;
  webIntentEvidence: string[];
  webIntentSource: NonNullable<CanonicalEnvelope["webIntentSource"]>;
  webActuallyInvoked: boolean;
  webSearchEventStatus: string[];
  webToolPruned: boolean;
  webToolPruneReason?: string;
  webFallbackChain: string[];
  attemptedExecutionProfileIds: string[];
  attemptedChannelIds: string[];
  attemptedProviders: string[];
  attemptedNetworkEndpoints: string[];
  routeSummary: {
    mode: string;
    routingPreference: string;
    difficulty?: number;
    candidateCount: number;
    selectedModel: string;
    routeReason: string;
    qualityUpperBoundModel?: string;
    estimatedCostReductionVsQualityUpperBoundCny?: number;
    counterfactualQualityCeilingCostCny?: number;
    providerSelectionReason?: string;
    selectedProvider?: string;
  };
  phase?: string;
  judgeExplanation?: string;
  judgeTrigger?: string;
  judgeCalls: number;
  judgeReused: boolean;
  reusedJudgeEvaluationId?: string;
  routeRefreshReason?: string;
  routeDecisionSnapshot?: JsonObject;
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

function optionalNumber(value: unknown): number | undefined {
  const valueAsNumber = Number(value);
  return value === null || value === undefined || !Number.isFinite(valueAsNumber) ? undefined : valueAsNumber;
}

function webIntentFromMetadata(value: JsonObject): WebIntentDecision | undefined {
  if (!isWebIntent(value.webIntent) || !isWebIntentSource(value.webIntentSource)) return undefined;
  const confidence = Number(value.webIntentConfidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return undefined;
  if (typeof value.webIntentReason !== "string" || !Array.isArray(value.webIntentEvidence)
    || value.webIntentEvidence.some((item) => typeof item !== "string")) return undefined;
  return {
    intent: value.webIntent,
    confidence,
    reason: value.webIntentReason,
    evidence: value.webIntentEvidence as string[],
    source: value.webIntentSource,
  };
}

function applyWebIntent(envelope: CanonicalEnvelope, decision: WebIntentDecision): void {
  envelope.webIntent = decision.intent;
  envelope.webIntentConfidence = decision.confidence;
  envelope.webIntentReason = decision.reason;
  envelope.webIntentEvidence = decision.evidence;
  envelope.webIntentSource = decision.source;
}

function webIntentMetadata(decision: WebIntentDecision): JsonObject {
  return {
    webIntent: decision.intent,
    webIntentConfidence: decision.confidence,
    webIntentReason: decision.reason,
    webIntentEvidence: decision.evidence,
    webIntentSource: decision.source,
  };
}

function canonicalActualModel(profile: AlphaExecutionProfile, actualModel: string | undefined): string {
  if (!actualModel) return profile.modelId;
  const accepted = new Set([profile.modelId, profile.providerModelId ?? profile.modelId, ...(profile.actualModelAliases ?? [])]);
  return accepted.has(actualModel) ? profile.modelId : actualModel;
}

function routeDisplaySummary(
  requestedModel: string,
  selectedModel: string,
  routingPreference: string,
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
      routingPreference: stringValue(formulaInputs?.routingPreference) ?? routingPreference,
      difficulty: Number.isFinite(difficulty) ? difficulty : undefined,
      candidateCount: candidates.length,
      selectedModel,
      routeReason: (stringValue(storedRoute.route_explanation) ?? "Reused the segment's saved route decision.").slice(0, 240),
      qualityUpperBoundModel: stringValue(qualityUpperBound?.modelId),
      estimatedCostReductionVsQualityUpperBoundCny: selected && qualityUpperBound
        ? Math.max(0, numberValue(qualityUpperBound.expectedTotalCost) - numberValue(selected.expectedTotalCost))
        : undefined,
      counterfactualQualityCeilingCostCny: qualityUpperBound
        ? numberValue(qualityUpperBound.expectedTotalCost)
        : undefined,
      selectedProvider: stringValue(record(storedRoute.selected_profile_json)?.provider),
    };
  }
  if (!route) {
    return {
      mode: "explicit",
      routingPreference,
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
    routingPreference: route.preference,
    difficulty: judge?.judge.difficultyIndex,
    candidateCount: route.candidateEstimates.length,
    selectedModel,
    routeReason: route.recommendation.reason.slice(0, 240),
    qualityUpperBoundModel: qualityUpperBound?.modelId,
    estimatedCostReductionVsQualityUpperBoundCny: selected && qualityUpperBound
      ? Math.max(0, qualityUpperBound.expectedTotalCost - selected.expectedTotalCost)
      : undefined,
    counterfactualQualityCeilingCostCny: qualityUpperBound?.expectedTotalCost,
    providerSelectionReason: route.providerSelectionReason,
    selectedProvider: route.selectedProfile.provider,
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

function isHostedWebTool(value: unknown): boolean {
  const type = String(record(value)?.type ?? "").toLowerCase();
  return type === "web_search" || type.startsWith("web_search_");
}

function bodyDeclaresHostedWebTool(body: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as JsonObject;
    return Array.isArray(parsed.tools) && parsed.tools.some(isHostedWebTool);
  } catch {
    return false;
  }
}

function isWebSearchProviderError(response: { status: number }, webIntent: CanonicalEnvelope["webIntent"]): boolean {
  return webIntent !== "not_required" && [400, 409, 422].includes(response.status);
}

export function prepareProviderBody(
  rawBody: Uint8Array,
  model: string,
  envelope: CanonicalEnvelope,
  profile: AlphaExecutionProfile,
): { body: Buffer; webToolPruned: boolean; pruneReason?: string } {
  void envelope;
  void profile;
  const parsed = JSON.parse(Buffer.from(rawBody).toString("utf8")) as JsonObject;
  const providerModel = typeof parsed.model === "string" ? parsed.model : "";
  if (providerModel === model) {
    return { body: Buffer.from(rawBody), webToolPruned: false };
  }
  return {
    body: Buffer.from(JSON.stringify({ ...parsed, model })),
    webToolPruned: false,
  };
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
  private readonly expectedOutputTokens: number;

  constructor(private readonly options: AlphaProcessorOptions) {
    this.expectedOutputTokens = options.expectedOutputTokens ?? 800;
  }

  private async effectiveProfiles(allowedProfileIds: string[] = [], wakeProbe = true): Promise<{ profiles: AlphaExecutionProfile[]; probeClaims: Array<{ scope: "channel" | "profile"; id: string }> }> {
    const repository = new AlphaRepository(this.options.database);
    const channelIds = this.options.profiles.map((profile) => profile.channelId ?? profile.channel);
    const executionProfileIds = this.options.profiles.map((profile) => profile.executionProfileId);
    const [channelHealth, profileHealth] = await Promise.all([
      repository.batchChannelHealth(channelIds),
      repository.batchProfileHealth(executionProfileIds),
    ]);
    let probeCandidateId: string | undefined;
    const allowed = allowedProfileIds.length > 0 ? new Set(allowedProfileIds) : undefined;
    const profiles = this.options.profiles.map((profile): AlphaExecutionProfile => {
      const channelId = profile.channelId ?? profile.channel;
      const channel = channelHealth.get(channelId);
      const runtime = profileHealth.get(profile.executionProfileId);
      const lastSuccessAt = runtime?.lastSuccessAt ?? channel?.lastSuccessAt;
      const fresh = Boolean(lastSuccessAt && Date.now() - lastSuccessAt.getTime() <= 120 * 60_000);
      const staleFreshnessRequired = profile.requiresFreshProbe === true && !fresh;
      if ((!allowed || allowed.has(profile.executionProfileId)) && !probeCandidateId
        && (staleFreshnessRequired || channel?.state === "open" || channel?.state === "half_open"
        || runtime?.state === "open" || runtime?.state === "half_open")) probeCandidateId = profile.executionProfileId;
      const unavailable = channel?.state === "disabled" || runtime?.state === "disabled"
        || channel?.state === "open" || channel?.state === "half_open"
        || runtime?.state === "open" || runtime?.state === "half_open"
        || staleFreshnessRequired;
      const degraded = [channel?.state, runtime?.state].some((state) => state === "degraded");
      return {
        ...profile,
        health: unavailable ? "cooldown" as const : degraded ? "degraded" as const : profile.health,
        usageTrusted: runtime?.usageTrusted ?? profile.usageTrusted,
        recentSuccessRate: Math.min(channel?.recentSuccessRate ?? 1, runtime?.recentSuccessRate ?? 1),
        observedLatencyMs: runtime?.totalLatencyMs ?? channel?.totalLatencyMs ?? profile.observedLatencyMs,
        observedSuccessfulInputTokens: Math.max(
          runtime?.observedSuccessfulInputTokens ?? 0,
          profile.observedSuccessfulInputTokens ?? 0,
        ),
        webSearchRecentSuccessRate: optionalNumber(runtime?.metadata?.webSearchRecentSuccessRate)
          ?? profile.webSearchRecentSuccessRate,
        webSearchObservedLatencyMs: optionalNumber(runtime?.metadata?.webSearchObservedLatencyMs)
          ?? profile.webSearchObservedLatencyMs,
        webSearchLastVerifiedAt: stringValue(runtime?.metadata?.webSearchLastVerifiedAt)
          || profile.webSearchLastVerifiedAt,
        webSearchFailureReason: stringValue(runtime?.metadata?.webSearchFailureReason)
          || profile.webSearchFailureReason,
      };
    });
    if (wakeProbe && probeCandidateId) this.options.wakeProbe?.(probeCandidateId);
    return { profiles, probeClaims: [] };
  }

  async selectionCorridor(inputTokens: number, expectedOutputTokens: number): Promise<Record<string, unknown>> {
    const { profiles } = await this.effectiveProfiles([], false);
    const preferences = ["economy", "balanced", "quality"] as const;
    const factors = {
      reasoningDepth: 0,
      taskScope: 0,
      constraintDensity: 0,
      toolDependency: 0,
      verificationBurden: 0,
      contextBurden: 0,
    };
    const series = Object.fromEntries(preferences.map((preference) => {
      const points = Array.from({ length: 51 }, (_, index) => index * 2).flatMap((difficulty) => {
        try {
          const route = routeWithCurrentAcuFormula({
            judge: {
              pLow: 0.25,
              pMid: 0.25,
              pMidHigh: 0.25,
              pHigh: 0.25,
              confidence: 1,
              difficultyScoreRaw: difficulty,
              factors,
              factorComposite: difficulty,
              difficultyIndex: difficulty,
              difficultyMethodVersion: "acu-difficulty-index-v1",
              difficultyScore: difficulty,
              signals: [],
              explanation: "",
            },
            judgeCost: 0,
            inputTokens,
            expectedOutputTokens,
            effectiveQualityTarget: 80,
            routingPreference: preference,
            profiles,
            requirements: {
              protocol: "responses",
              requireTools: false,
              requireThinking: false,
              contextTokens: inputTokens + expectedOutputTokens,
              expectedOutputTokens,
              webIntent: "not_required",
            },
          });
          const candidates = [...route.candidateEstimates]
            .filter((candidate) => candidate.paretoEfficient)
            .sort((left, right) => right.valueUtility - left.valueUtility)
            .slice(0, 3);
          return [{
            difficulty,
            selectedModelId: route.recommendation.recommended.modelId,
            selectedQuality: route.recommendation.recommended.estimatedQuality * 100,
            selectedCostCny: route.recommendation.recommended.estimatedCallCost,
            qualityLower: Math.min(...candidates.map((candidate) => candidate.qualityLower * 100)),
            qualityUpper: Math.max(...candidates.map((candidate) => candidate.qualityUpper * 100)),
            candidates: candidates.map((candidate) => ({
              modelId: candidate.modelId,
              quality: candidate.estimatedQuality * 100,
              costCny: candidate.estimatedCallCost,
              valueUtility: candidate.valueUtility,
            })),
          }];
        } catch {
          return [];
        }
      });
      return [preference, points];
    }));
    return {
      formulaVersion: ACU_ROUTING_MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      inputTokens,
      expectedOutputTokens,
      assumptions: {
        protocol: "responses",
        tools: false,
        webIntent: "not_required",
        baseQualityTarget: 80,
        judgeCostIncluded: false,
        currentHealthApplied: true,
        candidateDefinition: "top_3_pareto_by_value_utility",
      },
      series,
    };
  }

  private async releaseUnusedProbeClaims(
    claims: Array<{ scope: "channel" | "profile"; id: string }>,
    selected: AlphaExecutionProfile,
  ): Promise<void> {
    const repository = new AlphaRepository(this.options.database);
    const selectedChannel = selected.channelId ?? selected.channel;
    await Promise.all(claims
      .filter((claim) => claim.scope === "channel" ? claim.id !== selectedChannel : claim.id !== selected.executionProfileId)
      .map((claim) => repository.releaseHalfOpenProbe(claim.scope, claim.id)));
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
        routingLeaseExpired: Boolean(segmentRow?.last_activity_at)
          && new Date(String(segmentRow!.last_activity_at)).getTime() <= Date.now() - 10 * 60 * 1_000,
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
        const previousSegmentRow = segmentRow;
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
        if (decision.reason === "plan_finished" && !decision.runJudge && previousSegmentRow
          && stringValue(previousSegmentRow.selected_execution_profile_id)) {
          await repository.updateSegmentDecision({
            segmentId,
            newapiUserId: identity.newapiUserId,
            judgeEvaluationId: stringValue(previousSegmentRow.judge_evaluation_id),
            routeDecisionId: stringValue(previousSegmentRow.route_decision_id),
            selectedExecutionProfileId: stringValue(previousSegmentRow.selected_execution_profile_id)!,
            metadata: {
              ...metadata(previousSegmentRow),
              ...nextMetadata,
              judgeReusedFromSegmentId: previousSegmentId,
              judgeReuseReason: "plan_finished_without_rejudge_evidence",
            },
          });
          segmentRow = await repository.getSegment(segmentId, identity.newapiUserId);
        }
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
    logicalRequestId: string,
    ingress: AlphaIngressContext,
  ): Promise<{
    profile: AlphaExecutionProfile;
    judge?: AlphaJudgeRun;
    route?: AlphaRouteDecision;
    recoveryProfiles: AlphaExecutionProfile[];
  }> {
    const repository = new AlphaRepository(this.options.database);
    const contextAdmission = estimateContextAdmission(envelope, this.expectedOutputTokens);
    const { profiles: effectiveProfiles, probeClaims } = await this.effectiveProfiles(identity.allowedProfileIds);
    const recoveryProfiles = identity.allowedProfileIds.length > 0
      ? effectiveProfiles.filter((profile) => identity.allowedProfileIds.includes(profile.executionProfileId))
      : effectiveProfiles;
    const storedSegment = await repository.getSegment(state.segmentId, identity.newapiUserId);
    const storedSegmentMetadata = metadata(storedSegment);
    const startAdmissionTrace = async (judgeEvaluationId?: string) => repository.saveAdmissionTrace({
      admissionTraceId: alphaId("admission"),
      admissionIdempotencyKey: sha256([
        identity.newapiUserId, state.segmentId, envelope.protocol, envelope.historyHash, envelope.requestedModel,
      ].join("\n")),
      newapiUserId: identity.newapiUserId,
      logicalRequestId,
      sessionId: state.sessionId,
      taskId: state.taskId,
      segmentId: state.segmentId,
      judgeEvaluationId,
      requestProtocol: envelope.protocol,
      requestedModel: envelope.requestedModel,
      ...contextAdmission,
      metadata: {
        trigger: state.decision.reason,
        judgeCalls: state.decision.runJudge ? 1 : 0,
        judgeReused: !state.decision.runJudge && Boolean(judgeEvaluationId),
      },
    });
    const storedWebIntent = state.decision.runJudge ? undefined : webIntentFromMetadata(storedSegmentMetadata);
    if (storedWebIntent) applyWebIntent(envelope, storedWebIntent);
    if (modeForModel(envelope.requestedModel) === "explicit") {
      const webIntentDecision = storedWebIntent ?? withWebIntentSource(classifyWebIntentFallback({
        recentUserInputs: envelope.humanCandidates
          .filter((candidate) => candidate.confidence === "high")
          .map((candidate) => candidate.text),
        rootGoalText: state.rootGoalText,
      }), state.decision.createSegment ? "heuristic_fallback" : "legacy_heuristic");
      applyWebIntent(envelope, webIntentDecision);
      const admission = await startAdmissionTrace();
      let profile: AlphaExecutionProfile;
      try {
        profile = resolveExplicitProfile(envelope.requestedModel, effectiveProfiles, {
        protocol: envelope.protocol,
        requireTools: envelope.requiredToolTypes.length > 0,
        requiredToolTypes: envelope.requiredToolTypes,
        requireThinking: envelope.containsThinking,
        reasoningEffort: envelope.reasoningEffort,
        context: contextAdmission,
        expectedOutputTokens: this.expectedOutputTokens,
        allowedProfileIds: identity.allowedProfileIds.length > 0 ? identity.allowedProfileIds : undefined,
        clientDeclaredWebTool: envelope.clientDeclaredWebTool,
        webIntent: envelope.webIntent,
        });
      } catch (error) {
        const typed = error instanceof AlphaAdmissionError ? error : undefined;
        await repository.completeAdmissionTrace({
          admissionTraceId: admission.admissionTraceId, status: "rejected",
          errorType: typed?.errorType ?? "admission_failed", httpStatus: typed?.statusCode ?? 502,
          maximumAvailableContextTokens: Number(typed?.details.maximum_available_context_tokens ?? 0) || undefined,
          candidateContextLimits: typed?.details.candidate_context_limits as Record<string, number> | undefined,
          exclusionCounts: typed?.details.exclusion_counts as Record<string, number> | undefined,
        });
        if (typed) typed.details.admission_trace_id = admission.admissionTraceId;
        throw error;
      }
      await repository.completeAdmissionTrace({
        admissionTraceId: admission.admissionTraceId, status: "admitted",
        maximumAvailableContextTokens: effectiveContextCeiling(profile),
        metadata: { selectedProfileId: profile.executionProfileId },
      });
      if (state.decision.createSegment || !state.segment.segmentId) {
        const catalogModel = getAcuModel(profile.modelId);
        const nominalCost = catalogModel?.inputPricePerMillion === null || catalogModel?.outputPricePerMillion === null
          ? null
          : ((contextAdmission.estimatedInputTokens * (catalogModel?.inputPricePerMillion ?? 0))
            + (this.expectedOutputTokens * (catalogModel?.outputPricePerMillion ?? 0))) / 1_000_000;
        const effectiveCashCost = nominalCost === null
          ? null
          : nominalCost * (profile.economics ? cashCnyPerNominalUsd(profile.economics) : 1);
        const explicitSelectionReason = "User-selected explicit model; Judge and ACU model selection skipped.";
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
            reasoningEffort: envelope.reasoningEffort,
            requiredToolTypes: envelope.requiredToolTypes,
            ...webIntentMetadata(webIntentDecision),
            userRoutingPolicy: identity.routingPolicy,
            routingPreference: identity.routingPreference,
            userRoutingPolicyVersion: identity.routingPolicyVersion,
            decisionSnapshot: {
              difficultyIndex: null,
              difficultyFactors: null,
              judgeConfidence: null,
              qualityTarget: 0,
              routingPreference: identity.routingPreference,
              webIntent: webIntentDecision.intent,
              candidateCount: 1,
              legalCanonicalModelCandidates: [profile.modelId],
              candidates: [{
                modelId: profile.modelId,
                estimatedQuality: null,
                nominalCost,
                effectiveCashCost,
                valueScore: null,
                pareto: null,
                exclusionReason: null,
              }],
              excludedProfiles: [],
              selectedModel: profile.modelId,
              selectedChannel: profile.channelId ?? profile.channel,
              modelSelectionReason: explicitSelectionReason,
              channelSelectionReason: explicitSelectionReason,
              qualityCeilingModel: profile.modelId,
              costReductionVsCeiling: 0,
            },
          },
          candidateEstimates: [],
          paretoFrontier: [],
          selectedProfile: { ...profile },
          routeExplanation: explicitSelectionReason,
        });
        await repository.updateSegmentDecision({
          segmentId: state.segmentId,
          newapiUserId: identity.newapiUserId,
          routeDecisionId,
          selectedExecutionProfileId: profile.executionProfileId,
          metadata: {
            ...state.stateMetadata,
            ...webIntentMetadata(webIntentDecision),
            selectedProfile: profile,
            userRoutingPolicyVersion: identity.routingPolicyVersion,
            allowedProfileIds: identity.allowedProfileIds,
          },
        });
      } else if (!storedWebIntent) {
        await repository.updateSegmentMetadata(state.segmentId, identity.newapiUserId, {
          ...storedSegmentMetadata,
          ...webIntentMetadata(webIntentDecision),
        });
      }
      await this.releaseUnusedProbeClaims(probeClaims, profile);
      return { profile, recoveryProfiles };
    }

    const originalStoredProfile = selectedProfileFromSegment(storedSegment, this.options.profiles);
    const storedProfile = selectedProfileFromSegment(storedSegment, effectiveProfiles);
    const previousJudge = record(storedSegmentMetadata.judgeRun) as AlphaJudgeRun | undefined;
    const policyVersionMatches = metadata(storedSegment).userRoutingPolicyVersion === identity.routingPolicyVersion;
    const storedAllowedProfileIds = Array.isArray(storedSegmentMetadata.allowedProfileIds)
      ? storedSegmentMetadata.allowedProfileIds.filter((value): value is string => typeof value === "string").sort()
      : [];
    const profilePolicyChanged = JSON.stringify(storedAllowedProfileIds)
      !== JSON.stringify([...identity.allowedProfileIds].sort());
    const reused = storedProfile
      && policyVersionMatches
      && identity.routingPolicy !== "explicit_only"
      && (identity.routingPolicy !== "custom_allowlist" || identity.allowedModelIds.includes(storedProfile.modelId))
      && (identity.allowedProfileIds.length === 0 || identity.allowedProfileIds.includes(storedProfile.executionProfileId))
      ? storedProfile
      : undefined;
    if (!state.decision.runJudge && reused && reused.health !== "cooldown") {
      const admission = await startAdmissionTrace(stringValue(storedSegment?.judge_evaluation_id));
      let compatible: AlphaExecutionProfile;
      try {
        compatible = resolveExplicitProfile(reused.modelId, effectiveProfiles, {
        protocol: envelope.protocol,
        requireTools: envelope.requiredToolTypes.length > 0,
        requiredToolTypes: envelope.requiredToolTypes,
        requireThinking: envelope.containsThinking,
        reasoningEffort: envelope.reasoningEffort,
        context: contextAdmission,
        expectedOutputTokens: this.expectedOutputTokens,
        allowedModelIds: identity.routingPolicy === "custom_allowlist" ? identity.allowedModelIds : undefined,
        allowedProfileIds: identity.allowedProfileIds.length > 0 ? identity.allowedProfileIds : undefined,
        clientDeclaredWebTool: envelope.clientDeclaredWebTool,
        webIntent: envelope.webIntent,
        });
      } catch (error) {
        const typed = error instanceof AlphaAdmissionError ? error : undefined;
        await repository.completeAdmissionTrace({
          admissionTraceId: admission.admissionTraceId, status: "rejected",
          errorType: typed?.errorType ?? "admission_failed", httpStatus: typed?.statusCode ?? 502,
          maximumAvailableContextTokens: Number(typed?.details.maximum_available_context_tokens ?? 0) || undefined,
          candidateContextLimits: typed?.details.candidate_context_limits as Record<string, number> | undefined,
          exclusionCounts: typed?.details.exclusion_counts as Record<string, number> | undefined,
        });
        if (typed) typed.details.admission_trace_id = admission.admissionTraceId;
        throw error;
      }
      await repository.completeAdmissionTrace({
        admissionTraceId: admission.admissionTraceId, status: "admitted",
        maximumAvailableContextTokens: effectiveContextCeiling(compatible),
        metadata: { selectedProfileId: compatible.executionProfileId, judgeReused: true },
      });
      if (!storedWebIntent) {
        const legacyWebIntent = withWebIntentSource(classifyWebIntentFallback({
          recentUserInputs: envelope.humanCandidates
            .filter((candidate) => candidate.confidence === "high")
            .map((candidate) => candidate.text),
          rootGoalText: state.rootGoalText,
        }), "legacy_heuristic");
        applyWebIntent(envelope, legacyWebIntent);
        await repository.updateSegmentMetadata(state.segmentId, identity.newapiUserId, {
          ...storedSegmentMetadata,
          ...webIntentMetadata(legacyWebIntent),
        });
      }
      await this.releaseUnusedProbeClaims(probeClaims, compatible);
      return { profile: compatible, recoveryProfiles };
    }

    const reusedJudgeEvaluationId = stringValue(storedSegment?.judge_evaluation_id);
    const routeRefreshReason = profilePolicyChanged ? "profile_policy_changed" : "profile_health";
    const profileHealthRefresh = !state.decision.runJudge
      && Boolean(reusedJudgeEvaluationId)
      && Boolean(previousJudge)
      && Boolean(originalStoredProfile)
      && (!reused || reused.health === "cooldown"
        || originalStoredProfile?.health === "cooldown" || originalStoredProfile?.enabled === false);
    if (profileHealthRefresh && previousJudge && reusedJudgeEvaluationId) {
      applyWebIntent(envelope, previousJudge.webIntentDecision);
      const admission = await startAdmissionTrace(reusedJudgeEvaluationId);
      let route: AlphaRouteDecision;
      try {
        route = routeWithCurrentAcuFormula({
          judge: previousJudge.judge,
          judgeCost: 0,
          inputTokens: contextAdmission.estimatedInputTokens,
          expectedOutputTokens: this.expectedOutputTokens,
          effectiveQualityTarget: state.effectiveQualityTarget,
          routingPreference: identity.routingPreference,
          profiles: effectiveProfiles,
          requirements: {
            protocol: envelope.protocol,
            requireTools: envelope.requiredToolTypes.length > 0,
            requiredToolTypes: envelope.requiredToolTypes,
            requireThinking: envelope.containsThinking,
            reasoningEffort: envelope.reasoningEffort,
            context: contextAdmission,
            expectedOutputTokens: this.expectedOutputTokens,
            allowedModelIds: identity.routingPolicy === "all_routing_eligible"
              ? undefined
              : identity.routingPolicy === "custom_allowlist" ? identity.allowedModelIds : [],
            allowedProfileIds: identity.allowedProfileIds.length > 0 ? identity.allowedProfileIds : undefined,
            clientDeclaredWebTool: envelope.clientDeclaredWebTool,
            webIntent: envelope.webIntent,
          },
          routeDirection: state.decision.routeDirection,
          currentProfile: originalStoredProfile,
        });
      } catch (error) {
        const typed = error instanceof AlphaAdmissionError ? error : undefined;
        await repository.completeAdmissionTrace({
          admissionTraceId: admission.admissionTraceId,
          status: "rejected",
          errorType: typed?.errorType ?? "admission_failed",
          httpStatus: typed?.statusCode ?? 502,
          maximumAvailableContextTokens: Number(typed?.details.maximum_available_context_tokens ?? 0) || undefined,
          candidateContextLimits: typed?.details.candidate_context_limits as Record<string, number> | undefined,
          exclusionCounts: typed?.details.exclusion_counts as Record<string, number> | undefined,
          metadata: {
            trigger: "reuse_route", judgeCalls: 0, judgeReused: true,
            reusedJudgeEvaluationId, routeRefreshReason,
          },
        });
        throw error;
      }
      await repository.completeAdmissionTrace({
        admissionTraceId: admission.admissionTraceId,
        status: "admitted",
        maximumAvailableContextTokens: effectiveContextCeiling(route.selectedProfile),
        exclusionCounts: Object.fromEntries(route.excludedProfiles.flatMap((item) => item.reasons)
          .map(exclusionCategory)
          .reduce((counts, category) => counts.set(category, (counts.get(category) ?? 0) + 1), new Map<string, number>())),
        metadata: {
          trigger: "reuse_route", judgeCalls: 0, judgeReused: true,
          reusedJudgeEvaluationId, routeRefreshReason,
          selectedProfileId: route.selectedProfile.executionProfileId,
        },
      });
      const routeDecisionId = alphaId("route");
      await repository.saveRouteDecision({
        routeDecisionId,
        newapiUserId: identity.newapiUserId,
        segmentId: state.segmentId,
        judgeEvaluationId: reusedJudgeEvaluationId,
        mode: envelope.requestedModel,
        policyVersion: `${POLICY_VERSION}:${identity.routingPolicyVersion}`,
        routingModelVersion: route.formulaVersion,
        qualityCurveVersion: QUALITY_CURVE_VERSION,
        priceVersion: PRICE_VERSION,
        effectiveQualityTarget: route.effectiveQualityTarget,
        formulaInputs: {
          judge: previousJudge.judge,
          judgeCost: 0,
          judgeReused: true,
          reusedJudgeEvaluationId,
          routeRefreshReason,
          inputTokens: contextAdmission.estimatedInputTokens,
          expectedOutputTokens: this.expectedOutputTokens,
          userRoutingPolicy: identity.routingPolicy,
          routingPreference: identity.routingPreference,
          routingPreferenceParameters: route.preferenceParameters,
          userRoutingPolicyVersion: identity.routingPolicyVersion,
          allowedModelIds: identity.allowedModelIds,
          allowedProfileIds: identity.allowedProfileIds,
          providerCandidateEstimates: route.providerCandidateEstimates,
          excludedProfiles: route.excludedProfiles,
          costUnit: "CNY",
          ...webIntentMetadata(previousJudge.webIntentDecision),
        },
        candidateEstimates: route.candidateEstimates,
        paretoFrontier: route.paretoFrontier,
        selectedProfile: { ...route.selectedProfile },
        routeExplanation: `Reused Judge Evaluation ${reusedJudgeEvaluationId}; refreshed route for ${routeRefreshReason}. ${route.recommendation.reason} ${route.providerSelectionReason}`,
      });
      await repository.updateSegmentDecision({
        segmentId: state.segmentId,
        newapiUserId: identity.newapiUserId,
        judgeEvaluationId: reusedJudgeEvaluationId,
        routeDecisionId,
        selectedExecutionProfileId: route.selectedProfile.executionProfileId,
        metadata: {
          ...storedSegmentMetadata,
          ...webIntentMetadata(previousJudge.webIntentDecision),
          judgeRun: previousJudge,
          selectedProfile: route.selectedProfile,
          userRoutingPolicyVersion: identity.routingPolicyVersion,
          allowedProfileIds: identity.allowedProfileIds,
          routingPreference: identity.routingPreference,
          routeRefreshReason,
        },
      });
      await this.releaseUnusedProbeClaims(probeClaims, route.selectedProfile);
      return { profile: route.selectedProfile, route, recoveryProfiles };
    }

    const context = buildAlphaJudgeContext(envelope, {
      sessionId: state.sessionId,
      taskId: state.taskId,
      segmentId: state.segmentId,
      rootGoalText: state.rootGoalText,
      phase: state.decision.phase,
      trigger: state.decision.reason,
      recentEvents: state.events,
      acceptedModelResponsesSinceJudge: state.segment.acceptedModelResponsesSinceJudge,
      taskBaseQualityTarget: state.taskBaseQualityTarget,
      capabilityEscalationFloor: state.capabilityEscalationFloor,
      temporaryPhaseOverride: state.decision.temporaryPhaseOverride,
    });
    const contextHash = canonicalHash(context.envelope);
    const webIntentFallbackInput = {
      recentUserInputs: envelope.humanCandidates
        .filter((candidate) => candidate.confidence === "high")
        .map((candidate) => candidate.text),
      rootGoalText: state.rootGoalText,
    };
    const rawNative = {
      stateMetadata: {
        sessionId: state.sessionId,
        taskId: state.taskId,
        segmentId: state.segmentId,
        phase: state.decision.phase,
        trigger: state.decision.reason,
        priorJudgeEvaluationId: stringValue(storedSegment?.judge_evaluation_id),
        currentExecutionProfileId: stringValue(storedSegment?.selected_execution_profile_id),
      },
      rawRequest: Buffer.from(ingress.rawBody).toString("utf8"),
    };
    let judge: AlphaJudgeRun;
    try {
      judge = await this.options.judgeRunner.run({
        messages: context.messages,
        tools: context.tools,
        trigger: state.decision.reason,
        contextHash,
        recentEvaluation: previousJudge,
        webIntentFallbackInput,
        rawNative,
        signal: ingress.signal,
      });
    } catch (error) {
      if (error instanceof AcuJudgeContextLengthError) {
        throw new AlphaAdmissionError(
          "judge_context_length_exceeded",
          "The complete native request exceeds the Judge context window.",
          400,
          {
            judge_context_token_estimate: error.requiredTokens,
            judge_context_limit: error.contextLimit,
            context_truncated: false,
            judge_context_source: "raw_native_request_v1",
          },
        );
      }
      throw error;
    }
    applyWebIntent(envelope, judge.webIntentDecision);
    const effectiveJudgeCostCny = Number(judge.costCny);
    const judgeEvaluationId = alphaId("judge");
    const judgeIdempotencyKey = sha256([
      judge.policyVersion,
      judge.promptVersion,
      judge.model ?? "none",
      state.triggerEventId ?? `${state.decision.reason}:${state.segmentId}`,
      judge.contextHash,
    ].join("\n"));
    const admissionIdempotencyKey = sha256([
      identity.newapiUserId,
      state.segmentId,
      envelope.protocol,
      envelope.historyHash,
      envelope.requestedModel,
    ].join("\n"));
    const admissionTraceId = alphaId("admission");
    const persisted = await this.options.database.transaction(async (client) => {
      const transactional = new AlphaRepository(client);
      const storedJudge = await transactional.saveJudgeEvaluation({
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
        rawRequestBytes: BigInt(judge.rawRequestBytes),
        rawRequestTokenEstimate: BigInt(judge.rawRequestTokenEstimate),
        judgeContextLimit: BigInt(judge.judgeContextLimit),
        judgeContextSource: judge.judgeContextSource,
        curveCalibrationEligible: !judge.terminalError
          && !judge.contextTruncated && judge.judgeContextSource === "raw_native_request_v1",
        curveCalibrationExclusionReason: judge.terminalError ? "judge_context_length_exceeded" : undefined,
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
        explanationNormalized: judge.judge.explanationNormalized,
        originalExplanationLength: judge.judge.originalExplanationLength,
        originalExplanationType: judge.judge.originalExplanationType,
        webIntent: judge.webIntentDecision.intent,
        webIntentConfidence: judge.webIntentDecision.confidence,
        webIntentReason: judge.webIntentDecision.reason,
        webIntentEvidence: judge.webIntentDecision.evidence,
        webIntentSource: judge.webIntentDecision.source,
        promptTokens: BigInt(judge.promptTokens),
        completionTokens: BigInt(judge.completionTokens),
        latencyMs: judge.latencyMs,
        actualCostUsd: judge.costUsd,
        officialPaygEquivalentCost: judge.officialPaygEquivalentCostCny,
        costCurrency: judge.costCurrency,
        judgeCostStatus: judge.costStatus,
        judgeCostSource: judge.costSource,
        errorCategory: judge.errorCategory,
      });
      const storedAdmission = await transactional.saveAdmissionTrace({
        admissionTraceId,
        admissionIdempotencyKey,
        newapiUserId: identity.newapiUserId,
        logicalRequestId,
        sessionId: state.sessionId,
        taskId: state.taskId,
        segmentId: state.segmentId,
        judgeEvaluationId: storedJudge.judgeEvaluationId,
        requestProtocol: envelope.protocol,
        requestedModel: envelope.requestedModel,
        ...contextAdmission,
        metadata: {
          trigger: state.decision.reason,
          judgeCalls: judge.attempts.length,
          judgeReused: false,
          routeRefreshReason: !state.decision.runJudge ? "missing_prior_judge" : undefined,
          webIntent: judge.webIntentDecision.intent,
          webIntentSource: judge.webIntentDecision.source,
        },
      });
      for (const attempt of judge.attempts) {
        const judgeAttemptId = alphaId("att");
        await transactional.saveJudgeAttempt({
          judgeAttemptId,
          judgeEvaluationId: storedJudge.judgeEvaluationId,
          logicalRequestId,
          attemptIndex: attempt.attemptIndex,
          attemptRole: attempt.role,
          provider: attempt.provider,
          model: attempt.model,
          endpointHost: attempt.endpointHost,
          upstreamRequestId: attempt.upstreamRequestId,
          status: attempt.status,
          errorCategory: attempt.errorCategory,
          httpStatus: attempt.httpStatus,
          inputTokens: BigInt(attempt.promptTokens),
          cachedInputTokens: BigInt(attempt.cachedPromptTokens),
          outputTokens: BigInt(attempt.completionTokens),
          latencyMs: attempt.latencyMs,
          nominalCostUsd: attempt.nominalCostUsd,
          officialPaygEquivalentCost: attempt.officialPaygEquivalentCostCny,
          effectiveCostCny: attempt.effectiveCostCny,
          currency: attempt.currency,
          costStatus: attempt.costStatus,
          costSource: attempt.costSource,
          usageStatus: attempt.usageStatus,
        });
        if (attempt.status === "error") {
          await transactional.savePayload({
            payloadId: alphaId("payload"),
            newapiUserId: identity.newapiUserId,
            logicalRequestId,
            payloadKind: "judge_attempt_error_response",
            protocol: envelope.protocol,
            contentType: attempt.responseHeaders?.["content-type"] ?? "application/octet-stream",
            headers: attempt.responseHeaders,
            body: attempt.rawResponseBody ?? "",
            isComplete: true,
            metadata: {
              judgeAttemptId,
              judgeEvaluationId: storedJudge.judgeEvaluationId,
              attemptIndex: attempt.attemptIndex,
              attemptRole: attempt.role,
              provider: attempt.provider,
              model: attempt.model,
              endpointHost: attempt.endpointHost,
              httpStatus: attempt.httpStatus,
              upstreamRequestId: attempt.upstreamRequestId,
              errorCategory: attempt.errorCategory,
              parserExceptionType: attempt.parserExceptionType,
              parserExceptionMessage: attempt.parserExceptionMessage,
              promptTokens: attempt.promptTokens,
              cachedPromptTokens: attempt.cachedPromptTokens,
              completionTokens: attempt.completionTokens,
              latencyMs: attempt.latencyMs,
              backupEligible: attempt.backupEligible,
              backupTriggered: attempt.role === "primary"
                && judge.attempts.some((candidate) => candidate.role === "backup"),
              backupReason: attempt.backupReason,
            },
          });
        }
      }
      await transactional.saveJudgeLedgerEntry({
        judgeLedgerEntryId: alphaId("ledger"),
        judgeEvaluationId: storedJudge.judgeEvaluationId,
        admissionTraceId: storedAdmission.admissionTraceId,
        newapiUserId: identity.newapiUserId,
        judgeProvider: judge.provider,
        judgeModel: judge.model,
        promptTokens: BigInt(judge.promptTokens),
        completionTokens: BigInt(judge.completionTokens),
        nominalCostUsd: judge.costUsd,
        effectiveCashCostCny: effectiveJudgeCostCny.toFixed(10),
        costSource: judge.costSource,
        officialPaygEquivalentCost: judge.officialPaygEquivalentCostCny,
        currency: judge.costCurrency,
        costStatus: judge.costStatus,
        costSourceDetail: judge.costSource,
      });
      return { storedJudge, storedAdmission };
    });
    const storedJudge = persisted.storedJudge;
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
          stateMetadata: rawNative.stateMetadata,
          rawNativeApiRequest: rawNative.rawRequest,
          rawRequestSha256: sha256(rawNative.rawRequest),
          trigger: state.decision.reason,
          contextHash: judge.contextHash,
          judgeContextSource: judge.judgeContextSource,
          contextTruncated: judge.contextTruncated,
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
    if (judge.terminalError) {
      await repository.completeAdmissionTrace({
        admissionTraceId: persisted.storedAdmission.admissionTraceId,
        status: "rejected",
        errorType: judge.terminalError.type,
        httpStatus: 400,
        metadata: {
          message: judge.terminalError.message,
          upstreamErrorCategory: judge.errorCategory,
          contextTruncated: false,
        },
      });
      throw new AlphaAdmissionError(
        judge.terminalError.type,
        judge.terminalError.message,
        400,
        {
          judge_context_token_estimate: judge.rawRequestTokenEstimate,
          judge_primary_context_tokens: judge.terminalError.primaryContextTokens,
          context_truncated: false,
          judge_context_source: judge.judgeContextSource,
          admission_trace_id: persisted.storedAdmission.admissionTraceId,
          judge_evaluation_id: storedJudge.judgeEvaluationId,
        },
      );
    }
    let route: AlphaRouteDecision;
    try {
      route = routeWithCurrentAcuFormula({
      judge: judge.judge,
      judgeCost: effectiveJudgeCostCny,
      inputTokens: contextAdmission.estimatedInputTokens,
      expectedOutputTokens: this.expectedOutputTokens,
      effectiveQualityTarget: state.effectiveQualityTarget,
      routingPreference: identity.routingPreference,
      profiles: effectiveProfiles,
      requirements: {
        protocol: envelope.protocol,
        requireTools: envelope.requiredToolTypes.length > 0,
        requiredToolTypes: envelope.requiredToolTypes,
        requireThinking: envelope.containsThinking,
        reasoningEffort: envelope.reasoningEffort,
        context: contextAdmission,
        expectedOutputTokens: this.expectedOutputTokens,
        allowedModelIds: identity.routingPolicy === "all_routing_eligible"
          ? undefined
          : identity.routingPolicy === "custom_allowlist"
            ? identity.allowedModelIds
            : [],
        allowedProfileIds: identity.allowedProfileIds.length > 0 ? identity.allowedProfileIds : undefined,
        clientDeclaredWebTool: envelope.clientDeclaredWebTool,
        webIntent: envelope.webIntent,
      },
      routeDirection: state.decision.routeDirection,
      currentProfile: reused,
      });
    } catch (error) {
      const admission = error instanceof AlphaAdmissionError ? error : undefined;
      await repository.completeAdmissionTrace({
        admissionTraceId: persisted.storedAdmission.admissionTraceId,
        status: "rejected",
        errorType: admission?.errorType ?? "admission_failed",
        httpStatus: admission?.statusCode ?? 502,
        maximumAvailableContextTokens: Number(admission?.details.maximum_available_context_tokens ?? 0) || undefined,
        candidateContextLimits: admission?.details.candidate_context_limits as Record<string, number> | undefined,
        exclusionCounts: admission?.details.exclusion_counts as Record<string, number> | undefined,
        metadata: { message: error instanceof Error ? error.message : "admission_failed" },
      });
      if (admission) {
        admission.details.admission_trace_id = persisted.storedAdmission.admissionTraceId;
        admission.details.judge_evaluation_id = persisted.storedJudge.judgeEvaluationId;
        admission.details.judge_cost_usd = judge.costUsd;
        admission.details.judge_cash_cost_cny = effectiveJudgeCostCny.toFixed(10);
        admission.details.judge_provider = judge.provider;
        admission.details.judge_model = judge.model;
      }
      throw error;
    }
    await repository.completeAdmissionTrace({
      admissionTraceId: persisted.storedAdmission.admissionTraceId,
      status: "admitted",
      maximumAvailableContextTokens: effectiveContextCeiling(route.selectedProfile),
      exclusionCounts: Object.fromEntries(route.excludedProfiles.flatMap((item) => item.reasons)
        .map(exclusionCategory)
        .reduce((counts, category) => counts.set(category, (counts.get(category) ?? 0) + 1), new Map<string, number>())),
      metadata: { selectedProfileId: route.selectedProfile.executionProfileId },
    });
    const qualityCeiling = route.candidateEstimates.reduce((best, candidate) => (
      !best || candidate.conservativeScore > best.conservativeScore ? candidate : best
    ), undefined as (typeof route.candidateEstimates)[number] | undefined);
    const selectedCandidate = route.candidateEstimates.find((candidate) => (
      candidate.modelId === route.selectedProfile.modelId
    ));
    const routeDecisionSnapshot = {
      difficultyIndex: judge.judge.difficultyIndex,
      difficultyFactors: judge.judge.factors,
      judgeConfidence: judge.judge.confidence,
      qualityTarget: route.effectiveQualityTarget,
      routingPreference: route.preference,
      webIntent: judge.webIntentDecision.intent,
      candidateCount: route.candidateEstimates.length,
      legalCanonicalModelCandidates: route.candidateEstimates.map((candidate) => candidate.modelId),
      candidates: route.candidateEstimates.map((candidate) => {
        const model = getAcuModel(candidate.modelId);
        const nominalCost = model?.inputPricePerMillion === null || model?.outputPricePerMillion === null
          ? null
          : ((contextAdmission.estimatedInputTokens * (model?.inputPricePerMillion ?? 0))
            + (this.expectedOutputTokens * (model?.outputPricePerMillion ?? 0))) / 1_000_000;
        return {
          modelId: candidate.modelId,
          estimatedQuality: candidate.estimatedQuality,
          nominalCost,
          effectiveCashCost: candidate.estimatedCallCost,
          valueScore: candidate.valueUtility,
          pareto: candidate.paretoEfficient,
          exclusionReason: null,
        };
      }),
      curves: Object.fromEntries(route.candidateEstimates.flatMap((candidate) => {
        const model = getAcuModel(candidate.modelId);
        return model ? [[candidate.modelId, buildModelCurve(model).map((point) => ({
          difficulty: point.difficultyScore,
          estimatedQuality: point.estimatedQuality * 100,
        }))]] : [];
      })),
      excludedProfiles: route.excludedProfiles.map((profile) => ({
        executionProfileId: profile.executionProfileId,
        exclusionReason: exclusionCategory(profile.reasons[0] ?? "adapter"),
        exclusionDetail: profile.reasons[0] ?? "adapter",
      })),
      selectedModel: route.selectedProfile.modelId,
      selectedChannel: route.selectedProfile.channelId ?? route.selectedProfile.channel,
      modelSelectionReason: route.recommendation.reason,
      channelSelectionReason: route.providerSelectionReason,
      qualityCeilingModel: qualityCeiling?.modelId,
      costReductionVsCeiling: selectedCandidate && qualityCeiling
        ? Math.max(0, qualityCeiling.expectedTotalCost - selectedCandidate.expectedTotalCost)
        : null,
    };
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
      effectiveQualityTarget: route.effectiveQualityTarget,
      formulaInputs: {
        judge: judge.judge,
        judgeCost: judge.costUsd,
        effectiveJudgeCostCny,
        effectiveSwitchCostCny: route.effectiveSwitchCost,
        inputTokens: contextAdmission.estimatedInputTokens,
        estimatedInputTokens: contextAdmission.estimatedInputTokens,
        estimationMethod: contextAdmission.estimationMethod,
        requestedMaxOutputTokens: contextAdmission.requestedMaxOutputTokens,
        reservedOutputTokens: contextAdmission.reservedOutputTokens,
        safetyMarginTokens: contextAdmission.safetyMarginTokens,
        requiredTotalContextTokens: contextAdmission.requiredTotalContextTokens,
        effectiveContextCeiling: effectiveContextCeiling(route.selectedProfile),
        expectedOutputTokens: this.expectedOutputTokens,
        userRoutingPolicy: identity.routingPolicy,
        routingPreference: identity.routingPreference,
        routingPreferenceParameters: route.preferenceParameters,
        baseEffectiveQualityTarget: state.effectiveQualityTarget,
        userRoutingPolicyVersion: identity.routingPolicyVersion,
        allowedModelIds: identity.allowedModelIds,
        allowedProfileIds: identity.allowedProfileIds,
        configuredProfileCount: effectiveProfiles.length,
        protocolProfileCount: effectiveProfiles.filter((profile) => profile.protocols.includes(envelope.protocol)).length,
        initialCandidateModelCount: new Set(
          effectiveProfiles
            .filter((profile) => profile.protocols.includes(envelope.protocol))
            .map((profile) => profile.modelId),
        ).size,
        hardFilteredProfileCount: route.candidateEstimates
          .reduce((count, estimate) => count + estimate.executionProfileIds.length, 0),
        hardFilteredCandidateModelCount: route.candidateEstimates.length,
        paretoFrontierCandidateCount: route.paretoFrontier.length,
        excludedProfiles: route.excludedProfiles,
        costUnit: "CNY",
        providerSelectionReason: route.providerSelectionReason,
        providerCandidateEstimates: route.providerCandidateEstimates,
        reasoningEffort: envelope.reasoningEffort,
        requiredToolTypes: envelope.requiredToolTypes,
        clientDeclaredWebTool: envelope.clientDeclaredWebTool,
        ...webIntentMetadata(judge.webIntentDecision),
        decisionSnapshot: routeDecisionSnapshot,
      },
      candidateEstimates: route.candidateEstimates,
      paretoFrontier: route.paretoFrontier,
      selectedProfile: { ...route.selectedProfile },
      routeExplanation: `${route.recommendation.reason} ${route.providerSelectionReason}`,
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
        ...webIntentMetadata(judge.webIntentDecision),
        judgeRun: judge,
        selectedProfile: route.selectedProfile,
        userRoutingPolicyVersion: identity.routingPolicyVersion,
        allowedProfileIds: identity.allowedProfileIds,
        routingPreference: identity.routingPreference,
      },
    });
    await this.releaseUnusedProbeClaims(probeClaims, route.selectedProfile);
    return { profile: route.selectedProfile, judge, route, recoveryProfiles };
  }

  private recoveryProfile(
    current: AlphaExecutionProfile,
    envelope: CanonicalEnvelope,
    mode: AlphaMode,
    excludedProfileIds: Set<string> = new Set(),
  ): AlphaExecutionProfile | undefined {
    const equivalent = this.options.profiles.filter((profile) => (
      profile.executionProfileId !== current.executionProfileId
      && !excludedProfileIds.has(profile.executionProfileId)
      && profile.modelId === current.modelId
      && profile.enabled
      && profile.administratorAllowed
      && profile.health === "healthy"
      && profile.usageTrusted !== false
      && (!profile.economics || (profile.economics.enabled && profile.economics.health === "healthy"))
      && profile.protocols.includes(envelope.protocol)
      && (!envelope.requiredToolTypes.length || profile.toolCallSupport)
      && envelope.requiredToolTypes.every((toolType) => profile.supportedToolTypes?.includes(toolType))
      && (envelope.webIntent !== "required" || profile.webSearchExecutionVerified === true)
      && (!envelope.containsThinking || profile.thinkingSupport)
      && effectiveContextCeiling(profile) >= estimateContextAdmission(envelope, this.expectedOutputTokens).requiredTotalContextTokens
      && this.options.adapters.has(profile.executionProfileId)
    )).sort((left, right) => {
      const leftRate = left.economics
        ? left.economics.observedBillingMultiplier * (left.economics.rechargeCashCny ?? Number.POSITIVE_INFINITY)
          / (left.economics.creditsReceivedUsd ?? 1)
        : 1;
      const rightRate = right.economics
        ? right.economics.observedBillingMultiplier * (right.economics.rechargeCashCny ?? Number.POSITIVE_INFINITY)
          / (right.economics.creditsReceivedUsd ?? 1)
        : 1;
      return leftRate - rightRate;
    })[0];
    return equivalent;
  }

  private endpoints(profile: AlphaExecutionProfile): Array<{ endpoint: string; adapter: NativeProviderAdapter }> {
    const configured = this.options.networkAdapters?.get(profile.executionProfileId);
    if (configured?.length) return configured;
    const adapter = this.options.adapters.get(profile.executionProfileId);
    return adapter ? [{ endpoint: "primary", adapter }] : [];
  }

  private async recordRuntimeHealth(profile: AlphaExecutionProfile, protocol: AlphaProtocol, outcome: AttemptOutcome): Promise<{ errorClass: string; cooldownUntil?: Date }> {
    const repository = new AlphaRepository(this.options.database);
    const channelId = profile.channelId ?? profile.channel;
    const classified = classifyAttemptOutcome(outcome, (await repository.channelHealth(channelId))?.consecutiveFailures ?? 0);
    const initial = (): HealthSnapshot => ({ state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 });
    if (classified.scope === "channel" || outcome.success || outcome.clientCancelled) {
      const current = await repository.channelHealth(channelId) ?? initial();
      await repository.saveChannelHealth({ channelId, providerId: profile.provider,
        snapshot: applyAttemptOutcome(current, outcome) });
    }
    if (classified.scope === "profile" || outcome.success || outcome.clientCancelled) {
      const current = await repository.profileHealth(profile.executionProfileId) ?? initial();
      const snapshot = applyAttemptOutcome(current, outcome);
      await repository.saveProfileHealth({
        executionProfileId: profile.executionProfileId,
        channelId,
        providerId: profile.provider,
        canonicalModelId: profile.modelId,
        protocol,
        snapshot,
        usageTrusted: classified.usageTrusted && profile.usageTrusted !== false,
        actualModelVerified: !outcome.actualModelMismatch,
        healthReason: classified.errorClass,
      });
    }
    const persisted = classified.scope === "profile"
      ? await repository.profileHealth(profile.executionProfileId)
      : await repository.channelHealth(channelId);
    return { errorClass: classified.errorClass, cooldownUntil: persisted?.cooldownUntil };
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
    webFailure?: boolean;
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
    const responseText = input.response?.body.toString("utf8") ?? "";
    const retryAfterSeconds = input.response?.headers["retry-after"] ? Number(input.response.headers["retry-after"]) : undefined;
    const health = input.webFailure ? undefined : await this.recordRuntimeHealth(input.attempt.profile, input.protocol, {
      success: false,
      httpStatus: input.response?.status,
      errorCode: input.error instanceof Error ? input.error.name : undefined,
      errorMessage: input.error instanceof Error ? input.error.message : responseText.slice(0, 512),
      retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      firstTokenLatencyMs: input.response?.observation?.firstModelEventLatencyMs,
      totalLatencyMs: input.latencyMs,
    });
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
      errorCategory: input.webFailure ? "web_search_failed" : "provider_error",
      httpStatus: input.response?.status,
      inputTokens: usage?.inputTokens,
      cachedInputTokens: usage?.cachedInputTokens,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.reasoningTokens,
      usageSource: usage?.usageSource,
      actualCostUsd: "0.0000000000",
      latencyMs: input.latencyMs,
      visibleOutputBytes: input.response?.observation?.modelVisibleOutputBytes ?? 0,
      metadata: {
        error: input.error instanceof Error ? input.error.message : undefined,
        webFailure: input.webFailure === true,
        normalized_error_signature: sha256(`${health?.errorClass ?? "web_search_failed"}\n${input.response?.status ?? 0}\n${input.attempt.profile.provider}\n${input.attempt.profile.channel}`),
        errorClass: health?.errorClass,
        endpoint: input.attempt.networkEndpoint,
        cfRay: input.response?.headers["cf-ray"],
        contentType,
        retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
        raw_response_bytes: input.response?.observation?.rawResponseBytes ?? input.response?.body.byteLength ?? 0,
        model_visible_output_bytes: input.response?.observation?.modelVisibleOutputBytes ?? 0,
        first_model_event_at: input.response?.observation?.firstModelEventAt?.toISOString(),
        first_model_event_latency_ms: input.response?.observation?.firstModelEventLatencyMs,
        cooldown_until: health?.cooldownUntil?.toISOString(),
      },
    });
    if (input.webFailure) {
      const runtime = await repository.profileHealth(input.attempt.profile.executionProfileId);
      const previousRate = optionalNumber(runtime?.metadata?.webSearchRecentSuccessRate)
        ?? input.attempt.profile.webSearchRecentSuccessRate
        ?? 1;
      await repository.saveProfileWebHealth({
        executionProfileId: input.attempt.profile.executionProfileId,
        channelId: input.attempt.profile.channelId ?? input.attempt.profile.channel,
        providerId: input.attempt.profile.provider,
        canonicalModelId: input.attempt.profile.modelId,
        protocol: input.protocol,
        usageTrusted: input.attempt.profile.usageTrusted !== false,
        actualModelVerified: true,
        metadata: {
          webSearchRecentSuccessRate: (previousRate * 4) / 5,
          webSearchFailureReason: "web_search_provider_error",
        },
      });
    }
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
        errorClass: health?.errorClass,
        cooldownUntil: health?.cooldownUntil?.toISOString(),
        recoveryEligible: (input.response?.observation?.modelVisibleOutputBytes ?? 0) === 0,
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
    networkEndpointIndex?: number;
    routeDecisionId?: string;
    judgeEvaluationId?: string;
  }): Promise<ProviderAttemptHandle> {
    const endpointIndex = input.networkEndpointIndex ?? 0;
    const endpoint = this.endpoints(input.profile)[endpointIndex];
    if (!endpoint) throw new Error(`No Provider adapter endpoint ${endpointIndex} for ${input.profile.executionProfileId}`);
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
      channelId: input.profile.channelId ?? input.profile.channel,
      networkEndpoint: endpoint.endpoint,
      executionProfileId: input.profile.executionProfileId,
      requestedModel: input.requestedModel,
      actualModel: input.profile.modelId,
      status: "started",
      inputPricePerMillion: catalogModel?.inputPricePerMillion?.toString(),
      outputPricePerMillion: catalogModel?.outputPricePerMillion?.toString(),
      metadata: {
        clientDeclaredWebTool: input.envelope.clientDeclaredWebTool,
        webIntent: input.envelope.webIntent,
        webIntentSource: input.envelope.webIntentSource,
        providerRequestDeclaresWebTool: bodyDeclaresHostedWebTool(input.body),
        webProfileVerified: input.profile.webSearchExecutionVerified === true,
      },
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
      metadata: {
        requestedModel: input.requestedModel,
        canonicalModel: input.profile.modelId,
        providerModel: input.profile.providerModelId ?? input.profile.modelId,
        selectedProvider: input.profile.provider,
        channelId: input.profile.channelId ?? input.profile.channel,
        networkEndpoint: endpoint.endpoint,
        clientDeclaredWebTool: input.envelope.clientDeclaredWebTool,
        webIntent: input.envelope.webIntent,
        webIntentSource: input.envelope.webIntentSource,
        providerRequestDeclaresWebTool: bodyDeclaresHostedWebTool(input.body),
        webProfileVerified: input.profile.webSearchExecutionVerified === true,
      },
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
    return { attemptId, attemptIndex: input.attemptIndex, adapter: endpoint.adapter, profile: input.profile,
      body: input.body, networkEndpointIndex: endpointIndex, networkEndpoint: endpoint.endpoint };
  }

  async resolveExecution(
    envelope: CanonicalEnvelope,
    identity: TrustedNewApiIdentity,
    ingress: AlphaIngressContext,
  ): Promise<AlphaExecutionResolution> {
    const mode = modeForModel(envelope.requestedModel);
    const state = await this.prepareState(envelope, identity, ingress, mode);
    const repository = new AlphaRepository(this.options.database);
    const ingressIdempotencyKey = sha256([
      identity.newapiUserId,
      identity.newapiLogId,
      identity.requestId,
    ].join("\n"));
    await repository.abandonStaleLogicalRequest(identity.newapiUserId, ingressIdempotencyKey);
    const requestedLogicalRequestId = alphaId("req");
    const replayableLogical = await repository.getReplayableLogicalRequest(
      identity.newapiUserId,
      ingressIdempotencyKey,
    );
    const logical = replayableLogical
      ? { logicalRequestId: String(replayableLogical.logical_request_id), inserted: false }
      : await repository.createLogicalRequest({
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
      streaming: envelope.stream,
      hadTools: envelope.tools.length > 0,
      metadata: {
        requestId: identity.requestId,
        newapiLogId: identity.newapiLogId,
        requestBodySha256: identity.bodySha256,
        requestIdentityVersion: "trusted-request-instance-v1",
        reasoningEffort: envelope.reasoningEffort,
        clientDeclaredWebTool: envelope.clientDeclaredWebTool,
        webIntent: envelope.webIntent,
        webIntentConfidence: envelope.webIntentConfidence,
        webIntentReason: envelope.webIntentReason,
        webIntentEvidence: envelope.webIntentEvidence,
        webIntentSource: envelope.webIntentSource,
        webActuallyInvoked: false,
      },
      });
    if (logical.inserted) this.options.wakeProbe?.();
    const logicalRow = replayableLogical
      ?? await repository.getLogicalRequest(logical.logicalRequestId, identity.newapiUserId);
    if (!logical.inserted && logicalRow?.status === "completed" && stringValue(logicalRow.response_payload_id)) {
      const payload = await repository.getPayload(String(logicalRow.response_payload_id), identity.newapiUserId);
      if (payload) {
        const replayProfile = this.options.profiles.find((profile) => (
          profile.executionProfileId === stringValue(logicalRow.selected_profile_id)
        ));
        if (!replayProfile) throw new Error("Replayed logical request has no execution profile");
        const replaySegment = await repository.getSegment(state.segmentId, identity.newapiUserId);
        const replayRouteDecisionId = stringValue(replaySegment?.route_decision_id);
        const replayStoredRoute = replayRouteDecisionId
          ? await repository.getRouteDecision(replayRouteDecisionId, identity.newapiUserId)
          : undefined;
        return {
          adapter: staticResponseAdapter(payload),
          requestedModel: envelope.requestedModel,
          actualModel: replayProfile.modelId,
          provider: replayProfile.provider,
          channel: replayProfile.channel,
          context: {
            logicalRequestId: logical.logicalRequestId,
            sessionId: state.sessionId,
            taskId: state.taskId,
            segmentId: state.segmentId,
            newapiUserId: identity.newapiUserId,
            newapiTokenId: identity.newapiTokenId,
            newapiLogId: identity.newapiLogId,
            protocol: envelope.protocol,
            requestedModel: envelope.requestedModel,
            reasoningEffort: envelope.reasoningEffort,
            selectedProfile: replayProfile,
            judgeCostUsd: "0.0000000000",
            judgeCashCostCny: "0.0000000000",
            judgeInputTokens: 0,
            judgeOutputTokens: 0,
            judgeOfficialPaygEquivalentCost: "0.0000000000",
            judgeCostCurrency: "CNY",
            judgeCostStatus: "not_applicable",
            judgeCostSource: "not_applicable",
            requestBytes: ingress.rawBody.byteLength,
            replayed: true,
            clientDeclaredWebTool: envelope.clientDeclaredWebTool,
            webIntent: envelope.webIntent,
            webIntentConfidence: envelope.webIntentConfidence,
            webIntentReason: envelope.webIntentReason,
            webIntentEvidence: envelope.webIntentEvidence,
            webIntentSource: envelope.webIntentSource!,
            webActuallyInvoked: false,
            webSearchEventStatus: [],
            webToolPruned: false,
            webFallbackChain: [],
            attemptedExecutionProfileIds: [replayProfile.executionProfileId],
            attemptedChannelIds: [replayProfile.channelId ?? replayProfile.channel],
            attemptedProviders: [replayProfile.provider],
            attemptedNetworkEndpoints: [],
            phase: stringValue(replaySegment?.phase),
            judgeCalls: 0,
            judgeReused: Boolean(replaySegment?.judge_evaluation_id),
            reusedJudgeEvaluationId: stringValue(replaySegment?.judge_evaluation_id),
            routeDecisionSnapshot: replayStoredRoute,
            routeSummary: routeDisplaySummary(
              envelope.requestedModel,
              replayProfile.modelId,
              identity.routingPreference,
              undefined,
              undefined,
              replayStoredRoute,
            ),
          } satisfies AlphaResolutionContext,
        };
      }
    }
    if (!logical.inserted && logicalRow?.status === "failed") {
      const logicalMetadata = metadata(logicalRow);
      const errorType = stringValue(logicalMetadata.admissionErrorType);
      if (errorType) {
        throw new AlphaAdmissionError(
          errorType,
          stringValue(logicalMetadata.admissionErrorMessage) ?? "Admission failed",
          numberValue(logicalMetadata.admissionHttpStatus, 400),
          record(logicalMetadata.admissionErrorDetails) ?? {},
        );
      }
    }
    if (!logical.inserted) {
      throw new AlphaAdmissionError(
        "request_in_progress",
        "An identical logical request is already being processed.",
        409,
        { logical_request_id: logical.logicalRequestId },
      );
    }
    let result: Awaited<ReturnType<AlphaRequestProcessor["judgeAndRoute"]>>;
    try {
      result = await this.judgeAndRoute(envelope, identity, state, logical.logicalRequestId, ingress);
    } catch (error) {
      if (ingress.signal.aborted || error instanceof AcuJudgeClientCancelledError) {
        await repository.completeLogicalRequest({
          logicalRequestId: logical.logicalRequestId,
          newapiUserId: identity.newapiUserId,
          status: "cancelled",
          errorCategory: "client_cancelled",
        });
        throw error;
      }
      if (error instanceof AlphaAdmissionError) {
        await repository.updateLogicalRequestMetadata(logical.logicalRequestId, identity.newapiUserId, {
          admissionErrorType: error.errorType,
          admissionErrorMessage: error.message,
          admissionHttpStatus: error.statusCode,
          admissionErrorDetails: error.details,
        });
        await repository.completeLogicalRequest({
          logicalRequestId: logical.logicalRequestId,
          newapiUserId: identity.newapiUserId,
          status: "failed",
          errorCategory: error.errorType,
        });
        await this.createAdmissionFailureUsageReport({
          logicalRequestId: logical.logicalRequestId,
          identity,
          envelope,
          error,
        });
      }
      throw error;
    }
    await repository.selectLogicalRequestProfile(
      logical.logicalRequestId,
      identity.newapiUserId,
      result.profile.executionProfileId,
    );
    const executionSegment = await repository.getSegment(state.segmentId, identity.newapiUserId);
    const routeDecisionId = stringValue(executionSegment?.route_decision_id);
    const judgeEvaluationId = stringValue(executionSegment?.judge_evaluation_id);
    const storedRoute = routeDecisionId
      ? await repository.getRouteDecision(routeDecisionId, identity.newapiUserId)
      : undefined;
    const storedRouteInputs = record(storedRoute?.formula_inputs_json);
    const storedExecutionMetadata = metadata(executionSegment);
    const routeRefreshReason = stringValue(storedRouteInputs?.routeRefreshReason)
      ?? stringValue(storedExecutionMetadata.routeRefreshReason);
    const judgeReused = Boolean(storedRouteInputs?.judgeReused)
      || (!result.judge && Boolean(judgeEvaluationId) && mode !== "explicit");
    const attemptIndex = await repository.nextProviderAttemptIndex(logical.logicalRequestId);
    const maxProviderAttempts = 3;
    if (attemptIndex > maxProviderAttempts) throw new Error("Provider Attempt budget exhausted for logical request");
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
    const prepared = prepareProviderBody(
      ingress.rawBody,
      mode === "explicit" ? envelope.requestedModel : result.profile.providerModelId ?? result.profile.modelId,
      envelope,
      result.profile,
    );
    const providerBody = prepared.body;
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
    const judgeCashCostCny = result.judge?.costCny ?? "0.0000000000";
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
      requestedModel: envelope.requestedModel,
      reasoningEffort: envelope.reasoningEffort,
      selectedProfile: result.profile,
      networkEndpoint: initialAttempt.networkEndpoint,
      judgeCostUsd: result.judge?.costUsd ?? "0.0000000000",
      judgeCashCostCny,
      judgeInputTokens: result.judge?.promptTokens ?? 0,
      judgeOutputTokens: result.judge?.completionTokens ?? 0,
      judgeOfficialPaygEquivalentCost: result.judge?.officialPaygEquivalentCostCny ?? "0.0000000000",
      judgeCostCurrency: result.judge?.costCurrency ?? "CNY",
      judgeCostStatus: result.judge?.costStatus ?? "not_applicable",
      judgeCostSource: result.judge?.costSource ?? "not_applicable",
      judgeProvider: result.judge?.provider,
      judgeModel: result.judge?.model,
      judgeLatencyMs: result.judge?.latencyMs ?? 0,
      requestBytes: ingress.rawBody.byteLength,
      replayed: false,
      clientDeclaredWebTool: envelope.clientDeclaredWebTool,
      webIntent: envelope.webIntent,
      webIntentConfidence: envelope.webIntentConfidence,
      webIntentReason: envelope.webIntentReason,
      webIntentEvidence: envelope.webIntentEvidence,
      webIntentSource: envelope.webIntentSource!,
      webActuallyInvoked: false,
      webSearchEventStatus: [],
      webToolPruned: prepared.webToolPruned,
      webToolPruneReason: prepared.pruneReason,
      webFallbackChain: [],
      attemptedExecutionProfileIds: [result.profile.executionProfileId],
      attemptedChannelIds: [result.profile.channelId ?? result.profile.channel],
      attemptedProviders: [result.profile.provider],
      attemptedNetworkEndpoints: initialAttempt.networkEndpoint ? [initialAttempt.networkEndpoint] : [],
      phase: state.decision.phase,
      judgeExplanation: result.judge?.judge.explanation,
      judgeTrigger: routeRefreshReason ? "reuse_route" : state.decision.reason,
      judgeCalls: result.judge ? 1 : 0,
      judgeReused,
      reusedJudgeEvaluationId: judgeReused ? judgeEvaluationId : undefined,
      routeRefreshReason,
      routeDecisionSnapshot: storedRoute,
      routeSummary: routeDisplaySummary(
        envelope.requestedModel,
        result.profile.modelId,
        identity.routingPreference,
        result.judge,
        result.route,
        storedRoute,
      ),
    };
    const recoveryContextAdmission = estimateContextAdmission(envelope, this.expectedOutputTokens);
    const latencySamples = await this.options.database.query<{ latency_ms: number }>(
      `SELECT (metadata_json->>'first_model_event_latency_ms')::double precision AS latency_ms
       FROM acu_attempts
       WHERE attempt_kind='provider' AND status='success' AND execution_profile_id=$1
         AND metadata_json ? 'first_model_event_latency_ms'
         AND CASE WHEN $2::boolean THEN input_tokens>=100000 ELSE input_tokens<100000 END
         AND completed_at >= now()-interval '24 hours'
       ORDER BY completed_at DESC LIMIT 50`,
      [result.profile.executionProfileId, recoveryContextAdmission.estimatedInputTokens >= 100_000],
    );
    const recentOutcomes = await this.options.database.query<{ error_class: string }>(
      `SELECT COALESCE(metadata_json->>'errorClass',error_category,'') AS error_class
       FROM acu_attempts WHERE attempt_kind='provider' AND execution_profile_id=$1
         AND completed_at >= now()-interval '24 hours'
       ORDER BY completed_at DESC LIMIT 5`,
      [result.profile.executionProfileId],
    );
    const runtimeProfileHealth = await new AlphaRepository(this.options.database).profileHealth(result.profile.executionProfileId);
    const firstModelEventDeadlineMs = computeFirstModelEventDeadlineMs({
      estimatedInputTokens: recoveryContextAdmission.estimatedInputTokens,
      successfulLatenciesMs: latencySamples.rows.map((row) => Number(row.latency_ms)),
      recentErrorClasses: recentOutcomes.rows.map((row) => row.error_class),
      profileState: runtimeProfileHealth?.state ?? result.profile.health,
    });
    const attemptedProfiles = new Set(resolutionContext.attemptedExecutionProfileIds);
    const attemptedChannels = new Set(resolutionContext.attemptedChannelIds);
    const attemptedProviders = new Set(resolutionContext.attemptedProviders);
    const attemptedEndpoints = new Set(resolutionContext.attemptedNetworkEndpoints);
    const routeProfiles = (result.route?.providerCandidateEstimates ?? [])
      .filter((candidate) => candidate.health === "healthy" && candidate.usageTrusted)
      .map((candidate) => this.options.profiles.find((profile) => profile.executionProfileId === candidate.executionProfileId))
      .filter((profile): profile is AlphaExecutionProfile => Boolean(profile));
    const recoveryPool = [...routeProfiles, ...result.recoveryProfiles].filter((profile, index, all) => (
      all.findIndex((candidate) => candidate.executionProfileId === profile.executionProfileId) === index
      && profile.modelId === result.profile.modelId && profile.enabled && profile.administratorAllowed
      && profile.health === "healthy" && profile.usageTrusted !== false
      && (!profile.economics || (profile.economics.enabled && profile.economics.health === "healthy"))
      && profile.protocols.includes(envelope.protocol)
      && (!envelope.requiredToolTypes.length || profile.toolCallSupport)
      && envelope.requiredToolTypes.every((toolType) => profile.supportedToolTypes?.includes(toolType))
      && (envelope.webIntent !== "required" || profile.webSearchExecutionVerified === true)
      && (!envelope.containsThinking || profile.thinkingSupport)
      && effectiveContextCeiling(profile) >= recoveryContextAdmission.requiredTotalContextTokens
      && this.options.adapters.has(profile.executionProfileId)
    ));
    const hasUnattemptedRecovery = (current: ProviderAttemptHandle): boolean => recoveryPool.some((profile) => (
      !attemptedProfiles.has(profile.executionProfileId) && !attemptedChannels.has(profile.channelId ?? profile.channel)
    )) || this.endpoints(current.profile).some((item) => !attemptedEndpoints.has(item.endpoint));
    const adapter = createRecoveringProviderAdapter({
      initial: initialAttempt,
      maxAttempts: maxProviderAttempts,
      isRecoverableResponse: (response) => isWebSearchProviderError(response, envelope.webIntent),
      hasRecoveryTarget: hasUnattemptedRecovery,
      firstModelEventDeadlineMs: () => firstModelEventDeadlineMs,
      selectRecoveryTarget: (() => {
        return (current, failure, error): ProviderRecoveryTarget | undefined => {
          const eligible = recoveryPool.filter((profile) => (
            !attemptedProfiles.has(profile.executionProfileId)
            && !attemptedChannels.has(profile.channelId ?? profile.channel)
          ));
          const errorClass = failure?.status === 524
            ? "provider_edge_timeout"
            : error instanceof Error ? error.message : undefined;
          const preferCrossProvider = errorClass === "provider_edge_timeout"
            || (runtimeProfileHealth?.consecutiveFailures ?? 0) > 0;
          const profile = (current.attemptIndex === 1 && !preferCrossProvider
            ? eligible.find((candidate) => candidate.provider === current.profile.provider)
            : undefined)
            ?? (current.attemptIndex === 1 && preferCrossProvider
              ? eligible.find((candidate) => candidate.provider !== current.profile.provider)
            : undefined)
            ?? (current.attemptIndex >= 2
            ? eligible.find((candidate) => candidate.provider !== result.profile.provider)
            : undefined)
            ?? eligible[0];
          if (profile) {
            attemptedProfiles.add(profile.executionProfileId);
            attemptedChannels.add(profile.channelId ?? profile.channel);
            attemptedProviders.add(profile.provider);
            const primaryEndpoint = this.endpoints(profile)[0]?.endpoint;
            if (primaryEndpoint) attemptedEndpoints.add(primaryEndpoint);
            resolutionContext.attemptedExecutionProfileIds = [...attemptedProfiles];
            resolutionContext.attemptedChannelIds = [...attemptedChannels];
            resolutionContext.attemptedProviders = [...attemptedProviders];
            resolutionContext.attemptedNetworkEndpoints = [...attemptedEndpoints];
            return { profile, networkEndpointIndex: 0, reason: "same_model_channel_fallback" };
          }
          const endpointProfiles = [current.profile, ...recoveryPool.filter((candidate) => attemptedProfiles.has(candidate.executionProfileId))];
          for (const endpointProfile of endpointProfiles) {
            const endpoints = this.endpoints(endpointProfile);
            for (let index = 0; index < endpoints.length; index += 1) {
              const endpoint = endpoints[index]?.endpoint;
              if (!endpoint || attemptedEndpoints.has(endpoint)) continue;
              attemptedEndpoints.add(endpoint);
              resolutionContext.attemptedNetworkEndpoints = [...attemptedEndpoints];
              return { profile: endpointProfile, networkEndpointIndex: index, reason: "network_endpoint_fallback" };
            }
          }
          return undefined;
        };
      })(),
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
          webFailure: Boolean(response && isWebSearchProviderError(response, envelope.webIntent)),
        });
      },
      startRetry: async (profile, nextAttemptIndex, target) => {
        const retryPrepared = prepareProviderBody(
          ingress.rawBody,
          mode === "explicit" ? envelope.requestedModel : profile.providerModelId ?? profile.modelId,
          envelope,
          profile,
        );
        const retryBody = retryPrepared.body;
        const next = await this.startProviderAttempt({
          identity,
          state,
          logicalRequestId: logical.logicalRequestId,
          envelope,
          requestedModel: envelope.requestedModel,
          profile,
          attemptIndex: nextAttemptIndex,
          retryOwner: "acu",
          body: retryBody,
          networkEndpointIndex: target?.networkEndpointIndex,
          routeDecisionId,
          judgeEvaluationId,
        });
        resolutionContext.attemptId = next.attemptId;
        resolutionContext.attemptIndex = next.attemptIndex;
        resolutionContext.selectedProfile = next.profile;
        resolutionContext.networkEndpoint = next.networkEndpoint;
        if (!resolutionContext.attemptedExecutionProfileIds.includes(next.profile.executionProfileId)) {
          resolutionContext.attemptedExecutionProfileIds.push(next.profile.executionProfileId);
        }
        const nextChannelId = next.profile.channelId ?? next.profile.channel;
        if (!resolutionContext.attemptedChannelIds.includes(nextChannelId)) resolutionContext.attemptedChannelIds.push(nextChannelId);
        if (!resolutionContext.attemptedProviders.includes(next.profile.provider)) resolutionContext.attemptedProviders.push(next.profile.provider);
        if (next.networkEndpoint && !resolutionContext.attemptedNetworkEndpoints.includes(next.networkEndpoint)) {
          resolutionContext.attemptedNetworkEndpoints.push(next.networkEndpoint);
        }
        resolutionContext.webToolPruned = retryPrepared.webToolPruned;
        resolutionContext.webToolPruneReason = retryPrepared.pruneReason;
        if (envelope.webIntent !== "not_required") {
          if (resolutionContext.webFallbackChain.length === 0) {
            resolutionContext.webFallbackChain.push(
              `${result.profile.channel}:${initialAttempt.networkEndpoint ?? "primary"}`,
            );
          }
          resolutionContext.webFallbackChain.push(`${next.profile.channel}:${next.networkEndpoint ?? "primary"}`);
        }
        resolutionContext.routeSummary.providerSelectionReason = [
          resolutionContext.routeSummary.providerSelectionReason,
          `${target?.reason ?? "same_model_channel_fallback"}:${next.profile.channel}:${next.networkEndpoint ?? "primary"}`,
        ].filter(Boolean).join("; ");
        return next;
      },
      onSelected(attempt) {
        resolutionContext.attemptId = attempt.attemptId;
        resolutionContext.attemptIndex = attempt.attemptIndex;
        resolutionContext.selectedProfile = attempt.profile;
        resolutionContext.networkEndpoint = attempt.networkEndpoint;
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
    const economics = input.context.selectedProfile.economics;
    const providerCash = economics
      ? providerCostBreakdown(economics, Number(providerCostUsd))
      : {
          nominalProviderCostUsd: Number(providerCostUsd),
          providerBalanceCharge: Number(providerCostUsd),
          providerBalanceCurrency: "USD-denominated credits" as const,
          providerCreditCashCostCny: 1,
          effectiveCashCostCny: Number(providerCostUsd),
          effectiveCostSource: "missing_provider_economics",
          effectiveCostVersion: "missing_provider_economics",
        };
    const failedAttempts = await this.options.database.query<{
      provider: string;
      channel: string | null;
      actual_cost_usd: string;
    }>(
      `SELECT provider,channel,actual_cost_usd FROM acu_attempts
       WHERE logical_request_id=$1 AND attempt_kind='provider' AND status='error'
         AND provider_billed=true AND actual_cost_usd>0`,
      [input.context.logicalRequestId],
    );
    const channelAttempts = await this.options.database.query<{
      attempt_index: number;
      provider: string;
      channel: string | null;
      execution_profile_id: string | null;
      status: string;
      error_category: string | null;
      http_status: number | null;
      latency_ms: number | null;
      started_at: Date;
      completed_at: Date | null;
      actual_cost_usd: string;
      metadata_json: Record<string, unknown>;
    }>(
      `SELECT attempt_index,provider,channel,execution_profile_id,status,error_category,http_status,
              latency_ms,started_at,completed_at,actual_cost_usd,metadata_json
       FROM acu_attempts WHERE logical_request_id=$1 AND attempt_kind='provider'
       ORDER BY attempt_index`,
      [input.context.logicalRequestId],
    );
    const logicalTiming = await this.options.database.query<{ started_at: Date; completed_at: Date | null; status: string }>(
      "SELECT started_at,completed_at,status FROM acu_logical_requests WHERE logical_request_id=$1",
      [input.context.logicalRequestId],
    );
    const logicalRow = logicalTiming.rows[0];
    const endToEndLatencyMs = logicalRow?.completed_at
      ? Math.max(0, logicalRow.completed_at.getTime() - logicalRow.started_at.getTime())
      : channelAttempts.rows.reduce((total, attempt) => total + Number(attempt.latency_ms ?? 0), 0) + (input.context.judgeLatencyMs ?? 0);
    const providerLatencyMs = channelAttempts.rows.reduce((total, attempt) => total + Number(attempt.latency_ms ?? 0), 0);
    const recovered = channelAttempts.rows.some((attempt) => attempt.status === "error")
      && channelAttempts.rows.some((attempt) => attempt.status === "success");
    const savedRoute = input.context.routeDecisionSnapshot;
    const savedCandidates = Array.isArray(savedRoute?.candidate_estimates_json)
      ? savedRoute.candidate_estimates_json.map(record).filter((item): item is JsonObject => Boolean(item))
      : [];
    const savedFormulaInputs = record(savedRoute?.formula_inputs_json);
    const savedDecisionSnapshot = record(savedFormulaInputs?.decisionSnapshot);
    const routeDecisionView = savedRoute ? {
      route_decision_id: savedRoute.route_decision_id,
      phase: input.context.phase,
      curve_version: savedRoute.quality_curve_version,
      price_version: savedRoute.price_version,
      routing_formula_version: savedRoute.routing_model_version,
      difficulty: input.context.routeSummary.difficulty,
      routing_preference: input.context.routeSummary.routingPreference,
      effective_quality_target: savedRoute.effective_quality_target,
      candidate_estimates: savedCandidates,
      pareto_frontier: savedRoute.pareto_frontier_json,
      selected_profile: savedRoute.selected_profile_json,
      route_explanation: savedRoute.route_explanation,
      excluded_profiles: savedFormulaInputs?.excludedProfiles,
      decision_snapshot: savedDecisionSnapshot,
      curves: savedDecisionSnapshot?.curves,
    } : undefined;
    const failedBilledCostUsd = failedAttempts.rows
      .reduce((total, attempt) => total + Number(attempt.actual_cost_usd), 0);
    const failedAttemptCashCostCny = failedAttempts.rows.reduce((total, attempt) => {
      const attemptProfile = this.options.profiles.find((profile) => (
        profile.provider === attempt.provider
        && (profile.channel === attempt.channel || profile.channelId === attempt.channel)
      ));
      const attemptEconomics = attemptProfile?.economics ?? economics;
      return total + (attemptEconomics
        ? providerCostBreakdown(attemptEconomics, Number(attempt.actual_cost_usd)).effectiveCashCostCny
        : Number(attempt.actual_cost_usd));
    }, 0);
    const judgeCashCostCny = Number(input.context.judgeCashCostCny);
    const actualTotalCashCostCny = providerCash.effectiveCashCostCny + judgeCashCostCny + failedAttemptCashCostCny;
    const counterfactualQualityCeilingCostCny = input.context.routeSummary.counterfactualQualityCeilingCostCny;
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
      failedBilledCostUsd: failedBilledCostUsd.toFixed(10),
      finalUserCostUsd: "0.0000000000",
      nominalProviderCostUsd: providerCash.nominalProviderCostUsd.toFixed(10),
      providerBalanceCharge: providerCash.providerBalanceCharge.toFixed(10),
      providerBalanceCurrency: providerCash.providerBalanceCurrency,
      providerCreditCashCostCny: providerCash.providerCreditCashCostCny.toFixed(10),
      effectiveProviderCashCostCny: providerCash.effectiveCashCostCny.toFixed(10),
      judgeCashCostCny: judgeCashCostCny.toFixed(10),
      failedAttemptCashCostCny: failedAttemptCashCostCny.toFixed(10),
      actualTotalCashCostCny: actualTotalCashCostCny.toFixed(10),
      userChargeCny: actualTotalCashCostCny.toFixed(10),
      counterfactualQualityCeilingCostCny: counterfactualQualityCeilingCostCny?.toFixed(10),
      judgeInputTokens: BigInt(input.context.judgeInputTokens),
      judgeOutputTokens: BigInt(input.context.judgeOutputTokens),
      judgeOfficialPaygEquivalentCost: input.context.judgeOfficialPaygEquivalentCost,
      judgeCostCurrency: input.context.judgeCostCurrency,
      judgeCostStatus: input.context.judgeCostStatus,
      judgeCostSource: input.context.judgeCostSource,
      judgeProvider: input.context.judgeProvider,
      judgeModel: input.context.judgeModel,
      costBreakdown: {
        billing_version: "founder-alpha-actual-cash-v2",
        logical_request_status: recovered && logicalRow?.status === "completed" ? "completed_with_recovery" : logicalRow?.status,
        end_to_end_latency_ms: endToEndLatencyMs,
        judge_latency_ms: input.context.judgeLatencyMs ?? 0,
        provider_latency_ms: providerLatencyMs,
        requested_model: input.context.requestedModel,
        routed_by_acu: modeForModel(input.context.requestedModel) !== "explicit",
        session_id: input.context.sessionId,
        task_id: input.context.taskId,
        segment_id: input.context.segmentId,
        judge_trigger: input.context.judgeTrigger,
        judge_calls: input.context.judgeCalls,
        judge_reused: input.context.judgeReused,
        reused_judge_evaluation_id: input.context.reusedJudgeEvaluationId,
        route_refresh_reason: input.context.routeRefreshReason,
        judge_nominal_cost_usd: input.context.judgeCostUsd,
        nominal_provider_cost_usd: providerCash.nominalProviderCostUsd,
        provider_balance_charge: providerCash.providerBalanceCharge,
        provider_balance_currency: providerCash.providerBalanceCurrency,
        provider_credit_cash_cost_cny: providerCash.providerCreditCashCostCny,
        effective_provider_cash_cost_cny: providerCash.effectiveCashCostCny,
        judge_cash_cost_cny: judgeCashCostCny,
        judge_input_tokens: input.context.judgeInputTokens,
        judge_output_tokens: input.context.judgeOutputTokens,
        judge_official_payg_equivalent_cost: input.context.judgeOfficialPaygEquivalentCost,
        judge_cost_currency: input.context.judgeCostCurrency,
        judge_cost_status: input.context.judgeCostStatus,
        judge_cost_source: input.context.judgeCostSource,
        judge_provider: input.context.judgeProvider,
        judge_model: input.context.judgeModel,
        failed_attempt_cash_cost_cny: failedAttemptCashCostCny,
        failed_attempt_nominal_cost_usd: failedBilledCostUsd,
        actual_total_cash_cost_cny: actualTotalCashCostCny,
        user_charge_cny: actualTotalCashCostCny,
        counterfactual_quality_ceiling_cost_cny: counterfactualQualityCeilingCostCny,
        usageSource: input.usageSource,
        reasoning_effort: input.context.reasoningEffort,
        routing_preference: input.context.routeSummary.routingPreference,
        mode: input.context.routeSummary.mode,
        difficulty: input.context.routeSummary.difficulty,
        candidate_count: input.context.routeSummary.candidateCount,
        selected_model: input.context.routeSummary.selectedModel,
        route_reason: input.context.routeSummary.routeReason,
        quality_upper_bound_model: input.context.routeSummary.qualityUpperBoundModel,
        estimated_cost_reduction_vs_quality_upper_bound_cny:
          input.context.routeSummary.estimatedCostReductionVsQualityUpperBoundCny,
        canonical_model: input.context.selectedProfile.modelId,
        provider_model: input.context.selectedProfile.providerModelId ?? input.context.selectedProfile.modelId,
        selected_provider: input.context.routeSummary.selectedProvider ?? input.context.selectedProfile.provider,
        actual_provider: input.context.selectedProfile.provider,
        routing_group: input.context.selectedProfile.routingGroupName,
        channel_id: input.context.selectedProfile.channelId ?? input.context.selectedProfile.channel,
        network_endpoint: input.context.networkEndpoint,
        circuit_state: input.context.selectedProfile.health,
        recent_success_rate: input.context.selectedProfile.recentSuccessRate,
        effective_cost_status: input.context.selectedProfile.effectiveCostStatus,
        billing_multiplier: input.context.selectedProfile.economics?.observedBillingMultiplier,
        provider_selection_reason: input.context.routeSummary.providerSelectionReason,
        model_selection_reason: input.context.routeSummary.routeReason,
        fallback_chain: input.context.routeSummary.providerSelectionReason?.includes("fallback")
          ? input.context.routeSummary.providerSelectionReason
          : undefined,
        phase: input.context.phase,
        judge_explanation: input.context.judgeExplanation,
        route_decision: routeDecisionView,
        channel_attempts: channelAttempts.rows.map((attempt) => ({
          attempt_index: attempt.attempt_index,
          provider: attempt.provider,
          channel: attempt.channel,
          execution_profile_id: attempt.execution_profile_id,
          status: attempt.status,
          error_category: attempt.error_category,
          http_status: attempt.http_status,
          latency_ms: attempt.latency_ms,
          started_at: attempt.started_at,
          completed_at: attempt.completed_at,
          nominal_cost_usd: Number(attempt.actual_cost_usd),
          raw_response_bytes: optionalNumber(attempt.metadata_json?.raw_response_bytes),
          model_visible_output_bytes: optionalNumber(attempt.metadata_json?.model_visible_output_bytes),
          first_model_event_at: stringValue(attempt.metadata_json?.first_model_event_at),
          first_model_event_latency_ms: optionalNumber(attempt.metadata_json?.first_model_event_latency_ms),
          normalized_error_signature: stringValue(attempt.metadata_json?.normalized_error_signature),
          error_class: stringValue(attempt.metadata_json?.errorClass),
          cooldown_until: stringValue(attempt.metadata_json?.cooldown_until),
          cf_ray: stringValue(attempt.metadata_json?.cfRay),
        })),
        client_declared_web_tool: input.context.clientDeclaredWebTool,
        web_intent: input.context.webIntent,
        web_intent_confidence: input.context.webIntentConfidence,
        web_intent_reason: input.context.webIntentReason,
        web_intent_evidence: input.context.webIntentEvidence,
        web_intent_source: input.context.webIntentSource,
        web_actually_invoked: input.context.webActuallyInvoked,
        web_search_event_status: input.context.webSearchEventStatus,
        web_profile_verified: input.context.selectedProfile.webSearchExecutionVerified === true,
        web_fallback_chain: input.context.webFallbackChain,
        attempted_execution_profile_ids: input.context.attemptedExecutionProfileIds,
        attempted_channel_ids: input.context.attemptedChannelIds,
        attempted_providers: input.context.attemptedProviders,
        attempted_network_endpoints: input.context.attemptedNetworkEndpoints,
        web_tool_pruned: input.context.webToolPruned,
        web_tool_prune_reason: input.context.webToolPruneReason,
        ...(() => {
          if (!economics) return {};
          const actual = providerCash;
          const reference = this.options.profiles.find((profile) => (
            profile.provider === "closeai" && profile.modelId === input.context.selectedProfile.modelId
            && profile.economics?.enabled
          ));
          const referenceCost = reference?.economics
            ? providerCostBreakdown(reference.economics, Number(providerCostUsd)).effectiveCashCostCny
            : undefined;
          return {
            nominal_provider_cost_usd: actual.nominalProviderCostUsd,
            provider_balance_charge: actual.providerBalanceCharge,
            provider_balance_currency: actual.providerBalanceCurrency,
            provider_credit_cash_cost_cny: actual.providerCreditCashCostCny,
            effective_cash_cost_cny: actual.effectiveCashCostCny,
            effective_cost_source: actual.effectiveCostSource,
            effective_cost_version: actual.effectiveCostVersion,
            user_charge: actualTotalCashCostCny,
            user_charge_currency: "CNY",
            reference_provider: reference?.provider,
            reference_effective_cash_cost_cny: referenceCost,
            effective_savings_vs_reference_cny: referenceCost === undefined
              ? undefined
              : referenceCost - actual.effectiveCashCostCny,
          };
        })(),
      },
    });
  }

  private async createAdmissionFailureUsageReport(input: {
    logicalRequestId: string;
    identity: TrustedNewApiIdentity;
    envelope: CanonicalEnvelope;
    error: AlphaAdmissionError;
  }): Promise<void> {
    const judgeCostUsd = String(input.error.details.judge_cost_usd ?? "0.0000000000");
    const judgeCashCostCny = String(input.error.details.judge_cash_cost_cny ?? "0.0000000000");
    await new AlphaRepository(this.options.database).createUsageReport({
      usageReportId: alphaId("usage"),
      logicalRequestId: input.logicalRequestId,
      reportIdempotencyKey: sha256(`${input.logicalRequestId}\nadmission-failure-v2`),
      newapiUserId: input.identity.newapiUserId,
      newapiTokenId: input.identity.newapiTokenId,
      newapiLogId: input.identity.newapiLogId,
      actualModel: input.envelope.requestedModel,
      provider: String(input.error.details.judge_provider ?? "judge"),
      channel: "admission",
      judgeCostUsd,
      providerCostUsd: "0.0000000000",
      failedBilledCostUsd: "0.0000000000",
      finalUserCostUsd: "0.0000000000",
      nominalProviderCostUsd: "0.0000000000",
      providerBalanceCharge: "0.0000000000",
      providerBalanceCurrency: "USD-denominated credits",
      providerCreditCashCostCny: "0.0000000000",
      effectiveProviderCashCostCny: "0.0000000000",
      judgeCashCostCny,
      failedAttemptCashCostCny: "0.0000000000",
      actualTotalCashCostCny: judgeCashCostCny,
      userChargeCny: judgeCashCostCny,
      costBreakdown: {
        billing_version: "founder-alpha-actual-cash-v2",
        admission_error_type: input.error.errorType,
        admission_trace_id: input.error.details.admission_trace_id,
        judge_evaluation_id: input.error.details.judge_evaluation_id,
        judge_model: input.error.details.judge_model,
        judge_nominal_cost_usd: judgeCostUsd,
        judge_cash_cost_cny: judgeCashCostCny,
        actual_total_cash_cost_cny: judgeCashCostCny,
        user_charge_cny: judgeCashCostCny,
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
      await this.recordRuntimeHealth(context.selectedProfile, context.protocol, {
        success: false,
        clientCancelled: trace.status === "cancelled",
        errorMessage: trace.error instanceof Error ? trace.error.message : "provider execution failed",
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
    context.webActuallyInvoked = relay.webSearch.actuallyInvoked;
    trace.envelope.webActuallyInvoked = relay.webSearch.actuallyInvoked;
    context.webSearchEventStatus = relay.webSearch.eventStatus;
    const webSucceeded = relay.webSearch.actuallyInvoked
      && relay.webSearch.executionCompleted
      && relay.webSearch.resultVerified;
    const webRequiredFailure = context.webIntent === "required" && !webSucceeded;
    if (relay.webSearch.actuallyInvoked || webRequiredFailure) {
      const previousRate = context.selectedProfile.webSearchRecentSuccessRate ?? 1;
      context.selectedProfile.webSearchRecentSuccessRate = (previousRate * 4 + (webSucceeded ? 1 : 0)) / 5;
      context.selectedProfile.webSearchObservedLatencyMs = relay.webSearch.searchLatencyMs;
      if (webSucceeded) {
        context.selectedProfile.webSearchLastVerifiedAt = new Date().toISOString();
        context.selectedProfile.webSearchFailureReason = undefined;
      } else {
        context.selectedProfile.webSearchFailureReason = relay.webSearch.actuallyInvoked
          ? "web_search_event_incomplete"
          : "web_search_not_invoked";
      }
    }
    const transportSuccess = relay.httpStatus >= 200 && relay.httpStatus < 300 && relay.complete;
    const success = transportSuccess && !webRequiredFailure;
    const status = relay.clientCancelled ? "cancelled" : success ? "success" : "error";
    const errorCategory = success
      ? undefined
      : relay.clientCancelled
        ? "client_cancelled"
        : webRequiredFailure
          ? context.webActuallyInvoked ? "web_search_failed" : "web_search_not_invoked"
          : "provider_error";
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
      actualModel: canonicalActualModel(context.selectedProfile, usage.actualModel),
      providerRequestId,
      errorCategory,
      httpStatus: relay.httpStatus,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      usageSource: usage.usageSource,
      actualCostUsd: transportSuccess ? usage.providerCostUsd : "0.0000000000",
      providerBilled: transportSuccess ? true : undefined,
      visibleOutputBytes: relay.modelVisibleOutputBytes,
      metadata: {
        complete: relay.complete,
        clientCancelled: relay.clientCancelled,
        clientDeclaredWebTool: context.clientDeclaredWebTool,
        webIntent: context.webIntent,
        webActuallyInvoked: context.webActuallyInvoked,
        webSearchEventStatus: context.webSearchEventStatus,
        webSearchExecutionCompleted: relay.webSearch.executionCompleted,
        webSearchResultVerified: relay.webSearch.resultVerified,
        webSearchObservedLatencyMs: relay.webSearch.searchLatencyMs,
        webProfileVerified: context.selectedProfile.webSearchExecutionVerified === true,
        webFallbackChain: context.webFallbackChain,
        webToolPruned: context.webToolPruned,
        webToolPruneReason: context.webToolPruneReason,
        raw_response_bytes: relay.rawResponseBytes,
        model_visible_output_bytes: relay.modelVisibleOutputBytes,
        first_model_event_at: relay.firstModelEventAt,
        first_model_event_latency_ms: relay.firstModelEventLatencyMs,
      },
    });
    const canonicalModel = canonicalActualModel(context.selectedProfile, usage.actualModel);
    await this.recordRuntimeHealth(context.selectedProfile, context.protocol, {
      success: transportSuccess,
      clientCancelled: relay.clientCancelled,
      httpStatus: relay.httpStatus,
      actualModelMismatch: Boolean(usage.actualModel && canonicalModel !== context.selectedProfile.modelId),
      usageTrusted: transportSuccess ? usage.usageSource === "provider_usage" : undefined,
      firstTokenLatencyMs: relay.firstModelEventLatencyMs,
    });
    if (transportSuccess || relay.webSearch.actuallyInvoked || webRequiredFailure) {
      await repository.saveProfileWebHealth({
        executionProfileId: context.selectedProfile.executionProfileId,
        channelId: context.selectedProfile.channelId ?? context.selectedProfile.channel,
        providerId: context.selectedProfile.provider,
        canonicalModelId: context.selectedProfile.modelId,
        protocol: context.protocol,
        usageTrusted: context.selectedProfile.usageTrusted !== false,
        actualModelVerified: !usage.actualModel || canonicalModel === context.selectedProfile.modelId,
        canonicalAdvertisedContextWindow: context.selectedProfile.canonicalAdvertisedContextWindow,
        providerDeclaredContextWindow: context.selectedProfile.providerDeclaredContextWindow,
        observedSuccessfulInputTokens: transportSuccess ? usage.inputTokens : undefined,
        providerHardContextCap: context.selectedProfile.providerHardContextCap,
        contextCapabilityStatus: context.selectedProfile.providerHardContextCap
          ? "provider_capped"
          : transportSuccess ? "observed_floor" : context.selectedProfile.contextCapabilityStatus,
        contextCapabilitySource: transportSuccess
          ? "provider_usage_observed_success"
          : context.selectedProfile.contextCapabilitySource,
        contextLastVerifiedAt: transportSuccess ? new Date() : undefined,
        metadata: {
          webSearchRecentSuccessRate: context.selectedProfile.webSearchRecentSuccessRate,
          webSearchObservedLatencyMs: context.selectedProfile.webSearchObservedLatencyMs,
          webSearchLastVerifiedAt: context.selectedProfile.webSearchLastVerifiedAt,
          webSearchFailureReason: context.selectedProfile.webSearchFailureReason,
        },
      });
    }
    await repository.updateLogicalRequestMetadata(context.logicalRequestId, context.newapiUserId, {
      clientDeclaredWebTool: context.clientDeclaredWebTool,
      webIntent: context.webIntent,
      webActuallyInvoked: context.webActuallyInvoked,
      webSearchEventStatus: context.webSearchEventStatus,
      webProfileVerified: context.selectedProfile.webSearchExecutionVerified === true,
      webFallbackChain: context.webFallbackChain,
      webToolPruned: context.webToolPruned,
      webToolPruneReason: context.webToolPruneReason,
    });
    await repository.completeLogicalRequest({
      logicalRequestId: context.logicalRequestId,
      newapiUserId: context.newapiUserId,
      status: success ? "completed" : status,
      acceptedAttemptId: success ? context.attemptId : undefined,
      responsePayloadId,
      errorCategory,
    });
    if (success) await repository.incrementAcceptedResponses(context.segmentId, context.newapiUserId);
    await this.createFinalUsageReport({
      context,
      actualModel: canonicalActualModel(context.selectedProfile, usage.actualModel),
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      providerCostUsd: transportSuccess ? usage.providerCostUsd : "0.0000000000",
      usageSource: usage.usageSource,
    });
  }
}
