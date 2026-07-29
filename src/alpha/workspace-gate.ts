import { constants } from "node:fs";
import { access, stat, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { CanonicalEnvelope } from "./protocol/types.js";

const execFileAsync = promisify(execFile);

export class WorkspaceGateError extends Error {
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGateError";
  }
}

export function taskRequiresWorkspaceWrite(envelope: CanonicalEnvelope): boolean {
  const text = envelope.humanCandidates.map((item) => item.text).join("\n").toLowerCase();
  return /\b(modify|edit|write|change|update|create|delete|remove|patch)\b.{0,40}\b(file|code|repo|repository|workspace|check\.sh)\b|修改|编辑|写入|改动|创建|删除/.test(text);
}

export function workspaceContext(envelope: CanonicalEnvelope): { cwd?: string; sandboxMode?: string } {
  const text = JSON.stringify({ instructions: envelope.instructions, history: envelope.history });
  return {
    cwd: /<cwd>([^<]+)<\/cwd>/.exec(text)?.[1],
    sandboxMode: /`sandbox_mode` is `([^`]+)`/.exec(text)?.[1],
  };
}

export async function verifyWritableWorkspace(envelope: CanonicalEnvelope): Promise<void> {
  if (!taskRequiresWorkspaceWrite(envelope)) return;
  const context = workspaceContext(envelope);
  if (context.sandboxMode !== "workspace-write") {
    throw new WorkspaceGateError("Local workspace gate failed: Codex sandbox must be workspace-write for a file modification task");
  }
  if (!context.cwd) throw new WorkspaceGateError("Local workspace gate failed: Codex working directory was not declared");
}

export async function verifyLocalWorkspacePath(cwd: string): Promise<void> {
  const details = await stat(cwd).catch(() => undefined);
  if (!details?.isDirectory()) throw new WorkspaceGateError("Local workspace gate failed: working directory does not exist");
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new WorkspaceGateError("Local workspace gate failed: current user does not own the working directory");
  }
  await access(cwd, constants.W_OK).catch(() => {
    throw new WorkspaceGateError("Local workspace gate failed: working directory is not writable");
  });
  const probe = join(cwd, `.acu-workspace-probe-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probe, "acu-workspace-write-probe\n", { flag: "wx", mode: 0o600 });
  } catch {
    throw new WorkspaceGateError("Local workspace gate failed: probe file could not be created");
  } finally {
    await unlink(probe).catch(() => undefined);
  }
  try {
    await execFileAsync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { timeout: 2_000 });
  } catch {
    throw new WorkspaceGateError("Local workspace gate failed: working directory is not a usable Git repository");
  }
}
