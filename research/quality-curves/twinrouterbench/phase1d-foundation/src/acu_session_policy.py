"""Deterministic session-tier policies for Phase 1D simulations."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Iterable, Mapping

from acu_curve_engine import TIER_ORDER, TIER_TO_ID


@dataclass(frozen=True)
class SessionTransition:
    context_id: str
    instance_id: str
    step_index: int
    recommended_tier: str
    applied_tier: str
    previous_tier: str | None
    transition: str
    sticky_override: bool

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


class StickyEscalationPolicy:
    """Allow escalation but keep the strongest tier already used in a session."""

    def __init__(self) -> None:
        self._session_tiers: dict[str, str] = {}

    def reset(self) -> None:
        self._session_tiers.clear()

    def select(
        self,
        *,
        context_id: str,
        instance_id: str,
        step_index: int,
        recommended_tier: str,
    ) -> SessionTransition:
        if recommended_tier not in TIER_TO_ID:
            raise ValueError(f"unknown recommended tier: {recommended_tier!r}")
        previous = self._session_tiers.get(instance_id)
        if previous is None:
            applied = recommended_tier
            transition = "start"
        elif TIER_TO_ID[recommended_tier] > TIER_TO_ID[previous]:
            applied = recommended_tier
            transition = "escalate"
        elif TIER_TO_ID[recommended_tier] < TIER_TO_ID[previous]:
            applied = previous
            transition = "sticky_hold"
        else:
            applied = previous
            transition = "stay"
        self._session_tiers[instance_id] = applied
        return SessionTransition(
            context_id=context_id,
            instance_id=instance_id,
            step_index=int(step_index),
            recommended_tier=recommended_tier,
            applied_tier=applied,
            previous_tier=previous,
            transition=transition,
            sticky_override=applied != recommended_tier,
        )


def simulate_sticky_policy(rows: Iterable[Mapping[str, object]]) -> list[SessionTransition]:
    ordered = sorted(rows, key=lambda row: (str(row["instance_id"]), int(row["step_index"]), str(row["context_id"])))
    policy = StickyEscalationPolicy()
    return [
        policy.select(
            context_id=str(row["context_id"]),
            instance_id=str(row["instance_id"]),
            step_index=int(row["step_index"]),
            recommended_tier=str(row["recommended_tier"]),
        )
        for row in ordered
    ]


def self_check() -> None:
    policy = StickyEscalationPolicy()
    observed = []
    for index, tier in enumerate(("low", "mid_high", "mid", "high", "low"), 1):
        observed.append(
            policy.select(
                context_id=f"demo-{index}",
                instance_id="demo-session",
                step_index=index,
                recommended_tier=tier,
            ).applied_tier
        )
    assert observed == ["low", "mid_high", "mid_high", "high", "high"]
    assert all(a in TIER_ORDER for a in observed)


if __name__ == "__main__":
    self_check()
