# Transparent Protocol Capture Harness

This tool inserts a byte-preserving HTTP/SSE relay at capture point A, B, C, or D. It records the inbound request, upstream response, raw SSE event boundaries, timing, cancellation, correlation IDs, model, provider and protocol. It never invokes ACU Judge or routing code.

## Start a capture instance

Keep `PROTOCOL_CAPTURE_DIR` outside the repository for all real traffic.

```bash
PROTOCOL_CAPTURE_POINT=A \
PROTOCOL_CAPTURE_UPSTREAM=https://new-api.example.test \
PROTOCOL_CAPTURE_DIR=/var/lib/acu-protocol-captures/run-001 \
PROTOCOL_FIXTURE_ID=codex-0.145.0-C01-newapi-001 \
PROTOCOL_CAPTURE_PORT=9081 \
npm run protocol:capture
```

Use a second instance for B/C when deployment allows Base URL insertion. The incoming path and query are forwarded unchanged; the TCP destination and HTTP `Host` necessarily target the configured upstream.

## Controlled mock provider

`npm run protocol:mock` starts an isolated Responses/Messages/Chat Completions provider for harness and native-client tests. A Mock result proves only the observed client and capture behavior; it must never be labelled as real Provider compatibility.

Controlled failure variables are `PROTOCOL_MOCK_STATUS`, `PROTOCOL_MOCK_FAIL_COUNT`, `PROTOCOL_MOCK_DELAY_MS`, and `PROTOCOL_MOCK_STREAM_DELAY_MS`. A non-200 status fails every request unless `PROTOCOL_MOCK_FAIL_COUNT` limits failures; the next request then returns the normal protocol response. The stream delay sends SSE headers immediately, then delays the first event for idle-timeout tests. These controls are for retry/timeout observation only.

## Raw record

Each completed or interrupted exchange produces a mode-0600 JSON record containing:

- method, path, query, headers and raw body;
- response status, headers and raw non-streaming/stream body;
- per-event SSE name, sequence, raw event, arrival time and extracted delta/usage/stop/error fields;
- connection start/end/interruption and client cancellation timestamps;
- New API, ACU, upstream and Provider request IDs when present.

Raw records contain secrets and must not be committed. Build repository fixtures only after applying deterministic redaction and running `npm run protocol:scan`.

## CloseAI endpoints

- OpenAI-compatible: configure the client-visible path under `https://api.openai-proxy.org/v1`.
- Anthropic-compatible: configure the client-visible path under `https://api.openai-proxy.org/anthropic`; Claude Messages then targets `/anthropic/v1/messages`.

Exact behavior remains unconfirmed until a native-client Fixture is captured for the selected model and endpoint.
