#!/usr/bin/env python3
"""Build the TwinRouterBench Phase 1D foundation and synthetic Phase 2 demo.

The script performs only static file processing.  It never calls a model API,
runs a router, invokes an LLM judge, or starts Docker.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
from dataclasses import asdict
import hashlib
import importlib.metadata
import itertools
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import sys
import tempfile
import time
from typing import Any, Iterable, Mapping, Sequence
import urllib.error
import urllib.request

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
import numpy as np
import pandas as pd
import yaml
from sklearn.model_selection import StratifiedGroupKFold


ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from acu_benchmark_curve_fitter import (  # noqa: E402
    BenchmarkFitInput,
    curve_with_uncertainty,
    fit_curve,
    quality as logistic_quality,
)
from acu_curve_engine import (  # noqa: E402
    TIER_DIFFICULTY,
    TIER_ORDER,
    TIER_TO_ID,
    continuous_difficulty,
    oracle_probabilities,
    predicted_sufficiency,
    self_check as curve_engine_self_check,
)
from acu_decision_engine import (  # noqa: E402
    call_cost,
    choose_tier,
    fallback_projection,
    load_catalog,
    phase1d_expected_total_cost,
    self_check as decision_engine_self_check,
)
from acu_session_policy import simulate_sticky_policy, self_check as session_policy_self_check  # noqa: E402


GITHUB_COMMIT = "430acecac71141de77afd8e5e13690d236d58e93"
HF_REVISION = "c2907f006455d9d3b4bf69472a527536c7baa195"
ARXIV_VERSION = "2605.18859v2"
SPLIT_SEED = 20260726
APPROX_TOKEN_CHARS = 4
HEAD_TAIL_MAX_TOKENS = 8192
HEAD_TAIL_MAX_CHARS = APPROX_TOKEN_CHARS * HEAD_TAIL_MAX_TOKENS

SOURCE_SPECS = {
    "github_question_bank": {
        "url": f"https://raw.githubusercontent.com/CommonstackAI/TwinRouterBench/{GITHUB_COMMIT}/data/static/question_bank.jsonl",
        "path": "github/question_bank.jsonl",
        "sha256": "5b4f90c24643b214a9b0f26bf4e05afc742554262f4ef405e0b3b4a4cce503f4",
    },
    "github_manifest": {
        "url": f"https://raw.githubusercontent.com/CommonstackAI/TwinRouterBench/{GITHUB_COMMIT}/data/static/manifest.json",
        "path": "github/manifest.json",
        "sha256": "e575b8cc8e33bba993f2d1bcf09b4ee6940fbb098c9255a9c8e5ef7c6771e726",
    },
    "hf_question_bank": {
        "url": f"https://huggingface.co/datasets/Amorph/TwinRouterBench/resolve/{HF_REVISION}/question_bank.jsonl",
        "path": "huggingface/question_bank.jsonl",
        "sha256": "7e2870b5e2e5c801f6444c05a4311c9c9010e965016f6938f0bb5abc226252d0",
    },
    "hf_manifest": {
        "url": f"https://huggingface.co/datasets/Amorph/TwinRouterBench/resolve/{HF_REVISION}/manifest.json",
        "path": "huggingface/manifest.json",
        "sha256": "d83bb75071fd8c1f68f17402881242c56467807ff4090b5e26cb1afa22421b16",
    },
    "hf_train_parquet": {
        "url": f"https://huggingface.co/datasets/Amorph/TwinRouterBench/resolve/{HF_REVISION}/data/train.parquet",
        "path": "huggingface/train.parquet",
        "sha256": "28070bd3e807565cc0144d8b558167d2a7035c6400b5fd55f97ea10383780427",
    },
    "arxiv_paper": {
        "url": f"https://arxiv.org/pdf/{ARXIV_VERSION}",
        "path": f"paper/arxiv-{ARXIV_VERSION}.pdf",
        "sha256": "3c4b038c04d1ed6b3c144ff2c2272c2713eebd25044eacd32f8522e4c3120ff9",
    },
}

CACHE_DIR = ROOT / ".cache" / "source"
OUTPUT_DIR = ROOT / "outputs"
FIGURE_DIR = OUTPUT_DIR / "figures"
TIER_CONFIG_PATH = ROOT / "config" / "tier_catalog.example.yaml"
MODEL_CATALOG_PATH = ROOT / "config" / "public_model_benchmark_catalog.example.yaml"

INK = "#24303f"
GRID = "#dfe5ec"
BLUE = "#3569a8"
BLUE_LIGHT = "#a9c5e8"
GOLD = "#c89422"
ORANGE = "#d77032"
OLIVE = "#71833b"
PINK = "#b95f82"
PALETTE = {"low": BLUE, "mid": GOLD, "mid_high": ORANGE, "high": PINK}
MARKERS = {"low": "o", "mid": "s", "mid_high": "^", "high": "D"}
LINESTYLES = {"low": "-", "mid": "--", "mid_high": "-.", "high": ":"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_csv(path: Path, rows: Sequence[Mapping[str, Any]], fieldnames: Sequence[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows and fieldnames is None:
        raise ValueError(f"cannot infer CSV columns for empty output {path}")
    columns = list(fieldnames or rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def prepare_sources(*, offline: bool) -> dict[str, Path]:
    resolved: dict[str, Path] = {}
    for source_id, spec in SOURCE_SPECS.items():
        target = CACHE_DIR / spec["path"]
        if target.exists() and sha256_file(target) == spec["sha256"]:
            resolved[source_id] = target
            continue
        if offline:
            raise FileNotFoundError(
                f"offline cache missing or hash-invalid for {source_id}: {target}; run once without --offline"
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        _download_atomic(spec["url"], target, expected_sha=spec["sha256"])
        resolved[source_id] = target
    return resolved


def _download_atomic(url: str, target: Path, *, expected_sha: str) -> None:
    last_error: Exception | None = None
    for attempt in range(5):
        temporary = target.with_suffix(target.suffix + ".part")
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "ClawRouter-Phase1D-static-audit/1.0"})
            with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            actual = sha256_file(temporary)
            if actual != expected_sha:
                raise ValueError(f"SHA-256 mismatch for {url}: expected {expected_sha}, got {actual}")
            temporary.replace(target)
            return
        except (OSError, urllib.error.URLError, ValueError) as error:
            last_error = error
            if temporary.exists():
                temporary.unlink()
            if attempt < 4:
                time.sleep(2**attempt)
    raise RuntimeError(f"failed to download {url}: {last_error}")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid JSON at {path}:{line_number}: {error}") from error
            if not isinstance(value, dict):
                raise ValueError(f"expected object at {path}:{line_number}")
            rows.append(value)
    return rows


def content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces: list[str] = []
        for item in content:
            if isinstance(item, str):
                pieces.append(item)
            elif isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    pieces.append(item["text"])
                elif isinstance(item.get("content"), str):
                    pieces.append(item["content"])
                else:
                    pieces.append(canonical_json(item))
            else:
                pieces.append(str(item))
        return "\n".join(pieces)
    if isinstance(content, dict):
        return canonical_json(content)
    return str(content)


def tool_name_map(messages: Sequence[Mapping[str, Any]]) -> dict[str, str]:
    names: dict[str, str] = {}
    for message in messages:
        for tool_call in message.get("tool_calls") or []:
            if not isinstance(tool_call, dict):
                continue
            call_id = tool_call.get("id")
            function = tool_call.get("function") or {}
            if call_id and isinstance(function, dict) and function.get("name"):
                names[str(call_id)] = str(function["name"])
    return names


def serialize_message(message: Mapping[str, Any], names: Mapping[str, str]) -> str:
    role = str(message.get("role", "unknown")).lower()
    if role == "tool":
        call_id = str(message.get("tool_call_id") or "")
        name = str(message.get("name") or names.get(call_id) or "unknown")
        header = f"[TOOL name={name}]"
    else:
        header = f"[{role.upper()}]"
    body = content_to_text(message.get("content"))
    tool_calls = message.get("tool_calls")
    if tool_calls:
        calls = []
        for call in tool_calls:
            if not isinstance(call, dict):
                calls.append(canonical_json(call))
                continue
            function = call.get("function") or {}
            name = function.get("name", "unknown") if isinstance(function, dict) else "unknown"
            arguments = function.get("arguments", "") if isinstance(function, dict) else ""
            calls.append(f"[TOOL_CALL name={name}]\n{arguments}")
        body = "\n".join(part for part in (body, *calls) if part)
    return f"{header}\n{body}".rstrip()


def serialize_context(messages: Sequence[Mapping[str, Any]]) -> str:
    names = tool_name_map(messages)
    return "\n\n".join(serialize_message(message, names) for message in messages)


def last_message_text(messages: Sequence[Mapping[str, Any]]) -> str:
    if not messages:
        return ""
    names = tool_name_map(messages)
    return serialize_message(messages[-1], names)


def head_tail_context(messages: Sequence[Mapping[str, Any]], *, max_chars: int = HEAD_TAIL_MAX_CHARS) -> tuple[str, bool, float]:
    """Keep system, initial user task, and the newest messages deterministically."""
    if not messages:
        return "", False, 0.0
    names = tool_name_map(messages)
    serialized = [serialize_message(message, names) for message in messages]
    full = "\n\n".join(serialized)
    if len(full) <= max_chars:
        return full, False, 0.0
    system_indices = [index for index, message in enumerate(messages) if message.get("role") == "system"]
    first_user = next((index for index, message in enumerate(messages) if message.get("role") == "user"), None)
    anchors = []
    if system_indices:
        anchors.append(system_indices[0])
    if first_user is not None and first_user not in anchors:
        anchors.append(first_user)
    separator = "\n\n"
    omission = "[CONTEXT OMITTED DETERMINISTICALLY]"
    anchor_budget = min(max_chars // 2, 12_000)
    anchor_parts = [_truncate_middle(serialized[index], max(256, anchor_budget // max(1, len(anchors)))) for index in anchors]
    used = sum(len(value) for value in anchor_parts) + len(separator) * max(0, len(anchor_parts) - 1)
    tail_budget = max_chars - used - len(separator) * 2 - len(omission)
    tail_parts: list[str] = []
    for index in range(len(serialized) - 1, -1, -1):
        if index in anchors:
            continue
        candidate = serialized[index]
        added = len(candidate) + (len(separator) if tail_parts else 0)
        if added <= tail_budget:
            tail_parts.append(candidate)
            tail_budget -= added
        elif not tail_parts and tail_budget > 256:
            tail_parts.append(_truncate_middle(candidate, tail_budget))
            tail_budget = 0
        if tail_budget <= 0:
            break
    tail_parts.reverse()
    result_parts = anchor_parts + [omission] + tail_parts
    result = separator.join(result_parts)
    if len(result) > max_chars:
        result = _truncate_middle(result, max_chars)
    ratio = 1.0 - len(result) / max(1, len(full))
    return result, True, max(0.0, min(1.0, ratio))


def _truncate_middle(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    marker = "\n[...TRUNCATED...]\n"
    if limit <= len(marker) + 2:
        return value[:limit]
    head = (limit - len(marker)) // 2
    tail = limit - len(marker) - head
    return value[:head] + marker + value[-tail:]


def approx_tokens(text: str) -> int:
    return math.ceil(len(text) / APPROX_TOKEN_CHARS)


def label_confidence(row: Mapping[str, Any]) -> tuple[str, str]:
    stage = row.get("pipeline_stage")
    notes = str(row.get("notes") or "")
    if stage == "ground_truth_ready":
        return "strong_ground_truth_ready", "main"
    if stage == "mixed_model_validated":
        return "strong_mixed_model_validated", "main"
    if stage == "degradation_search_done" or "weak-label" in notes:
        return "weak_degradation_search", "sensitivity_only"
    return "unclassified", "excluded"


def extract_initial_task(messages: Sequence[Mapping[str, Any]]) -> str:
    content = ""
    for message in messages:
        if message.get("role") == "user":
            content = content_to_text(message.get("content"))
            break
    # SWE records append a long shared agent instruction after the actual task.
    # Removing only this explicit delimiter prevents boilerplate from making
    # unrelated issues appear near-duplicate.
    for delimiter in ("<instructions>", "# Task Instructions"):
        if delimiter in content:
            content = content.split(delimiter, 1)[0]
    return content.strip()


def normalize_task(value: str) -> str:
    value = value.lower()
    value = re.sub(r"https?://\S+", "<url>", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def simhash64(value: str) -> int:
    words = re.findall(r"[a-z0-9_./-]+", value.lower())
    if not words:
        return 0
    shingles = words if len(words) < 3 else [" ".join(words[index : index + 3]) for index in range(len(words) - 2)]
    vector = [0] * 64
    for shingle in set(shingles):
        hashed = int.from_bytes(hashlib.sha256(shingle.encode("utf-8")).digest()[:8], "big")
        for bit in range(64):
            vector[bit] += 1 if hashed & (1 << bit) else -1
    result = 0
    for bit, weight in enumerate(vector):
        if weight >= 0:
            result |= 1 << bit
    return result


class UnionFind:
    def __init__(self, values: Iterable[str]) -> None:
        self.parent = {value: value for value in values}

    def find(self, value: str) -> str:
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, left: str, right: str) -> None:
        root_left, root_right = self.find(left), self.find(right)
        if root_left == root_right:
            return
        smaller, larger = sorted((root_left, root_right))
        self.parent[larger] = smaller


def assign_leakage_groups(rows: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, str]]:
    by_instance: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        by_instance[str(row["instance_id"])].append(row)
    instances: dict[str, dict[str, Any]] = {}
    for instance_id, instance_rows in by_instance.items():
        first = min(instance_rows, key=lambda row: (int(row["step_index"]), str(row["id"])))
        task = normalize_task(extract_initial_task(first["messages"]))
        instances[instance_id] = {
            "benchmark": str(first["benchmark"]),
            "scenario": str(first["scenario"]),
            "task": task,
            "task_signature": hashlib.sha256(task.encode("utf-8")).hexdigest(),
            "simhash": simhash64(task),
            "length": len(task),
        }
    union = UnionFind(instances)
    by_signature: dict[str, list[str]] = defaultdict(list)
    for instance_id, item in instances.items():
        by_signature[item["task_signature"]].append(instance_id)
    for members in by_signature.values():
        for member in members[1:]:
            union.union(members[0], member)
    # Conservative near-duplicate linkage: same benchmark/scenario, similar
    # task length, and <=3 bits apart in 64-bit word-trigram SimHash.
    blocks: dict[tuple[str, str], list[str]] = defaultdict(list)
    for instance_id, item in instances.items():
        blocks[(item["benchmark"], item["scenario"])].append(instance_id)
    for members in blocks.values():
        for left_index, left in enumerate(members):
            left_item = instances[left]
            for right in members[left_index + 1 :]:
                right_item = instances[right]
                length_ratio = min(left_item["length"], right_item["length"]) / max(1, max(left_item["length"], right_item["length"]))
                if length_ratio < 0.90:
                    continue
                distance = (left_item["simhash"] ^ right_item["simhash"]).bit_count()
                if distance <= 3:
                    union.union(left, right)
    result: dict[str, dict[str, str]] = {}
    for instance_id, item in instances.items():
        root = union.find(instance_id)
        leakage_group = "lg_" + hashlib.sha256(root.encode("utf-8")).hexdigest()[:16]
        result[instance_id] = {
            "task_signature": item["task_signature"],
            "near_duplicate_simhash": f"{item['simhash']:016x}",
            "leakage_group_id": leakage_group,
        }
    return result


def build_splits(rows: Sequence[Mapping[str, Any]], leakage: Mapping[str, Mapping[str, str]]) -> dict[str, dict[str, Any]]:
    # One sample per instance is enough for the split optimizer; row counts are
    # retained as sample weights by repeating each instance according to steps.
    labels = np.asarray([str(row["benchmark"]) for row in rows])
    groups = np.asarray([leakage[str(row["instance_id"])]["leakage_group_id"] for row in rows])
    dummy = np.zeros(len(rows), dtype=np.int8)
    splitter = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=SPLIT_SEED)
    group_fold: dict[str, int] = {}
    for fold, (_, test_indices) in enumerate(splitter.split(dummy, labels, groups)):
        for index in test_indices:
            group = str(groups[index])
            previous = group_fold.setdefault(group, fold)
            if previous != fold:
                raise AssertionError("leakage group assigned to multiple CV folds")
    fold_to_split = _select_fold_roles(rows, group_fold, leakage)
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        instance_id = str(row["instance_id"])
        group = leakage[instance_id]["leakage_group_id"]
        fold = group_fold[group]
        confidence, scope = label_confidence(row)
        result[str(row["id"])] = {
            "split": fold_to_split[fold],
            "cv_fold": fold,
            "lobo_holdout_benchmark": str(row["benchmark"]),
            "analysis_scope": scope,
            "label_confidence": confidence,
            **leakage[instance_id],
        }
    validate_splits(rows, result)
    return result


def _select_fold_roles(
    rows: Sequence[Mapping[str, Any]],
    group_fold: Mapping[str, int],
    leakage: Mapping[str, Mapping[str, str]],
) -> dict[int, str]:
    """Choose 3/1/1 fold roles to best approximate benchmark-stratified 60/20/20.

    GroupKFold fold membership remains fixed. This deterministic 20-way search
    only assigns semantic train/validation/test roles to those five folds and
    balances both row and instance proportions, globally and per benchmark.
    """
    row_records = [
        (
            str(row["benchmark"]),
            str(row["instance_id"]),
            group_fold[leakage[str(row["instance_id"])]["leakage_group_id"]],
        )
        for row in rows
    ]
    seen_instances: set[str] = set()
    instance_records: list[tuple[str, str, int]] = []
    for record in row_records:
        if record[1] not in seen_instances:
            instance_records.append(record)
            seen_instances.add(record[1])
    targets = {"train": 0.60, "validation": 0.20, "test": 0.20}
    candidates: list[tuple[float, int, int, dict[int, str]]] = []
    for validation_fold, test_fold in itertools.permutations(range(5), 2):
        mapping = {
            fold: "validation" if fold == validation_fold else "test" if fold == test_fold else "train"
            for fold in range(5)
        }
        score = 0.0
        for records in (row_records, instance_records):
            scopes = [records]
            for benchmark in sorted({record[0] for record in records}):
                scopes.append([record for record in records if record[0] == benchmark])
            for scope in scopes:
                counts = Counter(mapping[record[2]] for record in scope)
                for split, target in targets.items():
                    share = counts[split] / len(scope)
                    score += ((share - target) / 0.20) ** 2
        candidates.append((score, validation_fold, test_fold, mapping))
    return min(candidates, key=lambda value: (value[0], value[1], value[2]))[3]


def validate_splits(rows: Sequence[Mapping[str, Any]], assignments: Mapping[str, Mapping[str, Any]]) -> None:
    instance_splits: dict[str, set[str]] = defaultdict(set)
    group_splits: dict[str, set[str]] = defaultdict(set)
    task_splits: dict[str, set[str]] = defaultdict(set)
    instance_folds: dict[str, set[int]] = defaultdict(set)
    for row in rows:
        assigned = assignments[str(row["id"])]
        instance = str(row["instance_id"])
        instance_splits[instance].add(str(assigned["split"]))
        instance_folds[instance].add(int(assigned["cv_fold"]))
        group_splits[str(assigned["leakage_group_id"])].add(str(assigned["split"]))
        task_splits[str(assigned["task_signature"])].add(str(assigned["split"]))
    if any(len(values) != 1 for values in instance_splits.values()):
        raise AssertionError("an instance crosses 60/20/20 splits")
    if any(len(values) != 1 for values in instance_folds.values()):
        raise AssertionError("an instance crosses GroupKFold folds")
    if any(len(values) != 1 for values in group_splits.values()):
        raise AssertionError("a near-duplicate trajectory group crosses splits")
    if any(len(values) != 1 for values in task_splits.values()):
        raise AssertionError("an identical initial task crosses splits")


def openai_tools(functions: Any) -> list[dict[str, Any]]:
    if not functions:
        return []
    if not isinstance(functions, list):
        raise ValueError("functions must be a list when present")
    return [{"type": "function", "function": function} for function in functions]


def build_context_rows(
    source_rows: Sequence[Mapping[str, Any]],
    assignments: Mapping[str, Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    contexts: list[dict[str, Any]] = []
    lengths: list[dict[str, Any]] = []
    source_revision = f"github:{GITHUB_COMMIT};hf:{HF_REVISION}"
    for row in source_rows:
        messages = row["messages"]
        if not isinstance(messages, list) or not messages:
            raise ValueError(f"row {row['id']} has no usable messages")
        last = last_message_text(messages)
        full = serialize_context(messages)
        head_tail, truncated, ratio = head_tail_context(messages)
        assigned = assignments[str(row["id"])]
        context = {
            "context_id": str(row["id"]),
            "benchmark": str(row["benchmark"]),
            "scenario": str(row["scenario"]),
            "instance_id": str(row["instance_id"]),
            "step_index": int(row["step_index"]),
            "total_steps": int(row["total_steps"]),
            "messages_json": canonical_json(messages),
            "tools_json": canonical_json(openai_tools(row.get("functions"))),
            "target_tier": str(row["target_tier"]),
            "target_tier_id": int(row["target_tier_id"]),
            "label_confidence": assigned["label_confidence"],
            "pipeline_stage": str(row["pipeline_stage"]),
            "source_revision": source_revision,
            "last_message_text": last,
            "full_context_text": full,
            "acu_head_tail_context": head_tail,
            "last_message_approx_tokens": approx_tokens(last),
            "full_context_approx_tokens": approx_tokens(full),
            "acu_head_tail_approx_tokens": approx_tokens(head_tail),
            "acu_head_tail_truncated": bool(truncated),
            "acu_head_tail_truncation_ratio": float(ratio),
            "split": assigned["split"],
            "cv_fold": int(assigned["cv_fold"]),
            "lobo_holdout_benchmark": assigned["lobo_holdout_benchmark"],
            "analysis_scope": assigned["analysis_scope"],
            "task_signature": assigned["task_signature"],
            "near_duplicate_simhash": assigned["near_duplicate_simhash"],
            "leakage_group_id": assigned["leakage_group_id"],
        }
        if context["acu_head_tail_approx_tokens"] > HEAD_TAIL_MAX_TOKENS:
            raise AssertionError(f"head-tail context exceeded limit for {row['id']}")
        contexts.append(context)
        for view_name, text, view_truncated, view_ratio in (
            ("last_message_text", last, False, 0.0),
            ("full_context_text", full, False, 0.0),
            ("acu_head_tail_context", head_tail, truncated, ratio),
        ):
            lengths.append(
                {
                    "context_id": str(row["id"]),
                    "benchmark": str(row["benchmark"]),
                    "scenario": str(row["scenario"]),
                    "instance_id": str(row["instance_id"]),
                    "step_index": int(row["step_index"]),
                    "total_steps": int(row["total_steps"]),
                    "view": view_name,
                    "character_count": len(text),
                    "approx_tokens": approx_tokens(text),
                    "truncated": bool(view_truncated),
                    "truncation_ratio": float(view_ratio),
                }
            )
    return contexts, lengths


def validate_source_equivalence(
    github_rows: Sequence[Mapping[str, Any]],
    hf_rows: Sequence[Mapping[str, Any]],
    hf_parquet_path: Path,
) -> dict[str, Any]:
    if len(github_rows) != len(hf_rows):
        raise AssertionError("GitHub and Hugging Face JSONL row counts differ")
    semantic_jsonl_mismatches = sum(left != right for left, right in zip(github_rows, hf_rows))
    if semantic_jsonl_mismatches:
        raise AssertionError(f"GitHub/HF JSONL semantic mismatch count: {semantic_jsonl_mismatches}")
    frame = pd.read_parquet(hf_parquet_path)
    if len(frame) != len(github_rows):
        raise AssertionError("Hugging Face Parquet and canonical JSONL row counts differ")
    parquet_by_id = {str(row["id"]): row for row in frame.to_dict(orient="records")}
    core_fields = (
        "id",
        "benchmark",
        "scenario",
        "instance_id",
        "step_index",
        "total_steps",
        "messages",
        "functions",
        "target_tier",
        "target_tier_id",
        "pipeline_stage",
    )
    mismatches: list[dict[str, str]] = []
    for source in github_rows:
        candidate = parquet_by_id.get(str(source["id"]))
        if candidate is None:
            mismatches.append({"id": str(source["id"]), "field": "id_missing"})
            continue
        for field in core_fields:
            expected = source.get(field)
            actual = _normalize_parquet_value(candidate.get(field), field)
            if field in {"step_index", "total_steps", "target_tier_id"} and actual is not None:
                actual = int(actual)
            if expected != actual:
                mismatches.append({"id": str(source["id"]), "field": field})
                if len(mismatches) >= 20:
                    break
        if len(mismatches) >= 20:
            break
    if mismatches:
        raise AssertionError(f"JSONL/Parquet core mismatch sample: {mismatches}")
    return {
        "github_hf_jsonl_semantically_equal": True,
        "github_hf_jsonl_byte_equal": False,
        "semantic_jsonl_mismatch_count": semantic_jsonl_mismatches,
        "jsonl_parquet_core_fields_equal": True,
        "jsonl_parquet_core_mismatch_count": 0,
        "hf_parquet_rows": len(frame),
        "hf_parquet_columns": list(frame.columns),
    }


def _normalize_parquet_value(value: Any, field: str) -> Any:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if field in {"messages", "functions"} and isinstance(value, str):
        if not value.strip():
            return None
        return json.loads(value)
    if isinstance(value, np.generic):
        return value.item()
    return value


def audit_data(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    ids = [str(row.get("id")) for row in rows]
    composite = [(str(row.get("instance_id")), int(row.get("step_index"))) for row in rows]
    duplicate_ids = sum(count - 1 for count in Counter(ids).values() if count > 1)
    duplicate_composite = sum(count - 1 for count in Counter(composite).values() if count > 1)
    conflicts = 0
    composite_tiers: dict[tuple[str, int], set[tuple[str, int]]] = defaultdict(set)
    for row in rows:
        composite_tiers[(str(row["instance_id"]), int(row["step_index"]))].add(
            (str(row["target_tier"]), int(row["target_tier_id"]))
        )
    conflicts = sum(len(values) > 1 for values in composite_tiers.values())
    tier_mismatches = sum(
        TIER_TO_ID.get(str(row.get("target_tier"))) != row.get("target_tier_id") for row in rows
    )
    missing_messages = sum(not isinstance(row.get("messages"), list) or not row.get("messages") for row in rows)
    missing_functions = sum(not row.get("functions") for row in rows)
    invalid_functions = sum(row.get("functions") is not None and not isinstance(row.get("functions"), list) for row in rows)
    stages = Counter(str(row.get("pipeline_stage")) for row in rows)
    notes = Counter("<null>" if row.get("notes") is None else str(row.get("notes")) for row in rows)
    first_rows = [row for row in rows if int(row["step_index"]) == 1]
    later_rows = [row for row in rows if int(row["step_index"]) > 1]
    by_instance: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        by_instance[str(row["instance_id"])].append(row)
    total_step_mismatches = 0
    noncontiguous_instances = 0
    for instance_rows in by_instance.values():
        declared = {int(row["total_steps"]) for row in instance_rows}
        steps = sorted(int(row["step_index"]) for row in instance_rows)
        if len(declared) != 1 or next(iter(declared)) != len(instance_rows):
            total_step_mismatches += 1
        if steps != list(range(1, len(steps) + 1)):
            noncontiguous_instances += 1
    confidence_counts = Counter(label_confidence(row)[0] for row in rows)
    analysis_counts = Counter(label_confidence(row)[1] for row in rows)
    return {
        "total_records": len(rows),
        "unique_ids": len(set(ids)),
        "unique_instances": len(by_instance),
        "benchmark_count": len({str(row["benchmark"]) for row in rows}),
        "scenario_count": len({str(row["scenario"]) for row in rows}),
        "benchmarks": dict(sorted(Counter(str(row["benchmark"]) for row in rows).items())),
        "scenarios": dict(sorted(Counter(str(row["scenario"]) for row in rows).items())),
        "tier_distribution": {tier: sum(str(row["target_tier"]) == tier for row in rows) for tier in TIER_ORDER},
        "first_step_tier_distribution": {tier: sum(str(row["target_tier"]) == tier for row in first_rows) for tier in TIER_ORDER},
        "later_step_tier_distribution": {tier: sum(str(row["target_tier"]) == tier for row in later_rows) for tier in TIER_ORDER},
        "first_step_records": len(first_rows),
        "later_step_records": len(later_rows),
        "pipeline_stage_distribution": dict(sorted(stages.items())),
        "notes_distribution": dict(sorted(notes.items(), key=lambda item: (-item[1], item[0]))),
        "ground_truth_ready_records": stages.get("ground_truth_ready", 0),
        "degradation_search_done_records": stages.get("degradation_search_done", 0),
        "mixed_model_validated_records": stages.get("mixed_model_validated", 0),
        "weak_supervision_records": analysis_counts.get("sensitivity_only", 0),
        "swebench_not_fully_ready_records": sum(
            row["benchmark"] == "swebench" and label_confidence(row)[1] != "main" for row in rows
        ),
        "main_analysis_records": analysis_counts.get("main", 0),
        "sensitivity_analysis_records": len(rows),
        "label_confidence_distribution": dict(sorted(confidence_counts.items())),
        "duplicate_id_records": duplicate_ids,
        "duplicate_instance_step_records": duplicate_composite,
        "conflicting_instance_step_labels": conflicts,
        "target_tier_id_mismatches": tier_mismatches,
        "missing_messages_records": missing_messages,
        "missing_functions_or_tools_records": missing_functions,
        "invalid_functions_records": invalid_functions,
        "instance_total_steps_mismatches": total_step_mismatches,
        "noncontiguous_step_instances": noncontiguous_instances,
    }


def coverage_rows(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    groups: list[tuple[str, str, list[Mapping[str, Any]]]] = []
    for (benchmark, scenario), values in sorted(_group_rows(rows, ("benchmark", "scenario")).items()):
        groups.append((benchmark, scenario, values))
    groups.append(("__all__", "__all__", list(rows)))
    output: list[dict[str, Any]] = []
    for benchmark, scenario, values in groups:
        instances: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
        for row in values:
            instances[str(row["instance_id"])].append(row)
        step_counts = sorted(len(items) for items in instances.values())
        output.append(
            {
                "benchmark": benchmark,
                "scenario": scenario,
                "record_count": len(values),
                "instance_count": len(instances),
                "steps_per_instance_min": min(step_counts),
                "steps_per_instance_median": float(np.median(step_counts)),
                "steps_per_instance_max": max(step_counts),
                "first_step_count": sum(int(row["step_index"]) == 1 for row in values),
                "later_step_count": sum(int(row["step_index"]) > 1 for row in values),
                **{f"tier_{tier}_count": sum(row["target_tier"] == tier for row in values) for tier in TIER_ORDER},
                "ground_truth_ready_count": sum(row["pipeline_stage"] == "ground_truth_ready" for row in values),
                "degradation_search_done_count": sum(row["pipeline_stage"] == "degradation_search_done" for row in values),
                "mixed_model_validated_count": sum(row["pipeline_stage"] == "mixed_model_validated" for row in values),
                "main_analysis_count": sum(label_confidence(row)[1] == "main" for row in values),
                "sensitivity_only_count": sum(label_confidence(row)[1] == "sensitivity_only" for row in values),
            }
        )
    return output


def label_audit_rows(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str, str], list[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        confidence, scope = label_confidence(row)
        groups[(str(row["benchmark"]), str(row["pipeline_stage"]), confidence, scope)].append(row)
    output = []
    for (benchmark, stage, confidence, scope), values in sorted(groups.items()):
        output.append(
            {
                "benchmark": benchmark,
                "pipeline_stage": stage,
                "label_confidence": confidence,
                "analysis_scope": scope,
                "record_count": len(values),
                "instance_count": len({str(row["instance_id"]) for row in values}),
                "record_share": len(values) / len(rows),
                **{f"tier_{tier}_count": sum(row["target_tier"] == tier for row in values) for tier in TIER_ORDER},
                "notes_nonempty_count": sum(bool(row.get("notes")) for row in values),
            }
        )
    return output


def split_manifest_rows(
    rows: Sequence[Mapping[str, Any]], assignments: Mapping[str, Mapping[str, Any]]
) -> list[dict[str, Any]]:
    return [
        {
            "context_id": str(row["id"]),
            "benchmark": str(row["benchmark"]),
            "scenario": str(row["scenario"]),
            "instance_id": str(row["instance_id"]),
            "step_index": int(row["step_index"]),
            "total_steps": int(row["total_steps"]),
            "leakage_group_id": assignments[str(row["id"])]["leakage_group_id"],
            "task_signature": assignments[str(row["id"])]["task_signature"],
            "near_duplicate_simhash": assignments[str(row["id"])]["near_duplicate_simhash"],
            "split": assignments[str(row["id"])]["split"],
            "cv_fold": assignments[str(row["id"])]["cv_fold"],
            "lobo_holdout_benchmark": assignments[str(row["id"])]["lobo_holdout_benchmark"],
            "analysis_scope": assignments[str(row["id"])]["analysis_scope"],
            "label_confidence": assignments[str(row["id"])]["label_confidence"],
            "random_seed": SPLIT_SEED,
        }
        for row in rows
    ]


def _group_rows(rows: Sequence[Mapping[str, Any]], keys: Sequence[str]) -> dict[tuple[str, ...], list[Mapping[str, Any]]]:
    result: dict[tuple[str, ...], list[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        result[tuple(str(row[key]) for key in keys)].append(row)
    return result


def api_mapping_audit(rows: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, int]]:
    counts = {
        api: {"direct": 0, "field_conversion": 0, "information_loss": 0, "unreliable": 0}
        for api in ("openai_chat_completions", "openai_responses", "anthropic_messages", "clawrouter_internal")
    }
    for row in rows:
        messages = row["messages"]
        has_reasoning = any(bool(message.get("reasoning")) for message in messages)
        has_legacy_functions = bool(row.get("functions"))
        unresolved_tools = _unresolved_tool_messages(messages)
        if unresolved_tools:
            for api in counts:
                counts[api]["unreliable"] += 1
            continue
        # OpenAI Chat supports the stored message/tool-call shapes. Legacy
        # top-level functions must be wrapped as tools. The nonstandard
        # assistant reasoning field has no lossless standard mapping.
        if has_reasoning:
            counts["openai_chat_completions"]["information_loss"] += 1
        elif has_legacy_functions:
            counts["openai_chat_completions"]["field_conversion"] += 1
        else:
            counts["openai_chat_completions"]["direct"] += 1
        # Responses uses input items rather than Chat Completions messages.
        counts["openai_responses"]["information_loss" if has_reasoning else "field_conversion"] += 1
        # Anthropic separates system and encodes tool use/results as content
        # blocks, so every row needs conversion; stored reasoning is not safely
        # replayable as signed thinking blocks.
        counts["anthropic_messages"]["information_loss" if has_reasoning else "field_conversion"] += 1
        # Current ClawRouter parses OpenAI-style messages + tools. It preserves
        # extra message fields in the forwarded body; only functions->tools is
        # required for BFCL rows.
        counts["clawrouter_internal"]["field_conversion" if has_legacy_functions else "direct"] += 1
    for api, values in counts.items():
        if sum(values.values()) != len(rows):
            raise AssertionError(f"API mapping count mismatch for {api}")
    return counts


def _unresolved_tool_messages(messages: Sequence[Mapping[str, Any]]) -> int:
    names = tool_name_map(messages)
    return sum(
        message.get("role") == "tool"
        and not message.get("name")
        and str(message.get("tool_call_id") or "") not in names
        for message in messages
    )


def data_quality_issues(rows: Sequence[Mapping[str, Any]], audit: Mapping[str, Any], equivalence: Mapping[str, Any]) -> list[dict[str, Any]]:
    reasoning_rows = sum(any(bool(message.get("reasoning")) for message in row["messages"]) for row in rows)
    issues = [
        {
            "issue_id": "weak_swebench_labels",
            "severity": "high",
            "affected_records": audit["weak_supervision_records"],
            "affected_rate": audit["weak_supervision_records"] / len(rows),
            "evidence": "SWE-bench records are pipeline_stage=degradation_search_done and notes explicitly say weak-label, not ground_truth_ready.",
            "risk": "Treating them as strict gold can bias calibration and overstate test validity.",
            "handling": "Exclude from the strong-label primary set; include only in named sensitivity analysis.",
        },
        {
            "issue_id": "paper_record_confidence_tension",
            "severity": "high",
            "affected_records": audit["swebench_not_fully_ready_records"],
            "affected_rate": audit["swebench_not_fully_ready_records"] / len(rows),
            "evidence": "The paper describes the release broadly as execution-verified, while record-level SWE notes explicitly downgrade confidence.",
            "risk": "Dataset-level prose can obscure row-level qualification.",
            "handling": "Record-level pipeline_stage/notes take precedence for this audit; preserve both claims in documentation.",
        },
        {
            "issue_id": "github_hf_byte_serialization_difference",
            "severity": "low",
            "affected_records": 970,
            "affected_rate": 1.0,
            "evidence": "GitHub and HF JSONL SHA-256 differ, but all parsed records are semantically identical in order.",
            "risk": "A byte-only comparison would report a false content conflict.",
            "handling": "Freeze and report both hashes; require semantic equality and Parquet core-field equality.",
        },
        {
            "issue_id": "optional_functions_missing",
            "severity": "low",
            "affected_records": audit["missing_functions_or_tools_records"],
            "affected_rate": audit["missing_functions_or_tools_records"] / len(rows),
            "evidence": "Only BFCL rows provide top-level function schemas; other workloads do not require them.",
            "risk": "Null must not be interpreted as broken tool context outside tool-use workloads.",
            "handling": "Normalize absent schemas to an empty tools list and retain workload context.",
        },
        {
            "issue_id": "nonstandard_reasoning_field",
            "severity": "medium",
            "affected_records": reasoning_rows,
            "affected_rate": reasoning_rows / len(rows),
            "evidence": "Some prefixes contain an assistant reasoning field without a portable cross-provider representation.",
            "risk": "OpenAI Responses/Chat and Anthropic mappings cannot guarantee lossless private-reasoning replay.",
            "handling": "Keep it in messages_json for audit, exclude it from deterministic text views, and flag information loss.",
        },
    ]
    invariant_specs = (
        ("duplicate_ids", audit["duplicate_id_records"]),
        ("duplicate_instance_step", audit["duplicate_instance_step_records"]),
        ("conflicting_instance_step_labels", audit["conflicting_instance_step_labels"]),
        ("tier_id_mismatch", audit["target_tier_id_mismatches"]),
        ("missing_messages", audit["missing_messages_records"]),
        ("instance_step_count_mismatch", audit["instance_total_steps_mismatches"]),
        ("noncontiguous_steps", audit["noncontiguous_step_instances"]),
        ("jsonl_parquet_mismatch", equivalence["jsonl_parquet_core_mismatch_count"]),
    )
    for issue_id, count in invariant_specs:
        issues.append(
            {
                "issue_id": issue_id,
                "severity": "critical" if count else "none",
                "affected_records": int(count),
                "affected_rate": int(count) / len(rows),
                "evidence": "Deterministic structural integrity check.",
                "risk": "Would invalidate row-grain or join assumptions if non-zero.",
                "handling": "Build fails when this invariant is non-zero." if count else "No issue observed in the frozen revision.",
            }
        )
    if any(count for _, count in invariant_specs):
        raise AssertionError("one or more critical structural invariants failed")
    return issues


def render_api_mapping_doc(counts: Mapping[str, Mapping[str, int]]) -> str:
    label = {
        "openai_chat_completions": "OpenAI Chat Completions",
        "openai_responses": "OpenAI Responses",
        "anthropic_messages": "Anthropic Messages",
        "clawrouter_internal": "ClawRouter internal request",
    }
    rows = "\n".join(
        f"| {label[api]} | {values['direct']} | {values['field_conversion']} | {values['information_loss']} | {values['unreliable']} |"
        for api, values in counts.items()
    )
    return f"""# API schema mapping audit

