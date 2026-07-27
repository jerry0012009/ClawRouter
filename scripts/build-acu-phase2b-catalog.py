#!/usr/bin/env python3
"""Build Phase 2B differentiated ACU curves without executing benchmarks or models."""

from __future__ import annotations

import csv
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
PHASE2A = ROOT / "research/quality-curves/acu-demo/phase2a-tier-model"
PHASE = ROOT / "research/quality-curves/acu-demo/phase2b-product"
CATALOG = ROOT / "src/acu/catalog/model-catalog.json"
PRESETS = ROOT / "src/acu/catalog/twin-product-presets.json"
TIER_ORDER = ("low", "mid", "mid_high", "high")
TIER_KEYS = {"low": "Low", "mid": "Mid", "mid_high": "MidHigh", "high": "High"}
TIER_DIFFICULTY = {"low": 0.15, "mid": 0.40, "mid_high": 0.65, "high": 0.88}
WEIGHTS = {"low": 689 / 970, "mid": 62 / 970, "mid_high": 49 / 970, "high": 170 / 970}
CURVE_THRESHOLDS = {"above_low": 0.275, "above_mid": 0.525, "above_mid_high": 0.765}
CURVE_TEMPERATURE = 0.08
RETRIEVED_AT = "2026-07-27"

PROFILES: dict[str, dict[str, Any]] = {
    "frontier_resilient": {"temperature": 0.16, "floor": 0.03, "ceiling": 0.99,
        "adjustments": {"low": -0.010, "mid": -0.005, "mid_high": 0.020, "high": 0.055}},
    "balanced_frontier": {"temperature": 0.135, "floor": 0.03, "ceiling": 0.99,
        "adjustments": {"low": 0.000, "mid": 0.005, "mid_high": 0.015, "high": 0.015}},
    "efficient_fast": {"temperature": 0.095, "floor": 0.025, "ceiling": 0.985,
        "adjustments": {"low": 0.050, "mid": 0.020, "mid_high": -0.060, "high": -0.080}},
    "coding_specialist": {"temperature": 0.125, "floor": 0.03, "ceiling": 0.99,
        "adjustments": {"low": 0.000, "mid": 0.025, "mid_high": 0.050, "high": -0.010}},
}

MODEL_PROFILE = {
    "gpt-5.6-sol": "frontier_resilient", "claude-opus-4-8": "frontier_resilient",
    "gpt-5.6-terra": "balanced_frontier", "gpt-5.5": "balanced_frontier",
    "claude-sonnet-5": "balanced_frontier", "gemini-3.5-flash": "balanced_frontier",
    "deepseek-v4-pro": "balanced_frontier", "glm-5.2": "balanced_frontier",
    "glm-5.1": "balanced_frontier", "qwen3.6-plus": "balanced_frontier",
    "gpt-5.6-luna": "efficient_fast", "gpt-5.4-mini": "efficient_fast",
    "deepseek-v4-flash": "efficient_fast", "qwen3.5-flash": "efficient_fast",
    "kimi-k2.7-code": "coding_specialist", "kimi-k2.6": "coding_specialist",
    "qwen3.7-max": "coding_specialist", "minimax-m3": "balanced_frontier",
}

DEFAULT_MODELS = {
    "claude-opus-4-8", "gpt-5.6-sol", "gpt-5.6-terra",
    "deepseek-v4-flash", "kimi-k2.7-code", "glm-5.2",
}

OFFICIAL = {
    "openai": "https://openai.com/index/gpt-5-6/",
    "openai_sol": "https://openai.com/index/previewing-gpt-5-6-sol/",
    "anthropic": "https://www.anthropic.com/claude/opus",
    "google": "https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-5/",
    "deepseek": "https://api-docs.deepseek.com/news/news260424/",
    "glm": "https://zcode.z.ai/en/docs/agents",
    "kimi": "https://huggingface.co/moonshotai/Kimi-K2.7-Code",
    "qwen": "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/",
    "openhands": "https://huggingface.co/datasets/OpenHands/openhands-index",
}


def sigmoid(value: float) -> float:
    return 1 / (1 + math.exp(-max(-60, min(60, value))))


