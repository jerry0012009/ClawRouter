import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import fewShotData from "./catalog/twin-few-shots.json";
import type { AcuDifficultyFactors, AcuJudgeResult, AcuVisibleMessage } from "./types.js";
import type { AcuRuntimeConfig } from "./config.js";
import { ACU_DIFFICULTY_METHOD_VERSION } from "./config.js";
import { getAcuCatalog } from "./catalog.js";
import { normalizeProbabilities } from "./math.js";

type FewShot = {
  exampleId: string;
  context: string;
  minimumSufficientTier: string;
  explanation: string;
  expected: Record<string, unknown>;
};

type CacheRecord = {
  result: AcuJudgeResult;
  createdAt: string;
  promptVersion: string;
  model: string;
  provider: string;
  endpointHost: string;
  upstreamRequestId: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  usageStatus: "reported" | "usage_missing";
};

type CacheFile = { schemaVersion: "acu-judge-cache-v4"; entries: Record<string, CacheRecord> };

export type JudgeRequestResult = {
  result: AcuJudgeResult;
  status: "live" | "cache_hit";
  resultSource: "upstream_live" | "disk_cache";
  provider: string;
  model: string;
  endpointHost: string;
  upstreamRequestId: string | null;
  latencyMs: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  usageStatus: "reported" | "usage_missing";
  contextSha256: string;
  cacheKeySha256: string;
  cacheCreatedAt: string;
  contextTokenEstimate: number;
  contextTruncated: boolean;
  rawRequestBytes: number;
  rawRequestTokenEstimate: number;
  judgeContextLimit: number;
  judgeContextSource: "raw_native_request_v1" | "visible_context_legacy";
};

export type RawNativeJudgeContext = {
  stateMetadata: Record<string, unknown>;
  rawRequest: string;
};

export class AcuJudgeContextLengthError extends Error {
  constructor(readonly requiredTokens: number, readonly contextLimit: number) {
    super(`Judge raw request requires ${requiredTokens} tokens but only ${contextLimit} are available`);
    this.name = "AcuJudgeContextLengthError";
  }
}

export class AcuJudgeClientCancelledError extends Error {
  constructor() {
    super("Judge request cancelled by the client");
    this.name = "AcuJudgeClientCancelledError";
  }
}

export type JudgeAttemptFailure = {
  provider: string;
  model: string;
  endpointHost: string;
  upstreamRequestId: string | null;
  latencyMs: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  usageStatus: "reported" | "usage_missing";
  errorCategory: string;
  httpStatus?: number;
  backupEligible: boolean;
  backupReason: string;
  responseHeaders: Record<string, string>;
  rawResponseBody: string;
  parserExceptionType?: string;
  parserExceptionMessage?: string;
  contextSha256: string;
  contextTokenEstimate: number;
  rawRequestBytes: number;
  rawRequestTokenEstimate: number;
  judgeContextLimit: number;
  failureLayer: "transport_failure" | "provider_protocol_failure" | "judge_semantic_parse_failure";
  responseContentType?: string;
  providerEnvelopeValid: boolean;
  assistantTextExtracted: boolean;
};

export class AcuJudgeAttemptError extends Error {
  constructor(message: string, readonly attempt: JudgeAttemptFailure) {
    super(message);
    this.name = "AcuJudgeAttemptError";
  }
}

class JudgeProviderProtocolError extends Error {
  override name = "JudgeProviderProtocolError";
}
class JudgeSemanticParseError extends Error {
  override name = "JudgeSemanticParseError";
}

function looksLikeHtml(body: string, contentType: string): boolean {
  return /text\/html/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(body);
}

function extractResponsesAssistantText(payload: Record<string, unknown>): string | undefined {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const text = output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content : [];
    return content.flatMap((part) => part && typeof part === "object"
      && (part as { type?: unknown }).type === "output_text"
      && typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text] : []);
  }).join("");
  return text || undefined;
}

