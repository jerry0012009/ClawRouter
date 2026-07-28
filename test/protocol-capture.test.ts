import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeterministicRedactor,
  diffBodies,
  diffHeaders,
  sanitizeCapture,
  scanFixtureDirectory,
  scanTextForSecrets,
  startCaptureProxy,
  validateManifest,
  type CaptureRecord,
} from "../tools/protocol-capture/index.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

async function upstream(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function capture(upstreamUrl: string, onRecord: (record: CaptureRecord) => void): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acu-capture-test-"));
  const proxy = await startCaptureProxy({ upstream: upstreamUrl, captureDir: directory, capturePoint: "A", fixtureId: "test-fixture", onRecord });
  closers.push(proxy.close);
  return proxy.baseUrl;
}

function waitForRecord(): { promise: Promise<CaptureRecord>; accept: (record: CaptureRecord) => void } {
  let accept!: (record: CaptureRecord) => void;
  return { promise: new Promise((resolve) => { accept = resolve; }), accept };
}

describe("protocol capture proxy", () => {
  it("forwards method, path, query and request body", async () => {
    let observed = "";
    const target = await upstream(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      observed = `${req.method} ${req.url} ${Buffer.concat(chunks).toString()}`;
      res.writeHead(201, { "content-type": "application/json" }).end('{"ok":true}');
    });
    const record = waitForRecord();
    const base = await capture(target, record.accept);
    const response = await fetch(`${base}/v1/responses?trace=yes`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"model":"mock"}' });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"ok":true}');
    expect(observed).toBe('POST /v1/responses?trace=yes {"model":"mock"}');
    const saved = await record.promise;
    expect(saved.request.path).toBe("/v1/responses");
    expect(saved.request.query).toBe("trace=yes");
    expect(saved.model).toBe("mock");
  });

  it("passes a non-streaming response byte-for-byte", async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    const target = await upstream((_req, res) => res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length }).end(bytes));
    const record = waitForRecord();
    const base = await capture(target, record.accept);
    const response = await fetch(`${base}/binary`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect((await record.promise).response.body.encoding).toBe("base64");
  });

  it("relays SSE chunks immediately and records every raw event", async () => {
    const raw = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"one"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    ];
    const target = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(raw[0]);
      setTimeout(() => res.end(raw[1]), 5);
    });
    const record = waitForRecord();
    const base = await capture(target, record.accept);
    const response = await fetch(`${base}/v1/responses`, { method: "POST", body: '{"stream":true}' });
    expect(await response.text()).toBe(raw.join(""));
    const saved = await record.promise;
    expect(saved.response.streaming_events).toHaveLength(2);
    expect(saved.response.streaming_events[0].text_delta).toBe("one");
    expect(saved.response.streaming_events[1].completed_stop_event).toBe(true);
    expect(saved.response.streaming_events.map((event) => event.raw_event).join("")).toBe(raw.join(""));
  });

  it("propagates and records client cancellation", async () => {
    let upstreamClosed = false;
    const target = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      res.on("close", () => { upstreamClosed = true; });
    });
    const record = waitForRecord();
    const base = await capture(target, record.accept);
    await new Promise<void>((resolve) => {
      const req = httpRequest(`${base}/v1/responses`, { method: "POST" }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.end('{"stream":true}');
    });
    const saved = await record.promise;
    expect(saved.connection.client_cancelled).toBe(true);
    expect(saved.connection.client_cancelled_at).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(upstreamClosed).toBe(true);
  });

  it("does not alter tool calling response content", async () => {
    const tool = '{"id":"resp_1","output":[{"type":"function_call","call_id":"call_1","name":"shell","arguments":"{\\"cmd\\":\\"pwd\\"}"}]}';
    const target = await upstream((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(tool));
    const record = waitForRecord();
    const base = await capture(target, record.accept);
    expect(await (await fetch(`${base}/v1/responses`, { method: "POST", body: "{}" })).text()).toBe(tool);
    expect((await record.promise).response.body.raw).toBe(tool);
  });
});

