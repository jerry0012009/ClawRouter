#!/usr/bin/env python3
"""Build the Phase 2A ACU model catalog and research artifacts.

This is a deterministic product-estimation build. It reads the repository's
callable model registry, the frozen Phase 1D TwinRouterBench contexts, and the
already-audited official OpenHands Index coverage table. It does not call any
model API or execute benchmark tasks.
"""

from __future__ import annotations

import csv
from datetime import date
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
PHASE = ROOT / "research/quality-curves/acu-demo/phase2a-tier-model"
FOUNDATION = ROOT / "research/quality-curves/twinrouterbench/phase1d-foundation"
OPENHANDS = ROOT / "research/quality-curves/openhands"
CATALOG_PATH = ROOT / "src/acu/catalog/model-catalog.json"
FEW_SHOT_PATH = ROOT / "src/acu/catalog/twin-few-shots.json"
RETRIEVED_AT = "2026-07-27"
TIER_ORDER = ("low", "mid", "mid_high", "high")
TIER_DIFFICULTY = {"low": 0.15, "mid": 0.40, "mid_high": 0.65, "high": 0.88}
SHARED_TEMPERATURE = 0.12
COMMON_FLOOR = 0.03
COMMON_CEILING = 0.99
CURVE_THRESHOLDS = {"above_low": 0.275, "above_mid": 0.525, "above_mid_high": 0.765}
CURVE_TEMPERATURE = 0.08

OPENHANDS_SOURCE = {
    "name": "OpenHands Index SWE-bench aggregate",
    "url": "https://huggingface.co/datasets/OpenHands/openhands-index",
    "version": "v2026.06.30-3015ac6",
    "revision": "94ac78ad8ec547875a0a4ec56e15a644aa5653f6",
    "results_url": "https://github.com/OpenHands/openhands-index-results/tree/3015ac612e7196f428e6e8a3948965d32d9a3331",
    "benchmark_date": "2026-06-30",
}

# Exact entries use the audited OpenHands aggregate. Relative entries keep the
# reference and delta explicit and always receive low evidence confidence.
MODEL_SPECS: list[dict[str, Any]] = [
    {"model_id": "gpt-5.5", "provider": "OpenAI", "evidence": "GPT-5.5", "default": True},
    {"model_id": "gpt-5.4-mini", "provider": "OpenAI", "relative_to": "GPT-5.4", "delta": -0.10, "default": False},
    {"model_id": "claude-opus-4-8", "provider": "Anthropic", "evidence": "claude-opus-4-8", "default": True},
    {"model_id": "claude-sonnet-5", "provider": "Anthropic", "relative_to": "claude-opus-4-8", "delta": -0.06, "default": True},
    {"model_id": "gemini-3.5-flash", "provider": "Google", "evidence": "Gemini-3.5-Flash", "default": True},
    {"model_id": "deepseek-v4-flash", "provider": "DeepSeek", "relative_to": "DeepSeek-V4-Pro", "delta": -0.06, "default": True},
    {"model_id": "deepseek-v4-pro", "provider": "DeepSeek", "evidence": "DeepSeek-V4-Pro", "default": True},
    {"model_id": "glm-5.1", "provider": "Zhipu AI", "evidence": "GLM-5.1", "default": True},
    {"model_id": "kimi-k2.6", "provider": "Moonshot AI", "evidence": "Kimi-K2.6", "default": True},
    {"model_id": "qwen3.5-flash", "provider": "Alibaba Cloud", "evidence": "Qwen3.5-Flash", "default": True},
    {"model_id": "qwen3.6-plus", "provider": "Alibaba Cloud", "evidence": "Qwen3.6-Plus", "default": True},
    {"model_id": "qwen3.7-max", "provider": "Alibaba Cloud", "relative_to": "Qwen3.6-Plus", "delta": 0.02, "default": True},
    {"model_id": "minimax-m3", "display_name": "MiniMax M3", "provider": "MiniMax", "evidence": "MiniMax-M3", "default": False, "unavailable": True},
]


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def parse_model_registry() -> dict[str, dict[str, Any]]:
    source = (ROOT / "src/models.ts").read_text(encoding="utf-8")
    pattern = re.compile(
        r'\{ id: "(?P<id>[^"]+)", name: "(?P<name>[^"]+)", upstream: "(?P<upstream>[^"]+)"(?P<middle>.*?)'
        r'cost: \{ input: (?P<input>[\d.]+), output: (?P<output>[\d.]+), cacheRead: (?P<cache>[\d.]+), cacheWrite: (?P<cache_write>[\d.]+) \}, '
        r'contextWindow: (?P<context>[\d_]+), maxTokens: (?P<max_tokens>[\d_]+) \},',
        re.DOTALL,
    )
    models: dict[str, dict[str, Any]] = {}
    for match in pattern.finditer(source):
        middle = match.group("middle")
        models[match.group("id")] = {
            "modelId": match.group("id"),
            "displayName": match.group("name"),
            "upstream": match.group("upstream"),
            "inputPricePerMillion": float(match.group("input")),
            "outputPricePerMillion": float(match.group("output")),
            "cachedInputPricePerMillion": float(match.group("cache")),
            "cacheWritePricePerMillion": float(match.group("cache_write")),
            "contextWindow": int(match.group("context").replace("_", "")),
            "maxOutputTokens": int(match.group("max_tokens").replace("_", "")),
            "toolCallSupport": match.group("id") != "liquid/lfm-2.5-1.2b-thinking:free",
            "visionSupport": '"image"' in middle,
        }
    if len(models) < 40:
        raise RuntimeError(f"Model registry parser found only {len(models)} entries")
    return models