export function judgeNominalCostUsd(
  modelId: string,
  promptTokens: number,
  cachedPromptTokens: number,
  completionTokens: number,
): number {
  const price = modelId === "mimo-v2.5-pro"
    ? { input: 0.435, cached: 0.0036, output: 0.87 }
    : (() => {
        const model = getAcuCatalog().models.find((entry) => entry.modelId === modelId);
        if (!model || model.inputPricePerMillion === null || model.outputPricePerMillion === null) return undefined;
        return {
          input: model.inputPricePerMillion,
          cached: model.cachedInputPricePerMillion ?? model.inputPricePerMillion,
          output: model.outputPricePerMillion,
        };
      })();
  if (!price) return 0;
  const cached = Math.max(0, Math.min(promptTokens, cachedPromptTokens));
  const uncached = Math.max(0, promptTokens - cached);
  return ((uncached * price.input) + (cached * price.cached) + (Math.max(0, completionTokens) * price.output)) / 1_000_000;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type === "image_url" || "image_url" in record) return "[IMAGE]";
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return String(part ?? "");
      const value = part as Record<string, unknown>;
      if (value.type === "image_url" || "image_url" in value) return "[IMAGE]";
      if (typeof value.text === "string") return value.text;
      return stableJson(value);
    }).join("\n");
  }
  return stableJson(content);
}

function serializeToolCall(call: unknown): string {
  const value = call && typeof call === "object" ? call as Record<string, unknown> : {};
  const fn = value.function && typeof value.function === "object"
    ? value.function as Record<string, unknown>
    : {};
  const id = String(value.id ?? "unknown");
  const name = String(fn.name ?? value.name ?? "unknown");
  let args: unknown = fn.arguments ?? value.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args) as unknown; } catch { /* preserve non-JSON arguments */ }
  }
  return `[ASSISTANT_TOOL_CALL id=${id}]\nname=${name}\narguments=${typeof args === "string" ? args : stableJson(args)}`;
}

export function serializeVisibleContext(messages: AcuVisibleMessage[], tools: unknown[] = []): string {
  const sections: string[] = [];
  for (const message of messages) {
    const role = String(message.role || "unknown").toLowerCase();
    const text = contentText(message.content);
    if (role === "tool") {
      const id = String(message.tool_call_id ?? "unknown");
      const name = String(message.name ?? "unknown");
      const extra = Object.fromEntries(
        Object.entries(message)
          .filter(([key]) => !["role", "name", "content", "tool_call_id"].includes(key))
          .sort(([left], [right]) => left.localeCompare(right)),
      );
      sections.push(`[TOOL_RESULT id=${id} name=${name}]\n${text}${Object.keys(extra).length ? `\nmetadata=${stableJson(extra)}` : ""}`);
      continue;
    }
    const name = message.name ? ` name=${message.name}` : "";
    if (text || !Array.isArray(message.tool_calls)) sections.push(`[${role.toUpperCase()}${name}]\n${text}`);
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) sections.push(serializeToolCall(call));
    }
    const structured = Object.fromEntries(
      Object.entries(message)
        .filter(([key]) => !["role", "name", "content", "tool_calls", "tool_call_id"].includes(key))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    if (Object.keys(structured).length) sections.push(`[${role.toUpperCase()}_METADATA]\n${stableJson(structured)}`);
  }
  if (tools.length > 0) sections.push(`[AVAILABLE_TOOLS]\n${stableJson(tools)}`);
  return sections.join("\n\n").trim();
}

export function estimateVisibleTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

export function estimateJudgeContextTokens(rawNative: RawNativeJudgeContext): number {
  return estimateVisibleTokens(
    `[ACU_STATE_METADATA]\n${stableJson(rawNative.stateMetadata)}\n[RAW_NATIVE_API_REQUEST]\n${rawNative.rawRequest}`,
  );
}