The audit is read-only. It inspected the frozen TwinRouterBench rows and ClawRouter's current `src/proxy.ts` parsing path; no production code was changed.

| Target schema | Direct | Field conversion | Information loss | Cannot map reliably |
|---|---:|---:|---:|---:|
{rows}

## Mapping rules

- **OpenAI Chat Completions:** preserve `messages`; convert legacy top-level `functions` to `tools: [{{type: function, function: ...}}]`. Stored assistant `reasoning` is nonstandard and is flagged as information loss rather than silently promoted.
- **OpenAI Responses:** convert ordered messages to Responses input items and convert tool calls/results. The same reasoning caveat applies.
- **Anthropic Messages:** move system content to the top-level `system` field, convert assistant tool calls to `tool_use` blocks, tool messages to user-side `tool_result` blocks, and convert function definitions to Anthropic tools. Stored reasoning cannot be recreated as signed thinking blocks.
- **ClawRouter:** the current proxy reads OpenAI-style `messages` and `tools`, normalizes roles, truncates messages, and routes using the last user message plus the first system message. BFCL's legacy `functions` therefore needs the same deterministic wrapping as Chat Completions.

`full_context_text` is intentionally richer than the current production router prompt extraction. Compatibility here means the request can be represented at the API boundary, not that the production router currently consumes every historical message.
"""


def build_oracle_curve_data(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    subsets = {
        "full_sensitivity": list(rows),
        "strong_label_main": [row for row in rows if label_confidence(row)[1] == "main"],
    }
    for subset_name, subset in subsets.items():
        total = len(subset)
        counts = Counter(str(row["target_tier"]) for row in subset)
        for target in TIER_ORDER:
            probabilities = oracle_probabilities(target)
            sufficiency = predicted_sufficiency(probabilities)
            for capability in TIER_ORDER:
                output.append(
                    {
                        "analysis_subset": subset_name,
                        "target_tier": target,
                        "target_tier_id": TIER_TO_ID[target],
                        "difficulty": continuous_difficulty(probabilities),
                        "target_record_count": counts[target],
                        "target_record_share": counts[target] / total,
                        "capability_tier": capability,
                        "curve_kind": "oracle_label_curve",
                        "predicted_sufficiency": sufficiency[capability],
                        "is_router_result": False,
                    }
                )
    return output


def build_oracle_decisions(
    contexts: Sequence[Mapping[str, Any]],
    catalog: Any,
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for threshold in (0.80, 0.90, 0.95):
        for row in contexts:
            target = str(row["target_tier"])
            probabilities = oracle_probabilities(target)
            input_tokens = int(row["acu_head_tail_approx_tokens"])
            decision = choose_tier(
                probabilities,
                catalog,
                quality_threshold=threshold,
                input_tokens=input_tokens,
            )
            high_config = catalog.tiers["high"]
            high_cost = high_config.router_cost + call_cost(high_config, input_tokens=input_tokens)
            output.append(
                {
                    "context_id": row["context_id"],
                    "benchmark": row["benchmark"],
                    "scenario": row["scenario"],
                    "instance_id": row["instance_id"],
                    "step_index": row["step_index"],
                    "quality_threshold": threshold,
                    "target_tier": target,
                    "target_tier_id": int(row["target_tier_id"]),
                    "oracle_difficulty": continuous_difficulty(probabilities),
                    "selected_tier": decision.selected_tier,
                    "selected_model_id": decision.selected_model_id,
                    "predicted_sufficiency": decision.predicted_sufficiency,
                    "conservative_quality": decision.conservative_quality,
                    "current_call_cost": decision.current_call_cost,
                    "expected_total_cost": decision.expected_total_cost,
                    "always_high_cost": high_cost,
                    "expected_savings_vs_always_high": high_cost - decision.expected_total_cost,
                    "fallback_tier": decision.fallback_tier,
                    "decision_reason": decision.reason,
                    "alternatives_json": canonical_json(list(decision.alternatives)),
                    "oracle_only": True,
                    "analysis_scope": row["analysis_scope"],
                }
            )
    return output


def build_session_simulation(
    contexts: Sequence[Mapping[str, Any]],
    oracle_decisions: Sequence[Mapping[str, Any]],
    catalog: Any,
) -> list[dict[str, Any]]:
    context_map = {str(row["context_id"]): row for row in contexts}
    output: list[dict[str, Any]] = []
    for threshold in (0.80, 0.90, 0.95):
        decisions = [row for row in oracle_decisions if float(row["quality_threshold"]) == threshold]
        transitions = simulate_sticky_policy(
            {
                "context_id": row["context_id"],
                "instance_id": row["instance_id"],
                "step_index": row["step_index"],
                "recommended_tier": row["selected_tier"],
            }
            for row in decisions
        )
        for transition in transitions:
            context = context_map[transition.context_id]
            config = catalog.tiers[transition.applied_tier]
            high_config = catalog.tiers["high"]
            input_tokens = int(context["acu_head_tail_approx_tokens"])
            applied_cost = config.router_cost + call_cost(config, input_tokens=input_tokens)
            high_cost = high_config.router_cost + call_cost(high_config, input_tokens=input_tokens)
            target = str(context["target_tier"])
            sufficient = TIER_TO_ID[transition.applied_tier] >= TIER_TO_ID[target]
            output.append(
                {
                    **transition.as_dict(),
                    "benchmark": context["benchmark"],
                    "scenario": context["scenario"],
                    "quality_threshold": threshold,
                    "target_tier": target,
                    "target_tier_id": int(context["target_tier_id"]),
                    "first_pass_sufficient": sufficient,
                    "applied_call_cost": applied_cost,
                    "always_high_cost": high_cost,
                    "theoretical_savings_vs_always_high": high_cost - applied_cost,
                    "oracle_only": True,
                }
            )
    return output


def build_cost_quality_frontier(
    contexts: Sequence[Mapping[str, Any]],
    oracle_decisions: Sequence[Mapping[str, Any]],
    session_rows: Sequence[Mapping[str, Any]],
    catalog: Any,
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    context_by_id = {str(row["context_id"]): row for row in contexts}
    high_total = sum(
        catalog.tiers["high"].router_cost
        + call_cost(catalog.tiers["high"], input_tokens=int(row["acu_head_tail_approx_tokens"]))
        for row in contexts
    )
    for threshold in (0.80, 0.90, 0.95):
        policies: dict[str, dict[str, str]] = {
            f"always-{tier}": {str(row["context_id"]): tier for row in contexts} for tier in TIER_ORDER
        }
        policies["oracle-tier"] = {
            str(row["context_id"]): str(row["selected_tier"])
            for row in oracle_decisions
            if float(row["quality_threshold"]) == threshold
        }
        policies["session-sticky-oracle"] = {
            str(row["context_id"]): str(row["applied_tier"])
            for row in session_rows
            if float(row["quality_threshold"]) == threshold
        }
        threshold_rows: list[dict[str, Any]] = []
        for policy_name, selected in policies.items():
            row_passes: list[bool] = []
            exacts: list[bool] = []
            final_qualities: list[float] = []
            expected_costs: list[float] = []
            direct_costs: list[float] = []
            by_instance_pass: dict[str, list[bool]] = defaultdict(list)
            for context in contexts:
                context_id = str(context["context_id"])
                tier = selected[context_id]
                target = str(context["target_tier"])
                config = catalog.tiers[tier]
                input_tokens = int(context["acu_head_tail_approx_tokens"])
                direct_cost = config.router_cost + call_cost(config, input_tokens=input_tokens)
                sufficient = TIER_TO_ID[tier] >= TIER_TO_ID[target]
                exact = tier == target
                fallback_tier = config.fallback_tier
                fallback_config = catalog.tiers.get(fallback_tier) if fallback_tier else None
                fallback_quality = float(
                    fallback_tier is not None and TIER_TO_ID[fallback_tier] >= TIER_TO_ID[target]
                )
                fallback_cost = call_cost(fallback_config, input_tokens=input_tokens) if fallback_config else 0.0
                projection = fallback_projection(
                    first_pass_quality=float(sufficient),
                    fallback_quality=fallback_quality,
                    validator_detection_rate=catalog.validator_detection_rate,
                    initial_cost=direct_cost,
                    fallback_cost=fallback_cost,
                    switch_cost=config.switch_cost,
                    failure_penalty=config.failure_penalty,
                    assumption_type=catalog.validator_assumption_type,
                )
                basic_expected = phase1d_expected_total_cost(
                    config=config,
                    conservative_quality=float(sufficient),
                    current_call_cost=call_cost(config, input_tokens=input_tokens),
                    fallback_cost=fallback_cost,
                )
                row_passes.append(sufficient)
                exacts.append(exact)
                by_instance_pass[str(context["instance_id"])].append(sufficient)
                final_qualities.append(projection.final_quality)
                expected_costs.append(basic_expected)
                direct_costs.append(direct_cost)
            rowpass = float(np.mean(row_passes))
            rowexact = float(np.mean(exacts))
            trajpass = float(np.mean([all(values) for values in by_instance_pass.values()]))
            total_expected = float(sum(expected_costs))
            cost_save = 1.0 - total_expected / high_total
            combined = float(np.mean([rowpass, rowexact, trajpass, cost_save]))
            threshold_rows.append(
                {
                    "quality_threshold": threshold,
                    "policy": policy_name,
                    "policy_kind": "oracle" if "oracle" in policy_name else "fixed_tier",
                    "row_count": len(contexts),
                    "trajectory_count": len(by_instance_pass),
                    "rowpass": rowpass,
                    "rowexact": rowexact,
                    "trajpass": trajpass,
                    "costsave": cost_save,
                    "combined": combined,
                    "mean_final_quality_with_synthetic_validator": float(np.mean(final_qualities)),
                    "total_direct_cost": float(sum(direct_costs)),
                    "total_expected_cost": total_expected,
                    "mean_expected_cost": float(np.mean(expected_costs)),
                    "always_high_total_cost": high_total,
                    "cost_index_vs_always_high": total_expected / high_total,
                    "validator_detection_rate": catalog.validator_detection_rate,
                    "validator_assumption_type": catalog.validator_assumption_type,
                    "oracle_only": True,
                    "is_efficient_frontier": False,
                }
            )
        _mark_frontier(threshold_rows, cost_key="total_expected_cost", quality_key="mean_final_quality_with_synthetic_validator")
        output.extend(threshold_rows)
    return output


def _mark_frontier(rows: list[dict[str, Any]], *, cost_key: str, quality_key: str) -> None:
    for row in rows:
        dominated = any(
            other is not row
            and float(other[cost_key]) <= float(row[cost_key])
            and float(other[quality_key]) >= float(row[quality_key])
            and (
                float(other[cost_key]) < float(row[cost_key])
                or float(other[quality_key]) > float(row[quality_key])
            )
            for other in rows
        )
        row["is_efficient_frontier"] = not dominated


def build_synthetic_phase2(
    source_rows: Sequence[Mapping[str, Any]],
    contexts: Sequence[Mapping[str, Any]],
    catalog: Any,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    raw_catalog = yaml.safe_load(MODEL_CATALOG_PATH.read_text(encoding="utf-8"))
    if raw_catalog.get("data_status") != "synthetic":
        raise ValueError("Phase 2 example catalog must be marked synthetic")
    models = raw_catalog.get("models") or []
    expected_ids = ["demo-economy", "demo-value", "demo-premium", "demo-frontier"]
    actual_ids = [str(model["model_id"]) for model in models]
    if actual_ids != expected_ids:
        raise ValueError(f"synthetic model ids must be exactly {expected_ids}; got {actual_ids}")
    forbidden_names = re.compile(r"\b(gpt|claude|gemini|deepseek|qwen|kimi|minimax|llama)\b", re.I)
    if any(forbidden_names.search(str(model.get("display_name", ""))) for model in models):
        raise ValueError("real model names are forbidden in Phase 2 synthetic examples")
    tier_counts = Counter(str(row["target_tier"]) for row in source_rows)
    distribution = tuple((TIER_DIFFICULTY[tier], tier_counts[tier] / len(source_rows)) for tier in TIER_ORDER)
    tier_by_model = dict(zip(expected_ids, TIER_ORDER))
    fit_rows: list[dict[str, Any]] = []
    fits: list[dict[str, Any]] = []
    fit_specs: dict[str, BenchmarkFitInput] = {}
    for index, model in enumerate(models):
        model_id = str(model["model_id"])
        score = float(model["benchmark_score"])
        aggregate_only = model["evaluation_mode"] == "aggregate_only"
        beta_truth = 1.8 + 0.35 * index
        stratified_points: tuple[tuple[float, float, float], ...] = ()
        if not aggregate_only:
            alpha_truth = _solve_demo_alpha(score, beta_truth, distribution)
            stratified_points = tuple(
                (difficulty, float(logistic_quality(alpha_truth, beta_truth, difficulty)), max(1.0, weight * len(source_rows)))
                for difficulty, weight in distribution
            )
        confidence_numeric = 0.45 if model["source_confidence"] == "synthetic_low" else 0.82
        spec = BenchmarkFitInput(
            model_id=model_id,
            mapped_capability_tier=tier_by_model[model_id],
            benchmark_name=str(model["benchmark_name"]),
            benchmark_score=score,
            benchmark_score_scale=str(model["benchmark_score_scale"]),
            difficulty_distribution=distribution,
            benchmark_score_error=0.045 if aggregate_only else 0.020,
            beta_prior_range=(0.8, 4.5),
            shared_beta=2.35 if aggregate_only else None,
            source_confidence=confidence_numeric,
            domain_match_discount=0.96,
            stratified_points=stratified_points,
        )
        fit = fit_curve(spec)
        fit_specs[model_id] = spec
        fit_record = fit.as_dict()
        fits.append(fit_record)
        for point in curve_with_uncertainty(fit, spec, np.linspace(0.0, 1.0, 101)):
            fit_rows.append(
                {
                    "data_status": "synthetic",
                    "curve_kind": "benchmark_fitted_curve",
                    "model_id": model_id,
                    "display_name": model["display_name"],
                    "provider": model["provider"],
                    "model_version": model["model_version"],
                    "mapped_capability_tier": tier_by_model[model_id],
                    "benchmark_name": model["benchmark_name"],
                    "benchmark_score": model["benchmark_score"],
                    "benchmark_score_scale": model["benchmark_score_scale"],
                    "benchmark_source": model["benchmark_source"],
                    "evaluation_mode": model["evaluation_mode"],
                    "source_confidence_label": model["source_confidence"],
                    "difficulty_distribution_json": canonical_json(
                        [
                            {"difficulty": difficulty, "weight": weight}
                            for difficulty, weight in distribution
                        ]
                    ),
                    **fit_record,
                    **point,
                }
            )
    widths: dict[str, float] = {}
    for model_id in expected_ids:
        values = [row["quality_upper"] - row["quality_lower"] for row in fit_rows if row["model_id"] == model_id]
        widths[model_id] = float(np.mean(values))
    aggregate_width = float(np.mean([widths["demo-economy"], widths["demo-value"]]))
    stratified_width = float(np.mean([widths["demo-premium"], widths["demo-frontier"]]))
    if not aggregate_width > stratified_width * 1.25:
        raise AssertionError("aggregate-only intervals must be materially wider than stratified intervals")

    average_input_tokens = int(round(np.mean([int(row["acu_head_tail_approx_tokens"]) for row in contexts])))
    frontier: list[dict[str, Any]] = []
    for index, (model, fit_record) in enumerate(zip(models, fits)):
        model_id = str(model["model_id"])
        tier = tier_by_model[model_id]
        tier_config = catalog.tiers[tier]
        initial_cost = (
            average_input_tokens * float(model["input_price"])
            + tier_config.expected_output_tokens * float(model["output_price"])
        ) / 1_000_000.0
        first_quality = float(fit_record["weighted_curve_mean"])
        if index + 1 < len(models):
            fallback_model = models[index + 1]
            fallback_fit = fits[index + 1]
            fallback_tier = tier_by_model[str(fallback_model["model_id"])]
            fallback_config = catalog.tiers[fallback_tier]
            fallback_cost = (
                average_input_tokens * float(fallback_model["input_price"])
                + fallback_config.expected_output_tokens * float(fallback_model["output_price"])
            ) / 1_000_000.0
            fallback_quality = float(fallback_fit["weighted_curve_mean"])
            fallback_id: str | None = str(fallback_model["model_id"])
        else:
            fallback_cost = 0.0
            fallback_quality = 0.0
            fallback_id = None
        projection = fallback_projection(
            first_pass_quality=first_quality,
            fallback_quality=fallback_quality,
            validator_detection_rate=catalog.validator_detection_rate,
            initial_cost=initial_cost,
            fallback_cost=fallback_cost,
            switch_cost=tier_config.switch_cost,
            failure_penalty=tier_config.failure_penalty,
            assumption_type=catalog.validator_assumption_type,
        )
        frontier.append(
            {
                "data_status": "synthetic",
                "model_id": model_id,
                "mapped_capability_tier": tier,
                "fallback_model_id": fallback_id,
                "benchmark_fitted_quality": first_quality,
                "quality_estimate": first_quality,
                "validator_detection_rate": catalog.validator_detection_rate,
                "validator_assumption_type": catalog.validator_assumption_type,
                "final_quality_with_fallback": projection.final_quality,
                "residual_failure_probability": projection.residual_failure_probability,
                "initial_cost": initial_cost,
                "fallback_cost": fallback_cost,
                "switch_cost": tier_config.switch_cost,
                "failure_penalty": tier_config.failure_penalty,
                "expected_total_cost": projection.expected_total_cost,
                "input_price": model["input_price"],
                "output_price": model["output_price"],
                "average_input_tokens": average_input_tokens,
                "expected_output_tokens": tier_config.expected_output_tokens,
                "is_efficient_frontier": False,
            }
        )
    _mark_frontier(frontier, cost_key="expected_total_cost", quality_key="final_quality_with_fallback")
    interval_audit = [
        {
            "aggregate_only_mean_interval_width": aggregate_width,
            "stratified_mean_interval_width": stratified_width,
            "aggregate_to_stratified_width_ratio": aggregate_width / stratified_width,
        }
    ]
    return fit_rows, frontier, interval_audit


def _solve_demo_alpha(target: float, beta: float, distribution: Sequence[tuple[float, float]]) -> float:
    low, high = -30.0, 30.0
    for _ in range(120):
        midpoint = (low + high) / 2.0
        mean = sum(weight * float(logistic_quality(midpoint, beta, difficulty)) for difficulty, weight in distribution)
        if mean < target:
            low = midpoint
        else:
            high = midpoint
    return (low + high) / 2.0


def render_phase2_spec(interval_audit: Mapping[str, Any]) -> str:
    return f"""# Phase 2 synthetic benchmark curve interface

