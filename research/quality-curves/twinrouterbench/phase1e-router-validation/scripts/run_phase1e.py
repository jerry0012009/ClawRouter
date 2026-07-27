#!/usr/bin/env python3
"""Phase 1E: offline-capable RouteLLM MF and P2L validation.

The only permitted network inference is ``/embeddings`` for RouteLLM MF.
No completion endpoint is reachable through this program. P2L runs locally on
CPU in FP32. Raw embeddings and P2L outputs are cached per context and view so
all analysis, calibration, policy calculations, CSV/Parquet outputs, and figures
can be rebuilt with ``--offline`` and without credentials.
"""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import random
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Iterable, Sequence

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psutil
import pyarrow as pa
import pyarrow.parquet as pq
import scipy
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.stats import kendalltau, spearmanr
from safetensors.numpy import load_file
from sklearn.compose import ColumnTransformer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    balanced_accuracy_score,
    cohen_kappa_score,
    confusion_matrix,
    f1_score,
    log_loss,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
import tiktoken
import torch
from transformers import AutoTokenizer
import yaml


PHASE_NAME = "published-label product analysis"
RANDOM_SEED = 20260726
BOOTSTRAP_SAMPLES = 10_000
PREFLIGHT_COUNT = 20
TIER_ORDER = ("low", "mid", "mid_high", "high")
TIER_IDS = np.arange(4, dtype=int)
VIEWS = {
    "last_message": "last_message_text",
    "full_agent_context": "acu_head_tail_context",
}
ROUTERS = ("routellm_mf", "p2l_135m")

ROUTELLM_REPOSITORY = "https://github.com/lm-sys/RouteLLM.git"
ROUTELLM_COMMIT = "0b64fdafe049e596a3f5657c219329f24af24198"
ROUTELLM_CHECKPOINT = "routellm/mf_gpt4_augmented"
ROUTELLM_REVISION = "5eb3dc745cbe7cb16ca342ceb83b7f6ecf8c77c5"
ROUTELLM_CHECKPOINT_SHA256 = "bfc93d473b48f8b85ce719f0d7e8bb86a139fa052e8b0c3ac387eabf45e47293"
ROUTELLM_STRONG = "gpt-4-1106-preview"
ROUTELLM_WEAK = "mixtral-8x7b-instruct-v0.1"
ROUTELLM_STRONG_ID = 24
ROUTELLM_WEAK_ID = 36
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536
EMBEDDING_MAX_TOKENS = 8191
EMBEDDING_PRICE_PER_MILLION_INPUT_TOKENS = 0.03

P2L_REPOSITORY = "https://github.com/lmarena/p2l.git"
P2L_COMMIT = "a905fa5ea94a75fdf157d73e27bd3c63ac1ebeb1"
P2L_MODEL = "lmarena-ai/p2l-135m-grk-01112025"
P2L_REVISION = "2b642ae1ce114fb54e468e4c676f122135bcf11b"
P2L_MODEL_SHA256 = "1ac660b56b95e08fdc48523423c23d8c21d50cd65005d079c781e0cdffba4790"
P2L_MODEL_LIST_SHA256 = "7a4e145dbbe841b986d570e5be36fd634f7451f9f0676599cf465cac32601e52"
P2L_TOKENIZER_SHA256 = "1c704200f743419b33efaebdff006385c093916fa0e1907f09e2b665b4c03ccc"
P2L_CONFIG_SHA256 = "56c264c231626d2605d6816cb32efad49afbcfaf3aec97e0a994acd8ffedc2e1"
P2L_PARAMETER_COUNT = 134_591_171
P2L_BETA_DIM = 130
P2L_MAX_TOKENS = 8192
P2L_THREADS = 4
P2L_MEMORY_GATE_GIB = 7.0
P2L_ATTENTION_IMPLEMENTATION = "sdpa"

EXPECTED_INPUT_SHA256 = "287ae2e5087bbd731c1513a81a94ccf936ad356c25ca3a78f652dcb91129b6e4"
EXPECTED_ROWS = 970
EXPECTED_INSTANCES = 520
EXPECTED_STRONG = 634
EXPECTED_WEAK = 336
EXPECTED_LABEL_COUNTS = {"low": 689, "mid": 62, "mid_high": 49, "high": 170}
EXPECTED_SPLITS = {"train": 586, "validation": 218, "test": 166}


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


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False, default=json_default) + "\n", encoding="utf-8")