export function buildJudgeSystemPrompt(): string {
  const examples = (fewShotData.examples as FewShot[]).map((example) => [
    `示例 ${example.exampleId}`,
    "上下文：",
    example.context,
    `最低充分档位解释：${example.minimumSufficientTier}；${example.explanation}`,
    `期望输出：${stableJson({
      ...example.expected,
      webIntent: "not_required",
      webIntentConfidence: 0.95,
      webIntentReason: "The visible task can be completed from provided or local context.",
      webIntentEvidence: ["provided_or_local_context"],
    })}`,
  ].join("\n")).join("\n\n---\n\n");
  return [
    "你是 ACU 任务能力需求分类器。Difficulty 表示：在整个 Task、完整可见历史和当前工作阶段下，完成当前这一次模型响应所需的最低充分能力。",
    "不要只判断最新一个 Tool Call，也不要重复评估最初用户目标；应判断当前完整工作 Turn 的总体能力需求。",
    "不得回答原任务，不得推荐具体模型，不得根据模型品牌判断，不得输出代码或思维过程。",
    '只输出严格 JSON：{"difficulty_score_raw":0,"factors":{"reasoning_depth":0,"task_scope":0,"constraint_density":0,"tool_dependency":0,"verification_burden":0,"context_burden":0},"p_low":0,"p_mid":0,"p_mid_high":0,"p_high":0,"confidence":0,"signals":[],"explanation":"","webIntent":"likely","webIntentConfidence":0,"webIntentReason":"","webIntentEvidence":[]}',
    "difficulty_score_raw是0到100的原始总体判断；六个factors均为0到10、允许一位小数。后端会确定性计算最终难度指数，不要自行输出最终指数。",
    "reasoning_depth衡量推理链长度和抽象程度；task_scope衡量步骤、文件、模块、实体和目标范围；constraint_density衡量格式、事实、风格、业务和质量约束及其相互影响。",
    "tool_dependency衡量工具调用、代码执行、检索、多轮Agent行为和环境状态依赖；verification_burden越难通过JSON、测试或明确答案验证则越高；context_burden衡量上下文长度、分散程度和历史依赖。",
    "不要为了简洁默认使用5的倍数。请分别判断各能力需求因子，总难度由后端计算；只有真实判断恰好落在整数或5的倍数时才可输出该值。",
    "概率表达分类不确定性；除极其明确外不要机械输出单档100%，相邻档存在合理可能时应给软概率。原始总分与主要档位应大体一致，但不要求等于概率期望。",
    "四档概率必须在0到1且总和为1；signals必须是字符串数组；explanation必须是字符串，长度由整体 Judge max output tokens 控制。",
    "在同一次判断中输出 Web Intent。required 表示完成当前真实目标必须取得实时或外部 Web 信息；likely 表示可能有帮助但不能作为硬条件；not_required 表示当前 Segment 可完全依赖本地工作区、已给上下文和普通工具完成。",
    "Web 判断必须综合当前真实用户目标、最近用户输入、Task/Goal、Plan、Routing Segment 状态和确定性 Web 线索。客户端声明 Web Tool 只表示能力可用，不能直接判为 required。",
    "单独出现 current、latest、today、当前、最新、今天不得判为 required。代码标识符、变量名、文件名、本地日志、Git 分支和本地测试内容中的这些词应判为 not_required。",
    "例如：‘修改 currentUser 函数’、‘更新 latestVersion 变量’、‘查看今天生成的本地日志’均为 not_required；‘查询今天 BTC 价格’、‘搜索最新 Codex 官方文档’为 required。",
    "webIntentConfidence 必须在0到1；webIntentReason必须是字符串；webIntentEvidence必须是字符串数组，只列可审计的简短证据标签。",
    "以下示例只包含当时可见上下文，不含未来消息：",
    examples,
  ].join("\n\n");
}

function extractJson(text: string): Record<string, unknown> {
  const raw = text.trim();
  const candidates = [raw];
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  if (fenced !== undefined) candidates.push(fenced.trim());
  let objectText: string | undefined;
  for (const candidate of candidates) {
    try {
      const direct = JSON.parse(candidate) as unknown;
      if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
    } catch {
      // Continue with deterministic object extraction.
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;
    for (let index = 0; index < candidate.length; index += 1) {
      const character = candidate[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") {
        if (depth === 0) start = index;
        depth += 1;
      } else if (character === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          objectText = candidate.slice(start, index + 1);
          break;
        }
      }
    }
    if (objectText) break;
  }
  if (!objectText) throw new SyntaxError("Judge response does not contain a complete JSON object");
  const parsed = JSON.parse(objectText) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Judge response JSON must be an object");
  return parsed as Record<string, unknown>;
}

