import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AcuJudgeResult } from "../src/acu/types.js";
import { AlphaDatabase } from "../src/alpha/database.js";
import { createAlphaGatewayServer } from "../src/alpha/gateway.js";
import type { AlphaJudgeRunner } from "../src/alpha/judge-runner.js";
import { createNativeProviderAdapter } from "../src/alpha/provider.js";
import { AlphaRequestProcessor } from "../src/alpha/processor.js";
import type { AlphaExecutionProfile } from "../src/alpha/routing.js";
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
): Record<string, string> {
  const identity = {
    newapiUserId: userId,
    newapiTokenId: `token-${userId}`,
    newapiLogId: `log-${requestId}`,
    requestId,
    routingPolicy: "all_routing_eligible" as const,
    allowedModelIds: [],
    routingPolicyVersion: "acu-user-policy-v2-0000000000000000",
    routingPreference: "balanced" as const,
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
      const failuresBeforeSuccess = Number(requestBody.test_failures_before_success ?? 0);
      if (testCase && testCaseCall <= failuresBeforeSuccess) {
        response.statusCode = Number(requestBody.test_failure_status ?? 503);
        response.setHeader("content-type", "application/json");
        response.setHeader("x-request-id", `provider-${testCase}-failed-${testCaseCall}`);
        response.end(JSON.stringify({ error: { type: "overloaded_error", message: "controlled test overload" } }));
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
        "event: response.output_text.delta",
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}`,
        "",
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: responseId,
            model: requestBody.model,
            output: requestBody.test_web_success === true
              ? [{ type: "web_search_call", status: "completed" }, { type: "message", content: [] }]
              : [{ type: "message", content: [] }],
            usage: {
              input_tokens: 100,
              input_tokens_details: { cached_tokens: 20 },
              output_tokens: 10,
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
      thinkingSupport: true,
      contextWindow: 1_000_000,
      health: "healthy",
      enabled: true,
      administratorAllowed: true,
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
    const recoveryProfile: AlphaExecutionProfile = {
      ...profile,
      executionProfileId: "test:gpt-5.4-mini:recovery",
      channel: "test-recovery-channel",
    };
    const judgeRunner: AlphaJudgeRunner = {
      async run(input) {
        judgeCalls += 1;
        const visible = JSON.stringify(input.messages);
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
          promptTokens: 10,
          completionTokens: 10,
          latencyMs: 1,
          costUsd: "0.0010000000",
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
    const processor = new AlphaRequestProcessor({
      database,
      profiles: [profile, recoveryProfile],
      adapters: new Map([
        [profile.executionProfileId, adapter],
        [recoveryProfile.executionProfileId, adapter],
      ]),
      judgeRunner,
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
    expect(response.status).toBe(200);
    return response.text();
  }

  it("Judges a new auto Task, rewrites only model, and persists the full trace", async () => {
    const history = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Fix the bug" }] }];
    await send({ model: "acu-auto", input: history, stream: true }, "request-1");
    expect(judgeCalls).toBe(1);
    expect(upstreamBodies[0].model).toBe("gpt-5.4-mini");
    const counts = await database.query<{ sessions: string; tasks: string; segments: string; judges: string; routes: string; requests: string; attempts: string; payloads: string; usage: string }>(
      `SELECT
       (SELECT count(*) FROM acu_sessions) sessions,
       (SELECT count(*) FROM acu_tasks) tasks,
       (SELECT count(*) FROM acu_segments) segments,
       (SELECT count(*) FROM acu_judge_evaluations) judges,
       (SELECT count(*) FROM acu_route_decisions) routes,
       (SELECT count(*) FROM acu_logical_requests) requests,
       (SELECT count(*) FROM acu_attempts) attempts,
       (SELECT count(*) FROM acu_payloads) payloads,
       (SELECT count(*) FROM acu_usage_reports) usage`,
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
       FROM acu_route_decisions LIMIT 1`,
    );
    expect(routeEvidence.rows[0]).toEqual({
      configured_profiles: "2",
      protocol_profiles: "2",
      initial_models: "1",
      filtered_profiles: "2",
      filtered_models: "1",
      pareto_models: "1",
      excluded_profiles: [],
      routing_preference: "balanced",
      routing_model_version: "acu-routing-model-v0.3",
    });
    const payloadKinds = await database.query<{ payload_kind: string }>(
      "SELECT payload_kind FROM acu_payloads ORDER BY created_at,payload_kind",
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
      `SELECT (SELECT count(*) FROM acu_segments) segments,
       (SELECT count(*) FROM acu_judge_evaluations) judges,
       (SELECT metadata_json->>'webIntent' FROM acu_segments WHERE status='active') segment_web_intent,
       (SELECT metadata_json->>'webIntentSource' FROM acu_segments WHERE status='active') segment_web_source`,
    );
    expect(counts.rows[0]).toEqual({
      segments: "1",
      judges: "1",
      segment_web_intent: "not_required",
      segment_web_source: "judge",
    });
  });

  it("creates a new Segment and Judges the human message '继续' with full history", async () => {
    const history = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the bug" }] },
      { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call-1", output: "workspace" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] },
    ];
    const firstResponse = await send({ model: "acu-auto", input: history, stream: true }, "request-3");
    expect(judgeCalls).toBe(2);
    const counts = await database.query<{ segments: string; active: string; judges: string }>(
      `SELECT (SELECT count(*) FROM acu_segments) segments,
       (SELECT count(*) FROM acu_segments WHERE status='active') active,
       (SELECT count(*) FROM acu_judge_evaluations) judges`,
    );
    expect(counts.rows[0]).toEqual({ segments: "2", active: "1", judges: "2" });

    const replay = await send({ model: "acu-auto", input: history, stream: true }, "request-3-replayed");
    expect(replay).toBe(firstResponse);
    expect(judgeCalls).toBe(2);
    const replayCounts = await database.query<{ attempts: string; requests: string; usage: string }>(
      `SELECT (SELECT count(*) FROM acu_attempts) attempts,
       (SELECT count(*) FROM acu_logical_requests) requests,
       (SELECT count(*) FROM acu_usage_reports) usage`,
    );
    expect(replayCounts.rows[0]).toEqual({ attempts: "3", requests: "3", usage: "3" });
  });

  it("executes an explicit model with Judge=0 and no model substitution", async () => {
    await send({
      model: "gpt-5.4-mini",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Explicit request" }] }],
      stream: true,
    }, "explicit-1", "user-explicit");
    expect(judgeCalls).toBe(2);
    expect(upstreamBodies.at(-1)?.model).toBe("gpt-5.4-mini");
    const result = await database.query<{ judge_count: string; route_mode: string }>(
      `SELECT
       (SELECT count(*) FROM acu_judge_evaluations WHERE newapi_user_id='user-explicit') judge_count,
       (SELECT mode FROM acu_route_decisions WHERE newapi_user_id='user-explicit' LIMIT 1) route_mode`,
    );
    expect(result.rows[0]).toEqual({ judge_count: "0", route_mode: "explicit" });
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
  });

  it("backs off a 502 Channel and recovers on the same model without duplicating the Logical Request", async () => {
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
      channel_id: string;
      circuit_state: string;
      error_class: string;
      cooldown_active: boolean;
    }>(
      `SELECT channel_id,circuit_state,error_class,coalesce(cooldown_until>now(),false) cooldown_active
       FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel') ORDER BY channel_id`,
    );
    expect(health.rows).toEqual([
      { channel_id: "test-channel", circuit_state: "open", error_class: "provider_5xx", cooldown_active: true },
      { channel_id: "test-recovery-channel", circuit_state: "healthy", error_class: "none", cooldown_active: false },
    ]);
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
  });

  it("keeps a Web-specific 422 out of normal Profile health and falls back within the same model", async () => {
    await database.query("DELETE FROM acu_channel_health WHERE channel_id IN ('test-channel','test-recovery-channel')");
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

  it("rejects a file modification before Judge or Provider when the workspace is read-only", async () => {
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
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Codex sandbox must be workspace-write");
    expect(judgeCalls).toBe(beforeJudge);
    expect(upstreamBodies.length).toBe(beforeProvider);
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
