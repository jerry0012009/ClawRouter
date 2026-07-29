import { createHash, createHmac } from "node:crypto";
import type { AlphaRepository, PendingUsageReport } from "./repository.js";

export type UsageFinalizeClientOptions = {
  baseUrl: string;
  sharedSecret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type UsageOutboxOptions = UsageFinalizeClientOptions & {
  repository: Pick<AlphaRepository, "claimUsageReports" | "acknowledgeUsageReport" | "failUsageReport">;
  intervalMs?: number;
  batchSize?: number;
};

function safeTokenCount(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) throw new Error("Usage token count exceeds JSON safe integer range");
  return converted;
}

export function usageFinalizeBody(report: PendingUsageReport): Buffer {
  return Buffer.from(JSON.stringify({
    report_idempotency_key: report.reportIdempotencyKey,
    newapi_user_id: report.newapiUserId,
    newapi_token_id: report.newapiTokenId ?? "",
    newapi_log_id: report.newapiLogId ?? "",
    logical_request_id: report.logicalRequestId,
    actual_model: report.actualModel ?? "",
    provider: report.provider ?? "",
    channel: report.channel ?? "",
    usage: {
      input_tokens: safeTokenCount(report.inputTokens),
      cached_input_tokens: safeTokenCount(report.cachedInputTokens),
      output_tokens: safeTokenCount(report.outputTokens),
      reasoning_tokens: safeTokenCount(report.reasoningTokens),
    },
    judge_cost_usd: report.judgeCostUsd,
    provider_cost_usd: report.providerCostUsd,
    failed_billed_cost_usd: report.failedBilledCostUsd,
    final_user_cost_usd: report.finalUserCostUsd,
    nominal_provider_cost_usd: report.nominalProviderCostUsd,
    provider_balance_charge: report.providerBalanceCharge,
    provider_balance_currency: report.providerBalanceCurrency,
    provider_credit_cash_cost_cny: report.providerCreditCashCostCny,
    effective_provider_cash_cost_cny: report.effectiveProviderCashCostCny,
    judge_cash_cost_cny: report.judgeCashCostCny,
    failed_attempt_cash_cost_cny: report.failedAttemptCashCostCny,
    actual_total_cash_cost_cny: report.actualTotalCashCostCny,
    user_charge_cny: report.userChargeCny,
    counterfactual_quality_ceiling_cost_cny: report.counterfactualQualityCeilingCostCny,
    cost_breakdown: report.costBreakdown,
  }));
}

export function signUsageFinalizeBody(body: Uint8Array, timestamp: string, sharedSecret: string): {
  bodySha256: string;
  signature: string;
} {
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", sharedSecret)
    .update(`${timestamp}\n${bodySha256}`)
    .digest("hex");
  return { bodySha256, signature };
}

export async function sendUsageFinalize(
  report: PendingUsageReport,
  options: UsageFinalizeClientOptions,
): Promise<void> {
  if (!options.sharedSecret) throw new Error("New API finalize shared secret is not configured");
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const body = usageFinalizeBody(report);
  const timestamp = new Date().toISOString();
  const signed = signUsageFinalizeBody(body, timestamp, options.sharedSecret);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await (options.fetch ?? fetch)(`${baseUrl}/internal/acu/usage/finalize`, {
      method: "POST",
      body: body.toString("utf8"),
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        "x-acu-timestamp": timestamp,
        "x-acu-body-sha256": signed.bodySha256,
        "x-acu-signature": signed.signature,
      },
    });
    if (!response.ok) throw new Error(`New API Usage Finalize returned HTTP ${response.status}`);
    const payload = await response.json() as { status?: unknown };
    if (payload.status !== "acknowledged") throw new Error("New API Usage Finalize acknowledgment is invalid");
  } finally {
    clearTimeout(timeout);
  }
}

export class UsageOutboxWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly options: UsageOutboxOptions) {}

  async runOnce(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      const reports = await this.options.repository.claimUsageReports(this.options.batchSize ?? 10);
      for (const report of reports) {
        try {
          await sendUsageFinalize(report, this.options);
          await this.options.repository.acknowledgeUsageReport(report.usageReportId);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown Usage Finalize error";
          const retrySeconds = Math.min(300, 5 * (2 ** Math.min(report.sendAttemptCount - 1, 6)));
          await this.options.repository.failUsageReport(report.usageReportId, message, retrySeconds);
        }
      }
      return reports.length;
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.runOnce();
    this.timer = setInterval(() => { void this.runOnce(); }, this.options.intervalMs ?? 2_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
