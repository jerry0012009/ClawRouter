(function (root) {
  const HEALTH_RANK = { healthy: 0, unknown: 1, degraded: 2, cooldown: 3 };
  const EVIDENCE_RANK = { high: 0, medium: 1, low: 2 };

  function selectQualityCeiling(candidates) {
    if (!candidates.length) return null;
    return [...candidates].sort((left, right) =>
      Number(right.predictedScore.toFixed(1)) - Number(left.predictedScore.toFixed(1))
      || right.conservativeScore - left.conservativeScore
      || (HEALTH_RANK[left.healthStatus] ?? 1) - (HEALTH_RANK[right.healthStatus] ?? 1)
      || (left.p50LatencyMs ?? Infinity) - (right.p50LatencyMs ?? Infinity)
      || (EVIDENCE_RANK[left.evidenceConfidence] ?? 2) - (EVIDENCE_RANK[right.evidenceConfidence] ?? 2)
      || left.modelId.localeCompare(right.modelId)
    )[0];
  }

  function autoDifficultyDomain(difficulty) {
    const bounded = Math.max(0, Math.min(100, difficulty));
    if (bounded <= 18) return [0, 30];
    if (bounded >= 82) return [70, 100];
    return [bounded - 18, bounded + 18];
  }

  function normalizeDomain(domain, minimumSpan, bounds = [0, 100]) {
    let [minimum, maximum] = domain;
    const span = maximum - minimum;
    if (span < minimumSpan) {
      const center = (minimum + maximum) / 2;
      minimum = center - minimumSpan / 2;
      maximum = center + minimumSpan / 2;
    }
    if (minimum < bounds[0]) { maximum += bounds[0] - minimum; minimum = bounds[0]; }
    if (maximum > bounds[1]) { minimum -= maximum - bounds[1]; maximum = bounds[1]; }
    return [Math.max(bounds[0], minimum), Math.min(bounds[1], maximum)];
  }

  function autoScoreDomain(curves, modelIds, xDomain) {
    const values = [];
    for (const modelId of modelIds) {
      for (const point of curves[modelId] || []) {
        if (point.difficultyScore >= xDomain[0] && point.difficultyScore <= xDomain[1]) values.push(point.estimatedQuality * 100);
      }
    }
    if (!values.length) return [0, 100];
    return normalizeDomain([Math.min(...values) - 5, Math.max(...values) + 5], 20);
  }

  function sortCandidates(candidates, key) {
    const sorted = [...candidates];
    const compare = {
      value: (a, b) => b.valueUtility - a.valueUtility || b.predictedScore - a.predictedScore,
      score: (a, b) => b.predictedScore - a.predictedScore,
      cost: (a, b) => a.expectedTotalCost - b.expectedTotalCost,
      latency: (a, b) => (a.p50LatencyMs ?? Infinity) - (b.p50LatencyMs ?? Infinity),
      name: (a, b) => a.displayName.localeCompare(b.displayName),
    }[key] || ((a, b) => b.valueUtility - a.valueUtility);
    return sorted.sort(compare);
  }

  function visibleCandidates(candidates, curveIds) {
    const availableCurves = new Set(curveIds);
    return candidates.filter((candidate) => candidate.routingEligible === true
      && candidate.healthStatus !== 'cooldown'
      && Number.isFinite(candidate.expectedTotalCost)
      && availableCurves.has(candidate.modelId));
  }

  function benchmarkCounterfactualCost(pricing, usage) {
    const inputTokens = Number(usage?.inputTokens ?? usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
    const outputTokens = Number(usage?.completionTokens ?? usage?.completion_tokens ?? usage?.output_tokens ?? 0);
    const inputPrice = Number(pricing?.inputPricePerMillion);
    const outputPrice = Number(pricing?.outputPricePerMillion);
    if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)
      || !Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)
      || inputTokens <= 0 || outputTokens < 0 || inputPrice < 0 || outputPrice < 0) return null;
    return (inputTokens * inputPrice + outputTokens * outputPrice) / 1e6;
  }

  function featuredModelIds({ candidates, benchmarkId, qualityLeaderId, ceilingId, recommendedId, actualId, attemptIds }) {
    const compatible = new Map(candidates.map((candidate) => [candidate.modelId, candidate]));
    const fixed = [benchmarkId, qualityLeaderId, ceilingId, recommendedId, actualId, ...(attemptIds || [])]
      .filter((id) => compatible.has(id));
    const remaining = candidates.filter((candidate) => !fixed.includes(candidate.modelId));
    const valueModel = sortCandidates(remaining, 'value')[0]?.modelId;
    const lowCostModel = sortCandidates(remaining.filter((candidate) => candidate.modelId !== valueModel), 'cost')[0]?.modelId;
    const scoreFill = sortCandidates(remaining, 'score').map((candidate) => candidate.modelId);
    return [...new Set([...fixed, valueModel, lowCostModel, ...scoreFill].filter(Boolean))].slice(0, 6);
  }

  root.AcuChartCore = {
    selectQualityCeiling,
    autoDifficultyDomain,
    autoScoreDomain,
    normalizeDomain,
    sortCandidates,
    visibleCandidates,
    benchmarkCounterfactualCost,
    featuredModelIds,
  };
})(typeof window !== 'undefined' ? window : globalThis);
