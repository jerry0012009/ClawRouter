#!/usr/bin/env python3
"""Validate a compact CloseAI pricing snapshot and its optional source HTML."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--html", type=Path)
    args = parser.parse_args()

    snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    if snapshot.get("schemaVersion") != "acu-closeai-pricing-snapshot-v1":
        raise ValueError("Unsupported CloseAI pricing snapshot schema")
    models = snapshot.get("models")
    if not isinstance(models, list) or not models:
        raise ValueError("Snapshot must contain model rows")
    model_ids = [row.get("m") for row in models]
    if any(not isinstance(model_id, str) or not model_id for model_id in model_ids):
        raise ValueError("Every model row must have a non-empty m field")
    if len(model_ids) != len(set(model_ids)):
        raise ValueError("CloseAI snapshot model IDs must be unique")
    coverage = snapshot.get("coverage", {})
    if coverage.get("rows") != len(models) or coverage.get("uniqueModels") != len(set(model_ids)):
        raise ValueError("Snapshot coverage does not match model rows")

    explicit_rows = 0
    promotion_rows_without_multiplier = 0
    for row in models:
        prices = row.get("prices")
        if not isinstance(prices, list) or not prices:
            raise ValueError(f"{row['m']}: missing prices")
        multipliers = [price.get("x") for price in prices if price.get("x") is not None]
        if multipliers:
            explicit_rows += 1
            if any(not isinstance(value, (int, float)) or value <= 0 for value in multipliers):
                raise ValueError(f"{row['m']}: invalid explicit multiplier")
        elif any(price.get("promo") for price in prices):
            promotion_rows_without_multiplier += 1

    html_verified = False
    if args.html:
        actual_hash = hashlib.sha256(args.html.read_bytes()).hexdigest()
        if actual_hash != snapshot.get("sourceHtmlSha256"):
            raise ValueError("Source HTML SHA-256 does not match snapshot")
        html_verified = True

    print(json.dumps({
        "schemaVersion": snapshot["schemaVersion"],
        "models": len(models),
        "explicitMultiplierRows": explicit_rows,
        "promotionRowsWithoutMultiplier": promotion_rows_without_multiplier,
        "htmlSha256Verified": html_verified,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
