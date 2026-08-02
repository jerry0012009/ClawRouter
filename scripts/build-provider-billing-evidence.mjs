#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const inputs = (outputIndex >= 0 ? args.slice(0, outputIndex) : args).map((value) => {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid provider input ${value}; expected provider=path`);
  }
  return { provider: value.slice(0, separator), path: value.slice(separator + 1) };
});
if (inputs.length === 0 || !outputPath) {
  throw new Error("usage: build-provider-billing-evidence.mjs provider=ledger.json [...] --output report.json");
}

const componentFields = [
  ["inputPricePerMillion", "input_tokens", "input_cost"],
  ["outputPricePerMillion", "output_tokens", "output_cost"],
  ["cachedInputPricePerMillion", "cache_read_tokens", "cache_read_cost"],
  ["cacheWritePricePerMillion", "cache_creation_tokens", "cache_creation_cost"],
];

function rounded(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function modalRates(items) {
  const models = new Map();
  for (const item of items) {
    if (!models.has(item.model)) models.set(item.model, { records: 0, multipliers: new Set(), components: {} });
    const model = models.get(item.model);
    model.records += 1;
    if (Number.isFinite(item.rate_multiplier)) model.multipliers.add(item.rate_multiplier);
    for (const [name, tokenField, costField] of componentFields) {
      const tokens = Number(item[tokenField] ?? 0);
      const cost = Number(item[costField] ?? 0);
      if (!(tokens > 0) || !(cost > 0)) continue;
      const rate = rounded(cost * 1_000_000 / tokens);
      const counts = model.components[name] ?? new Map();
      counts.set(rate, (counts.get(rate) ?? 0) + 1);
      model.components[name] = counts;
    }
  }
  return [...models.entries()].map(([model, evidence]) => ({
    model,
    records: evidence.records,
    observedBillingMultipliers: [...evidence.multipliers].sort((a, b) => a - b),
    componentRates: Object.fromEntries(Object.entries(evidence.components).map(([name, counts]) => {
      const alternatives = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      return [name, { modalRate: alternatives[0][0], samples: alternatives[0][1], alternatives: alternatives.slice(1, 4).map(([rate, samples]) => ({ rate, samples })) }];
    })),
  })).sort((a, b) => b.records - a.records || a.model.localeCompare(b.model));
}

function providerEvidence(path, provider, cashCnyPerCredit) {
  const input = JSON.parse(readFileSync(path, "utf8"));
  const totalCost = Number(input.stats?.total_cost ?? 0);
  const actualCost = Number(input.stats?.total_actual_cost ?? 0);
  const ratioFailures = input.items.filter((item) => Number.isFinite(item.rate_multiplier)
    && Math.abs(Number(item.actual_cost) - Number(item.total_cost) * Number(item.rate_multiplier)) > 1e-8).length;
  return {
    provider,
    source: input.source,
    exportedAt: input.exported_at,
    recordCount: input.record_count,
    cashCnyPerCredit,
    dashboardWindow: {
      startDate: input.models?.start_date ?? null,
      endDate: input.models?.end_date ?? null,
      nominalCredits: totalCost,
      chargedCredits: actualCost,
      chargedCashCny: actualCost * cashCnyPerCredit,
    },
    actualEqualsNominalTimesMultiplier: { checkedRecords: input.items.length, failures: ratioFailures },
    groups: input.groups ?? undefined,
    models: modalRates(input.items),
    dashboardModels: input.models?.models ?? undefined,
  };
}

const cashRatios = { lucen: 1, blackai: 0.14 };
const providers = inputs.map(({ provider, path }) => {
  const cashCnyPerCredit = cashRatios[provider];
  if (cashCnyPerCredit === undefined) throw new Error(`No reviewed cash conversion for provider ${provider}`);
  return providerEvidence(path, provider, cashCnyPerCredit);
});
const report = {
  schemaVersion: "acu-provider-billing-evidence-v1",
  generatedAt: providers.map((provider) => provider.exportedAt).sort().at(-1),
  pricePrecedence: ["verified execution-profile ledger price", "official shared catalog fallback"],
  formula: "cashCny = nominal token cost * observed group multiplier * cashCnyPerCredit",
  providers,
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
