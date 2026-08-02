#!/usr/bin/env python3
"""Compare sanitized Lucen usage billing with the official ACU catalog."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

COMPONENTS = (
    ("input", "input_tokens", "input_cost"),
    ("output", "output_tokens", "output_cost"),
    ("cache_read", "cache_read_tokens", "cache_read_cost"),
    ("cache_creation", "cache_creation_tokens", "cache_creation_cost"),
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--billing", required=True, type=Path)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    billing = json.loads(args.billing.read_text())
    catalog = {
        item["modelId"]: item
        for item in json.loads(args.catalog.read_text())["models"]
    }
    rows = billing.get("records", billing.get("items"))
    if not isinstance(rows, list):
        raise ValueError("Billing input must contain a records or items array")
    prices: dict[tuple[str, str], Counter[float]] = defaultdict(Counter)
    groups: dict[str, set[str]] = defaultdict(set)
    mismatches = 0

    for row in rows:
        model = row.get("model", "unknown")
        groups[model].add(str(row.get("group_id", "unknown")))
        expected = float(row.get("total_cost", 0)) * float(row.get("rate_multiplier", 1))
        if abs(expected - float(row.get("actual_cost", 0))) > 1e-8:
            mismatches += 1
        for label, token_key, cost_key in COMPONENTS:
            tokens = float(row.get(token_key, 0) or 0)
            cost = float(row.get(cost_key, 0) or 0)
            if tokens > 0 and cost > 0:
                price = round(cost * 1_000_000 / tokens, 8)
                prices[(model, label)][price] += 1

    lines = [
        "# Lucen Usage Reconciliation",
        "",
        f"- Records: {len(rows)}",
        f"- Cost equation mismatches: {mismatches}",
        "",
        "| Model | Groups | Official input/output/cache | Lucen dominant input/output/cache |",
        "| --- | ---: | --- | --- |",
    ]
    for model in sorted(groups):
        observed = []
        for label, _, _ in COMPONENTS[:3]:
            clusters = sorted(
                prices[(model, label)].items(),
                key=lambda item: (-item[1], item[0]),
            )
            observed.append(str(clusters[0][0]) if clusters else "-")
        item = catalog.get(model)
        acu = (
            f"{item['inputPricePerMillion']}/"
            f"{item['outputPricePerMillion']}/"
            f"{item['cachedInputPricePerMillion']}"
            if item
            else "-"
        )
        lines.append(
            f"| `{model}` | {len(groups[model])} | {acu} | "
            f"{'/'.join(observed)} |"
        )

    output = "\n".join(lines) + "\n"
    if args.output:
        args.output.write_text(output)
    else:
        print(output, end="")


if __name__ == "__main__":
    main()