def registry() -> dict[str, dict[str, Any]]:
    text = (ROOT / "src/models.ts").read_text(encoding="utf-8")
    pattern = re.compile(
        r'\{ id: "(?P<id>[^"]+)", name: "(?P<name>[^"]+)", upstream: "(?P<upstream>[^"]+)"(?P<middle>.*?)'
        r'cost: \{ input: (?P<input>[\d.]+), output: (?P<output>[\d.]+), cacheRead: (?P<cache>[\d.]+), cacheWrite: (?P<write>[\d.]+) \}, '
        r'contextWindow: (?P<context>[\d_]+), maxTokens: (?P<max>[\d_]+) \},', re.DOTALL)
    output = {}
    for match in pattern.finditer(text):
        middle = match.group("middle")
        output[match.group("id")] = {
            "modelId": match.group("id"), "displayName": match.group("name"),
            "upstream": match.group("upstream"),
            "inputPricePerMillion": float(match.group("input")),
            "outputPricePerMillion": float(match.group("output")),
            "cachedInputPricePerMillion": float(match.group("cache")),
            "cacheWritePricePerMillion": float(match.group("write")),
            "contextWindow": int(match.group("context").replace("_", "")),
            "maxOutputTokens": int(match.group("max").replace("_", "")),
            "toolCallSupport": "toolCalling: false" not in middle,
            "visionSupport": '"image"' in middle,
        }
    if len(output) < 45:
        raise RuntimeError(f"Expected at least 45 registry entries, found {len(output)}")
    return output


def project_monotone(values: list[float]) -> list[float]:
    blocks = [[value, 1] for value in values]
    index = 0
    while index < len(blocks) - 1:
        if blocks[index][0] >= blocks[index + 1][0]:
            index += 1
            continue
        weight = blocks[index][1] + blocks[index + 1][1]
        mean = (blocks[index][0] * blocks[index][1] + blocks[index + 1][0] * blocks[index + 1][1]) / weight
        blocks[index:index + 2] = [[mean, weight]]
        index = max(0, index - 1)
    projected: list[float] = []
    for value, count in blocks:
        projected.extend([min(1.0, max(0.0, value))] * count)
    return projected


def tier_values(ability: float, profile_name: str, adjusted: bool = True) -> dict[str, float]:
    profile = PROFILES[profile_name]
    raw = []
    for tier in TIER_ORDER:
        value = profile["floor"] + (profile["ceiling"] - profile["floor"]) * sigmoid(
            (ability - TIER_DIFFICULTY[tier]) / profile["temperature"])
        raw.append(value + (profile["adjustments"][tier] if adjusted else 0))
    return dict(zip(TIER_ORDER, project_monotone(raw), strict=True))


def weighted(ability: float, profile_name: str) -> float:
    values = tier_values(ability, profile_name)
    return sum(WEIGHTS[tier] * values[tier] for tier in TIER_ORDER)


def solve(anchor: float, profile_name: str) -> tuple[float, float]:
    low, high = -1.5, 2.0
    for _ in range(120):
        middle = (low + high) / 2
        if weighted(middle, profile_name) < anchor:
            low = middle
        else:
            high = middle
    ability = (low + high) / 2
    return ability, weighted(ability, profile_name) - anchor


def continuous_probabilities(difficulty: float) -> dict[str, float]:
    above_low = sigmoid((difficulty - CURVE_THRESHOLDS["above_low"]) / CURVE_TEMPERATURE)
    above_mid = sigmoid((difficulty - CURVE_THRESHOLDS["above_mid"]) / CURVE_TEMPERATURE)
    above_high = sigmoid((difficulty - CURVE_THRESHOLDS["above_mid_high"]) / CURVE_TEMPERATURE)
    return {"low": 1 - above_low, "mid": above_low - above_mid,
            "mid_high": above_mid - above_high, "high": above_high}