function scoreTier(score: number): number {
  if (score < 30) return 0;
  if (score < 55) return 1;
  if (score < 80) return 2;
  return 3;
}

function dominantTier(result: AcuJudgeResult): number {
  const values = [result.pLow, result.pMid, result.pMidHigh, result.pHigh];
  return values.indexOf(Math.max(...values));
}

export function hasSevereTierConflict(result: AcuJudgeResult): boolean {
  const tiers = [scoreTier(result.difficultyIndex), scoreTier(result.difficultyScoreRaw), dominantTier(result)];
  return Math.max(...tiers) - Math.min(...tiers) >= 2;
}

const FACTOR_KEYS = [
  ["reasoning_depth", "reasoningDepth"],
  ["task_scope", "taskScope"],
  ["constraint_density", "constraintDensity"],
  ["tool_dependency", "toolDependency"],
  ["verification_burden", "verificationBurden"],
  ["context_burden", "contextBurden"],
] as const;

function oneDecimal(value: unknown, name: string, maximum: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > maximum) throw new Error(`Judge ${name} must be finite and in [0, ${maximum}]`);
  if (Math.abs(numeric * 10 - Math.round(numeric * 10)) > 1e-8) throw new Error(`Judge ${name} must have at most one decimal place`);
  return Math.round(numeric * 10) / 10;
}

export function computeDifficultyIndex(
  difficultyScoreRaw: number,
  factors: AcuDifficultyFactors,
): { factorComposite: number; difficultyIndex: number } {
  const factorComposite = 10 * (
    0.25 * factors.reasoningDepth
    + 0.15 * factors.taskScope
    + 0.15 * factors.constraintDensity
    + 0.20 * factors.toolDependency
    + 0.15 * factors.verificationBurden
    + 0.10 * factors.contextBurden
  );
  const difficultyIndex = Math.max(0, Math.min(100, 0.80 * factorComposite + 0.20 * difficultyScoreRaw));
  return {
    factorComposite: Math.round(factorComposite * 10) / 10,
    difficultyIndex: Math.round(difficultyIndex * 10) / 10,
  };
}

export function parseJudgeResult(text: string): AcuJudgeResult {
  const parsed = extractJson(text);
  const difficultyScoreRaw = oneDecimal(parsed.difficulty_score_raw, "difficulty_score_raw", 100);
  if (!parsed.factors || typeof parsed.factors !== "object" || Array.isArray(parsed.factors)) throw new Error("Judge factors must be an object");
  const rawFactors = parsed.factors as Record<string, unknown>;
  const factors = Object.fromEntries(FACTOR_KEYS.map(([wire, local]) => [local, oneDecimal(rawFactors[wire], `factors.${wire}`, 10)])) as AcuDifficultyFactors;
  const { factorComposite, difficultyIndex } = computeDifficultyIndex(difficultyScoreRaw, factors);
  const probabilities = normalizeProbabilities({
    pLow: Number(parsed.p_low), pMid: Number(parsed.p_mid), pMidHigh: Number(parsed.p_mid_high), pHigh: Number(parsed.p_high), confidence: Number(parsed.confidence),
  });
  if (!Array.isArray(parsed.signals) || parsed.signals.some((signal) => typeof signal !== "string")) {
    throw new Error("Judge signals must be an array of strings");
  }
  const rawExplanation = parsed.explanation;
  const originalExplanationType = !("explanation" in parsed)
    ? "missing"
    : rawExplanation === null
      ? "null"
      : Array.isArray(rawExplanation)
        ? "array"
        : typeof rawExplanation === "object"
          ? "object"
          : "string";
  const explanation = typeof rawExplanation === "string"
    ? rawExplanation
    : rawExplanation === null || rawExplanation === undefined
      ? ""
      : stableJson(rawExplanation);
  const originalExplanationLength = typeof rawExplanation === "string"
    ? Array.from(rawExplanation).length
    : undefined;
  const explanationNormalized = originalExplanationType !== "string";
  if (!["required", "likely", "not_required"].includes(String(parsed.webIntent))) {
    throw new Error("Judge webIntent must be required, likely, or not_required");
  }
  const webIntentConfidence = Number(parsed.webIntentConfidence);
  if (!Number.isFinite(webIntentConfidence) || webIntentConfidence < 0 || webIntentConfidence > 1) {
    throw new Error("Judge webIntentConfidence must be finite and in [0, 1]");
  }
  if (typeof parsed.webIntentReason !== "string") throw new Error("Judge webIntentReason must be a string");
  if (!Array.isArray(parsed.webIntentEvidence)
    || parsed.webIntentEvidence.some((item) => typeof item !== "string")) {
    throw new Error("Judge webIntentEvidence must be an array of strings");
  }
  return {
    ...probabilities,
    difficultyScoreRaw,
    factors,
    factorComposite,
    difficultyIndex,
    difficultyMethodVersion: ACU_DIFFICULTY_METHOD_VERSION,
    difficultyScore: difficultyIndex,
    signals: parsed.signals as string[],
    explanation,
    explanationNormalized,
    originalExplanationLength,
    originalExplanationType,
    webIntent: parsed.webIntent as AcuJudgeResult["webIntent"],
    webIntentConfidence,
    webIntentReason: parsed.webIntentReason,
    webIntentEvidence: parsed.webIntentEvidence as string[],
  };
}

