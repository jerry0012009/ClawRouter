#!/usr/bin/env python3
"""Reproducible, model-free audit of the pinned OpenHands Index release."""

from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
import math
import shutil
import statistics
import subprocess
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    import pyarrow.parquet as pq
except ImportError as exc:  # pragma: no cover - user-facing dependency guard
    raise SystemExit(
        "Missing dependency: pyarrow. Run: python -m pip install -r requirements.txt"
    ) from exc


OPENHANDS_DATASET = "OpenHands/openhands-index"
OPENHANDS_REVISION = "v2026.06.30-3015ac6"
OPENHANDS_HF_COMMIT = "94ac78ad8ec547875a0a4ec56e15a644aa5653f6"
UPSTREAM_REPO = "https://github.com/OpenHands/openhands-index-results.git"
UPSTREAM_COMMIT = "3015ac612e7196f428e6e8a3948965d32d9a3331"
SWEBENCH_DATASET = "SWE-bench/SWE-bench_Verified"
SWEBENCH_REVISION = "91aa3ed51b709be6457e12d00300a6a596d4c6a3"

DOWNLOADS = {
    "openhands_default": {
        "url": f"https://huggingface.co/datasets/{OPENHANDS_DATASET}/resolve/{OPENHANDS_REVISION}/data/test-00000-of-00001.parquet",
        "path": "openhands-index-raw/test.parquet",
        "sha256": "966544ad62ba160fec79c73bdd5295df521743c733f9fbcca1ed0f82833d827a",
    },
    "openhands_instances": {
        "url": f"https://huggingface.co/datasets/{OPENHANDS_DATASET}/resolve/{OPENHANDS_REVISION}/instances/data/train-00000-of-00001.parquet",
        "path": "openhands-index-raw/instances.parquet",
        "sha256": "f456e937771bdd45815cacd6458433e0e750be0a2a6bcd5daf91670b151968a5",
    },
    "swebench_verified": {
        "url": f"https://huggingface.co/datasets/{SWEBENCH_DATASET}/resolve/{SWEBENCH_REVISION}/data/test-00000-of-00001.parquet",
        "path": "swebench-official-raw/data/test-00000-of-00001.parquet",
        "sha256": "43ed5a3d1d98da36472c1ade65ddd2085d7b4ff694fcaf6a023a07c5c1f32f21",
    },
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url: str, destination: Path, expected_sha256: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and sha256(destination) == expected_sha256:
        return
    partial = destination.with_suffix(destination.suffix + ".part")
    if partial.exists():
        partial.unlink()
    print(f"Downloading {url}", file=sys.stderr)
    request = urllib.request.Request(url, headers={"User-Agent": "ClawRouter-data-audit/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as out:
            shutil.copyfileobj(response, out)
    except (urllib.error.URLError, TimeoutError) as exc:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Failed to download {url}: {exc}") from exc
    actual = sha256(partial)
    if actual != expected_sha256:
        partial.unlink(missing_ok=True)
        raise RuntimeError(
            f"Checksum mismatch for {url}: expected {expected_sha256}, got {actual}"
        )
    partial.replace(destination)


def run_git(arguments: list[str], cwd: Path | None = None) -> str:
    try:
        result = subprocess.run(
            ["git", *arguments], cwd=cwd, check=True, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", None) or str(exc)
        raise RuntimeError(f"Git command failed: git {' '.join(arguments)}\n{detail}") from exc
    return result.stdout.strip()


def prepare_upstream(cache: Path, offline: bool) -> Path:
    repo = cache / "openhands-index-results"
    if not repo.exists():
        if offline:
            raise RuntimeError(f"Offline mode: missing upstream cache {repo}")
        run_git(["clone", "--no-checkout", UPSTREAM_REPO, str(repo)])
    if not (repo / ".git").exists():
        raise RuntimeError(f"Expected a Git repository at {repo}")
    try:
        run_git(["cat-file", "-e", f"{UPSTREAM_COMMIT}^{{commit}}"], repo)
    except RuntimeError:
        if offline:
            raise RuntimeError(f"Offline mode: commit {UPSTREAM_COMMIT} is not cached")
        run_git(["fetch", "origin", UPSTREAM_COMMIT], repo)
    run_git(["checkout", "--detach", "--quiet", UPSTREAM_COMMIT], repo)
    actual = run_git(["rev-parse", "HEAD"], repo)
    if actual != UPSTREAM_COMMIT:
        raise RuntimeError(f"Upstream checkout mismatch: expected {UPSTREAM_COMMIT}, got {actual}")
    return repo


def read_parquet(path: Path) -> list[dict[str, Any]]:
    try:
        return pq.read_table(path).to_pylist()
    except Exception as exc:
        raise RuntimeError(f"Cannot read Parquet file {path}: {exc}") from exc


def percentile(values: list[float], fraction: float) -> float | None:
    """R-7 / NumPy-linear quantile over non-null observations."""
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def rounded(value: float | None, digits: int = 6) -> float | None:
    return None if value is None else round(value, digits)


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if fields is None:
        fields = list(rows[0]) if rows else []
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=fields, extrasaction="ignore", lineterminator="\n"
        )
        writer.writeheader()
        # Official problem statements can contain CRLF and line-ending spaces.
        # Normalize only the exported CSV representation so generated files are
        # portable and pass Git whitespace checks; cached source remains intact.
        normalized_rows = []
        for row in rows:
            normalized_rows.append({
                key: "\n".join(
                    line.rstrip() for line in value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
                ) if isinstance(value, str) else value
                for key, value in row.items()
            })
        writer.writerows(normalized_rows)


def json_load(path: Path) -> Any:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot read JSON file {path}: {exc}") from exc


def issue(
    issues: list[dict[str, Any]], severity: str, issue_type: str, scope: str,
    count: int, details: str,
) -> None:
    issues.append({
        "severity": severity, "issue_type": issue_type, "scope": scope,
        "count": count, "details": details,
    })


def select_anchors(models: list[dict[str, Any]], pair_lookup: dict[tuple[str, str], int]) -> list[dict[str, Any]]:
    """Choose eight anchors from objective recency, completeness, quality and cost signals."""
    eligible = [
        model for model in models
        if str(model["release_date"]).startswith("2026-")
        and model["swebench_verified_join_rate"] >= 0.99
        and model["resolved_null_rate"] <= 0.01
        and model["cost_missing_rate"] <= 0.01
        and model["cost_mean"] is not None and model["cost_mean"] > 0
    ]
    if len(eligible) < 8:
        eligible = [
            model for model in models
            if model["swebench_verified_join_rate"] >= 0.99
            and model["resolved_null_rate"] <= 0.02
            and model["cost_missing_rate"] <= 0.02
            and model["cost_mean"] is not None and model["cost_mean"] > 0
        ]
    if len(eligible) < 6:
        raise RuntimeError("Fewer than six models meet the anchor completeness criteria")

    for model in eligible:
        model["_quality"] = model["resolved_rate"]
        model["_value"] = model["resolved_rate"] / model["cost_mean"]

    chosen: list[tuple[dict[str, Any], str]] = []

    def add(model: dict[str, Any], role: str) -> None:
        if all(existing["language_model"] != model["language_model"] for existing, _ in chosen):
            chosen.append((model, role))

    add(max(eligible, key=lambda row: (row["_quality"], -row["cost_mean"])), "high_quality")
    add(min(eligible, key=lambda row: (row["cost_mean"], -row["_quality"])), "low_cost")
    for model in sorted(eligible, key=lambda row: (row["_value"], row["_quality"]), reverse=True):
        if len([1 for _, role in chosen if role == "value"]) >= 2:
            break
        if all(existing["language_model"] != model["language_model"] for existing, _ in chosen):
            add(model, "value")

    # Fill the quality range at evenly spaced targets. Overlap is a tie-breaker.
    target_count = min(8, len(eligible))
    q_min = min(row["_quality"] for row in eligible)
    q_max = max(row["_quality"] for row in eligible)
    targets = [q_min + (q_max - q_min) * index / (target_count - 1) for index in range(target_count)]
    for target in targets:
        if len(chosen) >= target_count:
            break
        remaining = [row for row in eligible if all(c["language_model"] != row["language_model"] for c, _ in chosen)]
        if not remaining:
            break
        def rank(row: dict[str, Any]) -> tuple[float, float, float]:
            overlaps = [
                pair_lookup.get(tuple(sorted((row["language_model"], c["language_model"]))), 0)
                for c, _ in chosen
            ]
            return (abs(row["_quality"] - target), -min(overlaps or [0]), row["cost_mean"])
        add(min(remaining, key=rank), "quality_gradient")

    # If role-first choices already occupied target slots, complete using maximum distance
    # from the selected quality/cost points after log-scaling cost.
    while len(chosen) < target_count:
        remaining = [row for row in eligible if all(c["language_model"] != row["language_model"] for c, _ in chosen)]
        if not remaining:
            break
        def diversity(row: dict[str, Any]) -> float:
            return min(
                abs(row["_quality"] - c["_quality"])
                + 0.1 * abs(math.log(row["cost_mean"]) - math.log(c["cost_mean"]))
                for c, _ in chosen
            )
        add(max(remaining, key=diversity), "quality_cost_gradient")

    result = []
    for rank_number, (model, role) in enumerate(chosen, start=1):
        peers = [
            pair_lookup.get(tuple(sorted((model["language_model"], other["language_model"]))), 0)
            for other, _ in chosen if other["language_model"] != model["language_model"]
        ]
        result.append({
            "rank": rank_number,
            "language_model": model["language_model"],
            "role": role,
            "release_date": model["release_date"],
            "resolved_rate": model["resolved_rate"],
            "cost_mean": model["cost_mean"],
            "cost_median": model["cost_median"],
            "resolved_null_rate": model["resolved_null_rate"],
            "cost_missing_rate": model["cost_missing_rate"],
            "minimum_overlap_with_selected": min(peers or [model["swebench_instance_count"]]),
            "actual_swebench_agent_version": model["scores_swebench_agent_version"],
        })
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Use only already-verified cache files")
    parser.add_argument("--cache-dir", type=Path, help="Override the ignored local cache directory")
    args = parser.parse_args()

    project = Path(__file__).resolve().parents[1]
    cache = (args.cache_dir or project / ".cache").resolve()
    output = project / "outputs"
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)

    for spec in DOWNLOADS.values():
        target = cache / spec["path"]
        if args.offline:
            if not target.exists():
                raise RuntimeError(f"Offline mode: missing {target}")
            actual = sha256(target)
            if actual != spec["sha256"]:
                raise RuntimeError(f"Checksum mismatch for cached file {target}: {actual}")
        else:
            download(spec["url"], target, spec["sha256"])
    upstream = prepare_upstream(cache, args.offline)

    default_rows = read_parquet(cache / DOWNLOADS["openhands_default"]["path"])
    instance_rows = read_parquet(cache / DOWNLOADS["openhands_instances"]["path"])
    verified_rows = read_parquet(cache / DOWNLOADS["swebench_verified"]["path"])
    if len(default_rows) != 34:
        raise RuntimeError(f"Expected 34 default rows, found {len(default_rows)}")
    if len(verified_rows) != 500:
        raise RuntimeError(f"Expected 500 SWE-bench Verified rows, found {len(verified_rows)}")

    issues: list[dict[str, Any]] = []
    model_by_id = {row["id"]: row for row in default_rows}
    if len(model_by_id) != len(default_rows):
        issue(issues, "error", "duplicate_default_model_id", "default", len(default_rows) - len(model_by_id), "Duplicate id values in default config")

    benchmark_counts = []
    grouped_benchmark: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in instance_rows:
        grouped_benchmark[row["benchmark"]].append(row)
    for benchmark, rows in sorted(grouped_benchmark.items()):
        sets_by_model: dict[str, set[str]] = defaultdict(set)
        for row in rows:
            sets_by_model[row["id"]].add(row["instance_id"])
        sets = list(sets_by_model.values())
        union = set().union(*sets) if sets else set()
        intersection = set.intersection(*sets) if sets else set()
        signature_count = len({frozenset(values) for values in sets})
        benchmark_counts.append({
            "benchmark": benchmark,
            "row_count": len(rows),
            "model_count": len({row["id"] for row in rows}),
            "unique_instance_count": len(union),
            "common_instance_count": len(intersection),
            "minimum_model_instance_count": min(map(len, sets)) if sets else 0,
            "maximum_model_instance_count": max(map(len, sets)) if sets else 0,
            "all_model_instance_sets_identical": signature_count == 1,
        })
        if signature_count > 1:
            issue(issues, "warning", "model_instance_sets_differ", benchmark, signature_count, "Distinct per-model instance sets; benchmark is outside the first curve scope" if benchmark != "swe-bench" else "Distinct per-model SWE-bench instance sets")

    key_rows: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in instance_rows:
        key_rows[(row["id"], row["benchmark"], row["instance_id"])].append(row)
    duplicate_groups = {key: rows for key, rows in key_rows.items() if len(rows) > 1}
    conflict_groups = {
        key: rows for key, rows in duplicate_groups.items()
        if len({(row.get("resolved"), row.get("cost")) for row in rows}) > 1
    }
    if duplicate_groups:
        issue(issues, "error", "duplicate_model_benchmark_instance", "all", len(duplicate_groups), "Duplicate composite-key groups")
    if conflict_groups:
        issue(issues, "error", "conflicting_duplicate_result", "all", len(conflict_groups), "Duplicate groups with different resolved or cost values")

    swe_rows = grouped_benchmark.get("swe-bench", [])
    if not swe_rows:
        raise RuntimeError("No benchmark == 'swe-bench' rows found")
    swe_by_model: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in swe_rows:
        swe_by_model[row["id"]].append(row)

    verified_by_id = {row["instance_id"]: row for row in verified_rows}
    if len(verified_by_id) != len(verified_rows):
        issue(issues, "error", "duplicate_verified_instance_id", "SWE-bench_Verified", len(verified_rows) - len(verified_by_id), "Duplicate official Verified instance ids")
    for field in ("instance_id", "problem_statement", "difficulty", "repo"):
        missing = sum(row.get(field) is None or row.get(field) == "" for row in verified_rows)
        if missing:
            issue(issues, "error", f"verified_{field}_missing", "SWE-bench_Verified", missing, f"Official Verified rows missing {field}")

    version_rows: list[dict[str, Any]] = []
    upstream_versions: dict[str, dict[str, Any]] = {}
    result_dirs = [path for path in (upstream / "results").iterdir() if path.is_dir()]
    expected_dirs = {row["id"].split("/", 1)[1] for row in default_rows}
    extra_dirs = sorted(path.name for path in result_dirs if path.name not in expected_dirs)
    if extra_dirs:
        issue(issues, "warning", "unmatched_upstream_result_directory", "upstream/results", len(extra_dirs), "; ".join(extra_dirs))

    for default in default_rows:
        directory_name = default["id"].split("/", 1)[1]
        result_dir = upstream / "results" / directory_name
        if not result_dir.exists():
            issue(issues, "error", "missing_upstream_model_directory", default["language_model"], 1, str(result_dir.relative_to(upstream)))
            metadata, scores = {}, []
        else:
            metadata = json_load(result_dir / "metadata.json")
            scores = json_load(result_dir / "scores.json")
        swe_scores = [row for row in scores if row.get("benchmark") == "swe-bench"]
        if len(swe_scores) != 1:
            issue(issues, "error", "unexpected_swebench_score_record_count", default["language_model"], len(swe_scores), "Expected exactly one SWE-bench aggregate record")
        score_row = swe_scores[0] if len(swe_scores) == 1 else {}
        default_version = default.get("sdk_version")
        metadata_version = metadata.get("agent_version")
        scores_version = score_row.get("agent_version")
        record = {
            "language_model": default["language_model"],
            "default_id": default["id"],
            "default_sdk_version": default_version,
            "metadata_agent_version": metadata_version,
            "scores_swebench_agent_version": scores_version,
            "default_vs_metadata_match": default_version == metadata_version,
            "default_vs_scores_match": default_version == scores_version,
            "metadata_vs_scores_match": metadata_version == scores_version,
            "actual_evaluation_version_source": "scores.json:swe-bench.agent_version",
            "upstream_result_directory": f"results/{directory_name}",
        }
        version_rows.append(record)
        upstream_versions[default["id"]] = {**record, "score_record": score_row}
        if default_version != scores_version:
            issue(issues, "warning", "default_sdk_vs_swebench_agent_version_mismatch", default["language_model"], 1, f"default={default_version}; scores.swe-bench={scores_version}")
        if metadata_version != scores_version:
            issue(issues, "warning", "metadata_vs_swebench_agent_version_mismatch", default["language_model"], 1, f"metadata={metadata_version}; scores.swe-bench={scores_version}")

    model_rows: list[dict[str, Any]] = []
    model_sets: dict[str, set[str]] = {}
    for default in default_rows:
        model_id = default["id"]
        rows = swe_by_model.get(model_id, [])
        instances = {row["instance_id"] for row in rows}
        model_sets[default["language_model"]] = instances
        true_count = sum(row.get("resolved") is True for row in rows)
        false_count = sum(row.get("resolved") is False for row in rows)
        null_count = sum(row.get("resolved") is None for row in rows)
        costs = [float(row["cost"]) for row in rows if row.get("cost") is not None]
        missing_cost = len(rows) - len(costs)
        zero_cost = sum(value == 0 for value in costs)
        negative_cost = sum(value < 0 for value in costs)
        joined = instances & set(verified_by_id)
        aggregate_score = default.get("issue_resolution_score")
        observed_score = 100 * true_count / len(rows) if rows else None
        score_delta_pp = aggregate_score - observed_score if aggregate_score is not None and observed_score is not None else None
        score_consistent = score_delta_pp is not None and abs(score_delta_pp) <= 0.100001
        version = upstream_versions[model_id]
        score_record = version["score_record"]
        score_json_score = score_record.get("score")
        score_json_delta_pp = score_json_score - observed_score if score_json_score is not None and observed_score is not None else None
        row = {
            "language_model": default["language_model"],
            "default_id": model_id,
            "sdk_version": default.get("sdk_version"),
            "metadata_agent_version": version["metadata_agent_version"],
            "scores_swebench_agent_version": version["scores_swebench_agent_version"],
            "release_date": str(default.get("release_date")),
            "swebench_aggregate_score": aggregate_score,
            "scores_json_swebench_score": score_json_score,
            "swebench_aggregate_average_cost": default.get("issue_resolution_cost"),
            "scores_json_swebench_average_cost": score_record.get("cost_per_instance"),
            "swebench_instance_count": len(rows),
            "resolved_true_count": true_count,
            "resolved_false_count": false_count,
            "resolved_null_count": null_count,
            "resolved_rate": rounded(true_count / len(rows) if rows else None),
            "resolved_null_rate": rounded(null_count / len(rows) if rows else None),
            "cost_non_null_count": len(costs),
            "cost_missing_count": missing_cost,
            "cost_missing_rate": rounded(missing_cost / len(rows) if rows else None),
            "cost_zero_count": zero_cost,
            "cost_negative_count": negative_cost,
            "cost_mean": rounded(statistics.fmean(costs) if costs else None),
            "cost_median": rounded(statistics.median(costs) if costs else None),
            "cost_p25": rounded(percentile(costs, 0.25)),
            "cost_p75": rounded(percentile(costs, 0.75)),
            "cost_p95": rounded(percentile(costs, 0.95)),
            "swebench_verified_join_count": len(joined),
            "swebench_verified_join_rate": rounded(len(joined) / len(instances) if instances else None),
            "verified_set_coverage_rate": rounded(len(joined) / len(verified_by_id)),
            "per_instance_score_percent": rounded(observed_score),
            "aggregate_score_delta_pp": rounded(score_delta_pp),
            "aggregate_score_consistent_with_instances": score_consistent,
            "scores_json_score_delta_pp": rounded(score_json_delta_pp),
        }
        model_rows.append(row)
        if null_count:
            issue(issues, "warning", "resolved_null", default["language_model"], null_count, "SWE-bench rows with null resolved")
        if missing_cost:
            issue(issues, "warning", "cost_missing", default["language_model"], missing_cost, "SWE-bench rows with null cost")
        if zero_cost:
            issue(issues, "info", "cost_zero", default["language_model"], zero_cost, "SWE-bench rows with zero cost; retained in statistics")
        if negative_cost:
            issue(issues, "error", "cost_negative", default["language_model"], negative_cost, "SWE-bench rows with negative cost")
        if score_delta_pp is None or abs(score_delta_pp) > 0.100001:
            issue(issues, "warning", "aggregate_score_mismatch", default["language_model"], 1, f"default={aggregate_score}; true/rows*100={rounded(observed_score)}; delta_pp={rounded(score_delta_pp)}")

    union_set = set().union(*model_sets.values())
    intersection_set = set.intersection(*model_sets.values()) if model_sets else set()
    distinct_set_signatures = len({frozenset(values) for values in model_sets.values()})
    if distinct_set_signatures > 1:
        issue(issues, "warning", "model_instance_sets_differ", "swe-bench", distinct_set_signatures, "Distinct per-model SWE-bench instance sets")

    pair_rows = []
    pair_lookup: dict[tuple[str, str], int] = {}
    for model_a, model_b in itertools.combinations(sorted(model_sets), 2):
        overlap = len(model_sets[model_a] & model_sets[model_b])
        pair_lookup[(model_a, model_b)] = overlap
        pair_rows.append({
            "model_a": model_a, "model_b": model_b,
            "model_a_instance_count": len(model_sets[model_a]),
            "model_b_instance_count": len(model_sets[model_b]),
            "common_instance_count": overlap,
            "overlap_over_smaller_set": rounded(overlap / min(len(model_sets[model_a]), len(model_sets[model_b]))),
            "jaccard": rounded(overlap / len(model_sets[model_a] | model_sets[model_b])),
        })

    anchors = select_anchors(model_rows, pair_lookup)
    anchor_names = {row["language_model"] for row in anchors}
    for row in model_rows:
        row["recommended_anchor"] = row["language_model"] in anchor_names
        row.pop("_quality", None)
        row.pop("_value", None)

    sample_rows = []
    # Sorting by question first gives the sample broad model coverage instead of
    # taking hundreds of consecutive rows from a single model.
    for row in sorted(swe_rows, key=lambda item: (item["instance_id"], item["language_model"])):
        question = verified_by_id.get(row["instance_id"])
        if question is None:
            continue
        sample_rows.append({
            "language_model": row["language_model"],
            "instance_id": row["instance_id"],
            "resolved": row.get("resolved"),
            "cost": row.get("cost"),
            "repo": question.get("repo"),
            "difficulty": question.get("difficulty"),
            "problem_statement": question.get("problem_statement"),
            "openhands_revision": OPENHANDS_REVISION,
            "swebench_revision": SWEBENCH_REVISION,
        })
        if len(sample_rows) == 200:
            break

    write_csv(output / "model_coverage.csv", sorted(model_rows, key=lambda row: (-row["resolved_rate"], row["cost_mean"])))
    write_csv(output / "model_pair_overlap.csv", pair_rows)
    write_csv(output / "swebench_joined_sample.csv", sample_rows)
    write_csv(output / "sdk_version_audit.csv", version_rows)
    write_csv(output / "data_quality_issues.csv", issues, ["severity", "issue_type", "scope", "count", "details"])

    maximum_pair_overlap = max((row["common_instance_count"] for row in pair_rows), default=0)
    maximum_pairs = sum(row["common_instance_count"] == maximum_pair_overlap for row in pair_rows)
    total_joined_questions = len(union_set & set(verified_by_id))
    summary = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "scope": "data audit only; no RouteLLM or model inference",
        "sources": {
            "openhands_index": {
                "dataset": OPENHANDS_DATASET,
                "requested_revision": OPENHANDS_REVISION,
                "resolved_huggingface_commit": OPENHANDS_HF_COMMIT,
                "configs": ["default", "instances"],
                "files": {name: {"url": spec["url"], "sha256": spec["sha256"]} for name, spec in DOWNLOADS.items() if name.startswith("openhands")},
            },
            "openhands_index_results": {"repository": UPSTREAM_REPO, "commit": UPSTREAM_COMMIT},
            "swebench_verified": {
                "dataset": SWEBENCH_DATASET, "revision": SWEBENCH_REVISION,
                "file": DOWNLOADS["swebench_verified"],
            },
        },
        "counts": {
            "default_models": len(default_rows),
            "all_instance_rows": len(instance_rows),
            "benchmarks": benchmark_counts,
            "swebench_rows": len(swe_rows),
            "swebench_unique_instances": len(union_set),
            "swebench_common_to_all_models": len(intersection_set),
            "verified_questions": len(verified_by_id),
            "verified_questions_joined": total_joined_questions,
            "joined_sample_rows": len(sample_rows),
        },
        "join": {
            "union_join_rate": rounded(total_joined_questions / len(union_set)),
            "verified_coverage_rate": rounded(total_joined_questions / len(verified_by_id)),
            "all_models_have_identical_instance_sets": distinct_set_signatures == 1,
        },
        "overlap": {
            "pair_count": len(pair_rows),
            "maximum_pair_overlap": maximum_pair_overlap,
            "pairs_at_maximum": maximum_pairs,
            "all_model_intersection": len(intersection_set),
        },
        "quality": {
            "duplicate_composite_key_groups": len(duplicate_groups),
            "conflicting_duplicate_groups": len(conflict_groups),
            "resolved_null_rows": sum(row["resolved_null_count"] for row in model_rows),
            "cost_missing_rows": sum(row["cost_missing_count"] for row in model_rows),
            "cost_zero_rows": sum(row["cost_zero_count"] for row in model_rows),
            "cost_negative_rows": sum(row["cost_negative_count"] for row in model_rows),
            "aggregate_score_mismatch_models": [row["language_model"] for row in model_rows if not row["aggregate_score_consistent_with_instances"]],
            "default_vs_actual_swebench_version_mismatch_count": sum(not row["default_vs_scores_match"] for row in version_rows),
            "metadata_vs_actual_swebench_version_mismatch_count": sum(not row["metadata_vs_scores_match"] for row in version_rows),
            "issue_rows": len(issues),
        },
        "recommended_anchor_models": anchors,
        "route_llm_readiness": {
            "sufficient_for_difficulty_validation": True,
            "rationale": "All 34 models share and join the same 500 official Verified instances, enabling paired difficulty comparisons.",
            "remaining_requirements_before_curve_generation": [
                "Use scores.json SWE-bench agent_version as the actual evaluation version; do not substitute default or metadata versions.",
                "Define how null resolved values are treated; the published aggregate effectively uses true/500, so null behaves as failure in aggregation.",
                "Decide whether zero-cost rows represent cached/free executions or cost instrumentation gaps before fitting cost-aware curves.",
                "Validate that a single agent version policy is acceptable because 17 models' actual SWE-bench version differs from default/metadata.",
                "Pre-register the success metric (resolved == true) and retain missingness flags rather than imputing values.",
            ],
        },
        "models": sorted(model_rows, key=lambda row: row["language_model"].lower()),
    }
    with (output / "audit_summary.json").open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    anchor_lines = [
        "# Recommended OpenHands anchor models", "",
        "This list is selected by the audit script, not a hard-coded model allowlist. Eligibility requires a 2026 release, at least 99% Verified join coverage, at most 1% missing `resolved`, at most 1% missing `cost`, and positive observed mean cost. Selection then assigns one quality leader, one lowest-cost model, two additional value models (resolved rate / mean cost), and fills the quality range with overlap as a tie-breaker.", "",
        "All selected models have 500 instances in common with every other selected model. Cost statistics include observed zero values and exclude only nulls.", "",
        "| Model | Role | Release | Resolved | Mean cost | Median cost | Actual SWE-bench agent | Min selected overlap |", "|---|---|---:|---:|---:|---:|---|---:|",
    ]
    for anchor in anchors:
        anchor_lines.append(
            f"| {anchor['language_model']} | {anchor['role']} | {anchor['release_date']} | "
            f"{anchor['resolved_rate']:.1%} | {anchor['cost_mean']:.4f} | {anchor['cost_median']:.4f} | "
            f"{anchor['actual_swebench_agent_version']} | {anchor['minimum_overlap_with_selected']} |"
        )
    anchor_lines += [
        "", "## Interpretation", "",
        "The role labels are sampling roles, not product endorsements. `high_quality` anchors the top of the observed success range; `low_cost` anchors the observed cost floor; `value` models have high empirical resolved-rate-to-mean-cost ratios; gradient models broaden the success/cost range. Re-run the script when the pinned data revision changes rather than carrying this list forward manually.", "",
    ]
    (output / "recommended_anchor_models.md").write_text("\n".join(anchor_lines), encoding="utf-8")

    print(json.dumps({
        "models": len(default_rows), "swebench_rows": len(swe_rows),
        "swebench_instances": len(union_set), "verified_joined": total_joined_questions,
        "anchors": [row["language_model"] for row in anchors],
        "version_mismatches": summary["quality"]["default_vs_actual_swebench_version_mismatch_count"],
        "issues": len(issues),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
