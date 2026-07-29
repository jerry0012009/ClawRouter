#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmod, open, readFile, rename } from "node:fs/promises";
import { promisify } from "node:util";
import { validateDotenv } from "./normalize-env.js";

const execute = promisify(execFile);
const target = process.argv[2] ?? ".env";
const containers = process.argv.slice(3);
if (containers.length === 0) throw new Error("At least one source container is required");
const required = new Set([
  "POSTGRES_NEWAPI_PASSWORD", "POSTGRES_ACU_PASSWORD", "ACU_TRUSTED_IDENTITY_SECRET",
  "ACU_ADMIN_TRACE_TOKEN", "ACU_JUDGE_API_KEY", "CLOSEAI_API_KEY", "NEW_API_SESSION_SECRET",
]);
const current = await readFile(target, "utf8");
validateDotenv(current);
const present = new Set(current.split(/\r?\n/).flatMap((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1] ?? []));
const found = new Map<string, string>();
for (const container of containers) {
  const { stdout } = await execute("docker", ["inspect", "--format", "{{json .Config.Env}}", container], { maxBuffer: 2_000_000 });
  const values = JSON.parse(stdout) as string[];
  for (const item of values) {
    const separator = item.indexOf("=");
    const name = separator > 0 ? item.slice(0, separator) : "";
    if (required.has(name) && !found.has(name)) found.set(name, item.slice(separator + 1));
    if (name === "POSTGRES_PASSWORD" && container.includes("postgres-newapi")) {
      found.set("POSTGRES_NEWAPI_PASSWORD", item.slice(separator + 1));
    }
    if (name === "POSTGRES_PASSWORD" && container.includes("postgres-acu")) {
      found.set("POSTGRES_ACU_PASSWORD", item.slice(separator + 1));
    }
    if (name === "SESSION_SECRET" && container.includes("new-api")) {
      found.set("NEW_API_SESSION_SECRET", item.slice(separator + 1));
    }
  }
}
const missing = [...required].filter((name) => !present.has(name) && !found.has(name));
if (missing.length) throw new Error(`Runtime containers lack required variables: ${missing.join(",")}`);
const additions = [...required].filter((name) => !present.has(name)).map((name) => `${name}=${found.get(name)}`);
const output = `${current.trimEnd()}\n\n# ACU deployment secrets adopted from the existing isolated runtime.\n${additions.join("\n")}\n`;
validateDotenv(output);
const temp = `${target}.adopt-${process.pid}`;
const handle = await open(temp, "wx", 0o600);
try { await handle.writeFile(output); await handle.sync(); } finally { await handle.close(); }
await chmod(temp, 0o600);
await rename(temp, target);
await chmod(target, 0o600);
console.log(JSON.stringify({ adoptedVariableNames: additions.map((line) => line.slice(0, line.indexOf("="))), permissions: "600" }));
