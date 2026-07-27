PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE routing_requests (
  request_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  session_hash TEXT,
  context_sha256 TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  routing_model_version TEXT NOT NULL,
  judge_status TEXT NOT NULL,
  judge_model TEXT NOT NULL,
  judge_provider TEXT NOT NULL,
  difficulty_score REAL NOT NULL,
  p_low REAL NOT NULL,
  p_mid REAL NOT NULL,
  p_mid_high REAL NOT NULL,
  p_high REAL NOT NULL,
  judge_confidence REAL NOT NULL,
  judge_latency_ms INTEGER NOT NULL,
  judge_tokens INTEGER,
  judge_cost REAL NOT NULL,
  requested_model TEXT,
  recommended_model TEXT,
  actual_model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  actual_cost REAL,
  latency_ms INTEGER,
  final_status TEXT,
  had_tools INTEGER NOT NULL DEFAULT 0,
  error_category TEXT
);

CREATE TABLE model_candidate_scores (
  request_id TEXT NOT NULL REFERENCES routing_requests(request_id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  predicted_score REAL NOT NULL,
  conservative_score REAL NOT NULL,
  expected_call_cost REAL NOT NULL,
  expected_total_cost REAL NOT NULL,
  value_utility REAL NOT NULL,
  pareto_efficient INTEGER NOT NULL,
  selected INTEGER NOT NULL,
  PRIMARY KEY(request_id, model_id)
);

CREATE TABLE user_feedback (
  feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES routing_requests(request_id) ON DELETE CASCADE,
  accepted INTEGER,
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  required_upgrade INTEGER,
  final_model TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE execution_outcomes (
  outcome_id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES routing_requests(request_id) ON DELETE CASCADE,
  validator_result TEXT,
  test_result TEXT,
  tool_error_count INTEGER,
  retry_count INTEGER,
  model_switched INTEGER,
  user_retried INTEGER,
  outcome_score REAL,
  outcome_source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
