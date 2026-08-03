import { describe, expect, it } from "vitest";
import {
  classifyProviderContextOverflow,
  computeFirstModelEventDeadlineMs,
  contextOverflowRecoveryEligible,
  createRecoveringProviderAdapter,
  isRecoverableProviderStatus,
  ProviderPreOutputError,
  providerAttemptIdentity,
  type ProviderAttemptHandle,
} from "../src/alpha/execution.js";
import type { NativeProviderRequest } from "../src/alpha/provider.js";
import type { AlphaExecutionProfile } from "../src/alpha/routing.js";

const profile: AlphaExecutionProfile = {
  executionProfileId: "test:model:primary",
  modelId: "test-model",
  provider: "test-provider",
  channel: "primary",
  protocols: ["responses", "messages"],
  toolCallSupport: true,
  thinkingSupport: true,
  contextWindow: 100_000,
  health: "healthy",
  enabled: true,
  administratorAllowed: true,
};

function request(): NativeProviderRequest {
  return {
    protocol: "responses",
    path: "/v1/responses",
    query: "",
    headers: {},
    body: Buffer.from("{}"),
    signal: new AbortController().signal,
  };
}

describe("Alpha Provider attempt recovery", () => {
  it("classifies only explicit Provider context overflow evidence", () => {
    expect(classifyProviderContextOverflow(JSON.stringify({
      error: { type: "invalid_request_error", code: "context_length_exceeded", message: "Maximum context length is 128,000 tokens" },
    }))).toEqual({ isContextOverflow: true, reportedContextLimit: 128000 });
    expect(classifyProviderContextOverflow("input exceeds the context window")).toEqual({ isContextOverflow: true });
    expect(classifyProviderContextOverflow(JSON.stringify({
      error: { type: "invalid_request_error", message: "unsupported parameter" },
    }))).toEqual({ isContextOverflow: false });
  });

  it("allows context reroute only for automatic zero-output connected requests", () => {
    expect(contextOverflowRecoveryEligible({
      isContextOverflow: true, modelVisibleOutputBytes: 0, clientDisconnected: false, automaticRouting: true,
    })).toBe(true);
    expect(contextOverflowRecoveryEligible({
      isContextOverflow: true, modelVisibleOutputBytes: 12, clientDisconnected: false, automaticRouting: true,
    })).toBe(false);
    expect(contextOverflowRecoveryEligible({
      isContextOverflow: true, modelVisibleOutputBytes: 0, clientDisconnected: false, automaticRouting: false,
    })).toBe(false);
    expect(contextOverflowRecoveryEligible({
      isContextOverflow: true, modelVisibleOutputBytes: 0, clientDisconnected: true, automaticRouting: true,
    })).toBe(false);
  });

  it("reroutes a zero-output context overflow across canonical models", async () => {
    const alternate = { ...profile, executionProfileId: "alternate:sol", modelId: "gpt-5.6-sol", channel: "sol" };
    const calls: string[] = [];
    const failed: string[] = [];
    const handle = (attemptIndex: number, selected: AlphaExecutionProfile): ProviderAttemptHandle => ({
      attemptId: `attempt-${attemptIndex}`, attemptIndex, startedAt: new Date(), profile: selected,
      adapter: { async execute() {
        calls.push(selected.modelId);
        return selected.modelId === profile.modelId
          ? new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "prompt is too long" } }), { status: 400 })
          : new Response("success", { status: 200 });
      } },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: handle(1, profile), maxAttempts: 3,
      isRecoverableFailure: (failure) => classifyProviderContextOverflow(failure).isContextOverflow,
      selectRecoveryTarget: () => ({ profile: alternate, reason: "context_model_reroute" }),
      startRetry: async (selected, attemptIndex) => handle(attemptIndex, selected),
      recordFailedAttempt: async ({ attempt }) => { failed.push(attempt.profile.modelId); },
    });
    expect(await (await adapter.execute(request())).text()).toBe("success");
    expect(calls).toEqual(["test-model", "gpt-5.6-sol"]);
    expect(failed).toEqual(["test-model"]);
  });

  it("does not retry an ordinary Provider 400", async () => {
    let retries = 0;
    const adapter = createRecoveringProviderAdapter({
      initial: {
        attemptId: "attempt-1", attemptIndex: 1, startedAt: new Date(), profile,
        adapter: { async execute() { return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "unsupported parameter" } }), { status: 400 }); } },
      },
      isRecoverableFailure: (failure) => classifyProviderContextOverflow(failure).isContextOverflow,
      selectRecoveryProfile: () => profile,
      startRetry: async () => { retries += 1; throw new Error("must not retry"); },
      recordFailedAttempt: async () => {},
    });
    expect((await adapter.execute(request())).status).toBe(400);
    expect(retries).toBe(0);
  });

  it("limits repeated context overflow reroutes to three Provider Attempts", async () => {
    let calls = 0;
    let recorded = 0;
    const models = [profile, { ...profile, executionProfileId: "terra", modelId: "gpt-5.6-terra" }, { ...profile, executionProfileId: "luna", modelId: "gpt-5.6-luna" }];
    const handle = (attemptIndex: number, selected: AlphaExecutionProfile): ProviderAttemptHandle => ({
      attemptId: `attempt-${attemptIndex}`, attemptIndex, startedAt: new Date(), profile: selected,
      adapter: { async execute() {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "input exceeds the context window" } }), { status: 400 });
      } },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: handle(1, models[0]!), maxAttempts: 3,
      isRecoverableFailure: (failure) => classifyProviderContextOverflow(failure).isContextOverflow,
      selectRecoveryTarget: (current) => {
        const next = models[current.attemptIndex];
        return next ? { profile: next, reason: "context_model_reroute" } : undefined;
      },
      startRetry: async (selected, attemptIndex) => handle(attemptIndex, selected),
      recordFailedAttempt: async () => { recorded += 1; },
    });
    const response = await adapter.execute(request());
    expect(response.status).toBe(400);
    expect(calls).toBe(3);
    expect(recorded).toBe(3);
  });

  it("tries a Channel network fallback before a same-model Channel", async () => {
    const secondaryProfile = { ...profile, executionProfileId: "test:model:secondary", channel: "secondary" };
    const visited: string[] = [];
    const handle = (attemptIndex: number, targetProfile: AlphaExecutionProfile, endpoint: number): ProviderAttemptHandle => ({
      attemptId: `attempt-${attemptIndex}`,
      attemptIndex,
      profile: targetProfile,
      networkEndpointIndex: endpoint,
      networkEndpoint: endpoint === 0 ? "primary.test" : "fallback.test",
      adapter: { async execute() {
        visited.push(`${targetProfile.channel}:${endpoint}`);
        return visited.length < 3 ? new Response("retry", { status: 502 }) : new Response("ok", { status: 200 });
      } },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: handle(1, profile, 0),
      maxAttempts: 3,
      selectRecoveryTarget(current) {
        if (current.profile.channel === "primary" && current.networkEndpointIndex === 0) {
          return { profile, networkEndpointIndex: 1, reason: "network_endpoint_fallback" };
        }
        return { profile: secondaryProfile, networkEndpointIndex: 0, reason: "same_model_channel_fallback" };
      },
      async startRetry(targetProfile, attemptIndex, target) {
        return handle(attemptIndex, targetProfile, target?.networkEndpointIndex ?? 0);
      },
      async recordFailedAttempt() {},
    });
    expect(await (await adapter.execute(request())).text()).toBe("ok");
    expect(visited).toEqual(["primary:0", "primary:1", "secondary:0"]);
  });

  it("retries one recoverable response before client-visible output", async () => {
    let calls = 0;
    const failed: number[] = [];
    const selected: number[] = [];
    const handles = (attemptIndex: number): ProviderAttemptHandle => ({
      attemptId: `attempt-${attemptIndex}`,
      attemptIndex,
      profile,
      adapter: {
        async execute() {
          calls += 1;
          return calls === 1
            ? new Response('{"error":"overloaded"}', { status: 503, headers: { "x-request-id": "failed-1" } })
            : new Response("success", { status: 200 });
        },
      },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: handles(1),
      selectRecoveryProfile: () => profile,
      async startRetry(_profile, attemptIndex) { return handles(attemptIndex); },
      async recordFailedAttempt(input) { failed.push(input.response?.status ?? 0); },
      onSelected(attempt) { selected.push(attempt.attemptIndex); },
    });

    const response = await adapter.execute(request());
    expect(await response.text()).toBe("success");
    expect(calls).toBe(2);
    expect(failed).toEqual([503]);
    expect(selected).toEqual([2]);
  });

  it("allows a Web-specific pre-stream error to use the configured recovery path", async () => {
    let calls = 0;
    const handles = (attemptIndex: number): ProviderAttemptHandle => ({
      attemptId: `attempt-${attemptIndex}`,
      attemptIndex,
      profile,
      adapter: {
        async execute() {
          calls += 1;
          return calls === 1
            ? new Response('{"error":"web search unavailable"}', { status: 422 })
            : new Response("success", { status: 200 });
        },
      },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: handles(1),
      isRecoverableResponse: (response) => response.status === 422,
      selectRecoveryProfile: () => profile,
      async startRetry(_profile, attemptIndex) { return handles(attemptIndex); },
      async recordFailedAttempt() {},
    });

    expect(await (await adapter.execute(request())).text()).toBe("success");
    expect(calls).toBe(2);
  });

  it("honors the configured Provider Attempt budget", async () => {
    let calls = 0;
    const adapterFor = (attemptIndex: number): ProviderAttemptHandle => ({
      attemptId: `attempt-${attemptIndex}`,
      attemptIndex,
      profile,
      adapter: { async execute() { calls += 1; return new Response("failed", { status: 503 }); } },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: adapterFor(1),
      maxAttempts: 3,
      selectRecoveryProfile: () => profile,
      async startRetry(_profile, attemptIndex) { return adapterFor(attemptIndex); },
      async recordFailedAttempt() {},
    });
    const response = await adapter.execute(request());
    expect(response.status).toBe(503);
    expect(calls).toBe(3);
  });

  it("does not recover after a successful streaming response has been selected", async () => {
    let calls = 0;
    let retries = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("event: message\ndata: visible\n\n"));
        controller.error(new Error("stream interrupted"));
      },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: {
        attemptId: "attempt-1",
        attemptIndex: 1,
        profile,
        adapter: { async execute() { calls += 1; return new Response(stream, { status: 200 }); } },
      },
      selectRecoveryProfile: () => profile,
      async startRetry() {
        retries += 1;
        throw new Error("must not retry");
      },
      async recordFailedAttempt() {},
    });
    const response = await adapter.execute(request());
    await expect(response.text()).rejects.toThrow("stream interrupted");
    expect(calls).toBe(1);
    expect(retries).toBe(0);
  });

  it("classifies rate limits and all Provider 5xx statuses as recoverable", () => {
    expect([429, 500, 502, 503, 504, 520, 524, 527].every(isRecoverableProviderStatus)).toBe(true);
    expect([200, 400, 401, 403, 404, 422].some(isRecoverableProviderStatus)).toBe(false);
  });

  it("keys attempts by Profile, endpoint, and reasoning variant", () => {
    expect(providerAttemptIdentity({ executionProfileId: "profile-a", networkEndpoint: "primary" }))
      .not.toBe(providerAttemptIdentity({ executionProfileId: "profile-b", networkEndpoint: "primary" }));
    expect(providerAttemptIdentity({ executionProfileId: "profile-a", networkEndpoint: "secondary" }))
      .not.toBe(providerAttemptIdentity({ executionProfileId: "profile-a", networkEndpoint: "primary" }));
    expect(providerAttemptIdentity({ executionProfileId: "profile-a", networkEndpoint: "primary", reasoningFallback: "default" }))
      .not.toBe(providerAttemptIdentity({ executionProfileId: "profile-a", networkEndpoint: "primary" }));
  });

  it("recovers from a 524 HTML response without treating error bytes as model output", async () => {
    let calls = 0;
    let failure: Parameters<NonNullable<Parameters<typeof createRecoveringProviderAdapter>[0]["recordFailedAttempt"]>>[0] | undefined;
    const handle = (attemptIndex: number): ProviderAttemptHandle => ({
      attemptId: `attempt-${attemptIndex}`, attemptIndex, profile,
      adapter: { async execute() {
        calls += 1;
        return calls === 1
          ? new Response("<html>cloudflare timeout</html>", { status: 524, headers: { "content-type": "text/html", "cf-ray": "fixture" } })
          : new Response("ok", { status: 200 });
      } },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: handle(1), maxAttempts: 3,
      selectRecoveryProfile: () => profile,
      async startRetry(_profile, index) { return handle(index); },
      async recordFailedAttempt(input) { failure = input; },
    });
    expect(await (await adapter.execute(request())).text()).toBe("ok");
    expect(failure?.response?.observation).toMatchObject({ rawResponseBytes: 31, modelVisibleOutputBytes: 0 });
  });

  it("uses the header watchdog before a recovery target is selected", async () => {
    let calls = 0;
    const slow = (attemptIndex: number): ProviderAttemptHandle => ({
      attemptId: `attempt-${attemptIndex}`, attemptIndex, profile,
      adapter: { async execute(input) {
        calls += 1;
        if (calls > 1) return new Response("data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
        return new Promise<Response>((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
      } },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: slow(1), maxAttempts: 2, hasRecoveryTarget: () => true, firstModelEventDeadlineMs: () => 10,
      selectRecoveryProfile: () => profile,
      async startRetry(_profile, index) { return slow(index); },
      async recordFailedAttempt(input) { expect((input.error as ProviderPreOutputError).code).toBe("header_timeout"); },
    });
    const response = await adapter.execute(request());
    expect(await response.text()).toContain("output_text.delta");
    expect(calls).toBe(2);
  });

  it("arms the watchdog and finalizes the only attempt without a recovery target", async () => {
    let aborted = false;
    let recorded = 0;
    const adapter = createRecoveringProviderAdapter({
      initial: {
        attemptId: "attempt-1", attemptIndex: 1, profile,
        adapter: { async execute(input) {
          input.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
          await new Promise((resolve) => setTimeout(resolve, 20));
          return new Response("ok", { status: 200 });
        } },
      },
      hasRecoveryTarget: () => false,
      firstModelEventDeadlineMs: () => 5,
      async startRetry() { throw new Error("must not retry"); },
      async recordFailedAttempt(input) {
        recorded += 1;
        expect((input.error as ProviderPreOutputError).code).toBe("header_timeout");
      },
    });
    await expect(adapter.execute(request())).rejects.toMatchObject({ code: "header_timeout" });
    expect(aborted).toBe(true);
    expect(recorded).toBe(1);
  });

  it("uses the current Profile deadline after fallback", async () => {
    const second = { ...profile, executionProfileId: "test:model:second", channel: "second" };
    const deadlines: string[] = [];
    const handle = (attemptIndex: number, selected: AlphaExecutionProfile): ProviderAttemptHandle => ({
      attemptId: `attempt-${attemptIndex}`, attemptIndex, profile: selected,
      adapter: { async execute(input) {
        if (selected === second) return new Response("ok", { status: 200 });
        return new Promise<Response>((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
      } },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: handle(1, profile), maxAttempts: 2,
      firstModelEventDeadlineMs(attempt) {
        deadlines.push(attempt.profile.executionProfileId);
        return attempt.profile === profile ? 5 : 50;
      },
      selectRecoveryTarget: () => ({ profile: second, reason: "same_model_channel_fallback" }),
      startRetry: async (selected, index) => handle(index, selected),
      recordFailedAttempt: async () => {},
    });
    expect(await (await adapter.execute(request())).text()).toBe("ok");
    expect(deadlines).toEqual([profile.executionProfileId, second.executionProfileId]);
  });

  it("allows a fourth attempt to succeed", async () => {
    let calls = 0;
    const profiles = Array.from({ length: 4 }, (_, index) => ({
      ...profile, executionProfileId: `profile-${index + 1}`, channel: `channel-${index + 1}`,
    }));
    const handle = (index: number, selected: AlphaExecutionProfile): ProviderAttemptHandle => ({
      attemptId: `attempt-${index}`, attemptIndex: index, profile: selected,
      adapter: { async execute() {
        calls += 1;
        return calls < 4 ? new Response("failed", { status: 503 }) : new Response("ok", { status: 200 });
      } },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: handle(1, profiles[0]!), maxAttempts: 5,
      selectRecoveryTarget(current) {
        const next = profiles[current.attemptIndex];
        return next ? { profile: next, reason: "same_model_channel_fallback" } : undefined;
      },
      startRetry: async (selected, index) => handle(index, selected),
      recordFailedAttempt: async () => {},
    });
    expect(await (await adapter.execute(request())).text()).toBe("ok");
    expect(calls).toBe(4);
  });

  it("stops on the recovery time budget and records the final attempt", async () => {
    const decisions: string[] = [];
    let retries = 0;
    const adapter = createRecoveringProviderAdapter({
      initial: {
        attemptId: "attempt-1", attemptIndex: 1, profile,
        adapter: { async execute() { return new Response("failed", { status: 503 }); } },
      },
      maxAttempts: 5, recoveryBudgetMs: 10, minimumAttemptBudgetMs: 20,
      selectRecoveryProfile: () => profile,
      startRetry: async () => { retries += 1; throw new Error("must not retry"); },
      recordFailedAttempt: async (input) => { expect(input.timeBudgetExhausted).toBe(true); },
      recordRecoveryDecision: async (input) => { decisions.push(input.recoveryDecision); },
    });
    expect((await adapter.execute(request())).status).toBe(503);
    expect(retries).toBe(0);
    expect(decisions).toEqual(["recovery_budget_exhausted"]);
  });

  it("preserves HTTP 200 headers and observations for an empty SSE stream", async () => {
    let failure: ProviderPreOutputError | undefined;
    const adapter = createRecoveringProviderAdapter({
      initial: {
        attemptId: "attempt-1", attemptIndex: 1, profile, networkEndpoint: "primary.test",
        adapter: { async execute() {
          return new Response("", { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "empty-1" } });
        } },
      },
      firstModelEventDeadlineMs: () => 50,
      startRetry: async () => { throw new Error("must not retry"); },
      recordFailedAttempt: async (input) => { failure = input.error as ProviderPreOutputError; },
    });
    await expect(adapter.execute(request())).rejects.toMatchObject({ code: "stream_ended_before_model_event" });
    expect(failure).toMatchObject({
      code: "stream_ended_before_model_event",
      details: { upstreamStatus: 200, providerRequestId: "empty-1", endpoint: "primary.test" },
      observation: { rawResponseBytes: 0, modelVisibleOutputBytes: 0 },
    });
  });

  it("applies the first-model-event deadline to an SSE 5xx response body", async () => {
    let failure: ProviderPreOutputError | undefined;
    const adapter = createRecoveringProviderAdapter({
      initial: {
        attemptId: "attempt-1", attemptIndex: 1, profile,
        adapter: { async execute(input) {
          const body = new ReadableStream({ start(controller) {
            input.signal.addEventListener("abort", () => controller.error(input.signal.reason), { once: true });
          } });
          return new Response(body, { status: 503, headers: { "content-type": "text/event-stream" } });
        } },
      },
      firstModelEventDeadlineMs: () => 5,
      startRetry: async () => { throw new Error("must not retry"); },
      recordFailedAttempt: async (input) => { failure = input.error as ProviderPreOutputError; },
    });
    await expect(adapter.execute(request())).rejects.toMatchObject({ code: "slow_first_model_event" });
    expect(failure).toMatchObject({ details: { upstreamStatus: 503 } });
  });

  it("disarms the watchdog after the first valid model event", async () => {
    let retries = 0;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(Buffer.from("data: {\"type\":\"response.output_text.delta\",\"delta\":\"first\"}\n\n"));
        await new Promise((resolve) => setTimeout(resolve, 25));
        controller.enqueue(Buffer.from("data: {\"type\":\"response.output_text.delta\",\"delta\":\"second\"}\n\n"));
        controller.close();
      },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: {
        attemptId: "attempt-1", attemptIndex: 1, profile,
        adapter: { async execute() { return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }); } },
      },
      hasRecoveryTarget: () => true,
      firstModelEventDeadlineMs: () => 10,
      selectRecoveryProfile: () => profile,
      async startRetry() { retries += 1; throw new Error("must not retry"); },
      async recordFailedAttempt() { throw new Error("must not record a failure"); },
    });
    const body = await (await adapter.execute(request())).text();
    expect(body).toContain("first");
    expect(body).toContain("second");
    expect(retries).toBe(0);
  });

  it("uses a network endpoint fallback before another Channel of the same model", async () => {
    const order: string[] = [];
    const secondChannel = { ...profile, executionProfileId: "test:model:second", channel: "second" };
    const handle = (attemptIndex: number, selectedProfile: AlphaExecutionProfile, endpoint: number): ProviderAttemptHandle => ({
      attemptId: `attempt-${attemptIndex}`,
      attemptIndex,
      profile: selectedProfile,
      networkEndpointIndex: endpoint,
      adapter: { async execute() {
        order.push(`${selectedProfile.channel}:${endpoint}`);
        return order.length < 3 ? new Response("failed", { status: 502 }) : new Response("ok", { status: 200 });
      } },
    });
    const adapter = createRecoveringProviderAdapter({
      initial: handle(1, profile, 0),
      maxAttempts: 3,
      selectRecoveryTarget(current) {
        return current.attemptIndex === 1
          ? { profile, networkEndpointIndex: 1, reason: "network_endpoint_fallback" }
          : { profile: secondChannel, networkEndpointIndex: 0, reason: "same_model_channel_fallback" };
      },
      async startRetry(nextProfile, attemptIndex, target) {
        return handle(attemptIndex, nextProfile, target?.networkEndpointIndex ?? 0);
      },
      async recordFailedAttempt() {},
    });
    expect(await (await adapter.execute(request())).text()).toBe("ok");
    expect(order).toEqual(["primary:0", "primary:1", "second:0"]);
  });
});

describe("first model event deadline", () => {
  it("uses a bounded p95 only for a stable 24-hour sample", () => {
    expect(computeFirstModelEventDeadlineMs({
      estimatedInputTokens: 20_000,
      successfulLatenciesMs: Array.from({ length: 10 }, (_, index) => 20_000 + index * 100),
      recentErrorClasses: [],
      profileState: "healthy",
    })).toBe(31_350);
  });

  it("does not reward a volatile profile with a longer wait", () => {
    expect(computeFirstModelEventDeadlineMs({
      estimatedInputTokens: 20_000,
      successfulLatenciesMs: [10_000, 10_000, 10_000, 10_000, 10_000, 11_000, 12_000, 20_000, 60_000, 80_000],
      recentErrorClasses: ["provider_edge_timeout", "slow_first_model_event", "none"],
      profileState: "degraded",
    })).toBe(45_000);
  });
});