def load_openhands() -> dict[str, dict[str, Any]]:
    frame = pd.read_csv(OPENHANDS / "outputs/model_coverage.csv")
    required = {"language_model", "swebench_aggregate_score", "swebench_instance_count", "resolved_null_rate"}
    if not required.issubset(frame.columns) or len(frame) != 34:
        raise RuntimeError("Pinned OpenHands coverage table has changed")
    return {str(row.language_model): row._asdict() for row in frame.itertuples(index=False)}


def sufficiency(ability: float) -> dict[str, float]:
    return {
        tier: COMMON_FLOOR + (COMMON_CEILING - COMMON_FLOOR)
        * sigmoid((ability - TIER_DIFFICULTY[tier]) / SHARED_TEMPERATURE)
        for tier in TIER_ORDER
    }


def weighted_quality(ability: float, weights: dict[str, float]) -> float:
    values = sufficiency(ability)
    return sum(weights[tier] * values[tier] for tier in TIER_ORDER)


def solve_ability(anchor: float, weights: dict[str, float]) -> tuple[float, float]:
    low, high = -1.0, 2.0
    for _ in range(100):
        middle = (low + high) / 2.0
        if weighted_quality(middle, weights) < anchor:
            low = middle
        else:
            high = middle
    solved = (low + high) / 2.0
    return solved, weighted_quality(solved, weights) - anchor


def continuous_tier_probabilities(difficulty: float) -> dict[str, float]:
    d = min(1.0, max(0.0, difficulty))
    above_low = sigmoid((d - CURVE_THRESHOLDS["above_low"]) / CURVE_TEMPERATURE)
    above_mid = sigmoid((d - CURVE_THRESHOLDS["above_mid"]) / CURVE_TEMPERATURE)
    above_mid_high = sigmoid((d - CURVE_THRESHOLDS["above_mid_high"]) / CURVE_TEMPERATURE)
    values = {
        "low": 1.0 - above_low,
        "mid": above_low - above_mid,
        "mid_high": above_mid - above_mid_high,
        "high": above_mid_high,
    }
    if min(values.values()) < -1e-12 or abs(sum(values.values()) - 1.0) > 1e-12:
        raise RuntimeError(f"Invalid continuous tier probabilities at {d}")
    return {key: max(0.0, value) for key, value in values.items()}


