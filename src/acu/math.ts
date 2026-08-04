import {
  ACU_COMMON_CEILING,
  ACU_COMMON_FLOOR,
  ACU_CURVE_TEMPERATURE,
  ACU_CURVE_THRESHOLDS,
  ACU_SHARED_TEMPERATURE,
  ACU_TIER_DIFFICULTY,
} from "./config.js";
import type { AcuModelCatalogEntry, AcuTierProbabilities } from "./types.js";

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Normalize benefit-oriented utilities within the current eligible set. */
export function normalizeBenefitUtilities(
  values: number[],
  minimumMeaningfulRange: number,
): number[] {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return values.map(() => 0);
  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  const range = maximum - minimum;
  if (range <= 0) return values.map((value) => (Number.isFinite(value) ? 0.5 : 0));
  const denominator = Math.max(range, Math.max(0, minimumMeaningfulRange));
  return values.map((value) => Number.isFinite(value)
    ? clamp((value - minimum) / denominator)
    : 0);
}

export function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

export function applyLogitShift(probability: number, shift: number): number {
  const boundedProbability = clamp(probability);
  const oddsMultiplier = Math.exp(shift);
  return clamp(
    (boundedProbability * oddsMultiplier)
      / (1 - boundedProbability + boundedProbability * oddsMultiplier),
  );
}

export function normalizeProbabilities(
  value: Omit<AcuTierProbabilities, "confidence"> & { confidence?: number },
): AcuTierProbabilities {
  const raw = [value.pLow, value.pMid, value.pMidHigh, value.pHigh];
  if (raw.some((item) => !Number.isFinite(item) || item < 0 || item > 1)) {
    throw new Error("ACU tier probabilities must be finite values in [0, 1]");
  }
  const total = raw.reduce((sum, item) => sum + item, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("ACU tier probabilities must have a positive sum");
  }
  const confidence = value.confidence ?? 0.5;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("ACU confidence must be in [0, 1]");
  }
  return {
    pLow: raw[0] / total,
    pMid: raw[1] / total,
    pMidHigh: raw[2] / total,
    pHigh: raw[3] / total,
    confidence,
  };
}

export function difficultyScore(probabilities: AcuTierProbabilities): number {
  const normalized = normalizeProbabilities(probabilities);
  return 100 * (
    normalized.pMid / 3
    + (2 * normalized.pMidHigh) / 3
    + normalized.pHigh
  );
}

export function normalizedEntropy(probabilities: AcuTierProbabilities): number {
  const normalized = normalizeProbabilities(probabilities);
  const values = [normalized.pLow, normalized.pMid, normalized.pMidHigh, normalized.pHigh];
  const entropy = -values.reduce((sum, value) => sum + (value > 0 ? value * Math.log(value) : 0), 0);
  return entropy / Math.log(values.length);
}

export function tierSufficiency(abilityParameter: number): {
  sufficientLow: number;
  sufficientMid: number;
  sufficientMidHigh: number;
  sufficientHigh: number;
} {
  const calculate = (difficulty: number) => ACU_COMMON_FLOOR
    + (ACU_COMMON_CEILING - ACU_COMMON_FLOOR)
      * sigmoid((abilityParameter - difficulty) / ACU_SHARED_TEMPERATURE);
  const values = {
    sufficientLow: calculate(ACU_TIER_DIFFICULTY.low),
    sufficientMid: calculate(ACU_TIER_DIFFICULTY.mid),
    sufficientMidHigh: calculate(ACU_TIER_DIFFICULTY.midHigh),
    sufficientHigh: calculate(ACU_TIER_DIFFICULTY.high),
  };
  if (!(values.sufficientLow >= values.sufficientMid
    && values.sufficientMid >= values.sufficientMidHigh
    && values.sufficientMidHigh >= values.sufficientHigh)) {
    throw new Error("ACU tier sufficiency must be monotone decreasing");
  }
  return values;
}

export function solveAbilityParameter(
  abilityAnchor: number,
  distribution: AcuTierProbabilities,
): { abilityParameter: number; fittingError: number } {
  const anchor = clamp(abilityAnchor);
  const weights = normalizeProbabilities(distribution);
  const aggregate = (ability: number): number => {
    const values = tierSufficiency(ability);
    return weights.pLow * values.sufficientLow
      + weights.pMid * values.sufficientMid
      + weights.pMidHigh * values.sufficientMidHigh
      + weights.pHigh * values.sufficientHigh;
  };
  let lower = -1;
  let upper = 2;
  for (let index = 0; index < 100; index += 1) {
    const middle = (lower + upper) / 2;
    if (aggregate(middle) < anchor) lower = middle;
    else upper = middle;
  }
  const abilityParameter = (lower + upper) / 2;
  return { abilityParameter, fittingError: aggregate(abilityParameter) - anchor };
}

export function estimatedQuality(
  probabilities: AcuTierProbabilities,
  model: Pick<AcuModelCatalogEntry,
    "sufficientLow" | "sufficientMid" | "sufficientMidHigh" | "sufficientHigh">,
): number {
  const normalized = normalizeProbabilities(probabilities);
  return normalized.pLow * model.sufficientLow
    + normalized.pMid * model.sufficientMid
    + normalized.pMidHigh * model.sufficientMidHigh
    + normalized.pHigh * model.sufficientHigh;
}

export function continuousTierProbabilities(difficulty: number): AcuTierProbabilities {
  const d = clamp(difficulty);
  const aboveLow = sigmoid((d - ACU_CURVE_THRESHOLDS.aboveLow) / ACU_CURVE_TEMPERATURE);
  const aboveMid = sigmoid((d - ACU_CURVE_THRESHOLDS.aboveMid) / ACU_CURVE_TEMPERATURE);
  const aboveMidHigh = sigmoid(
    (d - ACU_CURVE_THRESHOLDS.aboveMidHigh) / ACU_CURVE_TEMPERATURE,
  );
  return normalizeProbabilities({
    pLow: 1 - aboveLow,
    pMid: aboveLow - aboveMid,
    pMidHigh: aboveMid - aboveMidHigh,
    pHigh: aboveMidHigh,
    confidence: 1,
  });
}
