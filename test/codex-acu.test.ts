import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("codex-acu isolated launcher", () => {
  it("installs into an independent CODEX_HOME and leaves native Codex state untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-acu-test-"));
    const fakeBin = join(root, "fake-bin");
    const installBin = join(root, "install-bin");
    const acuHome = join(root, "acu-home");
    const nativeHome = join(root, "native-home");
    await Promise.all([fakeBin, nativeHome].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(nativeHome, "config.toml"), "model = \"native\"\n");
    const fakeCodex = join(fakeBin, "codex");
    await writeFile(fakeCodex, "#!/bin/sh\nprintf '%s\\n' \"$CODEX_HOME|$*\"\n");
    await chmod(fakeCodex, 0o755);
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
    const install = spawnSync(resolve("tools/codex-acu/install.sh"), [
      "--base-url", "https://acu.example.test/v1",
      "--bin-dir", installBin,
      "--acu-home", acuHome,
    ], { env, encoding: "utf8" });
    expect(install.status).toBe(0);
    const config = await readFile(join(acuHome, "config.toml"), "utf8");
    expect(config).toContain('model = "acu-auto"');
    expect(config).toContain("model_context_window = 272000");
    expect(config).toContain("model_auto_compact_token_limit = 258400");
    expect(config).toContain('model_auto_compact_token_limit_scope = "total"');
    expect(config).toContain(`model_catalog_json = "${acuHome}/model-catalog.json"`);
    expect(await readFile(join(acuHome, "model-catalog.json"), "utf8")).toContain('"slug": "acu-auto"');
    expect(config).toContain('base_url = "https://acu.example.test/v1"');
    expect(config).toContain('env_key = "ACU_API_KEY"');
    expect(config).not.toContain("test-only-key");
    const credential = spawnSync(join(installBin, "codex-acu"), ["credentials", "set"], {
      env: { ...env, CODEX_ACU_HOME: acuHome },
      input: "sk-test-only-key\n",
      encoding: "utf8",
    });
    expect(credential.status).toBe(0);
    expect(await readFile(join(acuHome, "credentials"), "utf8")).toBe("sk-test-only-key\n");
    expect((await stat(join(acuHome, "credentials"))).mode & 0o777).toBe(0o600);
    const launch = spawnSync(join(installBin, "codex-acu"), ["doctor"], {
      env: { ...env, CODEX_ACU_HOME: acuHome },
      encoding: "utf8",
    });
    expect(launch.status).toBe(0);
    expect(launch.stdout).toContain("codex-acu: healthy");
    expect(launch.stdout).toContain(acuHome);
    expect(launch.stdout).toContain("effective model: acu-auto");
    expect(launch.stdout).toContain("model_provider: acu-founder-alpha");
    expect(launch.stdout).toContain("reasoning effort: medium");
    const effective = spawnSync(join(installBin, "codex-acu"), ["exec", "hello"], {
      env: { ...env, CODEX_ACU_HOME: acuHome },
      encoding: "utf8",
    });
    expect(effective.status).toBe(0);
    expect(effective.stdout).toContain('-m acu-auto -c model_provider="acu-founder-alpha"');
    expect(effective.stdout).toContain('-c model_reasoning_effort="medium" exec hello');
    expect(effective.stdout).not.toContain("--sandbox workspace-write");
    const override = spawnSync(join(installBin, "codex-acu"), ["-m", "gpt-5.6-sol"], {
      env: { ...env, CODEX_ACU_HOME: acuHome },
      encoding: "utf8",
    });
    expect(override.status).toBe(2);
    expect(await readFile(join(nativeHome, "config.toml"), "utf8")).toBe('model = "native"\n');

    const uninstall = spawnSync(resolve("tools/codex-acu/uninstall.sh"), [], {
      env: { ...env, CODEX_ACU_HOME: acuHome, CODEX_ACU_BIN_DIR: installBin },
      encoding: "utf8",
    });
    expect(uninstall.status).toBe(0);
    await expect(stat(join(installBin, "codex-acu"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(acuHome, "config.toml"), "utf8")).toBe(config);
  });
});