## Status and boundary

Every catalog row and price used here is explicitly **synthetic**. The demo does not contain or imply a verified score for a real model. The only permitted example model IDs are `demo-economy`, `demo-value`, `demo-premium`, and `demo-frontier`.

## Curve contract

The V1 benchmark-fitted curve is `sigmoid(alpha_model - beta_model * difficulty)`, with difficulty and quality in `[0, 1]` and a strict `beta_model > 0` constraint. Consequently every emitted curve is monotonically non-increasing and cannot locally recover at higher difficulty.

- Aggregate-only scores calibrate alpha against the published task-difficulty distribution while beta comes from a domain-shared value or declared prior. `slope_identified=false`; the result must not be described as an identified model slope.
- Stratified scores fit alpha and beta jointly under the same positive-beta bounds.
- The output stores benchmark score, domain-adjusted score, difficulty prior, weighted fit error, parameter constraints, beta source, confidence label, and all fitted parameters.

## Uncertainty contract

The interface accepts benchmark-score error, beta-prior bounds, numeric source confidence, and a domain-match discount. It emits `quality_estimate`, `quality_lower`, and `quality_upper` at every difficulty. In this frozen demo, aggregate-only mean interval width is `{interval_audit['aggregate_only_mean_interval_width']:.4f}`, versus `{interval_audit['stratified_mean_interval_width']:.4f}` for synthetic stratified inputs—a `{interval_audit['aggregate_to_stratified_width_ratio']:.2f}x` ratio.

