import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAlphaGatewayServer,
  isPrivateNetworkAddress,
  type AlphaGatewayTrace,
} from "../src/alpha/gateway.js";
import { createNativeProviderAdapter } from "../src/alpha/provider.js";
import { bodySha256, trustedIdentityHeaders } from "../src/alpha/trusted-identity.js";
import { DEFAULT_ROUTING_UTILITY_POLICY } from "../src/alpha/routing-utility-v2.js";

const sharedSecret = "alpha-test-shared-secret-not-production";
const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

function signedHeaders(body: Buffer): Record<string, string> {
  const identity = {
    newapiUserId: "test-user",
    newapiTokenId: "test-token",
    newapiLogId: "test-log",
    requestId: "test-request",
    clientVersion: "2.1.220",
    routingPolicy: "all_routing_eligible" as const,
    allowedModelIds: [],
    allowedProfileIds: [],
    routingPolicyVersion: "acu-user-policy-v2-0000000000000000",
    routingPreference: "balanced" as const,
    timestamp: new Date().toISOString(),
    bodySha256: bodySha256(body),
  };
  return { ...trustedIdentityHeaders(identity, sharedSecret), "content-type": "application/json" };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe("Alpha native protocol gateway", () => {
  it("serves an authenticated zero-call selection corridor projection", async () => {
    const calls: Array<{ inputTokens: number; expectedOutputTokens: number }> = [];
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      adminSelectionCorridor: {
        token: "corridor-token",
        async load(inputTokens, expectedOutputTokens) {
          calls.push({ inputTokens, expectedOutputTokens });
          return { formulaVersion: "acu-routing-model-v0.5", series: { balanced: [] } };
        },
      },
      async resolveExecution() { throw new Error("corridor projection must not route an execution"); },
    }));
    const unauthorized = await fetch(`http://127.0.0.1:${gatewayPort}/internal/admin/selection-corridor`);
    expect(unauthorized.status).toBe(401);
    const response = await fetch(
      `http://127.0.0.1:${gatewayPort}/internal/admin/selection-corridor?inputTokens=24000&expectedOutputTokens=1200`,
      { headers: { authorization: "Bearer corridor-token" } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ formulaVersion: "acu-routing-model-v0.5" });
    expect(calls).toEqual([{ inputTokens: 24000, expectedOutputTokens: 1200 }]);
  });

  it("protects Channel Monitor and records an authorized manual pause", async () => {
    const pauses: Array<{ channelId: string; durationMinutes: number; actor: string }> = [];
    const monitorQueries: Array<Record<string, unknown>> = [];
    const monitorPolicies: Array<Record<string, unknown> | undefined> = [];
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      adminChannelMonitor: {
        token: "monitor-token",
        async load(query, utilityPolicy) {
          monitorQueries.push(query); monitorPolicies.push(utilityPolicy); return { ...query, profiles: [] };
        },
        async pause(channelId, durationMinutes, actor) {
          pauses.push({ channelId, durationMinutes, actor });
          return { channelId, state: "open", recovery: "half_open_probe" };
        },
      },
      async resolveExecution() { throw new Error("monitor must not route an execution"); },
    }));
    const unauthorized = await fetch(`http://127.0.0.1:${gatewayPort}/internal/admin/channel-monitor`);
    expect(unauthorized.status).toBe(401);
    const monitor = await fetch(
      `http://127.0.0.1:${gatewayPort}/internal/admin/channel-monitor?range=6h&supplyStrategy=low_latency&scenario=small`,
      { headers: { authorization: "Bearer monitor-token",
        "x-acu-monitor-routing-utility-policy": JSON.stringify({
          ...DEFAULT_ROUTING_UTILITY_POLICY, profileCostLogScale: 7,
        }) } },
    );
    expect(monitor.status).toBe(200);
    expect(monitorQueries).toEqual([{ range: "6h", supplyStrategy: "low_latency", scenario: "small" }]);
    expect(monitorPolicies).toHaveLength(1);
    expect(monitorPolicies[0]?.profileCostLogScale).toBe(7);
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/internal/admin/channel-monitor`, {
      method: "POST",
      headers: { authorization: "Bearer monitor-token", "content-type": "application/json" },
      body: JSON.stringify({ channelId: "lucen-cx014-pro-stable", durationMinutes: 30, actor: "admin-fixture" }),
    });
    expect(response.status).toBe(200);
    expect(pauses).toEqual([{ channelId: "lucen-cx014-pro-stable", durationMinutes: 30, actor: "admin-fixture" }]);
    expect(await response.json()).toMatchObject({ state: "open", recovery: "half_open_probe" });
  });

  it("returns verifiable build, migration, Judge, and routing identity in health", async () => {
    const identity = {
      runningCommit: "commit-fixture",
      buildTime: "2026-07-30T00:00:00Z",
      buildBranch: "productization/alpha-rc1-validation",
      latestMigration: "0007_rc22_judge_cutover",
      judgePrimaryModel: "mimo-v2.5-pro",
      judgeBackupModel: "deepseek-v4-flash",
      routingFormulaVersion: "acu-routing-model-v0.5",
    };
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async healthCheck() { return identity; },
      async resolveExecution() { throw new Error("health must not route an execution"); },
    }));
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/internal/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", ...identity });
  });

  it("recognizes only loopback and private network ingress addresses", () => {
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.2.3.4", "172.16.0.1", "172.31.2.3", "192.168.1.2", "fd00::1"]
      .every(isPrivateNetworkAddress)).toBe(true);
    expect(["8.8.8.8", "172.15.0.1", "172.32.0.1", "2001:4860:4860::8888"]
      .some(isPrivateNetworkAddress)).toBe(false);
  });

  it("lists auxiliary Alpha models only for trusted New API requests", async () => {
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      models: ["gpt-test", "claude-test", "gpt-test"],
      async resolveExecution() {
        throw new Error("models must not resolve an execution");
      },
    }));
    const unsigned = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
    expect(unsigned.status).toBe(401);

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
      headers: signedHeaders(Buffer.alloc(0)),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: ["acu-auto", "acu-high", "gpt-test", "claude-test"].map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "acu",
      })),
    });
  });

  it("protects full traces with an independent administrator bearer token", async () => {
    let loads = 0;
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      adminTrace: {
        token: "independent-admin-token-not-production",
        async load(logicalRequestId) {
          loads += 1;
          return logicalRequestId === "req_trace_1"
            ? { logical_request: { logical_request_id: logicalRequestId }, attempts: [] }
            : undefined;
        },
      },
      async resolveExecution() { throw new Error("admin traces must not resolve an execution"); },
    }));

    const unsigned = await fetch(`http://127.0.0.1:${gatewayPort}/internal/admin/traces/req_trace_1`);
    expect(unsigned.status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${gatewayPort}/internal/admin/traces/req_trace_1`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(403);
    expect(loads).toBe(0);

    const authorized = await fetch(`http://127.0.0.1:${gatewayPort}/internal/admin/traces/req_trace_1`, {
      headers: { authorization: "Bearer independent-admin-token-not-production" },
    });
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get("cache-control")).toBe("no-store");
    expect(await authorized.json()).toEqual({
      logical_request: { logical_request_id: "req_trace_1" },
      attempts: [],
    });
    expect(loads).toBe(1);

    const absent = await fetch(`http://127.0.0.1:${gatewayPort}/internal/admin/traces/req_missing`, {
      headers: { authorization: "Bearer independent-admin-token-not-production" },
    });
    expect(absent.status).toBe(404);
  });

  it("forwards an explicit Responses request body unchanged and replaces credentials", async () => {
    let upstreamBody = Buffer.alloc(0);
    let upstreamHeaders: Record<string, string | string[] | undefined> = {};
    const upstreamPort = await listen(createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      upstreamBody = Buffer.concat(chunks);
      upstreamHeaders = request.headers;
      response.setHeader("content-type", "application/json");
      response.end('{"id":"response-1","output":[]}');
    }));
    const adapter = createNativeProviderAdapter({
      provider: "closeai",
      channel: "closeai-openai",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: "provider-test-key",
      authMode: "bearer",
    });
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async resolveExecution(envelope) {
        return { adapter, requestedModel: envelope.requestedModel, actualModel: envelope.requestedModel, provider: "closeai", channel: "closeai-openai" };
      },
    }));
    const body = Buffer.from('{"model":"gpt-test","input":"hello","stream":false}');
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { ...signedHeaders(body), authorization: "Bearer client-secret" },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"id":"response-1","output":[]}');
    expect(upstreamBody.equals(body)).toBe(true);
    expect(upstreamHeaders.authorization).toBe("Bearer provider-test-key");
    expect(upstreamHeaders["x-acu-newapi-user-id"]).toBeUndefined();
  });

  it("does not forward gzip metadata after fetch has decoded the Provider body", async () => {
    const expected = '{"id":"response-gzip","output":[]}';
    const upstreamPort = await listen(createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("content-encoding", "gzip");
      response.end(gzipSync(expected));
    }));
    const adapter = createNativeProviderAdapter({
      provider: "lucen", channel: "lucen-openai",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "provider-test-key", authMode: "bearer",
    });
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async resolveExecution(envelope) {
        return { adapter, requestedModel: envelope.requestedModel, actualModel: envelope.requestedModel, provider: "lucen", channel: "lucen-openai" };
      },
    }));
    const body = Buffer.from('{"model":"gpt-test","input":"hello","stream":false}');
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST", headers: signedHeaders(body), body,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe(expected);
  });

  it("supports Providers whose Responses root omits the /v1 prefix", async () => {
    let upstreamPath = "";
    const upstreamPort = await listen(createServer((request, response) => {
      upstreamPath = request.url ?? "";
      response.setHeader("content-type", "application/json");
      response.end('{"id":"response-strip-v1","output":[]}');
    }));
    const adapter = createNativeProviderAdapter({
      provider: "lucen",
      channel: "lucen-openai",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "provider-test-key",
      authMode: "bearer",
      stripV1Path: true,
    });
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async resolveExecution(envelope) {
        return { adapter, requestedModel: envelope.requestedModel, actualModel: envelope.requestedModel, provider: "lucen", channel: "lucen-openai" };
      },
    }));
    const body = Buffer.from('{"model":"gpt-test","input":"hello","stream":false}');
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses?fixture=1`, {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(response.status).toBe(200);
    expect(upstreamPath).toBe("/responses?fixture=1");
  });

  it("relays SSE tool events byte-for-byte without aggregation or injection", async () => {
    const expected = [
      "event: response.output_item.added\n",
      "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call-1\"}}\n\n",
      "event: response.function_call_arguments.delta\n",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}\n\n",
      "event: response.completed\n",
      "data: {\"type\":\"response.completed\"}\n\n",
    ].join("");
    const upstreamPort = await listen(createServer((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.flushHeaders();
      for (const part of expected.split(/(?=event:)/).filter(Boolean)) response.write(part);
      response.end();
    }));
    const adapter = createNativeProviderAdapter({
      provider: "test",
      channel: "test",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "test-key",
      authMode: "bearer",
    });
    const traces: AlphaGatewayTrace[] = [];
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async resolveExecution(envelope) {
        return { adapter, requestedModel: envelope.requestedModel, actualModel: envelope.requestedModel, provider: "test", channel: "test" };
      },
      onTrace(trace) { traces.push({ ...trace }); },
    }));
    const body = Buffer.from('{"model":"gpt-test","input":"use shell","stream":true}');
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(await response.text()).toBe(expected);
    expect(traces.at(-1)).toMatchObject({ status: "completed", response: { complete: true } });
    expect(traces.at(-1)?.response?.body.toString()).toBe(expected);
  });

  it("treats a protocol-complete SSE response as completed when the client closes immediately", async () => {
    const expected = [
      'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call-1"}}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    ].join("");
    const upstreamPort = await listen(createServer((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.write(expected);
      setTimeout(() => response.end(), 30);
    }));
    const adapter = createNativeProviderAdapter({
      provider: "test", channel: "test", baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "test-key", authMode: "bearer",
    });
    const traces: AlphaGatewayTrace[] = [];
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async resolveExecution(envelope) {
        return { adapter, requestedModel: envelope.requestedModel, actualModel: envelope.requestedModel, provider: "test", channel: "test" };
      },
      onTrace(trace) { traces.push({ ...trace }); },
    }));
    const body = Buffer.from('{"model":"gpt-test","input":"use shell","stream":true}');
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST", headers: signedHeaders(body), body, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(traces.at(-1)).toMatchObject({ status: "completed", response: { complete: true, clientCancelled: false, protocolCompleted: true } });
  });

  it("relays max_output_tokens incomplete responses without replaying them", async () => {
    const expected = [
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
    ].join("");
    let attempts = 0;
    const traces: AlphaGatewayTrace[] = [];
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async resolveExecution(envelope) {
        return {
          requestedModel: envelope.requestedModel,
          actualModel: envelope.requestedModel,
          provider: "test",
          channel: "test",
          adapter: { async execute() {
            attempts += 1;
            return new Response(expected, { status: 200, headers: { "content-type": "text/event-stream" } });
          } },
        };
      },
      onTrace(trace) { traces.push({ ...trace }); },
    }));
    const body = Buffer.from('{"model":"gpt-test","input":"long answer","stream":true}');
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST", headers: signedHeaders(body), body,
    });
    expect(await response.text()).toBe(expected);
    expect(attempts).toBe(1);
    expect(traces.at(-1)).toMatchObject({
      response: { terminalKind: "incomplete", incompleteReason: "max_output_tokens" },
    });
  });

  it("keeps relaying a stream while valid chunks continue", async () => {
    const upstreamPort = await listen(createServer(async (_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.flushHeaders();
      for (let index = 0; index < 5; index += 1) {
        response.write(`data: chunk-${index}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      response.end("data: [DONE]\n\n");
    }));
    const adapter = createNativeProviderAdapter({
      provider: "test", channel: "test", baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "test-key", authMode: "bearer",
    });
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async resolveExecution(envelope) {
        return { adapter, requestedModel: envelope.requestedModel, actualModel: envelope.requestedModel, provider: "test", channel: "test" };
      },
    }));
    const body = Buffer.from('{"model":"gpt-test","input":"long stream","stream":true}');
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST", headers: signedHeaders(body), body,
    });
    const text = await response.text();
    expect(text).toContain("chunk-0");
    expect(text).toContain("chunk-4");
    expect(text).toContain("[DONE]");
  });

  it("accepts a request larger than the removed 32 MiB Router default", async () => {
    const input = "a".repeat(33 * 1024 * 1024);
    const body = Buffer.from(JSON.stringify({ model: "gpt-test", input, stream: false }));
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async resolveExecution(envelope) {
        return {
          adapter: { async execute() { return new Response('{"id":"large-fixture","output":[]}'); } },
          requestedModel: envelope.requestedModel,
          actualModel: envelope.requestedModel,
          provider: "fixture",
          channel: "fixture",
        };
      },
    }));
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST", headers: signedHeaders(body), body,
    });
    expect(response.status).toBe(200);
  }, 20_000);

  it("preserves Messages tool_use and thinking signature bytes", async () => {
    const expected = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"thinking\",\"signature\":\"sig-1\"}}\n\n"
      + "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool-1\"}}\n\n";
    let path = "";
    const upstreamPort = await listen(createServer((request, response) => {
      path = request.url ?? "";
      response.setHeader("content-type", "text/event-stream");
      response.end(expected);
    }));
    const adapter = createNativeProviderAdapter({
      provider: "closeai",
      channel: "closeai-anthropic",
      baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic`,
      apiKey: "test-key",
      authMode: "x-api-key",
      anthropicVersion: "2023-06-01",
    });
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async resolveExecution(envelope) {
        return { adapter, requestedModel: envelope.requestedModel, actualModel: envelope.requestedModel, provider: "closeai", channel: "closeai-anthropic" };
      },
    }));
    const body = Buffer.from('{"model":"claude-test","messages":[{"role":"user","content":"hello"}],"stream":true}');
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages?beta=true`, {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(await response.text()).toBe(expected);
    expect(path).toBe("/anthropic/v1/messages?beta=true");
  });

  it("fails closed on a forged identity before reaching Provider", async () => {
    let upstreamCalls = 0;
    const upstreamPort = await listen(createServer((_request, response) => {
      upstreamCalls += 1;
      response.end("unexpected");
    }));
    const adapter = createNativeProviderAdapter({
      provider: "test",
      channel: "test",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "test-key",
      authMode: "bearer",
    });
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async resolveExecution(envelope) {
        return { adapter, requestedModel: envelope.requestedModel, actualModel: envelope.requestedModel, provider: "test", channel: "test" };
      },
    }));
    const body = Buffer.from('{"model":"gpt-test","input":"hello"}');
    const headers = signedHeaders(body);
    headers["x-acu-newapi-user-id"] = "forged-user";
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, { method: "POST", headers, body });
    expect(response.status).toBe(401);
    expect(upstreamCalls).toBe(0);
  });

  it("uses a native Messages error envelope for invalid trusted identity", async () => {
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async resolveExecution() { throw new Error("must not execute"); },
    }));
    const body = Buffer.from('{"model":"claude-test","messages":[]}');
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "api_error", message: "Missing or repeated trusted identity header: x-acu-newapi-user-id" },
    });
  });

  it("aborts the Provider stream after client cancellation", async () => {
    let upstreamClosedResolve: (() => void) | undefined;
    const upstreamClosed = new Promise<void>((resolve) => { upstreamClosedResolve = resolve; });
    const upstreamPort = await listen(createServer((request, response) => {
      request.once("close", () => upstreamClosedResolve?.());
      response.setHeader("content-type", "text/event-stream");
      response.flushHeaders();
      response.write("event: message\ndata: first\n\n");
      const timer = setInterval(() => response.write("event: message\ndata: more\n\n"), 10);
      response.once("close", () => clearInterval(timer));
    }));
    const adapter = createNativeProviderAdapter({
      provider: "test",
      channel: "test",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "test-key",
      authMode: "bearer",
    });
    const gatewayPort = await listen(createAlphaGatewayServer({
      trustedIdentitySecret: sharedSecret,
      async resolveExecution(envelope) {
        return { adapter, requestedModel: envelope.requestedModel, actualModel: envelope.requestedModel, provider: "test", channel: "test" };
      },
    }));
    const body = Buffer.from('{"model":"gpt-test","input":"hello","stream":true}');
    const client = httpRequest({
      host: "127.0.0.1",
      port: gatewayPort,
      path: "/v1/responses",
      method: "POST",
      headers: { ...signedHeaders(body), "content-length": body.length },
    });
    client.on("response", (response) => response.once("data", () => response.destroy()));
    client.end(body);
    await upstreamClosed;
    expect(true).toBe(true);
  });
});
