#!/usr/bin/env python3
"""Render the Phase 2A public curve gallery from the frozen curve CSV."""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
CURVE_PATH = ROOT / "research/quality-curves/acu-demo/phase2a-tier-model/fitted_model_curves.csv"
CATALOG_PATH = ROOT / "src/acu/catalog/model-catalog.json"
OUTPUT = ROOT / "public/acu-curves"
COLORS = ["#2878b5", "#d49324", "#d55e3a", "#5b8f54", "#b55286"]
LINESTYLES = ["-", "--", "-.", ":"]


def style_axis(axis: plt.Axes, title: str, subtitle: str) -> None:
    axis.set_title(title, loc="left", fontsize=14, fontweight="bold", pad=26, color="#17212b")
    axis.text(0, 1.025, subtitle, transform=axis.transAxes, color="#607080", fontsize=9)
    axis.set_xlim(0, 100)
    axis.set_ylim(0, 1)
    axis.set_xlabel("Display difficulty (0–100)")
    axis.set_ylabel("Estimated sufficiency")
    axis.yaxis.set_major_formatter(lambda value, _: f"{value:.0%}")
    axis.grid(axis="y", color="#dce2e7", linewidth=0.7)
    axis.spines[["top", "right"]].set_visible(False)
    axis.spines[["left", "bottom"]].set_color("#8795a1")


def draw_lines(frame: pd.DataFrame, model_ids: list[str], metadata: dict[str, dict], path: Path,
               title: str, subtitle: str) -> None:
    figure, axis = plt.subplots(figsize=(12, 7), dpi=160)
    style_axis(axis, title, subtitle)
    for index, model_id in enumerate(model_ids):
        rows = frame[frame.model_id == model_id]
        axis.plot(rows.difficulty_score, rows.estimated_quality, color=COLORS[index],
                  linestyle=LINESTYLES[index % len(LINESTYLES)], linewidth=2.2,
                  label=metadata[model_id]["displayName"])
    axis.legend(loc="upper right", frameon=False, fontsize=9)
    figure.text(0.01, 0.01, "Source: frozen Phase 2A curve CSV · constrained estimate, not per-request measured success",
                fontsize=7.5, color="#657482")
    figure.tight_layout(rect=(0, 0.035, 1, 1))
    figure.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(figure)


def draw_provider_facets(frame: pd.DataFrame, metadata: dict[str, dict], path: Path) -> None:
    providers: dict[str, list[dict]] = {}
    for item in metadata.values():
        if item["routingEligible"]:
            providers.setdefault(item["provider"], []).append(item)
    figure, axes = plt.subplots(2, 4, figsize=(15, 8), dpi=160, sharex=True, sharey=True)
    provider_items = sorted(providers.items())
    for axis, (provider, models) in zip(axes.flat, provider_items):
        for index, model in enumerate(models):
            rows = frame[frame.model_id == model["modelId"]]
            axis.plot(rows.difficulty_score, rows.estimated_quality, color=COLORS[index],
                      linestyle=LINESTYLES[index], linewidth=2, label=model["displayName"])
        axis.set_title(provider, loc="left", fontsize=11, fontweight="bold")
        axis.set_xlim(0, 100)
        axis.set_ylim(0, 1)
        axis.grid(axis="y", color="#e1e6ea", linewidth=0.6)
        axis.yaxis.set_major_formatter(lambda value, _: f"{value:.0%}")
        axis.spines[["top", "right"]].set_visible(False)
        axis.legend(loc="upper right", frameon=False, fontsize=7)
    for axis in list(axes.flat)[len(provider_items):]:
        axis.set_visible(False)
    figure.suptitle("Callable model difficulty–quality curves by provider", x=0.06, ha="left",
                     fontsize=16, fontweight="bold", color="#17212b")
    figure.text(0.06, 0.925, "12 catalog models · same tier centers and shared slope · constrained estimates",
                fontsize=9, color="#607080")
    figure.supxlabel("Display difficulty (0–100)")
    figure.supylabel("Estimated sufficiency")
    figure.text(0.01, 0.01, "Source: frozen Phase 2A curve CSV · not per-request measured success",
                fontsize=7.5, color="#657482")
    figure.tight_layout(rect=(0.025, 0.04, 1, 0.91))
    figure.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(figure)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    frame = pd.read_csv(CURVE_PATH)
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    metadata = {item["modelId"]: item for item in catalog["models"]}
    if len(frame) != 13 * 101 or frame.groupby("model_id").size().ne(101).any():
        raise RuntimeError("Frozen curve CSV has an unexpected shape")
    draw_lines(frame, ["claude-opus-4-8", "gemini-3.5-flash", "gpt-5.5", "glm-5.1", "deepseek-v4-flash"], metadata,
               OUTPUT / "representative-model-curves.png", "Representative model difficulty–quality curves",
               "Five capability anchors · shared slope · 101 difficulty points per model")
    draw_lines(frame, ["deepseek-v4-flash", "qwen3.5-flash", "qwen3.6-plus", "glm-5.1", "kimi-k2.6"], metadata,
               OUTPUT / "value-model-curves.png", "Value-model difficulty–quality curves",
               "Cost-oriented candidates; routing still applies conservative quality thresholds")
    draw_provider_facets(frame, metadata, OUTPUT / "provider-model-curves.png")
    print(json.dumps({"images": 3, "output": str(OUTPUT.relative_to(ROOT))}))


if __name__ == "__main__":
    main()