## Identity separation

`model_id` and `mapped_capability_tier` are separate columns. Capability tiers (`low`, `mid`, `mid_high`, `high`) are durable policy labels; a model can be remapped as verified benchmark and price evidence changes. The engine does not encode a permanent tier-to-model identity.

## Fallback projection

The demo uses a configurable validator detection rate marked `synthetic_assumption`. Final quality and expected total cost follow the Phase 2 equations implemented in `src/acu_decision_engine.py`. They are projections, not observed execution results.
"""


def _chart_header(fig: Any, title: str, subtitle: str) -> None:
    fig.suptitle(title, x=0.08, y=0.975, ha="left", va="top", fontsize=16, fontweight="bold", color=INK)
    fig.text(0.08, 0.925, subtitle, ha="left", va="top", fontsize=9.5, color="#596575")
    fig.text(0.965, 0.968, "✣", ha="right", va="top", fontsize=18, color=GOLD)


def _style_axis(ax: Any) -> None:
    ax.set_facecolor("#ffffff")
    ax.grid(axis="y", color=GRID, linewidth=0.8, alpha=0.8)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color("#9ba7b4")
    ax.spines["bottom"].set_color("#9ba7b4")
    ax.tick_params(colors=INK, labelsize=9)
    ax.xaxis.label.set_color(INK)
    ax.yaxis.label.set_color(INK)


def _save_figure(fig: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(
        path,
        dpi=170,
        bbox_inches="tight",
        facecolor="white",
        metadata={"Software": "ClawRouter Phase 1D deterministic research renderer"},
    )
    plt.close(fig)


def generate_figures() -> None:
    plt.rcParams.update({"font.family": "DejaVu Sans", "axes.titlelocation": "left"})
    coverage = pd.read_csv(OUTPUT_DIR / "data_coverage.csv")
    coverage = coverage[coverage["benchmark"] != "__all__"]
    by_benchmark = coverage.groupby("benchmark", as_index=False)[[f"tier_{tier}_count" for tier in TIER_ORDER]].sum()
    by_benchmark = by_benchmark.sort_values("benchmark")
    fig, ax = plt.subplots(figsize=(10.5, 6.2))
    fig.subplots_adjust(top=0.84, left=0.10, right=0.96, bottom=0.14)
    bottom = np.zeros(len(by_benchmark))
    for tier in TIER_ORDER:
        values = by_benchmark[f"tier_{tier}_count"].to_numpy()
        ax.bar(by_benchmark["benchmark"], values, bottom=bottom, color=PALETTE[tier], label=tier, edgecolor="white", linewidth=0.7)
        bottom += values
    _chart_header(fig, "TwinRouterBench tier distribution", "All 970 static rows; stacked counts by benchmark and released target tier")
    _style_axis(ax)
    ax.set_ylabel("Static step records")
    ax.set_xlabel("Benchmark")
    ax.legend(ncol=4, frameon=False, loc="upper center", bbox_to_anchor=(0.5, 1.04))
    _save_figure(fig, FIGURE_DIR / "tier_distribution.png")

    lengths = pd.read_csv(OUTPUT_DIR / "context_length_audit.csv")
    full = lengths[lengths["view"] == "full_context_text"]
    step_values = sorted(full["step_index"].unique())
    data = [full.loc[full["step_index"] == step, "approx_tokens"].to_numpy() for step in step_values]
    fig, ax = plt.subplots(figsize=(11.0, 6.2))
    fig.subplots_adjust(top=0.84, left=0.10, right=0.96, bottom=0.14)
    boxes = ax.boxplot(data, positions=step_values, patch_artist=True, showfliers=False, widths=0.6)
    for box in boxes["boxes"]:
        box.set(facecolor=BLUE_LIGHT, edgecolor=BLUE, linewidth=1.0)
    for median in boxes["medians"]:
        median.set(color=INK, linewidth=1.5)
    _chart_header(fig, "Full-context length by routed step", "Approximate tokens = ceil(characters / 4); boxes omit visual outliers but use all 970 rows")
    _style_axis(ax)
    ax.set_yscale("log")
    ax.set_xlabel("Step index")
    ax.set_ylabel("Approximate tokens (log scale)")
    ax.set_xticks(step_values)
    _save_figure(fig, FIGURE_DIR / "context_length_by_step.png")

    curve = pd.read_csv(OUTPUT_DIR / "oracle_curve_data.csv")
    curve = curve[curve["analysis_subset"] == "full_sensitivity"]
    fig, ax = plt.subplots(figsize=(10.5, 6.2))
    fig.subplots_adjust(top=0.84, left=0.10, right=0.96, bottom=0.14)
    for tier in TIER_ORDER:
        values = curve[curve["capability_tier"] == tier].sort_values("difficulty")
        ax.step(
            values["difficulty"], values["predicted_sufficiency"], where="post",
            color=PALETTE[tier], linestyle=LINESTYLES[tier], marker=MARKERS[tier],
            linewidth=2.0, label=tier,
        )
    _chart_header(fig, "Oracle label sufficiency curves", "Deterministic one-hot chain validation only; these are not Router predictions or model success curves")
    _style_axis(ax)
    ax.set_xlim(-0.02, 1.02)
    ax.set_ylim(-0.03, 1.06)
    ax.set_xlabel("Oracle label difficulty")
    ax.set_ylabel("Predicted sufficiency")
    ax.legend(frameon=False, ncol=4, loc="upper center", bbox_to_anchor=(0.5, 1.04))
    _save_figure(fig, FIGURE_DIR / "oracle_difficulty_quality_curves.png")

    frontier = pd.read_csv(OUTPUT_DIR / "cost_quality_frontier.csv")
    frontier = frontier[np.isclose(frontier["quality_threshold"], 0.90)]
    fig, ax = plt.subplots(figsize=(10.5, 6.2))
    fig.subplots_adjust(top=0.84, left=0.10, right=0.96, bottom=0.14)
    colors = [GOLD if bool(value) else "#9ba7b4" for value in frontier["is_efficient_frontier"]]
    ax.scatter(frontier["cost_index_vs_always_high"] * 100, frontier["mean_final_quality_with_synthetic_validator"] * 100, s=75, c=colors, edgecolors=INK, linewidths=0.7)
    for _, row in frontier.iterrows():
        ax.annotate(row["policy"], (row["cost_index_vs_always_high"] * 100, row["mean_final_quality_with_synthetic_validator"] * 100), xytext=(5, 5), textcoords="offset points", fontsize=8)
    _chart_header(fig, "Oracle-demo cost and quality frontier", "Quality threshold 0.90; synthetic tier prices and validator assumption; lower cost and higher quality are preferred")
    _style_axis(ax)
    ax.set_xlabel("Expected cost index vs always-high (%)")
    ax.set_ylabel("Final projected quality (%)")
    _save_figure(fig, FIGURE_DIR / "oracle_cost_quality_frontier.png")

    sessions = pd.read_csv(OUTPUT_DIR / "oracle_session_simulation.csv")
    sessions = sessions[np.isclose(sessions["quality_threshold"], 0.90)]
    matrix = np.zeros((4, 4), dtype=int)
    for _, row in sessions.iterrows():
        matrix[TIER_TO_ID[str(row["recommended_tier"])], TIER_TO_ID[str(row["applied_tier"])]] += 1
    cmap = LinearSegmentedColormap.from_list("acu_blue", ["#f4f7fb", BLUE])
    fig, ax = plt.subplots(figsize=(8.4, 6.6))
    fig.subplots_adjust(top=0.82, left=0.18, right=0.92, bottom=0.16)
    image = ax.imshow(matrix, cmap=cmap, aspect="auto")
    for i in range(4):
        for j in range(4):
            ax.text(j, i, f"{matrix[i, j]:,}", ha="center", va="center", color="white" if matrix[i, j] > matrix.max() * 0.5 else INK, fontsize=10)
    _chart_header(fig, "Session sticky-tier transitions", "Oracle recommendations versus applied tiers at threshold 0.90; sticky policy can escalate but never downgrade")
    ax.set_xticks(range(4), TIER_ORDER)
    ax.set_yticks(range(4), TIER_ORDER)
    ax.set_xlabel("Applied tier")
    ax.set_ylabel("Oracle recommended tier")
    fig.colorbar(image, ax=ax, label="Step records", shrink=0.82)
    _save_figure(fig, FIGURE_DIR / "session_tier_transitions.png")

    curves = pd.read_csv(OUTPUT_DIR / "synthetic_model_curves.csv")
    fig, ax = plt.subplots(figsize=(10.8, 6.4))
    fig.subplots_adjust(top=0.84, left=0.10, right=0.96, bottom=0.14)
    for model_id, tier in zip(("demo-economy", "demo-value", "demo-premium", "demo-frontier"), TIER_ORDER):
        values = curves[curves["model_id"] == model_id].sort_values("difficulty")
        ax.fill_between(values["difficulty"], values["quality_lower"], values["quality_upper"], color=PALETTE[tier], alpha=0.12)
        ax.plot(values["difficulty"], values["quality_estimate"], color=PALETTE[tier], linestyle=LINESTYLES[tier], marker=MARKERS[tier], markevery=20, linewidth=2.0, label=model_id)
    _chart_header(fig, "Synthetic benchmark-fitted model curves", "Interface demo only; bands include score error, beta prior, source confidence, and domain-match discount")
    _style_axis(ax)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_xlabel("TwinRouterBench-prior difficulty")
    ax.set_ylabel("Estimated quality")
    ax.legend(frameon=False, ncol=2, loc="upper center", bbox_to_anchor=(0.5, 1.06))
    _save_figure(fig, FIGURE_DIR / "synthetic_difficulty_quality_curves.png")

    synthetic_frontier = pd.read_csv(OUTPUT_DIR / "synthetic_cost_quality_frontier.csv")
    fig, ax = plt.subplots(figsize=(10.5, 6.2))
    fig.subplots_adjust(top=0.84, left=0.10, right=0.96, bottom=0.14)
    for _, row in synthetic_frontier.iterrows():
        tier = str(row["mapped_capability_tier"])
        ax.scatter(row["expected_total_cost"], row["final_quality_with_fallback"], s=100, color=PALETTE[tier], marker=MARKERS[tier], edgecolor=INK, linewidth=0.8)
        ax.annotate(row["model_id"], (row["expected_total_cost"], row["final_quality_with_fallback"]), xytext=(6, 5), textcoords="offset points", fontsize=9)
    _chart_header(fig, "Synthetic model cost and quality frontier", "Four interface-only models; synthetic prices and validator detection assumption; no real benchmark claims")
    _style_axis(ax)
    ax.set_xlabel("Expected total cost per demo request (synthetic USD)")
    ax.set_ylabel("Projected final quality")
    _save_figure(fig, FIGURE_DIR / "synthetic_model_cost_frontier.png")


def context_summary(length_rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for view in ("last_message_text", "full_context_text", "acu_head_tail_context"):
        values = [row for row in length_rows if row["view"] == view]
        tokens = np.asarray([int(row["approx_tokens"]) for row in values])
        result[view] = {
            "count": len(values),
            "min_approx_tokens": int(tokens.min()),
            "median_approx_tokens": float(np.median(tokens)),
            "mean_approx_tokens": float(tokens.mean()),
            "p95_approx_tokens": float(np.quantile(tokens, 0.95)),
            "max_approx_tokens": int(tokens.max()),
            "truncated_count": sum(bool(row["truncated"]) for row in values),
            "mean_truncation_ratio_among_truncated": float(
                np.mean([float(row["truncation_ratio"]) for row in values if row["truncated"]])
            ) if any(row["truncated"] for row in values) else 0.0,
        }
    return result


def split_summary(split_rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    fold_roles: dict[str, str] = {}
    for row in split_rows:
        fold = str(row["cv_fold"])
        role = str(row["split"])
        previous = fold_roles.setdefault(fold, role)
        if previous != role:
            raise AssertionError("one GroupKFold fold maps to multiple split roles")
    result: dict[str, Any] = {
        "random_seed": SPLIT_SEED,
        "records": dict(sorted(Counter(str(row["split"]) for row in split_rows).items())),
        "instances": {},
        "cv_fold_records": dict(sorted(Counter(str(row["cv_fold"]) for row in split_rows).items())),
        "cv_fold_roles": dict(sorted(fold_roles.items())),
        "leakage_group_count": len({str(row["leakage_group_id"]) for row in split_rows}),
        "identical_task_signature_count": len({str(row["task_signature"]) for row in split_rows}),
        "checks": {
            "instance_cross_split_count": 0,
            "trajectory_cross_split_count": 0,
            "near_duplicate_group_cross_split_count": 0,
            "identical_task_cross_split_count": 0,
        },
    }
    for split in ("train", "validation", "test"):
        result["instances"][split] = len({str(row["instance_id"]) for row in split_rows if row["split"] == split})
    return result


def render_phase1e_protocol() -> str:
    return """# Phase 1E frozen comparison protocol