describe("redaction and fixture safety", () => {
  it("redacts headers, bodies and paths with stable placeholders", () => {
    const redactor = new DeterministicRedactor();
    expect(redactor.headers({ authorization: "Bearer sk-supersecret", "x-api-key": "sk-supersecret" })).toEqual({
      authorization: "<REDACTED_AUTHORIZATION_1>",
      "x-api-key": "<REDACTED_API_KEY_1>",
    });
    const first = redactor.value({ token: "same-secret", path: "/root/private/repo" });
    const second = redactor.value({ token: "same-secret" });
    expect(first).toEqual({ token: "<REDACTED_TOKEN_1>", path: "<REDACTED_USER_HOME_1>/private/repo" });
    expect(second).toEqual({ token: "<REDACTED_TOKEN_1>" });
  });

  it("sanitizes capture payloads and uses non-reversible keyed hashes", () => {
    const sample = {
      schema_version: "acu-protocol-capture-v1", fixture_id: "f", capture_id: "c", capture_point: "A",
      connection: { started_at: "now", request_ended_at: null, response_started_at: null, response_ended_at: null, interrupted_at: null, client_cancelled: false, client_cancelled_at: null },
      request: { method: "POST", path: "/v1/responses", query: "", headers: { authorization: "Bearer secret-value" }, body: { encoding: "utf8", raw: '{"api_key":"secret-value"}', byte_length: 26, sha256: "plain" } },
      response: { status_code: 200, headers: {}, body: { encoding: "utf8", raw: "ok", byte_length: 2, sha256: "plain" }, streaming_events: [] },
      ids: { upstream_request_id: null, new_api_request_id: null, acu_request_id: null, provider_request_id: null }, model: null, provider: null, protocol: "responses", upstream_url: "http://example.test", capture_error: null,
    } satisfies CaptureRecord;
    const sanitized = sanitizeCapture(sample, new DeterministicRedactor(), Buffer.alloc(32, 7));
    expect(sanitized.request.body.raw).not.toContain("secret-value");
    expect(sanitized.request.body.sha256).toMatch(/^hmac-sha256:/);
    expect(scanTextForSecrets(JSON.stringify(sanitized))).toEqual([]);
  });

  it("fails fixture scans for secrets and .env files", async () => {
    const root = await mkdtemp(join(tmpdir(), "acu-secret-test-"));
    await mkdir(join(root, "fixture"));
    await writeFile(join(root, "fixture", "request.json"), '{"Authorization":"Bearer actual-token"}');
    await writeFile(join(root, ".env"), "TOKEN=value");
    const findings = await scanFixtureDirectory(root);
    expect(findings.map((item) => item.rule)).toContain("authorization-bearer");
    expect(findings.map((item) => item.rule)).toContain("env-file");
  });
});

describe("fixture schema and diffs", () => {
  it("validates the required manifest contract", () => {
    const manifest = { fixture_id: "codex-0.145.0-C01-mock-001", captured_at: "2026-07-28T12:00:00Z", client: "codex", client_version: "0.145.0", os: "Ubuntu 24.04", newapi_version: "not-present", acu_commit: "bf5e442", provider: "controlled-mock", requested_model: "mock", actual_model: "mock", protocol: "responses", stream: false, scenario: "C01", request_count: 1, contains_tools: false, contains_reasoning: false, contains_plan_signal: false, capture_points: ["A"], sanitized: true, capture_status: "partial" };
    expect(validateManifest(manifest)).toEqual([]);
    expect(validateManifest({ ...manifest, sanitized: false, capture_status: "invented" })).toEqual(expect.arrayContaining(["sanitized must be true", "capture_status is invalid"]));
  });

  it("builds deterministic header and body diffs", () => {
    expect(diffHeaders({ Authorization: "x", remove: "y" }, { authorization: "z", added: "v" })).toEqual({
      added: [{ path: "added", after: "v" }],
      removed: [{ path: "remove", before: "y" }],
      changed: [{ path: "authorization", before: "x", after: "z" }],
    });
    expect(diffBodies({ model: "alias", nested: { keep: 1 } }, { model: "actual", nested: { keep: 1 }, stream: true })).toEqual([
      { path: "$.model", before: "alias", after: "actual" },
      { path: "$.stream", after: true },
    ]);
  });
});
