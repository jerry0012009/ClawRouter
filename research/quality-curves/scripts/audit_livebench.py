#!/usr/bin/env python3
"""Audit the official public LiveBench question and model-judgment data.

The script uses only pinned official GitHub/Hugging Face repositories. It does
not call any model API. Raw repositories and projected source data are kept in
the gitignored cache directory.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
import math
import os
import re
import statistics
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    import fsspec
    import pyarrow.parquet as pq
except ImportError as exc:  # pragma: no cover - exercised by clean environments
    raise SystemExit(
        "Missing Python dependencies. Run: "
        "python3 -m venv .cache/venv && "
        ".cache/venv/bin/pip install -r requirements.txt"
    ) from exc


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DEFAULT_CACHE_DIR = PROJECT_DIR / ".cache"
DEFAULT_OUTPUT_DIR = PROJECT_DIR / "outputs"

LIVEBENCH_CODE = {
    "name": "LiveBench/LiveBench",
    "url": "https://github.com/LiveBench/LiveBench.git",
    "web_url": "https://github.com/LiveBench/LiveBench",
    # Last official code commit at/before the HF data snapshot timestamp.
    "commit": "a41783c06f646697a96cc2ae2275a6b5c2646cb4",
}

HF_DATASETS: dict[str, dict[str, Any]] = {
    "model_judgment": {
        "commit": "9704e5da7bfbefe75ac1482a13de827127295993",
        "files": ["data/leaderboard-00000-of-00001.parquet"],
        "kind": "judgment",
    },
    "reasoning": {
        "commit": "6fc6498a5dfba553f69f4413feabade1f1a2d384",
        "files": ["data/test-00000-of-00001.parquet"],
        "kind": "question",
    },
    "math": {
        "commit": "bb66571c8ccf32d3df9e6f48b920d3770ff4aacb",
        "files": ["data/test-00000-of-00001.parquet"],
        "kind": "question",
    },
    "coding": {
        "commit": "a958549fdd8aa57be0a3fafe7b205ffc160ed5f4",
        "files": ["data/test-00000-of-00001.parquet"],
        "kind": "question",
    },
    "language": {
        "commit": "3ada32a2e53d5e04e57fa503384cb85ce9116c40",
        "files": ["data/test-00000-of-00001.parquet"],
        "kind": "question",
    },
    "data_analysis": {
        "commit": "31b9661ff678df9958e2f7fa228427f4c858c1a1",
        "files": ["data/test-00000-of-00001.parquet"],
        "kind": "question",
    },
    "instruction_following": {
        "commit": "0868379c4b5cf62aeacaf8be4f08fced815c81bb",
        "files": ["data/test-00000-of-00001.parquet"],
        "kind": "question",
    },
}

QUESTION_COLUMNS = ["question_id", "category", "task", "turns"]
JUDGMENT_COLUMNS = [
    "question_id",
    "task",
    "model",
    "score",
    "turn",
    "tstamp",
    "category",
]
PUBLIC_CATEGORIES = [
    "coding",
    "data_analysis",
    "instruction_following",
    "language",
    "math",
    "reasoning",
]

# These descriptions are grounded in the pinned official scorer source.
SCORE_DEFINITIONS = {
    "LCB_generation": "binary: all public/private code tests pass",
    "coding_completion": "binary: all public/private code tests pass",
    "typos": "binary: corrected reference text is present",
    "connections": "fraction of exact four-item groups recovered",
    "plot_unscrambling": "1 - normalized sentence-order edit distance",
    "paraphrase": "0.5 * (all constraints pass + fraction of constraints passed)",
    "story_generation": "0.5 * (all constraints pass + fraction of constraints passed)",
}
FULL_SUCCESS_TASKS = set(SCORE_DEFINITIONS)


class AuditError(RuntimeError):
    """Expected audit failure with an actionable message."""


def run_git(args: list[str], cwd: Path | None = None) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=cwd,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise AuditError("git is required but was not found on PATH") from exc
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.strip() or exc.stdout.strip()
        raise AuditError(f"git {' '.join(args)} failed: {detail}") from exc
    return result.stdout.strip()


def ensure_repo(url: str, path: Path, commit: str, offline: bool) -> None:
    if not (path / ".git").is_dir():
        if offline:
            raise AuditError(f"Offline cache is missing repository: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        run_git(["clone", "--filter=blob:none", "--no-checkout", url, str(path)])
    try:
        run_git(["cat-file", "-e", f"{commit}^{{commit}}"], cwd=path)
    except AuditError:
        if offline:
            raise
        run_git(["fetch", "origin", commit], cwd=path)
    run_git(["checkout", "--detach", commit], cwd=path)


def hf_url(dataset: str, commit: str, relative_path: str) -> str:
    return (
        f"https://huggingface.co/datasets/livebench/{dataset}/resolve/"
        f"{commit}/{relative_path}"
    )


def json_safe(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise AuditError(f"Invalid cache JSON at {path}:{line_number}") from exc
    return rows


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(json_safe(row), ensure_ascii=False) + "\n")
    os.replace(temp, path)


def is_parquet(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size < 8:
        return False
    with path.open("rb") as handle:
        return handle.read(4) == b"PAR1"


def parquet_projection(
    *,
    dataset: str,
    commit: str,
    relative_path: str,
    repo_path: Path,
    requested_columns: list[str],
    projection_cache: Path,
    offline: bool,
) -> tuple[list[dict[str, Any]], list[str], str]:
    if projection_cache.is_file():
        rows = read_jsonl(projection_cache)
        names = sorted({key for row in rows for key in row})
        return rows, names, "projection_cache"

    local_path = repo_path / relative_path
    source: Any = local_path
    opened = None
    source_kind = "local_parquet"
    if not is_parquet(local_path):
        if offline:
            raise AuditError(
                f"Offline cache lacks projected data and a materialized Parquet file: {local_path}"
            )
        url = hf_url(dataset, commit, relative_path)
        try:
            opened = fsspec.open(url, "rb", block_size=5 * 1024 * 1024).open()
        except Exception as exc:
            raise AuditError(f"Could not open official dataset URL {url}: {exc}") from exc
        source = opened
        source_kind = "official_hf_http_range"

    try:
        parquet_file = pq.ParquetFile(source)
        schema_names = parquet_file.schema_arrow.names
        columns = [column for column in requested_columns if column in schema_names]
        required = {"question_id"}
        if dataset == "model_judgment":
            required |= {"task", "model", "score", "turn", "category"}
        elif "turns" not in schema_names:
            required.add("turns")
        missing = required - set(schema_names)
        if missing:
            raise AuditError(
                f"{dataset}/{relative_path} is missing required columns: {sorted(missing)}"
            )
        rows = parquet_file.read(columns=columns).to_pylist()
    except AuditError:
        raise
    except Exception as exc:
        raise AuditError(f"Could not read {dataset}/{relative_path}: {exc}") from exc
    finally:
        if opened is not None:
            opened.close()

    write_jsonl(projection_cache, rows)
    return rows, schema_names, source_kind


def lfs_metadata(repo: Path, commit: str, relative_path: str) -> dict[str, Any]:
    try:
        pointer = run_git(["show", f"{commit}:{relative_path}"], cwd=repo)
    except AuditError:
        return {}
    oid_match = re.search(r"oid sha256:([0-9a-f]{64})", pointer)
    size_match = re.search(r"size (\d+)", pointer)
    return {
        "lfs_sha256": oid_match.group(1) if oid_match else None,
        "lfs_size_bytes": int(size_match.group(1)) if size_match else None,
    }


def normalize_question(row: dict[str, Any], dataset: str) -> dict[str, Any]:
    task = row.get("task")
    category = row.get("category")
    # Early language snapshots stored task in category and had no task field.
    if not task and dataset == "language":
        task = category
        category = "language"
    return {
        "question_id": row.get("question_id"),
        "category": category or dataset,
        "task": task,
        "turns": row.get("turns"),
        "question_source_dataset": f"livebench/{dataset}",
    }


def scan_history_for_missing_questions(
    *,
    dataset: str,
    repo: Path,
    relative_path: str,
    target_ids: set[str],
    cache_dir: Path,
    offline: bool,
) -> tuple[list[dict[str, Any]], list[str]]:
    recovered: dict[str, dict[str, Any]] = {}
    scanned: list[str] = []
    if not target_ids:
        return [], scanned
    commits = run_git(["rev-list", "--all", "--", relative_path], cwd=repo).splitlines()
    pinned = HF_DATASETS[dataset]["commit"]
    for commit in commits:
        if commit == pinned:
            continue
        scanned.append(commit)
        cache = cache_dir / "projections" / f"{dataset}-{commit[:12]}-history.jsonl"
        try:
            rows, _, _ = parquet_projection(
                dataset=dataset,
                commit=commit,
                relative_path=relative_path,
                repo_path=repo,
                requested_columns=QUESTION_COLUMNS,
                projection_cache=cache,
                offline=offline,
            )
        except AuditError:
            # Historical revisions can contain a deleted or transitional file.
            continue
        for raw in rows:
            row = normalize_question(raw, dataset)
            if row["question_id"] in target_ids and row["question_id"] not in recovered:
                row["question_source_commit"] = commit
                row["question_source_scope"] = "historical"
                recovered[row["question_id"]] = row
        if target_ids <= recovered.keys():
            break
    return list(recovered.values()), scanned


def stable_row_tuple(row: dict[str, Any]) -> tuple[str, ...]:
    return tuple(
        json.dumps(json_safe(row.get(key)), ensure_ascii=False, sort_keys=True)
        for key in sorted(row)
    )


def mean(values: Iterable[float]) -> float | None:
    values_list = list(values)
    return statistics.fmean(values_list) if values_list else None


def write_csv(path: Path, fieldnames: list[str], rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temp, path)


def choose_anchors(model_rows: list[dict[str, Any]], qsets: dict[str, set[str]]) -> dict[str, Any]:
    max_coverage = max(row["joined_prompt_question_count"] for row in model_rows)
    coverage_floor = math.ceil(max_coverage * 0.99)
    eligible = [
        row
        for row in model_rows
        if row["joined_prompt_question_count"] >= coverage_floor
        and row["coverage_category_count"] >= 2
        and row["joined_average_score"] != ""
    ]
    if len(eligible) < 5:
        raise AuditError(f"Only {len(eligible)} models satisfy anchor eligibility")

    low = min(float(row["joined_average_score"]) for row in eligible)
    high = max(float(row["joined_average_score"]) for row in eligible)
    targets = [low + index * (high - low) / 4 for index in range(5)]
    selected: list[dict[str, Any]] = []
    for target in targets:
        remaining = [row for row in eligible if row not in selected]

        def rank(row: dict[str, Any]) -> tuple[Any, ...]:
            overlaps = [len(qsets[row["model"]] & qsets[item["model"]]) for item in selected]
            minimum_overlap = min(overlaps) if overlaps else row["joined_prompt_question_count"]
            return (
                abs(float(row["joined_average_score"]) - target),
                -minimum_overlap,
                -row["joined_prompt_question_count"],
                row["model"],
            )

        selected.append(min(remaining, key=rank))
    selected.sort(key=lambda row: float(row["joined_average_score"]))
    common = set.intersection(*(qsets[row["model"]] for row in selected))
    return {
        "coverage_floor": coverage_floor,
        "eligible_model_count": len(eligible),
        "score_targets": targets,
        "common_joined_question_count": len(common),
        "models": selected,
    }


def render_anchor_markdown(anchor_result: dict[str, Any]) -> str:
    models = anchor_result["models"]
    lines = [
        "# 第一批锚点模型建议",
        "",
        "## 结论",
        "",
        (
            f"推荐以下 {len(models)} 个模型。它们均至少覆盖两个任务大类；在可连接题目中，"
            f"五者共同覆盖 {anchor_result['common_joined_question_count']} 题。选择不是硬编码名单："
            "脚本先保留达到最高可连接覆盖率 99% 的模型，再在该集合的平均分区间上取五个"
            "等距能力目标，并优先选择与已选模型重叠更高者。"
        ),
        "",
        "| 模型 | 可连接题目 | 大类 | task | 平均分 | 完全成功率 | 入选原因 |",
        "|---|---:|---:|---:|---:|---:|---|",
    ]
    for index, row in enumerate(models, 1):
        level = ["低位", "中低位", "中位", "中高位", "高位"][index - 1]
        lines.append(
            f"| `{row['model']}` | {row['joined_prompt_question_count']} | "
            f"{row['coverage_category_count']} | {row['coverage_task_count']} | "
            f"{float(row['joined_average_score']):.4f} | "
            f"{float(row['joined_full_success_rate']):.4f} | "
            f"接近可用模型分布的{level}能力目标，且题目重叠满足门槛。 |"
        )
    lines += [
        "",
        "## 使用限制",
        "",
        "- 平均分混合了二元与部分得分 task，只用于初步分层，不是最终质量曲线。",
        "- 当前公开 judgment 只覆盖 coding、language、instruction_following 三个大类。",
        "- 建议 RouteLLM 前在共同题集上按 task 分层，并分别比较原始分数与 `score == 1`。",
        "- 同一模型同一题的重复 judgment 已按最新 `tstamp` 用于覆盖统计；冲突仍保留在审计结论中。",
        "",
    ]
    return "\n".join(lines)


def audit(args: argparse.Namespace) -> dict[str, Any]:
    cache_dir = args.cache_dir.resolve()
    output_dir = args.output_dir.resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    code_repo = cache_dir / "livebench-repo"
    ensure_repo(LIVEBENCH_CODE["url"], code_repo, LIVEBENCH_CODE["commit"], args.offline)

    source_manifest: dict[str, Any] = {
        "livebench_code": {**LIVEBENCH_CODE},
        "datasets": {},
    }
    all_questions: list[dict[str, Any]] = []
    judgments: list[dict[str, Any]] = []
    dataset_repos: dict[str, Path] = {}

    for dataset, config in HF_DATASETS.items():
        repo = cache_dir / dataset
        dataset_repos[dataset] = repo
        url = f"https://huggingface.co/datasets/livebench/{dataset}"
        ensure_repo(url, repo, config["commit"], args.offline)
        manifest_files = []
        for relative_path in config["files"]:
            cache_name = (
                f"{dataset}-{config['commit'][:12]}-"
                f"{Path(relative_path).stem}.jsonl"
            )
            rows, schema_names, source_kind = parquet_projection(
                dataset=dataset,
                commit=config["commit"],
                relative_path=relative_path,
                repo_path=repo,
                requested_columns=(
                    JUDGMENT_COLUMNS if config["kind"] == "judgment" else QUESTION_COLUMNS
                ),
                projection_cache=cache_dir / "projections" / cache_name,
                offline=args.offline,
            )
            file_info = {
                "path": relative_path,
                "schema_columns": schema_names,
                "projected_row_count": len(rows),
                "read_via": source_kind,
                **lfs_metadata(repo, config["commit"], relative_path),
            }
            manifest_files.append(file_info)
            if config["kind"] == "judgment":
                judgments.extend(rows)
            else:
                for raw in rows:
                    row = normalize_question(raw, dataset)
                    row["question_source_commit"] = config["commit"]
                    row["question_source_scope"] = "current_snapshot"
                    all_questions.append(row)
        source_manifest["datasets"][dataset] = {
            "url": url,
            "commit": config["commit"],
            "files": manifest_files,
        }

    if not judgments:
        raise AuditError("No model judgments were loaded")

    question_ids = [row.get("question_id") for row in all_questions]
    question_id_counts = Counter(question_ids)
    duplicate_question_ids = {key: value for key, value in question_id_counts.items() if value > 1}
    if duplicate_question_ids:
        raise AuditError(f"Official question snapshot has duplicate question_id values: {len(duplicate_question_ids)}")
    question_map = {row["question_id"]: row for row in all_questions if row.get("question_id")}

    judged_ids = {row.get("question_id") for row in judgments if row.get("question_id")}
    unmatched_ids = judged_ids - question_map.keys()
    history_audit: dict[str, Any] = {}
    if unmatched_ids and not args.skip_history:
        by_category: dict[str, set[str]] = defaultdict(set)
        for row in judgments:
            if row.get("question_id") in unmatched_ids:
                by_category[row.get("category")].add(row["question_id"])
        for dataset, targets in sorted(by_category.items()):
            if dataset not in dataset_repos or dataset == "model_judgment":
                continue
            relative_path = HF_DATASETS[dataset]["files"][0]
            recovered, commits = scan_history_for_missing_questions(
                dataset=dataset,
                repo=dataset_repos[dataset],
                relative_path=relative_path,
                target_ids=targets,
                cache_dir=cache_dir,
                offline=args.offline,
            )
            for row in recovered:
                question_map[row["question_id"]] = row
            history_audit[dataset] = {
                "target_question_count": len(targets),
                "commits_scanned": commits,
                "recovered_question_count": len(recovered),
            }

    # Profile and deterministically resolve repeat judgments for analysis only.
    exact_duplicates = len(judgments) - len({stable_row_tuple(row) for row in judgments})
    by_key: dict[tuple[Any, Any, Any], list[dict[str, Any]]] = defaultdict(list)
    for row in judgments:
        by_key[(row.get("model"), row.get("question_id"), row.get("turn"))].append(row)
    duplicate_groups = {key: rows for key, rows in by_key.items() if len(rows) > 1}
    score_conflict_groups = {
        key: rows for key, rows in duplicate_groups.items() if len({row.get("score") for row in rows}) > 1
    }
    latest: list[dict[str, Any]] = []
    for rows in by_key.values():
        latest.append(max(rows, key=lambda row: (row.get("tstamp") or float("-inf"))))

    current_question_tasks: dict[tuple[str, str], set[str]] = defaultdict(set)
    for row in all_questions:
        current_question_tasks[(row.get("category"), row.get("task"))].add(row["question_id"])
    latest_by_task: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    raw_by_task: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in judgments:
        raw_by_task[(row.get("category"), row.get("task"))].append(row)
    for row in latest:
        latest_by_task[(row.get("category"), row.get("task"))].append(row)

    task_keys = sorted(set(current_question_tasks) | set(raw_by_task))
    task_rows: list[dict[str, Any]] = []
    for category, task in task_keys:
        raw_rows = raw_by_task.get((category, task), [])
        dedup_rows = latest_by_task.get((category, task), [])
        scores = [float(row["score"]) for row in dedup_rows if row.get("score") is not None]
        unique_scores = sorted(set(scores))
        judged_task_ids = {row["question_id"] for row in dedup_rows}
        joined_task_ids = judged_task_ids & question_map.keys()
        binary = bool(scores) and set(unique_scores) <= {0.0, 1.0}
        if not scores:
            suitability = "not_evaluable_no_judgments"
        elif binary:
            suitability = "native_binary"
        elif task in FULL_SUCCESS_TASKS:
            suitability = "safe_only_as_full_success_score_eq_1"
        else:
            suitability = "requires_task_specific_review"
        task_rows.append(
            {
                "category": category,
                "task": task,
                "official_current_question_count": len(current_question_tasks.get((category, task), set())),
                "judged_question_count": len(judged_task_ids),
                "joined_prompt_question_count": len(joined_task_ids),
                "missing_prompt_question_count": len(judged_task_ids - question_map.keys()),
                "raw_judgment_count": len(raw_rows),
                "deduplicated_judgment_count": len(dedup_rows),
                "model_count": len({row["model"] for row in dedup_rows}),
                "score_min": min(scores) if scores else "",
                "score_max": max(scores) if scores else "",
                "unique_score_count": len(unique_scores),
                "partial_credit_present": bool(scores) and not binary,
                "score_definition": SCORE_DEFINITIONS.get(task, "not present in public judgment snapshot"),
                "pass_fail_suitability": suitability,
            }
        )

    raw_model_counts = Counter(row["model"] for row in judgments)
    by_model: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in latest:
        by_model[row["model"]].append(row)
    judgment_universe = {row["question_id"] for row in latest}
    model_rows: list[dict[str, Any]] = []
    model_all_qsets: dict[str, set[str]] = {}
    model_joined_qsets: dict[str, set[str]] = {}
    for model, rows in sorted(by_model.items()):
        qset = {row["question_id"] for row in rows}
        joined_rows = [row for row in rows if row["question_id"] in question_map]
        joined_qset = {row["question_id"] for row in joined_rows}
        model_all_qsets[model] = qset
        model_joined_qsets[model] = joined_qset
        categories = {row["category"] for row in rows}
        tasks = {row["task"] for row in rows}
        missing_rate = (len(judgment_universe) - len(qset)) / len(judgment_universe)
        model_row: dict[str, Any] = {
            "model": model,
            "coverage_question_count": len(qset),
            "joined_prompt_question_count": len(joined_qset),
            "coverage_category_count": len(categories),
            "coverage_task_count": len(tasks),
            "raw_judgment_count": raw_model_counts[model],
            "deduplicated_judgment_count": len(rows),
            "average_score": mean(float(row["score"]) for row in rows),
            "joined_average_score": mean(float(row["score"]) for row in joined_rows) or "",
            "full_success_rate": mean(1.0 if row["score"] == 1 else 0.0 for row in rows),
            "joined_full_success_rate": (
                mean(1.0 if row["score"] == 1 else 0.0 for row in joined_rows) or ""
            ),
            "missing_question_count": len(judgment_universe) - len(qset),
            "missing_rate": missing_rate,
            "has_large_missing": missing_rate > 0.20,
        }
        for category in PUBLIC_CATEGORIES:
            model_row[f"{category}_question_count"] = len(
                {row["question_id"] for row in rows if row["category"] == category}
            )
        model_rows.append(model_row)

    overlap_rows: list[dict[str, Any]] = []
    for model_a, model_b in itertools.combinations(sorted(by_model), 2):
        all_a, all_b = model_all_qsets[model_a], model_all_qsets[model_b]
        joined_a, joined_b = model_joined_qsets[model_a], model_joined_qsets[model_b]
        union = all_a | all_b
        overlap_rows.append(
            {
                "model_a": model_a,
                "model_b": model_b,
                "overlap_question_count": len(all_a & all_b),
                "joined_prompt_overlap_count": len(joined_a & joined_b),
                "union_question_count": len(union),
                "jaccard_overlap": len(all_a & all_b) / len(union) if union else 0.0,
            }
        )

    anchors = choose_anchors(model_rows, model_joined_qsets)

    joined_latest = [row for row in latest if row["question_id"] in question_map]
    sample_rows: list[dict[str, Any]] = []
    for row in sorted(joined_latest, key=lambda item: (item["question_id"], item["model"]))[:100]:
        question = question_map[row["question_id"]]
        turns = question.get("turns") or []
        turn_index = int(row["turn"]) - 1 if row.get("turn") else 0
        prompt = turns[turn_index] if 0 <= turn_index < len(turns) else ""
        sample_rows.append(
            {
                "question_id": row["question_id"],
                "prompt": prompt,
                "category": row["category"],
                "task": row["task"],
                "model": row["model"],
                "score": row["score"],
                "turn": row["turn"],
                "question_source": question["question_source_dataset"],
                "question_source_commit": question["question_source_commit"],
                "judgment_source": "livebench/model_judgment",
                "judgment_source_commit": HF_DATASETS["model_judgment"]["commit"],
                "judgment_tstamp": row.get("tstamp"),
            }
        )

    category_summary = []
    for category in PUBLIC_CATEGORIES:
        category_tasks = [row for row in task_rows if row["category"] == category]
        raw_rows = [row for row in judgments if row["category"] == category]
        scores = [float(row["score"]) for row in raw_rows if row.get("score") is not None]
        category_summary.append(
            {
                "category": category,
                "official_current_question_count": sum(
                    row["official_current_question_count"] for row in category_tasks
                ),
                "judged_question_count": len({row["question_id"] for row in raw_rows}),
                "raw_judgment_count": len(raw_rows),
                "model_count": len({row["model"] for row in raw_rows}),
                "score_min": min(scores) if scores else None,
                "score_max": max(scores) if scores else None,
                "task_count": len(category_tasks),
                "pass_fail_summary": (
                    "score_eq_1_is_full_success_but_partial_credit_exists"
                    if any(row["partial_credit_present"] for row in category_tasks)
                    else ("native_binary" if scores else "no_public_judgments")
                ),
            }
        )

    missing_question_prompt_count = sum(
        not row.get("turns") or not any(str(turn).strip() for turn in row.get("turns") or [])
        for row in all_questions
    )
    missing_judged_prompt_ids = judged_ids - question_map.keys()
    missing_judgment_fields = {
        field: sum(row.get(field) is None or row.get(field) == "" for row in judgments)
        for field in JUDGMENT_COLUMNS
    }
    task_or_category_mismatch = sum(
        row["question_id"] in question_map
        and (
            row["task"] != question_map[row["question_id"]]["task"]
            or row["category"] != question_map[row["question_id"]]["category"]
        )
        for row in judgments
    )

    summary: dict[str, Any] = {
        "audit_generated_at": datetime.now(timezone.utc).isoformat(),
        "scope": "Phase 1A public LiveBench data audit; no model inference",
        "sources": source_manifest,
        "counts": {
            "official_current_question_rows": len(all_questions),
            "official_current_distinct_questions": len(question_map) - sum(
                item["recovered_question_count"] for item in history_audit.values()
            ),
            "historical_questions_recovered": sum(
                item["recovered_question_count"] for item in history_audit.values()
            ),
            "judged_distinct_questions": len(judged_ids),
            "joined_distinct_questions": len(judged_ids & question_map.keys()),
            "unjoined_judged_questions": len(missing_judged_prompt_ids),
            "raw_judgments": len(judgments),
            "deduplicated_latest_judgments": len(latest),
            "joined_raw_judgments": sum(row["question_id"] in question_map for row in judgments),
            "joined_deduplicated_judgments": len(joined_latest),
            "models": len(by_model),
            "public_question_categories": len({row["category"] for row in all_questions}),
            "public_question_tasks": len({row["task"] for row in all_questions}),
            "judgment_categories": len({row["category"] for row in judgments}),
            "judgment_tasks": len({row["task"] for row in judgments}),
        },
        "join_quality": {
            "question_id_join_possible": bool(judged_ids & question_map.keys()),
            "distinct_question_join_rate": len(judged_ids & question_map.keys()) / len(judged_ids),
            "raw_judgment_join_rate": (
                sum(row["question_id"] in question_map for row in judgments) / len(judgments)
            ),
            "task_or_category_mismatch_rows_among_joinable": task_or_category_mismatch,
            "history_scan": history_audit,
        },
        "data_quality": {
            "duplicate_official_question_ids": len(duplicate_question_ids),
            "exact_duplicate_judgment_rows": exact_duplicates,
            "duplicate_model_question_turn_groups": len(duplicate_groups),
            "extra_duplicate_model_question_turn_rows": sum(
                len(rows) - 1 for rows in duplicate_groups.values()
            ),
            "duplicate_groups_with_score_conflict": len(score_conflict_groups),
            "missing_prompt_in_official_current_questions": missing_question_prompt_count,
            "judged_question_ids_missing_official_prompt": len(missing_judged_prompt_ids),
            "raw_judgment_rows_missing_official_prompt": sum(
                row["question_id"] in missing_judged_prompt_ids for row in judgments
            ),
            "missing_judgment_fields": missing_judgment_fields,
            "turn_distribution": dict(sorted(Counter(row.get("turn") for row in judgments).items())),
            "latest_tstamp_used_for_duplicate_resolution": True,
        },
        "score_semantics": {
            "global_range": [
                min(float(row["score"]) for row in judgments),
                max(float(row["score"]) for row in judgments),
            ],
            "definitions_are_consistent_across_tasks": False,
            "full_success_conversion": "pass = (score == 1.0)",
            "conversion_assessment": (
                "Safe as an exact/full-success indicator for the seven published tasks, "
                "but it discards partial credit and is not equivalent to score > 0."
            ),
            "turn_filter_recommendation": (
                "Filter turn == 1 for this snapshot; all rows are turn 1. Keep the filter explicit "
                "to prevent future multi-turn grain changes."
            ),
        },
        "category_summary": category_summary,
        "recommended_anchor_models": [
            {
                "model": row["model"],
                "joined_prompt_question_count": row["joined_prompt_question_count"],
                "category_count": row["coverage_category_count"],
                "task_count": row["coverage_task_count"],
                "joined_average_score": row["joined_average_score"],
                "joined_full_success_rate": row["joined_full_success_rate"],
            }
            for row in anchors["models"]
        ],
        "anchor_selection": {
            key: value for key, value in anchors.items() if key != "models"
        },
        "route_llm_readiness": {
            "ready_for_final_quality_curve": False,
            "usable_for_initial_anchor_experiments": True,
            "blocking_or_required_followups": [
                "Choose whether to exclude the 100 judged questions whose official prompt is unavailable.",
                "Resolve or exclude the 64 duplicate model/question/turn groups with conflicting scores.",
                "Decide whether RouteLLM target is exact success (score == 1) or task-specific partial credit.",
                "Stratify by task/category; raw scores are not semantically identical across tasks.",
                "Obtain official judgments for reasoning, math, and data_analysis if those categories are required.",
                "Freeze the pinned snapshot and model-name normalization policy before training/evaluation.",
            ],
        },
    }

    model_fields = [
        "model",
        "coverage_question_count",
        "joined_prompt_question_count",
        "coverage_category_count",
        "coverage_task_count",
        *[f"{category}_question_count" for category in PUBLIC_CATEGORIES],
        "raw_judgment_count",
        "deduplicated_judgment_count",
        "average_score",
        "joined_average_score",
        "full_success_rate",
        "joined_full_success_rate",
        "missing_question_count",
        "missing_rate",
        "has_large_missing",
    ]
    task_fields = list(task_rows[0].keys())
    overlap_fields = list(overlap_rows[0].keys())
    sample_fields = list(sample_rows[0].keys())
    write_csv(output_dir / "model_coverage.csv", model_fields, model_rows)
    write_csv(output_dir / "task_coverage.csv", task_fields, task_rows)
    write_csv(output_dir / "question_model_overlap.csv", overlap_fields, overlap_rows)
    write_csv(output_dir / "sample_joined_rows.csv", sample_fields, sample_rows)
    (output_dir / "audit_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "recommended_anchor_models.md").write_text(
        render_anchor_markdown(anchors), encoding="utf-8"
    )
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit pinned official LiveBench questions and model judgments."
    )
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Use only already cached repositories/projections; never access the network.",
    )
    parser.add_argument(
        "--skip-history",
        action="store_true",
        help="Do not scan official dataset history for judged question IDs missing current prompts.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        summary = audit(args)
    except (AuditError, OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    counts = summary["counts"]
    anchors = [item["model"] for item in summary["recommended_anchor_models"]]
    print(
        "Audit complete: "
        f"questions={counts['official_current_question_rows']}, "
        f"judged_questions={counts['judged_distinct_questions']}, "
        f"models={counts['models']}, raw_judgments={counts['raw_judgments']}"
    )
    print("Recommended anchors: " + ", ".join(anchors))
    print(f"Outputs: {args.output_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
