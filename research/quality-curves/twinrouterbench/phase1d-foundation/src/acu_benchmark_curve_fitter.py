"""Constrained Phase 2 benchmark-to-quality logistic curve fitter.

V1 uses ``sigmoid(alpha - beta * difficulty)`` with ``beta > 0``.  Aggregate
scores identify alpha conditional on a shared/prior beta; they do *not*
identify a model-specific slope.  Stratified observations may fit both.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import math
from typing import Iterable, Sequence

import numpy as np
from scipy.optimize import least_squares


@dataclass(frozen=True)
class BenchmarkFitInput:
    model_id: str
    benchmark_name: str
    benchmark_score: float
    benchmark_score_scale: str
    difficulty_distribution: tuple[tuple[float, float], ...]
    benchmark_score_error: float = 0.03
    beta_prior_range: tuple[float, float] = (1.0, 4.0)
    shared_beta: float | None = None
    source_confidence: float = 0.5
    domain_match_discount: float = 1.0
    mapped_capability_tier: str | None = None
    stratified_points: tuple[tuple[float, float, float], ...] = ()

    def validate(self) -> None:
        if not self.model_id:
            raise ValueError("model_id is required")
        score = normalize_score(self.benchmark_score, self.benchmark_score_scale)
        if not 0.0 <= score <= 1.0:
            raise ValueError("normalized benchmark score must be in [0, 1]")
        if self.benchmark_score_error < 0:
            raise ValueError("benchmark_score_error must be non-negative")
        low, high = self.beta_prior_range
        if not (math.isfinite(low) and math.isfinite(high) and 0.0 < low <= high):
            raise ValueError("beta_prior_range must satisfy 0 < low <= high")
        if self.shared_beta is not None and not low <= self.shared_beta <= high:
            raise ValueError("shared_beta must fall within beta_prior_range")
        if not 0.0 <= self.source_confidence <= 1.0:
            raise ValueError("source_confidence must be in [0, 1]")
        if not 0.0 < self.domain_match_discount <= 1.0:
            raise ValueError("domain_match_discount must be in (0, 1]")
        _normalize_distribution(self.difficulty_distribution)
        for difficulty, quality, weight in self.stratified_points:
            if not (0.0 <= difficulty <= 1.0 and 0.0 <= quality <= 1.0 and weight > 0):
                raise ValueError("stratified points require difficulty/quality in [0,1] and weight > 0")


@dataclass(frozen=True)
class BenchmarkCurveFit:
    model_id: str
    mapped_capability_tier: str | None
    benchmark_name: str
    benchmark_score_normalized: float
    domain_adjusted_score: float
    alpha: float
    beta: float
    beta_lower_for_interval: float
    beta_upper_for_interval: float
    weighted_curve_mean: float
    weighted_fit_error: float
    aggregate_score_only: bool
    slope_identified: bool
    beta_source: str
    curve_confidence: str
    benchmark_score_error: float
    source_confidence: float
    domain_match_discount: float
    parameter_constraints: str

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def normalize_score(score: float, scale: str) -> float:
    value = float(score)
    if scale in {"0_to_1", "fraction", "probability"}:
        return value
    if scale in {"0_to_100", "percent"}:
        return value / 100.0
    raise ValueError(f"unsupported benchmark_score_scale: {scale!r}")


def sigmoid(value: float | np.ndarray) -> float | np.ndarray:
    values = np.asarray(value, dtype=float)
    clipped = np.clip(values, -60.0, 60.0)
    result = 1.0 / (1.0 + np.exp(-clipped))
    return float(result) if result.ndim == 0 else result


def quality(alpha: float, beta: float, difficulty: float | np.ndarray) -> float | np.ndarray:
    if beta <= 0 or not math.isfinite(beta):
        raise ValueError("beta must be finite and > 0")
    values = np.asarray(difficulty, dtype=float)
    if np.any(~np.isfinite(values)) or np.any((values < 0.0) | (values > 1.0)):
        raise ValueError("difficulty must be finite and in [0, 1]")
    return sigmoid(float(alpha) - float(beta) * values)


def fit_curve(spec: BenchmarkFitInput) -> BenchmarkCurveFit:
    spec.validate()
    distribution = _normalize_distribution(spec.difficulty_distribution)
    raw_score = normalize_score(spec.benchmark_score, spec.benchmark_score_scale)
    adjusted_score = min(1.0, max(0.0, raw_score * spec.domain_match_discount))
    beta_low, beta_high = spec.beta_prior_range
    if spec.stratified_points:
        adjusted_points = tuple(
            (difficulty, quality_value * spec.domain_match_discount, weight)
            for difficulty, quality_value, weight in spec.stratified_points
        )
        alpha, beta = _fit_stratified(adjusted_points, beta_low, beta_high)
        aggregate_only = False
        slope_identified = True
        beta_source = "stratified_benchmark_fit"
        local_radius = max(0.15, 0.15 * beta)
        interval_beta_low = max(beta_low, beta - local_radius)
        interval_beta_high = min(beta_high, beta + local_radius)
        confidence = _confidence_label(spec.source_confidence, stratified=True)
    else:
        beta = spec.shared_beta if spec.shared_beta is not None else (beta_low + beta_high) / 2.0
        alpha = _solve_alpha(adjusted_score, beta, distribution)
        aggregate_only = True
        slope_identified = False
        beta_source = "domain_shared_beta" if spec.shared_beta is not None else "beta_prior_midpoint"
        interval_beta_low, interval_beta_high = beta_low, beta_high
        confidence = _confidence_label(spec.source_confidence, stratified=False)
    fitted_mean = weighted_mean_quality(alpha, beta, distribution)
    target_for_error = adjusted_score
    return BenchmarkCurveFit(
        model_id=spec.model_id,
        mapped_capability_tier=spec.mapped_capability_tier,
        benchmark_name=spec.benchmark_name,
        benchmark_score_normalized=raw_score,
        domain_adjusted_score=adjusted_score,
        alpha=float(alpha),
        beta=float(beta),
        beta_lower_for_interval=float(interval_beta_low),
        beta_upper_for_interval=float(interval_beta_high),
        weighted_curve_mean=float(fitted_mean),
        weighted_fit_error=float(fitted_mean - target_for_error),
        aggregate_score_only=aggregate_only,
        slope_identified=slope_identified,
        beta_source=beta_source,
        curve_confidence=confidence,
        benchmark_score_error=float(spec.benchmark_score_error),
        source_confidence=float(spec.source_confidence),
        domain_match_discount=float(spec.domain_match_discount),
        parameter_constraints="difficulty in [0,1]; quality in [0,1]; beta > 0; monotone decreasing",
    )


def curve_with_uncertainty(
    fit: BenchmarkCurveFit,
    spec: BenchmarkFitInput,
    difficulties: Iterable[float],
) -> list[dict[str, float]]:
    spec.validate()
    distribution = _normalize_distribution(spec.difficulty_distribution)
    error_multiplier = (1.0 + 2.0 * (1.0 - spec.source_confidence))
    if not fit.aggregate_score_only:
        error_multiplier *= 0.45
    score_error = spec.benchmark_score_error * error_multiplier
    interval_center = fit.weighted_curve_mean
    score_low = max(1e-6, interval_center - score_error)
    score_high = min(1.0 - 1e-6, interval_center + score_error)
    beta_candidates = (fit.beta_lower_for_interval, fit.beta_upper_for_interval)
    scenarios: list[tuple[float, float]] = []
    for target in (score_low, score_high):
        for beta in beta_candidates:
            scenarios.append((_solve_alpha(target, beta, distribution), beta))
    rows: list[dict[str, float]] = []
    for difficulty in difficulties:
        estimate = float(quality(fit.alpha, fit.beta, difficulty))
        bounds = [float(quality(alpha, beta, difficulty)) for alpha, beta in scenarios]
        rows.append(
            {
                "difficulty": float(difficulty),
                "quality_estimate": estimate,
                "quality_lower": min(bounds),
                "quality_upper": max(bounds),
            }
        )
    return rows


def weighted_mean_quality(
    alpha: float,
    beta: float,
    distribution: Sequence[tuple[float, float]],
) -> float:
    normalized = _normalize_distribution(distribution)
    return sum(weight * float(quality(alpha, beta, difficulty)) for difficulty, weight in normalized)


def _solve_alpha(target: float, beta: float, distribution: Sequence[tuple[float, float]]) -> float:
    target = min(1.0 - 1e-10, max(1e-10, float(target)))
    low, high = -30.0, 30.0
    for _ in range(120):
        midpoint = (low + high) / 2.0
        if weighted_mean_quality(midpoint, beta, distribution) < target:
            low = midpoint
        else:
            high = midpoint
    return (low + high) / 2.0


def _fit_stratified(points: Sequence[tuple[float, float, float]], beta_low: float, beta_high: float) -> tuple[float, float]:
    x = np.asarray([row[0] for row in points], dtype=float)
    y = np.asarray([row[1] for row in points], dtype=float)
    weights = np.sqrt(np.asarray([row[2] for row in points], dtype=float))

    def residual(params: np.ndarray) -> np.ndarray:
        alpha = params[0]
        beta = math.exp(params[1])
        return weights * (quality(alpha, beta, x) - y)

    initial_beta = (beta_low + beta_high) / 2.0
    result = least_squares(
        residual,
        x0=np.asarray([0.0, math.log(initial_beta)]),
        bounds=(np.asarray([-30.0, math.log(beta_low)]), np.asarray([30.0, math.log(beta_high)])),
        method="trf",
    )
    if not result.success:
        raise RuntimeError(f"stratified curve fit failed: {result.message}")
    return float(result.x[0]), float(math.exp(result.x[1]))


def _normalize_distribution(distribution: Sequence[tuple[float, float]]) -> tuple[tuple[float, float], ...]:
    if not distribution:
        raise ValueError("difficulty_distribution must not be empty")
    values = [(float(difficulty), float(weight)) for difficulty, weight in distribution]
    if any(not 0.0 <= difficulty <= 1.0 or weight < 0.0 for difficulty, weight in values):
        raise ValueError("difficulty values must be in [0,1] and weights non-negative")
    total = sum(weight for _, weight in values)
    if not math.isfinite(total) or total <= 0:
        raise ValueError("difficulty weights must have a positive finite sum")
    return tuple((difficulty, weight / total) for difficulty, weight in values)


def _stratified_weighted_mean(points: Sequence[tuple[float, float, float]]) -> float:
    total = sum(weight for _, _, weight in points)
    return sum(quality_value * weight for _, quality_value, weight in points) / total


def _confidence_label(source_confidence: float, *, stratified: bool) -> str:
    if stratified and source_confidence >= 0.8:
        return "medium_high_stratified"
    if stratified:
        return "medium_stratified"
    if source_confidence >= 0.8:
        return "low_medium_aggregate_only"
    return "low_aggregate_only"


def self_check() -> None:
    distribution = ((0.0, 0.5), (0.5, 0.3), (1.0, 0.2))
    aggregate = BenchmarkFitInput(
        model_id="demo-economy",
        benchmark_name="synthetic",
        benchmark_score=0.6,
        benchmark_score_scale="0_to_1",
        difficulty_distribution=distribution,
    )
    fit = fit_curve(aggregate)
    assert fit.beta > 0 and not fit.slope_identified
    assert abs(fit.weighted_curve_mean - fit.domain_adjusted_score) < 1e-8
    rows = curve_with_uncertainty(fit, aggregate, np.linspace(0.0, 1.0, 101))
    estimates = [row["quality_estimate"] for row in rows]
    assert all(left >= right for left, right in zip(estimates, estimates[1:]))
    assert all(0.0 <= row["quality_lower"] <= row["quality_estimate"] <= row["quality_upper"] <= 1.0 for row in rows)


if __name__ == "__main__":
    self_check()
