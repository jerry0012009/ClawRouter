import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AcuJudgeResult } from "../src/acu/types.js";
import { AlphaDatabase } from "../src/alpha/database.js";
import { createAlphaGatewayServer } from "../src/alpha/gateway.js";
import type { AlphaJudgeRunner } from "../src/alpha/judge-runner.js";
import { createNativeProviderAdapter } from "../src/alpha/provider.js";
import { AlphaRequestProcessor } from "../src/alpha/processor.js";
import { AlphaRepository } from "../src/alpha/repository.js";
import { evaluateProfiles, type AlphaExecutionProfile } from "../src/alpha/routing.js";
import {
  DEFAULT_ROUTING_UTILITY_POLICY,
  type RoutingUtilityPolicy,
} from "../src/alpha/routing-utility-v2.js";
import { bodySha256, trustedIdentityHeaders } from "../src/alpha/trusted-identity.js";

const databaseUrl = process.env.ACU_PROCESSOR_TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const sharedSecret = "processor-test-secret-not-production";

const judgeResult: AcuJudgeResult = {
  pLow: 0.1,
  pMid: 0.3,
  pMidHigh: 0.5,
  pHigh: 0.1,
  confidence: 0.8,
  difficultyScoreRaw: 60,
  factors: {
    reasoningDepth: 6,
    taskScope: 6,
    constraintDensity: 6,
    toolDependency: 7,
    verificationBurden: 6,
    contextBurden: 5,
  },
  factorComposite: 61,
  difficultyIndex: 60.8,
  difficultyMethodVersion: "acu-difficulty-index-v1",
  difficultyScore: 60.8,
  signals: ["test_fixture"],
  explanation: "fixture",
  webIntent: "not_required",
  webIntentConfidence: 0.97,
  webIntentReason: "The fixture represents a local coding task.",
  webIntentEvidence: ["local_or_code_context"],
};

function signedHeaders(
  body: Buffer,
  requestId: string,
  userId = "user-auto",
  client: "codex" | "claude-code" = "codex",
  allowedProfileIds: string[] = [],
  routingPreference: "economy" | "balanced" | "quality" = "balanced",
  utilityPolicy?: RoutingUtilityPolicy,
): Record<string, string> {
  const identity = {
    newapiUserId: userId,
    newapiTokenId: `token-${userId}`,
    newapiLogId: `log-${requestId}`,
    requestId,
    routingPolicy: "all_routing_eligible" as const,
    allowedModelIds: [],
    allowedProfileIds,
    routingPolicyVersion: `acu-user-policy-v2-${createHash("sha256").update(JSON.stringify(allowedProfileIds)).digest("hex").slice(0, 16)}`,
    routingPreference,
    ...(utilityPolicy ? {
      qualityBias: utilityPolicy.qualityBias,
      supplyStrategy: utilityPolicy.supplyStrategy,
      supplyWeights: utilityPolicy.supplyWeights,
      acuHighBiasOffset: utilityPolicy.acuHighBiasOffset,
      modelCostLogScale: utilityPolicy.modelCostLogScale,
      profileCostLogScale: utilityPolicy.profileCostLogScale,
      profileSpeedLogScale: utilityPolicy.profileSpeedLogScale,
      latencyPolicy: utilityPolicy.latency,
      reliabilityPolicy: utilityPolicy.reliability,
      workPhaseBiasOffsets: utilityPolicy.workPhaseBiasOffsets,
      routingUtilityVersion: utilityPolicy.routingUtilityVersion,
      formulaMode: utilityPolicy.formulaMode,
      identityVersion: "v3" as const,
    } : {}),
    timestamp: new Date().toISOString(),
    bodySha256: bodySha256(body),
  };
  return {
    ...trustedIdentityHeaders(identity, sharedSecret),
    "content-type": "application/json",
    "user-agent": client === "codex" ? "codex_exec/0.145.0 (test)" : "claude-cli/2.1.0 (test)",
    ...(client === "claude-code" ? { "x-claude-code-version": "2.1.0" } : {}),
    "thread-id": `thread-${userId}`,
  };
}

