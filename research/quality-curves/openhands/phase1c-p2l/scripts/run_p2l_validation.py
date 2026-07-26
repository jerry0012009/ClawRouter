#!/usr/bin/env python3
"""Phase 1C: validate official P2L difficulty signals on SWE-bench Verified.

The script performs local CPU-only inference with the pinned official
lmarena-ai/p2l-135m-grk-01112025 model. It never calls a model API, generates an
answer, uses a gold/test patch as input, or trains the model. Raw outputs are cached
per question so a completed run can be reproduced with ``--offline``.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import random
import shutil
import subprocess
import sys
import threading
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psutil
import pyarrow as pa
import pyarrow.parquet as pq
import torch
from huggingface_hub import snapshot_download
from scipy.stats import kruskal, rankdata, spearmanr
from sklearn.metrics import roc_auc_score
from transformers import AutoTokenizer


P2L_REPOSITORY = "https://github.com/lmarena/p2l.git"
P2L_COMMIT = "a905fa5ea94a75fdf157d73e27bd3c63ac1ebeb1"
P2L_MODEL = "lmarena-ai/p2l-135m-grk-01112025"
P2L_MODEL_REVISION = "2b642ae1ce114fb54e468e4c676f122135bcf11b"
P2L_MODEL_SHA256 = "1ac660b56b95e08fdc48523423c23d8c21d50cd65005d079c781e0cdffba4790"
P2L_MODEL_LIST_SHA256 = "7a4e145dbbe841b986d570e5be36fd634f7451f9f0676599cf465cac32601e52"
P2L_TOKENIZER_SHA256 = "1c704200f743419b33efaebdff006385c093916fa0e1907f09e2b665b4c03ccc"
P2L_CONFIG_SHA256 = "56c264c231626d2605d6816cb32efad49afbcfaf3aec97e0a994acd8ffedc2e1"
P2L_PARAMETER_COUNT = 134_591_171
P2L_MODEL_TYPE = "llama"
P2L_HEAD_TYPE = "rk"
P2L_LOSS_TYPE = "bag"
MAX_CONTEXT = 8192
EXPECTED_BETA_DIM = 130
CPU_THREADS = 4
MEMORY_GATE_GIB = 7.0
PREFLIGHT_COUNT = 20

OPENHANDS_DATASET = "OpenHands/openhands-index"
OPENHANDS_REVISION = "v2026.06.30-3015ac6"
OPENHANDS_HF_COMMIT = "94ac78ad8ec547875a0a4ec56e15a644aa5653f6"
OPENHANDS_INSTANCES_SHA256 = "f456e937771bdd45815cacd6458433e0e750be0a2a6bcd5daf91670b151968a5"
SWEBENCH_DATASET = "SWE-bench/SWE-bench_Verified"
SWEBENCH_REVISION = "91aa3ed51b709be6457e12d00300a6a596d4c6a3"
SWEBENCH_SHA256 = "43ed5a3d1d98da36472c1ade65ddd2085d7b4ff694fcaf6a023a07c5c1f32f21"

ROUTELLM_COMMIT = "0b64fdafe049e596a3f5657c219329f24af24198"
ROUTELLM_CHECKPOINT = "routellm/mf_gpt4_augmented"
BOOTSTRAP_SAMPLES = 10_000
RANDOM_SEED = 20260726
BIN_ORDER = ["Easy", "Medium", "Hard"]
OFFICIAL_DIFFICULTY_ORDER = ["<15 min fix", "15 min - 1 hour", "1-4 hours", ">4 hours"]
REPRESENTATIVE_MODELS = [
    "claude-opus-4-8", "GPT-5.5", "Gemini-3.5-Flash", "DeepSeek-V4-Pro",
    "GLM-5.1", "Kimi-K2.6", "MiniMax-M3", "Qwen3-Coder-Next",
]


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def text_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=False)
        handle.write("\n")


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if fields is None:
        fields = []
        seen: set[str] = set()
        for row in rows:
            for field in row:
                if field not in seen:
                    fields.append(field)
                    seen.add(field)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def run_git(arguments: list[str], cwd: Path | None = None) -> str:
    result = subprocess.run(
        ["git", *arguments], cwd=cwd, text=True, check=False,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise RuntimeError(f"git {' '.join(arguments)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def prepare_official_assets(cache: Path, offline: bool) -> tuple[Path, Path]:
    repo = cache / "p2l"
    if not (repo / ".git").exists():
        if offline:
            raise RuntimeError("Offline mode: pinned P2L repository is missing")
        run_git(["clone", P2L_REPOSITORY, str(repo)])
    actual_commit = run_git(["rev-parse", "HEAD"], repo)
    if actual_commit != P2L_COMMIT:
        if offline:
            raise RuntimeError(f"Offline P2L commit mismatch: {actual_commit}")
        run_git(["fetch", "origin", P2L_COMMIT], repo)
        run_git(["checkout", "--detach", P2L_COMMIT], repo)
    if run_git(["rev-parse", "HEAD"], repo) != P2L_COMMIT:
        raise RuntimeError("Unable to freeze official P2L Git commit")

    model_dir = cache / "model"
    required = [
        "model.safetensors", "model_list.json", "config.json", "tokenizer.json",
        "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json",
        "vocab.json", "merges.txt", "training_config.json", "README.md",
    ]
    if not all((model_dir / name).exists() for name in required):
        if offline:
            raise RuntimeError("Offline mode: pinned P2L model snapshot is incomplete")
        snapshot_download(repo_id=P2L_MODEL, revision=P2L_MODEL_REVISION, local_dir=model_dir)
    expected_hashes = {
        "model.safetensors": P2L_MODEL_SHA256,
        "model_list.json": P2L_MODEL_LIST_SHA256,
        "tokenizer.json": P2L_TOKENIZER_SHA256,
        "config.json": P2L_CONFIG_SHA256,
    }
    for name, expected in expected_hashes.items():
        actual = sha256(model_dir / name)
        if actual != expected:
            raise RuntimeError(f"Pinned asset hash mismatch for {name}: {actual}")
    return repo, model_dir


def verify_official_code(repo: Path) -> dict[str, Any]:
    model_text = (repo / "p2l/model.py").read_text(encoding="utf-8")
    eval_text = (repo / "p2l/eval.py").read_text(encoding="utf-8")
    required_model = [
        '@register_head("rk")', "class RKHead", "coefs = self.head(last_hidden_dim)",
        "eta = self.eta_head(last_hidden_dim)", "cls_mask = input_ids == self.cls_token_id",
    ]
    required_eval = [
        'messages = [{"role": "user", "content": inputs}]',
        "formatted = formatted + self.tokenizer.cls_token", "max_length=8192",
        "truncation=True",
    ]
    missing = [x for x in required_model if x not in model_text]
    missing += [x for x in required_eval if x not in eval_text]
    if missing:
        raise RuntimeError(f"Official P2L source contract changed: {missing}")
    return {
        "repository_commit": P2L_COMMIT,
        "model_py_sha256": sha256(repo / "p2l/model.py"),
        "eval_py_sha256": sha256(repo / "p2l/eval.py"),
        "verified_snippets": required_model + required_eval,
    }


def load_verified(phase_dir: Path) -> tuple[list[dict[str, Any]], Path]:
    path = phase_dir.parent / ".cache/swebench-official-raw/data/test-00000-of-00001.parquet"
    if not path.exists() or sha256(path) != SWEBENCH_SHA256:
        raise RuntimeError(f"Pinned SWE-bench Verified input missing or changed: {path}")
    rows = pq.read_table(
        path, columns=["instance_id", "repo", "difficulty", "problem_statement"]
    ).to_pylist()
    if len(rows) != 500 or len({row["instance_id"] for row in rows}) != 500:
        raise RuntimeError("Expected exactly 500 unique SWE-bench Verified questions")
    for field in ["instance_id", "repo", "difficulty", "problem_statement"]:
        if any(row.get(field) in (None, "") for row in rows):
            raise RuntimeError(f"Verified questions contain missing {field}")
    return sorted(rows, key=lambda row: row["instance_id"]), path


def load_openhands(phase_dir: Path) -> tuple[list[dict[str, Any]], Path]:
    path = phase_dir.parent / ".cache/openhands-index-raw/instances.parquet"
    if not path.exists() or sha256(path) != OPENHANDS_INSTANCES_SHA256:
        raise RuntimeError(f"Pinned OpenHands input missing or changed: {path}")
    rows = pq.read_table(path).to_pylist()
    swe = [row for row in rows if row["benchmark"] == "swe-bench"]
    if len(swe) != 17_000 or len({row["id"] for row in swe}) != 34:
        raise RuntimeError("Expected 17,000 SWE-bench outcomes across 34 models")
    keys = [(row["id"], row["instance_id"]) for row in swe]
    if len(set(keys)) != 17_000:
        raise RuntimeError("Duplicate OpenHands model + instance outcome")
    return swe, path


def load_model_list(model_dir: Path) -> list[str]:
    models = json.loads((model_dir / "model_list.json").read_text(encoding="utf-8"))
    if len(models) != EXPECTED_BETA_DIM or len(set(models)) != EXPECTED_BETA_DIM:
        raise RuntimeError(f"Expected {EXPECTED_BETA_DIM} unique P2L model names")
    if models != sorted(models):
        raise RuntimeError("Official model_list.json is not in its documented sorted order")
    return models


def load_tokenizer(model_dir: Path) -> Any:
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
    if tokenizer.model_max_length != MAX_CONTEXT:
        raise RuntimeError(f"Expected tokenizer max length {MAX_CONTEXT}, got {tokenizer.model_max_length}")
    if tokenizer.cls_token_id is None:
        raise RuntimeError("Official tokenizer has no CLS token")
    return tokenizer


def formatted_prompt(tokenizer: Any, prompt: str) -> str:
    messages = [{"role": "user", "content": prompt}]
    rendered = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=False, add_special_tokens=False,
    )
    return rendered + tokenizer.cls_token


def tokenize_prompt(tokenizer: Any, prompt: str) -> tuple[dict[str, torch.Tensor], int, bool]:
    rendered = formatted_prompt(tokenizer, prompt)
    full_ids = tokenizer(rendered, add_special_tokens=True, truncation=False)["input_ids"]
    input_token_count = len(full_ids)
    encoded = tokenizer(
        rendered, return_tensors="pt", max_length=MAX_CONTEXT,
        padding="longest", truncation=True,
    )
    if int((encoded["input_ids"] == tokenizer.cls_token_id).sum()) != 1:
        raise RuntimeError("Official preprocessing did not preserve exactly one CLS token")
    return encoded, input_token_count, input_token_count > MAX_CONTEXT


def load_p2l_model(repo: Path, model_dir: Path, model_count: int) -> tuple[Any, float]:
    sys.path.insert(0, str(repo))
    from p2l.model import get_p2l_model

    tokenizer = load_tokenizer(model_dir)
    model_cls = get_p2l_model(P2L_MODEL_TYPE, P2L_LOSS_TYPE, P2L_HEAD_TYPE)
    started = time.perf_counter()
    model = model_cls.from_pretrained(
        model_dir, CLS_id=tokenizer.cls_token_id, num_models=model_count,
        torch_dtype=torch.float32, low_cpu_mem_usage=True, local_files_only=True,
    )
    model = model.to("cpu")
    model.eval()
    load_seconds = time.perf_counter() - started
    if sum(parameter.numel() for parameter in model.parameters()) != P2L_PARAMETER_COUNT:
        raise RuntimeError("Loaded P2L parameter count does not match frozen model")
    if any(parameter.device.type != "cpu" for parameter in model.parameters()):
        raise RuntimeError("P2L model is not entirely on CPU")
    if any(parameter.dtype != torch.float32 for parameter in model.parameters()):
        raise RuntimeError("P2L model is not entirely FP32")
    return model, load_seconds


class PeakRSS:
    def __init__(self) -> None:
        self.process = psutil.Process()
        self.peak = self.process.memory_info().rss
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._sample, daemon=True)

    def _sample(self) -> None:
        while not self.stop_event.wait(0.02):
            self.peak = max(self.peak, self.process.memory_info().rss)

    def __enter__(self) -> "PeakRSS":
        self.thread.start()
        return self

    def __exit__(self, *_: Any) -> None:
        self.stop_event.set()
        self.thread.join()
        self.peak = max(self.peak, self.process.memory_info().rss)


def infer_one(model: Any, encoded: dict[str, torch.Tensor]) -> tuple[np.ndarray, float, float]:
    started = time.perf_counter()
    with torch.inference_mode():
        output = model(**{key: value.to("cpu") for key, value in encoded.items()})
    elapsed = time.perf_counter() - started
    beta = output.coefs.detach().cpu().float().numpy().reshape(-1)
    eta = float(output.eta.detach().cpu().float().numpy().reshape(-1)[0])
    if beta.shape != (EXPECTED_BETA_DIM,):
        raise RuntimeError(f"Unexpected beta shape {beta.shape}")
    if not np.isfinite(beta).all() or not math.isfinite(eta):
        raise RuntimeError("P2L emitted a non-finite beta or eta")
    return beta.astype(np.float32), eta, elapsed


def cache_paths(cache: Path, instance_id: str, statement_hash: str) -> tuple[Path, Path]:
    safe_id = instance_id.replace("/", "__")
    base = cache / "raw_outputs" / f"{safe_id}__{statement_hash[:16]}"
    return base.with_suffix(".npz"), base.with_suffix(".json")


def save_cached_output(
    cache: Path, question: dict[str, Any], beta: np.ndarray, eta: float,
    token_count: int, truncated: bool, latency_seconds: float,
) -> dict[str, Any]:
    statement_hash = text_hash(question["problem_statement"])
    npz_path, meta_path = cache_paths(cache, question["instance_id"], statement_hash)
    npz_path.parent.mkdir(parents=True, exist_ok=True)
    partial = npz_path.with_suffix(".npz.part")
    with partial.open("wb") as handle:
        np.savez(handle, beta=beta.astype(np.float32), eta=np.float32(eta))
    partial.replace(npz_path)
    metadata = {
        "instance_id": question["instance_id"],
        "problem_statement_hash": statement_hash,
        "input_token_count": token_count,
        "truncated": truncated,
        "beta_dimension": int(beta.size),
        "eta": eta,
        "latency_seconds": latency_seconds,
        "model_revision": P2L_MODEL_REVISION,
        "model_list_revision": P2L_MODEL_LIST_SHA256,
        "output_file": npz_path.name,
        "output_file_sha256": sha256(npz_path),
        "created_at_utc": now_utc(),
    }
    write_json(meta_path, metadata)
    return metadata


def load_cached_output(
    cache: Path, question: dict[str, Any],
) -> tuple[np.ndarray, float, dict[str, Any]] | None:
    statement_hash = text_hash(question["problem_statement"])
    npz_path, meta_path = cache_paths(cache, question["instance_id"], statement_hash)
    if not npz_path.exists() or not meta_path.exists():
        return None
    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    required = {
        "instance_id": question["instance_id"],
        "problem_statement_hash": statement_hash,
        "model_revision": P2L_MODEL_REVISION,
        "model_list_revision": P2L_MODEL_LIST_SHA256,
    }
    if any(metadata.get(key) != value for key, value in required.items()):
        return None
    if sha256(npz_path) != metadata.get("output_file_sha256"):
        raise RuntimeError(f"Cached output checksum mismatch: {npz_path}")
    with np.load(npz_path, allow_pickle=False) as payload:
        beta = payload["beta"].astype(np.float32)
        eta = float(payload["eta"])
    if beta.shape != (EXPECTED_BETA_DIM,) or not np.isfinite(beta).all() or not math.isfinite(eta):
        raise RuntimeError(f"Invalid cached P2L output: {npz_path}")
    return beta, eta, metadata


def run_hardware_preflight(
    questions: list[dict[str, Any]], repo: Path, model_dir: Path,
    cache: Path, output: Path,
) -> dict[str, Any]:
    selected = questions[:PREFLIGHT_COUNT]
    process = psutil.Process()
    idle_available = psutil.virtual_memory().available
    rss_before = process.memory_info().rss
    tokenizer = load_tokenizer(model_dir)
    torch.set_num_threads(CPU_THREADS)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    with PeakRSS() as monitor:
        model, load_seconds = load_p2l_model(repo, model_dir, EXPECTED_BETA_DIM)
        rss_after_load = process.memory_info().rss
        latencies: list[float] = []
        outputs: list[np.ndarray] = []
        total_started = time.perf_counter()
        for question in selected:
            encoded, token_count, truncated = tokenize_prompt(tokenizer, question["problem_statement"])
            beta, eta, latency = infer_one(model, encoded)
            save_cached_output(cache, question, beta, eta, token_count, truncated, latency)
            outputs.append(beta)
            latencies.append(latency)
        total_seconds = time.perf_counter() - total_started
        encoded, _, _ = tokenize_prompt(tokenizer, selected[0]["problem_statement"])
        repeat_a, repeat_eta_a, _ = infer_one(model, encoded)
        repeat_b, repeat_eta_b, _ = infer_one(model, encoded)
    peak_gib = monitor.peak / 2**30
    repeat_max_abs = float(np.max(np.abs(repeat_a - repeat_b)))
    repeat_eta_abs = abs(repeat_eta_a - repeat_eta_b)
    benchmark = {
        "status": "passed" if peak_gib <= MEMORY_GATE_GIB else "failed_memory_gate",
        "question_selection": "first 20 questions by stable instance_id sort; outcomes not loaded",
        "question_ids": [row["instance_id"] for row in selected],
        "cpu_threads": CPU_THREADS,
        "batch_size": 1,
        "torch_dtype": "float32",
        "device": "cpu",
        "model_load_seconds": load_seconds,
        "idle_available_memory_gib": idle_available / 2**30,
        "rss_before_load_gib": rss_before / 2**30,
        "rss_after_load_gib": rss_after_load / 2**30,
        "peak_rss_gib": peak_gib,
        "memory_gate_gib": MEMORY_GATE_GIB,
        "latency_seconds": {
            "mean": float(np.mean(latencies)),
            "median": float(np.median(latencies)),
            "p50": float(np.percentile(latencies, 50)),
            "p95": float(np.percentile(latencies, 95)),
            "minimum": float(min(latencies)),
            "maximum": float(max(latencies)),
        },
        "twenty_question_inference_seconds": total_seconds,
        "output_dimension": EXPECTED_BETA_DIM,
        "finite_output_count": int(sum(np.isfinite(value).all() for value in outputs)),
        "repeat_consistent": repeat_max_abs == 0.0 and repeat_eta_abs == 0.0,
        "repeat_beta_max_abs_difference": repeat_max_abs,
        "repeat_eta_abs_difference": repeat_eta_abs,
        "created_at_utc": now_utc(),
    }
    write_json(output / "hardware_benchmark.json", benchmark)
    if benchmark["status"] != "passed":
        raise RuntimeError(f"CPU preflight peak RSS {peak_gib:.3f} GiB exceeded 7 GiB gate")
    if benchmark["finite_output_count"] != PREFLIGHT_COUNT or not benchmark["repeat_consistent"]:
        raise RuntimeError("CPU preflight output validity or repeatability check failed")
    return benchmark


def run_inference(
    questions: list[dict[str, Any]], repo: Path, model_dir: Path,
    cache: Path, offline: bool,
) -> list[dict[str, Any]]:
    missing = [question for question in questions if load_cached_output(cache, question) is None]
    if missing and offline:
        raise RuntimeError(f"Offline mode: {len(missing)} P2L outputs are missing")
    model = None
    tokenizer = load_tokenizer(model_dir)
    if missing:
        torch.set_num_threads(CPU_THREADS)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass
        model, _ = load_p2l_model(repo, model_dir, EXPECTED_BETA_DIM)
    for index, question in enumerate(missing, start=1):
        encoded, token_count, truncated = tokenize_prompt(tokenizer, question["problem_statement"])
        beta, eta, latency = infer_one(model, encoded)
        save_cached_output(cache, question, beta, eta, token_count, truncated, latency)
        if index % 25 == 0 or index == len(missing):
            print(f"Inferred {index}/{len(missing)} missing questions", file=sys.stderr)
    records = []
    for question in questions:
        cached = load_cached_output(cache, question)
        if cached is None:
            raise RuntimeError(f"P2L output missing after inference: {question['instance_id']}")
        beta, eta, metadata = cached
        records.append({
            "instance_id": question["instance_id"],
            "repo": question["repo"],
            "official_difficulty": question["difficulty"],
            "problem_statement_hash": text_hash(question["problem_statement"]),
            "input_token_count": int(metadata["input_token_count"]),
            "truncated": bool(metadata["truncated"]),
            "beta": beta,
            "eta": eta,
            "model_list_revision": metadata["model_list_revision"],
            "latency_seconds": float(metadata["latency_seconds"]),
            "output_file_sha256": metadata["output_file_sha256"],
            "created_at_utc": metadata["created_at_utc"],
        })
    if len(records) != 500 or len({row["instance_id"] for row in records}) != 500:
        raise RuntimeError("500 questions do not each have exactly one P2L output")
    return records


def score_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    scored = []
    for row in records:
        beta = row["beta"]
        scored.append({
            **row,
            "p2l_difficulty_primary": float(np.mean(beta <= 0.0)),
            "p2l_difficulty_neg_median": float(-np.median(beta)),
            "p2l_difficulty_neg_mean": float(-np.mean(beta)),
            "p2l_beta_spread": float(np.percentile(beta, 90) - np.percentile(beta, 10)),
            "beta_min": float(np.min(beta)),
            "beta_p10": float(np.percentile(beta, 10)),
            "beta_median": float(np.median(beta)),
            "beta_mean": float(np.mean(beta)),
            "beta_p90": float(np.percentile(beta, 90)),
            "beta_max": float(np.max(beta)),
        })
    ordered = sorted(scored, key=lambda row: (row["p2l_difficulty_primary"], row["instance_id"]))
    for rank, row in enumerate(ordered, start=1):
        row["p2l_rank"] = rank
        row["p2l_percentile"] = (rank - 1) / (len(ordered) - 1)
        row["p2l_tertile"] = "Easy" if rank <= 167 else "Medium" if rank <= 333 else "Hard"
    return sorted(ordered, key=lambda row: row["instance_id"])


def safe_spearman(x: Iterable[float], y: Iterable[float]) -> float:
    result = spearmanr(np.asarray(list(x), dtype=float), np.asarray(list(y), dtype=float)).statistic
    return float(result) if math.isfinite(float(result)) else float("nan")


def bootstrap_spearman(
    x: np.ndarray, y: np.ndarray, seed: int = RANDOM_SEED,
) -> tuple[float, float, int]:
    rng = np.random.default_rng(seed)
    values = []
    for _ in range(BOOTSTRAP_SAMPLES):
        indices = rng.integers(0, len(x), size=len(x))
        value = safe_spearman(x[indices], y[indices])
        if math.isfinite(value):
            values.append(value)
    if not values:
        return float("nan"), float("nan"), 0
    low, high = np.quantile(values, [0.025, 0.975])
    return float(low), float(high), len(values)


def bootstrap_paired_spearman_difference(
    p2l: np.ndarray, routellm: np.ndarray, failures: np.ndarray,
) -> tuple[float, float, float, int]:
    observed = safe_spearman(p2l, failures) - safe_spearman(routellm, failures)
    rng = np.random.default_rng(RANDOM_SEED + 11)
    values = []
    for _ in range(BOOTSTRAP_SAMPLES):
        indices = rng.integers(0, len(p2l), size=len(p2l))
        p2l_rho = safe_spearman(p2l[indices], failures[indices])
        route_rho = safe_spearman(routellm[indices], failures[indices])
        if math.isfinite(p2l_rho) and math.isfinite(route_rho):
            values.append(p2l_rho - route_rho)
    low, high = np.quantile(values, [0.025, 0.975])
    return observed, float(low), float(high), len(values)


def wilson_interval(successes: int, n: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if n == 0:
        return float("nan"), float("nan")
    p = successes / n
    denominator = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denominator
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return center - margin, center + margin


def compute_question_difficulty(
    scores: list[dict[str, Any]], outcomes: list[dict[str, Any]], exclude_null: bool,
) -> list[dict[str, Any]]:
    by_question: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for outcome in outcomes:
        by_question[outcome["instance_id"]].append(outcome)
    output = []
    score_fields = [
        "instance_id", "repo", "official_difficulty", "problem_statement_hash",
        "input_token_count", "truncated", "p2l_difficulty_primary",
        "p2l_difficulty_neg_median", "p2l_difficulty_neg_mean", "p2l_beta_spread",
        "p2l_rank", "p2l_percentile", "p2l_tertile",
    ]
    for score in scores:
        rows = by_question[score["instance_id"]]
        if len(rows) != 34:
            raise RuntimeError(f"Question {score['instance_id']} has {len(rows)} outcomes")
        nulls = sum(row["resolved"] is None for row in rows)
        successes = sum(row["resolved"] is True for row in rows)
        denominator = len(rows) - nulls if exclude_null else len(rows)
        output.append({
            **{field: score[field] for field in score_fields},
            "model_result_count": len(rows),
            "valid_result_count": len(rows) - nulls,
            "resolved_null_count": nulls,
            "success_count": successes,
            "failure_count": denominator - successes,
            "empirical_success_rate": successes / denominator,
            "empirical_failure_rate": (denominator - successes) / denominator,
            "analysis_definition": "exclude_null" if exclude_null else "null_as_not_success",
        })
    return output


def compute_model_outputs(
    scores: list[dict[str, Any]], outcomes: list[dict[str, Any]], exclude_null: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    score_by_id = {row["instance_id"]: row for row in scores}
    by_model: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for outcome in outcomes:
        by_model[outcome["language_model"]].append({**outcome, **score_by_id[outcome["instance_id"]]})
    curves = []
    metrics = []
    for model_name in sorted(by_model, key=str.lower):
        rows = by_model[model_name]
        if len(rows) != 500:
            raise RuntimeError(f"Model {model_name} has {len(rows)} outcomes")
        rates: dict[str, float] = {}
        for difficulty_bin in BIN_ORDER:
            group = [row for row in rows if row["p2l_tertile"] == difficulty_bin]
            nulls = sum(row["resolved"] is None for row in group)
            successes = sum(row["resolved"] is True for row in group)
            valid = len(group) - nulls
            denominator = valid if exclude_null else len(group)
            low, high = wilson_interval(successes, denominator)
            rates[difficulty_bin] = successes / denominator
            curves.append({
                "language_model": model_name,
                "difficulty_bin": difficulty_bin,
                "total_question_count": len(group),
                "valid_result_count": valid,
                "resolved_null_count": nulls,
                "success_count": successes,
                "failure_count": denominator - successes,
                "success_rate": rates[difficulty_bin],
                "wilson_95_low": low,
                "wilson_95_high": high,
                "analysis_definition": "exclude_null" if exclude_null else "null_as_not_success",
                "representative_model": model_name in REPRESENTATIVE_MODELS,
            })
        metric_rows = [row for row in rows if not (exclude_null and row["resolved"] is None)]
        success = np.asarray([row["resolved"] is True for row in metric_rows], dtype=int)
        failure = 1 - success
        difficulty = np.asarray([row["p2l_difficulty_primary"] for row in metric_rows], dtype=float)
        metrics.append({
            "language_model": model_name,
            "question_count": len(rows),
            "valid_result_count": len(metric_rows),
            "resolved_null_count": sum(row["resolved"] is None for row in rows),
            "easy_success_rate": rates["Easy"],
            "medium_success_rate": rates["Medium"],
            "hard_success_rate": rates["Hard"],
            "easy_to_hard_drop_pp": 100 * (rates["Easy"] - rates["Hard"]),
            "monotonic_easy_ge_medium_ge_hard": rates["Easy"] >= rates["Medium"] >= rates["Hard"],
            "difficulty_success_spearman": safe_spearman(difficulty, success),
            "difficulty_failure_spearman": safe_spearman(difficulty, failure),
            "difficulty_failure_roc_auc": float(roc_auc_score(failure, difficulty)),
            "analysis_definition": "exclude_null" if exclude_null else "null_as_not_success",
            "representative_model": model_name in REPRESENTATIVE_MODELS,
        })
    return curves, metrics


def metric_summary(
    question_rows: list[dict[str, Any]], metric: str, seed_offset: int,
) -> dict[str, Any]:
    values = np.asarray([row[metric] for row in question_rows], dtype=float)
    failures = np.asarray([row["empirical_failure_rate"] for row in question_rows], dtype=float)
    rho = safe_spearman(values, failures)
    low, high, valid = bootstrap_spearman(values, failures, RANDOM_SEED + seed_offset)
    order = np.lexsort((np.asarray([row["instance_id"] for row in question_rows]), values))
    deciles = []
    for decile, indices in enumerate(np.array_split(order, 10), start=1):
        deciles.append({
            "decile": decile,
            "question_count": int(len(indices)),
            "mean_metric": float(np.mean(values[indices])),
            "mean_failure_rate": float(np.mean(failures[indices])),
        })
    return {
        "metric": metric,
        "spearman": rho,
        "bootstrap_95_ci": [low, high],
        "bootstrap_samples_requested": BOOTSTRAP_SAMPLES,
        "bootstrap_samples_valid": valid,
        "distribution": {
            "minimum": float(np.min(values)),
            "p25": float(np.percentile(values, 25)),
            "median": float(np.median(values)),
            "mean": float(np.mean(values)),
            "p75": float(np.percentile(values, 75)),
            "maximum": float(np.max(values)),
            "unique_value_count": int(np.unique(values).size),
        },
        "failure_trend_by_equal_count_decile": deciles,
        "nondecreasing_decile_steps_out_of_9": sum(
            deciles[i]["mean_failure_rate"] <= deciles[i + 1]["mean_failure_rate"]
            for i in range(9)
        ),
    }


def aggregate_metrics(
    question_rows: list[dict[str, Any]], model_metrics: list[dict[str, Any]],
) -> dict[str, Any]:
    primary = metric_summary(question_rows, "p2l_difficulty_primary", 0)
    auxiliaries = [
        metric_summary(question_rows, "p2l_difficulty_neg_median", 1),
        metric_summary(question_rows, "p2l_difficulty_neg_mean", 2),
        metric_summary(question_rows, "p2l_beta_spread", 3),
    ]
    difficulty_values = np.asarray(
        [OFFICIAL_DIFFICULTY_ORDER.index(row["official_difficulty"]) for row in question_rows],
        dtype=float,
    )
    primary_values = np.asarray([row["p2l_difficulty_primary"] for row in question_rows])
    groups = []
    group_arrays = []
    for label in OFFICIAL_DIFFICULTY_ORDER:
        values = np.asarray([
            row["p2l_difficulty_primary"] for row in question_rows
            if row["official_difficulty"] == label
        ])
        group_arrays.append(values)
        groups.append({
            "official_difficulty": label,
            "question_count": int(values.size),
            "mean_primary_difficulty": float(np.mean(values)),
            "median_primary_difficulty": float(np.median(values)),
        })
    kw = kruskal(*group_arrays)
    monotonic_count = sum(bool(row["monotonic_easy_ge_medium_ge_hard"]) for row in model_metrics)
    drops = np.asarray([row["easy_to_hard_drop_pp"] for row in model_metrics], dtype=float)
    rho = primary["spearman"]
    ci_low, ci_high = primary["bootstrap_95_ci"]
    if ci_low > 0 and monotonic_count >= math.ceil(2 * len(model_metrics) / 3) and np.median(drops) > 0:
        conclusion = "support"
    elif rho > 0 and ci_high > 0 and monotonic_count >= math.ceil(len(model_metrics) / 2) and np.median(drops) > 0:
        conclusion = "partial_support"
    else:
        conclusion = "not_support"
    return {
        "primary_metric": primary,
        "auxiliary_metrics": auxiliaries,
        "official_difficulty_primary_spearman": safe_spearman(primary_values, difficulty_values),
        "official_difficulty_groups": groups,
        "official_difficulty_kruskal_h": float(kw.statistic),
        "official_difficulty_kruskal_p": float(kw.pvalue),
        "monotonic_model_count": monotonic_count,
        "nonmonotonic_model_count": len(model_metrics) - monotonic_count,
        "easy_to_hard_drop_pp_median": float(np.median(drops)),
        "easy_to_hard_drop_pp_min": float(np.min(drops)),
        "easy_to_hard_drop_pp_max": float(np.max(drops)),
        "conclusion": conclusion,
        "decision_rule": {
            "support": "primary bootstrap CI lower > 0; >= 2/3 models monotonic; median Easy-to-Hard drop > 0",
            "partial_support": "primary rho > 0 and CI upper > 0; >= 1/2 models monotonic; median drop > 0",
            "not_support": "otherwise",
        },
    }


def null_sensitivity_rows(
    primary: dict[str, Any], sensitivity: dict[str, Any],
    primary_models: list[dict[str, Any]], sensitivity_models: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rows = [{
        "scope": "aggregate", "language_model": "ALL_MODELS", "null_record_count": 9,
        "primary_spearman": primary["primary_metric"]["spearman"],
        "sensitivity_spearman": sensitivity["primary_metric"]["spearman"],
        "spearman_delta": sensitivity["primary_metric"]["spearman"] - primary["primary_metric"]["spearman"],
        "primary_monotonic_count": primary["monotonic_model_count"],
        "sensitivity_monotonic_count": sensitivity["monotonic_model_count"],
        "primary_median_drop_pp": primary["easy_to_hard_drop_pp_median"],
        "sensitivity_median_drop_pp": sensitivity["easy_to_hard_drop_pp_median"],
        "primary_conclusion": primary["conclusion"],
        "sensitivity_conclusion": sensitivity["conclusion"],
        "conclusion_changed": primary["conclusion"] != sensitivity["conclusion"],
    }]
    sensitivity_by_model = {row["language_model"]: row for row in sensitivity_models}
    for model in primary_models:
        other = sensitivity_by_model[model["language_model"]]
        rows.append({
            "scope": "model", "language_model": model["language_model"],
            "null_record_count": model["resolved_null_count"],
            "primary_easy_success_rate": model["easy_success_rate"],
            "sensitivity_easy_success_rate": other["easy_success_rate"],
            "primary_medium_success_rate": model["medium_success_rate"],
            "sensitivity_medium_success_rate": other["medium_success_rate"],
            "primary_hard_success_rate": model["hard_success_rate"],
            "sensitivity_hard_success_rate": other["hard_success_rate"],
            "primary_drop_pp": model["easy_to_hard_drop_pp"],
            "sensitivity_drop_pp": other["easy_to_hard_drop_pp"],
            "primary_monotonic": model["monotonic_easy_ge_medium_ge_hard"],
            "sensitivity_monotonic": other["monotonic_easy_ge_medium_ge_hard"],
            "primary_failure_auc": model["difficulty_failure_roc_auc"],
            "sensitivity_failure_auc": other["difficulty_failure_roc_auc"],
        })
    return rows


def compare_with_routellm(
    phase_dir: Path, question_rows: list[dict[str, Any]], p2l_aggregate: dict[str, Any],
    p2l_models: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    phase1b = phase_dir.parent / "phase1b/outputs"
    route_questions = read_csv(phase1b / "question_empirical_difficulty.csv")
    route_models = read_csv(phase1b / "model_validity_metrics.csv")
    route_aggregate = json.loads((phase1b / "aggregate_validation.json").read_text(encoding="utf-8"))
    route_by_id = {row["instance_id"]: row for row in route_questions}
    if set(route_by_id) != {row["instance_id"] for row in question_rows}:
        raise RuntimeError("Phase 1B and Phase 1C question sets differ")
    ordered = sorted(question_rows, key=lambda row: row["instance_id"])
    p2l_values = np.asarray([row["p2l_difficulty_primary"] for row in ordered], dtype=float)
    route_values = np.asarray([
        float(route_by_id[row["instance_id"]]["routellm_raw_score"]) for row in ordered
    ])
    failures = np.asarray([row["empirical_failure_rate"] for row in ordered], dtype=float)
    delta, delta_low, delta_high, delta_valid = bootstrap_paired_spearman_difference(
        p2l_values, route_values, failures
    )
    route_primary = route_aggregate["primary_analysis"]
    rows: list[dict[str, Any]] = [
        {
            "scope": "aggregate", "language_model": "ALL_MODELS", "metric": "failure_spearman",
            "p2l_value": p2l_aggregate["primary_metric"]["spearman"],
            "routellm_value": route_primary["score_failure_spearman"],
            "difference": p2l_aggregate["primary_metric"]["spearman"] - route_primary["score_failure_spearman"],
            "difference_ci_low": "", "difference_ci_high": "",
        },
        {
            "scope": "aggregate", "language_model": "ALL_MODELS", "metric": "failure_spearman_ci_low",
            "p2l_value": p2l_aggregate["primary_metric"]["bootstrap_95_ci"][0],
            "routellm_value": route_primary["score_failure_spearman_bootstrap_95_ci"][0],
            "difference": "", "difference_ci_low": "", "difference_ci_high": "",
        },
        {
            "scope": "aggregate", "language_model": "ALL_MODELS", "metric": "failure_spearman_ci_high",
            "p2l_value": p2l_aggregate["primary_metric"]["bootstrap_95_ci"][1],
            "routellm_value": route_primary["score_failure_spearman_bootstrap_95_ci"][1],
            "difference": "", "difference_ci_low": "", "difference_ci_high": "",
        },
        {
            "scope": "aggregate", "language_model": "ALL_MODELS", "metric": "monotonic_model_count",
            "p2l_value": p2l_aggregate["monotonic_model_count"],
            "routellm_value": route_primary["monotonic_model_count"],
            "difference": p2l_aggregate["monotonic_model_count"] - route_primary["monotonic_model_count"],
            "difference_ci_low": "", "difference_ci_high": "",
        },
        {
            "scope": "aggregate", "language_model": "ALL_MODELS", "metric": "median_easy_to_hard_drop_pp",
            "p2l_value": p2l_aggregate["easy_to_hard_drop_pp_median"],
            "routellm_value": route_primary["easy_to_hard_drop_pp_median"],
            "difference": p2l_aggregate["easy_to_hard_drop_pp_median"] - route_primary["easy_to_hard_drop_pp_median"],
            "difference_ci_low": "", "difference_ci_high": "",
        },
        {
            "scope": "paired_bootstrap", "language_model": "ALL_MODELS",
            "metric": "p2l_spearman_minus_routellm_spearman",
            "p2l_value": p2l_aggregate["primary_metric"]["spearman"],
            "routellm_value": route_primary["score_failure_spearman"],
            "difference": delta, "difference_ci_low": delta_low, "difference_ci_high": delta_high,
        },
    ]
    for router, deciles in [
        ("P2L", p2l_aggregate["primary_metric"]["failure_trend_by_equal_count_decile"]),
        ("RouteLLM", route_primary["failure_trend_by_score_decile"]),
    ]:
        for row in deciles:
            rows.append({
                "scope": "decile", "language_model": router,
                "metric": f"failure_rate_decile_{row['decile']}",
                "p2l_value": row["mean_failure_rate"] if router == "P2L" else "",
                "routellm_value": row["mean_failure_rate"] if router == "RouteLLM" else "",
                "difference": "", "difference_ci_low": "", "difference_ci_high": "",
            })
    route_by_model = {row["language_model"]: row for row in route_models}
    p2l_aucs = []
    route_aucs = []
    for model in p2l_models:
        route = route_by_model.get(model["language_model"])
        if route is None:
            raise RuntimeError(f"Phase 1B missing model {model['language_model']}")
        p2l_auc = float(model["difficulty_failure_roc_auc"])
        route_auc = float(route["score_failure_roc_auc"])
        p2l_aucs.append(p2l_auc)
        route_aucs.append(route_auc)
        rows.append({
            "scope": "model", "language_model": model["language_model"],
            "metric": "failure_roc_auc", "p2l_value": p2l_auc,
            "routellm_value": route_auc, "difference": p2l_auc - route_auc,
            "difference_ci_low": "", "difference_ci_high": "",
        })
    comparison = {
        "same_question_count": len(ordered),
        "same_model_count": len(p2l_models),
        "p2l_spearman": p2l_aggregate["primary_metric"]["spearman"],
        "routellm_spearman": route_primary["score_failure_spearman"],
        "p2l_spearman_bootstrap_95_ci": p2l_aggregate["primary_metric"]["bootstrap_95_ci"],
        "routellm_spearman_bootstrap_95_ci": route_primary["score_failure_spearman_bootstrap_95_ci"],
        "paired_spearman_difference": delta,
        "paired_spearman_difference_bootstrap_95_ci": [delta_low, delta_high],
        "paired_bootstrap_samples_valid": delta_valid,
        "p2l_monotonic_model_count": p2l_aggregate["monotonic_model_count"],
        "routellm_monotonic_model_count": route_primary["monotonic_model_count"],
        "p2l_median_easy_to_hard_drop_pp": p2l_aggregate["easy_to_hard_drop_pp_median"],
        "routellm_median_easy_to_hard_drop_pp": route_primary["easy_to_hard_drop_pp_median"],
        "p2l_model_auc_median": float(np.median(p2l_aucs)),
        "routellm_model_auc_median": float(np.median(route_aucs)),
        "p2l_auc_higher_model_count": int(sum(p2l > route for p2l, route in zip(p2l_aucs, route_aucs))),
        "clear_spearman_improvement": delta_low > 0,
        "comparison_interpretation": (
            "P2L has a statistically clear paired Spearman improvement"
            if delta_low > 0 else
            "P2L does not have a statistically clear paired Spearman improvement"
        ),
        "phase1b_commit": ROUTELLM_COMMIT,
        "phase1b_checkpoint": ROUTELLM_CHECKPOINT,
    }
    return rows, comparison


def write_raw_outputs(path: Path, records: list[dict[str, Any]], model_list: list[str]) -> None:
    rows = []
    for record in records:
        rows.append({
            "instance_id": record["instance_id"],
            "repo": record["repo"],
            "problem_statement_hash": record["problem_statement_hash"],
            "input_token_count": record["input_token_count"],
            "truncated": record["truncated"],
            "beta": record["beta"].tolist(),
            "eta": record["eta"],
            "model_list_revision": record["model_list_revision"],
        })
    schema = pa.schema([
        ("instance_id", pa.string()), ("repo", pa.string()),
        ("problem_statement_hash", pa.string()), ("input_token_count", pa.int64()),
        ("truncated", pa.bool_()), ("beta", pa.list_(pa.float32(), EXPECTED_BETA_DIM)),
        ("eta", pa.float32()), ("model_list_revision", pa.string()),
    ])
    table = pa.Table.from_pylist(rows, schema=schema)
    metadata = {
        b"p2l_model": P2L_MODEL.encode(),
        b"p2l_model_revision": P2L_MODEL_REVISION.encode(),
        b"model_list_sha256": P2L_MODEL_LIST_SHA256.encode(),
        b"model_list_json": json.dumps(model_list, separators=(",", ":")).encode(),
    }
    pq.write_table(table.replace_schema_metadata(metadata), path, compression="zstd")


def plot_style() -> None:
    plt.rcParams.update({
        "figure.facecolor": "white", "axes.facecolor": "white",
        "axes.edgecolor": "#334155", "axes.labelcolor": "#1f2937",
        "text.color": "#1f2937", "xtick.color": "#475569", "ytick.color": "#475569",
        "grid.color": "#e2e8f0", "grid.linewidth": 0.8,
        "font.family": "DejaVu Sans", "font.size": 10,
    })


def save_figure(fig: Any, path: Path) -> None:
    fig.savefig(path, dpi=180, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def plot_figures(output: Path) -> None:
    """Generate every figure from committed CSV outputs, never in-memory results."""
    plot_style()
    figure_dir = output / "figures"
    figure_dir.mkdir(parents=True, exist_ok=True)
    questions = pd.read_csv(output / "question_empirical_difficulty.csv")
    curves = pd.read_csv(output / "model_difficulty_curves.csv")
    comparison = pd.read_csv(output / "p2l_vs_routellm.csv")
    blue, orange, grey, ink = "#2563eb", "#c2410c", "#94a3b8", "#334155"

    metric_specs = [
        ("p2l_difficulty_primary", "Unusable fraction (primary)"),
        ("p2l_difficulty_neg_median", "Negative median beta"),
        ("p2l_difficulty_neg_mean", "Negative mean beta"),
        ("p2l_beta_spread", "Beta P90-P10 spread"),
    ]
    metric_deciles: dict[str, pd.DataFrame] = {}
    fig, axes = plt.subplots(2, 2, figsize=(13, 9), sharey=True)
    for ax, (metric, label) in zip(axes.flat, metric_specs):
        ordered = questions.sort_values([metric, "instance_id"], kind="stable").copy()
        ordered["decile"] = np.repeat(np.arange(1, 11), 50)
        deciles = ordered.groupby("decile", as_index=False).agg(
            mean_metric=(metric, "mean"), empirical_failure_rate=("empirical_failure_rate", "mean")
        )
        metric_deciles[metric] = deciles
        ax.scatter(questions[metric], questions["empirical_failure_rate"],
                   s=14, alpha=0.22, color=blue, edgecolors="none", label="500 questions")
        ax.plot(deciles["mean_metric"], deciles["empirical_failure_rate"],
                color=orange, marker="o", linewidth=2, label="Decile means")
        ax.set_title(label)
        ax.set_xlabel(label)
        ax.grid(True, alpha=0.8)
    axes[0, 0].set_ylabel("Failure rate across 34 models")
    axes[1, 0].set_ylabel("Failure rate across 34 models")
    axes[0, 0].legend(frameon=False)
    fig.suptitle("Empirical failure rate vs pre-registered P2L metrics", fontsize=15)
    fig.tight_layout()
    save_figure(fig, figure_dir / "p2l_failure_scatter.png")

    fig, axes = plt.subplots(2, 2, figsize=(12, 8), sharex=True, sharey=True)
    for ax, (metric, label) in zip(axes.flat, metric_specs):
        deciles = metric_deciles[metric]
        ax.plot(deciles["decile"], deciles["empirical_failure_rate"],
                color=blue, marker="o", linewidth=2.2)
        ax.set_title(label)
        ax.set_xticks(range(1, 11))
        ax.grid(True, axis="y")
    axes[0, 0].set_ylabel("Mean failure rate")
    axes[1, 0].set_ylabel("Mean failure rate")
    fig.suptitle("Failure rate by equal-count P2L metric decile", fontsize=15)
    fig.supxlabel("Metric decile (low to high; 50 questions each)")
    fig.tight_layout()
    save_figure(fig, figure_dir / "p2l_decile_trend.png")

    rep = curves[curves["representative_model"]].copy()
    fig, axes = plt.subplots(2, 4, figsize=(14, 7), sharex=True, sharey=True)
    for ax, model_name in zip(axes.flat, REPRESENTATIVE_MODELS):
        group = rep[rep["language_model"] == model_name].set_index("difficulty_bin").loc[BIN_ORDER]
        rates = group["success_rate"].to_numpy()
        lower = rates - group["wilson_95_low"].to_numpy()
        upper = group["wilson_95_high"].to_numpy() - rates
        ax.errorbar(BIN_ORDER, rates, yerr=[lower, upper], color=blue, marker="o",
                    linewidth=2, capsize=3)
        ax.set_title(model_name, fontsize=10)
        ax.grid(True, axis="y")
    axes[0, 0].set_ylabel("Success rate")
    axes[1, 0].set_ylabel("Success rate")
    fig.suptitle("Representative model success rates by P2L tertile", fontsize=15)
    fig.supxlabel("P2L primary-difficulty tertile (167 / 166 / 167 questions)")
    fig.tight_layout()
    save_figure(fig, figure_dir / "representative_model_curves.png")

    fig, ax = plt.subplots(figsize=(11, 7))
    for _, group in curves.groupby("language_model"):
        group = group.set_index("difficulty_bin").loc[BIN_ORDER]
        ax.plot(BIN_ORDER, group["success_rate"], color=grey, alpha=0.5, linewidth=1.1)
    medians = curves.groupby("difficulty_bin")["success_rate"].median().loc[BIN_ORDER]
    ax.plot(BIN_ORDER, medians, color=orange, linewidth=3, marker="o", label="Median across 34 models")
    ax.set(title="All 34 model success curves by P2L tertile",
           xlabel="P2L primary-difficulty tertile", ylabel="Success rate", ylim=(0, 1))
    ax.grid(True, axis="y")
    ax.legend(frameon=False)
    save_figure(fig, figure_dir / "all_model_curves.png")

    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    decile_rows = comparison[comparison["scope"] == "decile"].copy()
    for router, color, column in [("P2L", blue, "p2l_value"), ("RouteLLM", orange, "routellm_value")]:
        group = decile_rows[decile_rows["language_model"] == router].copy()
        group["decile"] = group["metric"].str.rsplit("_", n=1).str[-1].astype(int)
        axes[0].plot(group["decile"], group[column], marker="o", linewidth=2, color=color, label=router)
    axes[0].set(title="Failure trend by router-score decile", xlabel="Score decile", ylabel="Mean failure rate", xticks=range(1, 11))
    axes[0].grid(True, axis="y")
    axes[0].legend(frameon=False)
    model_rows = comparison[(comparison["scope"] == "model") & (comparison["metric"] == "failure_roc_auc")]
    axes[1].scatter(model_rows["routellm_value"], model_rows["p2l_value"], color=blue, alpha=0.75)
    bounds = [0.4, 0.7]
    axes[1].plot(bounds, bounds, linestyle="--", color=ink, linewidth=1.2, label="Equal AUC")
    axes[1].set(title="Per-model failure ROC-AUC", xlabel="RouteLLM AUC", ylabel="P2L AUC", xlim=bounds, ylim=bounds)
    axes[1].grid(True)
    axes[1].legend(frameon=False)
    fig.tight_layout()
    save_figure(fig, figure_dir / "p2l_vs_routellm.png")

    group_values = [
        questions.loc[questions["official_difficulty"] == label, "p2l_difficulty_primary"].to_numpy()
        for label in OFFICIAL_DIFFICULTY_ORDER
    ]
    fig, ax = plt.subplots(figsize=(10, 5.5))
    box = ax.boxplot(group_values, tick_labels=OFFICIAL_DIFFICULTY_ORDER, patch_artist=True)
    for patch in box["boxes"]:
        patch.set(facecolor="#dbeafe", edgecolor=blue)
    for median in box["medians"]:
        median.set(color=orange, linewidth=2)
    ax.set(title="P2L primary difficulty by official SWE-bench difficulty",
           xlabel="Official difficulty (post-hoc comparison only)", ylabel="P2L unusable fraction")
    ax.grid(True, axis="y")
    save_figure(fig, figure_dir / "official_vs_p2l.png")


def installed_versions() -> dict[str, str]:
    packages = [
        "torch", "transformers", "tokenizers", "huggingface-hub", "accelerate",
        "safetensors", "numpy", "pandas", "pyarrow", "scipy", "scikit-learn",
        "matplotlib", "psutil",
    ]
    return {name: importlib.metadata.version(name) for name in packages}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["preflight", "full"], default="full")
    parser.add_argument("--offline", action="store_true", help="Forbid all downloads and require cached outputs")
    args = parser.parse_args()

    phase_dir = Path(__file__).resolve().parents[1]
    cache = phase_dir / ".cache"
    output = phase_dir / "outputs"
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(CPU_THREADS)

    repo, model_dir = prepare_official_assets(cache, args.offline)
    source_contract = verify_official_code(repo)
    model_list = load_model_list(model_dir)
    questions, verified_path = load_verified(phase_dir)

    if args.mode == "preflight":
        if args.offline:
            raise RuntimeError("Hardware preflight must execute CPU inference; --offline is not applicable")
        benchmark = run_hardware_preflight(questions, repo, model_dir, cache, output)
        print(json.dumps(benchmark, ensure_ascii=False, indent=2))
        return 0

    benchmark_path = output / "hardware_benchmark.json"
    if not benchmark_path.exists():
        raise RuntimeError("Required 20-question hardware preflight is missing")
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))
    if benchmark.get("status") != "passed" or benchmark.get("peak_rss_gib", 99) > MEMORY_GATE_GIB:
        raise RuntimeError("Hardware preflight did not pass the 7 GiB memory gate")

    raw_records = run_inference(questions, repo, model_dir, cache, args.offline)
    scored = score_records(raw_records)
    if Counter(row["p2l_tertile"] for row in scored) != Counter({"Easy": 167, "Medium": 166, "Hard": 167}):
        raise RuntimeError("P2L tertile counts are not 167 / 166 / 167")
    write_raw_outputs(output / "p2l_raw_outputs.parquet", raw_records, model_list)
    score_fields = [
        "instance_id", "repo", "problem_statement_hash", "input_token_count", "truncated",
        "p2l_difficulty_primary", "p2l_difficulty_neg_median", "p2l_difficulty_neg_mean",
        "p2l_beta_spread", "beta_min", "beta_p10", "beta_median", "beta_mean",
        "beta_p90", "beta_max", "eta", "p2l_rank", "p2l_percentile", "p2l_tertile",
        "model_list_revision",
    ]
    write_csv(output / "question_p2l_scores.csv", [
        {field: row[field] for field in score_fields} for row in scored
    ])

    outcomes, instances_path = load_openhands(phase_dir)
    if {row["instance_id"] for row in outcomes} != {row["instance_id"] for row in scored}:
        raise RuntimeError("OpenHands and P2L question sets differ")
    primary_questions = compute_question_difficulty(scored, outcomes, exclude_null=False)
    sensitivity_questions = compute_question_difficulty(scored, outcomes, exclude_null=True)
    primary_curves, primary_models = compute_model_outputs(scored, outcomes, exclude_null=False)
    sensitivity_curves, sensitivity_models = compute_model_outputs(scored, outcomes, exclude_null=True)
    primary_aggregate = aggregate_metrics(primary_questions, primary_models)
    sensitivity_aggregate = aggregate_metrics(sensitivity_questions, sensitivity_models)
    comparison_rows, comparison_summary = compare_with_routellm(
        phase_dir, primary_questions, primary_aggregate, primary_models
    )
    sensitivity_rows = null_sensitivity_rows(
        primary_aggregate, sensitivity_aggregate, primary_models, sensitivity_models
    )

    write_csv(output / "question_empirical_difficulty.csv", primary_questions)
    write_csv(output / "model_difficulty_curves.csv", primary_curves)
    write_csv(output / "model_validity_metrics.csv", primary_models)
    write_csv(output / "p2l_vs_routellm.csv", comparison_rows)
    write_csv(output / "null_sensitivity_analysis.csv", sensitivity_rows)

    latencies = np.asarray([row["latency_seconds"] for row in raw_records], dtype=float)
    full_benchmark = {
        "question_count": 500,
        "sum_single_question_latency_seconds": float(np.sum(latencies)),
        "mean_single_question_latency_seconds": float(np.mean(latencies)),
        "p50_single_question_latency_seconds": float(np.percentile(latencies, 50)),
        "p95_single_question_latency_seconds": float(np.percentile(latencies, 95)),
        "minimum_single_question_latency_seconds": float(np.min(latencies)),
        "maximum_single_question_latency_seconds": float(np.max(latencies)),
    }
    benchmark["full_run"] = full_benchmark
    write_json(benchmark_path, benchmark)

    aggregate = {
        "analysis_name": "Phase 1C P2L difficulty validity",
        "primary_metric_definition": "count(beta_i <= 0) / count(beta_i)",
        "primary_analysis": primary_aggregate,
        "null_excluded_sensitivity": sensitivity_aggregate,
        "null_sensitivity_changes_conclusion": primary_aggregate["conclusion"] != sensitivity_aggregate["conclusion"],
        "comparison_with_routellm": comparison_summary,
        "data_counts": {
            "question_count": 500, "p2l_output_count": 500,
            "p2l_beta_dimension": EXPECTED_BETA_DIM, "openhands_model_count": 34,
            "model_question_result_count": 17_000, "resolved_null_count": 9,
            "truncated_question_count": sum(row["truncated"] for row in scored),
            "truncated_question_rate": sum(row["truncated"] for row in scored) / len(scored),
            "tertile_question_counts": dict(Counter(row["p2l_tertile"] for row in scored)),
        },
        "input_token_distribution": {
            "minimum": int(np.min([row["input_token_count"] for row in scored])),
            "p25": float(np.percentile([row["input_token_count"] for row in scored], 25)),
            "median": float(np.median([row["input_token_count"] for row in scored])),
            "mean": float(np.mean([row["input_token_count"] for row in scored])),
            "p75": float(np.percentile([row["input_token_count"] for row in scored], 75)),
            "p95": float(np.percentile([row["input_token_count"] for row in scored], 95)),
            "maximum": int(np.max([row["input_token_count"] for row in scored])),
        },
        "full_inference_benchmark": full_benchmark,
        "representative_models": [row for row in primary_models if row["representative_model"]],
        "models_with_nonmonotonic_curves": [
            row["language_model"] for row in primary_models
            if not row["monotonic_easy_ge_medium_ge_hard"]
        ],
    }
    write_json(output / "aggregate_validation.json", aggregate)
    plot_figures(output)

    frozen_at = max(row["created_at_utc"] for row in raw_records)
    manifest = {
        "run_name": "ClawRouter OpenHands Phase 1C P2L",
        "inference_frozen_at_utc": frozen_at,
        "execution_mode": "offline_replay" if args.offline else "online_missing-cache-only",
        "data": {
            "openhands_dataset": OPENHANDS_DATASET, "openhands_tag": OPENHANDS_REVISION,
            "openhands_hf_commit": OPENHANDS_HF_COMMIT,
            "swebench_dataset": SWEBENCH_DATASET, "swebench_commit": SWEBENCH_REVISION,
            "input_files": {
                "openhands_instances": {"sha256": sha256(instances_path), "rows": 40_643},
                "swebench_verified": {"sha256": sha256(verified_path), "rows": 500},
                "phase1b_question_scores": {
                    "sha256": sha256(phase_dir.parent / "phase1b/outputs/question_routellm_scores.csv"),
                    "rows": 500,
                },
            },
        },
        "p2l": {
            "repository": P2L_REPOSITORY, "git_commit": P2L_COMMIT,
            "model": P2L_MODEL, "model_revision": P2L_MODEL_REVISION,
            "model_type": P2L_MODEL_TYPE, "head_type": P2L_HEAD_TYPE,
            "loss_type_used_to_construct_official_head": P2L_LOSS_TYPE,
            "parameter_count": P2L_PARAMETER_COUNT,
            "model_file_sha256": sha256(model_dir / "model.safetensors"),
            "config_sha256": sha256(model_dir / "config.json"),
            "tokenizer_revision": P2L_MODEL_REVISION,
            "tokenizer_json_sha256": sha256(model_dir / "tokenizer.json"),
            "tokenizer_config_sha256": sha256(model_dir / "tokenizer_config.json"),
            "tokenizer_model_max_length": load_tokenizer(model_dir).model_max_length,
            "tokenizer_truncation_side": load_tokenizer(model_dir).truncation_side,
            "model_list_sha256": sha256(model_dir / "model_list.json"),
            "model_list": model_list,
            "source_contract": source_contract,
            "compatibility_changes": [],
        },
        "inference": {
            "device": "cpu", "torch_dtype": "float32", "cpu_threads": CPU_THREADS,
            "batch_size": 1, "low_cpu_mem_usage": True, "model_eval": True,
            "torch_inference_mode": True, "commercial_model_api_calls": 0,
            "answer_generation_calls": 0, "input_field": "problem_statement only",
            "chat_template": "official tokenizer apply_chat_template; one user turn; no generation prompt; append CLS",
            "max_length": MAX_CONTEXT, "truncation": True,
            "cached_output_count": len(raw_records), "hardware_benchmark": benchmark,
        },
        "analysis": {
            "primary_metric": "p2l_unusable_fraction = count(beta_i <= 0) / count(beta_i)",
            "auxiliary_metrics": ["-median(beta)", "-mean(beta)", "p90(beta)-p10(beta)"],
            "primary_null_handling": "resolved null is not success",
            "sensitivity_null_handling": "exclude resolved null",
            "bootstrap_samples": BOOTSTRAP_SAMPLES, "random_seed": RANDOM_SEED,
            "tertile_rule": "stable primary-score and instance_id order; 167 Easy, 166 Medium, 167 Hard",
            "official_difficulty_used_as_input": False, "cost_used": False,
            "gold_or_test_patch_used": False, "openhands_outcomes_loaded_before_inference": False,
        },
        "runtime": {
            "python": platform.python_version(), "platform": platform.platform(),
            "dependencies": installed_versions(),
        },
        "chart_map": [
            {"file": "p2l_failure_scatter.png", "family": "relationship", "source": "question_empirical_difficulty.csv"},
            {"file": "p2l_decile_trend.png", "family": "ordered comparison", "source": "question_empirical_difficulty.csv"},
            {"file": "representative_model_curves.png", "family": "faceted uncertainty", "source": "model_difficulty_curves.csv"},
            {"file": "all_model_curves.png", "family": "multi-series ordered comparison", "source": "model_difficulty_curves.csv"},
            {"file": "p2l_vs_routellm.png", "family": "benchmark comparison", "source": "p2l_vs_routellm.csv"},
            {"file": "official_vs_p2l.png", "family": "grouped distribution", "source": "question_empirical_difficulty.csv"},
        ],
    }
    write_json(output / "run_manifest.json", manifest)
    print(json.dumps({
        "status": "complete", "primary_spearman": primary_aggregate["primary_metric"]["spearman"],
        "primary_spearman_ci": primary_aggregate["primary_metric"]["bootstrap_95_ci"],
        "monotonic_models": primary_aggregate["monotonic_model_count"],
        "median_drop_pp": primary_aggregate["easy_to_hard_drop_pp_median"],
        "routellm_delta": comparison_summary["paired_spearman_difference"],
        "routellm_delta_ci": comparison_summary["paired_spearman_difference_bootstrap_95_ci"],
        "conclusion": primary_aggregate["conclusion"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted; completed per-question cache entries are reusable.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
