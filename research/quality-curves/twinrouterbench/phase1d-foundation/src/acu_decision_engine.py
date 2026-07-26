"""Synthetic-configurable ACU tier and fallback cost decisions.

This module consumes predicted tier sufficiency from ``acu_curve_engine``.  It
does not claim that those probabilities are measured concrete-model success
rates.  Monetary examples are valid only for the catalog supplied by callers.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import math
from pathlib import Path
from typing import Any, Mapping

import yaml

from acu_curve_engine import TIER_ORDER, TIER_TO_ID, TierProbabilities, predicted_sufficiency


@dataclass(frozen=True)
class TierCostConfig:
    tier: str
    models: tuple[str, ...]
    provider: str
    input_price: float
    output_price: float
    cache_read_price: float
    cache_write_price: float
    expected_output_tokens: int
    router_cost: float
    fallback_tier: str | None
    switch_cost: float
    uncertainty_penalty: float
    failure_penalty: float

    def validate(self) -> None:
        if self.tier not in TIER_TO_ID:
            raise ValueError(f"unknown tier {self.tier!r}")
        if not self.models:
            raise ValueError(f"tier {self.tier!r} must contain at least one model id")
        numeric = (
            self.input_price,
            self.output_price,
            self.cache_read_price,
            self.cache_write_price,
            self.router_cost,
            self.switch_cost,
            self.uncertainty_penalty,
            self.failure_penalty,
        )
        if any(not math.isfinite(value) or value < 0 for value in numeric):
            raise ValueError(f"tier {self.tier!r} has a negative or non-finite cost/penalty")
        if self.expected_output_tokens < 0:
            raise ValueError("expected_output_tokens must be non-negative")
        if not 0.0 <= self.uncertainty_penalty <= 1.0:
            raise ValueError("uncertainty_penalty must be in [0, 1]")
        if self.fallback_tier is not None:
            if self.fallback_tier not in TIER_TO_ID:
                raise ValueError(f"unknown fallback tier {self.fallback_tier!r}")
            if TIER_TO_ID[self.fallback_tier] <= TIER_TO_ID[self.tier]:
                raise ValueError("fallback_tier must be strictly stronger")


@dataclass(frozen=True)
class DecisionCatalog:
    tiers: dict[str, TierCostConfig]
    validator_detection_rate: float
    validator_assumption_type: str
    data_status: str

    def validate(self) -> None:
        if tuple(self.tiers) != TIER_ORDER:
            raise ValueError(f"tiers must be ordered exactly as {TIER_ORDER}")
        for config in self.tiers.values():
            config.validate()
        if not 0.0 <= self.validator_detection_rate <= 1.0:
            raise ValueError("validator_detection_rate must be in [0, 1]")
        if self.data_status == "synthetic" and self.validator_assumption_type != "synthetic_assumption":
            raise ValueError("synthetic validator defaults must be marked synthetic_assumption")


@dataclass(frozen=True)
class TierDecision:
    selected_tier: str
    selected_model_id: str
    quality_threshold: float
    predicted_sufficiency: float
    conservative_quality: float
    current_call_cost: float
    expected_total_cost: float
    fallback_tier: str | None
    reason: str
    alternatives: tuple[dict[str, Any], ...]

    def as_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["alternatives"] = list(self.alternatives)
        return value


@dataclass(frozen=True)
class FallbackProjection:
    first_pass_quality: float
    fallback_quality: float
    validator_detection_rate: float
    final_quality: float
    residual_failure_probability: float
    initial_cost: float
    fallback_cost: float
    switch_cost: float
    failure_penalty: float
    expected_total_cost: float
    assumption_type: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def load_catalog(path: str | Path) -> DecisionCatalog:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    tiers: dict[str, TierCostConfig] = {}
    for tier in TIER_ORDER:
        item = raw["tiers"][tier]
        tiers[tier] = TierCostConfig(
            tier=tier,
            models=tuple(str(value) for value in item["models"]),
            provider=str(item["provider"]),
            input_price=float(item["input_price"]),
            output_price=float(item["output_price"]),
            cache_read_price=float(item["cache_read_price"]),
            cache_write_price=float(item["cache_write_price"]),
            expected_output_tokens=int(item["expected_output_tokens"]),
            router_cost=float(item["router_cost"]),
            fallback_tier=item.get("fallback_tier"),
            switch_cost=float(item["switch_cost"]),
            uncertainty_penalty=float(item["uncertainty_penalty"]),
            failure_penalty=float(item["failure_penalty"]),
        )
    validator = raw["validator"]
    catalog = DecisionCatalog(
        tiers=tiers,
        validator_detection_rate=float(validator["validator_detection_rate"]),
        validator_assumption_type=str(validator["assumption_type"]),
        data_status=str(raw.get("data_status", "unknown")),
    )
    catalog.validate()
    return catalog


def call_cost(
    config: TierCostConfig,
    *,
    input_tokens: int,
    output_tokens: int | None = None,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> float:
    if min(input_tokens, cache_read_tokens, cache_write_tokens) < 0:
        raise ValueError("token counts must be non-negative")
    output = config.expected_output_tokens if output_tokens is None else output_tokens
    if output < 0:
        raise ValueError("output_tokens must be non-negative")
    return (
        input_tokens * config.input_price
        + output * config.output_price
        + cache_read_tokens * config.cache_read_price
        + cache_write_tokens * config.cache_write_price
    ) / 1_000_000.0


def phase1d_expected_total_cost(
    *,
    config: TierCostConfig,
    conservative_quality: float,
    current_call_cost: float,
    fallback_cost: float,
) -> float:
    quality = _unit_interval(conservative_quality, "conservative_quality")
    return (
        config.router_cost
        + current_call_cost
        + (1.0 - quality)
        * (fallback_cost + config.switch_cost + config.failure_penalty)
    )


def fallback_projection(
    *,
    first_pass_quality: float,
    fallback_quality: float,
    validator_detection_rate: float,
    initial_cost: float,
    fallback_cost: float,
    switch_cost: float,
    failure_penalty: float,
    assumption_type: str,
) -> FallbackProjection:
    first = _unit_interval(first_pass_quality, "first_pass_quality")
    fallback = _unit_interval(fallback_quality, "fallback_quality")
    detection = _unit_interval(validator_detection_rate, "validator_detection_rate")
    if min(initial_cost, fallback_cost, switch_cost, failure_penalty) < 0:
        raise ValueError("costs and failure_penalty must be non-negative")
    final_quality = first + (1.0 - first) * detection * fallback
    residual = 1.0 - final_quality
    expected = (
        initial_cost
        + (1.0 - first) * detection * (fallback_cost + switch_cost)
        + residual * failure_penalty
    )
    return FallbackProjection(
        first_pass_quality=first,
        fallback_quality=fallback,
        validator_detection_rate=detection,
        final_quality=final_quality,
        residual_failure_probability=residual,
        initial_cost=initial_cost,
        fallback_cost=fallback_cost,
        switch_cost=switch_cost,
        failure_penalty=failure_penalty,
        expected_total_cost=expected,
        assumption_type=assumption_type,
    )


def choose_tier(
    probabilities: TierProbabilities | Mapping[str, Any],
    catalog: DecisionCatalog,
    *,
    quality_threshold: float,
    input_tokens: int,
) -> TierDecision:
    catalog.validate()
    threshold = _unit_interval(quality_threshold, "quality_threshold")
    probs = probabilities if isinstance(probabilities, TierProbabilities) else TierProbabilities.from_mapping(probabilities)
    probs.validate()
    qualities = predicted_sufficiency(probs)
    alternatives: list[dict[str, Any]] = []
    for tier in TIER_ORDER:
        config = catalog.tiers[tier]
        predicted = qualities[tier]
        applied_uncertainty = config.uncertainty_penalty * (1.0 - probs.confidence)
        conservative = max(0.0, predicted - applied_uncertainty)
        current = call_cost(config, input_tokens=input_tokens)
        fallback_config = catalog.tiers.get(config.fallback_tier) if config.fallback_tier else None
        fallback = call_cost(fallback_config, input_tokens=input_tokens) if fallback_config else 0.0
        expected = phase1d_expected_total_cost(
            config=config,
            conservative_quality=conservative,
            current_call_cost=current,
            fallback_cost=fallback,
        )
        alternatives.append(
            {
                "tier": tier,
                "model_id": config.models[0],
                "predicted_sufficiency": predicted,
                "conservative_quality": conservative,
                "applied_uncertainty_penalty": applied_uncertainty,
                "current_call_cost": current,
                "expected_total_cost": expected,
                "eligible": conservative >= threshold,
            }
        )
    eligible = [row for row in alternatives if row["eligible"]]
    if eligible:
        selected = min(eligible, key=lambda row: (row["expected_total_cost"], TIER_TO_ID[row["tier"]]))
        reason = (
            f"selected the lowest expected-total-cost tier among {len(eligible)} tiers "
            f"meeting conservative quality >= {threshold:.2f}"
        )
    else:
        selected = alternatives[-1]
        reason = "no tier met the quality threshold; selected the highest capability tier"
    config = catalog.tiers[selected["tier"]]
    return TierDecision(
        selected_tier=selected["tier"],
        selected_model_id=selected["model_id"],
        quality_threshold=threshold,
        predicted_sufficiency=selected["predicted_sufficiency"],
        conservative_quality=selected["conservative_quality"],
        current_call_cost=selected["current_call_cost"],
        expected_total_cost=selected["expected_total_cost"],
        fallback_tier=config.fallback_tier,
        reason=reason,
        alternatives=tuple(alternatives),
    )


def _unit_interval(value: float, name: str) -> float:
    value = float(value)
    if not math.isfinite(value) or not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be finite and in [0, 1]")
    return value


def self_check(config_path: str | Path) -> None:
    catalog = load_catalog(config_path)
    probs = TierProbabilities(0.0, 1.0, 0.0, 0.0, 1.0)
    decision = choose_tier(probs, catalog, quality_threshold=0.9, input_tokens=1_000)
    assert decision.selected_tier == "mid"
    projection = fallback_projection(
        first_pass_quality=0.6,
        fallback_quality=0.9,
        validator_detection_rate=catalog.validator_detection_rate,
        initial_cost=0.01,
        fallback_cost=0.02,
        switch_cost=0.001,
        failure_penalty=0.05,
        assumption_type=catalog.validator_assumption_type,
    )
    assert 0.6 < projection.final_quality < 1.0
    assert math.isclose(projection.residual_failure_probability, 1.0 - projection.final_quality)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("config")
    args = parser.parse_args()
    self_check(args.config)