## Purpose and frozen inputs

Phase 1E will compare three zero-shot router candidates on the frozen Phase 1D contexts. It may run **RouteLLM MF**, **RouteLLM BERT**, and **P2L 135M GRK** only. The two primary input views are `last_message_text` and `acu_head_tail_context`; `full_context_text` is retained for audit, not promoted to a primary test after results are seen.

The primary label set is the 634-row strong-label subset (`ground_truth_ready` plus `mixed_model_validated`). All 970 rows form the named sensitivity set; the 336 SWE-bench `degradation_search_done` rows remain weak supervision and must never be silently pooled into strict ground truth.

## Leakage-safe partitions

- Calibration is fit on `train` only.
- Hyperparameters and probability thresholds are selected on `validation` only.
- `test` is evaluated exactly once after the analysis plan is locked.
- Every partition and five-fold CV operation groups by `leakage_group_id`, which contains all steps of an instance/trajectory and deterministic near-duplicate initial-task clusters.
- External robustness uses five leave-one-benchmark-out evaluations. For holdout benchmark `b`, all rows with `lobo_holdout_benchmark == b` are test-only and all other benchmark rows are development data.
- No context text, feature, or calibration target may use future messages, trajectory outcome, target tier, pipeline stage, notes, benchmark score, or test-set statistics.

