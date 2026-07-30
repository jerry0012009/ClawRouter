import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const paths: string[] = [];
const launcher = resolve("tools/codex-acu/codex-acu");

async function fixture(): Promise<{ root: string; acuHome: string; bin: string; marker: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-acu-gate-"));
  paths.push(root);
  const acuHome = join(root, "acu-home");
  const bin = join(root, "bin");
  const marker = join(root, "codex-called");
  await mkdir(acuHome);
  await mkdir(bin);
  await chmod(acuHome, 0o700);
  await writeFile(join(acuHome, "config.toml"), 'model = "acu-auto"\n');
  await writeFile(join(acuHome, "credentials"), "sk-test-not-production\n", { mode: 0o600 });
  await writeFile(join(bin, "codex"), `#!/bin/sh\nprintf '%s\\n' "$*" > "${marker}"\n`, { mode: 0o755 });
  return { root, acuHome, bin, marker };
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("codex-acu native workspace behavior", () => {
  it("starts in a writable Git repository without forcing a sandbox", async () => {
    const value = await fixture();
    const workspace = join(value.root, "work");
    await mkdir(workspace);
    await execFileAsync("git", ["-C", workspace, "init", "-q"]);
    await execFileAsync(launcher, ["-C", workspace, "read one file"], {
      env: { ...process.env, CODEX_ACU_HOME: value.acuHome, PATH: `${value.bin}:${process.env.PATH}` },
    });
    const argumentsPassed = await import("node:fs/promises").then(({ readFile }) => readFile(value.marker, "utf8"));
    expect(argumentsPassed).not.toContain("--sandbox");
    expect(argumentsPassed).toContain(`-C ${workspace}`);
  });

  it("starts in a non-Git directory and passes through the native sandbox option", async () => {
    const value = await fixture();
    const workspace = join(value.root, "not-git");
    await mkdir(workspace);
    await execFileAsync(launcher, ["-C", workspace, "--sandbox", "read-only", "read one file"], {
      env: { ...process.env, CODEX_ACU_HOME: value.acuHome, PATH: `${value.bin}:${process.env.PATH}` },
    });
    const argumentsPassed = await import("node:fs/promises").then(({ readFile }) => readFile(value.marker, "utf8"));
    expect(argumentsPassed).toContain(`-C ${workspace} --sandbox read-only`);
  });
});
