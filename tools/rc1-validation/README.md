# ACU Alpha RC1 validation tools

`provider-preflight.ts` validates only real CloseAI native endpoints. It never writes credentials or response text to disk and emits only capability, model, usage, and estimated-cost metadata.

Required local environment:

```text
CLOSEAI_API_KEY=<local test key>
```

Optional:

```text
CLOSEAI_OPENAI_BASE_URL=https://api.openai-proxy.org/v1
CLOSEAI_ANTHROPIC_BASE_URL=https://api.openai-proxy.org/anthropic
RC1_CONTEXT_PROBE_TOKENS=32768
RC1_PREFLIGHT_CANDIDATES_JSON=[...]
```

Run:

```bash
npx tsx tools/rc1-validation/provider-preflight.ts
```

Do not redirect output into the repository unless it has been reviewed and deterministically sanitized. A successful lower-bound context probe does not prove the provider's full advertised context window.
