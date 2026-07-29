import { readFile } from "node:fs/promises";

export type ProviderEconomicsHealth = "healthy" | "degraded" | "cooldown" | "blocked";

export type ProviderEconomics = {
  providerId: string;
  displayName: string;
  protocol: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  balanceCurrency: "USD-denominated credits";
  rechargeCashCny: number | null;
  creditsReceivedUsd: number | null;
  observedBillingMultiplier: number;
  priceSource: string;
  priceObservedAt: string;
  health: ProviderEconomicsHealth;
  priority: number;
  enabled: boolean;
  effectiveCostStatus: "verified" | "estimated";
  effectiveCostSource: string;
  effectiveCostVersion: string;
};

export type ProviderEconomicsCatalog = {
  schemaVersion: "acu-provider-economics-v1";
  generatedAt: string;
  providers: ProviderEconomics[];
};

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function validateProviderEconomicsCatalog(value: unknown): ProviderEconomicsCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider economics must be an object");
  const catalog = value as Partial<ProviderEconomicsCatalog>;
  if (catalog.schemaVersion !== "acu-provider-economics-v1" || !Array.isArray(catalog.providers)) {
    throw new Error("Unsupported provider economics schema");
  }
  const ids = new Set<string>();
  for (const provider of catalog.providers) {
    if (!provider.providerId || ids.has(provider.providerId)) throw new Error("Provider economics IDs must be unique");
    ids.add(provider.providerId);
    if (!finitePositive(provider.observedBillingMultiplier)) throw new Error(`${provider.providerId}: invalid billing multiplier`);
    if ((provider.rechargeCashCny === null) !== (provider.creditsReceivedUsd === null)) {
      throw new Error(`${provider.providerId}: recharge cash and credits must both be present or absent`);
    }
    if (provider.rechargeCashCny !== null
      && (!finitePositive(provider.rechargeCashCny) || !finitePositive(provider.creditsReceivedUsd))) {
      throw new Error(`${provider.providerId}: invalid recharge batch`);
    }
    if (provider.enabled && (provider.health === "blocked" || provider.rechargeCashCny === null)) {
      throw new Error(`${provider.providerId}: enabled economics requires a usable cash conversion`);
    }
  }
  return catalog as ProviderEconomicsCatalog;
}

export async function readProviderEconomicsCatalog(path: string): Promise<ProviderEconomicsCatalog> {
  return validateProviderEconomicsCatalog(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export function cashCnyPerNominalUsd(provider: ProviderEconomics): number {
  if (provider.rechargeCashCny === null || provider.creditsReceivedUsd === null) return Number.POSITIVE_INFINITY;
  return provider.observedBillingMultiplier * provider.rechargeCashCny / provider.creditsReceivedUsd;
}

export function providerCreditCashCostCny(provider: ProviderEconomics): number {
  if (provider.rechargeCashCny === null || provider.creditsReceivedUsd === null) return Number.POSITIVE_INFINITY;
  return provider.rechargeCashCny / provider.creditsReceivedUsd;
}

export function providerCostBreakdown(provider: ProviderEconomics, nominalProviderCostUsd: number): {
  nominalProviderCostUsd: number;
  providerBalanceCharge: number;
  providerBalanceCurrency: "USD-denominated credits";
  providerCreditCashCostCny: number;
  effectiveCashCostCny: number;
  effectiveCostStatus: "verified" | "estimated";
  effectiveCostSource: string;
  effectiveCostVersion: string;
} {
  const nominal = Math.max(0, nominalProviderCostUsd);
  return {
    nominalProviderCostUsd: nominal,
    providerBalanceCharge: nominal * provider.observedBillingMultiplier,
    providerBalanceCurrency: provider.balanceCurrency,
    providerCreditCashCostCny: providerCreditCashCostCny(provider),
    effectiveCashCostCny: nominal * cashCnyPerNominalUsd(provider),
    effectiveCostStatus: provider.effectiveCostStatus,
    effectiveCostSource: provider.effectiveCostSource,
    effectiveCostVersion: provider.effectiveCostVersion,
  };
}