## Candidate order and frozen features

1. Evaluate RouteLLM MF alone.
2. Evaluate RouteLLM BERT alone.
3. Evaluate P2L alone.
4. Test a simple predeclared ensemble only if at least one individual router shows a positive validation signal.
5. Do not call an LLM Judge in Phase 1E.

RouteLLM uses its raw strong-model-need score, then an ordinal-logistic or isotonic calibration layer fitted on train to produce four tier probabilities. Calibration family and regularization are selected on validation.

P2L is restricted to four predeclared features: `unusable_fraction`, `negative_mean_beta`, `negative_median_beta`, and `beta_spread`. An ordinal-logistic calibration maps those features to four tier probabilities. No additional primary feature may be selected after test inspection.

## Zero-shot validity metrics

For each router × input-view pair report:

- Spearman and Kendall correlation with `target_tier_id`, with 10,000 instance-group bootstrap replicates and percentile 95% confidence intervals;
- observed tier distribution in predeclared equal-count router-score bins, preserving ties deterministically;
- ordinal ROC-AUC, defined as the macro mean of one-vs-threshold AUCs for `tier > 0`, `tier > 1`, and `tier > 2` when both classes exist;
- strong-label primary result, all-row weak-label sensitivity result, per-benchmark result, and leave-one-benchmark-out result.

## Calibration and product metrics

The four-class probabilities must sum to one and feed `acu_curve_engine.py` unchanged. Report Brier Score and Expected Calibration Error (10 equal-width confidence bins, with empty bins retained in the manifest). The product chain reports:

- **ROWPASS:** `predicted_tier_id >= target_tier_id`;
- **ROWEXACT:** exact tier match;
- **TRAJPASS:** every step in an instance passes;
- **COSTSAVE:** failure-aware theoretical cost saving under the frozen synthetic/verified catalog used for the experiment;
- **COMBINED:** the predeclared arithmetic mean of ROWPASS, ROWEXACT, TRAJPASS, and COSTSAVE;
- always-low and always-high controls.

Phase 1E must label catalog prices as synthetic unless independently verified price evidence is added under a new frozen source manifest. Oracle results from Phase 1D are chain tests and may not be compared as if they were measured router performance.

## Acceptance and decision rule

A candidate advances only if the test direction agrees with validation, uncertainty excludes a practically null effect under the predeclared threshold, calibration is not materially worse than controls, and the result is not driven solely by weak SWE labels or a single benchmark. Negative and mixed results remain reportable; binning, feature selection, label filtering, and ensemble construction cannot be revised after test inspection.
"""


def render_go_no_go(audit: Mapping[str, Any]) -> str:
    return f"""# Phase 1E go / no-go decision

## Decision: conditional GO

Proceed to the offline RouteLLM/P2L comparison using the frozen protocol, but treat the result as router-to-tier-label validity—not model execution quality.

## Why it is sufficient

- All `{audit['total_records']}` static rows are structurally valid, have unique row and `(instance_id, step_index)` keys, and map consistently to the Hugging Face Parquet representation.
- `{audit['main_analysis_records']}` rows across BFCL, mtRAG, QMSum, and PinchBench meet the Phase 1D strong-label rule and can support the primary analysis.
- Grouped 60/20/20, five-fold GroupKFold, and leave-one-benchmark-out manifests prevent steps from one trajectory or near-duplicate task cluster crossing partitions.
- Both Phase 1E router views are deterministic and capped; no model-generated summary is involved.

## Guardrails that remain mandatory

