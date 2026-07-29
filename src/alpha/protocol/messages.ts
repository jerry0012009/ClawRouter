import { array, canonicalHash, record, textParts } from "./common.js";
import type { CanonicalEnvelope, NativeRequestHeaders } from "./types.js";

const CLAUDE_PLAN_FINGERPRINT_VERSION = "claude-code-2.1-plan-v1";
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit", "apply_patch"]);

function parseJsonBody(body: unknown): Record<string, unknown> {
  if (typeof body === "string") return record(JSON.parse(body)) ?? {};
  return record(body) ?? {};
}

function systemText(value: unknown): string {
  return textParts(value).join("\n") || (typeof value === "string" ? value : "");
}

export function normalizeMessagesRequest(
  body: unknown,
  headers: NativeRequestHeaders = {},
  clientVersion?: string,
): CanonicalEnvelope {
  void headers;
  const raw = parseJsonBody(body);
  const messages = array(raw.messages);
  const tools = array(raw.tools);
  const humanCandidates: CanonicalEnvelope["humanCandidates"] = [];
  const toolCalls: CanonicalEnvelope["toolCalls"] = [];
  const toolResults: CanonicalEnvelope["toolResults"] = [];
  const signatures: string[] = [];

  messages.forEach((messageValue, sourceIndex) => {
    const message = record(messageValue);
    if (!message) return;
    const blocks = typeof message.content === "string" ? [message.content] : array(message.content);
    for (const blockValue of blocks) {
      if (typeof blockValue === "string") {
        if (message.role === "user" && blockValue.trim()) {
          humanCandidates.push({ text: blockValue, sourceIndex, confidence: "candidate" });
        }
        continue;
      }
      const block = record(blockValue);
      if (!block) continue;
      if (block.type === "tool_result") {
        toolResults.push({
          toolCallId: String(block.tool_use_id ?? ""),
          content: block.content,
          isError: block.is_error === true,
        });
        continue;
      }
      if (block.type === "text" && message.role === "user" && typeof block.text === "string" && block.text.trim()) {
        humanCandidates.push({ text: block.text, sourceIndex, confidence: "candidate" });
      }
      if (block.type === "tool_use") {
        toolCalls.push({ id: String(block.id ?? ""), name: String(block.name ?? ""), input: block.input });
      }
      if (block.type === "thinking" && typeof block.signature === "string") signatures.push(block.signature);
    }
  });

  const toolNames = tools.map((tool) => String(record(tool)?.name ?? ""));
  const exitPlanDeclared = toolNames.includes("ExitPlanMode");
  const writeToolsAbsent = !toolNames.some((name) => WRITE_TOOLS.has(name));
  const planSystem = /plan mode|planning mode|read-only|readonly/i.test(systemText(raw.system));
  const versionSupported = clientVersion !== undefined && /^2\.1\./.test(clientVersion);
  const planOnly = versionSupported && exitPlanDeclared && writeToolsAbsent && planSystem;
  const exitPlanCalls = toolCalls.filter((call) => call.name === "ExitPlanMode");

  return {
    protocol: "messages",
    requestedModel: String(raw.model ?? ""),
    stream: raw.stream === true,
    instructions: raw.system,
    history: messages,
    tools,
    humanCandidates,
    toolCalls,
    toolResults,
    planning: {
      started: planOnly,
      finished: exitPlanCalls.length > 0,
      updated: false,
      signalFamily: exitPlanCalls.length ? "claude_exit_plan_mode" : planOnly ? "claude_plan_only_fingerprint" : undefined,
      fingerprintVersion: planOnly || exitPlanCalls.length ? CLAUDE_PLAN_FINGERPRINT_VERSION : undefined,
      evidence: [
        ...(planOnly ? ["version_supported", "exit_plan_declared", "write_tools_absent", "plan_system"] : []),
        ...exitPlanCalls.map((call) => `tool_use:ExitPlanMode:${call.id}`),
      ],
    },
    containsThinking: signatures.length > 0 || messages.some((message) => array(record(message)?.content)
      .some((block) => record(block)?.type === "thinking")),
    thinkingSignatures: signatures,
    historyHash: canonicalHash(messages),
    raw,
  };
}
