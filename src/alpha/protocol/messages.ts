import { array, canonicalHash, record, textParts } from "./common.js";
import type { CanonicalEnvelope, NativeRequestHeaders } from "./types.js";

const CLAUDE_PLAN_FINGERPRINT_VERSION = "claude-code-2.1-plan-v2";
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit", "apply_patch"]);
const PLAN_TOOL_FAMILY = ["Read", "TaskCreate", "TaskUpdate", "Write"];

function parseJsonBody(body: unknown): Record<string, unknown> {
  if (typeof body === "string") return record(JSON.parse(body)) ?? {};
  return record(body) ?? {};
}

function systemText(value: unknown): string {
  return textParts(value).join("\n") || (typeof value === "string" ? value : "");
}

function isHostedWebTool(value: unknown): boolean {
  const tool = record(value);
  const type = String(tool?.type ?? "").toLowerCase();
  const name = String(tool?.name ?? record(tool?.function)?.name ?? "").toLowerCase();
  return type.startsWith("web_search_")
    || type === "web_search"
    || (type === "builtin_function" && name === "$web_search");
}

function continuityMessage(value: unknown): unknown {
  const item = record(value);
  if (item?.role !== "system") return value;
  const content = systemText(item.content);
  if (!/Plan mode is active\./i.test(content)
    || !content.includes("## Plan File Info:")
    || !content.includes("## Plan Workflow")) return value;
  return { role: "system", content: "<claude_plan_control:2.1:v2>" };
}

export function normalizeMessagesRequest(
  body: unknown,
  headers: NativeRequestHeaders = {},
  clientVersion?: string,
): CanonicalEnvelope {
  void headers;
  const raw = parseJsonBody(body);
  const messages = array(raw.messages);
  const continuityHistory = messages.map(continuityMessage);
  const tools = array(raw.tools);
  const clientDeclaredWebTool = tools.some(isHostedWebTool);
  const humanCandidates: CanonicalEnvelope["humanCandidates"] = [];
  const toolCalls: CanonicalEnvelope["toolCalls"] = [];
  const toolResults: CanonicalEnvelope["toolResults"] = [];
  const signatures: string[] = [];

  messages.forEach((messageValue, sourceIndex) => {
    const message = record(messageValue);
    if (!message) return;
    const blocks = typeof message.content === "string" ? [message.content] : array(message.content);
    const hasToolResult = blocks.some((block) => record(block)?.type === "tool_result");
    for (const blockValue of blocks) {
      if (typeof blockValue === "string") {
        if (message.role === "user" && blockValue.trim()) {
          humanCandidates.push({ text: blockValue, sourceIndex, confidence: "high" });
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
          sourceIndex,
        });
        continue;
      }
      if (block.type === "text" && message.role === "user" && typeof block.text === "string" && block.text.trim()) {
        humanCandidates.push({
          text: block.text,
          sourceIndex,
          confidence: hasToolResult ? "candidate" : "high",
        });
      }
      if (block.type === "tool_use") {
        toolCalls.push({
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          input: block.input,
          sourceIndex,
        });
      }
      if (block.type === "thinking" && typeof block.signature === "string") signatures.push(block.signature);
    }
  });

  const toolNames = tools.map((tool) => String(record(tool)?.name ?? ""));
  const exitPlanDeclared = toolNames.includes("ExitPlanMode");
  const writeToolsAbsent = !toolNames.some((name) => WRITE_TOOLS.has(name));
  const planSystem = /plan mode|planning mode|read-only|readonly/i.test(systemText(raw.system));
  const userText = messages.flatMap((message) => {
    const item = record(message);
    return item?.role === "user" ? textParts(item.content) : [];
  }).join("\n");
  const systemMessageText = messages.flatMap((message) => {
    const item = record(message);
    return item?.role === "system" ? textParts(item.content) : [];
  }).join("\n");
  const planControlText = [systemText(raw.system), systemMessageText, userText].filter(Boolean).join("\n");
  const activePlanReminder = /Plan mode is active\./i.test(planControlText)
    && planControlText.includes("## Plan File Info:")
    && planControlText.includes("## Plan Workflow");
  const exitedPlanReminder = planControlText.includes("## Exited Plan Mode");
  const planToolFamilyPresent = PLAN_TOOL_FAMILY.every((name) => toolNames.includes(name));
  const versionSupported = clientVersion !== undefined && /^2\.1\./.test(clientVersion);
  const legacyPlanOnly = exitPlanDeclared && writeToolsAbsent && planSystem;
  const nativePlanOnly = activePlanReminder && !exitedPlanReminder && planToolFamilyPresent;
  const planOnly = versionSupported && (legacyPlanOnly || nativePlanOnly);
  const exitPlanCalls = toolCalls.filter((call) => call.name === "ExitPlanMode");

  return {
    protocol: "messages",
    requestedModel: String(raw.model ?? ""),
    stream: raw.stream === true,
    instructions: raw.system,
    history: continuityHistory,
    tools,
    requiredToolTypes: tools.some((tool) => !isHostedWebTool(tool)) ? ["function"] : [],
    clientDeclaredWebTool,
    webIntent: "likely",
    webIntentConfidence: 0,
    webIntentReason: "Pending Routing Segment Judge evaluation.",
    webIntentEvidence: [],
    webActuallyInvoked: false,
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
        ...(legacyPlanOnly && versionSupported
          ? ["version_supported", "exit_plan_declared", "write_tools_absent", "plan_system"]
          : []),
        ...(nativePlanOnly && versionSupported
          ? ["version_supported", "active_plan_reminder", "plan_file_reminder", "plan_workflow_reminder", "plan_tool_family"]
          : []),
        ...exitPlanCalls.map((call) => `tool_use:ExitPlanMode:${call.id}`),
      ],
    },
    containsThinking: signatures.length > 0 || messages.some((message) => array(record(message)?.content)
      .some((block) => record(block)?.type === "thinking")),
    thinkingSignatures: signatures,
    historyHash: canonicalHash(continuityHistory),
    raw,
  };
}
