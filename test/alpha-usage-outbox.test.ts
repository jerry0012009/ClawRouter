import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PendingUsageReport } from "../src/alpha/repository.js";
import {
  UsageOutboxWorker,
  signUsageFinalizeBody,
  usageFinalizeBody,
} from "../src/alpha/usage-outbox.js";

function report(overrides: Partial<PendingUsageReport> = {}): PendingUsageReport {
  return {
    usageReportId: "usage_1",
    logicalRequestId: "req_1",
    reportIdempotencyKey: "report_key_1",
    newapiUserId: "17",
    newapiTokenId: "29",
    newapiLogId: "newapi_req_1",
    actualModel: "claude-sonnet-test",
    provider: "closeai",
    channel: "closeai-anthropic-primary",
    inputTokens: 100n,
    cachedInputTokens: 20n,
    outputTokens: 30n,
    reasoningTokens: 5n,
    judgeCostUsd: "0.0002000000",
    providerCostUsd: "0.0008000000",
    failedBilledCostUsd: "0.0000000000",
    finalUserCostUsd: "0.0010000000",
    costBreakdown: { judge: "0.0002000000", provider: "0.0008000000" },
    sendAttemptCount: 1,
    ...overrides,
  };
}

describe("Alpha Usage Finalize outbox", () => {
  it("serializes the authoritative report and signs the exact bytes", () => {
    const body = usageFinalizeBody(report());
    const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      report_idempotency_key: "report_key_1",
      logical_request_id: "req_1",
      actual_model: "claude-sonnet-test",
      final_user_cost_usd: "0.0010000000",
      usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_tokens: 5 },
    });
    const signed = signUsageFinalizeBody(body, "2026-07-29T12:00:00.000Z", "test-only-shared-secret");
    const expected = createHmac("sha256", "test-only-shared-secret")
      .update(`2026-07-29T12:00:00.000Z\n${signed.bodySha256}`).digest("hex");
    expect(signed.signature).toBe(expected);
  });

  it("acknowledges successful delivery and never exposes the shared secret", async () => {
    const acknowledge = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).not.toEqual(expect.objectContaining({ authorization: expect.anything() }));
      expect(JSON.stringify(init)).not.toContain("test-only-shared-secret");
      return new Response(JSON.stringify({ status: "acknowledged", already_processed: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const worker = new UsageOutboxWorker({
      repository: {
        claimUsageReports: vi.fn(async () => [report()]),
        acknowledgeUsageReport: acknowledge,
        failUsageReport: fail,
      },
      baseUrl: "http://new-api:3000/",
      sharedSecret: "test-only-shared-secret",
      fetch: fetchMock,
    });
    expect(await worker.runOnce()).toBe(1);
    expect(acknowledge).toHaveBeenCalledWith("usage_1");
    expect(fail).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("http://new-api:3000/internal/acu/usage/finalize", expect.any(Object));
  });

  it("persists a retry instead of failing the accepted client response", async () => {
    const acknowledge = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const worker = new UsageOutboxWorker({
      repository: {
        claimUsageReports: vi.fn(async () => [report({ sendAttemptCount: 2 })]),
        acknowledgeUsageReport: acknowledge,
        failUsageReport: fail,
      },
      baseUrl: "http://new-api:3000",
      sharedSecret: "test-only-shared-secret",
      fetch: vi.fn(async () => new Response("temporarily unavailable", { status: 503 })) as typeof fetch,
    });
    await expect(worker.runOnce()).resolves.toBe(1);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith("usage_1", "New API Usage Finalize returned HTTP 503", 10);
  });
});
