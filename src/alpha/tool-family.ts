import { record } from "./protocol/common.js";
import type { CanonicalToolCall } from "./protocol/types.js";

export type ToolFamily = "planning" | "verification" | "implementation" | "inspection" | "unknown";

const PLANNING_TOOLS = new Set(["update_plan", "exitplanmode"]);
const VERIFICATION_TOOLS = new Set(["test", "pytest", "unittest", "build", "typecheck", "tsc", "lint", "compile", "check"]);
const IMPLEMENTATION_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch", "patch"]);
const INSPECTION_TOOLS = new Set([
  "read", "grep", "glob", "search", "find", "list", "file_search", "web_fetch", "web_search",
]);
const SHELL_TOOLS = new Set(["exec_command", "shell", "bash", "sh", "terminal"]);

const VERIFY_COMMAND = /(?:^|[;&|\n]\s*)(?:pytest\b|python\s+-m\s+unittest\b|go\s+test\b|cargo\s+test\b|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|typecheck|lint|compile|check)\b|npx\s+tsc\b|tsc\b)/i;
const IMPLEMENT_COMMAND = /(?:^|[;&|\n]\s*)(?:apply_patch\b|patch\b|sed\s+-i\b|perl\s+-i\b|(?:cp|mv|install|truncate)\b|(?:tee|printf|echo)\b[^\n]*(?:>|>>))/i;
const INSPECT_COMMAND = /(?:^|[;&|\n]\s*)(?:cat\b|head\b|tail\b|rg\b|grep\b|find\b|ls\b|git\s+(?:status|diff|show|log|rev-parse|branch)\b)/i;

export function shellCommandForTool(call: CanonicalToolCall): string | undefined {
  const input = record(call.input);
  for (const key of ["cmd", "command", "script"]) {
    if (typeof input?.[key] === "string") return input[key] as string;
  }
  return undefined;
}

export function classifyShellCommand(command: string): ToolFamily {
  if (VERIFY_COMMAND.test(command)) return "verification";
  if (IMPLEMENT_COMMAND.test(command)) return "implementation";
  if (INSPECT_COMMAND.test(command)) return "inspection";
  return "unknown";
}

export function classifyToolCall(call: CanonicalToolCall): ToolFamily {
  const normalized = call.name.trim().toLowerCase().replace(/[ -]+/g, "_");
  if (PLANNING_TOOLS.has(normalized)) return "planning";
  if (VERIFICATION_TOOLS.has(normalized)) return "verification";
  if (IMPLEMENTATION_TOOLS.has(normalized)) return "implementation";
  if (INSPECTION_TOOLS.has(normalized)) return "inspection";
  if (SHELL_TOOLS.has(normalized)) {
    const command = shellCommandForTool(call);
    return command ? classifyShellCommand(command) : "unknown";
  }
  return "unknown";
}
