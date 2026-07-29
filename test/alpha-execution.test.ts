import { describe, expect, it } from "vitest";
import {
  createRecoveringProviderAdapter,
  isRecoverableProviderStatus,
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

  it("classifies only P0 transient HTTP statuses as recoverable", () => {
    expect([429, 500, 502, 503, 504].every(isRecoverableProviderStatus)).toBe(true);
    expect([200, 400, 401, 403, 404, 422].some(isRecoverableProviderStatus)).toBe(false);
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