def sanitize_context(value: str) -> str:
    text = re.sub(r"https?://\S+", "[URL]", value)
    text = re.sub(
        r"(?i)\b(?:gpt[-\w.]*|claude[-\w.]*|gemini[-\w.]*|deepseek[-\w.]*|qwen[-\w.]*|kimi[-\w.]*|minimax[-\w.]*|glm[-\w.]*)\b",
        "[MODEL]",
        text,
    )
    text = re.sub(r"(?i)\b(?:swe-?bench|twinrouterbench|bfcl|qmsum|mtrag|pinchbench)\b", "[TASK]", text)
    text = re.sub(r"[ \t]+$", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) > 2400:
        text = f"{text[:1700]}\n[...deterministic middle truncation...]\n{text[-600:]}"
    return text


def build_few_shots(contexts: pd.DataFrame) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    runtime: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []
    explanations = {
        "low": "单一明确动作，约束少，低档能力即可稳定完成。",
        "mid": "存在多个约束或工具参数，需要中档能力保持一致性。",
        "mid_high": "上下文依赖和执行状态较多，需要中高档能力综合处理。",
        "high": "需要跨多步状态、长上下文或高风险推理，高档能力才较充分。",
    }
    for tier in TIER_ORDER:
        candidates = contexts[(contexts.target_tier == tier) & (contexts.label_confidence != "weak_degradation_search")].copy()
        candidates["length"] = candidates.acu_head_tail_context.str.len()
        candidates["stable_key"] = candidates.context_id.map(lambda value: sha256_text(f"acu-tier-requirement-v1|{value}"))
        # Short examples minimize sensitive content. Scenario diversity is used
        # when available, then stable hash resolves ties.
        candidates = candidates.sort_values(["length", "stable_key"])
        selected = []
        seen_scenarios: set[str] = set()
        for row in candidates.itertuples(index=False):
            if row.scenario in seen_scenarios and len(selected) == 0:
                continue
            selected.append(row)
            seen_scenarios.add(row.scenario)
            if len(selected) == 2:
                break
        if len(selected) < 2:
            raise RuntimeError(f"Insufficient strong-label few-shot examples for {tier}")
        for position, row in enumerate(selected, start=1):
            context = sanitize_context(str(row.acu_head_tail_context))
            runtime.append({
                "exampleId": f"{tier}-{position}",
                "context": context,
                "minimumSufficientTier": tier,
                "explanation": explanations[tier],
            })
            manifest.append({
                "example_id": f"{tier}-{position}",
                "source_context_id": row.context_id,
                "source_context_sha256": sha256_text(str(row.acu_head_tail_context)),
                "prompt_context_sha256": sha256_text(context),
                "minimum_sufficient_tier": tier,
                "label_confidence": row.label_confidence,
                "pipeline_stage": row.pipeline_stage,
                "selection": "short strong-label prefix; stable prompt-version hash; up to two scenario-diverse rows",
                "future_messages_included": False,
                "model_brand_redaction": True,
                "benchmark_name_redaction": True,
            })
    return runtime, manifest


def build_prompt(few_shots: list[dict[str, Any]]) -> str:
    preamble = """# ACU Tier Requirement Judge v1

你是任务能力需求分类器。判断：根据当前完整、可见的 API 上下文，完成下一次模型响应所需的最低充分能力档位。

你不得回答原任务、推荐具体模型、输出代码或透露推理过程。只输出严格 JSON：

```json
{"p_low":0,"p_mid":0,"p_mid_high":0,"p_high":0,"confidence":0,"signals":[],"explanation":""}
```

约束：四档概率位于 0 到 1 且总和为 1；signals 最多 5 个；explanation 不超过 80 个中文字符。档位从低到高分别代表：单一明确执行、中等约束整合、复杂上下文与工具状态整合、高风险或深层多步推理。

以下示例只展示当时可见的上下文，不包含未来消息：
"""
    sections = [preamble]
    for example in few_shots:
        sections.append(
            f"\n## 示例 {example['exampleId']}\n\n上下文：\n```text\n{example['context']}\n```\n\n"
            f"最低充分档位：`{example['minimumSufficientTier']}`\n\n解释：{example['explanation']}\n"
        )
    sections.append("\n现在仅对随后提供的当前 API 上下文输出 JSON。\n")
    return "".join(sections)


def model_call_cost(model: dict[str, Any], input_tokens: int, output_tokens: int) -> float:
    if model["inputPricePerMillion"] is None:
        return math.inf
    return (
        input_tokens * model["inputPricePerMillion"]
        + output_tokens * model["outputPricePerMillion"]
    ) / 1_000_000.0


