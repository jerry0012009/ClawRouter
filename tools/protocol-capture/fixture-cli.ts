#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { diffBodies, diffHeaders } from "./diff.js";
import { assertValidManifest } from "./manifest.js";
import { DeterministicRedactor, sanitizeCapture } from "./redact.js";
import { scanFixtureDirectory } from "./secret-scan.js";
import type { CaptureRecord } from "./types.js";

type JsonObject = Record<string, unknown>;

function parseBody(record: CaptureRecord): unknown {
  try { return JSON.parse(record.request.body.raw) as unknown; } catch { return record.request.body.raw; }
}

function collectNamedStrings(value: unknown, names: Set<string>, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => collectNamedStrings(item, names, result));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as JsonObject)) {
      if (names.has(key) && typeof child === "string") result.add(child);
      collectNamedStrings(child, names, result);
    }
  }
  return result;
}

function usage(record: CaptureRecord): unknown[] {
  return record.response.streaming_events
    .map((event) => event.usage_event)
    .filter((value) => value !== null);
}

function eventSummary(record: CaptureRecord): JsonObject {
  const events = record.response.streaming_events;
  return {
    count: events.length,
    names: events.map((event) => event.event_name),
    raw_bytes: Buffer.byteLength(events.map((event) => event.raw_event).join("")),
    completed: events.some((event) => event.completed_stop_event),
    error_count: events.filter((event) => event.error_event !== null).length,
  };
}

function correlation(record: CaptureRecord): JsonObject {
  const headers = { ...record.request.headers, ...record.response.headers };
  const selected = Object.fromEntries(Object.entries(headers).filter(([name]) => /request-id|session-id|thread-id/i.test(name)));
  return { captured_ids: record.ids, headers: selected };
}