run("Alpha PostgreSQL request processor", () => {
  let database: AlphaDatabase;
  let upstream: Server;
  let gateway: Server;
  let gatewayPort: number;
  let judgeCalls = 0;
  let probeWakeCount = 0;
  let cancelledJudgeStarted: (() => void) | undefined;
  let releaseCancelledJudge: (() => void) | undefined;
  let providerHeadersWaitStarted: (() => void) | undefined;
  let primaryProfile: AlphaExecutionProfile;
  let processor: AlphaRequestProcessor;
  let recoveryProfile: AlphaExecutionProfile;
  let crossProviderRecoveryProfile: AlphaExecutionProfile;
  let alternateModelProfile: AlphaExecutionProfile;
  const upstreamBodies: Array<Record<string, unknown>> = [];
  const upstreamCaseCalls = new Map<string, number>();

  beforeAll(async () => {
    database = new AlphaDatabase({ connectionString: databaseUrl!, maxConnections: 4 });
    const down = await readFile(new URL("../migrations/acu/0001_alpha_p0.down.sql", import.meta.url), "utf8");
    await database.query(down);
    await database.migrate();

    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      upstreamBodies.push(requestBody);
      const testCase = typeof requestBody.test_case === "string" ? requestBody.test_case : "";
      const testCaseCall = (upstreamCaseCalls.get(testCase) ?? 0) + 1;
      upstreamCaseCalls.set(testCase, testCaseCall);
      const responseFailed = requestBody.test_response_failed === true
        && (requestBody.test_response_failed_once !== true || testCaseCall === 1);
      if (requestBody.test_wait_headers === true) {
        providerHeadersWaitStarted?.();
        await new Promise<void>((resolve) => request.once("close", () => resolve()));
        return;
      }
      if (requestBody.test_empty_stream_once === true && testCaseCall === 1) {
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("x-request-id", `provider-${testCase}-empty-1`);
        response.end();
        return;
      }
      if (requestBody.test_context_overflow_once === true && testCaseCall === 1) {
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("x-request-id", `provider-${testCase}-context-1`);
        response.end([
          "event: response.created",
          `data: ${JSON.stringify({ type: "response.created", response: { id: `response-${testCase}-1`, model: requestBody.model } })}`,
          "",
          "event: error",
          `data: ${JSON.stringify({ type: "error", error: {
            type: "invalid_request_error", code: "context_length_exceeded",
            message: "Input exceeds the context window",
          } })}`,
          "",
          "event: response.failed",
          `data: ${JSON.stringify({ type: "response.failed", response: {
            id: `response-${testCase}-1`, model: requestBody.model, status: "failed",
            error: { type: "invalid_request_error", code: "context_length_exceeded",
              message: "Input exceeds the context window" },
          } })}`,
          "",
          "",
        ].join("\n"));
        return;
      }
      const failuresBeforeSuccess = Number(requestBody.test_failures_before_success ?? 0);
      if (testCase && testCaseCall <= failuresBeforeSuccess) {
        response.statusCode = Number(requestBody.test_failure_status ?? 503);
        response.setHeader("content-type", "application/json");
        response.setHeader("x-request-id", `provider-${testCase}-failed-${testCaseCall}`);
        response.end(JSON.stringify({
          error: testCase === "web-retry-once"
            ? { type: "invalid_request_error", message: "web search tool unsupported" }
            : testCase.startsWith("reasoning-")
              ? { type: "invalid_request_error", message: "invalid reasoning effort" }
            : { type: "overloaded_error", message: "controlled test overload" },
        }));
        return;
      }
      if (request.url?.startsWith("/v1/messages")) {
        const body = [
          "event: message_start",
          `data: ${JSON.stringify({
            type: "message_start",
            message: {
              id: `message-${upstreamBodies.length}`,
              model: requestBody.model,
              usage: { input_tokens: 80, cache_read_input_tokens: 10, output_tokens: 0 },
            },
          })}`,
          "",
          "event: content_block_start",
          `data: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "checking", signature: "signature-test" },
          })}`,
          "",
          "event: content_block_start",
          `data: ${JSON.stringify({
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tool-test", name: "Read", input: { file_path: "README.md" } },
          })}`,
          "",
          "event: message_delta",
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } })}`,
          "",
          "event: message_stop",
          `data: ${JSON.stringify({ type: "message_stop" })}`,
          "",
          "",
        ].join("\n");
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("x-request-id", `provider-${upstreamBodies.length}`);
        response.end(body);
        return;
      }
      const responseId = `response-${upstreamBodies.length}`;
      const body = [
        "event: response.created",
        `data: ${JSON.stringify({ type: "response.created", response: { id: responseId, model: requestBody.model } })}`,
        "",
        ...(requestBody.test_web_success === true ? [
          "event: response.web_search_call.in_progress",
          `data: ${JSON.stringify({ type: "response.web_search_call.in_progress" })}`,
          "",
          "event: response.web_search_call.searching",
          `data: ${JSON.stringify({ type: "response.web_search_call.searching" })}`,
          "",
          "event: response.web_search_call.completed",
          `data: ${JSON.stringify({
            type: "response.web_search_call.completed",
            item: { type: "web_search_call", status: "completed" },
          })}`,
          "",
        ] : []),
        ...(requestBody.test_terminal_only === true ? [] : [
          "event: response.output_text.delta",
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}`,
          "",
        ]),
        responseFailed
          ? "event: response.failed"
          : requestBody.test_incomplete_reason ? "event: response.incomplete" : "event: response.completed",
        `data: ${JSON.stringify(responseFailed ? {
          type: "response.failed",
          response: { id: responseId, model: requestBody.model,
            error: { type: "overloaded_error", code: "server_error", message: "controlled generation failure" } },
        } : requestBody.test_incomplete_reason ? {
          type: "response.incomplete",
          response: { id: responseId, model: requestBody.model,
            incomplete_details: { reason: requestBody.test_incomplete_reason } },
        } : {
          type: "response.completed",
          response: {
            id: responseId, model: requestBody.model,
            output: requestBody.test_web_success === true
              ? [{ type: "web_search_call", status: "completed" }, { type: "message", content: [] }]
              : [{ type: "message", content: [] }],
            usage: {
              input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10,
              output_tokens_details: { reasoning_tokens: 2 },
            },
          },
        })}`,
        "",
        "",
      ].join("\n");
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("x-request-id", `provider-${upstreamBodies.length}`);
      response.end(body);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("No upstream port");

    const profile: AlphaExecutionProfile = {
      executionProfileId: "test:gpt-5.4-mini:responses",
      modelId: "gpt-5.4-mini",
      provider: "test-provider",
      channel: "test-channel",
      protocols: ["responses", "messages"],
      toolCallSupport: true,
      supportedToolTypes: ["function", "custom", "local_tool"],
      thinkingSupport: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoningControlMode: "standard_effort",
      contextWindow: 1_000_000,
      providerHardContextCap: 400_000,
      health: "healthy",
      enabled: true,
      administratorAllowed: true,
      usageTrusted: true,
      webToolDeclarationAccepted: true,
      webSearchExecutionVerified: true,
      webSearchStreamingVerified: true,
      webSearchResultVerified: true,
    };
    const adapter = createNativeProviderAdapter({
      provider: profile.provider,
      channel: profile.channel,
      baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      apiKey: "test-provider-key",
      authMode: "bearer",
    });
    recoveryProfile = {
      ...profile,
      executionProfileId: "test:gpt-5.4-mini:recovery",
      channel: "test-recovery-channel",
      provider: "lucen",
    };
    profile.provider = "lucen";
    crossProviderRecoveryProfile = {
      ...profile,
      executionProfileId: "test:gpt-5.4-mini:cross-provider-recovery",
      channel: "test-cross-provider-channel",
      provider: "blackai",
    };
    primaryProfile = profile;
    alternateModelProfile = {
      ...profile,
      executionProfileId: "test:gpt-5.6-luna:alternate",
      modelId: "gpt-5.6-luna",
      channel: "test-alternate-model-channel",
      provider: "blackai",
      enabled: false,
    };
    const judgeRunner: AlphaJudgeRunner = {
      async run(input) {
        judgeCalls += 1;
        const visible = JSON.stringify(input.messages);
        if (visible.includes("CLIENT_CANCEL_DURING_JUDGE")) {
          cancelledJudgeStarted?.();
          await new Promise<void>((resolve, reject) => {
            releaseCancelledJudge = resolve;
            input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
          });
        }
        const required = visible.includes("再查一下最新官方文档") || visible.includes("Use web search for the current UTC date");
        return {
          judge: {
            ...judgeResult,
            webIntent: required ? "required" : "not_required",
            webIntentConfidence: 0.97,
            webIntentReason: required
              ? "The current user input explicitly requires current Web information."
              : "The current Routing Segment is a local coding task.",
            webIntentEvidence: required ? ["explicit_web_action"] : ["local_or_code_context"],
          },
          status: "live",
          resultSource: "upstream_live",
          model: "test-judge",
          provider: "test",
          promptVersion: "test-prompt-v1",
          policyVersion: "test-policy-v1",
          contextHash: input.contextHash,
          contextTokenEstimate: 100,
          contextTruncated: false,
          rawRequestBytes: Buffer.byteLength(input.rawNative.rawRequest, "utf8"),
          rawRequestTokenEstimate: 100,
          judgeContextLimit: 250_000,
          judgeContextSource: "raw_native_request_v1",
          promptTokens: 10,
          completionTokens: 10,
          latencyMs: 1,
          costUsd: "0.0010000000",
          costCny: "0.0072000000",
          officialPaygEquivalentCostCny: "0.0000000000",
          costCurrency: "CNY",
          costStatus: "verified",
          costSource: "test_verified_cash_cost",
          attempts: [],
          entropy: 0.5,
          webIntentDecision: {
            intent: required ? "required" : "not_required",
            confidence: 0.97,
            reason: required
              ? "The current user input explicitly requires current Web information."
              : "The current Routing Segment is a local coding task.",
            evidence: required ? ["explicit_web_action"] : ["local_or_code_context"],
            source: "judge",
          },
        };
      },
    };
    processor = new AlphaRequestProcessor({
      database,
      profiles: [profile, recoveryProfile, crossProviderRecoveryProfile, alternateModelProfile],
      adapters: new Map([
        [profile.executionProfileId, adapter],
        [recoveryProfile.executionProfileId, adapter],
        [crossProviderRecoveryProfile.executionProfileId, adapter],
        [alternateModelProfile.executionProfileId, adapter],
      ]),
      judgeRunner,
      wakeProbe: () => { probeWakeCount += 1; },
    });
    gateway = createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      resolveExecution: processor.resolveExecution.bind(processor),
      onTrace: processor.handleTrace.bind(processor),
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const gatewayAddress = gateway.address();
    if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("No gateway port");
    gatewayPort = gatewayAddress.port;
  });

  afterAll(async () => {
    gateway.close();
    upstream.close();
    await Promise.all([once(gateway, "close"), once(upstream, "close")]);
    const down = await readFile(new URL("../migrations/acu/0001_alpha_p0.down.sql", import.meta.url), "utf8");
    await database.query(down);
    await database.close();
  });

  async function send(bodyValue: Record<string, unknown>, requestId: string, userId = "user-auto"): Promise<string> {
    return sendProtocol("responses", bodyValue, requestId, userId, "codex");
  }

  it("uses only exact Profile evidence for freshness, success rate, and latency", async () => {
    const repository = new AlphaRepository(database);
    const channelId = primaryProfile.channelId ?? primaryProfile.channel;
    const now = new Date();
    await repository.saveChannelHealth({
      channelId,
      providerId: primaryProfile.provider,
      snapshot: {
        state: "healthy", consecutiveFailures: 0, recentSuccessRate: 0.1,
        lastAttemptAt: now, lastSuccessAt: now, totalLatencyMs: 9_999,
      },
    });
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id=$1",
      [primaryProfile.executionProfileId],
    );
    primaryProfile.requiresFreshProbe = true;
    const invokeEffectiveProfiles = () => (processor as unknown as {
      effectiveProfiles(allowed: string[], wake: boolean): Promise<{ profiles: AlphaExecutionProfile[] }>;
    }).effectiveProfiles([], false);
    const channelOnly = (await invokeEffectiveProfiles()).profiles
      .find((profile) => profile.executionProfileId === primaryProfile.executionProfileId)!;
    expect(channelOnly.runtimeHealth?.probeState).toBe("stale");
    expect(channelOnly.recentSuccessRate).toBe(1);
    expect(channelOnly.observedLatencyMs).toBeUndefined();

    await repository.saveProfileHealth({
      executionProfileId: primaryProfile.executionProfileId,
      channelId,
      providerId: primaryProfile.provider,
      canonicalModelId: primaryProfile.modelId,
      protocol: "responses",
      snapshot: {
        state: "healthy", consecutiveFailures: 0, recentSuccessRate: 0.9,
        lastAttemptAt: now, lastSuccessAt: now, totalLatencyMs: 100,
      },
      usageTrusted: true,
      actualModelVerified: true,
    });
    const exact = (await invokeEffectiveProfiles()).profiles
      .find((profile) => profile.executionProfileId === primaryProfile.executionProfileId)!;
    expect(exact.runtimeHealth?.probeState).toBe("fresh");
    expect(exact.recentSuccessRate).toBe(0.9);
    expect(exact.observedLatencyMs).toBe(100);

    primaryProfile.requiresFreshProbe = false;
    await database.query("DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    await database.query("DELETE FROM acu_channel_health WHERE channel_id=$1", [channelId]);
  });

  it("requires a fresh exact success before dynamically enabling a freshness-gated Profile", async () => {
    const repository = new AlphaRepository(database);
    const channelId = primaryProfile.channelId ?? primaryProfile.channel;
    const originalAutoRouteEnabled = primaryProfile.autoRouteEnabled;
    const originalRequiresFreshProbe = primaryProfile.requiresFreshProbe;
    primaryProfile.autoRouteEnabled = false;
    primaryProfile.requiresFreshProbe = true;
    await database.query("DELETE FROM acu_profile_probe_queue WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    await database.query("DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    const staleSuccess = new Date(Date.now() - 121 * 60_000);
    await repository.saveProfileHealth({
      executionProfileId: primaryProfile.executionProfileId,
      channelId,
      providerId: primaryProfile.provider,
      canonicalModelId: primaryProfile.modelId,
      protocol: "responses",
      snapshot: {
        state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1,
        lastAttemptAt: staleSuccess, lastSuccessAt: staleSuccess,
      },
      usageTrusted: true,
      actualModelVerified: true,
    });
    const invokeEffectiveProfiles = (wake: boolean) => (processor as unknown as {
      effectiveProfiles(
        allowed: string[], wake: boolean, demandedModelId?: string,
      ): Promise<{ profiles: AlphaExecutionProfile[] }>;
    }).effectiveProfiles([], wake, primaryProfile.modelId);

    const wakesBefore = probeWakeCount;
    const stale = (await invokeEffectiveProfiles(true)).profiles
      .find((profile) => profile.executionProfileId === primaryProfile.executionProfileId)!;
    expect(stale.autoRouteEnabled).toBe(false);
    expect(evaluateProfiles({
      judge: judgeResult,
      judgeCost: 0,
      inputTokens: 10,
      expectedOutputTokens: 10,
      effectiveQualityTarget: 0.5,
      profiles: [stale],
      requirements: { protocol: "responses", requireTools: false, requireThinking: false, webIntent: "not_required" },
    })[0]).toMatchObject({ eligible: false, reasons: expect.arrayContaining(["auto_route_disabled"]) });
    expect((await database.query(
      "SELECT 1 FROM acu_profile_probe_queue WHERE execution_profile_id=$1", [primaryProfile.executionProfileId],
    )).rowCount).toBe(1);
    expect(probeWakeCount).toBe(wakesBefore + 1);

    const freshSuccess = new Date();
    await repository.saveProfileHealth({
      executionProfileId: primaryProfile.executionProfileId,
      channelId,
      providerId: primaryProfile.provider,
      canonicalModelId: primaryProfile.modelId,
      protocol: "responses",
      snapshot: {
        state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1,
        lastAttemptAt: freshSuccess, lastSuccessAt: freshSuccess,
      },
      usageTrusted: true,
      actualModelVerified: true,
    });
    const fresh = (await invokeEffectiveProfiles(false)).profiles
      .find((profile) => profile.executionProfileId === primaryProfile.executionProfileId)!;
    expect(fresh.autoRouteEnabled).toBe(true);
    expect(fresh.runtimeHealth?.effectiveState).toBe("eligible");

    primaryProfile.autoRouteEnabled = originalAutoRouteEnabled;
    primaryProfile.requiresFreshProbe = originalRequiresFreshProbe;
    await database.query("DELETE FROM acu_profile_probe_queue WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    await database.query("DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
  });

  it("does not change health, enqueue recovery, or wake probes for client cancellation", async () => {
    const channelId = primaryProfile.channelId ?? primaryProfile.channel;
    await database.query("DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    await database.query("DELETE FROM acu_channel_health WHERE channel_id=$1", [channelId]);
    await database.query("DELETE FROM acu_profile_probe_queue WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    const wakesBefore = probeWakeCount;
    await (processor as unknown as {
      recordRuntimeHealth(
        profile: AlphaExecutionProfile,
        protocol: "responses",
        outcome: { success: boolean; clientCancelled: boolean },
      ): Promise<unknown>;
    }).recordRuntimeHealth(primaryProfile, "responses", { success: false, clientCancelled: true });
    expect((await database.query(
      "SELECT 1 FROM acu_provider_model_profile_health WHERE execution_profile_id=$1", [primaryProfile.executionProfileId],
    )).rowCount).toBe(0);
    expect((await database.query("SELECT 1 FROM acu_channel_health WHERE channel_id=$1", [channelId])).rowCount).toBe(0);
    expect((await database.query(
      "SELECT 1 FROM acu_profile_probe_queue WHERE execution_profile_id=$1", [primaryProfile.executionProfileId],
    )).rowCount).toBe(0);
    expect(probeWakeCount).toBe(wakesBefore);
  });

  async function sendProtocol(
    protocol: "responses" | "messages",
    bodyValue: Record<string, unknown>,
    requestId: string,
    userId: string,
    client: "codex" | "claude-code",
  ): Promise<string> {
    const body = Buffer.from(JSON.stringify(bodyValue));
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/${protocol}`, {
      method: "POST",
      headers: signedHeaders(body, requestId, userId, client),
      body,
    });
    const errorBody = response.status === 200 ? "" : await response.clone().text();
    expect(response.status, errorBody).toBe(200);
    return response.text();
  }

  async function sendWithPolicy(
    bodyValue: Record<string, unknown>,
    requestId: string,
    userId: string,
    utilityPolicy: RoutingUtilityPolicy,
    allowedProfileIds: string[] = [],
  ): Promise<string> {
    const body = Buffer.from(JSON.stringify(bodyValue));
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: signedHeaders(body, requestId, userId, "codex", allowedProfileIds, "balanced", utilityPolicy),
      body,
    });
    const errorBody = response.status === 200 ? "" : await response.clone().text();
    expect(response.status, errorBody).toBe(200);
    return response.text();
  }

  it.each([
    ["inspection", "Read", -4],
    ["implementation", "apply_patch", 0],
    ["verification", "test", 0],
    ["planning", "update_plan", 4],
    ["general", "unknown_tool", 0],
  ])("persists detected %s Work Phase through Usage decision_summary", async (expectedPhase, toolName, expectedOffset) => {
    const userId = `user-work-phase-${expectedPhase}`;
    const callId = `call-${expectedPhase}`;
    await send({
      model: "acu-auto",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue the current coding step" }] },
        { type: "function_call", call_id: callId, name: toolName, arguments: toolName === "update_plan" ? "{\"plan\":[{\"status\":\"in_progress\"}]}" : "{}" },
        { type: "function_call_output", call_id: callId, output: "ok" },
      ],
      stream: true,
    }, `work-phase-${expectedPhase}`, userId);
    const report = await database.query<{ phase: string; work_phase: string; work_phase_offset: string }>(
      `SELECT cost_breakdown_json->>'phase' phase,
              cost_breakdown_json->'decision_summary'->>'work_phase' work_phase,
              cost_breakdown_json->'decision_summary'->>'work_phase_quality_target_offset' work_phase_offset
       FROM acu_usage_reports WHERE newapi_user_id=$1`,
      [userId],
    );
    expect(report.rows[0]).toEqual({
      phase: expectedPhase === "planning" ? "planning" : "execution",
      work_phase: expectedPhase,
      work_phase_offset: String(expectedOffset),
    });
  });

  it("settles a request cancelled during Judge and immediately accepts a new request", async () => {
    const userId = "user-client-cancel";
    const cancelledBody = Buffer.from(JSON.stringify({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "CLIENT_CANCEL_DURING_JUDGE" }] }],
      stream: true,
    }));
    let markJudgeStarted: (() => void) | undefined;
    const judgeStarted = new Promise<void>((resolve) => { markJudgeStarted = resolve; });
    cancelledJudgeStarted = markJudgeStarted;
    const controller = new AbortController();
    const cancelledRequest = fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: signedHeaders(cancelledBody, "client-cancel-1", userId),
      body: cancelledBody,
      signal: controller.signal,
    });
    await judgeStarted;
    controller.abort(new Error("fixture client cancellation"));
    await expect(cancelledRequest).rejects.toThrow();

    const nextResponse = await send({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "normal request after cancellation" }] }],
      stream: true,
    }, "client-cancel-2", userId);
    expect(nextResponse).not.toContain("request_in_progress");

    await new Promise((resolve) => setTimeout(resolve, 100));
    const beforeRelease = await database.query<{ status: string; lease_active: boolean }>(
      `SELECT status,processing_lease_expires_at IS NOT NULL lease_active
       FROM acu_logical_requests WHERE newapi_log_id='log-client-cancel-1'`,
    );
    releaseCancelledJudge?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancelledJudgeStarted = undefined;
    releaseCancelledJudge = undefined;

    const result = await database.query<{
      status: string;
      lease_active: boolean;
      provider_attempts: string;
      judge_attempts: string;
      backup_attempts: string;
      usage_reports: string;
      user_charge_cny: string | null;
      next_status: string;
    }>(
      `SELECT r.status,r.processing_lease_expires_at IS NOT NULL lease_active,
       (SELECT count(*) FROM acu_attempts a WHERE a.logical_request_id=r.logical_request_id) provider_attempts,
       (SELECT count(*) FROM acu_judge_attempts j WHERE j.logical_request_id=r.logical_request_id) judge_attempts,
       (SELECT count(*) FROM acu_judge_attempts j WHERE j.logical_request_id=r.logical_request_id AND j.attempt_role='backup') backup_attempts,
       (SELECT count(*) FROM acu_usage_reports u WHERE u.logical_request_id=r.logical_request_id) usage_reports,
       (SELECT user_charge_cny::text FROM acu_usage_reports u WHERE u.logical_request_id=r.logical_request_id) user_charge_cny,
       (SELECT status FROM acu_logical_requests n WHERE n.newapi_log_id='log-client-cancel-2') next_status
       FROM acu_logical_requests r WHERE r.newapi_log_id='log-client-cancel-1'`,
    );
    expect(beforeRelease.rows[0]).toEqual({ status: "cancelled", lease_active: false });
    expect(result.rows[0]).toEqual({
      status: "cancelled",
      lease_active: false,
      provider_attempts: "0",
      judge_attempts: "0",
      backup_attempts: "0",
      usage_reports: "0",
      user_charge_cny: null,
      next_status: "completed",
    });
    judgeCalls = 0;
    upstreamBodies.length = 0;
    upstreamCaseCalls.clear();
  });

  it("finalizes a headers-waiting Provider attempt as client cancellation without health or probe changes", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel')");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery')",
    );
    await database.query(
      "DELETE FROM acu_profile_probe_queue WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery')",
    );
    const body = Buffer.from(JSON.stringify({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Wait for Provider headers" }] }],
      stream: true,
      test_case: "provider-header-client-cancel",
      test_wait_headers: true,
    }));
    const controller = new AbortController();
    const providerStarted = new Promise<void>((resolve) => { providerHeadersWaitStarted = resolve; });
    const pending = fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: signedHeaders(body, "provider-header-client-cancel", "user-provider-client-cancel"),
      body,
      signal: controller.signal,
    });
    await providerStarted;
    controller.abort(new Error("fixture Provider attempt cancellation"));
    await expect(pending).rejects.toThrow();
    providerHeadersWaitStarted = undefined;
    for (let index = 0; index < 50; index += 1) {
      const completed = await database.query<{ status: string }>(
        "SELECT status FROM acu_logical_requests WHERE newapi_user_id=$1",
        ["user-provider-client-cancel"],
      );
      if (completed.rows[0]?.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const state = await database.query<{
      attempt_count: string; attempt_status: string; attempt_error: string; recovery: string;
      logical_status: string; health_count: string; probe_count: string;
    }>(
      `SELECT
       (SELECT count(*) FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) attempt_count,
       (SELECT status FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) attempt_status,
       (SELECT error_category FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) attempt_error,
       (SELECT metadata_json->>'recoveryDecisionReason' FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) recovery,
       l.status logical_status,
       (SELECT count(*) FROM acu_provider_model_profile_health h WHERE h.execution_profile_id IN
         ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery')) health_count,
       (SELECT count(*) FROM acu_profile_probe_queue q WHERE q.execution_profile_id IN
         ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery')) probe_count
       FROM acu_logical_requests l WHERE l.newapi_user_id=$1`,
      ["user-provider-client-cancel"],
    );
    expect(state.rows[0]).toEqual({
      attempt_count: "1", attempt_status: "cancelled", attempt_error: "client_cancelled",
      recovery: "client_disconnected", logical_status: "cancelled", health_count: "0", probe_count: "0",
    });
    judgeCalls = 0;
    upstreamBodies.length = 0;
    upstreamCaseCalls.clear();
  });

  it("Judges a new auto Task, rewrites only model, and persists the full trace", async () => {
    const history = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Fix the bug" }] }];
    await send({ model: "acu-auto", input: history, stream: true }, "request-1");
    expect(judgeCalls).toBe(1);
    expect(upstreamBodies[0].model).toBe("gpt-5.4-mini");
    const counts = await database.query<{ sessions: string; tasks: string; segments: string; judges: string; routes: string; requests: string; attempts: string; payloads: string; usage: string }>(
      `SELECT
       (SELECT count(*) FROM acu_sessions WHERE newapi_user_id='user-auto') sessions,
       (SELECT count(*) FROM acu_tasks WHERE newapi_user_id='user-auto') tasks,
       (SELECT count(*) FROM acu_segments WHERE newapi_user_id='user-auto') segments,
       (SELECT count(*) FROM acu_judge_evaluations WHERE newapi_user_id='user-auto') judges,
       (SELECT count(*) FROM acu_route_decisions WHERE newapi_user_id='user-auto') routes,
       (SELECT count(*) FROM acu_logical_requests WHERE newapi_user_id='user-auto') requests,
       (SELECT count(*) FROM acu_attempts a JOIN acu_logical_requests r USING (logical_request_id)
        WHERE r.newapi_user_id='user-auto') attempts,
       (SELECT count(*) FROM acu_payloads WHERE newapi_user_id='user-auto') payloads,
       (SELECT count(*) FROM acu_usage_reports WHERE newapi_user_id='user-auto') usage`,
    );
    expect(counts.rows[0]).toMatchObject({
      sessions: "1",
      tasks: "1",
      segments: "1",
      judges: "1",
      routes: "1",
      requests: "1",
      attempts: "1",
      payloads: "6",
      usage: "1",
    });
    const timing = await database.query<{
      first_model_event_latency_ms: string | null;
      latency_ms: number | null;
      total_latency_ms: string | null;
    }>(
      `SELECT a.metadata_json->>'first_model_event_latency_ms' first_model_event_latency_ms,
       a.latency_ms,a.metadata_json->>'total_latency_ms' total_latency_ms
       FROM acu_attempts a JOIN acu_logical_requests r USING (logical_request_id)
       WHERE r.newapi_user_id='user-auto'`,
    );
    expect(Number(timing.rows[0]?.first_model_event_latency_ms)).toBeGreaterThanOrEqual(0);
    expect(timing.rows[0]?.latency_ms).toBeGreaterThanOrEqual(0);
    expect(Number(timing.rows[0]?.total_latency_ms)).toBe(timing.rows[0]?.latency_ms);
    const routeEvidence = await database.query<{
      configured_profiles: string;
      protocol_profiles: string;
      initial_models: string;
      filtered_profiles: string;
      filtered_models: string;
      pareto_models: string;
      excluded_profiles: unknown;
      routing_preference: string;
      routing_model_version: string;
    }>(
      `SELECT
       formula_inputs_json->>'configuredProfileCount' configured_profiles,
       formula_inputs_json->>'protocolProfileCount' protocol_profiles,
       formula_inputs_json->>'initialCandidateModelCount' initial_models,
       formula_inputs_json->>'hardFilteredProfileCount' filtered_profiles,
       formula_inputs_json->>'hardFilteredCandidateModelCount' filtered_models,
       formula_inputs_json->>'paretoFrontierCandidateCount' pareto_models,
       formula_inputs_json->'excludedProfiles' excluded_profiles,
       formula_inputs_json->>'routingPreference' routing_preference,
       routing_model_version
       FROM acu_route_decisions WHERE newapi_user_id='user-auto' LIMIT 1`,
    );
    expect(routeEvidence.rows[0]).toEqual({
      configured_profiles: "4",
      protocol_profiles: "4",
      initial_models: "2",
      filtered_profiles: "3",
      filtered_models: "1",
      pareto_models: "1",
      excluded_profiles: [{
        executionProfileId: "test:gpt-5.6-luna:alternate",
        reasons: ["disabled", "health_disabled"],
      }],
      routing_preference: "balanced",
      routing_model_version: "acu-routing-model-v0.5",
    });
    const payloadKinds = await database.query<{ payload_kind: string }>(
      "SELECT payload_kind FROM acu_payloads WHERE newapi_user_id='user-auto' ORDER BY created_at,payload_kind",
    );
    expect(payloadKinds.rows.map((row) => row.payload_kind).sort()).toEqual([
      "client_request",
      "client_stream",
      "judge_request",
      "judge_response",
      "provider_request",
      "provider_stream",
    ]);
  });

  it("reuses the Segment for a normal Tool loop without another Judge", async () => {
    const history = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the bug" }] },
      { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call-1", output: "workspace" },
    ];
    await send({ model: "acu-auto", input: history, stream: true }, "request-2");
    expect(judgeCalls).toBe(1);
    const counts = await database.query<{ segments: string; judges: string; segment_web_intent: string; segment_web_source: string }>(
      `SELECT (SELECT count(*) FROM acu_segments WHERE newapi_user_id='user-auto') segments,
       (SELECT count(*) FROM acu_judge_evaluations WHERE newapi_user_id='user-auto') judges,
       (SELECT metadata_json->>'webIntent' FROM acu_segments WHERE newapi_user_id='user-auto' AND status='active') segment_web_intent,
       (SELECT metadata_json->>'webIntentSource' FROM acu_segments WHERE newapi_user_id='user-auto' AND status='active') segment_web_source`,
    );
    expect(counts.rows[0]).toEqual({
      segments: "1",
      judges: "1",
      segment_web_intent: "not_required",
      segment_web_source: "judge",
    });
  });

  it("creates a new Segment for '继续' and treats a new trusted request identity as a new execution", async () => {
    const history = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the bug" }] },
      { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call-1", output: "workspace" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] },
    ];
    const firstResponse = await send({ model: "acu-auto", input: history, stream: true }, "request-3");
    expect(judgeCalls).toBe(2);
    const counts = await database.query<{ segments: string; active: string; judges: string }>(
      `SELECT (SELECT count(*) FROM acu_segments WHERE newapi_user_id='user-auto') segments,
       (SELECT count(*) FROM acu_segments WHERE newapi_user_id='user-auto' AND status='active') active,
       (SELECT count(*) FROM acu_judge_evaluations WHERE newapi_user_id='user-auto') judges`,
    );
    expect(counts.rows[0]).toEqual({ segments: "2", active: "1", judges: "2" });

    const replay = await send({ model: "acu-auto", input: history, stream: true }, "request-3-replayed");
    expect(replay).not.toBe(firstResponse);
    expect(replay).toContain('"type":"response.completed"');
    expect(judgeCalls).toBe(2);
    const replayCounts = await database.query<{ attempts: string; requests: string; usage: string }>(
      `SELECT (SELECT count(*) FROM acu_attempts a JOIN acu_logical_requests r USING (logical_request_id)
        WHERE r.newapi_user_id='user-auto') attempts,
       (SELECT count(*) FROM acu_logical_requests WHERE newapi_user_id='user-auto') requests,
       (SELECT count(*) FROM acu_usage_reports WHERE newapi_user_id='user-auto') usage`,
    );
    expect(replayCounts.rows[0]).toEqual({ attempts: "4", requests: "4", usage: "4" });
  });

  it("executes an explicit model with Judge=0 and no model substitution", async () => {
    await send({
      model: "gpt-5.4-mini",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Explicit request" }] }],
      stream: true,
    }, "explicit-1", "user-explicit");
    expect(judgeCalls).toBe(2);
    expect(upstreamBodies.at(-1)?.model).toBe("gpt-5.4-mini");
    const result = await database.query<{
      judge_count: string; route_mode: string; candidate_count: string;
      difficulty_index: null; selected_model: string; selected_channel: string;
      model_reason: string; channel_reason: string;
    }>(
      `SELECT
       (SELECT count(*) FROM acu_judge_evaluations WHERE newapi_user_id='user-explicit') judge_count,
       mode route_mode,
       formula_inputs_json->'decisionSnapshot'->>'candidateCount' candidate_count,
       formula_inputs_json->'decisionSnapshot'->'difficultyIndex' difficulty_index,
       formula_inputs_json->'decisionSnapshot'->>'selectedModel' selected_model,
       formula_inputs_json->'decisionSnapshot'->>'selectedChannel' selected_channel,
       formula_inputs_json->'decisionSnapshot'->>'modelSelectionReason' model_reason,
       formula_inputs_json->'decisionSnapshot'->>'channelSelectionReason' channel_reason
       FROM acu_route_decisions WHERE newapi_user_id='user-explicit' LIMIT 1`,
    );
    expect(result.rows[0]).toMatchObject({
      judge_count: "0", route_mode: "explicit", candidate_count: "1", difficulty_index: null,
      selected_model: "gpt-5.4-mini", selected_channel: "test-channel",
    });
    expect(result.rows[0].model_reason).toContain("User-selected explicit model");
    expect(result.rows[0].channel_reason).toContain("User-selected explicit model");
  });

  it("uses active V2 Profile rank for an explicit model and same-model fallback", async () => {
    const userId = "user-explicit-v2-fallback";
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel')");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery')",
    );
    const beforeJudge = judgeCalls;
    const policy: RoutingUtilityPolicy = {
      ...DEFAULT_ROUTING_UTILITY_POLICY,
      formulaMode: "active",
      supplyStrategy: "lowest_cost",
      supplyWeights: { cost: 100, speed: 0, reliability: 0 },
      routingUtilityVersion: "acu-routing-utility-v1-1111111111111111",
    };
    const primaryBillingPrice = primaryProfile.billingPrice;
    const recoveryBillingPrice = recoveryProfile.billingPrice;
    primaryProfile.billingPrice = { inputPricePerMillion: 1, outputPricePerMillion: 1 };
    recoveryProfile.billingPrice = { inputPricePerMillion: 2, outputPricePerMillion: 2 };
    try {
      await sendWithPolicy({
        model: "gpt-5.4-mini",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Explicit V2 fallback" }] }],
        stream: true,
        test_case: "explicit-v2-fallback",
        test_failures_before_success: 1,
        test_failure_status: 502,
      }, "explicit-v2-fallback", userId, policy, [
        primaryProfile.executionProfileId,
        recoveryProfile.executionProfileId,
      ]);
    } finally {
      primaryProfile.billingPrice = primaryBillingPrice;
      recoveryProfile.billingPrice = recoveryBillingPrice;
    }
    expect(judgeCalls).toBe(beforeJudge);

    const result = await database.query<{
      requested_models: string[];
      actual_models: string[];
      profiles: string[];
      attempts: string;
      usage_reports: string;
      formula_mode: string;
      profile_formula_version: string;
    }>(
      `SELECT
       array_agg(DISTINCT r.requested_model) requested_models,
       array_agg(a.actual_model ORDER BY a.attempt_index) actual_models,
       array_agg(a.execution_profile_id ORDER BY a.attempt_index) profiles,
       count(DISTINCT a.attempt_id)::text attempts,
       count(DISTINCT u.usage_report_id)::text usage_reports,
       (SELECT formula_inputs_json->>'formulaMode' FROM acu_route_decisions
        WHERE newapi_user_id=$1 ORDER BY created_at DESC LIMIT 1) formula_mode,
       (SELECT formula_inputs_json->>'profileFormulaVersion' FROM acu_route_decisions
        WHERE newapi_user_id=$1 ORDER BY created_at DESC LIMIT 1) profile_formula_version
       FROM acu_logical_requests r
       JOIN acu_attempts a USING (logical_request_id)
       LEFT JOIN acu_usage_reports u USING (logical_request_id)
       WHERE r.newapi_user_id=$1
       GROUP BY r.logical_request_id`,
      [userId],
    );
    expect(result.rows[0]).toMatchObject({
      requested_models: ["gpt-5.4-mini"],
      actual_models: ["gpt-5.4-mini", "gpt-5.4-mini"],
      profiles: [primaryProfile.executionProfileId, recoveryProfile.executionProfileId],
      attempts: "2",
      usage_reports: "1",
      formula_mode: "active",
      profile_formula_version: "acu-profile-utility-v2.1",
    });
    const decision = await database.query<{ inputs: Record<string, unknown> }>(
      `SELECT formula_inputs_json inputs FROM acu_route_decisions
       WHERE newapi_user_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    const utilities = decision.rows[0]?.inputs.profileUtilitiesV2 as Array<{ executionProfileId: string; rank: number }>;
    expect([...utilities].sort((left, right) => left.rank - right.rank).map((utility) => utility.executionProfileId)).toEqual([
      primaryProfile.executionProfileId,
      recoveryProfile.executionProfileId,
    ]);
  });

  it("creates a new judged Segment when the user later explicitly requests current official docs", async () => {
    const userId = "user-web-rejudge";
    const initial = [{ type: "message", role: "user", content: [{ type: "input_text", text: "修改 currentUser 函数" }] }];
    const beforeJudge = judgeCalls;
    const instructions = `<permissions instructions>\n\`sandbox_mode\` is \`workspace-write\`\n</permissions instructions>\n<environment_context><cwd>${process.cwd()}</cwd></environment_context>`;
    await send({ model: "acu-auto", instructions, input: initial, stream: true }, "web-rejudge-1", userId);
    await send({
      model: "acu-auto",
      instructions,
      input: [
        ...initial,
        { type: "function_call", call_id: "call-local", name: "exec_command", arguments: "{\"cmd\":\"check.sh\"}" },
        { type: "function_call_output", call_id: "call-local", output: "ok" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "再查一下最新官方文档" }] },
      ],
      tools: [{ type: "web_search" }],
      stream: true,
      test_web_success: true,
    }, "web-rejudge-2", userId);
    expect(judgeCalls).toBe(beforeJudge + 2);
    const result = await database.query<{
      intents: string[];
      sources: string[];
      judge_intents: string[];
      route_intents: string[];
    }>(
      `SELECT
       (SELECT array_agg(metadata_json->>'webIntent' ORDER BY created_at) FROM acu_segments WHERE newapi_user_id=$1) intents,
       (SELECT array_agg(metadata_json->>'webIntentSource' ORDER BY created_at) FROM acu_segments WHERE newapi_user_id=$1) sources,
       (SELECT array_agg(web_intent ORDER BY created_at) FROM acu_judge_evaluations WHERE newapi_user_id=$1) judge_intents,
       (SELECT array_agg(formula_inputs_json->>'webIntent' ORDER BY created_at) FROM acu_route_decisions WHERE newapi_user_id=$1) route_intents`,
      [userId],
    );
    expect(result.rows[0]).toEqual({
      intents: ["not_required", "required"],
      sources: ["judge", "judge"],
      judge_intents: ["not_required", "required"],
      route_intents: ["not_required", "required"],
    });
  });

  it("keeps optional hosted Web non-invocation successful and capability-neutral", async () => {
    const userId = "user-optional-web";
    const initial = [{
      type: "message", role: "user",
      content: [{ type: "input_text", text: "Use web search to inspect this website" }],
    }];
    const beforeJudge = judgeCalls;
    await send({ model: "acu-auto", input: initial, tools: [{ type: "web_search" }], stream: true }, "optional-web-1", userId);
    await send({
      model: "acu-auto",
      input: [
        ...initial,
        { type: "function_call", call_id: "curl-site", name: "exec_command", arguments: "{\"cmd\":\"curl example.test\"}" },
        { type: "function_call_output", call_id: "curl-site", output: "HTTP 200" },
      ],
      tools: [{ type: "web_search" }],
      stream: true,
    }, "optional-web-2", userId);
    expect(judgeCalls).toBe(beforeJudge + 1);
    const result = await database.query<{ logical_statuses: string[]; attempt_statuses: string[]; web_statuses: Array<string | null> }>(
      `SELECT
       (SELECT array_agg(status ORDER BY started_at) FROM acu_logical_requests WHERE newapi_user_id=$1) logical_statuses,
       (SELECT array_agg(status ORDER BY started_at) FROM acu_attempts
        WHERE logical_request_id IN (SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id=$1)) attempt_statuses,
       (SELECT array_agg(metadata_json->>'webTransportStatus' ORDER BY started_at) FROM acu_attempts
        WHERE logical_request_id IN (SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id=$1)) web_statuses`,
      [userId],
    );
    expect(result.rows[0].logical_statuses).toEqual(["completed", "completed"]);
    expect(result.rows[0].attempt_statuses).toEqual(["success", "success"]);
    expect(result.rows[0].web_statuses).not.toContain("incompatible");
  });

  it("refreshes an acu-auto route with the cached Judge when its reused model loses a required capability", async () => {
    const userId = "user-web-capability-refresh";
    const initial = [{
      type: "message", role: "user",
      content: [{ type: "input_text", text: "Use web search for the current UTC date" }],
    }];
    const request = {
      model: "acu-auto",
      input: initial,
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
      stream: true,
      test_web_success: true,
    };
    const beforeJudge = judgeCalls;
    await send(request, "web-capability-refresh-1", userId);
    primaryProfile.webTransportStatus = "incompatible";
    recoveryProfile.webTransportStatus = "incompatible";
    crossProviderRecoveryProfile.webTransportStatus = "incompatible";
    alternateModelProfile.enabled = true;
    await database.query(
      `UPDATE acu_provider_model_profile_health
       SET metadata_json=jsonb_set(metadata_json,'{webTransportStatus}','"incompatible"'::jsonb,true)
       WHERE canonical_model_id='gpt-5.4-mini'`,
    );
    try {
      await send({
        ...request,
        input: [
          ...initial,
          { type: "function_call", call_id: "web-step", name: "exec_command", arguments: "{}" },
          { type: "function_call_output", call_id: "web-step", output: "continue" },
        ],
      }, "web-capability-refresh-2", userId);
    } finally {
      primaryProfile.webTransportStatus = undefined;
      recoveryProfile.webTransportStatus = undefined;
      crossProviderRecoveryProfile.webTransportStatus = undefined;
      alternateModelProfile.enabled = false;
    }
    expect(judgeCalls).toBe(beforeJudge + 1);
    const result = await database.query<{ models: string[]; judge_evaluations: string[]; refresh_reason: string }>(
      `SELECT
       (SELECT array_agg(a.actual_model ORDER BY l.started_at) FROM acu_logical_requests l
        JOIN acu_attempts a ON a.logical_request_id=l.logical_request_id WHERE l.newapi_user_id=$1) models,
       (SELECT array_agg(DISTINCT s.judge_evaluation_id) FROM acu_logical_requests l
        JOIN acu_segments s ON s.segment_id=l.segment_id WHERE l.newapi_user_id=$1) judge_evaluations,
       (SELECT metadata_json->>'routeRefreshReason' FROM acu_admission_traces
        WHERE newapi_user_id=$1 ORDER BY updated_at DESC LIMIT 1) refresh_reason`,
      [userId],
    );
    expect(result.rows[0].models).toEqual(["gpt-5.4-mini", "gpt-5.6-luna"]);
    expect(result.rows[0].judge_evaluations).toHaveLength(1);
    expect(result.rows[0].refresh_reason).toBe("profile_capability_changed");
  });

  it("marks an old Segment without Web fields as legacy_heuristic without another Judge", async () => {
    const userId = "user-web-legacy";
    const initial = [{ type: "message", role: "user", content: [{ type: "input_text", text: "更新 latestVersion 变量" }] }];
    const beforeJudge = judgeCalls;
    await send({ model: "acu-auto", input: initial, stream: true }, "web-legacy-1", userId);
    await database.query(
      `UPDATE acu_segments SET metadata_json=metadata_json
       - 'webIntent' - 'webIntentConfidence' - 'webIntentReason' - 'webIntentEvidence' - 'webIntentSource'
       WHERE newapi_user_id=$1`,
      [userId],
    );
    await send({
      model: "acu-auto",
      input: [
        ...initial,
        { type: "function_call", call_id: "call-legacy", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
        { type: "function_call_output", call_id: "call-legacy", output: "workspace" },
      ],
      stream: true,
    }, "web-legacy-2", userId);
    expect(judgeCalls).toBe(beforeJudge + 1);
    const result = await database.query<{ intent: string; source: string }>(
      `SELECT metadata_json->>'webIntent' intent,metadata_json->>'webIntentSource' source
       FROM acu_segments WHERE newapi_user_id=$1`,
      [userId],
    );
    expect(result.rows[0]).toEqual({ intent: "not_required", source: "legacy_heuristic" });
  });

  it("persists the first failure and Judges only the second identical failure without progress", async () => {
    const userId = "user-failure";
    const initial = [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fix the failing tests" }],
    }];
    await send({ model: "acu-auto", input: initial, stream: true }, "failure-1", userId);
    const afterTaskStart = judgeCalls;
    const firstFailure = [
      ...initial,
      { type: "function_call", call_id: "test-1", name: "test", arguments: "{}" },
      { type: "function_call_output", call_id: "test-1", output: "tests failed: expected 2 received 1", is_error: true },
    ];
    await send({ model: "acu-auto", input: firstFailure, stream: true }, "failure-2", userId);
    expect(judgeCalls).toBe(afterTaskStart);
    const secondFailure = [
      ...firstFailure,
      { type: "function_call", call_id: "test-2", name: "test", arguments: "{}" },
      { type: "function_call_output", call_id: "test-2", output: "tests failed: expected 2 received 1", is_error: true },
    ];
    await send({ model: "acu-auto", input: secondFailure, stream: true }, "failure-3", userId);
    expect(judgeCalls).toBe(afterTaskStart + 1);
    const recovery = await database.query<{ creation_reason: string; phase: string }>(
      `SELECT creation_reason,phase FROM acu_segments
       WHERE newapi_user_id=$1 AND status='active'`,
      [userId],
    );
    expect(recovery.rows[0]).toEqual({ creation_reason: "repeated_failure", phase: "recovery" });
    const usage = await database.query<{ work_phase: string; work_phase_offset: string }>(
      `SELECT cost_breakdown_json->'decision_summary'->>'work_phase' work_phase,
              cost_breakdown_json->'decision_summary'->>'work_phase_quality_target_offset' work_phase_offset
       FROM acu_usage_reports WHERE newapi_user_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(usage.rows[0]).toEqual({ work_phase: "recovery", work_phase_offset: "6" });
  });

  it("reuses PlanStarted until the accepted-response limit and Judges PlanFinished", async () => {
    const userId = "user-planning-state";
    const beforeJudge = judgeCalls;
    const history: Array<Record<string, unknown>> = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Plan and implement the fixture" }] },
      { type: "function_call", call_id: "plan-start", name: "update_plan", arguments: "{\"plan\":[{\"status\":\"in_progress\"}]}" },
    ];
    await send({ model: "acu-auto", input: history, stream: true }, "planning-start", userId);
    expect(judgeCalls).toBe(beforeJudge + 1);

    for (let index = 0; index < 10; index += 1) {
      history.push(
        { type: "function_call", call_id: `planning-read-${index}`, name: "Read", arguments: "{}" },
        { type: "function_call_output", call_id: `planning-read-${index}`, output: `fixture-${index}` },
      );
      await send({ model: "acu-auto", input: history, stream: true }, `planning-step-${index}`, userId);
      expect(judgeCalls, `planning step ${index}`).toBe(beforeJudge + (index < 7 ? 1 : 2));
    }

    history.push(
      { type: "function_call", call_id: "plan-complete", name: "update_plan", arguments: "{\"plan\":[{\"status\":\"completed\"}]}" },
      { type: "function_call_output", call_id: "plan-complete", output: "updated" },
      { type: "function_call", call_id: "plan-execute", name: "apply_patch", arguments: "{}" },
    );
    await send({ model: "acu-auto", input: history, stream: true }, "planning-finished", userId);
    expect(judgeCalls).toBe(beforeJudge + 3);

    const state = await database.query<{
      segments: string; judges: string; judge_ids: string[]; overrides: number[]; reasons: string[];
    }>(
      `SELECT
       count(*)::text segments,
       count(DISTINCT judge_evaluation_id)::text judges,
       array_agg(judge_evaluation_id ORDER BY created_at) judge_ids,
       array_agg(temporary_phase_override ORDER BY created_at) overrides,
       array_agg(creation_reason ORDER BY created_at) reasons
       FROM acu_segments WHERE newapi_user_id=$1`,
      [userId],
    );
    expect(state.rows[0]).toMatchObject({
      segments: "3",
      judges: "3",
      overrides: [0, 0, 0],
      reasons: ["task_start", "accepted_response_limit", "plan_finished"],
    });
    expect(new Set(state.rows[0].judge_ids).size).toBe(3);
  });

  it("isolates a 502 to the exact Profile and keeps same-model recovery independent", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel')");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery')",
    );
    const beforeJudge = judgeCalls;
    const body = {
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Retry safely" }] }],
      stream: true,
      test_case: "retry-once",
      test_failures_before_success: 1,
      test_failure_status: 502,
    };
    await send(body, "retry-1", "user-retry");
    expect(judgeCalls).toBe(beforeJudge + 1);
    const attempts = await database.query<{
      attempt_index: number;
      retry_owner: string;
      status: string;
      http_status: number;
      channel: string;
    }>(
      `SELECT attempt_index,retry_owner,status,http_status,channel FROM acu_attempts
       WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id='user-retry')
       ORDER BY attempt_index`,
    );
    expect(attempts.rows).toEqual([
      { attempt_index: 1, retry_owner: "acu", status: "error", http_status: 502, channel: "test-channel" },
      { attempt_index: 2, retry_owner: "acu", status: "success", http_status: 200, channel: "test-recovery-channel" },
    ]);
    const requestAndModels = await database.query<{
      logical_requests: string;
      attempt_models: string[];
      final_model: string;
    }>(
      `SELECT
       (SELECT count(*) FROM acu_logical_requests WHERE newapi_user_id='user-retry') logical_requests,
       (SELECT array_agg(actual_model ORDER BY attempt_index) FROM acu_attempts
        WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id='user-retry')) attempt_models,
       (SELECT actual_model FROM acu_usage_reports WHERE newapi_user_id='user-retry') final_model`,
    );
    expect(requestAndModels.rows[0]).toEqual({
      logical_requests: "1",
      attempt_models: ["gpt-5.4-mini", "gpt-5.4-mini"],
      final_model: "gpt-5.4-mini",
    });
    const health = await database.query<{
      execution_profile_id: string;
      circuit_state: string;
      error_class: string;
      cooldown_active: boolean;
    }>(
      `SELECT execution_profile_id,circuit_state,error_class,coalesce(cooldown_until>now(),false) cooldown_active
       FROM acu_provider_model_profile_health
       WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery')
       ORDER BY execution_profile_id`,
    );
    expect(health.rows).toEqual([
      { execution_profile_id: "test:gpt-5.4-mini:recovery", circuit_state: "healthy", error_class: "none", cooldown_active: false },
      { execution_profile_id: "test:gpt-5.4-mini:responses", circuit_state: "open", error_class: "provider_5xx", cooldown_active: true },
    ]);
    const channelHealth = await database.query(
      "SELECT 1 FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel')",
    );
    expect(channelHealth.rowCount).toBe(0);
    const queued = await database.query<{ execution_profile_id: string }>(
      "SELECT execution_profile_id FROM acu_profile_probe_queue WHERE execution_profile_id='test:gpt-5.4-mini:responses'",
    );
    expect(queued.rows).toEqual([{ execution_profile_id: "test:gpt-5.4-mini:responses" }]);
    const events = await database.query<{ event_type: string }>(
      `SELECT event_type FROM acu_events WHERE task_id=(SELECT task_id FROM acu_tasks WHERE newapi_user_id='user-retry')`,
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      "human_message",
      "provider_error",
      "retry_attempt",
    ]));
    const reports = await database.query<{ newapi_token_id: string; newapi_log_id: string }>(
      "SELECT newapi_token_id,newapi_log_id FROM acu_usage_reports WHERE newapi_user_id='user-retry'",
    );
    expect(reports.rows).toEqual([{ newapi_token_id: "token-user-retry", newapi_log_id: "log-retry-1" }]);
    const retriedBodies = upstreamBodies.filter((item) => item.test_case === "retry-once");
    expect(retriedBodies).toHaveLength(2);
    expect(retriedBodies[0]).toEqual(retriedBodies[1]);
    await database.query(
      "DELETE FROM acu_profile_probe_queue WHERE execution_profile_id='test:gpt-5.4-mini:responses'",
    );
    const wakesBeforeDemand = probeWakeCount;

    const segmentBeforeRefresh = await database.query<{ route_decision_id: string; judge_evaluation_id: string }>(
      `SELECT route_decision_id,judge_evaluation_id FROM acu_segments
       WHERE newapi_user_id='user-retry' AND status='active'`,
    );
    const callsBeforeRefresh = judgeCalls;
    await send({
      model: "acu-auto",
      input: [
        ...(body.input as Array<Record<string, unknown>>),
        { type: "function_call", call_id: "cooldown-read", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "cooldown-read", output: "continued without a new goal" },
      ],
      stream: true,
    }, "retry-cooldown-continuation", "user-retry");
    expect(judgeCalls).toBe(callsBeforeRefresh);
    const refreshed = await database.query<{
      route_decision_id: string; judge_evaluation_id: string; metadata_json: Record<string, unknown>;
    }>(
      `SELECT s.route_decision_id,s.judge_evaluation_id,a.metadata_json
       FROM acu_segments s JOIN acu_admission_traces a ON a.segment_id=s.segment_id
       WHERE s.newapi_user_id='user-retry' ORDER BY a.created_at DESC LIMIT 1`,
    );
    expect(refreshed.rows[0].judge_evaluation_id).toBe(segmentBeforeRefresh.rows[0].judge_evaluation_id);
    expect(refreshed.rows[0].route_decision_id).not.toBe(segmentBeforeRefresh.rows[0].route_decision_id);
    expect(refreshed.rows[0].metadata_json).toMatchObject({
      trigger: "reuse_route",
      judgeCalls: 0,
      judgeReused: true,
      routeRefreshReason: "profile_health",
    });
    expect((await database.query(
      "SELECT 1 FROM acu_profile_probe_queue WHERE execution_profile_id='test:gpt-5.4-mini:responses'",
    )).rowCount).toBe(1);
    expect(probeWakeCount).toBeGreaterThan(wakesBeforeDemand);
  });

  it("records an HTTP 200 empty stream in Profile health and immediately advances to the next Profile", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel','test-cross-provider-channel')");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery','test:gpt-5.4-mini:cross-provider-recovery')",
    );
    await send({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Recover from an empty stream" }] }],
      stream: true,
      test_case: "empty-stream-retry",
      test_empty_stream_once: true,
    }, "empty-stream-retry", "user-empty-stream");
    const attempts = await database.query<{
      attempt_index: number; execution_profile_id: string; http_status: number; status: string;
      provider_request_id: string; metadata_json: Record<string, unknown>;
    }>(
      `SELECT attempt_index,execution_profile_id,http_status,status,provider_request_id,metadata_json
       FROM acu_attempts WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id=$1)
       ORDER BY attempt_index`,
      ["user-empty-stream"],
    );
    expect(attempts.rows).toHaveLength(2);
    expect(attempts.rows[0]).toMatchObject({
      attempt_index: 1, execution_profile_id: primaryProfile.executionProfileId, http_status: 200, status: "error",
      provider_request_id: "provider-empty-stream-retry-empty-1",
      metadata_json: {
        errorCode: "stream_ended_before_model_event", errorClass: "provider_empty_stream",
        raw_response_bytes: 0, model_visible_output_bytes: 0, healthScope: "profile",
        recoveryDecisionReason: "executed", nextExecutionProfileId: recoveryProfile.executionProfileId,
      },
    });
    expect(attempts.rows[1]).toMatchObject({
      attempt_index: 2, execution_profile_id: recoveryProfile.executionProfileId, http_status: 200, status: "success",
    });
    const health = await database.query<{ consecutive_failures: number; cooldown_active: boolean }>(
      `SELECT consecutive_failures,coalesce(cooldown_until>now(),false) cooldown_active
       FROM acu_provider_model_profile_health WHERE execution_profile_id=$1`,
      [primaryProfile.executionProfileId],
    );
    expect(health.rows).toEqual([{ consecutive_failures: 1, cooldown_active: true }]);
    expect((await database.query(
      "SELECT 1 FROM acu_profile_probe_queue WHERE execution_profile_id=$1",
      [primaryProfile.executionProfileId],
    )).rowCount).toBe(1);
  });

  it("relays max_output_tokens without retrying or changing Profile health", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id='test-channel'");
    await database.query("DELETE FROM acu_profile_probe_queue WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    await database.query("DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    await send({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Generate until the token limit" }] }],
      stream: true,
      test_case: "generation-truncated",
      test_incomplete_reason: "max_output_tokens",
    }, "generation-truncated", "user-generation-truncated");
    const attempts = await database.query<{ status: string; metadata_json: Record<string, unknown> }>(
      `SELECT status,metadata_json FROM acu_attempts
       WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id=$1)`,
      ["user-generation-truncated"],
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]).toMatchObject({ status: "success", metadata_json: {
      terminalKind: "incomplete", incompleteReason: "max_output_tokens", generationTruncated: true,
    } });
    expect((await database.query(
      "SELECT 1 FROM acu_provider_model_profile_health WHERE execution_profile_id=$1",
      [primaryProfile.executionProfileId],
    )).rowCount).toBe(0);
  });

  it("delivers another incomplete terminal without accepting it or changing Profile health", async () => {
    await database.query("DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    await database.query("DELETE FROM acu_profile_probe_queue WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    const testCase = "generation-incomplete-other";
    const body = Buffer.from(JSON.stringify({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Stop for a content filter" }] }],
      stream: true,
      test_case: testCase,
      test_incomplete_reason: "fixture_other_reason",
    }));
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST", headers: signedHeaders(body, testCase, "user-generation-incomplete-other"), body,
    });
    const responseBody = await response.text();
    expect(responseBody).toContain('"type":"response.output_text.delta"');
    expect(responseBody).toContain('"type":"response.incomplete"');
    expect(responseBody).toContain('"reason":"fixture_other_reason"');
    const state = await database.query<{
      attempts: string; attempt_status: string; logical_status: string; accepted_attempt_id: string | null;
      accepted_responses: number; terminal: string; reason: string; incomplete: boolean; truncated: boolean;
      health_count: string; probe_count: string;
    }>(
      `SELECT
       (SELECT count(*) FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) attempts,
       (SELECT status FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) attempt_status,
       l.status logical_status,l.accepted_attempt_id,
       (SELECT accepted_responses_since_judge FROM acu_segments s WHERE s.segment_id=l.segment_id) accepted_responses,
       (SELECT metadata_json->>'terminalKind' FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) terminal,
       (SELECT metadata_json->>'incompleteReason' FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) reason,
       (SELECT (metadata_json->>'generationIncomplete')::boolean FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) incomplete,
       (SELECT (metadata_json->>'generationTruncated')::boolean FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) truncated,
       (SELECT count(*) FROM acu_provider_model_profile_health h WHERE h.execution_profile_id=$2) health_count,
       (SELECT count(*) FROM acu_profile_probe_queue q WHERE q.execution_profile_id=$2) probe_count
       FROM acu_logical_requests l WHERE l.newapi_user_id=$1`,
      ["user-generation-incomplete-other", primaryProfile.executionProfileId],
    );
    expect(state.rows[0]).toEqual({
      attempts: "1", attempt_status: "error", logical_status: "failed", accepted_attempt_id: null,
      accepted_responses: 0, terminal: "incomplete", reason: "fixture_other_reason",
      incomplete: true, truncated: false, health_count: "0", probe_count: "0",
    });
  });

  it("immediately delivers terminal-only incomplete without retrying or changing health", async () => {
    await database.query("DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    await database.query("DELETE FROM acu_profile_probe_queue WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    const testCase = "generation-incomplete-terminal-only";
    const started = Date.now();
    const responseBody = await send({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Terminal-only incomplete" }] }],
      stream: true,
      test_case: testCase,
      test_terminal_only: true,
      test_incomplete_reason: "fixture_other_reason",
    }, testCase, "user-generation-incomplete-terminal-only");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(responseBody).toContain('"type":"response.incomplete"');
    const state = await database.query<{
      attempts: string; attempt_status: string; terminal: string; reason: string;
      incomplete: boolean; health_count: string; probe_count: string;
    }>(
      `SELECT
       (SELECT count(*) FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) attempts,
       (SELECT status FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) attempt_status,
       (SELECT metadata_json->>'terminalKind' FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) terminal,
       (SELECT metadata_json->>'incompleteReason' FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) reason,
       (SELECT (metadata_json->>'generationIncomplete')::boolean FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) incomplete,
       (SELECT count(*) FROM acu_provider_model_profile_health h WHERE h.execution_profile_id=$2) health_count,
       (SELECT count(*) FROM acu_profile_probe_queue q WHERE q.execution_profile_id=$2) probe_count
       FROM acu_logical_requests l WHERE l.newapi_user_id=$1`,
      ["user-generation-incomplete-terminal-only", primaryProfile.executionProfileId],
    );
    expect(state.rows[0]).toEqual({
      attempts: "1", attempt_status: "error", terminal: "incomplete", reason: "fixture_other_reason",
      incomplete: true, health_count: "0", probe_count: "0",
    });
  });

  it("records response.failed after visible output as a failed logical request without recovery", async () => {
    await database.query("DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id=$1", [primaryProfile.executionProfileId]);
    const acceptedBefore = await database.query<{ count: number }>(
      "SELECT accepted_responses_since_judge count FROM acu_segments WHERE newapi_user_id=$1 AND status='active'",
      ["user-generation-failed-visible"],
    );
    await send({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Fail after output" }] }],
      stream: true,
      test_case: "generation-failed-visible",
      test_response_failed: true,
    }, "generation-failed-visible", "user-generation-failed-visible");
    const state = await database.query<{
      attempts: string; attempt_status: string; terminal: string; logical_status: string;
      accepted_attempt_id: string | null; accepted_responses: number;
    }>(
      `SELECT
       (SELECT count(*) FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) attempts,
       (SELECT status FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) attempt_status,
       (SELECT metadata_json->>'terminalKind' FROM acu_attempts a WHERE a.logical_request_id=l.logical_request_id) terminal,
       l.status logical_status,l.accepted_attempt_id,
       (SELECT accepted_responses_since_judge FROM acu_segments s WHERE s.segment_id=l.segment_id) accepted_responses
       FROM acu_logical_requests l WHERE l.newapi_user_id=$1`,
      ["user-generation-failed-visible"],
    );
    expect(acceptedBefore.rows).toHaveLength(0);
    expect(state.rows[0]).toEqual({
      attempts: "1", attempt_status: "error", terminal: "failed", logical_status: "failed",
      accepted_attempt_id: null, accepted_responses: 0,
    });
    const health = await database.query<{ error_class: string }>(
      "SELECT error_class FROM acu_provider_model_profile_health WHERE execution_profile_id=$1",
      [primaryProfile.executionProfileId],
    );
    expect(health.rows).toEqual([]);
  });

  it("immediately recovers from terminal-only response.failed without empty-stream classification", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel')");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery')",
    );
    await send({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Recover terminal failure" }] }],
      stream: true,
      test_case: "generation-failed-terminal-only",
      test_response_failed: true,
      test_response_failed_once: true,
      test_terminal_only: true,
    }, "generation-failed-terminal-only", "user-generation-failed-terminal-only");
    const attempts = await database.query<{ attempt_index: number; status: string; error_class: string | null }>(
      `SELECT attempt_index,status,metadata_json->>'errorClass' error_class FROM acu_attempts
       WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id=$1)
       ORDER BY attempt_index`,
      ["user-generation-failed-terminal-only"],
    );
    expect(attempts.rows).toEqual([
      { attempt_index: 1, status: "error", error_class: "other_provider_error" },
      { attempt_index: 2, status: "success", error_class: null },
    ]);
  });

  it("keeps the canonical model when an auto Effort is rejected and retries another Profile", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel','test-cross-provider-channel')");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery','test:gpt-5.4-mini:cross-provider-recovery')",
    );
    const testCase = "reasoning-profile-retry";
    await send({
      model: "acu-auto",
      reasoning: { effort: "high" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Retry the same model" }] }],
      stream: true,
      test_case: testCase,
      test_failures_before_success: 1,
      test_failure_status: 400,
    }, testCase, "user-reasoning-profile");
    const attempts = await database.query<{
      execution_profile_id: string; actual_model: string; error_category: string | null;
    }>(
      `SELECT execution_profile_id,actual_model,error_category FROM acu_attempts
       WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id=$1)
       ORDER BY attempt_index`,
      ["user-reasoning-profile"],
    );
    expect(attempts.rows).toHaveLength(2);
    expect(new Set(attempts.rows.map((row) => row.actual_model))).toEqual(new Set(["gpt-5.4-mini"]));
    expect(attempts.rows[0]).toMatchObject({ error_category: "reasoning_transport_error" });
    expect(attempts.rows[1]?.execution_profile_id).not.toBe(attempts.rows[0]?.execution_profile_id);
    const bodies = upstreamBodies.filter((body) => body.test_case === testCase);
    expect(bodies.map((body) => (body.reasoning as { effort?: string })?.effort)).toEqual(["high", "high"]);
  });

  it("falls back from Luna Max to the client Effort when no other Luna Profile is allowed", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id='test-alternate-model-channel'");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id='test:gpt-5.6-luna:alternate'",
    );
    const originalDifficulty = judgeResult.difficultyIndex;
    const originalScore = judgeResult.difficultyScore;
    alternateModelProfile.enabled = true;
    judgeResult.difficultyIndex = 99;
    judgeResult.difficultyScore = 99;
    const testCase = "reasoning-client-effort-retry";
    const body = Buffer.from(JSON.stringify({
      model: "acu-auto",
      reasoning: { effort: "high", summary: "auto" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Use Luna Max, then preserve my minimum" }] }],
      stream: true,
      test_case: testCase,
      test_failures_before_success: 1,
      test_failure_status: 400,
    }));
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
        method: "POST",
        headers: signedHeaders(body, testCase, "user-reasoning-client-fallback", "codex",
          [alternateModelProfile.executionProfileId], "quality"),
        body,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      await response.arrayBuffer();
      const bodies = upstreamBodies.filter((item) => item.test_case === testCase);
      expect(bodies.map((item) => item.reasoning)).toEqual([
        { effort: "max", summary: "auto" },
        { effort: "high", summary: "auto" },
      ]);
      const attempts = await database.query<{ actual_model: string; metadata_json: Record<string, unknown> }>(
        `SELECT actual_model,metadata_json FROM acu_attempts
         WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id=$1)
         ORDER BY attempt_index`,
        ["user-reasoning-client-fallback"],
      );
      expect(attempts.rows).toHaveLength(2);
      expect(attempts.rows.map((row) => row.actual_model)).toEqual(["gpt-5.6-luna", "gpt-5.6-luna"]);
      expect(attempts.rows[0]?.metadata_json).toMatchObject({ clientRequestedReasoningEffort: "high",
        presetReasoningEffort: "max", targetCanonicalReasoningEffort: "max", resolvedReasoningEffort: "max",
        wireReasoningEffort: "max", mappingStatus: "exact" });
      expect(attempts.rows[1]?.metadata_json).toMatchObject({ clientRequestedReasoningEffort: "high",
        presetReasoningEffort: "max", targetCanonicalReasoningEffort: "max", resolvedReasoningEffort: "high",
        wireReasoningEffort: "high", mappingStatus: "provider_fallback_to_client_effort" });
      const route = await database.query<{ formula_inputs_json: Record<string, unknown> }>(
        "SELECT formula_inputs_json FROM acu_route_decisions WHERE newapi_user_id=$1 ORDER BY created_at DESC LIMIT 1",
        ["user-reasoning-client-fallback"],
      );
      expect(route.rows[0]?.formula_inputs_json).toMatchObject({ clientRequestedReasoningEffort: "high",
        presetReasoningEffort: "max", targetCanonicalReasoningEffort: "max", resolvedReasoningEffort: "high",
        wireReasoningEffort: "high", mappingStatus: "provider_fallback_to_client_effort",
        decisionSnapshot: { clientRequestedReasoningEffort: "high", presetReasoningEffort: "max",
          targetCanonicalReasoningEffort: "max", resolvedReasoningEffort: "high", wireReasoningEffort: "high",
          mappingStatus: "provider_fallback_to_client_effort" } });
    } finally {
      alternateModelProfile.enabled = false;
      judgeResult.difficultyIndex = originalDifficulty;
      judgeResult.difficultyScore = originalScore;
      await database.query("DELETE FROM acu_profile_probe_queue WHERE execution_profile_id='test:gpt-5.6-luna:alternate'");
      await database.query("DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id='test:gpt-5.6-luna:alternate'");
    }
  });

  it("falls back from Luna Max to model default when the client supplied no Effort", async () => {
    const originalDifficulty = judgeResult.difficultyIndex;
    const originalScore = judgeResult.difficultyScore;
    alternateModelProfile.enabled = true;
    judgeResult.difficultyIndex = 99;
    judgeResult.difficultyScore = 99;
    const testCase = "reasoning-default-retry";
    const body = Buffer.from(JSON.stringify({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Use Luna Max with the model default fallback" }] }],
      stream: true,
      test_case: testCase,
      test_failures_before_success: 1,
      test_failure_status: 400,
    }));
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
        method: "POST",
        headers: signedHeaders(body, testCase, "user-reasoning-default", "codex",
          [alternateModelProfile.executionProfileId], "quality"),
        body,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      await response.arrayBuffer();
      const bodies = upstreamBodies.filter((item) => item.test_case === testCase);
      expect(bodies.map((item) => item.reasoning)).toEqual([{ effort: "max" }, undefined]);
      const attempts = await database.query<{ metadata_json: Record<string, unknown> }>(
        `SELECT metadata_json FROM acu_attempts
         WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id=$1)
         ORDER BY attempt_index`,
        ["user-reasoning-default"],
      );
      expect(attempts.rows.map((row) => row.metadata_json.mappingStatus)).toEqual(["exact", "provider_fallback_to_default"]);
      expect(attempts.rows[1]?.metadata_json).toMatchObject({ clientRequestedReasoningEffort: null,
        presetReasoningEffort: "max", targetCanonicalReasoningEffort: "max", resolvedReasoningEffort: null,
        wireReasoningEffort: null });
    } finally {
      alternateModelProfile.enabled = false;
      judgeResult.difficultyIndex = originalDifficulty;
      judgeResult.difficultyScore = originalScore;
      await database.query("DELETE FROM acu_profile_probe_queue WHERE execution_profile_id='test:gpt-5.6-luna:alternate'");
      await database.query("DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id='test:gpt-5.6-luna:alternate'");
    }
  });

  it("admits explicit Luna max despite a legacy Profile effort list and preserves it verbatim", async () => {
    alternateModelProfile.enabled = true;
    const beforeJudge = judgeCalls;
    const testCase = "explicit-luna-max-admission";
    const body = Buffer.from(JSON.stringify({
      model: "gpt-5.6-luna",
      reasoning: { effort: "max", summary: "auto" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Honor explicit max" }] }],
      stream: true,
      test_case: testCase,
    }));
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
        method: "POST",
        headers: signedHeaders(body, testCase, "user-explicit-luna-max", "codex", [alternateModelProfile.executionProfileId]),
        body,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      await response.arrayBuffer();
      expect(judgeCalls).toBe(beforeJudge);
      expect(upstreamBodies.filter((item) => item.test_case === testCase)).toMatchObject([
        { model: "gpt-5.6-luna", reasoning: { effort: "max", summary: "auto" } },
      ]);
      const attempt = await database.query<{ metadata_json: Record<string, unknown> }>(
        `SELECT metadata_json FROM acu_attempts
         WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id=$1)`,
        ["user-explicit-luna-max"],
      );
      expect(attempt.rows[0]?.metadata_json).toMatchObject({ clientRequestedReasoningEffort: "max",
        resolvedReasoningEffort: "max", wireReasoningEffort: "max", mappingStatus: "passthrough",
        providerReasoningOverrideApplied: false });
      const route = await database.query<{ formula_inputs_json: Record<string, unknown> }>(
        "SELECT formula_inputs_json FROM acu_route_decisions WHERE newapi_user_id=$1",
        ["user-explicit-luna-max"],
      );
      expect(route.rows[0]?.formula_inputs_json).toMatchObject({ judgeCalls: 0,
        clientRequestedReasoningEffort: "max", resolvedReasoningEffort: "max", wireReasoningEffort: "max",
        mappingStatus: "passthrough", decisionSnapshot: { clientRequestedReasoningEffort: "max",
          resolvedReasoningEffort: "max", wireReasoningEffort: "max", mappingStatus: "passthrough" } });
    } finally {
      alternateModelProfile.enabled = false;
    }
  });

  it("does not remove or retry a client Effort on an explicit model request", async () => {
    const testCase = "reasoning-explicit-rejected";
    alternateModelProfile.enabled = true;
    const body = Buffer.from(JSON.stringify({
      model: "gpt-5.6-luna",
      reasoning: { effort: "max" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Keep my effort" }] }],
      stream: true,
      test_case: testCase,
      test_failures_before_success: 1,
      test_failure_status: 400,
    }));
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
        method: "POST",
        headers: signedHeaders(body, testCase, "user-reasoning-explicit", "codex", [alternateModelProfile.executionProfileId]),
        body,
      });
      expect(response.status).toBe(400);
      await response.arrayBuffer();
      const bodies = upstreamBodies.filter((item) => item.test_case === testCase);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.reasoning).toEqual({ effort: "max" });
    } finally {
      alternateModelProfile.enabled = false;
    }
  });

  it("uses a different Provider for the third same-model Channel after two Lucen failures", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel','test-cross-provider-channel')");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery','test:gpt-5.4-mini:cross-provider-recovery')",
    );
    const beforeJudge = judgeCalls;
    await send({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Three channel recovery" }] }],
      stream: true,
      test_case: "retry-twice",
      test_failures_before_success: 2,
      test_failure_status: 502,
    }, "retry-three-channel", "user-three-channel");
    expect(judgeCalls).toBe(beforeJudge + 1);
    const attempts = await database.query<{
      attempt_index: number; provider: string; channel: string; status: string;
    }>(
      `SELECT attempt_index,provider,channel,status FROM acu_attempts
       WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id='user-three-channel')
       ORDER BY attempt_index`,
    );
    expect(attempts.rows).toEqual([
      { attempt_index: 1, provider: "lucen", channel: "test-channel", status: "error" },
      { attempt_index: 2, provider: "lucen", channel: "test-recovery-channel", status: "error" },
      { attempt_index: 3, provider: "blackai", channel: "test-cross-provider-channel", status: "success" },
    ]);
    const requestCount = await database.query<{ count: string }>(
      "SELECT count(*) FROM acu_logical_requests WHERE newapi_user_id='user-three-channel'",
    );
    expect(requestCount.rows[0].count).toBe("1");
  });

  it("tries another same-model Profile before a context model reroute", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel','test-cross-provider-channel')");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery','test:gpt-5.4-mini:cross-provider-recovery')",
    );
    const testCase = "context-same-model-first";
    const responseBody = await send({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Retry the same model first" }] }],
      stream: true,
      test_case: testCase,
      test_context_overflow_once: true,
    }, testCase, "user-context-same-model-first");
    expect(responseBody).toContain("response.completed");
    const attempts = await database.query<{
      attempt_index: number; execution_profile_id: string; actual_model: string; status: string;
      metadata_json: Record<string, unknown>;
    }>(
      `SELECT attempt_index,execution_profile_id,actual_model,status,metadata_json FROM acu_attempts
       WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests
         WHERE newapi_user_id='user-context-same-model-first') ORDER BY attempt_index`,
    );
    expect(attempts.rows).toHaveLength(2);
    expect(attempts.rows[0]).toMatchObject({
      attempt_index: 1,
      actual_model: "gpt-5.4-mini",
      status: "error",
      metadata_json: {
        errorClass: "provider_context_overflow",
        nextRecoveryAction: "same_model_channel_fallback",
      },
    });
    expect(attempts.rows[1]).toMatchObject({
      attempt_index: 2,
      actual_model: "gpt-5.4-mini",
      status: "success",
    });
    const contextEvidence = await database.query<{ metadata_json: Record<string, unknown> }>(
      "SELECT metadata_json FROM acu_provider_model_profile_health WHERE execution_profile_id=$1",
      [attempts.rows[0]!.execution_profile_id],
    );
    expect(contextEvidence.rows[0]?.metadata_json).toMatchObject({
      observedContextFailureThresholdTokens: expect.any(Number),
      contextFailureLastObservedAt: expect.any(String),
    });
    const successEvidence = await database.query<{ observed_successful_input_tokens: string }>(
      "SELECT observed_successful_input_tokens::text FROM acu_provider_model_profile_health WHERE execution_profile_id=$1",
      [attempts.rows[1]!.execution_profile_id],
    );
    expect(Number(successEvidence.rows[0]?.observed_successful_input_tokens)).toBeGreaterThan(0);
  });

  it("never recovers through a Profile outside the Token allowlist", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel','test-cross-provider-channel')");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery','test:gpt-5.4-mini:cross-provider-recovery')",
    );
    const body = Buffer.from(JSON.stringify({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Do not escape the Profile policy" }] }],
      stream: true,
      test_case: "profile-policy-no-recovery",
      test_failures_before_success: 1,
      test_failure_status: 502,
    }));
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: signedHeaders(body, "profile-policy-no-recovery", "user-profile-policy", "codex", [
        "test:gpt-5.4-mini:responses",
      ]),
      body,
    });
    expect(response.status).toBe(502);
    const attempts = await database.query<{
      execution_profile_id: string;
      status: string;
      http_status: number;
      latency_ms: number;
      network_endpoint: string;
      provider_request_id: string;
      metadata_json: Record<string, unknown>;
    }>(
      `SELECT execution_profile_id,status,http_status,latency_ms,network_endpoint,provider_request_id,metadata_json FROM acu_attempts
       WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id='user-profile-policy')`,
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]).toMatchObject({
      execution_profile_id: "test:gpt-5.4-mini:responses",
      status: "error",
      http_status: 502,
      network_endpoint: "primary",
      provider_request_id: "provider-profile-policy-no-recovery-failed-1",
      metadata_json: {
        endpoint: "primary",
        healthScope: "profile",
        recoveryDecisionReason: "no_compatible_profile",
        stopReason: "no_compatible_profile",
        attemptsBudgetExhausted: false,
        timeBudgetExhausted: false,
      },
    });
    expect(attempts.rows[0]!.latency_ms).toBeGreaterThanOrEqual(0);
    expect(attempts.rows[0]!.metadata_json.responseHeaders).toMatchObject({
      "x-request-id": "provider-profile-policy-no-recovery-failed-1",
    });
  });

  it("reuses Judge and only reroutes when the Token Profile policy changes", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel')");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery')",
    );
    const firstBody = Buffer.from(JSON.stringify({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Start Profile policy task" }] }],
      stream: true,
    }));
    const beforeJudge = judgeCalls;
    const first = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: signedHeaders(firstBody, "profile-policy-start", "user-profile-refresh", "codex", [
        "test:gpt-5.4-mini:responses",
        "test:gpt-5.4-mini:recovery",
      ]),
      body: firstBody,
    });
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    expect(judgeCalls).toBe(beforeJudge + 1);

    const continuationBody = Buffer.from(JSON.stringify({
      model: "acu-auto",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Start Profile policy task" }] },
        { type: "function_call", call_id: "policy-read", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "policy-read", output: "continue" },
      ],
      stream: true,
    }));
    const second = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: signedHeaders(continuationBody, "profile-policy-refresh", "user-profile-refresh", "codex", [
        "test:gpt-5.4-mini:recovery",
      ]),
      body: continuationBody,
    });
    expect(second.status).toBe(200);
    await second.arrayBuffer();
    expect(judgeCalls).toBe(beforeJudge + 1);
    const trace = await database.query<{ metadata_json: Record<string, unknown> }>(
      `SELECT metadata_json FROM acu_admission_traces WHERE newapi_user_id='user-profile-refresh'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(trace.rows[0]?.metadata_json).toMatchObject({
      judgeCalls: 0,
      judgeReused: true,
      routeRefreshReason: "profile_policy_changed",
    });
  });

  it("reuses Judge but recalculates Route when Routing Utility Version changes", async () => {
    const userId = "user-routing-utility-refresh";
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel')");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery')",
    );
    const policyA: RoutingUtilityPolicy = {
      ...DEFAULT_ROUTING_UTILITY_POLICY,
      formulaMode: "active",
      routingUtilityVersion: "acu-routing-utility-v1-aaaaaaaaaaaaaaaa",
    };
    const policyB: RoutingUtilityPolicy = {
      ...policyA,
      supplyStrategy: "lowest_cost",
      supplyWeights: { cost: 100, speed: 0, reliability: 0 },
      routingUtilityVersion: "acu-routing-utility-v1-bbbbbbbbbbbbbbbb",
    };
    const firstInput = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Start utility refresh task" }] },
    ];
    const beforeJudge = judgeCalls;
    await sendWithPolicy({ model: "acu-auto", input: firstInput, stream: true },
      "routing-utility-a", userId, policyA);
    expect(judgeCalls).toBe(beforeJudge + 1);

    await sendWithPolicy({
      model: "acu-auto",
      input: [
        ...firstInput,
        { type: "function_call", call_id: "utility-read", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "utility-read", output: "continue" },
      ],
      stream: true,
    }, "routing-utility-b", userId, policyB);
    expect(judgeCalls).toBe(beforeJudge + 1);

    const result = await database.query<{
      judges: string;
      routes: string;
      admission_metadata: Record<string, unknown>;
      segment_metadata: Record<string, unknown>;
    }>(
      `SELECT
       (SELECT count(*)::text FROM acu_judge_evaluations WHERE newapi_user_id=$1) judges,
       (SELECT count(*)::text FROM acu_route_decisions WHERE newapi_user_id=$1) routes,
       (SELECT metadata_json FROM acu_admission_traces WHERE newapi_user_id=$1 ORDER BY created_at DESC LIMIT 1) admission_metadata,
       (SELECT metadata_json FROM acu_segments WHERE newapi_user_id=$1 AND status='active' LIMIT 1) segment_metadata`,
      [userId],
    );
    expect(result.rows[0]).toMatchObject({ judges: "1", routes: "2" });
    expect(result.rows[0]?.admission_metadata).toMatchObject({
      judgeCalls: 0,
      judgeReused: true,
      routeRefreshReason: "routing_utility_changed",
    });
    expect(result.rows[0]?.segment_metadata).toMatchObject({
      routingUtilityVersion: "acu-routing-utility-v1-bbbbbbbbbbbbbbbb",
      formulaMode: "active",
      supplyStrategy: "lowest_cost",
      supplyWeights: { cost: 100, speed: 0, reliability: 0 },
      routingModelVersion: "acu-model-utility-v2.1",
      profileFormulaVersion: "acu-profile-utility-v2.1",
    });
  });

  it("treats identical bodies with different trusted New API identities as distinct requests", async () => {
    const userId = "user-distinct-request-identity";
    const body = {
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Same body, new user action" }] }],
      stream: true,
    };
    await send(body, "distinct-request-1", userId);
    await send(body, "distinct-request-2", userId);
    const requests = await database.query<{ count: string; logs: string[] }>(
      `SELECT count(*)::text count,array_agg(newapi_log_id ORDER BY newapi_log_id) logs
       FROM acu_logical_requests WHERE newapi_user_id=$1`,
      [userId],
    );
    expect(requests.rows[0]).toEqual({
      count: "2",
      logs: ["log-distinct-request-1", "log-distinct-request-2"],
    });
  });

  it("keeps a Web-specific 422 out of normal Profile health and falls back within the same model", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel')");
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery')",
    );
    await database.query(
      "DELETE FROM acu_provider_model_profile_health WHERE execution_profile_id IN ('test:gpt-5.4-mini:responses','test:gpt-5.4-mini:recovery')",
    );
    const body = {
      model: "acu-auto",
      input: "Use web search for the current UTC date",
      tools: [{ type: "web_search" }],
      stream: true,
      test_case: "web-retry-once",
      test_failures_before_success: 1,
      test_failure_status: 422,
      test_web_success: true,
    };
    await send(body, "web-retry-1", "user-web-retry");
    const result = await database.query<{
      logical_requests: string;
      channels: string[];
      first_circuit: string;
      first_web_rate: number;
      logical_metadata: Record<string, unknown>;
    }>(
      `SELECT
       (SELECT count(*) FROM acu_logical_requests WHERE newapi_user_id='user-web-retry') logical_requests,
       (SELECT array_agg(channel ORDER BY attempt_index) FROM acu_attempts
        WHERE logical_request_id=(SELECT logical_request_id FROM acu_logical_requests WHERE newapi_user_id='user-web-retry')) channels,
       (SELECT circuit_state FROM acu_provider_model_profile_health WHERE execution_profile_id='test:gpt-5.4-mini:responses') first_circuit,
       (SELECT (metadata_json->>'webSearchRecentSuccessRate')::double precision
        FROM acu_provider_model_profile_health WHERE execution_profile_id='test:gpt-5.4-mini:responses') first_web_rate,
       (SELECT metadata_json FROM acu_logical_requests WHERE newapi_user_id='user-web-retry') logical_metadata`,
    );
    expect(result.rows[0].logical_requests).toBe("1");
    expect(result.rows[0].channels).toEqual(["test-channel", "test-recovery-channel"]);
    expect(result.rows[0].first_circuit).toBe("healthy");
    expect(result.rows[0].first_web_rate).toBeLessThan(1);
    expect(result.rows[0].logical_metadata).toMatchObject({
      webActuallyInvoked: true,
      webSearchEventStatus: ["in_progress", "searching", "completed"],
      webFallbackChain: [
        "test-channel:primary",
        "test-recovery-channel:primary",
      ],
    });
  });

  it("preserves native Codex sandbox semantics instead of enforcing workspace-write", async () => {
    const beforeJudge = judgeCalls;
    const beforeProvider = upstreamBodies.length;
    const body = Buffer.from(JSON.stringify({
      model: "acu-auto",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>\n`sandbox_mode` is `read-only`\n</permissions instructions>" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context><cwd>${process.cwd()}</cwd></environment_context>` }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Modify one file and run check.sh" }] },
      ],
      stream: true,
    }));
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: signedHeaders(body, "workspace-read-only", "user-workspace", "codex"),
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("response.completed");
    expect(judgeCalls).toBe(beforeJudge + 1);
    expect(upstreamBodies.length).toBe(beforeProvider + 1);
  });

  it("persists Judge cost and returns one stable 400 when Context admission fails", async () => {
    const beforeJudge = judgeCalls;
    const beforeProvider = upstreamBodies.length;
    const body = Buffer.from(JSON.stringify({
      model: "acu-auto",
      input: [{
        type: "message", role: "user",
        content: [{ type: "input_text", text: `summarize ${"x".repeat(1_700_000)}` }],
      }],
      stream: true,
    }));
    const request = () => fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: signedHeaders(body, "context-too-long", "user-context-failure", "codex"),
      body,
    });

    const first = await request();
    expect(first.status).toBe(400);
    const firstError = await first.json() as { error: Record<string, unknown> };
    expect(firstError.error).toMatchObject({
      type: "context_length_exceeded",
      maximum_available_context_tokens: 400_000,
    });
    expect(judgeCalls).toBe(beforeJudge + 1);
    expect(upstreamBodies.length).toBe(beforeProvider);

    const replay = await request();
    expect(replay.status).toBe(400);
    expect(judgeCalls).toBe(beforeJudge + 1);
    expect(upstreamBodies.length).toBe(beforeProvider);

    const result = await database.query<{
      requests: string; judges: string; judge_ledger: string; admissions: string; attempts: string;
      usage_reports: string; pending_requests: string; judge_cash: string;
    }>(
      `SELECT
       (SELECT count(*) FROM acu_logical_requests WHERE newapi_user_id='user-context-failure') requests,
       (SELECT count(*) FROM acu_judge_evaluations WHERE newapi_user_id='user-context-failure') judges,
       (SELECT count(*) FROM acu_judge_ledger_entries WHERE newapi_user_id='user-context-failure') judge_ledger,
       (SELECT count(*) FROM acu_admission_traces WHERE newapi_user_id='user-context-failure') admissions,
       (SELECT count(*) FROM acu_attempts a JOIN acu_logical_requests r USING(logical_request_id)
        WHERE r.newapi_user_id='user-context-failure') attempts,
       (SELECT count(*) FROM acu_usage_reports WHERE newapi_user_id='user-context-failure') usage_reports,
       (SELECT count(*) FROM acu_logical_requests WHERE newapi_user_id='user-context-failure' AND status='pending') pending_requests,
       (SELECT judge_cash_cost_cny::text FROM acu_usage_reports WHERE newapi_user_id='user-context-failure') judge_cash`,
    );
    expect(result.rows[0]).toEqual({
      requests: "1", judges: "1", judge_ledger: "1", admissions: "1", attempts: "0",
      usage_reports: "1", pending_requests: "0", judge_cash: "0.0072000000",
    });
  });

  it("keeps Claude tool_result in role=user separate from a HumanMessage and preserves native SSE", async () => {
    const userId = "user-claude";
    const beforeJudge = judgeCalls;
    const initial = [{ role: "user", content: [{ type: "text", text: "Read the project file" }] }];
    const first = await sendProtocol("messages", {
      model: "acu-auto",
      messages: initial,
      stream: true,
    }, "claude-1", userId, "claude-code");
    expect(first).toContain('"type":"tool_use","id":"tool-test"');
    expect(first).toContain('"signature":"signature-test"');
    expect(judgeCalls).toBe(beforeJudge + 1);

    await sendProtocol("messages", {
      model: "acu-auto",
      messages: [
        ...initial,
        { role: "assistant", content: [{ type: "tool_use", id: "tool-test", name: "Read", input: { file_path: "README.md" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-test", content: "fixture contents" }] },
      ],
      stream: true,
    }, "claude-2", userId, "claude-code");
    expect(judgeCalls).toBe(beforeJudge + 1);
    const state = await database.query<{ sessions: string; segments: string; human_messages: string; tool_results: string }>(
      `SELECT
       (SELECT count(*) FROM acu_sessions WHERE newapi_user_id=$1) sessions,
       (SELECT count(*) FROM acu_segments WHERE newapi_user_id=$1) segments,
       (SELECT count(*) FROM acu_events e JOIN acu_tasks t ON t.task_id=e.task_id WHERE t.newapi_user_id=$1 AND e.event_type='human_message') human_messages,
       (SELECT count(*) FROM acu_events e JOIN acu_tasks t ON t.task_id=e.task_id WHERE t.newapi_user_id=$1 AND e.event_type='tool_result') tool_results`,
      [userId],
    );
    expect(state.rows[0]).toEqual({ sessions: "1", segments: "1", human_messages: "1", tool_results: "1" });
  });
});
