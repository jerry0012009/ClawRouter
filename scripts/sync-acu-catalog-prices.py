#!/usr/bin/env python3
"""Synchronize ACU Catalog prices from the model registry without rebuilding curves."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src/models.ts"
CATALOG = ROOT / "src/acu/catalog/model-catalog.json"
PRICE_VERSION = "acu-price-2026-08-01-lucen-v1"
GENERATED_AT = "2026-08-01"


def source_prices() -> dict[str, tuple[float, float, float, float]]:
    source = SOURCE.read_text(encoding="utf-8")
    pattern = re.compile(
        r'\{ id: "(?P<id>[^"]+)".*?cost: \{ input: (?P<input>[\d.]+), '
        r'output: (?P<output>[\d.]+), cacheRead: (?P<cache>[\d.]+), '
        r'cacheWrite: (?P<write>[\d.]+) \}',
        re.DOTALL,
    )
    return {
        match.group("id"): tuple(float(match.group(key)) for key in ("input", "output", "cache", "write"))
        for match in pattern.finditer(source)
    }


def main() -> None:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    prices = source_prices()
    missing = sorted(
        model["modelId"] for model in catalog["models"]
        if model["modelId"] not in prices and model.get("routingEligible") is not False
    )
    if missing:
        raise RuntimeError(f"Catalog models missing from src/models.ts: {', '.join(missing)}")
    for model in catalog["models"]:
        if model["modelId"] not in prices:
            continue
        input_price, output_price, cache_read, cache_write = prices[model["modelId"]]
        model.update({
            "inputPricePerMillion": input_price,
            "outputPricePerMillion": output_price,
            "cachedInputPricePerMillion": cache_read,
            "cacheWritePricePerMillion": cache_write,
        })
    catalog["generatedAt"] = GENERATED_AT
    catalog["priceVersion"] = PRICE_VERSION
    catalog["provenance"]["priceAndAvailabilitySource"] = "src/models.ts at build-time"
    catalog["provenance"]["priceAndAvailabilitySourceSha256"] = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