function pairCaptures(captures: CaptureRecord[]): Array<{ left: CaptureRecord; right: CaptureRecord }> {
  const post = captures.filter((capture) => capture.request.method === "POST");
  const points = [...new Set(post.map((capture) => capture.capture_point))].sort();
  if (points.length < 2) return [];
  const left = post.filter((capture) => capture.capture_point === points[0])
    .sort((a, b) => a.connection.started_at.localeCompare(b.connection.started_at));
  const right = post.filter((capture) => capture.capture_point === points[1])
    .sort((a, b) => a.connection.started_at.localeCompare(b.connection.started_at));
  return right.map((upstream) => {
    const candidates = left.filter((client) => client.connection.started_at <= upstream.connection.started_at);
    return { left: candidates.at(-1) ?? left[0], right: upstream };
  });
}

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
    || /^(?:client-to-(?:capture|newapi)-request\.json|newapi-to-(?:acu|provider)-request\.json|(?:capture|newapi)-to-client-(?:stream\.sse|response\.json)|(?:acu|provider)-to-newapi-(?:stream\.sse|response\.json)|auxiliary-requests\.json|hop-diffs\.json)$/.test(name)) {
    await unlink(`${outputDirectory}/${name}`);
  }
}
await writeFile(`${outputDirectory}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

const redactor = new DeterministicRedactor();
const ephemeralHashKey = randomBytes(32);
const rawFiles = (await readdir(rawDirectory)).filter((name) => name.endsWith(".json")).sort();
const captures: CaptureRecord[] = [];
const pointCounts = new Map<string, number>();
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
  const pointIndex = (pointCounts.get(sanitized.capture_point) ?? 0) + 1;
  pointCounts.set(sanitized.capture_point, pointIndex);
  await writeFile(`${outputDirectory}/capture-${sanitized.capture_point}-${pointIndex}.json`, `${JSON.stringify(sanitized, null, 2)}\n`);
}

if (auxiliary.length > 0) {
  await writeFile(`${outputDirectory}/auxiliary-requests.json`, `${JSON.stringify(auxiliary, null, 2)}\n`);
}

if (captures.length === 0) throw new Error(`No captures for fixture ${manifest.fixture_id} in ${rawDirectory}`);
const primary = captures.find((capture) => capture.request.method === "POST") ?? captures[0];
const hasNewApi = String((manifest as JsonObject).newapi_version) !== "not_applicable";
await writeFile(`${outputDirectory}/${hasNewApi ? "client-to-newapi" : "client-to-capture"}-request.json`, `${JSON.stringify(primary.request, null, 2)}\n`);
if (primary.response.streaming_events.length > 0) {
  await writeFile(`${outputDirectory}/${hasNewApi ? "newapi-to-client" : "capture-to-client"}-stream.sse`, primary.response.streaming_events.map((event) => event.raw_event).join(""));
} else {
  await writeFile(`${outputDirectory}/${hasNewApi ? "newapi-to-client" : "capture-to-client"}-response.json`, `${JSON.stringify(primary.response, null, 2)}\n`);
}

const pairs = pairCaptures(captures);
const comparable = pairs.length > 0 ? [pairs[0].left, pairs[0].right] : [primary];
const diffReason = "Only one comparable capture point was available; no cross-hop transformation is asserted.";
const headerDiff = comparable.length >= 2
  ? diffHeaders(comparable[0].request.headers, comparable[1].request.headers)
  : { status: "not_computable", reason: diffReason, added: [], removed: [], changed: [] };
let bodyDiff: unknown = { status: "not_computable", reason: diffReason, differences: [] };
if (comparable.length >= 2) {
  bodyDiff = { status: "computed", differences: diffBodies(parseBody(comparable[0]), parseBody(comparable[1])) };
}
await writeFile(`${outputDirectory}/header-diff.json`, `${JSON.stringify(headerDiff, null, 2)}\n`);
await writeFile(`${outputDirectory}/body-diff.json`, `${JSON.stringify(bodyDiff, null, 2)}\n`);

if (pairs.length > 0) {
  const throughAcu = (manifest as JsonObject).through_acu === true;
  const firstUpstream = pairs[0].right;
  await writeFile(`${outputDirectory}/newapi-to-${throughAcu ? "acu" : "provider"}-request.json`, `${JSON.stringify(firstUpstream.request, null, 2)}\n`);
  if (firstUpstream.response.streaming_events.length > 0) {
    await writeFile(`${outputDirectory}/${throughAcu ? "acu" : "provider"}-to-newapi-stream.sse`, firstUpstream.response.streaming_events.map((event) => event.raw_event).join(""));
  } else {
    await writeFile(`${outputDirectory}/${throughAcu ? "acu" : "provider"}-to-newapi-response.json`, `${JSON.stringify(firstUpstream.response, null, 2)}\n`);
  }
  const hopDiffs = pairs.map(({ left, right }, index) => {
    const leftBody = parseBody(left);
    const rightBody = parseBody(right);
    const idNames = new Set(["id", "call_id", "tool_use_id"]);
    const leftIds = [...collectNamedStrings(leftBody, idNames)].sort();
    const rightIds = [...collectNamedStrings(rightBody, idNames)].sort();
    return {
      sequence: index + 1,
      status: { client_hop: left.response.status_code, upstream_hop: right.response.status_code },
      header_diff: diffHeaders(left.request.headers, right.request.headers),
      body_diff: diffBodies(leftBody, rightBody),
      streaming_event_diff: { client_hop: eventSummary(left), upstream_hop: eventSummary(right) },
      error_diff: {
        client_capture_error: left.capture_error,
        upstream_capture_error: right.capture_error,
        status_equal: left.response.status_code === right.response.status_code,
      },
      usage_diff: { client_hop: usage(left), upstream_hop: usage(right) },
      request_id_mapping: { client_hop: correlation(left), upstream_hop: correlation(right) },
      model_mapping: { client_hop: left.model, upstream_hop: right.model, unchanged: left.model === right.model },
      tool_id_mapping: {
        client_hop: leftIds,
        upstream_hop: rightIds,
        unchanged: JSON.stringify(leftIds) === JSON.stringify(rightIds),
      },
    };
  });
  await writeFile(`${outputDirectory}/hop-diffs.json`, `${JSON.stringify(hopDiffs, null, 2)}\n`);
}

const findings = await scanFixtureDirectory(outputDirectory);
if (findings.length > 0) {
  throw new Error(`Sanitized fixture failed secret scan: ${findings.map((item) => `${basename(item.file)}:${item.line}:${item.rule}`).join(", ")}`);
}
console.log(`Created sanitized fixture ${manifest.fixture_id} from ${captures.length} capture record(s); original HMAC key discarded.`);