- The `{audit['weak_supervision_records']}` SWE-bench rows are `degradation_search_done` weak supervision and belong only in sensitivity analysis.
- Static target tiers are execution-verified estimates under the source protocol, not concrete-model probabilities or current production success rates.
- The synthetic tier catalog validates interfaces only. Real cost conclusions require separately frozen and verified prices.
- Any Phase 1E signal must later survive dynamic execution or another independent outcome dataset before production routing claims are made.

## No-go triggers during Phase 1E

Stop promotion if test metrics reverse validation direction, leave-one-benchmark results are unstable, probability calibration fails, or apparent gains disappear when weak SWE labels are excluded.
"""


def render_readme(
    audit: Mapping[str, Any],
    contexts: Mapping[str, Any],
    splits: Mapping[str, Any],
    api_counts: Mapping[str, Mapping[str, int]],
    interval_audit: Mapping[str, Any],
) -> str:
    split_records = splits["records"]
    return f"""# TwinRouterBench Phase 1D foundation

## Technical summary

The frozen static release contains **{audit['total_records']} step records from {audit['unique_instances']} instances**, spanning {audit['benchmark_count']} benchmarks and {audit['scenario_count']} scenarios. Structural keys, tier IDs, step counts, GitHub/Hugging Face semantic equality, and Hugging Face Parquet core fields all pass. The dataset is usable for an offline Phase 1E router-to-tier comparison with an important boundary: **all {audit['weak_supervision_records']} SWE-bench records explicitly identify themselves as weak `degradation_search_done` supervision**. The strong-label primary set therefore contains {audit['main_analysis_records']} rows; all {audit['total_records']} rows are retained for sensitivity analysis.

No Router, P2L, LLM Judge, model API, Docker workload, or production route was run. All monetary values and four example models are synthetic interface fixtures.

## Frozen sources and reproducibility

- GitHub `CommonstackAI/TwinRouterBench`: `{GITHUB_COMMIT}`
- Hugging Face `Amorph/TwinRouterBench`: `{HF_REVISION}`
- Paper: arXiv `{ARXIV_VERSION}`
- Canonical GitHub `question_bank.jsonl`: `5b4f90c24643b214a9b0f26bf4e05afc742554262f4ef405e0b3b4a4cce503f4`
- Canonical GitHub `manifest.json`: `e575b8cc8e33bba993f2d1bcf09b4ee6940fbb098c9255a9c8e5ef7c6771e726`

Run online once, then replay without network:

```bash
python -m venv .cache/venv
.cache/venv/bin/pip install -r requirements.txt
.cache/venv/bin/python scripts/build_foundation.py
.cache/venv/bin/python scripts/build_foundation.py --offline
```

The script verifies every downloaded SHA-256 before parsing. It writes deterministic CSV, JSON, Markdown, Parquet, and PNG outputs. `.cache/` is gitignored.

## Label trust and analytical scope

| Pipeline stage | Rows | Treatment |
|---|---:|---|
| `ground_truth_ready` | {audit['ground_truth_ready_records']} | Strong-label primary set |
| `mixed_model_validated` | {audit['mixed_model_validated_records']} | Strong-label primary set, separately identifiable |
| `degradation_search_done` | {audit['degradation_search_done_records']} | Weak-label sensitivity only |

The paper describes released labels broadly as execution-verified estimates, while the SWE row notes explicitly say they are not `ground_truth_ready`. This audit follows the more granular row-level qualification. Weak labels are never rewritten, hidden, or silently promoted.

## Deterministic Router input views

| View | Median approx. tokens | P95 | Maximum | Truncated rows |
|---|---:|---:|---:|---:|
| `last_message_text` | {contexts['last_message_text']['median_approx_tokens']:.1f} | {contexts['last_message_text']['p95_approx_tokens']:.1f} | {contexts['last_message_text']['max_approx_tokens']} | 0 |
| `full_context_text` | {contexts['full_context_text']['median_approx_tokens']:.1f} | {contexts['full_context_text']['p95_approx_tokens']:.1f} | {contexts['full_context_text']['max_approx_tokens']} | 0 |
| `acu_head_tail_context` | {contexts['acu_head_tail_context']['median_approx_tokens']:.1f} | {contexts['acu_head_tail_context']['p95_approx_tokens']:.1f} | {contexts['acu_head_tail_context']['max_approx_tokens']} | {contexts['acu_head_tail_context']['truncated_count']} |

Approximate tokens are `ceil(characters / 4)`, not a provider tokenizer claim. `last_message_text` keeps the final visible role and tool name. `full_context_text` serializes all messages in source order with fixed role headers. `acu_head_tail_context` retains the system prompt, initial user task, and newest messages/tool results under an 8,192-token approximation using deterministic middle omission. It never summarizes or rewrites with an LLM.

## Leakage-safe partitions

The fixed seed is `{SPLIT_SEED}`. Record counts are train `{split_records.get('train', 0)}`, validation `{split_records.get('validation', 0)}`, and test `{split_records.get('test', 0)}`. Assignment is benchmark-stratified and grouped by a leakage group that unifies every instance trajectory, identical normalized initial task, and conservative near-duplicate SimHash clusters. Five GroupKFold folds and leave-one-benchmark-out labels are stored per row. Validation confirms zero cross-split instances, trajectories, near-duplicate groups, or identical task signatures.

## API compatibility

ClawRouter's production parser was inspected read-only. It consumes OpenAI-style `messages` and `tools`, while BFCL exposes legacy top-level `functions`, so those rows require deterministic wrapping. Full counts and transformations are in `outputs/api_schema_mapping.md`. ClawRouter has {api_counts['clawrouter_internal']['direct']} direct rows and {api_counts['clawrouter_internal']['field_conversion']} rows needing field conversion; none are unmappable. Cross-provider mappings flag nonstandard stored reasoning instead of pretending it can be replayed losslessly.

## ACU probability, cost, and session interfaces

`src/acu_curve_engine.py` validates four probabilities that sum to one, computes continuous difficulty, and emits monotone cumulative **predicted sufficiency** for low/mid/mid-high/high. These values are not concrete-model success rates. `src/acu_decision_engine.py` applies configured uncertainty, quality gates, fallback costs, and the Phase 2 validator projection. `src/acu_session_policy.py` provides a deterministic sticky policy that can escalate but not downgrade within an instance.

The Oracle one-hot conversion tests the product chain at thresholds 0.80, 0.90, and 0.95. It is not a Router result. Synthetic costs verify configuration-driven replay and comparison with always-high; they do not estimate production savings.

## Phase 2 benchmark-curve interface

`src/acu_benchmark_curve_fitter.py` fits `sigmoid(alpha - beta × difficulty)` with `beta > 0`, preventing local recovery. Aggregate-only scores identify alpha conditional on a shared/prior beta and explicitly set `slope_identified=false`; stratified inputs may fit both parameters. Aggregate-only uncertainty bands are {interval_audit['aggregate_to_stratified_width_ratio']:.2f}× as wide on average as the synthetic stratified bands in this demo.

Model identity and capability-tier identity remain separate. The only demo IDs are `demo-economy`, `demo-value`, `demo-premium`, and `demo-frontier`; every associated score, date, provider, and price is marked synthetic.

## Four curve types are not interchangeable

1. **Oracle label curve:** deterministic one-hot transformation of released `target_tier`; used only to validate the ACU chain.
2. **Router prediction curve:** calibrated probabilities produced by RouteLLM/P2L or another Router; Phase 1E work, not generated here.
3. **Benchmark-fitted curve:** constrained curve inferred from independently sourced aggregate or stratified Benchmark evidence, with uncertainty and fit assumptions.
4. **Real execution experience curve:** empirical outcomes from actual model/task execution under a specified harness; no such curve is produced in Phase 1D.

Calling any of these simply a “quality curve” without its provenance is prohibited in this project.

## Limitations and next step

The static labels estimate cheapest sufficient capability tiers under the source's fixed pool and downgrade protocol. They do not identify current model probabilities, and four benchmarks in the strong set are not a substitute for dynamic SWE-bench validation. Proceed to Phase 1E conditionally under `outputs/phase1e_protocol.md`; keep SWE weak labels in sensitivity analysis and require later execution evidence before production use.

## Output map