def phase2a_models() -> dict[str, dict[str, Any]]:
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    if data["schemaVersion"] not in {"acu-model-catalog-v1", "acu-model-catalog-v2"}:
        raise RuntimeError("Unsupported ACU catalog schema")
    models = {model["modelId"]: model for model in data["models"] if model["modelId"] not in {
        "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "glm-5.2", "kimi-k2.7-code"}}
    frozen = pd.read_csv(PHASE2A / "model_tier_sufficiency.csv").set_index("model_id")
    for model_id, model in models.items():
        row = frozen.loc[model_id]
        model["solvedAbilityParameter"] = float(row.solved_ability_parameter)
        model["fittingError"] = float(row.fitting_error)
        for tier in TIER_ORDER:
            model[f"sufficient{TIER_KEYS[tier]}"] = float(row[f"sufficient_{tier}"])
    return models


def relative_model(model_id: str, display: str, provider: str, base: dict[str, Any], delta: float,
                   benchmark: str, source_url: str, notes: str) -> dict[str, Any]:
    model = json.loads(json.dumps(base))
    model.update({"modelId": model_id, "displayName": display, "provider": provider,
                  "abilityAnchor": min(0.97, max(0.05, base["abilityAnchor"] + delta)),
                  "evidenceConfidence": "low", "uncertaintyWidth": 0.14,
                  "notes": notes})
    model["benchmarkEvidence"] = [{
        "benchmarkName": benchmark, "normalizedScore": model["abilityAnchor"],
        "scoreScale": "relative family mapping onto pinned OpenHands anchor scale",
        "sampleSize": 0, "sourceModelName": model_id, "evaluationMode": "vendor-reported; not OpenHands-comparable",
        "sourceUrl": source_url, "resultsUrl": source_url, "sourceVersion": "retrieved-2026-07-27",
        "benchmarkDate": "2026-07-09" if model_id.startswith("gpt-5.6") else "2026-07-27",
        "directForModel": False, "configuredRelativeDelta": delta,
    }]
    return model


def evidence_rows() -> list[dict[str, str]]:
    rows = []
    def add(models: str, dimensions: str, source: str, claim: str, confidence: str = "medium") -> None:
        rows.append({"model_ids": models, "dimensions": dimensions, "source_type": "vendor_official",
                     "source_url": source, "retrieved_at": RETRIEVED_AT, "profile_claim": claim,
                     "profile_confidence": confidence, "comparability_note": "Curve-shape evidence only; not merged into a common benchmark score."})
    add("gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna", "broad coding|latency/cost positioning|context capability", OFFICIAL["openai"], "Sol is flagship, Terra balanced, Luna fastest/cost-efficient; official release reports a 1.05M context window.")
    add("gpt-5.6-sol", "terminal/tool use|long-horizon agent|repository engineering", OFFICIAL["openai_sol"], "Official preview positions Sol for coding, terminal and long-horizon agent work.")
    add("claude-opus-4-8", "repository engineering|long-horizon agent|context capability", OFFICIAL["anthropic"], "Official Opus page emphasizes long-running coding and agent tasks with sustained consistency.")
    add("gemini-3.5-flash", "terminal/tool use|long-horizon agent|latency/cost positioning", OFFICIAL["google"], "Official release reports agentic/terminal benchmarks and fast deployment positioning.")
    add("deepseek-v4-flash|deepseek-v4-pro", "terminal/tool use|long-horizon agent|latency/cost positioning", OFFICIAL["deepseek"], "Official comparison says Flash is near Pro on simple agent tasks while Pro leads on complex reasoning.", "high")
    add("glm-5.2", "repository engineering|terminal/tool use|long-horizon agent", OFFICIAL["glm"], "Official coding-agent documentation targets multi-turn, tool-driven engineering workflows.")
    add("kimi-k2.7-code", "broad coding|repository engineering|terminal/tool use|long-horizon agent", OFFICIAL["kimi"], "Official model card reports gains over K2.6 across coding-agent suites, with harness differences explicitly noted.")
    add("qwen3.7-max|qwen3.6-plus|qwen3.5-flash", "broad coding|context capability|latency/cost positioning", OFFICIAL["qwen"], "Official Qwen Code provider documentation identifies current model roles; direct cross-vendor score comparability is unavailable.", "low")
    rows.append({"model_ids": "all_phase2a_models", "dimensions": "broad coding|repository engineering", "source_type": "benchmark_official",
                 "source_url": OFFICIAL["openhands"], "retrieved_at": RETRIEVED_AT,
                 "profile_claim": "Pinned OpenHands SWE-bench aggregates retain overall ability positions.", "profile_confidence": "medium",
                 "comparability_note": "Agent-harness-dependent aggregate; used for position, not curve shape."})
    return rows


def build_models() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    old = phase2a_models()
    reg = registry()
    new = dict(old)
    new["gpt-5.6-sol"] = relative_model("gpt-5.6-sol", "GPT-5.6 Sol", "OpenAI", old["gpt-5.5"], 0.060, "GPT-5.6 official capability suite", OFFICIAL["openai"], "Family-relative product mapping from GPT-5.5; official results are not OpenHands-harness results.")
    new["gpt-5.6-terra"] = relative_model("gpt-5.6-terra", "GPT-5.6 Terra", "OpenAI", old["gpt-5.5"], 0.030, "GPT-5.6 official capability suite", OFFICIAL["openai"], "Family-relative product mapping from GPT-5.5; proxy price metadata unavailable.")
    new["gpt-5.6-luna"] = relative_model("gpt-5.6-luna", "GPT-5.6 Luna", "OpenAI", old["gpt-5.5"], 0.010, "GPT-5.6 official capability suite", OFFICIAL["openai"], "Family-relative product mapping from GPT-5.5; efficient profile follows official positioning.")
    new["glm-5.2"] = relative_model("glm-5.2", "GLM 5.2", "Zhipu AI", old["glm-5.1"], 0.025, "GLM-5.2 official coding-agent positioning", OFFICIAL["glm"], "Series-relative estimate from GLM 5.1; no directly comparable pinned OpenHands row.")
    new["kimi-k2.7-code"] = relative_model("kimi-k2.7-code", "Kimi K2.7 Code", "Moonshot AI", old["kimi-k2.6"], 0.030, "Kimi K2.7 Code official model-card suites", OFFICIAL["kimi"], "Series-relative estimate from K2.6; vendor comparisons use different agent harnesses.")
    output, parameters = [], []
    for model_id, model in new.items():
        profile_name = MODEL_PROFILE[model_id]
        profile = PROFILES[profile_name]
        before = {tier: model[f"sufficient{TIER_KEYS[tier]}"] for tier in TIER_ORDER}
        before_ability = model["solvedAbilityParameter"]
        if model_id in reg:
            model.update(reg[model_id])
            model["availability"] = "callable_preflight_or_repository"
            model["routingEligible"] = True
        elif model_id == "minimax-m3":
            model["routingEligible"] = False
        ability, error = solve(model["abilityAnchor"], profile_name)
        final = tier_values(ability, profile_name)
        model.update({
            "defaultDisplay": model_id in DEFAULT_MODELS and model.get("routingEligible", False),
            "solvedAbilityParameter": ability, "fittingError": error,
            **{f"sufficient{TIER_KEYS[tier]}": final[tier] for tier in TIER_ORDER},
            "curveProfile": profile_name, "curveTemperature": profile["temperature"],
            "curveFloor": profile["floor"], "curveCeiling": profile["ceiling"],
            "tierAdjustments": {"low": profile["adjustments"]["low"], "mid": profile["adjustments"]["mid"],
                                "midHigh": profile["adjustments"]["mid_high"], "high": profile["adjustments"]["high"]},
            "profileEvidence": [row["source_url"] for row in evidence_rows() if model_id in row["model_ids"] or row["model_ids"] == "all_phase2a_models"],
            "profileConfidence": "high" if model_id.startswith("deepseek-v4") else ("medium" if model_id in DEFAULT_MODELS else "low"),
            "curveMethod": "profiled constrained logistic; monotone projection; Twin-distribution anchor preservation",
        })
        output.append(model)
        parameters.append({"model_id": model_id, "ability_anchor": model["abilityAnchor"],
            "before_ability_parameter": before_ability, "after_ability_parameter": ability,
            "curve_profile": profile_name, "before_temperature": 0.12, "after_temperature": profile["temperature"],
            "curve_floor": profile["floor"], "curve_ceiling": profile["ceiling"],
            **{f"adjustment_{tier}": profile["adjustments"][tier] for tier in TIER_ORDER},
            **{f"before_sufficient_{tier}": before[tier] for tier in TIER_ORDER},
            **{f"after_sufficient_{tier}": final[tier] for tier in TIER_ORDER},
            "weighted_fit_error": error, "profile_confidence": model["profileConfidence"]})
    return output, parameters


def plot_curves(curves: pd.DataFrame, models: list[dict[str, Any]]) -> None:
    plt.style.use("seaborn-v0_8-whitegrid")
    figures = PHASE / "figures"
    figures.mkdir(parents=True, exist_ok=True)
    public = ROOT / "public/acu-curves"
    public.mkdir(parents=True, exist_ok=True)
    labels = {model["modelId"]: model["displayName"] for model in models}
    default = [model["modelId"] for model in models if model["defaultDisplay"]]
    fig, ax = plt.subplots(figsize=(12, 7))
    for model_id in default:
        part = curves[curves.model_id == model_id]
        ax.plot(part.difficulty_score, part.estimated_score, linewidth=2.4, label=labels[model_id])
    ax.set(xlabel="Request difficulty", ylabel="Estimated model score", title="Phase 2B differentiated hero-model curves", xlim=(0, 100), ylim=(0, 100))
    ax.legend(ncol=2); fig.tight_layout()
    fig.savefig(figures / "hero_model_curves.png", dpi=180); fig.savefig(public / "representative-model-curves.png", dpi=180); plt.close(fig)
    costs = {m["modelId"]: (m["inputPricePerMillion"] or math.inf) + (m["outputPricePerMillion"] or math.inf) for m in models}
    mids = curves[curves.difficulty_score == 55].copy(); mids["cost_index"] = mids.model_id.map(costs)
    mids = mids[mids.cost_index < math.inf]
    efficient = []
    for row in mids.itertuples():
        dominated = any((other.estimated_score >= row.estimated_score and other.cost_index <= row.cost_index)
                        and (other.estimated_score > row.estimated_score or other.cost_index < row.cost_index)
                        for other in mids.itertuples())
        if not dominated: efficient.append(row.model_id)
    fig, ax = plt.subplots(figsize=(11, 7))
    for model_id in efficient:
        part = curves[curves.model_id == model_id]
        ax.plot(part.difficulty_score, part.estimated_score, linewidth=2.2, label=labels[model_id])
    ax.set(xlabel="Request difficulty", ylabel="Estimated model score", title="Cost-quality efficient-frontier models", xlim=(0, 100), ylim=(0, 100)); ax.legend(); fig.tight_layout()
    fig.savefig(figures / "value_frontier_curves.png", dpi=180); fig.savefig(public / "value-model-curves.png", dpi=180); plt.close(fig)
    providers = sorted({m["provider"] for m in models if m["routingEligible"]})
    columns = 3; rows = math.ceil(len(providers) / columns)
    fig, axes = plt.subplots(rows, columns, figsize=(15, rows * 4.2), squeeze=False)
    for ax, provider in zip(axes.flat, providers):
        for model in [m for m in models if m["provider"] == provider and m["routingEligible"]]:
            part = curves[curves.model_id == model["modelId"]]
            ax.plot(part.difficulty_score, part.estimated_score, label=model["displayName"])
        ax.set_title(provider); ax.set_xlim(0, 100); ax.set_ylim(0, 100); ax.legend(fontsize=7)
    for ax in axes.flat[len(providers):]: ax.axis("off")
    fig.supxlabel("Request difficulty"); fig.supylabel("Estimated model score"); fig.tight_layout()
    fig.savefig(figures / "all_models_by_provider.png", dpi=180); fig.savefig(public / "provider-model-curves.png", dpi=180); plt.close(fig)


def main() -> None:
    PHASE.mkdir(parents=True, exist_ok=True)
    models, parameters = build_models()
    base = json.loads(CATALOG.read_text(encoding="utf-8"))
    base.update({"schemaVersion": "acu-model-catalog-v2", "generatedAt": RETRIEVED_AT,
                 "estimateLabel": "public-benchmark constrained model score",
                 "disclaimer": "预计模型得分用于相对匹配演示，不代表逐请求实测成功率。", "models": models})
    base["config"].update({"sharedTemperature": None, "commonFloor": None, "commonCeiling": None,
                           "profileConstraints": {"temperature": [0.09, 0.17], "floor": [0.01, 0.06],
                                                  "ceiling": [0.96, 0.995], "maxAbsoluteTierAdjustment": 0.08},
                           "defaultQualityTarget": 0.8,
                           "valueUtility": {
                               "qualityWeightAtPreference60": 0.58,
                               "qualityWeightAtPreference95": 0.82,
                               "uncertaintyRiskWeightAtPreference60": 0.20,
                               "uncertaintyRiskWeightAtPreference95": 0.45,
                               "qualityExponentAtPreference60": 0.8,
                               "qualityExponentAtPreference95": 2.0,
                               "combination": "qualityUtility * (qualityWeight + costWeight * costUtility)",
                               "costTransform": "pareto-frontier log-relative",
                               "hardScoreThreshold": False,
                           }})
    base["config"].pop("nearEqualTolerancePoints", None)
    base["provenance"].update({"phase2aCatalogSha256": hashlib.sha256(CATALOG.read_bytes()).hexdigest(),
                               "phase2bBuilder": "scripts/build-acu-phase2b-catalog.py",
                               "gpt56ProxyPricing": "not exposed; official list price used",
                               "profileEvidence": "research/quality-curves/acu-demo/phase2b-product/curve_profile_evidence.csv"})
    CATALOG.write_text(json.dumps(base, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    few_shots = json.loads((ROOT / "src/acu/catalog/twin-few-shots.json").read_text(encoding="utf-8"))["examples"]
    labels = {
        "low-1": ("简单明确任务 A", "单一明确执行"), "low-2": ("简单明确任务 B", "低约束回应"),
        "mid-1": ("常规多约束任务 A", "多条件整合"), "mid-2": ("常规多约束任务 B", "工具参数与一致性"),
        "mid_high-1": ("多工具/调试任务 A", "执行状态整合"), "mid_high-2": ("多工具/调试任务 B", "上下文依赖调试"),
        "high-1": ("高风险长程 Agent 任务 A", "长程多步推理"), "high-2": ("高风险长程 Agent 任务 B", "高风险工具链"),
    }
    product_presets = []
    for example in few_shots:
        title, category = labels[example["exampleId"]]
        product_presets.append({"id": example["exampleId"], "title": title, "category": category,
            "source": "TwinRouterBench", "publishedTier": example["minimumSufficientTier"],
            "request": {"model": "auto", "messages": [{"role": "user", "content": example["context"]}]}})
    PRESETS.write_text(json.dumps({"schemaVersion": "acu-twin-presets-v1", "examples": product_presets}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    pd.DataFrame(evidence_rows()).to_csv(PHASE / "curve_profile_evidence.csv", index=False)
    pd.DataFrame(parameters).to_csv(PHASE / "curve_profile_parameters.csv", index=False)
    tier_rows, curve_rows = [], []
    for model in models:
        tier_rows.append({"model_id": model["modelId"], "display_name": model["displayName"],
            "routing_eligible": model["routingEligible"], "default_display": model["defaultDisplay"],
            "ability_anchor": model["abilityAnchor"], "solved_ability_parameter": model["solvedAbilityParameter"],
            "curve_profile": model["curveProfile"], **{f"sufficient_{tier}": model[f"sufficient{TIER_KEYS[tier]}"] for tier in TIER_ORDER},
            "evidence_confidence": model["evidenceConfidence"], "profile_confidence": model["profileConfidence"]})
        for score in range(101):
            probs = continuous_probabilities(score / 100)
            quality = sum(probs[tier] * model[f"sufficient{TIER_KEYS[tier]}"] for tier in TIER_ORDER)
            curve_rows.append({"model_id": model["modelId"], "display_name": model["displayName"],
                "provider": model["provider"], "curve_profile": model["curveProfile"], "difficulty_score": score,
                **{f"p_{tier}": probs[tier] for tier in TIER_ORDER}, "estimated_score": quality * 100,
                "score_lower": max(0, quality - model["uncertaintyWidth"]) * 100,
                "score_upper": min(1, quality + model["uncertaintyWidth"]) * 100})
    pd.DataFrame(tier_rows).to_csv(PHASE / "model_tier_sufficiency_v2.csv", index=False)
    curves = pd.DataFrame(curve_rows); curves.to_csv(PHASE / "fitted_model_curves_v2.csv", index=False)
    plot_curves(curves, models)
    print(json.dumps({"models": len(models), "eligible": sum(m["routingEligible"] for m in models),
                      "defaults": [m["modelId"] for m in models if m["defaultDisplay"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