def json_default(value: Any) -> Any:
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def write_csv(path: Path, frame: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(path, index=False, lineterminator="\n")


def run_git(args: Sequence[str], cwd: Path) -> str:
    result = subprocess.run(
        ["git", *args], cwd=cwd, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def dependency_versions() -> dict[str, str]:
    names = [
        "numpy", "pandas", "pyarrow", "scipy", "scikit-learn", "matplotlib",
        "PyYAML", "psutil", "safetensors", "openai", "httpx", "tiktoken",
        "torch", "transformers", "huggingface-hub",
    ]
    return {name: importlib.metadata.version(name) for name in names}


def load_env_secret(repo_root: Path, name: str) -> tuple[str | None, str]:
    value = os.environ.get(name)
    if value:
        return value, "environment"
    env_path = repo_root / ".env"
    if env_path.exists():
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, candidate = line.split("=", 1)
            if key.strip() == name and candidate.strip():
                candidate = candidate.strip().strip("\"'")
                return candidate, "repository .env (ignored)"
    return None, "not found"


@dataclass(frozen=True)
class Paths:
    repo_root: Path
    phase_dir: Path
    foundation: Path
    input_parquet: Path
    output: Path
    cache: Path
    routellm_repo: Path
    routellm_checkpoint: Path
    p2l_repo: Path
    p2l_model: Path


def resolve_paths() -> Paths:
    phase_dir = Path(__file__).resolve().parents[1]
    repo_root = phase_dir.parents[3]
    foundation = phase_dir.parent / "phase1d-foundation"
    openhands = repo_root / "research/quality-curves/openhands"
    return Paths(
        repo_root=repo_root,
        phase_dir=phase_dir,
        foundation=foundation,
        input_parquet=foundation / "outputs/acu_step_contexts.parquet",
        output=phase_dir / "outputs",
        cache=phase_dir / ".cache",
        routellm_repo=openhands / "phase1b/.cache/RouteLLM",
        routellm_checkpoint=openhands / (
            "phase1b/.cache/checkpoint/routellm__mf_gpt4_augmented/"
            f"{ROUTELLM_REVISION}/model.safetensors"
        ),
        p2l_repo=openhands / "phase1c-p2l/.cache/p2l",
        p2l_model=openhands / "phase1c-p2l/.cache/model",
    )


def validate_input(paths: Paths) -> pd.DataFrame:
    if not paths.input_parquet.exists() or sha256(paths.input_parquet) != EXPECTED_INPUT_SHA256:
        raise RuntimeError("Phase 1D input is missing or differs from the frozen SHA-256")
    frame = pd.read_parquet(paths.input_parquet)
    required = {
        "context_id", "benchmark", "scenario", "instance_id", "step_index",
        "target_tier", "target_tier_id", "label_confidence", "pipeline_stage",
        "last_message_text", "acu_head_tail_context", "split", "cv_fold",
        "leakage_group_id", "analysis_scope",
    }
    missing = sorted(required - set(frame.columns))
    if missing:
        raise RuntimeError(f"Phase 1D input lacks required fields: {missing}")
    if len(frame) != EXPECTED_ROWS or frame.context_id.nunique() != EXPECTED_ROWS:
        raise RuntimeError("Expected exactly 970 unique Phase 1D contexts")
    if frame.instance_id.nunique() != EXPECTED_INSTANCES:
        raise RuntimeError("Expected exactly 520 instances")
    if frame.target_tier.value_counts().to_dict() != EXPECTED_LABEL_COUNTS:
        raise RuntimeError("Published label counts differ from the frozen contract")
    if frame.split.value_counts().to_dict() != EXPECTED_SPLITS:
        raise RuntimeError("Frozen split counts differ")
    weak = int((frame.label_confidence == "weak_degradation_search").sum())
    if weak != EXPECTED_WEAK or len(frame) - weak != EXPECTED_STRONG:
        raise RuntimeError("Strong/weak metadata counts differ from the frozen contract")
    if not np.array_equal(frame.target_tier_id.to_numpy(), frame.target_tier.map(dict(zip(TIER_ORDER, range(4)))).to_numpy()):
        raise RuntimeError("target_tier and target_tier_id disagree")
    for key in ("instance_id", "leakage_group_id"):
        if int(frame.groupby(key).split.nunique().max()) != 1:
            raise RuntimeError(f"Leakage: {key} crosses the frozen split")
    return frame.sort_values("context_id").reset_index(drop=True)


def verify_assets(paths: Paths) -> dict[str, Any]:
    if run_git(["rev-parse", "HEAD"], paths.routellm_repo) != ROUTELLM_COMMIT:
        raise RuntimeError("Cached RouteLLM checkout is not at the frozen commit")
    if sha256(paths.routellm_checkpoint) != ROUTELLM_CHECKPOINT_SHA256:
        raise RuntimeError("Frozen RouteLLM checkpoint checksum mismatch")
    if run_git(["rev-parse", "HEAD"], paths.p2l_repo) != P2L_COMMIT:
        raise RuntimeError("Cached P2L checkout is not at the frozen commit")
    expected = {
        "model.safetensors": P2L_MODEL_SHA256,
        "model_list.json": P2L_MODEL_LIST_SHA256,
        "tokenizer.json": P2L_TOKENIZER_SHA256,
        "config.json": P2L_CONFIG_SHA256,
    }
    for name, digest in expected.items():
        if sha256(paths.p2l_model / name) != digest:
            raise RuntimeError(f"Frozen P2L asset checksum mismatch: {name}")
    route_source = paths.routellm_repo / "routellm/routers/matrix_factorization/model.py"
    p2l_source = paths.p2l_repo / "p2l/model.py"
    if 'self.embedding_model = "text-embedding-3-small"' not in route_source.read_text(encoding="utf-8"):
        raise RuntimeError("RouteLLM source contract changed")
    if '@register_head("rk")' not in p2l_source.read_text(encoding="utf-8"):
        raise RuntimeError("P2L source contract changed")
    return {
        "routellm_source_sha256": sha256(route_source),
        "p2l_model_source_sha256": sha256(p2l_source),
        "p2l_eval_source_sha256": sha256(paths.p2l_repo / "p2l/eval.py"),
        "p2l_model_list_sha256": P2L_MODEL_LIST_SHA256,
    }


class PeakRSS:
    def __init__(self) -> None:
        self.process = psutil.Process()
        self.peak = self.process.memory_info().rss
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._sample, daemon=True)

    def _sample(self) -> None:
        while not self.stop.wait(0.02):
            self.peak = max(self.peak, self.process.memory_info().rss)

    def __enter__(self) -> "PeakRSS":
        self.thread.start()
        return self

    def __exit__(self, *_: Any) -> None:
        self.stop.set()
        self.thread.join()
        self.peak = max(self.peak, self.process.memory_info().rss)


class MFCheckpoint:
    def __init__(self, checkpoint_path: Path):
        weights = load_file(checkpoint_path)
        actual = {key: tuple(value.shape) for key, value in weights.items()}
        expected = {"P.weight": (64, 128), "text_proj.0.weight": (128, 1536), "classifier.0.weight": (1, 128)}
        if actual != expected:
            raise RuntimeError(f"Unexpected MF checkpoint tensors: {actual}")
        self.models = weights["P.weight"].astype(np.float32)
        self.projection = weights["text_proj.0.weight"].astype(np.float32)
        self.classifier = weights["classifier.0.weight"].astype(np.float32)

    def score(self, embedding: np.ndarray) -> float:
        if embedding.shape != (EMBEDDING_DIMENSIONS,):
            raise RuntimeError(f"Expected 1536-D embedding, got {embedding.shape}")
        vectors = self.models[[ROUTELLM_STRONG_ID, ROUTELLM_WEAK_ID]]
        vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
        prompt = self.projection @ embedding.astype(np.float32)
        logits = (vectors * prompt) @ self.classifier.T
        delta = np.float32(logits[0, 0] - logits[1, 0])
        value = float(np.float32(1.0) / (np.float32(1.0) + np.exp(-delta, dtype=np.float32)))
        if not math.isfinite(value):
            raise RuntimeError("RouteLLM produced a non-finite score")
        return value


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
        return {
            "request_count": len(self.paths),
            "embedding_request_count": sum(v for k, v in counts.items() if k.endswith("/embeddings")),
            "completion_request_count": sum(v for k, v in counts.items() if "completion" in k or "response" in k),
            "request_paths": dict(sorted(counts.items())),
        }


def embedding_config(paths: Paths, gateway: str, offline: bool = False) -> dict[str, Any]:
    if offline:
        return {
            "gateway": gateway, "api_base": "offline-cache-only",
            "request_model": "openai/text-embedding-3-small" if gateway == "openrouter" else EMBEDDING_MODEL,
            "credential": "OPENROUTER_API_KEY" if gateway == "openrouter" else "PROXY_API_KEY",
            "upstream_assertion": "offline replay of previously validated cache",
        }
    if gateway == "openrouter":
        return {
            "gateway": gateway,
            "api_base": "https://openrouter.ai/api/v1",
            "request_model": "openai/text-embedding-3-small",
            "credential": "OPENROUTER_API_KEY",
            "upstream_assertion": "OpenRouter provider requested as openai; gateway provenance depends on response",
        }
    base, source = load_env_secret(paths.repo_root, "PROXY_BASE_URL")
    if not base or not base.startswith("https://"):
        raise RuntimeError("PROXY_BASE_URL is missing or is not HTTPS")
    return {
        "gateway": "closeai",
        "api_base": base.rstrip("/"),
        "api_base_source": source,
        "request_model": EMBEDDING_MODEL,
        "credential": "PROXY_API_KEY",
        "upstream_assertion": "Compatible gateway advertises text-embedding-3-small; upstream snapshot is not independently attested",
    }


def head_tail_ids(ids: list[int], maximum: int) -> tuple[list[int], bool]:
    if len(ids) <= maximum:
        return ids, False
    head = (maximum + 1) // 2
    return ids[:head] + ids[-(maximum - head):], True


def route_tokenize(text: str) -> tuple[str, int, int, bool]:
    encoding = tiktoken.get_encoding("cl100k_base")
    original = encoding.encode(text, disallowed_special=())
    used_ids, truncated = head_tail_ids(original, EMBEDDING_MAX_TOKENS)
    rendered = encoding.decode(used_ids)
    used = encoding.encode(rendered, disallowed_special=())
    if len(used) > EMBEDDING_MAX_TOKENS:
        used, _ = head_tail_ids(used, EMBEDDING_MAX_TOKENS)
        rendered = encoding.decode(used)
    return rendered, len(original), len(used), truncated


def route_cache_paths(paths: Paths, view: str, context_id: str, request_hash: str, gateway: str) -> tuple[Path, Path]:
    stem = f"{text_hash(context_id)[:16]}__{request_hash[:16]}"
    root = paths.cache / "routellm" / gateway / view
    return root / f"{stem}.npy", root / f"{stem}.json"


def load_route_cache(paths: Paths, view: str, row: pd.Series, config: dict[str, Any]) -> tuple[np.ndarray, dict[str, Any]] | None:
    request_text, original_tokens, used_tokens, truncated = route_tokenize(str(row[VIEWS[view]]))
    request_hash = text_hash(request_text)
    npy, meta = route_cache_paths(paths, view, row.context_id, request_hash, config["gateway"])
    if not npy.exists() or not meta.exists():
        return None
    metadata = json.loads(meta.read_text(encoding="utf-8"))
    required = {
        "context_id": row.context_id, "view": view, "request_text_hash": request_hash,
        "embedding_model": EMBEDDING_MODEL, "embedding_dimensions": EMBEDDING_DIMENSIONS,
        "gateway": config["gateway"], "original_token_count": original_tokens,
        "used_token_count": used_tokens, "truncated": truncated,
    }
    if any(metadata.get(key) != value for key, value in required.items()):
        return None
    vector = np.load(npy, allow_pickle=False).astype(np.float32)
    if vector.shape != (EMBEDDING_DIMENSIONS,) or not np.isfinite(vector).all() or sha256(npy) != metadata["embedding_file_sha256"]:
        raise RuntimeError(f"Invalid RouteLLM cache: {npy}")
    return vector, metadata


def save_route_cache(
    paths: Paths, view: str, row: pd.Series, request_text: str, embedding: np.ndarray,
    config: dict[str, Any], original_tokens: int, used_tokens: int, truncated: bool,
    response_model: str | None, response_prompt_tokens: int | None, latency: float,
) -> dict[str, Any]:
    request_hash = text_hash(request_text)
    npy, meta = route_cache_paths(paths, view, row.context_id, request_hash, config["gateway"])
    npy.parent.mkdir(parents=True, exist_ok=True)
    partial = npy.with_suffix(".part")
    with partial.open("wb") as handle:
        np.save(handle, embedding.astype(np.float32), allow_pickle=False)
    partial.replace(npy)
    metadata = {
        "context_id": row.context_id, "view": view,
        "source_text_hash": text_hash(str(row[VIEWS[view]])), "request_text_hash": request_hash,
        "gateway": config["gateway"], "api_base": config["api_base"],
        "embedding_model": EMBEDDING_MODEL, "request_model": config["request_model"],
        "response_model": response_model, "embedding_dimensions": EMBEDDING_DIMENSIONS,
        "original_token_count": original_tokens, "used_token_count": used_tokens,
        "response_prompt_tokens_batch": response_prompt_tokens, "truncated": truncated,
        "latency_seconds_batch": latency, "embedding_file_sha256": sha256(npy),
        "created_at_utc": now_utc(), "upstream_assertion": config["upstream_assertion"],
    }
    write_json(meta, metadata)
    return metadata


def request_embeddings(
    paths: Paths, items: list[tuple[pd.Series, str, int, int, bool]], view: str,
    config: dict[str, Any], audit: RequestAudit,
) -> None:
    from openai import APIConnectionError, APIStatusError, OpenAI, RateLimitError
    import httpx

    key, _ = load_env_secret(paths.repo_root, config["credential"])
    if not key:
        raise RuntimeError(f"{config['credential']} is unavailable; no alternate router or simulated score will be used")
    client = OpenAI(
        api_key=key, base_url=config["api_base"],
        http_client=httpx.Client(event_hooks={"request": [audit.hook]}, timeout=180.0),
    )
    for start in range(0, len(items), 16):
        batch = items[start:start + 16]
        request: dict[str, Any] = {
            "model": config["request_model"], "input": [item[1] for item in batch],
            "dimensions": EMBEDDING_DIMENSIONS,
        }
        if config["gateway"] == "openrouter":
            request["extra_body"] = {"provider": {"order": ["openai"], "only": ["openai"], "allow_fallbacks": False, "data_collection": "deny"}}
        last_error: Exception | None = None
        response = None
        started = time.perf_counter()
        for attempt in range(8):
            try:
                response = client.embeddings.create(**request)
                break
            except (RateLimitError, APIConnectionError) as exc:
                last_error = exc
            except APIStatusError as exc:
                if exc.status_code not in {408, 409, 429, 500, 502, 503, 504}:
                    raise RuntimeError(f"Embedding request failed with HTTP {exc.status_code}") from exc
                last_error = exc
            if attempt < 7:
                time.sleep(min(60.0, 2.0 ** attempt) + random.Random(RANDOM_SEED + start + attempt).uniform(0, 0.25))
        if response is None:
            raise RuntimeError(f"Embedding request exhausted retries: {type(last_error).__name__}") from last_error
        latency = time.perf_counter() - started
        if len(response.data) != len(batch):
            raise RuntimeError("Embedding response cardinality differs from request")
        usage = getattr(response, "usage", None)
        prompt_tokens = getattr(usage, "prompt_tokens", None) if usage else None
        for item, data in zip(batch, response.data):
            row, request_text, original_tokens, used_tokens, truncated = item
            vector = np.asarray(data.embedding, dtype=np.float32)
            if vector.shape != (EMBEDDING_DIMENSIONS,) or not np.isfinite(vector).all():
                raise RuntimeError("Embedding response is non-finite or not 1536-D")
            save_route_cache(
                paths, view, row, request_text, vector, config, original_tokens,
                used_tokens, truncated, getattr(response, "model", None), prompt_tokens, latency,
            )
        print(f"RouteLLM {view}: embedded {min(start + len(batch), len(items))}/{len(items)} missing contexts", file=sys.stderr)


def score_route(
    paths: Paths, frame: pd.DataFrame, view: str, config: dict[str, Any],
    offline: bool, model: MFCheckpoint,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    audit = RequestAudit()
    missing: list[tuple[pd.Series, str, int, int, bool]] = []
    for _, row in frame.iterrows():
        if load_route_cache(paths, view, row, config) is None:
            request_text, original, used, truncated = route_tokenize(str(row[VIEWS[view]]))
            missing.append((row, request_text, original, used, truncated))
    if missing and offline:
        raise RuntimeError(f"Offline mode: {len(missing)} RouteLLM {view} embeddings are missing")
    if missing:
        request_embeddings(paths, missing, view, config, audit)
    rows: list[dict[str, Any]] = []
    for _, row in frame.iterrows():
        cached = load_route_cache(paths, view, row, config)
        if cached is None:
            raise RuntimeError("RouteLLM cache missing after embedding run")
        vector, meta = cached
        rows.append(raw_row(row, "routellm_mf", view, model.score(vector), meta, None, None))
    return rows, audit.summary()


def p2l_assets(paths: Paths) -> tuple[Any, list[str]]:
    tokenizer = AutoTokenizer.from_pretrained(paths.p2l_model, local_files_only=True)
    if tokenizer.model_max_length != P2L_MAX_TOKENS or tokenizer.cls_token_id is None:
        raise RuntimeError("Frozen P2L tokenizer contract differs")
    names = json.loads((paths.p2l_model / "model_list.json").read_text(encoding="utf-8"))
    if len(names) != P2L_BETA_DIM:
        raise RuntimeError("Expected 130 P2L beta dimensions")
    return tokenizer, names


def p2l_tokenize(tokenizer: Any, text: str) -> tuple[dict[str, torch.Tensor], int, int, bool]:
    rendered = tokenizer.apply_chat_template(
        [{"role": "user", "content": text}], tokenize=False,
        add_generation_prompt=False, add_special_tokens=False,
    ) + tokenizer.cls_token
    original = tokenizer(rendered, add_special_tokens=True, truncation=False)["input_ids"]
    used, truncated = head_tail_ids(original, P2L_MAX_TOKENS)
    if used[-1] != tokenizer.cls_token_id:
        raise RuntimeError("P2L deterministic head-tail truncation did not preserve CLS")
    encoded = {
        "input_ids": torch.tensor([used], dtype=torch.long),
        "attention_mask": torch.ones((1, len(used)), dtype=torch.long),
    }
    return encoded, len(original), len(used), truncated


def load_p2l_model(paths: Paths, tokenizer: Any) -> tuple[Any, float]:
    sys.path.insert(0, str(paths.p2l_repo))
    from p2l.model import get_p2l_model
    cls = get_p2l_model("llama", "bag", "rk")
    started = time.perf_counter()
    model = cls.from_pretrained(
        paths.p2l_model, CLS_id=tokenizer.cls_token_id, num_models=P2L_BETA_DIM,
        torch_dtype=torch.float32, low_cpu_mem_usage=True, local_files_only=True,
        attn_implementation=P2L_ATTENTION_IMPLEMENTATION,
    ).to("cpu").eval()
    elapsed = time.perf_counter() - started
    if sum(parameter.numel() for parameter in model.parameters()) != P2L_PARAMETER_COUNT:
        raise RuntimeError("P2L parameter count differs")
    if any(parameter.device.type != "cpu" or parameter.dtype != torch.float32 for parameter in model.parameters()):
        raise RuntimeError("P2L is not entirely CPU FP32")
    return model, elapsed


def p2l_cache_paths(paths: Paths, view: str, row: pd.Series) -> tuple[Path, Path]:
    source_hash = text_hash(str(row[VIEWS[view]]))
    stem = f"{text_hash(row.context_id)[:16]}__{source_hash[:16]}"
    root = paths.cache / "p2l" / view
    return root / f"{stem}.npz", root / f"{stem}.json"


def load_p2l_cache(paths: Paths, view: str, row: pd.Series) -> tuple[np.ndarray, float, dict[str, Any]] | None:
    npz, meta = p2l_cache_paths(paths, view, row)
    if not npz.exists() or not meta.exists():
        return None
    metadata = json.loads(meta.read_text(encoding="utf-8"))
    required = {
        "context_id": row.context_id, "view": view,
        "source_text_hash": text_hash(str(row[VIEWS[view]])),
        "model_revision": P2L_REVISION,
        "attention_implementation": P2L_ATTENTION_IMPLEMENTATION,
    }
    if any(metadata.get(key) != value for key, value in required.items()):
        return None
    if sha256(npz) != metadata["output_file_sha256"]:
        raise RuntimeError(f"P2L cache checksum mismatch: {npz}")
    with np.load(npz, allow_pickle=False) as payload:
        beta = payload["beta"].astype(np.float32)
        eta = float(payload["eta"])
    if beta.shape != (P2L_BETA_DIM,) or not np.isfinite(beta).all() or not math.isfinite(eta):
        raise RuntimeError(f"Invalid P2L cache: {npz}")
    return beta, eta, metadata


def save_p2l_cache(
    paths: Paths, view: str, row: pd.Series, beta: np.ndarray, eta: float,
    original_tokens: int, used_tokens: int, truncated: bool, latency: float,
) -> dict[str, Any]:
    npz, meta = p2l_cache_paths(paths, view, row)
    npz.parent.mkdir(parents=True, exist_ok=True)
    partial = npz.with_suffix(".part")
    with partial.open("wb") as handle:
        np.savez(handle, beta=beta.astype(np.float32), eta=np.float32(eta))
    partial.replace(npz)
    metadata = {
        "context_id": row.context_id, "view": view,
        "source_text_hash": text_hash(str(row[VIEWS[view]])),
        "model_revision": P2L_REVISION, "model_list_revision": P2L_MODEL_LIST_SHA256,
        "attention_implementation": P2L_ATTENTION_IMPLEMENTATION,
        "original_token_count": original_tokens, "used_token_count": used_tokens,
        "truncated": truncated, "latency_seconds": latency,
        "output_file_sha256": sha256(npz), "created_at_utc": now_utc(),
    }
    write_json(meta, metadata)
    return metadata


def infer_p2l_one(model: Any, encoded: dict[str, torch.Tensor]) -> tuple[np.ndarray, float, float]:
    started = time.perf_counter()
    with torch.inference_mode():
        result = model(**encoded)
    elapsed = time.perf_counter() - started
    beta = result.coefs.detach().cpu().float().numpy().reshape(-1).astype(np.float32)
    eta = float(result.eta.detach().cpu().float().numpy().reshape(-1)[0])
    if beta.shape != (P2L_BETA_DIM,) or not np.isfinite(beta).all() or not math.isfinite(eta):
        raise RuntimeError("P2L produced invalid beta or eta")
    return beta, eta, elapsed


def score_p2l(
    paths: Paths, frame: pd.DataFrame, views: Sequence[str], offline: bool,
    preflight: bool,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    tokenizer, _ = p2l_assets(paths)
    torch.set_num_threads(P2L_THREADS)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    missing = [(view, row) for view in views for _, row in frame.iterrows() if load_p2l_cache(paths, view, row) is None]
    if missing and offline:
        raise RuntimeError(f"Offline mode: {len(missing)} P2L outputs are missing")
    process = psutil.Process()
    rss_before = process.memory_info().rss
    model = None
    load_seconds = 0.0
    peak = rss_before
    if missing:
        with PeakRSS() as monitor:
            model, load_seconds = load_p2l_model(paths, tokenizer)
            rss_after = process.memory_info().rss
            for index, (view, row) in enumerate(missing, start=1):
                encoded, original, used, truncated = p2l_tokenize(tokenizer, str(row[VIEWS[view]]))
                beta, eta, latency = infer_p2l_one(model, encoded)
                save_p2l_cache(paths, view, row, beta, eta, original, used, truncated, latency)
                if index % 25 == 0 or index == len(missing):
                    print(f"P2L: inferred {index}/{len(missing)} missing context-views", file=sys.stderr)
            peak = monitor.peak
        rss_after = rss_after if missing else rss_before
    else:
        rss_after = rss_before
    repeat_beta_max_abs: float | None = None
    repeat_eta_abs: float | None = None
    if preflight:
        if model is None:
            with PeakRSS() as repeat_monitor:
                model, repeat_load_seconds = load_p2l_model(paths, tokenizer)
                load_seconds = max(load_seconds, repeat_load_seconds)
            peak = max(peak, repeat_monitor.peak)
            rss_after = max(rss_after, process.memory_info().rss)
        first_view = views[0]
        first_row = frame.iloc[0]
        encoded, _, _, _ = p2l_tokenize(tokenizer, str(first_row[VIEWS[first_view]]))
        beta_a, eta_a, _ = infer_p2l_one(model, encoded)
        beta_b, eta_b, _ = infer_p2l_one(model, encoded)
        repeat_beta_max_abs = float(np.max(np.abs(beta_a - beta_b)))
        repeat_eta_abs = abs(eta_a - eta_b)
    rows: list[dict[str, Any]] = []
    latencies: list[float] = []
    for view in views:
        for _, row in frame.iterrows():
            cached = load_p2l_cache(paths, view, row)
            if cached is None:
                raise RuntimeError("P2L cache missing after inference")
            beta, eta, meta = cached
            latencies.append(float(meta["latency_seconds"]))
            features = {
                "unusable_fraction": float(np.mean(beta <= 0.0)),
                "negative_mean_beta": float(-np.mean(beta)),
                "negative_median_beta": float(-np.median(beta)),
                "beta_spread": float(np.percentile(beta, 90) - np.percentile(beta, 10)),
            }
            rows.append(raw_row(row, "p2l_135m", view, features["unusable_fraction"], meta, beta, eta, features))
    computed_hardware = {
        "status": "passed" if peak / 2**30 < P2L_MEMORY_GATE_GIB else "failed_memory_gate",
        "preflight": preflight, "cpu_threads": P2L_THREADS, "device": "cpu",
        "dtype": "float32", "quantized": False, "fine_tuned": False,
        "attention_implementation": P2L_ATTENTION_IMPLEMENTATION,
        "sequential_inference": True, "model_load_seconds": load_seconds,
        "rss_before_load_gib": rss_before / 2**30, "rss_after_load_gib": rss_after / 2**30,
        "peak_rss_gib": peak / 2**30, "memory_gate_gib": P2L_MEMORY_GATE_GIB,
        "latency_seconds": distribution(latencies),
        "repeat_consistent": repeat_beta_max_abs == 0.0 and repeat_eta_abs == 0.0 if preflight else None,
        "repeat_beta_max_abs_difference": repeat_beta_max_abs,
        "repeat_eta_abs_difference": repeat_eta_abs,
    }
    if computed_hardware["status"] != "passed":
        raise RuntimeError("P2L exceeded the 7 GiB peak RSS gate")
    return rows, computed_hardware


def raw_row(
    row: pd.Series, router: str, view: str, score: float, meta: dict[str, Any],
    beta: np.ndarray | None, eta: float | None, features: dict[str, float] | None = None,
) -> dict[str, Any]:
    value = {
        "context_id": row.context_id, "benchmark": row.benchmark, "scenario": row.scenario,
        "instance_id": row.instance_id, "step_index": int(row.step_index),
        "target_tier": row.target_tier, "target_tier_id": int(row.target_tier_id),
        "label_confidence": row.label_confidence, "pipeline_stage": row.pipeline_stage,
        "analysis_scope": row.analysis_scope, "split": row.split, "cv_fold": int(row.cv_fold),
        "leakage_group_id": row.leakage_group_id, "router": router, "input_view": view,
        "raw_score": float(score), "original_token_count": int(meta["original_token_count"]),
        "used_token_count": int(meta["used_token_count"]), "truncated": bool(meta["truncated"]),
        "truncation_ratio": 1.0 - int(meta["used_token_count"]) / max(1, int(meta["original_token_count"])),
        "latency_seconds": float(meta.get("latency_seconds", meta.get("latency_seconds_batch", 0.0))),
        "beta": beta.tolist() if beta is not None else None, "eta": eta,
        "unusable_fraction": None, "negative_mean_beta": None,
        "negative_median_beta": None, "beta_spread": None,
    }
    if features:
        value.update(features)
    return value


def distribution(values: Iterable[float]) -> dict[str, float]:
    array = np.asarray(list(values), dtype=float)
    if not len(array):
        return {key: 0.0 for key in ("count", "sum", "mean", "p50", "p95", "minimum", "maximum")}
    return {
        "count": int(len(array)), "sum": float(np.sum(array)), "mean": float(np.mean(array)),
        "p50": float(np.percentile(array, 50)), "p95": float(np.percentile(array, 95)),
        "minimum": float(np.min(array)), "maximum": float(np.max(array)),
    }


def safe_spearman(score: np.ndarray, labels: np.ndarray) -> float:
    if np.unique(score).size < 2 or np.unique(labels).size < 2:
        return 0.0
    value = spearmanr(score, labels).statistic
    return float(value) if value is not None and math.isfinite(float(value)) else 0.0


def safe_kendall(score: np.ndarray, labels: np.ndarray) -> float:
    if np.unique(score).size < 2 or np.unique(labels).size < 2:
        return 0.0
    value = kendalltau(score, labels).statistic
    return float(value) if value is not None and math.isfinite(float(value)) else 0.0


def ordinal_auc(labels: np.ndarray, score: np.ndarray) -> float:
    values = []
    for threshold in range(3):
        binary = (labels > threshold).astype(int)
        if len(np.unique(binary)) == 2:
            values.append(float(roc_auc_score(binary, score)))
    return float(np.mean(values)) if values else 0.5


def multiclass_brier(labels: np.ndarray, probabilities: np.ndarray) -> float:
    truth = np.eye(4, dtype=float)[labels.astype(int)]
    return float(np.mean(np.sum((probabilities - truth) ** 2, axis=1)))


def expected_calibration_error(labels: np.ndarray, probabilities: np.ndarray, bins: int = 10) -> float:
    confidence = probabilities.max(axis=1)
    predictions = probabilities.argmax(axis=1)
    edges = np.linspace(0.0, 1.0, bins + 1)
    total = len(labels)
    result = 0.0
    for index in range(bins):
        lower, upper = edges[index], edges[index + 1]
        mask = (confidence >= lower) & (confidence <= upper if index == bins - 1 else confidence < upper)
        if mask.any():
            result += mask.mean() * abs(float(np.mean(predictions[mask] == labels[mask])) - float(np.mean(confidence[mask])))
    return float(result)


def fixed_zero_shot_predictions(score: np.ndarray) -> np.ndarray:
    return np.digitize(np.clip(score, 0.0, 1.0), [0.25, 0.50, 0.75], right=False).astype(int)


def discrimination_metrics(labels: np.ndarray, score: np.ndarray, predictions: np.ndarray | None = None) -> dict[str, float]:
    pred = fixed_zero_shot_predictions(score) if predictions is None else predictions.astype(int)
    return {
        "spearman": safe_spearman(score, labels),
        "kendall": safe_kendall(score, labels),
        "ordinal_auc": ordinal_auc(labels, score),
        "weighted_kappa": float(cohen_kappa_score(labels, pred, weights="quadratic")),
        "macro_f1": float(f1_score(labels, pred, average="macro", zero_division=0)),
        "balanced_accuracy": float(balanced_accuracy_score(labels, pred)),
    }


def probability_metrics(labels: np.ndarray, probabilities: np.ndarray) -> dict[str, float]:
    predictions = probabilities.argmax(axis=1)
    score = probabilities @ TIER_IDS.astype(float)
    return {
        **discrimination_metrics(labels, score, predictions),
        "multiclass_brier": multiclass_brier(labels, probabilities),
        "ece_10_bin": expected_calibration_error(labels, probabilities),
        "log_loss": float(log_loss(labels, probabilities, labels=TIER_IDS)),
    }


def prepare_group_indices(groups: np.ndarray) -> list[np.ndarray]:
    return [np.flatnonzero(groups == group) for group in np.unique(groups)]


def grouped_indices(prepared: list[np.ndarray], rng: np.random.Generator) -> np.ndarray:
    selected = rng.integers(0, len(prepared), size=len(prepared))
    return np.concatenate([prepared[index] for index in selected])


def bootstrap_discrimination(labels: np.ndarray, score: np.ndarray, groups: np.ndarray, seed: int) -> dict[str, tuple[float, float]]:
    rng = np.random.default_rng(seed)
    prepared = prepare_group_indices(groups)
    values = {key: [] for key in discrimination_metrics(labels, score)}
    for _ in range(BOOTSTRAP_SAMPLES):
        indices = grouped_indices(prepared, rng)
        metrics = discrimination_metrics(labels[indices], score[indices])
        for key, value in metrics.items():
            if math.isfinite(value):
                values[key].append(value)
    return {key: tuple(float(x) for x in np.quantile(item, [0.025, 0.975])) for key, item in values.items()}


def make_score_bins(part: pd.DataFrame) -> pd.DataFrame:
    ordered = part.sort_values(["raw_score", "context_id"]).copy()
    ordered["score_bin"] = np.concatenate([np.full(len(index), number + 1) for number, index in enumerate(np.array_split(np.arange(len(ordered)), 10))])
    rows = []
    for score_bin, group in ordered.groupby("score_bin", sort=True):
        counts = group.target_tier.value_counts()
        rows.append({
            "router": group.router.iloc[0], "input_view": group.input_view.iloc[0],
            "score_bin": int(score_bin), "record_count": len(group),
            "raw_score_min": group.raw_score.min(), "raw_score_max": group.raw_score.max(),
            "raw_score_mean": group.raw_score.mean(), "mean_target_tier_id": group.target_tier_id.mean(),
            **{f"proportion_{tier}": counts.get(tier, 0) / len(group) for tier in TIER_ORDER},
        })
    return pd.DataFrame(rows)


def zero_shot_outputs(raw: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    rows = []
    bins = []
    for index, ((router, view), part) in enumerate(raw.groupby(["router", "input_view"], sort=True)):
        labels = part.target_tier_id.to_numpy(dtype=int)
        score = part.raw_score.to_numpy(dtype=float)
        groups = part.instance_id.to_numpy()
        metrics = discrimination_metrics(labels, score)
        intervals = bootstrap_discrimination(labels, score, groups, RANDOM_SEED + index * 101)
        row: dict[str, Any] = {
            "analysis_name": PHASE_NAME, "router": router, "input_view": view,
            "record_count": len(part), "instance_count": part.instance_id.nunique(),
            "prediction_rule": "fixed thresholds [0.25, 0.50, 0.75] for class metrics; raw score for rank/AUC",
            "bootstrap_unit": "instance_id", "bootstrap_samples": BOOTSTRAP_SAMPLES,
        }
        for metric, value in metrics.items():
            row[metric] = value
            row[f"{metric}_ci_low"], row[f"{metric}_ci_high"] = intervals[metric]
        rows.append(row)
        bins.append(make_score_bins(part))
    return pd.DataFrame(rows), pd.concat(bins, ignore_index=True)


def paired_bootstrap_delta(last: pd.DataFrame, full: pd.DataFrame, seed: int) -> dict[str, tuple[float, float]]:
    joined = last[["context_id", "instance_id", "target_tier_id", "raw_score"]].merge(
        full[["context_id", "raw_score"]], on="context_id", suffixes=("_last", "_full"), validate="one_to_one"
    )
    labels = joined.target_tier_id.to_numpy(dtype=int)
    last_score = joined.raw_score_last.to_numpy(dtype=float)
    full_score = joined.raw_score_full.to_numpy(dtype=float)
    groups = joined.instance_id.to_numpy()
    metric_names = ["spearman", "kendall", "ordinal_auc", "macro_f1"]
    values = {name: [] for name in metric_names}
    rng = np.random.default_rng(seed)
    prepared = prepare_group_indices(groups)
    for _ in range(BOOTSTRAP_SAMPLES):
        indices = grouped_indices(prepared, rng)
        a = discrimination_metrics(labels[indices], last_score[indices])
        b = discrimination_metrics(labels[indices], full_score[indices])
        for name in metric_names:
            values[name].append(b[name] - a[name])
    return {name: tuple(float(x) for x in np.quantile(item, [0.025, 0.975])) for name, item in values.items()}


def context_gain_outputs(raw: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for index, router in enumerate(ROUTERS):
        last = raw[(raw.router == router) & (raw.input_view == "last_message")]
        full = raw[(raw.router == router) & (raw.input_view == "full_agent_context")]
        labels = last.sort_values("context_id").target_tier_id.to_numpy(dtype=int)
        last_score = last.sort_values("context_id").raw_score.to_numpy(dtype=float)
        full_score = full.sort_values("context_id").raw_score.to_numpy(dtype=float)
        a = discrimination_metrics(labels, last_score)
        b = discrimination_metrics(labels, full_score)
        intervals = paired_bootstrap_delta(last, full, RANDOM_SEED + 500 + index)
        row = {"analysis_name": PHASE_NAME, "router": router, "record_count": len(last), "bootstrap_unit": "instance_id", "bootstrap_samples": BOOTSTRAP_SAMPLES}
        for name in ["spearman", "kendall", "ordinal_auc", "macro_f1"]:
            row[f"last_message_{name}"] = a[name]
            row[f"full_agent_context_{name}"] = b[name]
            row[f"delta_{name}"] = b[name] - a[name]
            row[f"delta_{name}_ci_low"], row[f"delta_{name}_ci_high"] = intervals[name]
        rows.append(row)
    return pd.DataFrame(rows)


def expected_score(probabilities: np.ndarray) -> np.ndarray:
    return probabilities @ TIER_IDS.astype(float)


def metadata_pipeline(columns: list[str]) -> Pipeline:
    categorical = [column for column in columns if column in {"benchmark", "scenario"}]
    numeric = [column for column in columns if column not in categorical]
    transformer = ColumnTransformer([
        ("categorical", OneHotEncoder(handle_unknown="ignore"), categorical),
        ("numeric", StandardScaler(), numeric),
    ])
    model = LogisticRegression(C=1.0, class_weight="balanced", max_iter=3000, random_state=RANDOM_SEED)
    return Pipeline([("features", transformer), ("model", model)])


def align_probabilities(model: Any, raw_probabilities: np.ndarray) -> np.ndarray:
    output = np.zeros((len(raw_probabilities), 4), dtype=float)
    for source, cls in enumerate(model.classes_):
        output[:, int(cls)] = raw_probabilities[:, source]
    return output


def fixed_fold_predictions(frame: pd.DataFrame, columns: list[str]) -> np.ndarray:
    result = np.zeros((len(frame), 4), dtype=float)
    for fold in sorted(frame.cv_fold.unique()):
        train = frame.cv_fold != fold
        test = ~train
        model = metadata_pipeline(columns)
        model.fit(frame.loc[train, columns], frame.loc[train, "target_tier_id"])
        result[test] = align_probabilities(model.named_steps["model"], model.predict_proba(frame.loc[test, columns]))
    return result


def baseline_outputs(frame: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, np.ndarray]]:
    work = frame.copy()
    work["first_later"] = (work.step_index > 1).astype(int)
    work["last_token_count"] = work.last_message_approx_tokens.astype(float)
    work["full_token_count"] = work.acu_head_tail_approx_tokens.astype(float)
    labels = work.target_tier_id.to_numpy(dtype=int)
    definitions: dict[str, tuple[str, list[str] | None]] = {
        "majority-low": ("fixed", None), "step_index": ("numeric", ["step_index"]),
        "first-step-later-step": ("numeric", ["first_later"]),
        "last-message-token-count": ("numeric", ["last_token_count"]),
        "full-context-token-count": ("numeric", ["full_token_count"]),
        "benchmark-identity": ("model", ["benchmark"]), "scenario-identity": ("model", ["scenario"]),
        "benchmark-scenario-step-context-logistic": ("model", ["benchmark", "scenario", "step_index", "full_token_count"]),
    }
    rows = []
    predictions: dict[str, np.ndarray] = {}
    for name, (kind, columns) in definitions.items():
        if kind == "fixed":
            probs = np.zeros((len(work), 4)); probs[:, 0] = 1.0
            score = np.zeros(len(work)); pred = np.zeros(len(work), dtype=int)
        elif kind == "numeric":
            score = work[columns[0]].rank(method="average", pct=True).to_numpy(dtype=float)
            pred = fixed_zero_shot_predictions(score)
            probs = np.eye(4)[pred]
        else:
            probs = fixed_fold_predictions(work, columns or [])
            score = expected_score(probs) / 3.0
            pred = probs.argmax(axis=1)
        predictions[name] = probs
        metrics = discrimination_metrics(labels, score, pred)
        rows.append({
            "analysis_name": PHASE_NAME, "baseline": name, "record_count": len(work),
            "evaluation": "fixed Phase 1D GroupKFold out-of-fold" if kind == "model" else "zero-shot deterministic",
            **metrics, "multiclass_brier": multiclass_brier(labels, probs),
            "log_loss": float(log_loss(labels, np.clip(probs, 1e-12, 1.0), labels=TIER_IDS)),
        })
    return pd.DataFrame(rows), predictions


def incremental_outputs(frame: pd.DataFrame, raw: pd.DataFrame) -> pd.DataFrame:
    work = frame.copy().sort_values("context_id").reset_index(drop=True)
    work["context_length"] = work.acu_head_tail_approx_tokens.astype(float)
    base_columns = ["benchmark", "scenario", "step_index", "context_length"]
    base = fixed_fold_predictions(work, base_columns)
    labels = work.target_tier_id.to_numpy(dtype=int)
    groups = work.instance_id.to_numpy()
    rows = []
    for index, ((router, view), part) in enumerate(raw.groupby(["router", "input_view"], sort=True)):
        score_by_id = part.set_index("context_id").raw_score
        augmented = work.copy()
        augmented["router_score"] = augmented.context_id.map(score_by_id)
        aug = fixed_fold_predictions(augmented, base_columns + ["router_score"])
        observed = {
            "ordinal_auc": ordinal_auc(labels, expected_score(aug)) - ordinal_auc(labels, expected_score(base)),
            "log_loss": float(log_loss(labels, aug, labels=TIER_IDS) - log_loss(labels, base, labels=TIER_IDS)),
            "brier": multiclass_brier(labels, aug) - multiclass_brier(labels, base),
        }
        samples = {key: [] for key in observed}
        rng = np.random.default_rng(RANDOM_SEED + 800 + index)
        prepared = prepare_group_indices(groups)
        for _ in range(BOOTSTRAP_SAMPLES):
            indices = grouped_indices(prepared, rng)
            samples["ordinal_auc"].append(ordinal_auc(labels[indices], expected_score(aug[indices])) - ordinal_auc(labels[indices], expected_score(base[indices])))
            samples["log_loss"].append(float(log_loss(labels[indices], aug[indices], labels=TIER_IDS) - log_loss(labels[indices], base[indices], labels=TIER_IDS)))
            samples["brier"].append(multiclass_brier(labels[indices], aug[indices]) - multiclass_brier(labels[indices], base[indices]))
        row = {
            "analysis_name": PHASE_NAME, "router": router, "input_view": view,
            "record_count": len(work), "fold_source": "fixed Phase 1D cv_fold",
            "baseline_features": "benchmark+scenario+step_index+context_length",
            "augmented_feature": "router_score", "bootstrap_samples": BOOTSTRAP_SAMPLES,
        }
        for key, value in observed.items():
            row[f"delta_{key}"] = value
            row[f"delta_{key}_ci_low"], row[f"delta_{key}_ci_high"] = [float(x) for x in np.quantile(samples[key], [0.025, 0.975])]
        rows.append(row)
    return pd.DataFrame(rows)


class CumulativeLogistic:
    def __init__(self, c: float):
        self.c = c
        self.scaler = StandardScaler()
        self.models: list[LogisticRegression] = []

    def fit(self, features: np.ndarray, labels: np.ndarray) -> "CumulativeLogistic":
        scaled = self.scaler.fit_transform(features)
        self.models = []
        for threshold in range(3):
            binary = (labels > threshold).astype(int)
            model = LogisticRegression(C=self.c, class_weight="balanced", max_iter=3000, random_state=RANDOM_SEED + threshold)
            model.fit(scaled, binary)
            self.models.append(model)
        return self

    def predict_proba(self, features: np.ndarray) -> np.ndarray:
        scaled = self.scaler.transform(features)
        survival = np.column_stack([model.predict_proba(scaled)[:, list(model.classes_).index(1)] for model in self.models])
        survival[:, 1] = np.minimum(survival[:, 0], survival[:, 1])
        survival[:, 2] = np.minimum(survival[:, 1], survival[:, 2])
        probabilities = np.column_stack([1 - survival[:, 0], survival[:, 0] - survival[:, 1], survival[:, 1] - survival[:, 2], survival[:, 2]])
        return normalize_probabilities(probabilities)

    def parameters(self) -> dict[str, Any]:
        return {
            "method": "regularized cumulative ordinal logistic", "C": self.c,
            "scaler_mean": self.scaler.mean_.tolist(), "scaler_scale": self.scaler.scale_.tolist(),
            "threshold_models": [{"threshold": index, "coef": model.coef_.reshape(-1).tolist(), "intercept": model.intercept_.tolist()} for index, model in enumerate(self.models)],
        }


class CumulativeIsotonic:
    def __init__(self):
        self.models: list[IsotonicRegression] = []

    def fit(self, features: np.ndarray, labels: np.ndarray) -> "CumulativeIsotonic":
        score = features[:, 0]
        self.models = [IsotonicRegression(increasing=True, out_of_bounds="clip").fit(score, (labels > threshold).astype(float)) for threshold in range(3)]
        return self

    def predict_proba(self, features: np.ndarray) -> np.ndarray:
        score = features[:, 0]
        survival = np.column_stack([model.predict(score) for model in self.models])
        survival[:, 1] = np.minimum(survival[:, 0], survival[:, 1])
        survival[:, 2] = np.minimum(survival[:, 1], survival[:, 2])
        return normalize_probabilities(np.column_stack([1 - survival[:, 0], survival[:, 0] - survival[:, 1], survival[:, 1] - survival[:, 2], survival[:, 2]]))

    def parameters(self) -> dict[str, Any]:
        return {"method": "isotonic cumulative calibration", "threshold_models": [{"x_thresholds": model.X_thresholds_.tolist(), "y_thresholds": model.y_thresholds_.tolist()} for model in self.models]}


def normalize_probabilities(probabilities: np.ndarray) -> np.ndarray:
    result = np.clip(probabilities, 0.0, 1.0)
    sums = result.sum(axis=1, keepdims=True)
    result = result / np.where(sums == 0, 1.0, sums)
    if not np.isfinite(result).all() or not np.allclose(result.sum(axis=1), 1.0, atol=1e-10):
        raise RuntimeError("Calibrated probabilities are invalid")
    return result


def router_features(part: pd.DataFrame, router: str) -> tuple[np.ndarray, list[str]]:
    if router == "routellm_mf":
        return part[["raw_score"]].to_numpy(dtype=float), ["raw_strong_model_need_score"]
    names = ["unusable_fraction", "negative_mean_beta", "negative_median_beta", "beta_spread"]
    return part[names].to_numpy(dtype=float), names


def fit_calibrator(part: pd.DataFrame, router: str) -> tuple[Any, dict[str, Any]]:
    train = part.split == "train"
    validation = part.split == "validation"
    train_x, names = router_features(part[train], router)
    val_x, _ = router_features(part[validation], router)
    train_y = part.loc[train, "target_tier_id"].to_numpy(dtype=int)
    val_y = part.loc[validation, "target_tier_id"].to_numpy(dtype=int)
    candidates: list[tuple[str, Any, float]] = []
    for c in [0.01, 0.1, 1.0, 10.0]:
        model = CumulativeLogistic(c).fit(train_x, train_y)
        candidates.append((f"ordinal_logistic_C_{c:g}", model, float(log_loss(val_y, model.predict_proba(val_x), labels=TIER_IDS))))
    if router == "routellm_mf":
        model = CumulativeIsotonic().fit(train_x, train_y)
        candidates.append(("isotonic_cumulative", model, float(log_loss(val_y, model.predict_proba(val_x), labels=TIER_IDS))))
    name, selected, loss = min(candidates, key=lambda item: (item[2], item[0]))
    return selected, {
        "selected_method": name, "selection_metric": "validation log loss",
        "validation_log_loss": loss, "feature_names": names,
        "candidates": [{"name": item[0], "validation_log_loss": item[2]} for item in candidates],
        "fit_rows": int(train.sum()), "validation_rows": int(validation.sum()),
        "parameters": selected.parameters(),
    }


def calibration_outputs(raw: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    probability_rows = []
    metric_rows = []
    parameters: dict[str, Any] = {}
    for router in ROUTERS:
        for view in VIEWS:
            part = raw[(raw.router == router) & (raw.input_view == view)].sort_values("context_id").reset_index(drop=True)
            model, detail = fit_calibrator(part, router)
            features, _ = router_features(part, router)
            probabilities = model.predict_proba(features)
            key = f"{router}__{view}"
            parameters[key] = detail
            for row, probs in zip(part.to_dict("records"), probabilities):
                positive = probs[probs > 0]
                confidence = float(1.0 - (-np.sum(positive * np.log(positive)) / math.log(4.0)))
                probability_rows.append({
                    **{field: row[field] for field in ["context_id", "benchmark", "scenario", "instance_id", "step_index", "target_tier", "target_tier_id", "label_confidence", "pipeline_stage", "analysis_scope", "split", "cv_fold", "leakage_group_id", "router", "input_view", "raw_score", "used_token_count"]},
                    "p_low": float(probs[0]), "p_mid": float(probs[1]),
                    "p_mid_high": float(probs[2]), "p_high": float(probs[3]),
                    "confidence": confidence, "calibration_method": detail["selected_method"],
                    "estimate_label": "published-label calibrated estimate",
                })
            scopes = {
                "published_all_970": np.ones(len(part), dtype=bool),
                "held_out_test": (part.split == "test").to_numpy(),
                "strong_label_sensitivity": (part.label_confidence != "weak_degradation_search").to_numpy(),
                "swebench_coding_agent": (part.benchmark == "swebench").to_numpy(),
            }
            for scope, mask in scopes.items():
                metrics = probability_metrics(part.loc[mask, "target_tier_id"].to_numpy(dtype=int), probabilities[mask])
                metric_rows.append({
                    "analysis_name": PHASE_NAME, "router": router, "input_view": view,
                    "scope": scope, "record_count": int(mask.sum()), "instance_count": part.loc[mask, "instance_id"].nunique(),
                    "calibration_fit": "train only", "method_selected_on": "validation only", "test_evaluation_count": 1,
                    "selected_method": detail["selected_method"], **metrics,
                    "confusion_matrix_json": stable_json(confusion_matrix(part.loc[mask, "target_tier_id"], probabilities[mask].argmax(axis=1), labels=TIER_IDS).tolist()),
                })
    return pd.DataFrame(probability_rows), pd.DataFrame(metric_rows), parameters


def balanced_challenge(frame: pd.DataFrame) -> pd.DataFrame:
    """Select whole instances, maximizing the smallest tier then total rows."""
    grouped: list[tuple[str, str, Counter[str]]] = []
    for instance_id, part in frame.groupby("instance_id"):
        tier_counts = Counter(part.target_tier)
        key = text_hash(f"{RANDOM_SEED}|{part.benchmark.iloc[0]}|{int(part.step_index.min())}|{instance_id}")
        grouped.append((key, str(instance_id), tier_counts))
    grouped.sort()
    group_count = len(grouped)
    # Binary x_i selects a whole trajectory. Integer z is the minimum selected
    # tier count. A large z coefficient first balances all four classes; total
    # rows and the seeded stable order break ties deterministically.
    objective = np.zeros(group_count + 1, dtype=float)
    for index, (_, _, tier_counts) in enumerate(grouped):
        objective[index] = -sum(tier_counts.values()) - (group_count - index) * 1e-8
    objective[-1] = -10_000.0
    matrix = []
    upper = []
    for tier in TIER_ORDER:
        cap = np.zeros(group_count + 1, dtype=float)
        minimum = np.zeros(group_count + 1, dtype=float)
        for index, (_, _, tier_counts) in enumerate(grouped):
            cap[index] = tier_counts[tier]
            minimum[index] = -tier_counts[tier]
        minimum[-1] = 1.0
        matrix.extend([cap, minimum])
        upper.extend([49.0, 0.0])
    solution = milp(
        c=objective,
        integrality=np.ones(group_count + 1, dtype=int),
        bounds=Bounds(np.zeros(group_count + 1), np.r_[np.ones(group_count), 49.0]),
        constraints=LinearConstraint(np.vstack(matrix), -np.inf, np.asarray(upper)),
        options={"time_limit": 60.0},
    )
    if not solution.success or solution.x is None:
        raise RuntimeError(f"Balanced challenge MILP failed: {solution.message}")
    selected = {
        grouped[index][1]
        for index, value in enumerate(solution.x[:group_count])
        if value > 0.5
    }
    challenge = frame[frame.instance_id.isin(selected)].copy()
    if challenge.empty or challenge.groupby("instance_id").context_id.count().sum() != len(challenge):
        raise RuntimeError("Balanced challenge construction failed")
    if any(value > 49 for value in challenge.target_tier.value_counts()):
        raise RuntimeError("Balanced challenge exceeds the 49-per-tier cap")
    challenge["selection_seed"] = RANDOM_SEED
    challenge["selection_unit"] = "whole instance_id"
    return challenge.sort_values("context_id")


def balanced_outputs(frame: pd.DataFrame, raw: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    challenge = balanced_challenge(frame)
    rows = []
    for (router, view), part in raw[raw.context_id.isin(challenge.context_id)].groupby(["router", "input_view"], sort=True):
        labels = part.target_tier_id.to_numpy(dtype=int)
        score = part.raw_score.to_numpy(dtype=float)
        metrics = discrimination_metrics(labels, score)
        rows.append({
            "analysis_name": PHASE_NAME, "router": router, "input_view": view,
            "record_count": len(part), "instance_count": part.instance_id.nunique(),
            "selection_seed": RANDOM_SEED, "selection_unit": "whole instance_id",
            **{f"tier_{tier}_count": int((part.target_tier == tier).sum()) for tier in TIER_ORDER},
            **metrics, "confusion_matrix_json": stable_json(confusion_matrix(labels, fixed_zero_shot_predictions(score), labels=TIER_IDS).tolist()),
            "allowed_use": "four-tier discrimination only; not calibration, natural-distribution, or cost-savings estimation",
        })
    manifest_columns = [
        "context_id", "benchmark", "scenario", "instance_id", "step_index",
        "target_tier", "target_tier_id", "label_confidence", "split",
        "leakage_group_id", "selection_seed", "selection_unit",
    ]
    return pd.DataFrame(rows), challenge[manifest_columns]


def scoped_raw_metrics(raw: pd.DataFrame, scope_name: str, mask: Callable[[pd.DataFrame], pd.Series]) -> pd.DataFrame:
    rows = []
    for (router, view), part in raw.groupby(["router", "input_view"], sort=True):
        subset = part[mask(part)]
        metrics = discrimination_metrics(subset.target_tier_id.to_numpy(dtype=int), subset.raw_score.to_numpy(dtype=float))
        rows.append({
            "analysis_name": PHASE_NAME, "scope": scope_name, "router": router,
            "input_view": view, "record_count": len(subset), "instance_count": subset.instance_id.nunique(),
            "label_interpretation": "published labels; scope-specific sensitivity, not strict ground truth", **metrics,
        })
    return pd.DataFrame(rows)


def per_benchmark_outputs(raw: pd.DataFrame, probabilities: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for (router, view, benchmark), part in raw.groupby(["router", "input_view", "benchmark"], sort=True):
        zero = discrimination_metrics(part.target_tier_id.to_numpy(dtype=int), part.raw_score.to_numpy(dtype=float))
        calibrated = probabilities[(probabilities.router == router) & (probabilities.input_view == view) & (probabilities.benchmark == benchmark)]
        probs = calibrated[["p_low", "p_mid", "p_mid_high", "p_high"]].to_numpy(dtype=float)
        prob_metrics = probability_metrics(calibrated.target_tier_id.to_numpy(dtype=int), probs)
        rows.append({
            "analysis_name": PHASE_NAME, "router": router, "input_view": view,
            "benchmark": benchmark, "record_count": len(part), "instance_count": part.instance_id.nunique(),
            **{f"zero_shot_{key}": value for key, value in zero.items()},
            **{f"calibrated_{key}": value for key, value in prob_metrics.items()},
        })
    return pd.DataFrame(rows)


def lobo_outputs(raw: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for router in ROUTERS:
        for view in VIEWS:
            part = raw[(raw.router == router) & (raw.input_view == view)].sort_values("context_id").reset_index(drop=True)
            for benchmark in sorted(part.benchmark.unique()):
                training_pool = part[part.benchmark != benchmark].copy()
                holdout = part[part.benchmark == benchmark].copy()
                # Preserve Phase 1D train/validation roles inside the non-holdout pool.
                if not (training_pool.split == "validation").any():
                    raise RuntimeError("LOBO calibration has no validation rows")
                model, detail = fit_calibrator(training_pool, router)
                features, _ = router_features(holdout, router)
                probabilities = model.predict_proba(features)
                metrics = probability_metrics(holdout.target_tier_id.to_numpy(dtype=int), probabilities)
                rows.append({
                    "analysis_name": PHASE_NAME, "router": router, "input_view": view,
                    "holdout_benchmark": benchmark, "holdout_records": len(holdout),
                    "holdout_instances": holdout.instance_id.nunique(),
                    "training_records_excluding_holdout": len(training_pool),
                    "selected_method": detail["selected_method"], **metrics,
                })
    return pd.DataFrame(rows)


def integrate_product_policy(paths: Paths, probabilities: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    module_path = paths.foundation / "src"
    sys.path.insert(0, str(module_path))
    from acu_curve_engine import TierProbabilities, continuous_difficulty, predicted_sufficiency
    from acu_decision_engine import choose_tier, load_catalog

    catalog_path = paths.foundation / "config/tier_catalog.example.yaml"
    catalog = load_catalog(catalog_path)
    result = probabilities.copy()
    product_columns = [
        "continuous_difficulty", "predicted_sufficiency_low", "predicted_sufficiency_mid",
        "predicted_sufficiency_mid_high", "predicted_sufficiency_high", "selected_tier",
        "conservative_quality", "expected_total_cost", "fallback_tier", "selection_reason",
    ]
    for column in product_columns:
        result[column] = None
    policy_rows = []
    full = result.input_view == "full_agent_context"
    for index in result.index[full]:
        row = result.loc[index]
        tier_probs = TierProbabilities(row.p_low, row.p_mid, row.p_mid_high, row.p_high, row.confidence)
        difficulty = continuous_difficulty(tier_probs)
        sufficiency = predicted_sufficiency(tier_probs)
        decision = choose_tier(tier_probs, catalog, quality_threshold=0.90, input_tokens=int(row.used_token_count))
        values = {
            "continuous_difficulty": difficulty,
            **{f"predicted_sufficiency_{tier}": sufficiency[tier] for tier in TIER_ORDER},
            "selected_tier": decision.selected_tier, "conservative_quality": decision.conservative_quality,
            "expected_total_cost": decision.expected_total_cost, "fallback_tier": decision.fallback_tier,
            "selection_reason": decision.reason,
        }
        for key, value in values.items():
            result.at[index, key] = value
    for router in ROUTERS:
        subset = result[(result.router == router) & full].copy()
        for threshold in [0.80, 0.90, 0.95]:
            decisions = []
            for _, row in subset.iterrows():
                probs = TierProbabilities(row.p_low, row.p_mid, row.p_mid_high, row.p_high, row.confidence)
                decisions.append(choose_tier(probs, catalog, quality_threshold=threshold, input_tokens=int(row.used_token_count)))
            selected = Counter(decision.selected_tier for decision in decisions)
            always_high_costs = []
            always_low_costs = []
            for _, row in subset.iterrows():
                probs = TierProbabilities(row.p_low, row.p_mid, row.p_mid_high, row.p_high, row.confidence)
                alternatives = choose_tier(
                    probs, catalog, quality_threshold=0.0, input_tokens=int(row.used_token_count)
                ).alternatives
                low_cost = next(
                    float(item["expected_total_cost"])
                    for item in alternatives
                    if item["tier"] == "low"
                )
                high_config = catalog.tiers["high"]
                from acu_decision_engine import call_cost
                always_high_costs.append(high_config.router_cost + call_cost(high_config, input_tokens=int(row.used_token_count)))
                always_low_costs.append(low_cost)
            mean_cost = float(np.mean([decision.expected_total_cost for decision in decisions]))
            high_cost = float(np.mean(always_high_costs))
            policy_rows.append({
                "analysis_name": PHASE_NAME, "estimate_label": "published-label calibrated estimate",
                "router": router, "input_view": "full_agent_context", "quality_threshold": threshold,
                "record_count": len(subset), "mean_expected_total_cost": mean_cost,
                "mean_conservative_quality": float(np.mean([decision.conservative_quality for decision in decisions])),
                "always_high_mean_cost": high_cost, "always_low_mean_expected_cost": float(np.mean(always_low_costs)),
                "theoretical_cost_saving_vs_always_high": (high_cost - mean_cost) / high_cost,
                **{f"selected_{tier}_count": selected[tier] for tier in TIER_ORDER},
                "catalog_status": "synthetic", "cost_interpretation": "interface demonstration only",
            })
    policy = pd.DataFrame(policy_rows)
    representative_ids = []
    candidates = result[full & (result.router == "routellm_mf")].sort_values(["target_tier_id", "continuous_difficulty", "context_id"])
    targets = {"low": 3, "mid": 2, "mid_high": 2, "high": 3}
    for tier, count in targets.items():
        group = candidates[candidates.target_tier == tier]
        positions = np.linspace(0, len(group) - 1, count, dtype=int)
        representative_ids.extend(group.iloc[positions].context_id.tolist())
    representative = result[full & result.context_id.isin(representative_ids)][[
        "context_id", "benchmark", "scenario", "instance_id", "step_index", "target_tier",
        "label_confidence", "router", "continuous_difficulty", "p_low", "p_mid", "p_mid_high",
        "p_high", "confidence", "selected_tier", "conservative_quality", "expected_total_cost",
        "fallback_tier", "selection_reason", "estimate_label",
    ]].sort_values(["context_id", "router"])
    return result, policy, representative


def validate_product_probabilities(frame: pd.DataFrame) -> None:
    probs = frame[["p_low", "p_mid", "p_mid_high", "p_high"]].to_numpy(dtype=float)
    if not np.isfinite(probs).all() or (probs < 0).any() or (probs > 1).any() or not np.allclose(probs.sum(axis=1), 1.0, atol=1e-9):
        raise RuntimeError("Four-tier calibrated probability validation failed")
    full = frame[frame.input_view == "full_agent_context"]
    suff = full[[f"predicted_sufficiency_{tier}" for tier in TIER_ORDER]].to_numpy(dtype=float)
    if not np.isfinite(suff).all() or (np.diff(suff, axis=1) < -1e-12).any():
        raise RuntimeError("Predicted sufficiency cumulative monotonicity failed")


def go_no_go(
    zero: pd.DataFrame, gain: pd.DataFrame, incremental: pd.DataFrame,
    balanced: pd.DataFrame, swebench: pd.DataFrame,
) -> dict[str, Any]:
    outcomes = {}
    for router in ROUTERS:
        main = zero[(zero.router == router) & (zero.input_view == "full_agent_context")].iloc[0]
        delta = gain[gain.router == router].iloc[0]
        inc = incremental[(incremental.router == router) & (incremental.input_view == "full_agent_context")].iloc[0]
        challenge = balanced[(balanced.router == router) & (balanced.input_view == "full_agent_context")].iloc[0]
        coding = swebench[(swebench.router == router) & (swebench.input_view == "full_agent_context")].iloc[0]
        go_conditions = {
            "ordinal_auc_at_least_0_60": bool(main.ordinal_auc >= 0.60),
            "spearman_positive": bool(main.spearman > 0),
            "full_context_auc_gain_positive": bool(delta.delta_ordinal_auc > 0),
            "incremental_auc_positive": bool(inc.delta_ordinal_auc > 0),
            "balanced_challenge_above_random": bool(challenge.ordinal_auc > 0.50),
        }
        conditional = bool(
            0.55 <= main.ordinal_auc < 0.60 and main.spearman > 0
            and coding.ordinal_auc > 0.50 and challenge.ordinal_auc > 0.50
        )
        status = "GO" if all(go_conditions.values()) else "CONDITIONAL GO" if conditional else "NO-GO"
        outcomes[router] = {
            "status": status, "go_conditions": go_conditions,
            "full_context_ordinal_auc": float(main.ordinal_auc),
            "full_context_spearman": float(main.spearman),
            "full_minus_last_ordinal_auc": float(delta.delta_ordinal_auc),
            "incremental_ordinal_auc": float(inc.delta_ordinal_auc),
            "balanced_ordinal_auc": float(challenge.ordinal_auc),
            "swebench_ordinal_auc": float(coding.ordinal_auc),
        }
    go_routers = [router for router, item in outcomes.items() if item["status"] == "GO"]
    conditional_routers = [router for router, item in outcomes.items() if item["status"] == "CONDITIONAL GO"]
    if len(go_routers) == 1:
        recommendation = f"Select {go_routers[0]} for Phase 2."
        judge = False
    elif len(go_routers) == 2:
        recommendation = "Both routers pass; select using measured latency, cost, and deployment footprint."
        judge = False
    elif conditional_routers:
        recommendation = "Retain conditional routers only as auxiliary signals and run Phase 1F LLM Judge."
        judge = True
    else:
        recommendation = "Stop general pretrained-router experiments and proceed to Phase 1F LLM Judge."
        judge = True
    return {"router_outcomes": outcomes, "recommendation": recommendation, "enter_llm_judge": judge}


def plot_style() -> None:
    plt.rcParams.update({
        "figure.facecolor": "white", "axes.facecolor": "white", "axes.edgecolor": "#334155",
        "axes.labelcolor": "#1f2937", "text.color": "#1f2937", "xtick.color": "#475569",
        "ytick.color": "#475569", "grid.color": "#e2e8f0", "grid.linewidth": 0.7,
        "font.size": 9.5, "axes.titlesize": 12, "axes.titleweight": "semibold",
        "legend.frameon": False,
    })


def save_figure(fig: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=180, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def plot_outputs(paths: Paths) -> None:
    plot_style()
    output = paths.output
    raw = pd.read_parquet(output / "router_raw_scores.parquet")
    zero = pd.read_csv(output / "zero_shot_metrics.csv")
    gain = pd.read_csv(output / "context_gain_metrics.csv")
    baselines = pd.read_csv(output / "simple_baseline_metrics.csv")
    calibrated = pd.read_parquet(output / "calibrated_probabilities.parquet")
    calibration = pd.read_csv(output / "calibration_metrics.csv")
    balanced = pd.read_csv(output / "balanced_challenge_metrics.csv")
    policy = pd.read_csv(output / "product_policy_metrics.csv")
    representative = pd.read_csv(output / "representative_decisions.csv")
    palette = {"routellm_mf": "#2563eb", "p2l_135m": "#d97706"}
    tier_colors = {"low": "#bfdbfe", "mid": "#60a5fa", "mid_high": "#f59e0b", "high": "#92400e"}

    fig, axes = plt.subplots(2, 2, figsize=(12, 8), sharey=False)
    for axis, (router, view) in zip(axes.flat, [(r, v) for r in ROUTERS for v in VIEWS]):
        part = raw[(raw.router == router) & (raw.input_view == view)]
        data = [part.loc[part.target_tier == tier, "raw_score"].to_numpy() for tier in TIER_ORDER]
        boxes = axis.boxplot(data, tick_labels=TIER_ORDER, patch_artist=True, showfliers=False)
        for box, tier in zip(boxes["boxes"], TIER_ORDER):
            box.set_facecolor(tier_colors[tier]); box.set_edgecolor("#334155")
        axis.set_title(f"{router} · {view}")
        axis.set_ylabel("Raw difficulty / strong-model-need score")
        axis.grid(axis="y")
    fig.suptitle("Router raw score by published target tier", fontsize=14, fontweight="semibold")
    fig.text(0.5, 0.01, "970 published-label records; boxplots omit visual outliers but metrics retain every row", ha="center", color="#64748b")
    save_figure(fig, output / "figures/router_score_by_tier.png")

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5), sharey=True)
    for axis, router in zip(axes, ROUTERS):
        row = gain[gain.router == router].iloc[0]
        names = ["Spearman", "Kendall", "Ordinal AUC", "Macro F1"]
        keys = ["spearman", "kendall", "ordinal_auc", "macro_f1"]
        last = [row[f"last_message_{key}"] for key in keys]
        full = [row[f"full_agent_context_{key}"] for key in keys]
        x = np.arange(4); width = 0.36
        axis.bar(x - width / 2, last, width, label="Last message", color="#bfdbfe", edgecolor="#334155")
        axis.bar(x + width / 2, full, width, label="Full agent context", color=palette[router], edgecolor="#334155")
        axis.set_xticks(x, names, rotation=20, ha="right"); axis.set_ylim(-0.15, 1.0); axis.grid(axis="y")
        axis.set_title(router); axis.legend(loc="upper left")
    fig.suptitle("Last-message versus full-context discrimination")
    fig.text(0.5, 0.01, "Paired comparison on the same 970 context IDs", ha="center", color="#64748b")
    fig.subplots_adjust(bottom=0.24, top=0.86, wspace=0.20)
    save_figure(fig, output / "figures/context_gain_comparison.png")

    fig, axis = plt.subplots(figsize=(9, 4.8))
    labels = [f"{row.router}\n{row.input_view}" for row in zero.itertuples()]
    colors = [palette[row.router] for row in zero.itertuples()]
    axis.bar(np.arange(len(zero)), zero.ordinal_auc, color=colors, edgecolor="#334155")
    axis.axhline(0.5, color="#334155", linestyle="--", label="Random ranking")
    axis.axhline(0.6, color="#64748b", linestyle=":", label="GO threshold")
    axis.set_xticks(np.arange(len(zero)), labels); axis.set_ylim(0.35, max(0.68, zero.ordinal_auc.max() + 0.05))
    axis.set_ylabel("Ordinal ROC-AUC"); axis.set_title("Zero-shot ordinal ROC-AUC by router and input view")
    axis.grid(axis="y"); axis.legend()
    save_figure(fig, output / "figures/ordinal_roc_comparison.png")

    combined = pd.concat([
        baselines[["baseline", "ordinal_auc"]].rename(columns={"baseline": "method"}),
        zero.assign(method=zero.router + " · " + zero.input_view)[["method", "ordinal_auc"]],
    ], ignore_index=True).sort_values("ordinal_auc")
    fig, axis = plt.subplots(figsize=(10, 6))
    bar_colors = ["#94a3b8" if "·" not in method else (palette["routellm_mf"] if method.startswith("routellm") else palette["p2l_135m"]) for method in combined.method]
    axis.barh(combined.method, combined.ordinal_auc, color=bar_colors, edgecolor="#334155")
    axis.axvline(0.5, color="#334155", linestyle="--"); axis.set_xlim(0.35, max(0.7, combined.ordinal_auc.max() + 0.04))
    axis.set_xlabel("Ordinal ROC-AUC"); axis.set_title("Routers versus simple metadata and length baselines")
    axis.grid(axis="x")
    save_figure(fig, output / "figures/router_vs_simple_baselines.png")

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5), sharex=True, sharey=True)
    for axis, router in zip(axes, ROUTERS):
        part = calibrated[(calibrated.router == router) & (calibrated.input_view == "full_agent_context") & (calibrated.split == "test")].copy()
        part["predicted_tier"] = part[["p_low", "p_mid", "p_mid_high", "p_high"]].to_numpy() @ TIER_IDS
        part["bin"] = pd.qcut(part.predicted_tier.rank(method="first"), 6, labels=False)
        points = part.groupby("bin").agg(predicted=("predicted_tier", "mean"), observed=("target_tier_id", "mean"), count=("context_id", "size"))
        axis.plot(points.predicted, points.observed, marker="o", color=palette[router], label=router)
        axis.plot([0, 3], [0, 3], linestyle="--", color="#334155", label="Ideal")
        axis.set_xlim(0, 3); axis.set_ylim(0, 3); axis.grid(); axis.set_title(router)
        axis.set_xlabel("Mean predicted tier ID"); axis.set_ylabel("Mean published tier ID"); axis.legend()
    fig.suptitle("Held-out test ordinal calibration")
    fig.text(0.5, 0.01, "Six equal-count bins; calibrators fit on train and selected on validation", ha="center", color="#64748b")
    fig.subplots_adjust(bottom=0.18, top=0.86, wspace=0.20)
    save_figure(fig, output / "figures/calibration_curves.png")

    fig, axes = plt.subplots(1, 2, figsize=(10, 4.5))
    for axis, router in zip(axes, ROUTERS):
        row = balanced[(balanced.router == router) & (balanced.input_view == "full_agent_context")].iloc[0]
        matrix = np.asarray(json.loads(row.confusion_matrix_json), dtype=int)
        image = axis.imshow(matrix, cmap="Blues", vmin=0)
        for i in range(4):
            for j in range(4):
                axis.text(j, i, str(matrix[i, j]), ha="center", va="center", color="#111827")
        axis.set_xticks(range(4), TIER_ORDER, rotation=25, ha="right"); axis.set_yticks(range(4), TIER_ORDER)
        axis.set_xlabel("Predicted tier"); axis.set_ylabel("Published tier"); axis.set_title(router)
    fig.suptitle("Balanced challenge zero-shot confusion matrices")
    fig.text(0.5, 0.01, "Whole-instance deterministic sample; fixed 0.25/0.50/0.75 thresholds", ha="center", color="#64748b")
    fig.subplots_adjust(bottom=0.24, top=0.86, wspace=0.22)
    save_figure(fig, output / "figures/balanced_confusion_matrix.png")

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.8), sharex=True, sharey=True)
    for axis, router in zip(axes, ROUTERS):
        part = calibrated[(calibrated.router == router) & (calibrated.input_view == "full_agent_context")].sort_values("continuous_difficulty")
        x = part.continuous_difficulty.astype(float).rolling(60, min_periods=20, center=True).mean()
        for tier, style in zip(TIER_ORDER, [":", "--", "-.", "-"]):
            y = part[f"predicted_sufficiency_{tier}"].astype(float).rolling(60, min_periods=20, center=True).mean()
            axis.plot(x, y, linestyle=style, label=tier, color=tier_colors[tier] if tier != "low" else "#2563eb")
        axis.set_title(router); axis.set_xlabel("Continuous difficulty"); axis.set_ylabel("Predicted sufficiency")
        axis.set_xlim(0, 1); axis.set_ylim(0, 1.03); axis.grid(); axis.legend(title="Synthetic capability tier")
    fig.suptitle("Calibrated difficulty–predicted-sufficiency curves")
    fig.text(0.5, 0.01, "Published-label calibrated estimates; not concrete-model success probabilities", ha="center", color="#64748b")
    save_figure(fig, output / "figures/difficulty_sufficiency_curves.png")

    fig, axis = plt.subplots(figsize=(8.5, 5))
    for router in ROUTERS:
        part = policy[policy.router == router]
        axis.plot(part.mean_expected_total_cost, part.mean_conservative_quality, marker="o", color=palette[router], label=router)
        for row in part.itertuples():
            axis.annotate(f"q≥{row.quality_threshold:.2f}", (row.mean_expected_total_cost, row.mean_conservative_quality), xytext=(4, 4), textcoords="offset points", fontsize=8)
    axis.set_xlabel("Mean expected total cost (synthetic USD)"); axis.set_ylabel("Mean conservative predicted sufficiency")
    axis.set_title("Synthetic cost–quality operating points"); axis.grid(); axis.legend()
    save_figure(fig, output / "figures/cost_quality_frontier.png")

    fig, axis = plt.subplots(figsize=(10, 6))
    display = representative.copy()
    display["label"] = display.context_id.str.slice(0, 26) + " · " + display.router.str.replace("_", " ")
    y = np.arange(len(display))
    colors = [tier_colors[tier] for tier in display.selected_tier]
    axis.scatter(display.continuous_difficulty, y, s=80, c=colors, edgecolor="#334155")
    axis.set_yticks(y, display.label); axis.invert_yaxis(); axis.set_xlim(0, 1)
    axis.set_xlabel("Calibrated continuous difficulty"); axis.set_title("Representative ACU tier-selection examples")
    axis.grid(axis="x")
    save_figure(fig, output / "figures/representative_model_selection.png")


def build_readme(paths: Paths, aggregate: dict[str, Any], hardware: dict[str, Any]) -> None:
    outcomes = aggregate["go_no_go"]["router_outcomes"]
    metrics = aggregate["headline_metrics"]
    route = metrics["routellm_mf"]
    p2l = metrics["p2l_135m"]
    route_runtime = hardware["routellm_mf"]["estimated_embedding_request_latency_seconds"]["sum"]
    p2l_runtime = hardware["p2l"]["full_run_latency_seconds"]["sum"]
    p2l_peak = hardware["p2l"]["peak_rss_gib"]
    route_peak = hardware["routellm_mf"]["peak_rss_gib"]
    api_cost = hardware["routellm_mf"]["estimated_api_cost_usd"]
    text = f"""# TwinRouterBench Phase 1E router validation

## Technical summary

This study is a **{PHASE_NAME}** over all 970 released TwinRouterBench step labels. It is not a strict-ground-truth claim: 634 rows retain strong-label metadata and 336 SWE-bench rows retain `weak_degradation_search`. RouteLLM MF is classified **{outcomes['routellm_mf']['status']}** and P2L 135M is classified **{outcomes['p2l_135m']['status']}** under the pre-registered product gates. {aggregate['go_no_go']['recommendation']}

The full-context zero-shot ordinal AUC / Spearman values are {route['ordinal_auc']:.3f} / {route['spearman']:.3f} for RouteLLM MF and {p2l['ordinal_auc']:.3f} / {p2l['spearman']:.3f} for P2L. Full-minus-last-message ordinal-AUC changes are {route['context_auc_gain']:+.3f} and {p2l['context_auc_gain']:+.3f}. These are associations with published tier labels, not measured model success probabilities.

## Frozen inputs and routers

- Phase 1D input: `../phase1d-foundation/outputs/acu_step_contexts.parquet`, SHA-256 `{EXPECTED_INPUT_SHA256}`; its train/validation/test, `cv_fold`, `instance_id`, and `leakage_group_id` assignments are reused unchanged.
- RouteLLM MF: Git `{ROUTELLM_COMMIT}`, checkpoint `{ROUTELLM_CHECKPOINT}` revision `{ROUTELLM_REVISION}`, original strong/weak semantics `{ROUTELLM_STRONG}` versus `{ROUTELLM_WEAK}`.
- RouteLLM embedding: `{EMBEDDING_MODEL}`, 1536 dimensions, deterministic 8,191-token head-tail cap using `cl100k_base`. The compatible gateway is used only through `/embeddings`; completion calls are blocked and counted.
- P2L: Git `{P2L_COMMIT}`, model `{P2L_MODEL}` revision `{P2L_REVISION}`; CPU FP32, four Torch threads, sequential inference, no quantization and no fine-tuning. Official chat formatting and tokenizer are retained, with deterministic head-tail truncation at 8,192 tokens and the CLS token preserved. PyTorch SDPA is used to keep long-context attention within the 7 GiB gate without changing model weights or precision.

The 1,940 RouteLLM context-view embeddings consumed 2,890,375 input tokens and cost an estimated USD {api_cost:.6f} at the user-supplied compatible-endpoint rate. Reconstructed API request latency is {route_runtime:.1f} seconds; because one batch latency is copied to each cache row, this is the sum of distinct `(view, batch latency)` values rather than an independent wall-clock trace. MF checkpoint loading peaked at {route_peak:.3f} GiB RSS. Sequential P2L inference over 1,940 context views took {p2l_runtime:.1f} seconds in summed per-record latency and peaked at {p2l_peak:.3f} GiB RSS.

## Methods and metric definitions

`last_message` uses Phase 1D `last_message_text`; `full_agent_context` uses `acu_head_tail_context`. Raw RouteLLM evidence is the strong-model-need score. P2L's pre-registered primary score is `unusable_fraction`; complete 130-dimensional beta and eta outputs remain in `router_raw_scores.parquet`, and the three auxiliary features are fixed before test evaluation.

Ordinal ROC-AUC is the macro mean of AUC for `tier_id > 0`, `> 1`, and `> 2`. Zero-shot class metrics use the fixed score thresholds 0.25, 0.50, and 0.75; rank metrics and AUC use the untouched raw score. Confidence intervals use 10,000 `instance_id`-group bootstrap resamples. The balanced challenge uses whole instances, at most 49 rows per tier, and is never used for calibration or cost-savings estimates.

Calibration uses train only. RouteLLM compares regularized cumulative ordinal logistic and cumulative isotonic calibration; P2L uses the four pre-registered features in regularized cumulative ordinal logistic. Validation selects the method and regularization; test is evaluated once. `calibrated_probabilities.parquet` includes all 970 descriptive product estimates while `calibration_metrics.csv` explicitly separates held-out test from all-row, strong-label, and SWE-bench scopes.

## Main findings

- **RouteLLM MF:** full-context AUC {route['ordinal_auc']:.3f}, Spearman {route['spearman']:.3f}; context AUC delta {route['context_auc_gain']:+.3f}; metadata-controlled AUC delta {route['incremental_auc']:+.3f}; balanced AUC {route['balanced_auc']:.3f}; SWE-bench AUC {route['swebench_auc']:.3f}.
- **P2L 135M:** full-context AUC {p2l['ordinal_auc']:.3f}, Spearman {p2l['spearman']:.3f}; context AUC delta {p2l['context_auc_gain']:+.3f}; metadata-controlled AUC delta {p2l['incremental_auc']:+.3f}; balanced AUC {p2l['balanced_auc']:.3f}; SWE-bench AUC {p2l['swebench_auc']:.3f}.
- The calibrated probabilities sum to one and the ACU cumulative sufficiency relation is mechanically validated for every full-context row. Costs and model names come from the Phase 1D synthetic tier catalog, so cost savings are interface demonstrations rather than vendor-price or concrete-model evidence.

## Curve terminology

- **Oracle label curve:** one-hot released target tiers used only to validate the Phase 1D mechanics.
- **Router prediction curve:** raw RouteLLM/P2L score versus released labels.
- **Benchmark-fitted curve:** Phase 2 logistic capability curve fitted from separately sourced benchmark results; not produced here.
- **Real execution empirical curve:** measured success from actual model task execution; not available here.

These four curve types are not interchangeable. Phase 1E product outputs are labeled `published-label calibrated estimate` and are called predicted sufficiency or predicted attainment, never a concrete model's precise success rate.

## Limitations and robustness

The released labels are highly imbalanced and step position is strongly related to tier. The metadata baselines and augmented GroupKFold comparison therefore matter more than aggregate correlations alone. SWE-bench is weak supervision and is reported separately. Compatible-gateway embeddings advertise the frozen model and dimensions but do not independently attest the upstream OpenAI snapshot. Full-context head-tail views are already deterministically compressed by Phase 1D and may omit middle history; router-specific tokenization can truncate further.

## Reproduction

Use Python 3.12 and the pinned packages in `requirements.txt`. Create an ignored local environment and run:

```bash
python3 -m venv research/quality-curves/twinrouterbench/phase1e-router-validation/.cache/venv
research/quality-curves/twinrouterbench/phase1e-router-validation/.cache/venv/bin/pip install \
  -r research/quality-curves/twinrouterbench/phase1e-router-validation/requirements.txt
research/quality-curves/twinrouterbench/phase1e-router-validation/.cache/venv/bin/python \
  research/quality-curves/twinrouterbench/phase1e-router-validation/scripts/run_phase1e.py \
  --embedding-gateway closeai
```

The online run reads `PROXY_BASE_URL` and `PROXY_API_KEY` from environment or the ignored repository `.env`. No secret is printed or saved. After caches exist, remove credentials and run `--offline`; it performs no network request. The script exits on a missing cache, checksum mismatch, non-finite output, probability violation, leakage, non-embedding request, or memory-gate failure.

## Evidence map

Exact metrics are in the CSV/Parquet outputs, frozen provenance and dependencies in `source_manifest.json`, runtime/memory/cost evidence in `hardware_benchmark.json`, and the decision in `go_no_go.md`. Every PNG is regenerated from the committed CSV or Parquet outputs.
"""
    (paths.phase_dir / "README.md").write_text(text, encoding="utf-8")


def write_go_no_go(paths: Paths, decision: dict[str, Any]) -> None:
    lines = ["# Phase 1E GO / NO-GO", "", f"Primary analysis: **{PHASE_NAME}**.", ""]
    for router, item in decision["router_outcomes"].items():
        lines.extend([
            f"## {router}: {item['status']}", "",
            f"- Full-context ordinal AUC: {item['full_context_ordinal_auc']:.4f}",
            f"- Full-context Spearman: {item['full_context_spearman']:.4f}",
            f"- Full-minus-last ordinal AUC: {item['full_minus_last_ordinal_auc']:+.4f}",
            f"- Metadata-controlled incremental ordinal AUC: {item['incremental_ordinal_auc']:+.4f}",
            f"- Balanced challenge ordinal AUC: {item['balanced_ordinal_auc']:.4f}",
            f"- SWE-bench coding-agent ordinal AUC: {item['swebench_ordinal_auc']:.4f}", "",
        ])
    lines.extend(["## Product decision", "", decision["recommendation"], "", f"Enter Phase 1F LLM Judge: **{decision['enter_llm_judge']}**.", "", "The decision follows the pre-registered thresholds without post-test feature selection or bucket changes.", ""])
    (paths.output / "go_no_go.md").write_text("\n".join(lines), encoding="utf-8")


def analysis_run(paths: Paths, frame: pd.DataFrame, raw: pd.DataFrame, hardware: dict[str, Any], request_audits: dict[str, Any], asset_audit: dict[str, Any], mode: str) -> dict[str, Any]:
    zero, score_bins = zero_shot_outputs(raw)
    gain = context_gain_outputs(raw)
    baselines, _ = baseline_outputs(frame)
    incremental = incremental_outputs(frame, raw)
    probabilities, calibration, parameters = calibration_outputs(raw)
    balanced, challenge_manifest = balanced_outputs(frame, raw)
    per_benchmark = per_benchmark_outputs(raw, probabilities)
    lobo = lobo_outputs(raw)
    strong = scoped_raw_metrics(raw, "strong_label_sensitivity", lambda part: part.label_confidence != "weak_degradation_search")
    swebench = scoped_raw_metrics(raw, "swebench_coding_agent", lambda part: part.benchmark == "swebench")
    probabilities, policy, representative = integrate_product_policy(paths, probabilities)
    validate_product_probabilities(probabilities)
    decision = go_no_go(zero, gain, incremental, balanced, swebench)

    write_csv(paths.output / "zero_shot_metrics.csv", zero)
    write_csv(paths.output / "router_score_bins.csv", score_bins)
    write_csv(paths.output / "context_gain_metrics.csv", gain)
    write_csv(paths.output / "simple_baseline_metrics.csv", baselines)
    write_csv(paths.output / "incremental_value_metrics.csv", incremental)
    write_csv(paths.output / "calibration_metrics.csv", calibration)
    write_csv(paths.output / "balanced_challenge_metrics.csv", balanced)
    write_csv(paths.output / "balanced_challenge_manifest.csv", challenge_manifest)
    write_csv(paths.output / "product_policy_metrics.csv", policy)
    write_csv(paths.output / "representative_decisions.csv", representative)
    write_csv(paths.output / "per_benchmark_metrics.csv", per_benchmark)
    write_csv(paths.output / "lobo_metrics.csv", lobo)
    write_csv(paths.output / "strong_label_sensitivity.csv", strong)
    write_csv(paths.output / "swebench_coding_agent_metrics.csv", swebench)
    write_json(paths.output / "calibration_parameters.json", parameters)
    probabilities.to_parquet(paths.output / "calibrated_probabilities.parquet", index=False)
    write_go_no_go(paths, decision)

    headline = {}
    for router in ROUTERS:
        main = zero[(zero.router == router) & (zero.input_view == "full_agent_context")].iloc[0]
        delta = gain[gain.router == router].iloc[0]
        inc = incremental[(incremental.router == router) & (incremental.input_view == "full_agent_context")].iloc[0]
        challenge = balanced[(balanced.router == router) & (balanced.input_view == "full_agent_context")].iloc[0]
        coding = swebench[(swebench.router == router) & (swebench.input_view == "full_agent_context")].iloc[0]
        headline[router] = {
            "ordinal_auc": float(main.ordinal_auc), "spearman": float(main.spearman),
            "context_auc_gain": float(delta.delta_ordinal_auc), "incremental_auc": float(inc.delta_ordinal_auc),
            "balanced_auc": float(challenge.ordinal_auc), "swebench_auc": float(coding.ordinal_auc),
        }
    aggregate = {
        "study": "TwinRouterBench Phase 1E RouteLLM MF and P2L validation",
        "primary_analysis_name": PHASE_NAME,
        "data": {
            "record_count": len(frame), "instance_count": frame.instance_id.nunique(),
            "tier_counts": frame.target_tier.value_counts().reindex(TIER_ORDER).to_dict(),
            "strong_label_count": int((frame.label_confidence != "weak_degradation_search").sum()),
            "weak_swebench_count": int((frame.label_confidence == "weak_degradation_search").sum()),
            "split_counts": frame.split.value_counts().to_dict(),
        },
        "headline_metrics": headline, "go_no_go": decision,
        "validation": {
            "raw_context_router_rows": len(raw), "each_router_view_has_970": bool((raw.groupby(["router", "input_view"]).size() == 970).all()),
            "finite_raw_scores": bool(np.isfinite(raw.raw_score).all()),
            "probabilities_sum_to_one": True, "sufficiency_monotone": True,
            "same_instance_cross_split_count": int((frame.groupby("instance_id").split.nunique() > 1).sum()),
            "same_leakage_group_cross_split_count": int((frame.groupby("leakage_group_id").split.nunique() > 1).sum()),
            "completion_calls": sum(item.get("completion_request_count", 0) for item in request_audits.values()),
            "p2l_peak_rss_under_7_gib": hardware["p2l"]["peak_rss_gib"] < P2L_MEMORY_GATE_GIB,
            "figures_from_committed_csv_or_parquet": True,
        },
        "limitations": [
            "Published labels are the product target, not strict ground truth.",
            "336 SWE-bench rows retain weak_degradation_search confidence.",
            "Compatible-gateway embeddings cannot independently attest the upstream OpenAI snapshot.",
            "Synthetic tier prices and model IDs validate interfaces only.",
        ],
    }
    write_json(paths.output / "aggregate_validation.json", aggregate)
    source_manifest = {
        "study": aggregate["study"], "execution_mode": mode,
        "input": {
            "path": "../phase1d-foundation/outputs/acu_step_contexts.parquet",
            "sha256": EXPECTED_INPUT_SHA256, "rows": len(frame),
            "twinrouterbench_github_commit": "430acecac71141de77afd8e5e13690d236d58e93",
            "twinrouterbench_hf_revision": "c2907f006455d9d3b4bf69472a527536c7baa195",
        },
        "routers": {
            "routellm_mf": {"repository": ROUTELLM_REPOSITORY, "commit": ROUTELLM_COMMIT, "checkpoint": ROUTELLM_CHECKPOINT, "revision": ROUTELLM_REVISION, "checkpoint_sha256": ROUTELLM_CHECKPOINT_SHA256, "strong_model": ROUTELLM_STRONG, "weak_model": ROUTELLM_WEAK, "embedding_model": EMBEDDING_MODEL, "dimensions": EMBEDDING_DIMENSIONS},
            "p2l_135m": {"repository": P2L_REPOSITORY, "commit": P2L_COMMIT, "model": P2L_MODEL, "revision": P2L_REVISION, "model_sha256": P2L_MODEL_SHA256, "cpu_threads": P2L_THREADS, "dtype": "float32", "attention_implementation": P2L_ATTENTION_IMPLEMENTATION},
        },
        "asset_audit": asset_audit, "request_audits": request_audits,
        "runtime": {"python": platform.python_version(), "platform": platform.platform(), "dependencies": dependency_versions()},
        "parameters": {"bootstrap_samples": BOOTSTRAP_SAMPLES, "bootstrap_unit": "instance_id", "random_seed": RANDOM_SEED, "preflight_count": PREFLIGHT_COUNT, "embedding_max_tokens": EMBEDDING_MAX_TOKENS, "p2l_max_tokens": P2L_MAX_TOKENS},
        "input_file_sha256": EXPECTED_INPUT_SHA256,
        "chart_map": [
            {"file": "figures/router_score_by_tier.png", "family": "distribution", "source": "router_raw_scores.parquet"},
            {"file": "figures/context_gain_comparison.png", "family": "comparison", "source": "context_gain_metrics.csv"},
            {"file": "figures/ordinal_roc_comparison.png", "family": "comparison", "source": "zero_shot_metrics.csv"},
            {"file": "figures/router_vs_simple_baselines.png", "family": "ranking", "source": "zero_shot_metrics.csv + simple_baseline_metrics.csv"},
            {"file": "figures/calibration_curves.png", "family": "uncertainty", "source": "calibrated_probabilities.parquet"},
            {"file": "figures/balanced_confusion_matrix.png", "family": "matrix", "source": "balanced_challenge_metrics.csv"},
            {"file": "figures/difficulty_sufficiency_curves.png", "family": "ordered relationship", "source": "calibrated_probabilities.parquet"},
            {"file": "figures/cost_quality_frontier.png", "family": "relationship", "source": "product_policy_metrics.csv"},
            {"file": "figures/representative_model_selection.png", "family": "comparison", "source": "representative_decisions.csv"},
        ],
        "execution_boundary": {"completion_calls": aggregate["validation"]["completion_calls"], "llm_judge_calls": 0, "answers_generated": 0, "docker_tasks": 0, "production_code_modified": False, "cost_field_from_benchmark_used": False},
    }
    write_json(paths.output / "source_manifest.json", source_manifest)
    build_readme(paths, aggregate, hardware)
    plot_outputs(paths)
    return aggregate


def preflight_summary(raw: pd.DataFrame, router: str, view: str) -> dict[str, Any]:
    part = raw[(raw.router == router) & (raw.input_view == view)]
    return {
        "context_ids": part.context_id.tolist(), "record_count": len(part),
        "finite_output_count": int(np.isfinite(part.raw_score).sum()),
        "repeat_consistent": True,
        "truncated_count": int(part.truncated.sum()),
        "token_count": distribution(part.used_token_count),
        "latency_seconds": distribution(part.latency_seconds),
    }


def write_raw_outputs(paths: Paths, raw: pd.DataFrame) -> None:
    if len(raw) != EXPECTED_ROWS * len(ROUTERS) * len(VIEWS):
        raise RuntimeError(f"Expected 3,880 raw context-router-view rows, got {len(raw)}")
    counts = raw.groupby(["router", "input_view"]).context_id.nunique()
    if not (counts == EXPECTED_ROWS).all() or raw.groupby(["router", "input_view", "context_id"]).size().max() != 1:
        raise RuntimeError("Each router/view does not have exactly one score per context")
    if not np.isfinite(raw.raw_score).all():
        raise RuntimeError("Raw scores contain non-finite values")
    paths.output.mkdir(parents=True, exist_ok=True)
    raw.to_parquet(paths.output / "router_raw_scores.parquet", index=False)
    audit = raw.drop(columns=["beta"]).copy()
    audit["estimated_embedding_cost_usd"] = np.where(
        audit.router == "routellm_mf",
        audit.used_token_count * EMBEDDING_PRICE_PER_MILLION_INPUT_TOKENS / 1_000_000,
        0.0,
    )
    write_csv(paths.output / "tokenization_audit.csv", audit)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Require all router caches; make no network request")
    parser.add_argument("--embedding-gateway", choices=["closeai", "openrouter"], default="closeai")
    parser.add_argument("--preflight-only", action="store_true", help="Run the fixed 20-context router preflights only")
    args = parser.parse_args()
    paths = resolve_paths()
    paths.cache.mkdir(parents=True, exist_ok=True)
    paths.output.mkdir(parents=True, exist_ok=True)
    frame = validate_input(paths)
    asset_audit = verify_assets(paths)
    config = embedding_config(paths, args.embedding_gateway, args.offline)
    preflight_frame = frame.head(PREFLIGHT_COUNT).copy()
    route_process = psutil.Process()
    route_rss_before = route_process.memory_info().rss
    with PeakRSS() as route_monitor:
        model_started = time.perf_counter()
        mf = MFCheckpoint(paths.routellm_checkpoint)
        mf_load_seconds = time.perf_counter() - model_started
    route_peak_rss = route_monitor.peak
    route_rss_after = route_process.memory_info().rss

    preflight_rows = []
    request_audits: dict[str, Any] = {}
    for view in VIEWS:
        rows, audit = score_route(paths, preflight_frame, view, config, args.offline, mf)
        preflight_rows.extend(rows)
        request_audits[f"preflight__routellm_mf__{view}"] = audit
    p2l_preflight_rows, p2l_preflight_hardware = score_p2l(paths, preflight_frame, list(VIEWS), args.offline, preflight=True)
    preflight_rows.extend(p2l_preflight_rows)
    preflight_raw = pd.DataFrame(preflight_rows)
    preflights = {f"{router}__{view}": preflight_summary(preflight_raw, router, view) for router in ROUTERS for view in VIEWS}
    for view in VIEWS:
        first = preflight_frame.iloc[0]
        cached_a = load_route_cache(paths, view, first, config)
        cached_b = load_route_cache(paths, view, first, config)
        if cached_a is None or cached_b is None:
            raise RuntimeError("RouteLLM repeat check could not reload the first embedding")
        score_a = mf.score(cached_a[0])
        score_b = mf.score(cached_b[0])
        preflights[f"routellm_mf__{view}"]["repeat_consistent"] = score_a == score_b
        preflights[f"routellm_mf__{view}"]["repeat_score_abs_difference"] = abs(score_a - score_b)
    for view in VIEWS:
        preflights[f"p2l_135m__{view}"]["repeat_consistent"] = p2l_preflight_hardware["repeat_consistent"]
        preflights[f"p2l_135m__{view}"]["repeat_beta_max_abs_difference"] = p2l_preflight_hardware["repeat_beta_max_abs_difference"]
        preflights[f"p2l_135m__{view}"]["repeat_eta_abs_difference"] = p2l_preflight_hardware["repeat_eta_abs_difference"]
    if any(item["record_count"] != PREFLIGHT_COUNT or item["finite_output_count"] != PREFLIGHT_COUNT or not item["repeat_consistent"] for item in preflights.values()):
        raise RuntimeError("One or more fixed 20-context preflights failed")
    if args.preflight_only:
        write_json(paths.output / "hardware_benchmark.json", {"status": "preflight_passed", "preflights": preflights, "p2l": p2l_preflight_hardware, "routellm_mf_load_seconds": mf_load_seconds})
        print("All four fixed 20-context preflights passed.")
        return 0

    route_rows = []
    for view in VIEWS:
        rows, audit = score_route(paths, frame, view, config, args.offline, mf)
        route_rows.extend(rows)
        request_audits[f"full__routellm_mf__{view}"] = audit
    p2l_rows, p2l_full_hardware = score_p2l(paths, frame, list(VIEWS), args.offline, preflight=False)
    raw = pd.DataFrame(route_rows + p2l_rows).sort_values(["router", "input_view", "context_id"]).reset_index(drop=True)
    write_raw_outputs(paths, raw)

    route_part = raw[raw.router == "routellm_mf"]
    route_tokens = int(route_part.used_token_count.sum())
    route_batch_latencies = route_part[["input_view", "latency_seconds"]].drop_duplicates()
    p2l_hardware = p2l_full_hardware if p2l_full_hardware["peak_rss_gib"] > p2l_preflight_hardware["peak_rss_gib"] else p2l_preflight_hardware
    computed_hardware = {
        "status": "passed", "preflight_record_selection": "first 20 context_id values in stable lexical order",
        "preflights": preflights,
        "routellm_mf": {
            "checkpoint_load_seconds": mf_load_seconds, "embedding_calls_only": True,
            "rss_before_load_gib": route_rss_before / 2**30,
            "rss_after_load_gib": route_rss_after / 2**30,
            "peak_rss_gib": route_peak_rss / 2**30,
            "completion_calls": sum(item["completion_request_count"] for item in request_audits.values()),
            "request_token_count": route_tokens,
            "estimated_api_cost_usd": route_tokens * EMBEDDING_PRICE_PER_MILLION_INPUT_TOKENS / 1_000_000,
            "price_assumption": "user-supplied compatible endpoint rate: USD 0.03 per million input tokens",
            "score_latency_seconds": distribution(route_part.latency_seconds),
            "estimated_embedding_request_latency_seconds": distribution(route_batch_latencies.latency_seconds),
            "embedding_request_latency_estimation_method": "sum distinct (input_view, batch_latency) cache values; cache rows share one latency per API batch",
        },
        "p2l": {
            **p2l_hardware,
            "full_run_latency_seconds": distribution(raw[raw.router == "p2l_135m"].latency_seconds),
            "full_run_context_view_count": int((raw.router == "p2l_135m").sum()),
        },
    }
    hardware_path = paths.output / "hardware_benchmark.json"
    if args.offline and hardware_path.exists():
        hardware = json.loads(hardware_path.read_text(encoding="utf-8"))
        hardware["offline_replay_verified_without_credentials"] = True
        hardware["routellm_mf"]["estimated_embedding_request_latency_seconds"] = computed_hardware["routellm_mf"]["estimated_embedding_request_latency_seconds"]
        hardware["routellm_mf"]["embedding_request_latency_estimation_method"] = computed_hardware["routellm_mf"]["embedding_request_latency_estimation_method"]
        for key in ("rss_before_load_gib", "rss_after_load_gib", "peak_rss_gib"):
            hardware["routellm_mf"][key] = computed_hardware["routellm_mf"][key]
        hardware["p2l"]["full_run_latency_seconds"] = computed_hardware["p2l"]["full_run_latency_seconds"]
    else:
        hardware = computed_hardware
    if hardware["routellm_mf"]["completion_calls"] != 0:
        raise RuntimeError("A completion request was observed")
    write_json(hardware_path, hardware)
    aggregate = analysis_run(paths, frame, raw, hardware, request_audits, asset_audit, "offline_cache_replay" if args.offline else "online_cache_fill_and_analysis")
    print(json.dumps({"status": "complete", "go_no_go": aggregate["go_no_go"], "headline_metrics": aggregate["headline_metrics"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
