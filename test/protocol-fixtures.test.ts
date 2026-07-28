import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanFixtureDirectory, validateManifest } from "../tools/protocol-capture/index.js";

const fixtureRoot = join(process.cwd(), "test", "protocol-fixtures");

async function manifestsBelow(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await manifestsBelow(path));
    else if (entry.name === "manifest.json" && path !== join(fixtureRoot, "manifest.schema.json")) result.push(path);
  }
  return result;
}

describe("committed protocol fixtures", () => {
  it("defines every required field in the JSON Schema", async () => {
    const schema = JSON.parse(await readFile(join(fixtureRoot, "manifest.schema.json"), "utf8")) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const expected = [
      "fixture_id", "captured_at", "client", "client_version", "os", "newapi_version", "acu_commit",
      "provider", "requested_model", "actual_model", "protocol", "stream", "scenario", "request_count",
      "contains_tools", "contains_reasoning", "contains_plan_signal", "capture_points", "sanitized", "capture_status",
    ];
    expect(schema.required).toEqual(expected);
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(expected));
  });

  it("validates every committed fixture manifest", async () => {
    const manifests = await manifestsBelow(fixtureRoot);
    expect(manifests.length).toBeGreaterThan(0);
    for (const file of manifests) {
      const value = JSON.parse(await readFile(file, "utf8")) as unknown;
      expect(validateManifest(value), file).toEqual([]);
    }
  });

  it("contains no detected secret", async () => {
    expect(await scanFixtureDirectory(fixtureRoot)).toEqual([]);
  });
});