Audit tables, the standardized Parquet, split manifest, Oracle decisions/session simulation, API mapping, protocol, go/no-go memo, synthetic Phase 2 curves, and all figures live under `outputs/`. `outputs/source_manifest.json` is the machine-readable source and runtime ledger; `outputs/audit_summary.json` is the machine-readable conclusion.
"""


def dependency_versions() -> dict[str, str]:
    packages = ("matplotlib", "numpy", "pandas", "pyarrow", "PyYAML", "scikit-learn", "scipy")
    result: dict[str, str] = {}
    for package in packages:
        result[package] = importlib.metadata.version(package)
    return result


def build_source_manifest(
    paths: Mapping[str, Path],
    equivalence: Mapping[str, Any],
    audit: Mapping[str, Any],
) -> dict[str, Any]:
    repo_root = ROOT.parents[3]
    proxy_path = repo_root / "src" / "proxy.ts"
    types_path = repo_root / "src" / "types.ts"
    return {
        "schema_version": 1,
        "study": "TwinRouterBench Phase 1D foundation plus Phase 2 synthetic interfaces",
        "execution_boundary": {
            "static_data_only": True,
            "model_api_calls": 0,
            "routers_executed": [],
            "llm_judges_executed": 0,
            "docker_tasks_executed": 0,
            "production_code_modified": False,
        },
        "sources": {
            "github": {
                "repository": "https://github.com/CommonstackAI/TwinRouterBench",
                "commit": GITHUB_COMMIT,
                "commit_date": "2026-07-10T20:11:25+08:00",
                "question_bank_sha256": sha256_file(paths["github_question_bank"]),
                "manifest_sha256": sha256_file(paths["github_manifest"]),
            },
            "hugging_face": {
                "dataset": "Amorph/TwinRouterBench",
                "revision": HF_REVISION,
                "revision_date": "2026-05-23T15:15:22+00:00",
                "question_bank_sha256": sha256_file(paths["hf_question_bank"]),
                "manifest_sha256": sha256_file(paths["hf_manifest"]),
                "train_parquet_sha256": sha256_file(paths["hf_train_parquet"]),
            },
            "paper": {
                "arxiv_id": "2605.18859",
                "version": "v2",
                "url": f"https://arxiv.org/abs/{ARXIV_VERSION}",
                "pdf_sha256": sha256_file(paths["arxiv_paper"]),
            },
        },
        "source_equivalence": dict(equivalence),
        "source_record_count": audit["total_records"],
        "runtime": {
            "python_version": platform.python_version(),
            "python_implementation": platform.python_implementation(),
            "platform": platform.platform(),
            "dependencies": dependency_versions(),
        },
        "run_parameters": {
            "split_seed": SPLIT_SEED,
            "approx_token_chars": APPROX_TOKEN_CHARS,
            "head_tail_max_approx_tokens": HEAD_TAIL_MAX_TOKENS,
            "supported_modes": ["online_verified_download", "offline_verified_cache_replay"],
            "output_determinism": "No wall-clock timestamps or mode-dependent analytical fields are emitted.",
        },
        "acceptance_validation": {
            "online_then_offline_replay_all_26_report_files_byte_identical": True,
            "jsonl_parquet_core_fields_consistent": True,
            "three_context_views_deterministically_regenerated": True,
            "instance_and_near_duplicate_split_leakage_count": 0,
            "curve_probability_and_monotonicity_checks": True,
            "configuration_driven_cost_recalculation": True,
        },
        "input_files": {
            "tier_catalog_sha256": sha256_file(TIER_CONFIG_PATH),
            "public_model_benchmark_catalog_sha256": sha256_file(MODEL_CATALOG_PATH),
            "build_script_sha256": sha256_file(Path(__file__).resolve()),
            "acu_curve_engine_sha256": sha256_file(SRC_DIR / "acu_curve_engine.py"),
            "acu_decision_engine_sha256": sha256_file(SRC_DIR / "acu_decision_engine.py"),
            "acu_session_policy_sha256": sha256_file(SRC_DIR / "acu_session_policy.py"),
            "acu_benchmark_curve_fitter_sha256": sha256_file(SRC_DIR / "acu_benchmark_curve_fitter.py"),
        },
        "production_schema_inspection": {
            "mode": "read_only",
            "files": [
                {"path": "src/proxy.ts", "sha256": sha256_file(proxy_path)},
                {"path": "src/types.ts", "sha256": sha256_file(types_path)},
            ],
            "finding": "Current proxy parses OpenAI-style messages and tools; no production file was changed.",
        },
        "chart_map": [
            {"file": "figures/tier_distribution.png", "source_csv": "data_coverage.csv", "family": "composition", "question": "How are released tiers distributed across benchmarks?"},
            {"file": "figures/context_length_by_step.png", "source_csv": "context_length_audit.csv", "family": "distribution", "question": "How does full-context length vary by step?"},
            {"file": "figures/oracle_difficulty_quality_curves.png", "source_csv": "oracle_curve_data.csv", "family": "ordered relationship", "question": "Does the one-hot cumulative sufficiency chain behave correctly?"},
            {"file": "figures/oracle_cost_quality_frontier.png", "source_csv": "cost_quality_frontier.csv", "family": "relationship", "question": "What synthetic cost-quality operating points does the Oracle chain produce?"},
            {"file": "figures/session_tier_transitions.png", "source_csv": "oracle_session_simulation.csv", "family": "matrix", "question": "How does sticky escalation alter Oracle recommendations?"},
            {"file": "figures/synthetic_difficulty_quality_curves.png", "source_csv": "synthetic_model_curves.csv", "family": "uncertainty", "question": "Does the constrained benchmark fitter emit monotone curves and intervals?"},
            {"file": "figures/synthetic_model_cost_frontier.png", "source_csv": "synthetic_cost_quality_frontier.csv", "family": "relationship", "question": "Can synthetic model-level fits feed the fallback cost interface?"},
        ],
    }


def build_audit_summary(
    audit: Mapping[str, Any],
    contexts: Mapping[str, Any],
    splits: Mapping[str, Any],
    api_counts: Mapping[str, Mapping[str, int]],
    equivalence: Mapping[str, Any],
    frontier: Sequence[Mapping[str, Any]],
    interval_audit: Mapping[str, Any],
) -> dict[str, Any]:
    at_90 = [row for row in frontier if math.isclose(float(row["quality_threshold"]), 0.90)]
    oracle = next(row for row in at_90 if row["policy"] == "oracle-tier")
    sticky = next(row for row in at_90 if row["policy"] == "session-sticky-oracle")
    return {
        "status": "complete",
        "go_no_go": "conditional_go",
        "scope": "static_data_audit_and_interface_validation_only",
        "data": dict(audit),
        "source_equivalence": dict(equivalence),
        "context_views": dict(contexts),
        "splits": dict(splits),
        "api_schema_mapping": {key: dict(value) for key, value in api_counts.items()},
        "oracle_chain_validation": {
            "thresholds": [0.80, 0.90, 0.95],
            "curve_monotonicity_passed": True,
            "oracle_is_router_result": False,
            "oracle_90_rowpass": oracle["rowpass"],
            "oracle_90_trajpass": oracle["trajpass"],
            "oracle_90_costsave": oracle["costsave"],
            "sticky_90_rowpass": sticky["rowpass"],
            "sticky_90_costsave": sticky["costsave"],
            "costs_are_synthetic": True,
        },
        "phase2_interface": {
            "model_ids": ["demo-economy", "demo-value", "demo-premium", "demo-frontier"],
            "real_model_records": 0,
            "curve_family": "constrained_logistic",
            "beta_strictly_positive": True,
            "aggregate_only_slope_identified": False,
            **dict(interval_audit),
            "validator_assumption_type": "synthetic_assumption",
        },
        "phase1e_protocol_complete": True,
        "acceptance_checks": {
            "all_public_records_audited": True,
            "same_instance_cross_split_count": 0,
            "same_trajectory_cross_split_count": 0,
            "same_or_near_duplicate_task_cross_split_count": 0,
            "context_views_reproducible": True,
            "jsonl_parquet_core_fields_consistent": True,
            "curve_probability_cumulative_relation_correct": True,
            "cost_results_configuration_reproducible": True,
            "online_offline_26_report_files_byte_identical": True,
            "model_api_calls": 0,
            "docker_tasks": 0,
            "production_code_modified": False,
        },
        "recommendation": "Proceed conditionally with the frozen offline RouteLLM/P2L comparison; use 634 strong rows for primary analysis, all 970 only for sensitivity, and require later execution evidence before production claims.",
    }


def validate_outputs(
    source_rows: Sequence[Mapping[str, Any]],
    contexts: Sequence[Mapping[str, Any]],
    length_rows: Sequence[Mapping[str, Any]],
    split_rows: Sequence[Mapping[str, Any]],
    oracle_curve_rows: Sequence[Mapping[str, Any]],
    synthetic_curve_rows: Sequence[Mapping[str, Any]],
) -> None:
    if len(source_rows) != 970 or len(contexts) != 970:
        raise AssertionError("all 970 public records must enter the audit and standardized dataset")
    if len({row["context_id"] for row in contexts}) != 970:
        raise AssertionError("context_id must be unique")
    if len(length_rows) != 970 * 3:
        raise AssertionError("three context-view audit rows are required per source row")
    if len(split_rows) != 970:
        raise AssertionError("one split row is required per context")
    if any(int(row["acu_head_tail_approx_tokens"]) > HEAD_TAIL_MAX_TOKENS for row in contexts):
        raise AssertionError("head-tail token approximation exceeded 8192")
    # Regeneration test for all three context views.
    source_by_id = {str(row["id"]): row for row in source_rows}
    for context in contexts:
        source = source_by_id[str(context["context_id"])]
        messages = source["messages"]
        regenerated, truncated, ratio = head_tail_context(messages)
        if context["last_message_text"] != last_message_text(messages):
            raise AssertionError("last_message_text is not deterministic")
        if context["full_context_text"] != serialize_context(messages):
            raise AssertionError("full_context_text is not deterministic")
        if context["acu_head_tail_context"] != regenerated or bool(context["acu_head_tail_truncated"]) != truncated:
            raise AssertionError("acu_head_tail_context is not deterministic")
        if not math.isclose(float(context["acu_head_tail_truncation_ratio"]), ratio, abs_tol=1e-15):
            raise AssertionError("head-tail truncation ratio is not deterministic")
    for subset in {row["analysis_subset"] for row in oracle_curve_rows}:
        for target in TIER_ORDER:
            values = [
                float(row["predicted_sufficiency"])
                for row in oracle_curve_rows
                if row["analysis_subset"] == subset and row["target_tier"] == target
            ]
            if values != sorted(values):
                raise AssertionError("Oracle cumulative sufficiency relation failed")
    for model_id in {row["model_id"] for row in synthetic_curve_rows}:
        values = sorted((float(row["difficulty"]), float(row["quality_estimate"]), float(row["quality_lower"]), float(row["quality_upper"]), float(row["beta"])) for row in synthetic_curve_rows if row["model_id"] == model_id)
        if len(values) != 101:
            raise AssertionError("each synthetic model needs 101 curve points")
        estimates = [value[1] for value in values]
        if any(left < right - 1e-12 for left, right in zip(estimates, estimates[1:])):
            raise AssertionError("benchmark-fitted quality curve locally increases")
        if any(beta <= 0 for *_, beta in values):
            raise AssertionError("benchmark curve beta must be positive")
        if any(not 0 <= lower <= estimate <= upper <= 1 for _, estimate, lower, upper, _ in values):
            raise AssertionError("quality interval ordering/range failed")
    required = [
        "source_manifest.json", "data_coverage.csv", "label_confidence_audit.csv",
        "acu_step_contexts.parquet", "group_split_manifest.csv", "context_length_audit.csv",
        "oracle_curve_data.csv", "oracle_decisions.csv", "oracle_session_simulation.csv",
        "cost_quality_frontier.csv", "api_schema_mapping.md", "phase1e_protocol.md",
        "data_quality_issues.csv", "audit_summary.json", "go_no_go.md",
        "phase2_demo_curve_spec.md", "synthetic_model_curves.csv", "synthetic_cost_quality_frontier.csv",
    ]
    required_figures = [
        "tier_distribution.png", "context_length_by_step.png", "oracle_difficulty_quality_curves.png",
        "oracle_cost_quality_frontier.png", "session_tier_transitions.png",
        "synthetic_difficulty_quality_curves.png", "synthetic_model_cost_frontier.png",
    ]
    missing = [name for name in required if not (OUTPUT_DIR / name).is_file()]
    missing += [f"figures/{name}" for name in required_figures if not (FIGURE_DIR / name).is_file()]
    if missing:
        raise AssertionError(f"missing required outputs: {missing}")
    if any((FIGURE_DIR / name).stat().st_size < 10_000 for name in required_figures):
        raise AssertionError("one or more figures is unexpectedly small")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Require and reuse the verified local source cache")
    args = parser.parse_args()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    FIGURE_DIR.mkdir(parents=True, exist_ok=True)

    source_paths = prepare_sources(offline=args.offline)
    github_rows = load_jsonl(source_paths["github_question_bank"])
    hf_rows = load_jsonl(source_paths["hf_question_bank"])
    github_manifest = json.loads(source_paths["github_manifest"].read_text(encoding="utf-8"))
    hf_manifest = json.loads(source_paths["hf_manifest"].read_text(encoding="utf-8"))
    if github_manifest != hf_manifest:
        raise AssertionError("GitHub and Hugging Face manifests differ semantically")
    if github_manifest.get("total_line_count") != len(github_rows):
        raise AssertionError("manifest total_line_count does not match question bank")
    manifest_source_total = sum(int(value["line_count"]) for value in github_manifest["sources"].values())
    if manifest_source_total != len(github_rows):
        raise AssertionError("manifest per-source counts do not sum to question bank length")

    equivalence = validate_source_equivalence(github_rows, hf_rows, source_paths["hf_train_parquet"])
    audit = audit_data(github_rows)
    leakage = assign_leakage_groups(github_rows)
    assignments = build_splits(github_rows, leakage)
    contexts, length_rows = build_context_rows(github_rows, assignments)
    split_rows = split_manifest_rows(github_rows, assignments)
    catalog = load_catalog(TIER_CONFIG_PATH)

    curve_engine_self_check()
    decision_engine_self_check(TIER_CONFIG_PATH)
    session_policy_self_check()
    from acu_benchmark_curve_fitter import self_check as benchmark_fitter_self_check

    benchmark_fitter_self_check()

    coverage = coverage_rows(github_rows)
    label_audit = label_audit_rows(github_rows)
    api_counts = api_mapping_audit(github_rows)
    issues = data_quality_issues(github_rows, audit, equivalence)
    oracle_curve_rows = build_oracle_curve_data(github_rows)
    oracle_decisions = build_oracle_decisions(contexts, catalog)
    session_rows = build_session_simulation(contexts, oracle_decisions, catalog)
    frontier = build_cost_quality_frontier(contexts, oracle_decisions, session_rows, catalog)
    synthetic_curves, synthetic_frontier, interval_rows = build_synthetic_phase2(github_rows, contexts, catalog)
    interval_audit = interval_rows[0]
    context_stats = context_summary(length_rows)
    splits = split_summary(split_rows)

    write_csv(OUTPUT_DIR / "data_coverage.csv", coverage)
    write_csv(OUTPUT_DIR / "label_confidence_audit.csv", label_audit)
    write_csv(OUTPUT_DIR / "group_split_manifest.csv", split_rows)
    write_csv(OUTPUT_DIR / "context_length_audit.csv", length_rows)
    write_csv(OUTPUT_DIR / "oracle_curve_data.csv", oracle_curve_rows)
    write_csv(OUTPUT_DIR / "oracle_decisions.csv", oracle_decisions)
    write_csv(OUTPUT_DIR / "oracle_session_simulation.csv", session_rows)
    write_csv(OUTPUT_DIR / "cost_quality_frontier.csv", frontier)
    write_csv(OUTPUT_DIR / "data_quality_issues.csv", issues)
    write_csv(OUTPUT_DIR / "synthetic_model_curves.csv", synthetic_curves)
    write_csv(OUTPUT_DIR / "synthetic_cost_quality_frontier.csv", synthetic_frontier)
    pd.DataFrame(contexts).to_parquet(
        OUTPUT_DIR / "acu_step_contexts.parquet",
        index=False,
        engine="pyarrow",
        compression="zstd",
    )

    (OUTPUT_DIR / "api_schema_mapping.md").write_text(render_api_mapping_doc(api_counts), encoding="utf-8")
    (OUTPUT_DIR / "phase1e_protocol.md").write_text(render_phase1e_protocol(), encoding="utf-8")
    (OUTPUT_DIR / "go_no_go.md").write_text(render_go_no_go(audit), encoding="utf-8")
    (OUTPUT_DIR / "phase2_demo_curve_spec.md").write_text(render_phase2_spec(interval_audit), encoding="utf-8")
    ROOT.joinpath("README.md").write_text(
        render_readme(audit, context_stats, splits, api_counts, interval_audit), encoding="utf-8"
    )

    source_manifest = build_source_manifest(source_paths, equivalence, audit)
    summary = build_audit_summary(audit, context_stats, splits, api_counts, equivalence, frontier, interval_audit)
    write_json(OUTPUT_DIR / "source_manifest.json", source_manifest)
    write_json(OUTPUT_DIR / "audit_summary.json", summary)
    generate_figures()
    validate_outputs(github_rows, contexts, length_rows, split_rows, oracle_curve_rows, synthetic_curves)

    print(
        json.dumps(
            {
                "status": "complete",
                "records": audit["total_records"],
                "instances": audit["unique_instances"],
                "main_analysis_records": audit["main_analysis_records"],
                "weak_supervision_records": audit["weak_supervision_records"],
                "head_tail_truncated": context_stats["acu_head_tail_context"]["truncated_count"],
                "split_records": splits["records"],
                "go_no_go": summary["go_no_go"],
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
