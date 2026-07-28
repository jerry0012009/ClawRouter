# Sanitized Native Protocol Fixtures

Only deterministic, sanitized captures are committed here. Raw captures are stored outside the repository and are never a source of production rules by themselves.

## Layout

```text
codex/<client-version>/<scenario>/
claude-code/<client-version>/<scenario>/
```

Every scenario includes `manifest.json`, `header-diff.json`, `body-diff.json`, and `observation.md`. Files for an unobservable hop are deliberately absent. Partial direct-to-capture or direct-to-provider tests use truthful names such as `client-to-capture-request.json`; they do not create files named `newapi-to-acu-request.json` when New API/ACU were not in the chain.

`capture-<point>-<n>.json` is the complete sanitized harness record. `.sse` files preserve event bytes and ordering; they are not reconstructed from final text.

## Status meanings

- `complete`: every capture point required by that scenario was observed.
- `partial`: a real native-client execution completed, but one or more intended hops were unavailable.
- `blocked`: no scenario request could run because a required client, credential, account, balance, deployment control, or log was unavailable.
- `failed`: the real request ran and produced a client, gateway, protocol, provider, tool, or environment failure. The failure is evidence, not compatibility support.

## Safety and validation

```bash
npm run protocol:scan
npm test -- --run test/protocol-capture.test.ts test/protocol-fixtures.test.ts
```

Original content fingerprints use HMAC-SHA256 with an ephemeral per-generation key that is discarded. This retains a non-reversible capture fingerprint without committing a key that could assist offline secret guessing. Placeholders are stable within one fixture generation.

No fixture may be labelled “measured” without a native Codex or Claude Code process in the recorded chain. Controlled Mock fixtures prove client/Harness behavior only and never prove OpenRouter, CloseAI, New API, or ACU compatibility.
