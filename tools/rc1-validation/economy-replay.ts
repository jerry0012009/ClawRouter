#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { selectValueRoute } from "../../src/acu/decision.js";
import type { RoutingPreference, RoutingPreferenceParameters } from "../../src/alpha/routing.js";

type Json = Record<string, unknown>;
type Row = {
  routeDecisionId: string;
  preference: RoutingPreference;
  formulaInputs: Json;
  candidates: Json[];
  selectedProfile: Json;
  createdAt: string;
  observedFallbackCount: number;
};

const PARAMETERS: Record<"old" | "current", Record<RoutingPreference, RoutingPreferenceParameters>> = {
  old: {
    economy: { qualityTargetOffset: -12, costSensitivity: 3, fallbackRiskScale: 0 },
    balanced: { qualityTargetOffset: -3, costSensitivity: 1.4, fallbackRiskScale: 0.25 },
    quality: { qualityTargetOffset: 8, costSensitivity: 0.45, fallbackRiskScale: 1.25 },
  },
  current: {
    economy: { qualityTargetOffset: -6, costSensitivity: 1.8, fallbackRiskScale: 0.35 },
    balanced: { qualityTargetOffset: -3, costSensitivity: 1.4, fallbackRiskScale: 0.25 },
    quality: { qualityTargetOffset: 8, costSensitivity: 0.45, fallbackRiskScale: 1.25 },
  },
};

const number = (value: unknown): number => Number(value ?? 0);
const string = (value: unknown): string => typeof value === "string" ? value : "";

function replay(row: Row, parameters: RoutingPreferenceParameters) {
  const baseTarget = number(row.formulaInputs.baseEffectiveQualityTarget)
    || number(row.formulaInputs.effectiveQualityTarget)
    || 80;
  const target = Math.max(0, Math.min(100, baseTarget + parameters.qualityTargetOffset));
  const switchCost = number(row.formulaInputs.effectiveSwitchCostCny);
  const judgeCost = number(row.formulaInputs.effectiveJudgeCostCny);
  const flagship = row.candidates.reduce((best, item) =>
    number(item.predictedScore) > number(best.predictedScore) ? item : best, row.candidates[0]!);
  const fallbackCallCost = number(flagship.estimatedCallCost);
  const candidates = row.candidates.map((candidate) => {
    const lower = number(candidate.conservativeQuality);
    const callCost = number(candidate.estimatedCallCost);
    const expectedFallbackCost = parameters.fallbackRiskScale * (1 - lower) * (fallbackCallCost + switchCost);
    return {
      ...candidate,
      modelId: string(candidate.modelId),
      displayName: string(candidate.displayName) || string(candidate.modelId),
      predictedScore: number(candidate.predictedScore),
      conservativeScore: number(candidate.conservativeScore),
      riskAdjustedCost: judgeCost + callCost + expectedFallbackCost,
      estimatedCallCost: callCost,
      expectedFallbackCost,
      expectedTotalCost: judgeCost + callCost + expectedFallbackCost,
      estimatedQuality: number(candidate.estimatedQuality),
      bestExecutionProfileId: string(candidate.bestExecutionProfileId),
    };
  });
  const selection = selectValueRoute(candidates, target, parameters.costSensitivity).selected;
  return {
    model: selection.modelId,
    channel: selection.bestExecutionProfileId,
    predictedQuality: selection.estimatedQuality,
    target,
    targetHit: selection.estimatedQuality >= target / 100,
    expectedCost: selection.estimatedCallCost,
    expectedCostIncludingFallback: selection.expectedTotalCost,
    expectedFallbackCount: 1 - number(selection.conservativeQuality),
  };
}

function aggregate(items: Array<ReturnType<typeof replay>>) {
  const total = Math.max(1, items.length);
  return {
    samples: items.length,
    qualityTargetHitRate: items.filter((item) => item.targetHit).length / total,
    meanPredictedQuality: items.reduce((sum, item) => sum + item.predictedQuality, 0) / total,
    expectedCost: items.reduce((sum, item) => sum + item.expectedCost, 0),
    expectedCostIncludingFallback: items.reduce((sum, item) => sum + item.expectedCostIncludingFallback, 0),
    expectedFallbackCount: items.reduce((sum, item) => sum + item.expectedFallbackCount, 0),
  };
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3] ?? "reports/economy-v04-replay.json";
  if (!inputPath) throw new Error("Usage: economy-replay.ts <route-decisions.json> [output.json]");
  const rows = JSON.parse(await readFile(inputPath, "utf8")) as Row[];
  const usable = rows.filter((row) => row.candidates.length > 0 && row.formulaInputs.judge);
  const versions = Object.fromEntries((["old", "current"] as const).map((version) => [version,
    Object.fromEntries((["economy", "balanced", "quality"] as const).map((preference) => {
      const selected = usable.map((row) => replay(row, PARAMETERS[version][preference]));
      return [preference, aggregate(selected)];
    }))]));
  const economyRows = usable.filter((row) => row.preference === "economy");
  const comparisons = economyRows.map((row) => {
    const old = replay(row, PARAMETERS.old.economy);
    const current = replay(row, PARAMETERS.current.economy);
    return { routeDecisionId: row.routeDecisionId, createdAt: row.createdAt,
      difficulty: number((row.formulaInputs.judge as Json).difficultyIndex), old, current,
      modelChanged: old.model !== current.model, channelChanged: old.channel !== current.channel };
  });
  const buckets = Object.fromEntries(["0-39", "40-59", "60-79", "80-100"].map((label) => {
    const [lower, upper] = label.split("-").map(Number);
    const rowsInBucket = comparisons.filter((item) => item.difficulty >= lower! && item.difficulty <= upper!);
    return [label, { samples: rowsInBucket.length, old: aggregate(rowsInBucket.map((item) => item.old)),
      current: aggregate(rowsInBucket.map((item) => item.current)) }];
  }));
  const report = {
    generatedAt: new Date().toISOString(), source: "production acu_route_decisions",
    totalRows: rows.length, usableRows: usable.length, economyRows: economyRows.length,
    observedFallbackCount: usable.reduce((sum, row) => sum + row.observedFallbackCount, 0),
    parameters: PARAMETERS, versions, economyComparison: {
      modelChanges: comparisons.filter((item) => item.modelChanged).length,
      channelChanges: comparisons.filter((item) => item.channelChanged).length,
      old: aggregate(comparisons.map((item) => item.old)), current: aggregate(comparisons.map((item) => item.current)),
      buckets,
      examples: comparisons.filter((item) => item.modelChanged || item.channelChanged).slice(0, 12),
    },
    limitations: [
      "Counterfactual selection reuses the candidate set and effective per-call costs captured in each production Route Decision.",
      "It does not infer Profiles that were absent from the historical Router input.",
      "Observed fallback count is factual; counterfactual fallback count is the summed conservative failure probability.",
    ],
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, totalRows: rows.length, usableRows: usable.length, economyRows: economyRows.length,
    modelChanges: report.economyComparison.modelChanges }));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
