"""ACU tier-probability and predicted-sufficiency curve primitives.

The quantities in this module are router beliefs.  They are deliberately named
``predicted_sufficiency`` rather than model success probabilities: Phase 1D has
no execution evidence for a concrete model.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import math
from typing import Any, Literal, Mapping


TIER_ORDER = ("low", "mid", "mid_high", "high")
TIER_TO_ID = {name: index for index, name in enumerate(TIER_ORDER)}
TIER_DIFFICULTY = {
    "low": 0.0,
    "mid": 1.0 / 3.0,
    "mid_high": 2.0 / 3.0,
    "high": 1.0,
}


@dataclass(frozen=True)
class TierProbabilities:
    p_low: float
    p_mid: float
    p_mid_high: float
    p_high: float
    confidence: float

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "TierProbabilities":
        required = ("p_low", "p_mid", "p_mid_high", "p_high", "confidence")
        missing = [key for key in required if key not in value]
        if missing:
            raise ValueError(f"missing probability fields: {missing}")
        result = cls(**{key: float(value[key]) for key in required})
        result.validate()
        return result

    def validate(self, *, tolerance: float = 1e-9) -> None:
        values = (self.p_low, self.p_mid, self.p_mid_high, self.p_high)
        if not all(math.isfinite(value) for value in values + (self.confidence,)):
            raise ValueError("all probabilities and confidence must be finite")
        if any(value < 0.0 or value > 1.0 for value in values):
            raise ValueError("tier probabilities must be in [0, 1]")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence must be in [0, 1]")
        if not math.isclose(sum(values), 1.0, abs_tol=tolerance, rel_tol=0.0):
            raise ValueError(f"tier probabilities must sum to 1; got {sum(values)!r}")

    def as_dict(self) -> dict[str, float]:
        return asdict(self)


@dataclass(frozen=True)
class CurveIdentity:
    """Identity remains separate from optional capability-tier mapping."""

    curve_kind: Literal["capability_tier", "model"]
    curve_id: str
    capability_tier: str | None = None

    def validate(self) -> None:
        if self.curve_kind == "capability_tier":
            if self.curve_id not in TIER_TO_ID:
                raise ValueError(f"unknown capability tier: {self.curve_id}")
            if self.capability_tier not in (None, self.curve_id):
                raise ValueError("tier curves cannot map to a different tier")
        elif not self.curve_id:
            raise ValueError("model curve_id must not be empty")
        if self.capability_tier is not None and self.capability_tier not in TIER_TO_ID:
            raise ValueError(f"unknown mapped capability tier: {self.capability_tier}")


def continuous_difficulty(probabilities: TierProbabilities | Mapping[str, Any]) -> float:
    probs = _coerce(probabilities)
    return (
        probs.p_mid / 3.0
        + 2.0 * probs.p_mid_high / 3.0
        + probs.p_high
    )


def predicted_sufficiency(
    probabilities: TierProbabilities | Mapping[str, Any],
) -> dict[str, float]:
    probs = _coerce(probabilities)
    values = {
        "low": probs.p_low,
        "mid": probs.p_low + probs.p_mid,
        "mid_high": probs.p_low + probs.p_mid + probs.p_mid_high,
        "high": 1.0,
    }
    ordered = [values[tier] for tier in TIER_ORDER]
    if any(left > right + 1e-12 for left, right in zip(ordered, ordered[1:])):
        raise AssertionError("predicted sufficiency must be monotone non-decreasing by tier")
    return values


def oracle_probabilities(target_tier: str, *, confidence: float = 1.0) -> TierProbabilities:
    if target_tier not in TIER_TO_ID:
        raise ValueError(f"unknown target_tier: {target_tier!r}")
    values = [0.0, 0.0, 0.0, 0.0]
    values[TIER_TO_ID[target_tier]] = 1.0
    return TierProbabilities(*values, confidence=confidence)


def _coerce(value: TierProbabilities | Mapping[str, Any]) -> TierProbabilities:
    if isinstance(value, TierProbabilities):
        value.validate()
        return value
    return TierProbabilities.from_mapping(value)


def self_check() -> None:
    for tier in TIER_ORDER:
        probs = oracle_probabilities(tier)
        assert math.isclose(continuous_difficulty(probs), TIER_DIFFICULTY[tier])
        curve = predicted_sufficiency(probs)
        expected = {candidate: float(TIER_TO_ID[candidate] >= TIER_TO_ID[tier]) for candidate in TIER_ORDER}
        assert curve == expected
    for identity in (
        CurveIdentity("capability_tier", "low"),
        CurveIdentity("model", "demo-economy", "low"),
        CurveIdentity("model", "arbitrary-model-id", None),
    ):
        identity.validate()


if __name__ == "__main__":
    self_check()
