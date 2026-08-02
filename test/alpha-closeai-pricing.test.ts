import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAcuModel } from "../src/acu/catalog.js";
import {
  cashCnyPerNominalUsd,
  validateProviderEconomicsCatalog,
  type ProviderEconomics,
} from "../src/alpha/provider-economics.js";
import {
  resolveProfileBillingPrice,
  type AlphaExecutionProfile,
} from "../src/alpha/routing.js";
import { calculateProviderCost, parseProviderUsage } from "../src/alpha/usage.js";

const economics = validateProviderEconomicsCatalog(JSON.parse(readFileSync(
  new URL("../deploy/alpha/provider-economics.json", import.meta.url), "utf8",
)) as unknown);
const profiles = JSON.parse(readFileSync(
  new URL("../deploy/alpha/execution-profiles.json", import.meta.url), "utf8",
)) as AlphaExecutionProfile[];
const closeai = economics.providers.find((provider) => provider.providerId === "closeai")!;
const lucen = economics.providers.find((provider) => provider.providerId === "lucen")!;
const blackai = economics.providers.find((provider) => provider.providerId === "blackai")!;

function cashCost(
  provider: ProviderEconomics,
  modelId: string,
  inputTokens: bigint,
  outputTokens: bigint,
  billingPrice?: AlphaExecutionProfile["billingPrice"],
): number {
  return Number(calculateProviderCost(modelId, inputTokens, 0n, outputTokens, billingPrice))
    * cashCnyPerNominalUsd(provider);
}

describe("CloseAI public pricing reconciliation", () => {
  it("uses the explicit 1.5 service multiplier and 7.2 CNY/USD conversion", () => {
    expect(closeai.observedBillingMultiplier).toBe(1.5);
    expect(closeai.rechargeCashCny).toBe(7.2);
    expect(closeai.creditsReceivedUsd).toBe(1);
    expect(cashCnyPerNominalUsd(closeai)).toBe(10.8);
  });

  it("prices GPT-5.6 Luna from the official fallback at 0.00008424 CNY", () => {
    expect(cashCost(closeai, "gpt-5.6-luna", 9n, 5n)).toBeCloseTo(0.00008424, 12);
  });

  it("prices Claude Opus 4.8 from the official fallback at 0.001728 CNY", () => {
    expect(cashCost(closeai, "claude-opus-4-8", 12n, 4n)).toBeCloseTo(0.001728, 12);
  });

  it("uses the CloseAI execution-profile override before the official catalog", () => {
    const profile = profiles.find((item) => item.executionProfileId === "closeai-claude-sonnet-5-messages-strong")!;
    expect(getAcuModel("claude-sonnet-5")).toMatchObject({
      inputPricePerMillion: 2,
      outputPricePerMillion: 10,
    });
    expect(resolveProfileBillingPrice(profile)).toMatchObject({
      inputPricePerMillion: 3,
      outputPricePerMillion: 15,
      cachedInputPricePerMillion: 3,
      cacheWritePricePerMillion: 3,
      status: "estimated",
    });
  });

  it("conservatively prices CloseAI Messages cache reads and writes as ordinary input", () => {
    const profile = profiles.find((item) => item.executionProfileId === "closeai-claude-sonnet-5-messages-strong")!;
    const usage = parseProviderUsage({
      protocol: "messages",
      body: Buffer.from(JSON.stringify({
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 1_000_000,
          cache_read_input_tokens: 2_000_000,
          cache_creation_input_tokens: 3_000_000,
          output_tokens: 1_000_000,
        },
      })),
      contentType: "application/json",
      requestedModel: "claude-sonnet-5",
      requestBytes: 0,
      billingPrice: profile.billingPrice,
    });

    expect(getAcuModel("claude-sonnet-5")).toMatchObject({
      cachedInputPricePerMillion: 0.2,
      cacheWritePricePerMillion: 2.5,
    });
    expect(usage).toMatchObject({
      inputTokens: 1_000_000n,
      cachedInputTokens: 5_000_000n,
      cacheCreationInputTokens: 3_000_000n,
      outputTokens: 1_000_000n,
      providerCostUsd: "33.0000000000",
    });
    expect(usage.providerCostUsd).not.toBe("25.9000000000");
  });

  it("falls back to the official catalog before applying 1.5 and 7.2", () => {
    const profile = profiles.find((item) => item.executionProfileId === "closeai-gpt-5.6-luna-responses-value")!;
    expect(profile.billingPrice).toBeUndefined();
    expect(resolveProfileBillingPrice(profile)).toMatchObject({
      inputPricePerMillion: 0.2,
      outputPricePerMillion: 1.2,
    });
    expect(cashCost(closeai, profile.modelId, 9n, 5n, profile.billingPrice)).toBeCloseTo(0.00008424, 12);
  });

  it("does not change existing Lucen or BlackAI ledger economics", () => {
    expect(cashCnyPerNominalUsd(lucen)).toBe(0.06);
    expect(cashCnyPerNominalUsd(blackai)).toBe(0.14);
    const lucenProfile = profiles.find((item) => item.executionProfileId === "lucen-cn-models-k3-015:glm-5.2:responses")!;
    expect(resolveProfileBillingPrice(lucenProfile)).toMatchObject({
      inputPricePerMillion: 8,
      outputPricePerMillion: 28,
      cachedInputPricePerMillion: 2,
    });
    expect(cashCost(lucen, lucenProfile.modelId, 1_000_000n, 100_000n, lucenProfile.billingPrice))
      .toBeCloseTo(0.648, 12);
    expect(cashCost(blackai, "gpt-5.6-sol", 1_000_000n, 100_000n))
      .toBeCloseTo(1.12, 12);
  });

  it("adds no CloseAI profile or override for DeepSeek without an existing profile", () => {
    expect(profiles.some((profile) => profile.provider === "closeai" && profile.modelId === "deepseek-v4-flash")).toBe(false);
    expect(profiles.filter((profile) => profile.provider === "closeai" && profile.billingPrice)
      .map((profile) => profile.modelId)).toEqual(["claude-sonnet-5"]);
  });
});