def main() -> None:
    PHASE.mkdir(parents=True, exist_ok=True)
    CATALOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    registry = parse_model_registry()
    coverage = load_openhands()
    contexts = pd.read_parquet(FOUNDATION / "outputs/acu_step_contexts.parquet")
    if len(contexts) != 970 or contexts.context_id.nunique() != 970:
        raise RuntimeError("Phase 1D context input must contain exactly 970 unique rows")
    counts = contexts.target_tier.value_counts().reindex(TIER_ORDER)
    weights = {tier: float(counts[tier] / len(contexts)) for tier in TIER_ORDER}

    models: list[dict[str, Any]] = []
    for spec in MODEL_SPECS:
        unavailable = bool(spec.get("unavailable"))
        registry_row = None if unavailable else registry.get(spec["model_id"])
        if not unavailable and registry_row is None:
            raise RuntimeError(f"Catalog model is absent from BLOCKRUN_MODELS: {spec['model_id']}")
        evidence_name = spec.get("evidence") or spec["relative_to"]
        evidence = coverage[evidence_name]
        direct_score = float(evidence["swebench_aggregate_score"]) / 100.0
        anchor = min(0.97, max(0.05, direct_score + float(spec.get("delta", 0.0))))
        is_relative = "relative_to" in spec
        confidence = "low" if is_relative else "medium"
        uncertainty = 0.14 if is_relative else 0.08
        solved, error = solve_ability(anchor, weights)
        tiers = sufficiency(solved)
        if not all(tiers[TIER_ORDER[index]] >= tiers[TIER_ORDER[index + 1]] for index in range(3)):
            raise RuntimeError(f"Non-monotone sufficiency for {spec['model_id']}")
        base = registry_row or {
            "modelId": spec["model_id"], "displayName": spec["display_name"], "upstream": "not_configured",
            "inputPricePerMillion": None, "outputPricePerMillion": None,
            "cachedInputPricePerMillion": None, "cacheWritePricePerMillion": None,
            "contextWindow": None, "maxOutputTokens": None, "toolCallSupport": False, "visionSupport": False,
        }
        notes = (
            f"Series-relative estimate: {evidence_name} {direct_score:.3f} plus configured delta {spec['delta']:+.3f}; not a direct benchmark result."
            if is_relative else
            "Direct aggregate anchor from the pinned OpenHands Index SWE-bench evaluation; agent-harness dependent."
        )
        if unavailable:
            notes += " Benchmark-only entry: no matching callable text model exists in BLOCKRUN_MODELS, so routing eligibility is false."
        model = {
            **base,
            "provider": spec["provider"],
            "availability": "benchmark_only_not_configured" if unavailable else "callable_in_repository",
            "routingEligible": not unavailable,
            "defaultDisplay": bool(spec["default"]),
            "abilityAnchor": anchor,
            "solvedAbilityParameter": solved,
            "fittingError": error,
            "sufficientLow": tiers["low"],
            "sufficientMid": tiers["mid"],
            "sufficientMidHigh": tiers["mid_high"],
            "sufficientHigh": tiers["high"],
            "benchmarkEvidence": [{
                "benchmarkName": "SWE-bench Verified via OpenHands Index",
                "normalizedScore": direct_score,
                "scoreScale": "0-1 resolved fraction",
                "sampleSize": int(evidence["swebench_instance_count"]),
                "sourceModelName": evidence_name,
                "evaluationMode": "OpenHands agent harness",
                "sourceUrl": OPENHANDS_SOURCE["url"],
                "resultsUrl": OPENHANDS_SOURCE["results_url"],
                "sourceVersion": OPENHANDS_SOURCE["version"],
                "benchmarkDate": OPENHANDS_SOURCE["benchmark_date"],
                "directForModel": not is_relative,
                "configuredRelativeDelta": float(spec.get("delta", 0.0)),
            }],
            "evidenceConfidence": confidence,
            "uncertaintyWidth": uncertainty,
            "curveMethod": "shared-slope constrained logistic calibrated to Twin published-label distribution",
            "sourceNames": [OPENHANDS_SOURCE["name"], "ClawRouter BLOCKRUN_MODELS"],
            "sourceRetrievedAt": RETRIEVED_AT,
            "notes": notes,
        }
        models.append(model)

    catalog = {
        "schemaVersion": "acu-model-catalog-v1",
        "generatedAt": RETRIEVED_AT,
        "estimateLabel": "public-benchmark constrained estimate",
        "disclaimer": "用于产品演示，不代表具体模型对当前请求的逐题实测成功率。",
        "config": {
            "tierDifficulty": TIER_DIFFICULTY,
            "sharedTemperature": SHARED_TEMPERATURE,
            "commonFloor": COMMON_FLOOR,
            "commonCeiling": COMMON_CEILING,
            "curveThresholds": CURVE_THRESHOLDS,
            "curveTemperature": CURVE_TEMPERATURE,
            "distributionWeights": weights,
            "distributionCounts": {tier: int(counts[tier]) for tier in TIER_ORDER},
            "judge": {
                "model": "deepseek-v4-flash", "baseUrl": "https://api.deepseek.com",
                "mode": "non-thinking", "promptVersion": "acu-tier-requirement-v1",
                "timeoutMs": 8000, "maxContextTokens": 6000, "maxOutputTokens": 300,
            },
            "cost": {"judgeInputTokens": 6000, "judgeOutputTokens": 300, "switchCostUsd": 0.0002},
        },
        "provenance": {
            "twinInput": "research/quality-curves/twinrouterbench/phase1d-foundation/outputs/acu_step_contexts.parquet",
            "twinInputSha256": hashlib.sha256((FOUNDATION / "outputs/acu_step_contexts.parquet").read_bytes()).hexdigest(),
            "openhands": OPENHANDS_SOURCE,
            "priceAndAvailabilitySource": "src/models.ts at build-time",
            "priceAndAvailabilitySourceSha256": hashlib.sha256((ROOT / "src/models.ts").read_bytes()).hexdigest(),
            "crossBenchmarkCaveat": "Product-demo constrained connection; not strict statistical equivalence across benchmarks.",
        },
        "models": models,
    }
    CATALOG_PATH.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    runtime_few_shots, manifest = build_few_shots(contexts)
    FEW_SHOT_PATH.write_text(json.dumps({"promptVersion": "acu-tier-requirement-v1", "examples": runtime_few_shots}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (PHASE / "twin_few_shot_manifest.json").write_text(json.dumps({"prompt_version": "acu-tier-requirement-v1", "examples": manifest}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (PHASE / "judge_prompt_v1.md").write_text(build_prompt(runtime_few_shots), encoding="utf-8")
    (PHASE / "tier_distribution.json").write_text(json.dumps({
        "analysis_name": "TwinRouterBench published-label product distribution",
        "total": len(contexts), "counts": {tier: int(counts[tier]) for tier in TIER_ORDER},
        "weights": weights, "source": catalog["provenance"]["twinInput"],
        "source_sha256": catalog["provenance"]["twinInputSha256"],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    evidence_rows, tier_rows, curve_rows = [], [], []
    for model in models:
        item = model["benchmarkEvidence"][0]
        evidence_rows.append({
            "model_id": model["modelId"], "display_name": model["displayName"], "provider": model["provider"],
            "availability": model["availability"], "ability_anchor": model["abilityAnchor"],
            "benchmark_name": item["benchmarkName"], "source_model_name": item["sourceModelName"],
            "source_normalized_score": item["normalizedScore"], "direct_for_model": item["directForModel"],
            "relative_delta": item["configuredRelativeDelta"], "sample_size": item["sampleSize"],
            "evidence_confidence": model["evidenceConfidence"], "uncertainty_width": model["uncertaintyWidth"],
            "source_url": item["sourceUrl"], "results_url": item["resultsUrl"], "source_version": item["sourceVersion"],
            "source_retrieved_at": model["sourceRetrievedAt"], "notes": model["notes"],
        })
        tier_rows.append({
            "model_id": model["modelId"], "ability_anchor": model["abilityAnchor"],
            "solved_ability_parameter": model["solvedAbilityParameter"], "fitting_error": model["fittingError"],
            "sufficient_low": model["sufficientLow"], "sufficient_mid": model["sufficientMid"],
            "sufficient_mid_high": model["sufficientMidHigh"], "sufficient_high": model["sufficientHigh"],
            "shared_temperature": SHARED_TEMPERATURE, "evidence_confidence": model["evidenceConfidence"],
        })
        for difficulty_score in range(101):
            probs = continuous_tier_probabilities(difficulty_score / 100.0)
            quality = sum(probs[tier] * model[f"sufficient{''.join(part.title() for part in tier.split('_'))}"] for tier in TIER_ORDER)
            curve_rows.append({
                "model_id": model["modelId"], "difficulty_score": difficulty_score,
                **{f"p_{tier}": probs[tier] for tier in TIER_ORDER},
                "estimated_quality": quality,
                "quality_lower": max(0.0, quality - model["uncertaintyWidth"]),
                "quality_upper": min(1.0, quality + model["uncertaintyWidth"]),
                "estimate_label": "public-benchmark constrained estimate",
            })
    pd.DataFrame(evidence_rows).to_csv(PHASE / "model_catalog_evidence.csv", index=False)
    pd.DataFrame(tier_rows).to_csv(PHASE / "model_tier_sufficiency.csv", index=False)
    pd.DataFrame(curve_rows).to_csv(PHASE / "fitted_model_curves.csv", index=False)

    fallback = max((m for m in models if m["routingEligible"]), key=lambda m: m["abilityAnchor"])
    representative_probabilities = [
        ("single_explicit_action", {"low": 0.82, "mid": 0.13, "mid_high": 0.04, "high": 0.01}, 0.90),
        ("multi_constraint_tool_call", {"low": 0.12, "mid": 0.60, "mid_high": 0.23, "high": 0.05}, 0.90),
        ("long_context_execution_state", {"low": 0.04, "mid": 0.16, "mid_high": 0.58, "high": 0.22}, 0.90),
        ("high_risk_multi_step_reasoning", {"low": 0.01, "mid": 0.04, "mid_high": 0.20, "high": 0.75}, 0.90),
    ]
    decision_rows = []
    judge = registry["deepseek-v4-flash"]
    judge_cost = model_call_cost(judge, 6000, 300)
    for fixture, probabilities, target in representative_probabilities:
        candidates = []
        for model in models:
            if not model["routingEligible"]:
                continue
            quality = sum(probabilities[tier] * model[f"sufficient{''.join(part.title() for part in tier.split('_'))}"] for tier in TIER_ORDER)
            conservative = max(0.0, quality - model["uncertaintyWidth"])
            call_cost = model_call_cost(model, 1200, 600)
            fallback_cost = model_call_cost(fallback, 1200, 600)
            total = judge_cost + call_cost + (1.0 - conservative) * (fallback_cost + 0.0002)
            candidates.append((model, quality, conservative, call_cost, total))
        eligible = [item for item in candidates if item[2] >= target]
        selected = min(eligible, key=lambda item: item[4]) if eligible else max(candidates, key=lambda item: item[1])
        model, quality, conservative, call_cost, total = selected
        decision_rows.append({
            "fixture": fixture, **{f"p_{tier}": probabilities[tier] for tier in TIER_ORDER},
            "difficulty_score": 100 * (probabilities["mid"] / 3 + 2 * probabilities["mid_high"] / 3 + probabilities["high"]),
            "quality_target": target, "recommended_model": model["modelId"],
            "estimated_quality": quality, "conservative_quality": conservative,
            "estimated_call_cost": call_cost, "judge_cost": judge_cost, "expected_total_cost": total,
            "fallback_model": fallback["modelId"], "input_tokens": 1200, "output_tokens": 600,
            "probability_source": "deterministic interface fixture; not a live Judge result",
        })
    pd.DataFrame(decision_rows).to_csv(PHASE / "representative_decisions.csv", index=False)
    print(json.dumps({"models": len(models), "routing_eligible": sum(m["routingEligible"] for m in models), "few_shots": len(runtime_few_shots), "curve_rows": len(curve_rows), "tier_counts": counts.to_dict()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
