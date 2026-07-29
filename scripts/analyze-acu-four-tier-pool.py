#!/usr/bin/env python3
"""Replay the current ACU routing formula to identify a compact four-tier model pool.

This is an offline catalog analysis. It does not prove provider/protocol compatibility;
all shortlisted models still require native Responses/Messages preflight before they
can be added to an execution profile.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "src" / "acu" / "catalog" / "model-catalog.json"
TOKEN_PROFILES = ((2_000, 500), (20_000, 2_000), (100_000, 5_000))


def clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return min(maximum, max(minimum, value))


def sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def continuous_tier_probabilities(difficulty: float, catalog: dict[str, Any]) -> list[float]:
    config = catalog["config"]
    thresholds = config["curveThresholds"]
    temperature = float(config["curveTemperature"])
    d = clamp(difficulty / 100.0)
    above_low = sigmoid((d - float(thresholds["above_low"])) / temperature)
    above_mid = sigmoid((d - float(thresholds["above_mid"])) / temperature)
    above_mid_high = sigmoid((d - float(thresholds["above_mid_high"])) / temperature)
    return [1.0 - above_low, above_low - above_mid, above_mid - above_mid_high, above_mid_high]


def estimated_quality(model: dict[str, Any], difficulty: float, catalog: dict[str, Any]) -> float:
    probabilities = continuous_tier_probabilities(difficulty, catalog)
    sufficiency = [
        float(model["sufficientLow"]),
        float(model["sufficientMid"]),
        float(model["sufficientMidHigh"]),
        float(model["sufficientHigh"]),
    ]
    return sum(probability * score for probability, score in zip(probabilities, sufficiency, strict=True))


def call_cost(model: dict[str, Any], input_tokens: int, output_tokens: int) -> float:
    return (
        input_tokens * float(model["inputPricePerMillion"])
        + output_tokens * float(model["outputPricePerMillion"])
    ) / 1_000_000.0


def is_pareto_efficient(candidate: dict[str, Any], candidates: list[dict[str, Any]]) -> bool:
    return not any(
        other["modelId"] != candidate["modelId"]
        and other["predictedScore"] >= candidate["predictedScore"]
        and other["riskAdjustedCost"] <= candidate["riskAdjustedCost"]
        and (
            other["predictedScore"] > candidate["predictedScore"]
            or other["riskAdjustedCost"] < candidate["riskAdjustedCost"]
        )
        for other in candidates
    )


def select_model(
    models: list[dict[str, Any]],
    catalog: dict[str, Any],
    difficulty: int,
    input_tokens: int,
    output_tokens: int,
    target_score: float,
    judge_cost: float,
) -> tuple[str, list[dict[str, Any]]]:
    flagship = max(models, key=lambda model: float(model["abilityAnchor"]))
    fallback_cost = call_cost(flagship, input_tokens, output_tokens)
    switch_cost = float(catalog["config"]["cost"]["switchCostUsd"])

    estimates: list[dict[str, Any]] = []
    for model in models:
        quality = estimated_quality(model, difficulty, catalog)
        conservative = clamp(quality - float(model["uncertaintyWidth"]))
        estimated_call_cost = call_cost(model, input_tokens, output_tokens)
        expected_fallback_cost = (1.0 - conservative) * (fallback_cost + switch_cost)
        estimates.append(
            {
                "modelId": model["modelId"],
                "predictedScore": quality * 100.0,
                "conservativeScore": conservative * 100.0,
                "riskAdjustedCost": judge_cost + estimated_call_cost + expected_fallback_cost,
            }
        )

    frontier = [estimate for estimate in estimates if is_pareto_efficient(estimate, estimates)]
    preference = clamp((target_score - 60.0) / 35.0)
    quality_weight = 0.58 + 0.24 * preference
    risk_weight = 0.20 + 0.25 * preference
    quality_exponent = 0.8 + 1.2 * preference
    costs = [max(1e-9, estimate["riskAdjustedCost"]) for estimate in frontier]
    minimum_cost = min(costs)
    maximum_cost = max(costs)
    log_range = math.log(maximum_cost / minimum_cost) if maximum_cost > minimum_cost else 0.0

    for estimate in frontier:
        risk_adjusted_score = estimate["predictedScore"] - risk_weight * max(
            0.0, estimate["predictedScore"] - estimate["conservativeScore"]
        )
        quality_utility = (max(0.0, risk_adjusted_score) / max(1.0, target_score)) ** quality_exponent
        cost_utility = (
            1.0
            if log_range <= 1e-12
            else 1.0 - math.log(max(1e-9, estimate["riskAdjustedCost"]) / minimum_cost) / log_range
        )
        estimate["valueUtility"] = quality_utility * (
            quality_weight + (1.0 - quality_weight) * cost_utility
        )

    selected = max(frontier, key=lambda estimate: estimate["valueUtility"])
    return str(selected["modelId"]), frontier


def contiguous_ranges(selections: list[str]) -> list[dict[str, Any]]:
    ranges: list[dict[str, Any]] = []
    start = 0
    current = selections[0]
    for difficulty, model_id in enumerate(selections[1:], start=1):
        if model_id != current:
            ranges.append({"start": start, "end": difficulty - 1, "modelId": current})
            start = difficulty
            current = model_id
    ranges.append({"start": start, "end": 100, "modelId": current})
    return ranges


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=float, default=80.0)
    parser.add_argument("--include-openrouter", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    models = [
        model
        for model in catalog["models"]
        if model.get("routingEligible")
        and model.get("toolCallSupport")
        and model.get("inputPricePerMillion") is not None
        and model.get("outputPricePerMillion") is not None
        and (args.include_openrouter or model.get("upstream") != "openrouter")
    ]
    if not models:
        raise SystemExit("No eligible catalog models")

    judge_model_id = catalog["config"]["judge"]["model"]
    judge_model = next(model for model in catalog["models"] if model["modelId"] == judge_model_id)
    judge_input = int(catalog["config"]["cost"]["judgeInputTokens"])
    judge_output = int(catalog["config"]["cost"]["judgeOutputTokens"])
    judge_cost = call_cost(judge_model, judge_input, judge_output)

    output: dict[str, Any] = {
        "catalog": str(CATALOG_PATH.relative_to(ROOT)),
        "targetScore": args.target,
        "judgeCostUsd": judge_cost,
        "eligibleModelCount": len(models),
        "tokenProfiles": [],
    }
    union: Counter[str] = Counter()
    for input_tokens, output_tokens in TOKEN_PROFILES:
        selections: list[str] = []
        frontier_appearances: Counter[str] = Counter()
        for difficulty in range(101):
            selected, frontier = select_model(
                models, catalog, difficulty, input_tokens, output_tokens, args.target, judge_cost
            )
            selections.append(selected)
            union[selected] += 1
            frontier_appearances.update(str(item["modelId"]) for item in frontier)
        output["tokenProfiles"].append(
            {
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "selectedCounts": dict(Counter(selections).most_common()),
                "difficultyRanges": contiguous_ranges(selections),
                "frontierAppearances": dict(frontier_appearances.most_common()),
            }
        )

    output["selectedUnion"] = [model_id for model_id, _ in union.most_common()]
    output["recommendedFourTierPool"] = output["selectedUnion"][:4]
    output["warning"] = (
        "Catalog ranking only. Every model still requires provider-specific native protocol, "
        "streaming, tool, usage and actual-model preflight before execution-profile admission."
    )

    if args.json:
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return

    print(f"Eligible catalog models: {output['eligibleModelCount']}")
    print(f"Judge cost: ${judge_cost:.8f}")
    print("Recommended four-tier pool:")
    for index, model_id in enumerate(output["recommendedFourTierPool"], start=1):
        print(f"  {index}. {model_id}")
    for profile in output["tokenProfiles"]:
        print(f"\nTokens {profile['inputTokens']}/{profile['outputTokens']}")
        for item in profile["difficultyRanges"]:
            print(f"  difficulty {item['start']:>3}-{item['end']:>3}: {item['modelId']}")


if __name__ == "__main__":
    main()
