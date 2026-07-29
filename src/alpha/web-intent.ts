import type { CanonicalEnvelope, WebIntent, WebIntentDecision, WebIntentSource } from "./protocol/types.js";

export type WebIntentFallbackInput = {
  recentUserInputs: string[];
  rootGoalText?: string;
};

const EXPLICIT_WEB_PATTERN = /\b(?:search|browse|look up|check)\b.{0,48}\b(?:the web|online|internet|official (?:site|docs?|documentation)|website)\b|\b(?:web search|browse online|search online)\b|(?:搜索|查找).{0,32}(?:网页|网络|官网|官方文档)|浏览网页|联网(?:查询|搜索)?|查(?:一下)?官网/i;
const REALTIME_PATTERN = /\b(?:today|right now|real[- ]?time|live|as of|latest)\b|今天|今日|实时|现在|最新/i;
const EXTERNAL_OBJECT_PATTERN = /\b(?:btc|bitcoin|crypto|weather|news|stock|share price|exchange rate|price|market|official docs?|official documentation|release notes?)\b|比特币|加密货币|天气|新闻|股价|汇率|价格|行情|官方文档|发布说明/i;
const LOCAL_CONTEXT_PATTERN = /\b(?:function|variable|class|method|file|filename|directory|workspace|local log|logs?|git|branch|test|fixture|mock|currentuser|latestversion)\b|函数|变量|类名|方法|文件名?|目录|工作区|本地日志|日志文件|Git分支|测试内容/i;
const WEAK_EXTERNAL_PATTERN = /\b(?:online|internet|website|news|weather|market|official docs?|documentation)\b|网上|网络|官网|新闻|天气|行情|官方文档/i;

function relevantText(input: WebIntentFallbackInput): string {
  const recent = input.recentUserInputs.filter((value) => value.trim()).at(-1);
  return recent?.trim() || input.rootGoalText?.trim() || "";
}

export function extractWebIntentEvidence(
  envelope: Pick<CanonicalEnvelope, "clientDeclaredWebTool" | "humanCandidates">,
  rootGoalText?: string,
): string[] {
  const text = relevantText({
    recentUserInputs: envelope.humanCandidates
      .filter((candidate) => candidate.confidence === "high")
      .map((candidate) => candidate.text),
    rootGoalText,
  });
  const evidence: string[] = [];
  if (envelope.clientDeclaredWebTool) evidence.push("client_declared_hosted_web_tool");
  if (EXPLICIT_WEB_PATTERN.test(text)) evidence.push("explicit_web_action");
  if (REALTIME_PATTERN.test(text)) evidence.push("realtime_term");
  if (EXTERNAL_OBJECT_PATTERN.test(text)) evidence.push("external_information_object");
  if (LOCAL_CONTEXT_PATTERN.test(text)) evidence.push("local_or_code_context");
  return evidence;
}

export function classifyWebIntentFallback(input: WebIntentFallbackInput): Omit<WebIntentDecision, "source"> {
  const text = relevantText(input);
  const evidence: string[] = [];
  if (EXPLICIT_WEB_PATTERN.test(text)) {
    evidence.push("explicit_web_action");
    return {
      intent: "required",
      confidence: 0.98,
      reason: "The user explicitly requested Web access or an official online source.",
      evidence,
    };
  }

  const realtime = REALTIME_PATTERN.test(text);
  const externalObject = EXTERNAL_OBJECT_PATTERN.test(text);
  const localContext = LOCAL_CONTEXT_PATTERN.test(text);
  if (realtime) evidence.push("realtime_term");
  if (externalObject) evidence.push("external_information_object");
  if (localContext) evidence.push("local_or_code_context");

  if (realtime && externalObject && !localContext) {
    return {
      intent: "required",
      confidence: 0.94,
      reason: "A time-sensitive external information object requires current Web data.",
      evidence,
    };
  }
  if (localContext) {
    return {
      intent: "not_required",
      confidence: 0.96,
      reason: "The wording belongs to a local coding, file, Git, test, or log context.",
      evidence,
    };
  }
  if (WEAK_EXTERNAL_PATTERN.test(text) || realtime || externalObject) {
    return {
      intent: "likely",
      confidence: 0.62,
      reason: "The request may benefit from external information, but Web access is not unambiguously required.",
      evidence,
    };
  }
  return {
    intent: "likely",
    confidence: 0.5,
    reason: "The fallback lacks enough evidence to make Web access a hard requirement.",
    evidence,
  };
}

export function withWebIntentSource(
  decision: Omit<WebIntentDecision, "source">,
  source: WebIntentSource,
): WebIntentDecision {
  return { ...decision, source };
}

export function isWebIntent(value: unknown): value is WebIntent {
  return value === "required" || value === "likely" || value === "not_required";
}

export function isWebIntentSource(value: unknown): value is WebIntentSource {
  return value === "judge" || value === "heuristic_fallback" || value === "legacy_heuristic";
}
