#!/usr/bin/env python3
"""Phase 1B: validate RouteLLM MF strong-model-need scores on SWE-bench.

The only network inference operation in this script is an explicitly selected
OpenAI-compatible /embeddings endpoint for text-embedding-3-small. It never calls
completions and never generates answers. Once 500 embeddings are cached, --offline
reproduces all scores, statistics, CSVs, JSON and figures without credentials or
network access.
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
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from openai import APIConnectionError, APIStatusError, OpenAI, RateLimitError
from safetensors.numpy import load_file
from scipy.stats import kruskal, rankdata, spearmanr
from sklearn.metrics import roc_auc_score


OPENHANDS_DATASET = "OpenHands/openhands-index"
OPENHANDS_REVISION = "v2026.06.30-3015ac6"
OPENHANDS_HF_COMMIT = "94ac78ad8ec547875a0a4ec56e15a644aa5653f6"
SWEBENCH_DATASET = "SWE-bench/SWE-bench_Verified"
SWEBENCH_REVISION = "91aa3ed51b709be6457e12d00300a6a596d4c6a3"
ROUTELLM_REPO = "https://github.com/lm-sys/RouteLLM.git"
ROUTELLM_COMMIT = "0b64fdafe049e596a3f5657c219329f24af24198"
CHECKPOINT = "routellm/mf_gpt4_augmented"
CHECKPOINT_REVISION = "5eb3dc745cbe7cb16ca342ceb83b7f6ecf8c77c5"
CHECKPOINT_SHA256 = "bfc93d473b48f8b85ce719f0d7e8bb86a139fa052e8b0c3ac387eabf45e47293"
CHECKPOINT_URL = (
    "https://huggingface.co/routellm/mf_gpt4_augmented/resolve/"
    f"{CHECKPOINT_REVISION}/model.safetensors"
)
EMBEDDING_SEMANTIC_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536
STRONG_MODEL = "gpt-4-1106-preview"
WEAK_MODEL = "mixtral-8x7b-instruct-v0.1"
STRONG_MODEL_ID = 24
WEAK_MODEL_ID = 36
BOOTSTRAP_SAMPLES = 10_000
RANDOM_SEED = 20260726
PREFLIGHT_COUNT = 5

OPENHANDS_INSTANCES_SHA256 = "f456e937771bdd45815cacd6458433e0e750be0a2a6bcd5daf91670b151968a5"
SWEBENCH_SHA256 = "43ed5a3d1d98da36472c1ade65ddd2085d7b4ff694fcaf6a023a07c5c1f32f21"

OFFICIAL_DIFFICULTY_ORDER = [
    "<15 min fix",
    "15 min - 1 hour",
    "1-4 hours",
    ">4 hours",
]
REPRESENTATIVE_MODELS = [
    "claude-opus-4-8",
    "GPT-5.5",
    "Gemini-3.5-Flash",
    "DeepSeek-V4-Pro",
    "GLM-5.1",
    "Kimi-K2.6",
    "MiniMax-M3",
    "Qwen3-Coder-Next",
]
MODEL_IDS_EXPECTED = {
    "gpt-4-1106-preview": 24,
    "mixtral-8x7b-instruct-v0.1": 36,
}


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def prompt_hash(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def normalize_csv_string(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in value.split("\n"))


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = fields or (list(rows[0]) if rows else [])
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=fields, extrasaction="ignore", lineterminator="\n"
        )
        writer.writeheader()
        for row in rows:
            writer.writerow({
                key: normalize_csv_string(value) if isinstance(value, str) else value
                for key, value in row.items()
            })


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=False)
        handle.write("\n")


def load_env_secret(repo_root: Path, name: str) -> tuple[str | None, str]:
    value = os.environ.get(name)
    if value:
        return value, "environment"
    env_file = repo_root / ".env"
    if env_file.exists():
        for raw_line in env_file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, candidate = line.split("=", 1)
            if key.strip() == name:
                candidate = candidate.strip()
                if len(candidate) >= 2 and candidate[0] == candidate[-1] and candidate[0] in "\"'":
                    candidate = candidate[1:-1]
                if candidate:
                    return candidate, "repository .env (ignored)"
    return None, "not found"


def embedding_config(repo_root: Path, gateway: str) -> dict[str, Any]:
    if gateway == "openrouter":
        return {
            "gateway": gateway,
            "api_base": "https://openrouter.ai/api/v1",
            "request_model": "openai/text-embedding-3-small",
            "credential_name": "OPENROUTER_API_KEY",
            "upstream_assertion": "OpenRouter provider pinned to openai with fallbacks disabled",
        }
    api_base, source = load_env_secret(repo_root, "PROXY_BASE_URL")
    if not api_base:
        raise RuntimeError("PROXY_BASE_URL is unavailable for closeai")
    parsed = urlparse(api_base)
    if parsed.scheme != "https" or not parsed.hostname:
        raise RuntimeError("PROXY_BASE_URL must be an HTTPS URL")
    return {
        "gateway": gateway,
        "api_base": api_base.rstrip("/"),
        "api_base_source": source,
        "request_model": "text-embedding-3-small",
        "credential_name": "PROXY_API_KEY",
        "upstream_assertion": (
            "Gateway advertises OpenAI text-embedding-3-small; actual upstream snapshot "
            "cannot be independently attested by the compatible API response"
        ),
    }


def run_git(arguments: list[str], cwd: Path | None = None) -> str:
    result = subprocess.run(
        ["git", *arguments], cwd=cwd, text=True, check=False,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise RuntimeError(f"git {' '.join(arguments)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def prepare_routellm(cache: Path, offline: bool) -> Path:
    repo = cache / "RouteLLM"
    if not (repo / ".git").exists():
        if offline:
            raise RuntimeError(f"Offline mode: RouteLLM checkout missing at {repo}")
        run_git(["clone", ROUTELLM_REPO, str(repo)])
    try:
        run_git(["cat-file", "-e", f"{ROUTELLM_COMMIT}^{{commit}}"], repo)
    except RuntimeError:
        if offline:
            raise
        run_git(["fetch", "origin", ROUTELLM_COMMIT], repo)
    run_git(["checkout", "--detach", "--quiet", ROUTELLM_COMMIT], repo)
    if run_git(["rev-parse", "HEAD"], repo) != ROUTELLM_COMMIT:
        raise RuntimeError("RouteLLM checkout is not at the pinned commit")
    return repo


def download_checkpoint(cache: Path, offline: bool) -> Path:
    path = (
        cache / "checkpoint" / "routellm__mf_gpt4_augmented"
        / CHECKPOINT_REVISION / "model.safetensors"
    )
    if path.exists() and sha256(path) == CHECKPOINT_SHA256:
        return path
    if offline:
        raise RuntimeError(f"Offline mode: verified checkpoint missing at {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".part")
    partial.unlink(missing_ok=True)
    try:
        request = urllib.request.Request(
            CHECKPOINT_URL, headers={"User-Agent": "ClawRouter-Phase1B/1.0"}
        )
        with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as out:
            shutil.copyfileobj(response, out)
    except (urllib.error.URLError, TimeoutError) as exc:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Checkpoint download failed: {exc}") from exc
    actual = sha256(partial)
    if actual != CHECKPOINT_SHA256:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Checkpoint checksum mismatch: {actual}")
    partial.replace(path)
    return path


def verify_official_source_contract(routellm_repo: Path) -> dict[str, Any]:
    model_source = routellm_repo / "routellm/routers/matrix_factorization/model.py"
    router_source = routellm_repo / "routellm/routers/routers.py"
    model_text = model_source.read_text(encoding="utf-8")
    router_text = router_source.read_text(encoding="utf-8")
    required_snippets = [
        'self.embedding_model = "text-embedding-3-small"',
        "torch.nn.functional.normalize(model_embed, p=2, dim=1)",
        "prompt_embed = self.text_proj(prompt_embed)",
        "return self.classifier(model_embed * prompt_embed).squeeze()",
        "winrate = torch.sigmoid(logits[0] - logits[1]).item()",
    ]
    missing = [snippet for snippet in required_snippets if snippet not in model_text]
    if missing:
        raise RuntimeError(f"Pinned RouteLLM source contract changed; missing: {missing}")
    if '"gpt-4-1106-preview": 24' not in model_text or '"mixtral-8x7b-instruct-v0.1": 36' not in model_text:
        raise RuntimeError("Pinned strong/weak MODEL_IDS are not present in official source")
    if '"mf": {"checkpoint_path": "routellm/mf_gpt4_augmented"}' not in (
        routellm_repo / "routellm/controller.py"
    ).read_text(encoding="utf-8"):
        raise RuntimeError("Pinned official MF checkpoint is not the default GPT-4 augmented config")
    if "class MatrixFactorizationRouter" not in router_text:
        raise RuntimeError("Official MatrixFactorizationRouter class missing")
    return {
        "model_source_sha256": sha256(model_source),
        "router_source_sha256": sha256(router_source),
        "equivalent_lower_level_formula": (
            "L2-normalize P[model_ids]; project 1536-D prompt embedding with "
            "text_proj.0.weight; elementwise multiply; apply classifier.0.weight; "
            "sigmoid(strong_logit - weak_logit)"
        ),
    }


class MFCheckpoint:
    """NumPy float32 implementation of the pinned official MF inference formula."""

    def __init__(self, checkpoint_path: Path):
        weights = load_file(checkpoint_path)
        expected = {
            "P.weight": (64, 128),
            "text_proj.0.weight": (128, 1536),
            "classifier.0.weight": (1, 128),
        }
        actual = {key: tuple(value.shape) for key, value in weights.items()}
        if actual != expected:
            raise RuntimeError(f"Unexpected MF checkpoint tensors: {actual}")
        self.model_embeddings = weights["P.weight"].astype(np.float32)
        self.text_projection = weights["text_proj.0.weight"].astype(np.float32)
        self.classifier = weights["classifier.0.weight"].astype(np.float32)

    def calculate_strong_win_rate(self, embedding: np.ndarray) -> float:
        embedding = np.asarray(embedding, dtype=np.float32)
        if embedding.shape != (EMBEDDING_DIMENSIONS,):
            raise RuntimeError(f"Expected {EMBEDDING_DIMENSIONS}-D embedding, got {embedding.shape}")
        model_vectors = self.model_embeddings[[STRONG_MODEL_ID, WEAK_MODEL_ID]]
        norms = np.linalg.norm(model_vectors, ord=2, axis=1, keepdims=True)
        normalized = model_vectors / norms
        prompt_projected = self.text_projection @ embedding
        logits = (normalized * prompt_projected) @ self.classifier.T
        delta = np.float32(logits[0, 0] - logits[1, 0])
        score = float(np.float32(1.0) / (np.float32(1.0) + np.exp(-delta, dtype=np.float32)))
        if not math.isfinite(score):
            raise RuntimeError("Non-finite RouteLLM score")
        return score


class RequestAudit:
    def __init__(self) -> None:
        self.paths: list[str] = []

    def hook(self, request: Any) -> None:
        path = request.url.path
        self.paths.append(path)
        if not path.endswith("/embeddings"):
            raise RuntimeError(f"Blocked non-embedding API request: {path}")

    def summary(self) -> dict[str, Any]:
        counts = Counter(self.paths)
        completion_count = sum(
            count for path, count in counts.items()
            if "completion" in path or "response" in path
        )
        return {
            "request_count": len(self.paths),
            "embedding_request_count": sum(count for path, count in counts.items() if path.endswith("/embeddings")),
            "completion_request_count": completion_count,
            "request_paths": dict(sorted(counts.items())),
        }


class CompatibleEmbedder:
    def __init__(self, api_key: str, config: dict[str, Any], audit: RequestAudit):
        import httpx

        http_client = httpx.Client(event_hooks={"request": [audit.hook]}, timeout=120.0)
        self.client = OpenAI(api_key=api_key, base_url=config["api_base"], http_client=http_client)
        self.config = config

    def create(self, prompt: str) -> tuple[np.ndarray, dict[str, Any]]:
        last_error: Exception | None = None
        for attempt in range(8):
            try:
                request: dict[str, Any] = {
                    "input": [prompt],
                    "model": self.config["request_model"],
                    "dimensions": EMBEDDING_DIMENSIONS,
                }
                if self.config["gateway"] == "openrouter":
                    request["extra_body"] = {
                        "provider": {
                            "order": ["openai"],
                            "only": ["openai"],
                            "allow_fallbacks": False,
                            "data_collection": "deny",
                        }
                    }
                response = self.client.embeddings.create(**request)
                embedding = np.asarray(response.data[0].embedding, dtype=np.float32)
                if embedding.shape != (EMBEDDING_DIMENSIONS,) or not np.isfinite(embedding).all():
                    raise RuntimeError(f"Invalid embedding shape or values: {embedding.shape}")
                usage = getattr(response, "usage", None)
                metadata = {
                    "response_model": getattr(response, "model", None),
                    "prompt_tokens": getattr(usage, "prompt_tokens", None) if usage else None,
                    "total_tokens": getattr(usage, "total_tokens", None) if usage else None,
                    "embedding_dimensions": int(embedding.size),
                }
                return embedding, metadata
            except (RateLimitError, APIConnectionError) as exc:
                last_error = exc
            except APIStatusError as exc:
                if exc.status_code not in {408, 409, 429, 500, 502, 503, 504}:
                    raise RuntimeError(
                        f"{self.config['gateway']} embeddings failed with HTTP {exc.status_code}; "
                        "no alternate router or simulated score will be used"
                    ) from exc
                last_error = exc
            if attempt < 7:
                delay = min(60.0, 2.0**attempt) + random.Random(RANDOM_SEED + attempt).uniform(0, 0.25)
                time.sleep(delay)
        raise RuntimeError(
            f"{self.config['gateway']} embeddings exhausted retries: {type(last_error).__name__}"
        ) from last_error


def load_sources(phase_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], Path, Path]:
    openhands_root = phase_dir.parent
    instances_path = openhands_root / ".cache/openhands-index-raw/instances.parquet"
    verified_path = openhands_root / ".cache/swebench-official-raw/data/test-00000-of-00001.parquet"
    for path, expected in [
        (instances_path, OPENHANDS_INSTANCES_SHA256),
        (verified_path, SWEBENCH_SHA256),
    ]:
        if not path.exists():
            raise RuntimeError(f"Required Phase 1A cached input is missing: {path}")
        actual = sha256(path)
        if actual != expected:
            raise RuntimeError(f"Input checksum mismatch for {path}: {actual}")
    instances = pq.read_table(instances_path).to_pylist()
    verified = pq.read_table(
        verified_path, columns=["instance_id", "repo", "difficulty", "problem_statement"]
    ).to_pylist()
    if len(instances) != 40_643:
        raise RuntimeError(f"Expected 40,643 OpenHands rows, found {len(instances)}")
    if len(verified) != 500 or len({row["instance_id"] for row in verified}) != 500:
        raise RuntimeError("Expected 500 unique SWE-bench Verified questions")
    required = ("instance_id", "repo", "difficulty", "problem_statement")
    for field in required:
        if any(row.get(field) in (None, "") for row in verified):
            raise RuntimeError(f"Verified input has missing {field}")
    swe = [row for row in instances if row["benchmark"] == "swe-bench"]
    if len(swe) != 17_000 or len({row["id"] for row in swe}) != 34:
        raise RuntimeError("Expected exactly 17,000 SWE-bench rows and 34 models")
    keys = [(row["id"], row["instance_id"]) for row in swe]
    if len(set(keys)) != 17_000:
        raise RuntimeError("Duplicate model + SWE-bench instance key found")
    question_ids = {row["instance_id"] for row in verified}
    if {row["instance_id"] for row in swe} != question_ids:
        raise RuntimeError("OpenHands SWE-bench instance set does not exactly match Verified")
    return swe, verified, instances_path, verified_path


def embedding_paths(
    cache: Path, instance_id: str, statement_hash: str, gateway: str,
) -> tuple[Path, Path]:
    safe_id = instance_id.replace("/", "__")
    base = cache / f"embeddings_{gateway}" / f"{safe_id}__{statement_hash[:16]}"
    return base.with_suffix(".npy"), base.with_suffix(".json")


def load_cached_embedding(
    cache: Path, instance_id: str, statement_hash: str, config: dict[str, Any],
) -> tuple[np.ndarray, dict[str, Any]] | None:
    npy_path, meta_path = embedding_paths(cache, instance_id, statement_hash, config["gateway"])
    if not npy_path.exists() or not meta_path.exists():
        return None
    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    if metadata.get("problem_statement_hash") != statement_hash:
        return None
    if metadata.get("embedding_semantic_model") != EMBEDDING_SEMANTIC_MODEL:
        return None
    if metadata.get("gateway") != config["gateway"]:
        return None
    embedding = np.load(npy_path, allow_pickle=False)
    if embedding.shape != (EMBEDDING_DIMENSIONS,) or not np.isfinite(embedding).all():
        raise RuntimeError(f"Invalid cached embedding: {npy_path}")
    if sha256(npy_path) != metadata.get("embedding_file_sha256"):
        raise RuntimeError(f"Cached embedding checksum mismatch: {npy_path}")
    return embedding.astype(np.float32), metadata


def save_embedding(
    cache: Path, instance_id: str, statement_hash: str,
    embedding: np.ndarray, response_metadata: dict[str, Any], config: dict[str, Any],
) -> dict[str, Any]:
    npy_path, meta_path = embedding_paths(cache, instance_id, statement_hash, config["gateway"])
    npy_path.parent.mkdir(parents=True, exist_ok=True)
    partial = npy_path.with_suffix(".npy.part")
    with partial.open("wb") as handle:
        np.save(handle, embedding.astype(np.float32), allow_pickle=False)
    partial.replace(npy_path)
    metadata = {
        "instance_id": instance_id,
        "problem_statement_hash": statement_hash,
        "gateway": config["gateway"],
        "embedding_api": config["api_base"],
        "embedding_semantic_model": EMBEDDING_SEMANTIC_MODEL,
        "embedding_request_model": config["request_model"],
        "upstream_assertion": config["upstream_assertion"],
        "embedding_file": str(npy_path.name),
        "embedding_file_sha256": sha256(npy_path),
        "created_at_utc": now_utc(),
        **response_metadata,
    }
    write_json(meta_path, metadata)
    return metadata


def score_questions(
    questions: list[dict[str, Any]], cache: Path, model: MFCheckpoint,
    offline: bool, limit: int | None, repo_root: Path, config: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    selected = sorted(questions, key=lambda row: row["instance_id"])
    if limit is not None:
        selected = selected[:limit]
    audit = RequestAudit()
    credential_source = "not required (offline)"
    embedder: CompatibleEmbedder | None = None
    results = []
    for index, question in enumerate(selected, start=1):
        statement_hash = prompt_hash(question["problem_statement"])
        cached = load_cached_embedding(cache, question["instance_id"], statement_hash, config)
        cache_hit = cached is not None
        if cached is None:
            if offline:
                raise RuntimeError(
                    f"Offline mode: embedding missing for {question['instance_id']}"
                )
            if embedder is None:
                api_key, credential_source = load_env_secret(repo_root, config["credential_name"])
                if not api_key:
                    raise RuntimeError(
                        f"{config['credential_name']} is unavailable; stopping without alternate router "
                        "or simulated scores"
                    )
                embedder = CompatibleEmbedder(api_key, config, audit)
            embedding, response_meta = embedder.create(question["problem_statement"])
            metadata = save_embedding(
                cache, question["instance_id"], statement_hash, embedding, response_meta, config
            )
        else:
            embedding, metadata = cached
        score = model.calculate_strong_win_rate(embedding)
        results.append({
            "instance_id": question["instance_id"],
            "repo": question["repo"],
            "official_difficulty": question["difficulty"],
            "problem_statement_hash": statement_hash,
            "routellm_raw_score": score,
            "embedding_cache_hit": cache_hit,
            "embedding_file_sha256": metadata["embedding_file_sha256"],
            "embedding_prompt_tokens": metadata.get("prompt_tokens"),
        })
        if not offline and not cache_hit and (index % 25 == 0 or index == len(selected)):
            print(f"Embedded {index}/{len(selected)}", file=sys.stderr)
    return results, audit.summary(), credential_source


def assign_ranks_and_bins(score_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(score_rows, key=lambda row: (row["routellm_raw_score"], row["instance_id"]))
    if len(ordered) != 500:
        raise RuntimeError(f"Expected 500 scores, found {len(ordered)}")
    for index, row in enumerate(ordered, start=1):
        row["routellm_rank"] = index
        row["routellm_percentile"] = (index - 1) / (len(ordered) - 1)
        # Exact 167 / 166 / 167 split, preserving raw-score order.
        if index <= 167:
            row["routellm_tertile"] = "Easy"
        elif index <= 333:
            row["routellm_tertile"] = "Medium"
        else:
            row["routellm_tertile"] = "Hard"
    return sorted(ordered, key=lambda row: row["instance_id"])


def safe_spearman(x: Iterable[float], y: Iterable[float]) -> float:
    value = spearmanr(np.asarray(list(x), dtype=float), np.asarray(list(y), dtype=float)).statistic
    return float(value) if math.isfinite(float(value)) else float("nan")


def bootstrap_spearman(
    x: np.ndarray, y: np.ndarray, samples: int = BOOTSTRAP_SAMPLES,
    seed: int = RANDOM_SEED,
) -> tuple[float, float, int]:
    rng = np.random.default_rng(seed)
    values = []
    n = len(x)
    for _ in range(samples):
        indices = rng.integers(0, n, size=n)
        value = safe_spearman(x[indices], y[indices])
        if math.isfinite(value):
            values.append(value)
    if not values:
        return float("nan"), float("nan"), 0
    lower, upper = np.quantile(values, [0.025, 0.975])
    return float(lower), float(upper), len(values)


def partial_spearman_controlling_difficulty(
    scores: np.ndarray, failures: np.ndarray, difficulties: list[str]
) -> float:
    score_ranks = rankdata(scores)
    failure_ranks = rankdata(failures)
    design = np.ones((len(scores), 1 + len(OFFICIAL_DIFFICULTY_ORDER) - 1), dtype=float)
    for column, label in enumerate(OFFICIAL_DIFFICULTY_ORDER[1:], start=1):
        design[:, column] = [difficulty == label for difficulty in difficulties]
    score_residual = score_ranks - design @ np.linalg.lstsq(design, score_ranks, rcond=None)[0]
    failure_residual = failure_ranks - design @ np.linalg.lstsq(design, failure_ranks, rcond=None)[0]
    return float(np.corrcoef(score_residual, failure_residual)[0, 1])


def bootstrap_partial_spearman(
    scores: np.ndarray, failures: np.ndarray, difficulties: list[str]
) -> tuple[float, float, int]:
    rng = np.random.default_rng(RANDOM_SEED + 1)
    values = []
    difficulties_array = np.asarray(difficulties, dtype=object)
    for _ in range(BOOTSTRAP_SAMPLES):
        indices = rng.integers(0, len(scores), size=len(scores))
        try:
            value = partial_spearman_controlling_difficulty(
                scores[indices], failures[indices], difficulties_array[indices].tolist()
            )
        except np.linalg.LinAlgError:
            continue
        if math.isfinite(value):
            values.append(value)
    lower, upper = np.quantile(values, [0.025, 0.975])
    return float(lower), float(upper), len(values)


def wilson_interval(successes: int, n: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if n == 0:
        return float("nan"), float("nan")
    p = successes / n
    denominator = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denominator
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return center - margin, center + margin


def compute_question_difficulty(
    score_rows: list[dict[str, Any]], swe_rows: list[dict[str, Any]],
    exclude_null: bool,
) -> list[dict[str, Any]]:
    results_by_question: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in swe_rows:
        results_by_question[row["instance_id"]].append(row)
    output = []
    for score in score_rows:
        records = results_by_question[score["instance_id"]]
        nulls = sum(row["resolved"] is None for row in records)
        successes = sum(row["resolved"] is True for row in records)
        denominator = len(records) - nulls if exclude_null else len(records)
        failures = denominator - successes
        output.append({
            **{key: score[key] for key in [
                "instance_id", "repo", "official_difficulty", "problem_statement_hash",
                "routellm_raw_score", "routellm_rank", "routellm_percentile", "routellm_tertile",
            ]},
            "model_result_count": len(records),
            "valid_result_count": len(records) - nulls,
            "resolved_null_count": nulls,
            "success_count": successes,
            "failure_count": failures,
            "empirical_success_rate": successes / denominator,
            "empirical_failure_rate": failures / denominator,
            "analysis_definition": "exclude_null" if exclude_null else "null_as_not_success",
        })
    return output


def compute_model_outputs(
    score_rows: list[dict[str, Any]], swe_rows: list[dict[str, Any]],
    exclude_null: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    score_by_id = {row["instance_id"]: row for row in score_rows}
    by_model: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for result in swe_rows:
        score = score_by_id[result["instance_id"]]
        by_model[result["language_model"]].append({**result, **score})
    curves: list[dict[str, Any]] = []
    metrics: list[dict[str, Any]] = []
    tertile_order = ["Easy", "Medium", "Hard"]
    for model_name in sorted(by_model, key=str.lower):
        rows = by_model[model_name]
        if len(rows) != 500:
            raise RuntimeError(f"Model {model_name} has {len(rows)} rows, expected 500")
        rates = {}
        for tertile in tertile_order:
            group = [row for row in rows if row["routellm_tertile"] == tertile]
            nulls = sum(row["resolved"] is None for row in group)
            valid = len(group) - nulls
            successes = sum(row["resolved"] is True for row in group)
            denominator = valid if exclude_null else len(group)
            low, high = wilson_interval(successes, denominator)
            rate = successes / denominator
            rates[tertile] = rate
            curves.append({
                "language_model": model_name,
                "difficulty_bin": tertile,
                "total_question_count": len(group),
                "valid_result_count": valid,
                "resolved_null_count": nulls,
                "success_count": successes,
                "failure_count": denominator - successes,
                "success_rate": rate,
                "wilson_95_low": low,
                "wilson_95_high": high,
                "analysis_definition": "exclude_null" if exclude_null else "null_as_not_success",
                "representative_model": model_name in REPRESENTATIVE_MODELS,
            })
        metric_rows = [row for row in rows if not (exclude_null and row["resolved"] is None)]
        success_values = np.asarray([row["resolved"] is True for row in metric_rows], dtype=int)
        failure_values = 1 - success_values
        scores = np.asarray([row["routellm_raw_score"] for row in metric_rows], dtype=float)
        monotonic = rates["Easy"] >= rates["Medium"] >= rates["Hard"]
        metrics.append({
            "language_model": model_name,
            "question_count": len(rows),
            "valid_result_count": len(metric_rows),
            "resolved_null_count": len(rows) - len(metric_rows) if exclude_null else sum(row["resolved"] is None for row in rows),
            "easy_success_rate": rates["Easy"],
            "medium_success_rate": rates["Medium"],
            "hard_success_rate": rates["Hard"],
            "easy_to_hard_drop_pp": 100 * (rates["Easy"] - rates["Hard"]),
            "monotonic_easy_ge_medium_ge_hard": monotonic,
            "score_success_spearman": safe_spearman(scores, success_values),
            "score_failure_roc_auc": float(roc_auc_score(failure_values, scores)),
            "analysis_definition": "exclude_null" if exclude_null else "null_as_not_success",
            "representative_model": model_name in REPRESENTATIVE_MODELS,
        })
    return curves, metrics


def aggregate_metrics(
    question_rows: list[dict[str, Any]], model_metrics: list[dict[str, Any]]
) -> dict[str, Any]:
    scores = np.asarray([row["routellm_raw_score"] for row in question_rows], dtype=float)
    failures = np.asarray([row["empirical_failure_rate"] for row in question_rows], dtype=float)
    difficulties = [row["official_difficulty"] for row in question_rows]
    rho = safe_spearman(scores, failures)
    ci_low, ci_high, bootstrap_valid = bootstrap_spearman(scores, failures)
    official_numeric = np.asarray([OFFICIAL_DIFFICULTY_ORDER.index(value) for value in difficulties], dtype=float)
    official_rho = safe_spearman(scores, official_numeric)
    partial_rho = partial_spearman_controlling_difficulty(scores, failures, difficulties)
    partial_low, partial_high, partial_valid = bootstrap_partial_spearman(scores, failures, difficulties)
    grouped = []
    for label in OFFICIAL_DIFFICULTY_ORDER:
        values = scores[np.asarray([value == label for value in difficulties])]
        grouped.append({
            "official_difficulty": label,
            "question_count": int(values.size),
            "mean_raw_score": float(np.mean(values)),
            "median_raw_score": float(np.median(values)),
            "mean_percentile": float(np.mean([
                row["routellm_percentile"] for row in question_rows if row["official_difficulty"] == label
            ])),
        })
    kruskal_result = kruskal(*[
        scores[np.asarray([value == label for value in difficulties])]
        for label in OFFICIAL_DIFFICULTY_ORDER
    ])
    score_order = np.argsort(scores, kind="stable")
    decile_rows = []
    for decile, indices in enumerate(np.array_split(score_order, 10), start=1):
        decile_rows.append({
            "decile": decile,
            "question_count": int(len(indices)),
            "mean_raw_score": float(np.mean(scores[indices])),
            "mean_failure_rate": float(np.mean(failures[indices])),
        })
    decile_monotonic_steps = sum(
        decile_rows[index]["mean_failure_rate"] <= decile_rows[index + 1]["mean_failure_rate"]
        for index in range(9)
    )
    monotonic_count = sum(bool(row["monotonic_easy_ge_medium_ge_hard"]) for row in model_metrics)
    drops = np.asarray([row["easy_to_hard_drop_pp"] for row in model_metrics], dtype=float)
    if ci_low > 0 and monotonic_count >= math.ceil(2 * len(model_metrics) / 3) and np.median(drops) > 0:
        conclusion = "support"
    elif rho > 0 and ci_high > 0 and monotonic_count >= math.ceil(len(model_metrics) / 2) and np.median(drops) > 0:
        conclusion = "partial_support"
    else:
        conclusion = "not_support"
    return {
        "question_count": len(question_rows),
        "model_count": len(model_metrics),
        "score_failure_spearman": rho,
        "score_failure_spearman_bootstrap_95_ci": [ci_low, ci_high],
        "bootstrap_samples_requested": BOOTSTRAP_SAMPLES,
        "bootstrap_samples_valid": bootstrap_valid,
        "official_difficulty_score_spearman": official_rho,
        "official_difficulty_groups": grouped,
        "official_difficulty_kruskal_h": float(kruskal_result.statistic),
        "official_difficulty_kruskal_p": float(kruskal_result.pvalue),
        "score_failure_partial_spearman_controlling_official_difficulty": partial_rho,
        "partial_spearman_bootstrap_95_ci": [partial_low, partial_high],
        "partial_bootstrap_samples_valid": partial_valid,
        "failure_trend_by_score_decile": decile_rows,
        "nondecreasing_decile_steps_out_of_9": decile_monotonic_steps,
        "monotonic_model_count": monotonic_count,
        "nonmonotonic_model_count": len(model_metrics) - monotonic_count,
        "easy_to_hard_drop_pp_median": float(np.median(drops)),
        "easy_to_hard_drop_pp_min": float(np.min(drops)),
        "easy_to_hard_drop_pp_max": float(np.max(drops)),
        "conclusion": conclusion,
        "decision_rule": {
            "support": "bootstrap CI lower > 0; >= 2/3 models monotonic; median Easy-to-Hard drop > 0",
            "partial_support": "rho > 0 and CI upper > 0; >= 1/2 models monotonic; median drop > 0",
            "not_support": "otherwise",
        },
    }


def create_null_sensitivity(
    primary_aggregate: dict[str, Any], sensitivity_aggregate: dict[str, Any],
    primary_metrics: list[dict[str, Any]], sensitivity_metrics: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rows = [{
        "scope": "aggregate",
        "language_model": "ALL_MODELS",
        "null_record_count": 9,
        "primary_score_failure_spearman": primary_aggregate["score_failure_spearman"],
        "sensitivity_score_failure_spearman": sensitivity_aggregate["score_failure_spearman"],
        "spearman_delta": sensitivity_aggregate["score_failure_spearman"] - primary_aggregate["score_failure_spearman"],
        "primary_conclusion": primary_aggregate["conclusion"],
        "sensitivity_conclusion": sensitivity_aggregate["conclusion"],
        "conclusion_changed": primary_aggregate["conclusion"] != sensitivity_aggregate["conclusion"],
    }]
    sensitivity_by_model = {row["language_model"]: row for row in sensitivity_metrics}
    for primary in primary_metrics:
        other = sensitivity_by_model[primary["language_model"]]
        rows.append({
            "scope": "model",
            "language_model": primary["language_model"],
            "null_record_count": primary["resolved_null_count"],
            "primary_easy_success_rate": primary["easy_success_rate"],
            "sensitivity_easy_success_rate": other["easy_success_rate"],
            "primary_medium_success_rate": primary["medium_success_rate"],
            "sensitivity_medium_success_rate": other["medium_success_rate"],
            "primary_hard_success_rate": primary["hard_success_rate"],
            "sensitivity_hard_success_rate": other["hard_success_rate"],
            "primary_drop_pp": primary["easy_to_hard_drop_pp"],
            "sensitivity_drop_pp": other["easy_to_hard_drop_pp"],
            "primary_monotonic": primary["monotonic_easy_ge_medium_ge_hard"],
            "sensitivity_monotonic": other["monotonic_easy_ge_medium_ge_hard"],
            "monotonicity_changed": primary["monotonic_easy_ge_medium_ge_hard"] != other["monotonic_easy_ge_medium_ge_hard"],
            "primary_score_success_spearman": primary["score_success_spearman"],
            "sensitivity_score_success_spearman": other["score_success_spearman"],
            "primary_failure_auc": primary["score_failure_roc_auc"],
            "sensitivity_failure_auc": other["score_failure_roc_auc"],
        })
    return rows


def configure_plot_style() -> None:
    plt.rcParams.update({
        "figure.facecolor": "white", "axes.facecolor": "white",
        "axes.edgecolor": "#334155", "axes.labelcolor": "#1f2937",
        "text.color": "#1f2937", "xtick.color": "#475569", "ytick.color": "#475569",
        "grid.color": "#e2e8f0", "grid.linewidth": 0.8,
        "font.family": "DejaVu Sans", "font.size": 10,
    })


def plot_figures(output: Path) -> None:
    """Read only generated CSVs so all plotted data has a tabular source."""
    configure_plot_style()
    figures = output / "figures"
    figures.mkdir(parents=True, exist_ok=True)
    question_df = pd.read_csv(output / "question_empirical_difficulty.csv")
    score_df = pd.read_csv(output / "question_routellm_scores.csv")
    curves_df = pd.read_csv(output / "model_difficulty_curves.csv")

    fig, ax = plt.subplots(figsize=(9, 6))
    ax.scatter(
        question_df["routellm_raw_score"], question_df["empirical_failure_rate"],
        s=18, alpha=0.28, color="#2563eb", edgecolors="none", label="500 questions",
    )
    ordered = question_df.sort_values("routellm_raw_score")
    deciles = np.array_split(ordered, 10)
    decile_x = [frame["routellm_raw_score"].mean() for frame in deciles]
    decile_y = [frame["empirical_failure_rate"].mean() for frame in deciles]
    ax.plot(decile_x, decile_y, color="#c2410c", marker="o", linewidth=2.2, label="Equal-count decile means")
    ax.set_title("Cross-model failure rate vs RouteLLM score")
    ax.set_xlabel("RouteLLM raw strong-model-need score")
    ax.set_ylabel("Empirical failure rate across 34 models")
    ax.set_ylim(-0.03, 1.03)
    ax.grid(True, alpha=0.8)
    ax.legend(frameon=False)
    fig.tight_layout()
    fig.savefig(figures / "aggregate_failure_vs_routellm.png", dpi=180)
    plt.close(fig)

    reps = [model for model in REPRESENTATIVE_MODELS if model in set(curves_df["language_model"])]
    fig, axes = plt.subplots(2, 4, figsize=(15, 8), sharex=True, sharey=True)
    for ax, model_name in zip(axes.flat, reps):
        frame = curves_df[curves_df["language_model"] == model_name].copy()
        frame["difficulty_bin"] = pd.Categorical(frame["difficulty_bin"], ["Easy", "Medium", "Hard"], ordered=True)
        frame = frame.sort_values("difficulty_bin")
        y = frame["success_rate"].to_numpy()
        low = frame["wilson_95_low"].to_numpy()
        high = frame["wilson_95_high"].to_numpy()
        ax.errorbar(
            [0, 1, 2], y, yerr=[y - low, high - y], color="#2563eb",
            marker="o", linewidth=2, capsize=3,
        )
        ax.set_title(model_name, fontsize=10)
        ax.set_xticks([0, 1, 2], ["Easy", "Medium", "Hard"])
        ax.grid(True, axis="y")
    for ax in axes[:, 0]:
        ax.set_ylabel("Success rate")
    fig.suptitle("Representative model success rates by RouteLLM tertile", fontsize=14)
    fig.supxlabel("Raw-score tertile (167 / 166 / 167 questions)")
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    fig.savefig(figures / "representative_model_curves.png", dpi=180)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(10, 7))
    for model_name, frame in curves_df.groupby("language_model"):
        frame = frame.set_index("difficulty_bin").loc[["Easy", "Medium", "Hard"]]
        ax.plot([0, 1, 2], frame["success_rate"], color="#64748b", alpha=0.35, linewidth=1)
    median_curve = curves_df.groupby("difficulty_bin")["success_rate"].median().reindex(["Easy", "Medium", "Hard"])
    ax.plot([0, 1, 2], median_curve, color="#c2410c", linewidth=3, marker="o", label="Median across 34 models")
    ax.set_title("All 34 model success curves by RouteLLM tertile")
    ax.set_xlabel("Raw-score tertile")
    ax.set_ylabel("Success rate")
    ax.set_xticks([0, 1, 2], ["Easy", "Medium", "Hard"])
    ax.set_ylim(0, 1)
    ax.grid(True, axis="y")
    ax.legend(frameon=False)
    fig.tight_layout()
    fig.savefig(figures / "all_models_easy_medium_hard.png", dpi=180)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(10, 6))
    grouped_values = [
        score_df.loc[score_df["official_difficulty"] == label, "routellm_raw_score"].to_numpy()
        for label in OFFICIAL_DIFFICULTY_ORDER
    ]
    box = ax.boxplot(grouped_values, tick_labels=OFFICIAL_DIFFICULTY_ORDER, patch_artist=True, showfliers=True)
    for patch in box["boxes"]:
        patch.set_facecolor("#dbeafe")
        patch.set_edgecolor("#2563eb")
    for median in box["medians"]:
        median.set_color("#c2410c")
        median.set_linewidth(2)
    ax.set_title("RouteLLM score by official SWE-bench difficulty")
    ax.set_xlabel("Official difficulty")
    ax.set_ylabel("RouteLLM raw strong-model-need score")
    ax.grid(True, axis="y")
    fig.tight_layout()
    fig.savefig(figures / "official_vs_routellm_difficulty.png", dpi=180)
    plt.close(fig)


def installed_versions() -> dict[str, str]:
    names = [
        "numpy", "pandas", "pyarrow", "scipy", "scikit-learn",
        "matplotlib", "safetensors", "openai",
    ]
    return {name: importlib.metadata.version(name) for name in names}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode", choices=["preflight", "full"], default="full",
        help="preflight scores exactly five questions; full requires all 500",
    )
    parser.add_argument(
        "--embedding-gateway", choices=["closeai", "openrouter"], default="closeai",
        help="OpenAI-compatible embedding gateway; never changes the locked embedding model",
    )
    parser.add_argument("--offline", action="store_true", help="Forbid all API/download calls")
    args = parser.parse_args()

    phase_dir = Path(__file__).resolve().parents[1]
    openhands_dir = phase_dir.parent
    repo_root = phase_dir.parents[3]
    cache = phase_dir / ".cache"
    output = phase_dir / "outputs"
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    config = embedding_config(repo_root, args.embedding_gateway)

    swe_rows, verified, instances_path, verified_path = load_sources(phase_dir)
    routellm_repo = prepare_routellm(cache, args.offline)
    source_contract = verify_official_source_contract(routellm_repo)
    checkpoint_path = download_checkpoint(cache, args.offline)
    model = MFCheckpoint(checkpoint_path)

    limit = PREFLIGHT_COUNT if args.mode == "preflight" else None
    score_rows, request_audit, credential_source = score_questions(
        verified, cache, model, args.offline, limit, repo_root, config
    )
    if request_audit["completion_request_count"] != 0:
        raise RuntimeError("Completion request detected; aborting")

    if args.mode == "preflight":
        if len(score_rows) != PREFLIGHT_COUNT:
            raise RuntimeError("Preflight did not produce exactly five scores")
        preflight = {
            "status": "passed",
            "question_count": len(score_rows),
            "finite_score_count": sum(math.isfinite(row["routellm_raw_score"]) for row in score_rows),
            "embedding_dimensions": EMBEDDING_DIMENSIONS,
            "request_audit": request_audit,
            "completion_calls": 0,
            "credential_source": credential_source,
            "created_at_utc": now_utc(),
        }
        preflight["gateway"] = config["gateway"]
        preflight["request_model"] = config["request_model"]
        preflight["upstream_assertion"] = config["upstream_assertion"]
        write_json(cache / f"preflight_audit_{config['gateway']}.json", preflight)
        print(json.dumps(preflight, ensure_ascii=False, indent=2))
        return 0

    score_rows = assign_ranks_and_bins(score_rows)
    if len(score_rows) != 500 or len({row["instance_id"] for row in score_rows}) != 500:
        raise RuntimeError("500 questions do not each have exactly one score")
    if not all(math.isfinite(row["routellm_raw_score"]) for row in score_rows):
        raise RuntimeError("Non-finite RouteLLM score found")
    bin_counts = Counter(row["routellm_tertile"] for row in score_rows)
    if bin_counts != Counter({"Easy": 167, "Medium": 166, "Hard": 167}):
        raise RuntimeError(f"Unexpected tertile counts: {bin_counts}")

    primary_question = compute_question_difficulty(score_rows, swe_rows, exclude_null=False)
    sensitivity_question = compute_question_difficulty(score_rows, swe_rows, exclude_null=True)
    primary_curves, primary_model_metrics = compute_model_outputs(score_rows, swe_rows, exclude_null=False)
    sensitivity_curves, sensitivity_model_metrics = compute_model_outputs(score_rows, swe_rows, exclude_null=True)
    primary_aggregate = aggregate_metrics(primary_question, primary_model_metrics)
    sensitivity_aggregate = aggregate_metrics(sensitivity_question, sensitivity_model_metrics)
    null_sensitivity = create_null_sensitivity(
        primary_aggregate, sensitivity_aggregate, primary_model_metrics, sensitivity_model_metrics
    )

    score_output_rows = [
        {key: row[key] for key in [
            "instance_id", "repo", "official_difficulty", "problem_statement_hash",
            "routellm_raw_score", "routellm_rank", "routellm_percentile", "routellm_tertile",
        ]}
        for row in score_rows
    ]
    write_csv(output / "question_routellm_scores.csv", score_output_rows)
    write_csv(output / "question_empirical_difficulty.csv", primary_question)
    write_csv(output / "model_difficulty_curves.csv", primary_curves)
    write_csv(output / "model_validity_metrics.csv", primary_model_metrics)
    write_csv(output / "null_sensitivity_analysis.csv", null_sensitivity)

    preflight_path = cache / f"preflight_audit_{config['gateway']}.json"
    if not preflight_path.exists():
        raise RuntimeError("Five-question preflight audit is missing; run --mode preflight first")
    preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
    if preflight.get("status") != "passed" or preflight.get("completion_calls") != 0:
        raise RuntimeError("Preflight audit did not pass the embedding-only gate")

    aggregate = {
        "analysis_name": "Phase 1B RouteLLM difficulty validity",
        "score_term": "strong-model-need score",
        "primary_analysis": primary_aggregate,
        "null_excluded_sensitivity": sensitivity_aggregate,
        "null_sensitivity_changes_conclusion": primary_aggregate["conclusion"] != sensitivity_aggregate["conclusion"],
        "data_counts": {
            "question_count": 500,
            "model_count": 34,
            "model_question_result_count": 17_000,
            "resolved_null_count": 9,
            "tertile_question_counts": dict(bin_counts),
        },
        "score_distribution": {
            "minimum": float(min(row["routellm_raw_score"] for row in score_rows)),
            "p25": float(np.quantile([row["routellm_raw_score"] for row in score_rows], 0.25)),
            "median": float(np.median([row["routellm_raw_score"] for row in score_rows])),
            "mean": float(np.mean([row["routellm_raw_score"] for row in score_rows])),
            "p75": float(np.quantile([row["routellm_raw_score"] for row in score_rows], 0.75)),
            "maximum": float(max(row["routellm_raw_score"] for row in score_rows)),
        },
        "representative_models": [
            row for row in primary_model_metrics if row["language_model"] in REPRESENTATIVE_MODELS
        ],
        "models_with_nonmonotonic_curves": [
            row["language_model"] for row in primary_model_metrics
            if not row["monotonic_easy_ge_medium_ge_hard"]
        ],
    }
    write_json(output / "aggregate_validation.json", aggregate)

    plot_figures(output)

    # The timestamp is the latest immutable embedding creation time, so offline
    # reruns are byte-stable rather than recording the wall clock of each rerun.
    embedding_metadata = list((cache / f"embeddings_{config['gateway']}").glob("*.json"))
    score_frozen_at = max(
        json.loads(path.read_text(encoding="utf-8"))["created_at_utc"]
        for path in embedding_metadata
    )
    manifest = {
        "run_name": "ClawRouter OpenHands Phase 1B",
        "score_frozen_at_utc": score_frozen_at,
        "execution_mode": "offline_replay" if args.offline else "online_missing-cache-only",
        "data": {
            "openhands_dataset": OPENHANDS_DATASET,
            "openhands_tag": OPENHANDS_REVISION,
            "openhands_hf_commit": OPENHANDS_HF_COMMIT,
            "swebench_dataset": SWEBENCH_DATASET,
            "swebench_commit": SWEBENCH_REVISION,
            "input_files": {
                "openhands_instances": {"sha256": sha256(instances_path), "rows": 40_643},
                "swebench_verified": {"sha256": sha256(verified_path), "rows": 500},
            },
        },
        "routellm": {
            "repository": ROUTELLM_REPO,
            "git_commit": ROUTELLM_COMMIT,
            "router": "mf",
            "checkpoint": CHECKPOINT,
            "checkpoint_revision": CHECKPOINT_REVISION,
            "checkpoint_sha256": sha256(checkpoint_path),
            "strong_model": STRONG_MODEL,
            "weak_model": WEAK_MODEL,
            "strong_model_id": STRONG_MODEL_ID,
            "weak_model_id": WEAK_MODEL_ID,
            "source_contract": source_contract,
            "implementation": "equivalent NumPy float32 lower-level interface; no PyTorch runtime",
        },
        "embeddings": {
            "provider_gateway": config["gateway"],
            "api_base": config["api_base"],
            "semantic_model": EMBEDDING_SEMANTIC_MODEL,
            "request_model": config["request_model"],
            "dimensions": EMBEDDING_DIMENSIONS,
            "cached_embedding_count": len(embedding_metadata),
            "completion_calls": 0,
            "preflight_audit": preflight,
            "current_run_request_audit": request_audit,
            "credential_source": credential_source,
            "credential_saved": False,
            "controlled_deviation": config["upstream_assertion"],
        },
        "runtime": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "dependencies": installed_versions(),
        },
        "parameters": {
            "question_count": 500,
            "model_count": 34,
            "primary_success": "resolved is true",
            "primary_null_handling": "resolved null is not success",
            "sensitivity_null_handling": "exclude resolved null",
            "bootstrap_samples": BOOTSTRAP_SAMPLES,
            "random_seed": RANDOM_SEED,
            "tertile_rule": "stable raw-score order; 167 Easy, 166 Medium, 167 Hard",
            "cost_fields_used": False,
            "gold_patch_or_answer_fields_used": False,
        },
        "validation": {
            "unique_finite_scores": len(score_rows) == 500 and all(math.isfinite(row["routellm_raw_score"]) for row in score_rows),
            "model_question_rows": len(swe_rows),
            "models_in_metrics": len(primary_model_metrics),
            "tertile_counts": dict(bin_counts),
            "figures_from_csv": True,
        },
    }
    write_json(output / "run_manifest.json", manifest)

    print(json.dumps({
        "status": "complete",
        "score_range": [aggregate["score_distribution"]["minimum"], aggregate["score_distribution"]["maximum"]],
        "spearman": primary_aggregate["score_failure_spearman"],
        "spearman_ci": primary_aggregate["score_failure_spearman_bootstrap_95_ci"],
        "monotonic_models": primary_aggregate["monotonic_model_count"],
        "median_drop_pp": primary_aggregate["easy_to_hard_drop_pp_median"],
        "conclusion": primary_aggregate["conclusion"],
        "completion_calls": 0,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
