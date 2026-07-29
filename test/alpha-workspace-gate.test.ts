import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeResponsesRequest } from "../src/alpha/protocol/responses.js";
import { verifyLocalWorkspacePath, verifyWritableWorkspace, WorkspaceGateError } from "../src/alpha/workspace-gate.js";

const execFileAsync = promisify(execFile);
const paths: string[] = [];

function envelope(cwd: string, sandboxMode: string) {
  return normalizeResponsesRequest({
    model: "acu-auto",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: `<permissions instructions>\n\`sandbox_mode\` is \`${sandboxMode}\`\n</permissions instructions>` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context><cwd>${cwd}</cwd></environment_context>` }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Modify one file and run check.sh" }] },
    ],
  });
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Coding workspace gate", () => {
  it("accepts a newly created writable Git repository", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acu-workspace-"));
    paths.push(cwd);
    await execFileAsync("git", ["-C", cwd, "init", "-q"]);
    await writeFile(join(cwd, "check.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(cwd, "check.sh"), 0o755);
    await expect(verifyLocalWorkspacePath(cwd)).resolves.toBeUndefined();
    await expect(verifyWritableWorkspace(envelope(cwd, "workspace-write"))).resolves.toBeUndefined();
  });

  it("fails before Provider use when the Codex sandbox is read-only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acu-workspace-"));
    paths.push(cwd);
    await execFileAsync("git", ["-C", cwd, "init", "-q"]);
    await expect(verifyWritableWorkspace(envelope(cwd, "read-only"))).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceGateError>>({ statusCode: 422 }),
    );
  });
});