function cachePath(config: AcuRuntimeConfig): string {
  if (config.cachePath && config.promptVersion === "acu-tier-requirement-v4") {
    return config.cachePath.replace(/v[23](?=\.json$)/, "v4");
  }
  return config.cachePath || join(homedir(), ".claw-router", "acu-judge-cache-v4.json");
}

function readCache(path: string): CacheFile {
  if (!existsSync(path)) return { schemaVersion: "acu-judge-cache-v4", entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (parsed.schemaVersion !== "acu-judge-cache-v4" || !parsed.entries) throw new Error("wrong schema");
    return parsed;
  } catch {
    return { schemaVersion: "acu-judge-cache-v4", entries: {} };
  }
}

function writeCache(path: string, cache: CacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const entries = Object.entries(cache.entries).slice(-2_000);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...cache, entries: Object.fromEntries(entries) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch { /* cache failure must not break routing */ }
}

function endpointMetadata(baseUrl: string, provider: string): { host: string; provider: string } {
  const host = new URL(baseUrl).host;
  return { host, provider };
}

function responseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].filter(([name]) => ![
    "authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key", "api-key",
  ].includes(name.toLowerCase())));
}

function upstreamContextError(status: number, body: string): boolean {
  const pattern = /context[_ -]?(?:length|window)|maximum context|too many tokens|token limit/i;
  if (status === 400 || status === 413 || status === 422) return pattern.test(body);
  if (status !== 200) return false;
  try {
    const payload = JSON.parse(body) as { error?: unknown; response?: { error?: unknown } };
    const error = payload.error ?? payload.response?.error;
    return error !== undefined && pattern.test(typeof error === "string" ? error : JSON.stringify(error));
  } catch {
    return false;
  }
}

function errorResponseMetadata(body: string): {
  id?: string;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  usageStatus: "reported" | "usage_missing";
} {
  try {
    const value = JSON.parse(body) as {
      id?: unknown;
      request_id?: unknown;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
      };
    };
    const promptTokens = Number(value.usage?.prompt_tokens);
    const completionTokens = Number(value.usage?.completion_tokens);
    return {
      id: typeof value.id === "string" ? value.id : typeof value.request_id === "string" ? value.request_id : undefined,
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
      cachedPromptTokens: Number.isFinite(Number(value.usage?.prompt_tokens_details?.cached_tokens))
        ? Number(value.usage?.prompt_tokens_details?.cached_tokens) : 0,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
      usageStatus: Number.isFinite(promptTokens) && Number.isFinite(completionTokens) ? "reported" : "usage_missing",
    };
  } catch {
    return { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, usageStatus: "usage_missing" };
  }
}

