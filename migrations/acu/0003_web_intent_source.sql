BEGIN;

ALTER TABLE acu_judge_evaluations
  ADD COLUMN IF NOT EXISTS web_intent TEXT
    CHECK (web_intent IN ('required', 'likely', 'not_required')),
  ADD COLUMN IF NOT EXISTS web_intent_confidence DOUBLE PRECISION
    CHECK (web_intent_confidence BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS web_intent_reason TEXT,
  ADD COLUMN IF NOT EXISTS web_intent_evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS web_intent_source TEXT
    CHECK (web_intent_source IN ('judge', 'heuristic_fallback', 'legacy_heuristic'));

COMMIT;
