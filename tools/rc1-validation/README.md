# ACU Alpha RC1 validation tools

`provider-preflight.ts` validates only real CloseAI native endpoints. It never writes credentials or response text to disk and emits only capability, model, usage, and estimated-cost metadata. Paid validation is fail-closed and cannot start unless the local operator explicitly enables and budgets the run.

Required local environment:

```text
CLOSEAI_API_KEY=<local test key>
ACU_LIVE_TEST_ENABLED=true
ACU_TEST_RUN_BUDGET_CNY=5
ACU_TEST_TOTAL_BUDGET_CNY=30
ACU_TEST_MAX_CONCURRENCY=1
ACU_TEST_MAX_OUTPUT_TOKENS=4096
ACU_TEST_REQUIRE_APPROVAL_ABOVE_CNY=5
ACU_TEST_BUDGET_STATE_FILE=/var/lib/acu-protocol-recon/live-test-budget.json
```

Optional:

```text
CLOSEAI_OPENAI_BASE_URL=https://api.openai-proxy.org/v1
CLOSEAI_ANTHROPIC_BASE_URL=https://api.openai-proxy.org/anthropic
RC1_CONTEXT_PROBE_TOKENS=32768
RC1_PREFLIGHT_CANDIDATES_JSON=[...]
ACU_TEST_USD_TO_CNY=7.2
ACU_TEST_COST_APPROVED=false
```

Run:

```bash
npx tsx tools/rc1-validation/provider-preflight.ts
```

Do not redirect output into the repository unless it has been reviewed and deterministically sanitized. A successful lower-bound context probe does not prove the provider's full advertised context window.

`native-task-matrix.ts` runs the versioned 14-task matrix per native protocol against the isolated New API deployment. It creates disposable copies under the system temporary directory and emits metadata plus hashes, never prompts, model output, or credentials. Responses runs require `RC1_NEW_API_CODEX_TOKEN` and `RC1_CODEX_HOME`; Messages runs require `RC1_NEW_API_CLAUDE_TOKEN` and `RC1_CLAUDE_CONFIG_DIR`. Select a protocol with `RC1_MATRIX_PROTOCOL` and optionally set `RC1_MATRIX_IDS`. `RC1_MATRIX_CONCURRENCY` defaults to 1 and cannot exceed `ACU_TEST_MAX_CONCURRENCY`. Set a conservative pre-run estimate with `RC1_MATRIX_ESTIMATED_COST_USD_PER_TASK`; the default is USD 0.50 per selected task. Matrix settlement intentionally records that estimate when the harness cannot authoritatively read New API's final ledger; reconcile it against the database after the run.

The budget state file contains no credentials but should remain outside the repository. A crashed run leaves its reservation in place, intentionally blocking further paid tests until an operator reconciles the provider/New API ledger. Do not delete or edit it merely to bypass the cap.

`judge-live-validation.ts` reuses `readAcuRuntimeConfig`, `AcuJudgeClient`, and `createAcuJudgeRunner`. It performs one real upstream call followed by an identical cache lookup, then uses a clearly labelled controlled invalid-JSON fetch to verify `rules_fallback` and `recent_evaluation`. It never implements a second Judge configuration, cache, or formula.