export class AcuJudgeClient {
  constructor(private readonly config: AcuRuntimeConfig, private readonly fetchImplementation: typeof fetch = fetch) {
    if (fetchImplementation !== fetch && process.env.NODE_ENV !== "test" && !config.allowMock) {
      throw new Error("Mock ACU Judge providers are forbidden outside tests unless ACU_ALLOW_MOCK=true");
    }
  }

  async judge(
    messages: AcuVisibleMessage[],
    tools: unknown[] = [],
    forceRefresh = false,
    rawNative?: RawNativeJudgeContext,
    clientSignal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<JudgeRequestResult> {
    if (!this.config.apiKey) throw new Error("ACU Judge API key is not configured");
    if (this.config.promptVersion !== fewShotData.promptVersion) throw new Error("ACU Judge prompt version does not match frozen few-shot data");
    const rawRequestBytes = rawNative ? Buffer.byteLength(rawNative.rawRequest, "utf8") : 0;
    const rawRequestTokenEstimate = rawNative ? estimateVisibleTokens(rawNative.rawRequest) : 0;
    const visible = rawNative
      ? `[ACU_STATE_METADATA]\n${stableJson(rawNative.stateMetadata)}\n[RAW_NATIVE_API_REQUEST]\n${rawNative.rawRequest}`
      : serializeVisibleContext(messages, tools);
    const contextSha256 = createHash("sha256").update(visible).digest("hex");
    const judgeContextLimit = this.config.maxContextTokens;
    const contextTokenEstimate = rawNative ? estimateJudgeContextTokens(rawNative) : estimateVisibleTokens(visible);
    const truncated = { text: visible, tokenEstimate: contextTokenEstimate, truncated: false };
    const key = createHash("sha256").update(`${this.config.promptVersion}\n${this.config.judgeModel}\n${this.config.judgeReasoningEffort}\n${this.config.judgeProtocol}\n${contextSha256}`).digest("hex");
    const path = cachePath(this.config);
    const cache = readCache(path);
    const cached = cache.entries[key];
    if (cached && !forceRefresh) {
      return {
        result: cached.result, status: "cache_hit", resultSource: "disk_cache", provider: cached.provider,
        model: cached.model,
        endpointHost: cached.endpointHost, upstreamRequestId: cached.upstreamRequestId, latencyMs: 0, cost: 0,
        promptTokens: cached.promptTokens, cachedPromptTokens: cached.cachedPromptTokens ?? 0,
        completionTokens: cached.completionTokens, usageStatus: cached.usageStatus,
        contextSha256, cacheKeySha256: key, cacheCreatedAt: cached.createdAt,
        contextTokenEstimate: truncated.tokenEstimate, contextTruncated: false,
        rawRequestBytes, rawRequestTokenEstimate, judgeContextLimit,
        judgeContextSource: rawNative ? "raw_native_request_v1" : "visible_context_legacy",
      };
    }

    const metadata = endpointMetadata(this.config.judgeBaseUrl, this.config.judgeProvider);
    const controller = new AbortController();
    const firstByteTimeout = this.config.firstByteTimeoutMs > 0
      ? setTimeout(() => controller.abort(new Error("Judge first-byte timeout")), this.config.firstByteTimeoutMs)
      : undefined;
    const remainingTimeout = deadlineAt ? Math.max(1, deadlineAt - Date.now()) : this.config.timeoutMs;
    const totalTimeout = remainingTimeout > 0
      ? setTimeout(() => controller.abort(new Error("Judge total timeout")), remainingTimeout)
      : undefined;
    const started = Date.now();
    try {
      let payload: {
        id?: string;
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          input_tokens?: number;
          output_tokens?: number;
          input_tokens_details?: { cached_tokens?: number };
        };
      } | undefined;
      let response: Response | undefined;
      let rawResponseBody = "";
      let responseContentType = "";
      let providerEnvelopeValid = false;
      let assistantTextExtracted = false;
      try {
        const useResponses = this.config.judgeProtocol === "responses";
        const systemPrompt = buildJudgeSystemPrompt();
        const userPrompt = `当前API上下文：\n${truncated.text}`;
        response = await this.fetchImplementation(`${this.config.judgeBaseUrl.replace(/\/$/, "")}/${useResponses ? "responses" : "chat/completions"}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(useResponses ? {
            model: this.config.judgeModel,
            instructions: systemPrompt,
            input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
            ...(this.config.judgeReasoningEffort === "default" ? {} : {
              reasoning: { effort: this.config.judgeReasoningEffort, summary: "auto" },
            }),
            max_output_tokens: Math.min(300, this.config.maxOutputTokens),
            stream: false,
          } : {
            model: this.config.judgeModel,
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
            temperature: 0, max_tokens: Math.min(300, this.config.maxOutputTokens), response_format: { type: "json_object" },
            thinking: { type: "disabled" }, stream: false,
          }),
          signal: clientSignal ? AbortSignal.any([controller.signal, clientSignal]) : controller.signal,
        });
        if (firstByteTimeout) clearTimeout(firstByteTimeout);
        responseContentType = response.headers.get("content-type") ?? "";
        rawResponseBody = await response.text();
        const isContextError = upstreamContextError(response.status, rawResponseBody);
        if (!response.ok || isContextError) {
          const errorMetadata = errorResponseMetadata(rawResponseBody);
          throw new AcuJudgeAttemptError(`ACU Judge HTTP ${response.status}`, {
            provider: metadata.provider, model: this.config.judgeModel, endpointHost: metadata.host,
            upstreamRequestId: response.headers.get("x-request-id") ?? errorMetadata.id ?? null,
            latencyMs: Date.now() - started,
            promptTokens: errorMetadata.promptTokens, cachedPromptTokens: errorMetadata.cachedPromptTokens,
            completionTokens: errorMetadata.completionTokens, usageStatus: errorMetadata.usageStatus,
            errorCategory: isContextError ? "context_length_exceeded" : `http_${response.status}`,
            httpStatus: response.status,
            backupEligible: !isContextError && (response.status === 429 || response.status >= 500),
            backupReason: isContextError ? "backup_context_not_verified_larger_than_primary" :
              response.status === 429 ? "primary_rate_limited" : response.status >= 500
                ? "primary_server_error" : "http_status_not_backup_eligible",
            responseHeaders: responseHeaders(response.headers), rawResponseBody,
            contextSha256, contextTokenEstimate, rawRequestBytes, rawRequestTokenEstimate, judgeContextLimit,
            failureLayer: "transport_failure", responseContentType,
            providerEnvelopeValid: false, assistantTextExtracted: false,
          });
        }
        if (looksLikeHtml(rawResponseBody, responseContentType)) {
          throw new JudgeProviderProtocolError("ACU Judge returned HTML instead of a provider envelope");
        }
        try {
          payload = JSON.parse(rawResponseBody) as NonNullable<typeof payload>;
        } catch {
          throw new JudgeProviderProtocolError("ACU Judge returned an invalid JSON provider envelope");
        }
        if (!payload || typeof payload !== "object") throw new JudgeProviderProtocolError("ACU Judge returned an invalid provider envelope");
        if (payload?.model && payload.model !== this.config.judgeModel) {
          throw new JudgeProviderProtocolError(`ACU Judge actual model mismatch: ${payload.model}`);
        }
        const content = useResponses
          ? extractResponsesAssistantText(payload as Record<string, unknown>)
          : payload?.choices?.[0]?.message?.content;
        providerEnvelopeValid = useResponses ? Array.isArray(payload.output) : Array.isArray(payload.choices);
        if (!providerEnvelopeValid || !content) throw new JudgeProviderProtocolError("ACU Judge returned no valid Assistant output");
        assistantTextExtracted = true;
        let result: AcuJudgeResult;
        try {
          result = parseJudgeResult(content);
        } catch (error) {
          throw new JudgeSemanticParseError(error instanceof Error ? error.message : "Judge JSON is invalid", { cause: error });
        }
        const reportedInputTokens = payload.usage?.prompt_tokens ?? payload.usage?.input_tokens;
        const reportedOutputTokens = payload.usage?.completion_tokens ?? payload.usage?.output_tokens;
        const usageStatus = reportedInputTokens !== undefined && reportedOutputTokens !== undefined
        ? "reported" as const : "usage_missing" as const;
      const promptTokens = reportedInputTokens ?? truncated.tokenEstimate;
      const cachedPromptTokens = payload.usage?.prompt_tokens_details?.cached_tokens
        ?? payload.usage?.input_tokens_details?.cached_tokens ?? 0;
      const completionTokens = reportedOutputTokens ?? this.config.maxOutputTokens;
      const cost = judgeNominalCostUsd(this.config.judgeModel, promptTokens, cachedPromptTokens, completionTokens);
      const upstreamRequestId = payload.id ?? response.headers.get("x-request-id");
      const createdAt = new Date().toISOString();
      cache.entries[key] = {
        result, createdAt, promptVersion: this.config.promptVersion, model: this.config.judgeModel,
        provider: metadata.provider, endpointHost: metadata.host, upstreamRequestId,
        promptTokens, cachedPromptTokens, completionTokens, usageStatus,
      };
      writeCache(path, cache);
      return {
        result, status: "live", resultSource: "upstream_live", provider: metadata.provider,
        model: this.config.judgeModel,
        endpointHost: metadata.host, upstreamRequestId, latencyMs: Date.now() - started, cost,
        promptTokens, cachedPromptTokens, completionTokens, usageStatus, contextSha256, cacheKeySha256: key, cacheCreatedAt: createdAt,
        contextTokenEstimate: truncated.tokenEstimate, contextTruncated: false,
        rawRequestBytes, rawRequestTokenEstimate, judgeContextLimit,
        judgeContextSource: rawNative ? "raw_native_request_v1" : "visible_context_legacy",
      };
      } catch (error) {
        if (error instanceof AcuJudgeAttemptError) throw error;
        if (clientSignal?.aborted) throw new AcuJudgeClientCancelledError();
        const promptTokens = payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens ?? 0;
        const cachedPromptTokens = payload?.usage?.prompt_tokens_details?.cached_tokens
          ?? payload?.usage?.input_tokens_details?.cached_tokens ?? 0;
        const completionTokens = payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens ?? 0;
        const message = error instanceof Error ? error.message : "ACU Judge transport failure";
        const networkFailure = error instanceof TypeError || error instanceof DOMException || controller.signal.aborted;
        const semanticFailure = error instanceof JudgeSemanticParseError;
        const protocolFailure = error instanceof JudgeProviderProtocolError;
        const failureLayer = semanticFailure ? "judge_semantic_parse_failure"
          : protocolFailure ? "provider_protocol_failure" : "transport_failure";
        const errorCategory = semanticFailure ? "judge_semantic_parse_failure"
          : protocolFailure ? "provider_protocol_failure"
            : controller.signal.aborted ? "timeout" : networkFailure ? "network_error" : "provider_transport_error";
        throw new AcuJudgeAttemptError(message, {
          provider: metadata.provider, model: this.config.judgeModel, endpointHost: metadata.host,
          upstreamRequestId: payload?.id ?? response?.headers.get("x-request-id") ?? null,
          latencyMs: Date.now() - started, promptTokens, cachedPromptTokens, completionTokens,
          usageStatus: (payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens) !== undefined
            && (payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens) !== undefined
            ? "reported" : "usage_missing",
          errorCategory,
          backupEligible: networkFailure || protocolFailure || semanticFailure,
          backupReason: controller.signal.aborted ? "primary_timeout" : networkFailure
            ? "primary_network_error" : protocolFailure ? "primary_provider_protocol_invalid"
              : semanticFailure ? "primary_judge_semantic_invalid" : "not_backup_eligible",
          responseHeaders: response ? responseHeaders(response.headers) : {},
          rawResponseBody,
          parserExceptionType: semanticFailure && error.cause instanceof Error
            ? error.cause.name : error instanceof Error ? error.name : typeof error,
          parserExceptionMessage: message,
          contextSha256, contextTokenEstimate, rawRequestBytes, rawRequestTokenEstimate, judgeContextLimit,
          failureLayer, responseContentType, providerEnvelopeValid, assistantTextExtracted,
        });
      }
    } finally {
      if (firstByteTimeout) clearTimeout(firstByteTimeout);
      if (totalTimeout) clearTimeout(totalTimeout);
    }
  }
}
