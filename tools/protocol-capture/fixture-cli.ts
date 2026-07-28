#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { diffBodies, diffHeaders } from "./diff.js";
import { assertValidManifest } from "./manifest.js";
import { DeterministicRedactor, sanitizeCapture } from "./redact.js";
import { scanFixtureDirectory } from "./secret-scan.js";
import type { CaptureRecord } from "./types.js";

const [rawArgument, outputArgument, manifestArgument] = process.argv.slice(2);
if (!rawArgument || !outputArgument || !manifestArgument) {
  throw new Error("usage: fixture-cli <raw-capture-dir> <fixture-output-dir> <manifest.json>");
}

const rawDirectory = resolve(rawArgument);
const outputDirectory = resolve(outputArgument);
const manifest = JSON.parse(await readFile(resolve(manifestArgument), "utf8")) as unknown;
assertValidManifest(manifest);
await mkdir(outputDirectory, { recursive: true });
for (const name of await readdir(outputDirectory)) {
  if (/^capture-[A-D]-\d+\.json$/.test(name)
    || /^(?:client-to-capture-request\.json|capture-to-client-(?:stream\.sse|response\.json)|auxiliary-requests\.json)$/.test(name)) {
    await unlink(`${outputDirectory}/${name}`);
  }
}
await writeFile(`${outputDirectory}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

const redactor = new DeterministicRedactor();
const ephemeralHashKey = randomBytes(32);
const rawFiles = (await readdir(rawDirectory)).filter((name) => name.endsWith(".json")).sort();
const captures: CaptureRecord[] = [];
const auxiliary: Array<Record<string, unknown>> = [];
for (const name of rawFiles) {
  const raw = JSON.parse(await readFile(`${rawDirectory}/${name}`, "utf8")) as CaptureRecord;
  if (raw.fixture_id !== manifest.fixture_id) continue;
  const sanitized = sanitizeCapture(raw, redactor, ephemeralHashKey);
  if (sanitized.protocol === "unknown") {
    auxiliary.push({
      capture_point: sanitized.capture_point,
      method: sanitized.request.method,
      path: sanitized.request.path,
      query: sanitized.request.query,
      response_status: sanitized.response.status_code,
      request_started_at: sanitized.connection.started_at,
      response_ended_at: sanitized.connection.response_ended_at,
      request_body_bytes: sanitized.request.body.byte_length,
      request_body_original_hmac: sanitized.request.body.sha256,
      response_body_bytes: sanitized.response.body.byte_length,
      response_body_original_hmac: sanitized.response.body.sha256,
      capture_error: sanitized.capture_error,
    });
    continue;
  }
  captures.push(sanitized);
  await writeFile(`${outputDirectory}/capture-${sanitized.capture_point}-${captures.length}.json`, `${JSON.stringify(sanitized, null, 2)}\n`);
}

if (auxiliary.length > 0) {
  await writeFile(`${outputDirectory}/auxiliary-requests.json`, `${JSON.stringify(auxiliary, null, 2)}\n`);
}

if (captures.length === 0) throw new Error(`No captures for fixture ${manifest.fixture_id} in ${rawDirectory}`);
const primary = captures.find((capture) => capture.request.method === "POST") ?? captures[0];
await writeFile(`${outputDirectory}/client-to-capture-request.json`, `${JSON.stringify(primary.request, null, 2)}\n`);
if (primary.response.streaming_events.length > 0) {
  await writeFile(`${outputDirectory}/capture-to-client-stream.sse`, primary.response.streaming_events.map((event) => event.raw_event).join(""));
} else {
  await writeFile(`${outputDirectory}/capture-to-client-response.json`, `${JSON.stringify(primary.response, null, 2)}\n`);
}

const comparable = captures.filter((capture) => capture.request.method === primary.request.method && capture.protocol === primary.protocol);
const diffReason = "Only one comparable capture point was available; no cross-hop transformation is asserted.";
const headerDiff = comparable.length >= 2
  ? diffHeaders(comparable[0].request.headers, comparable[1].request.headers)
  : { status: "not_computable", reason: diffReason, added: [], removed: [], changed: [] };
let bodyDiff: unknown = { status: "not_computable", reason: diffReason, differences: [] };
if (comparable.length >= 2) {
  const parse = (record: CaptureRecord): unknown => {
    try { return JSON.parse(record.request.body.raw) as unknown; } catch { return record.request.body.raw; }
  };
  bodyDiff = { status: "computed", differences: diffBodies(parse(comparable[0]), parse(comparable[1])) };
}
await writeFile(`${outputDirectory}/header-diff.json`, `${JSON.stringify(headerDiff, null, 2)}\n`);
await writeFile(`${outputDirectory}/body-diff.json`, `${JSON.stringify(bodyDiff, null, 2)}\n`);

const findings = await scanFixtureDirectory(outputDirectory);
if (findings.length > 0) {
  throw new Error(`Sanitized fixture failed secret scan: ${findings.map((item) => `${basename(item.file)}:${item.line}:${item.rule}`).join(", ")}`);
}
console.log(`Created sanitized fixture ${manifest.fixture_id} from ${captures.length} capture record(s); original HMAC key discarded.`);
