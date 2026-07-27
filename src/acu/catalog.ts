import rawCatalog from "./catalog/model-catalog.json";
import type { AcuCurvePoint, AcuModelCatalogEntry } from "./types.js";
import { continuousTierProbabilities, estimatedQuality } from "./math.js";

export type AcuCatalogConfig = {
  tierDifficulty: { low: number; mid: number; mid_high: number; high: number };
  sharedTemperature: number;
  commonFloor: number;
  commonCeiling: number;
  curveThresholds: { above_low: number; above_mid: number; above_mid_high: number };
  curveTemperature: number;
  distributionWeights: { low: number; mid: number; mid_high: number; high: number };
  distributionCounts: { low: number; mid: number; mid_high: number; high: number };
  judge: {
    model: string;
    baseUrl: string;
    mode: string;
    promptVersion: string;
    timeoutMs: number;
    maxContextTokens: number;
    maxOutputTokens: number;
  };
  cost: { judgeInputTokens: number; judgeOutputTokens: number; switchCostUsd: number };
};

export type AcuModelCatalog = {
  schemaVersion: string;
  generatedAt: string;
  estimateLabel: string;
  disclaimer: string;
  config: AcuCatalogConfig;
  provenance: Record<string, unknown>;
  models: AcuModelCatalogEntry[];
};

const catalog = rawCatalog as AcuModelCatalog;

export function getAcuCatalog(): AcuModelCatalog {
  return catalog;
}

export function getAcuModel(modelId: string): AcuModelCatalogEntry | undefined {
  return catalog.models.find((model) => model.modelId === modelId);
}

export function getRoutingEligibleModels(eligibleModelIds?: string[]): AcuModelCatalogEntry[] {
  const allowed = eligibleModelIds ? new Set(eligibleModelIds) : null;
  return catalog.models.filter((model) => model.routingEligible && (!allowed || allowed.has(model.modelId)));
}

export function buildModelCurve(model: AcuModelCatalogEntry): AcuCurvePoint[] {
  const points: AcuCurvePoint[] = [];
  for (let difficultyScore = 0; difficultyScore <= 100; difficultyScore += 1) {
    const probabilities = continuousTierProbabilities(difficultyScore / 100);
    const quality = estimatedQuality(probabilities, model);
    points.push({
      difficultyScore,
      ...probabilities,
      estimatedQuality: quality,
      qualityLower: Math.max(0, quality - model.uncertaintyWidth),
      qualityUpper: Math.min(1, quality + model.uncertaintyWidth),
    });
  }
  return points;
}

export function publicCatalogPayload(): Record<string, unknown> {
  return {
    schemaVersion: catalog.schemaVersion,
    generatedAt: catalog.generatedAt,
    estimateLabel: catalog.estimateLabel,
    disclaimer: catalog.disclaimer,
    config: catalog.config,
    provenance: catalog.provenance,
    models: catalog.models,
    curves: Object.fromEntries(catalog.models.map((model) => [model.modelId, buildModelCurve(model)])),
  };
}
