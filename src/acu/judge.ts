import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import fewShotData from "./catalog/twin-few-shots.json";
import type { AcuDifficultyFactors, AcuJudgeResult, AcuVisibleMessage } from "./types.js";
import type { AcuRuntimeConfig } from "./config.js";
import { ACU_DIFFICULTY_METHOD_VERSION } from "./config.js";
import { estimateCallCost, judgeModelPrice } from "./decision.js";
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
  usageStatus: "reported" | "usage_missing";
};

type CacheFile = { schemaVersion: "acu-judge-cache-v3"; entries: Record<string, CacheRecord> };

export type JudgeRequestResult = {
  result: AcuJudgeResult;
  status: "live" | "cache_hit";
  resultSource: "upstream_live" | "disk_cache";
  provider: string;
  endpointHost: string;
  upstreamRequestId: string | null;
  latencyMs: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  usageStatus: "reported" | "usage_missing";
  contextSha256: string;
  cacheKeySha256: string;
  cacheCreatedAt: string;
  contextTokenEstimate: number;
  contextTruncated: boolean;
};

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

export function truncateVisibleContext(text: string, maxTokens: number): { text: string; tokenEstimate: number; truncated: boolean } {
  const originalTokens = estimateVisibleTokens(text);
  if (originalTokens <= maxTokens) return { text, tokenEstimate: originalTokens, truncated: false };
  const characters = Array.from(text);
  let lower = 0;
  let upper = characters.length;
  const marker = "\n[...deterministic head-tail truncation...]\n";
  while (lower < upper) {
    const keep = Math.ceil((lower + upper) / 2);
    const head = Math.ceil(keep * 0.58);
    const candidate = `${characters.slice(0, head).join("")}${marker}${characters.slice(-(keep - head)).join("")}`;
    if (estimateVisibleTokens(candidate) <= maxTokens) lower = keep;
    else upper = keep - 1;
  }
  const head = Math.ceil(lower * 0.58);
  const truncatedText = `${characters.slice(0, head).join("")}${marker}${characters.slice(-(lower - head)).join("")}`;
  return { text: truncatedText, tokenEstimate: estimateVisibleTokens(truncatedText), truncated: true };
}

export function buildJudgeSystemPrompt(): string {
  const examples = (fewShotData.examples as FewShot[]).map((example) => [
    `示例 ${example.exampleId}`,
    "上下文：",
    example.context,
    `最低充分档位解释：${example.minimumSufficientTier}；${example.explanation}`,
    `期望输出：${stableJson(example.expected)}`,
  ].join("\n")).join("\n\n---\n\n");
  return [
    "你是 ACU 任务能力需求分类器。判断当前完整、可见 API 上下文中，完成下一次模型响应所需的最低充分能力。",
    "不得回答原任务，不得推荐具体模型，不得根据模型品牌判断，不得输出代码或思维过程。",
    '只输出严格 JSON：{"difficulty_score_raw":0,"factors":{"reasoning_depth":0,"task_scope":0,"constraint_density":0,"tool_dependency":0,"verification_burden":0,"context_burden":0},"p_low":0,"p_mid":0,"p_mid_high":0,"p_high":0,"confidence":0,"signals":[],"explanation":""}',
    "difficulty_score_raw是0到100的原始总体判断；六个factors均为0到10、允许一位小数。后端会确定性计算最终难度指数，不要自行输出最终指数。",
    "reasoning_depth衡量推理链长度和抽象程度；task_scope衡量步骤、文件、模块、实体和目标范围；constraint_density衡量格式、事实、风格、业务和质量约束及其相互影响。",
    "tool_dependency衡量工具调用、代码执行、检索、多轮Agent行为和环境状态依赖；verification_burden越难通过JSON、测试或明确答案验证则越高；context_burden衡量上下文长度、分散程度和历史依赖。",
    "不要为了简洁默认使用5的倍数。请分别判断各能力需求因子，总难度由后端计算；只有真实判断恰好落在整数或5的倍数时才可输出该值。",
    "概率表达分类不确定性；除极其明确外不要机械输出单档100%，相邻档存在合理可能时应给软概率。原始总分与主要档位应大体一致，但不要求等于概率期望。",
    "四档概率必须在0到1且总和为1；signals最多5个；explanation不超过80个中文字符。",
    "以下示例只包含当时可见上下文，不含未来消息：",
    examples,
  ].join("\n\n");
}

function extractJson(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Judge response does not contain a JSON object");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
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
  if (!Array.isArray(parsed.signals) || parsed.signals.length > 5 || parsed.signals.some((signal) => typeof signal !== "string")) {
    throw new Error("Judge signals must contain at most five strings");
  }
  if (typeof parsed.explanation !== "string" || Array.from(parsed.explanation).length > 80) {
    throw new Error("Judge explanation must be a string no longer than 80 characters");
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
    explanation: parsed.explanation,
  };
}

function cachePath(config: AcuRuntimeConfig): string {
  if (config.cachePath && config.promptVersion === "acu-tier-requirement-v3") {
    return config.cachePath.replace(/v2(?=\.json$)/, "v3");
  }
  return config.cachePath || join(homedir(), ".claw-router", "acu-judge-cache-v3.json");
}

function readCache(path: string): CacheFile {
  if (!existsSync(path)) return { schemaVersion: "acu-judge-cache-v3", entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (parsed.schemaVersion !== "acu-judge-cache-v3" || !parsed.entries) throw new Error("wrong schema");
    return parsed;
  } catch {
    return { schemaVersion: "acu-judge-cache-v3", entries: {} };
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

function endpointMetadata(baseUrl: string): { host: string; provider: string } {
  const host = new URL(baseUrl).host;
  const provider = host.includes("openrouter") ? "openrouter"
    : host.includes("deepseek") ? "deepseek"
      : "openai_compatible";
  return { host, provider };
}

export class AcuJudgeClient {
  constructor(private readonly config: AcuRuntimeConfig, private readonly fetchImplementation: typeof fetch = fetch) {
    if (fetchImplementation !== fetch && process.env.NODE_ENV !== "test" && !config.allowMock) {
      throw new Error("Mock ACU Judge providers are forbidden outside tests unless ACU_ALLOW_MOCK=true");
    }
  }

  async judge(messages: AcuVisibleMessage[], tools: unknown[] = [], forceRefresh = false): Promise<JudgeRequestResult> {
    if (!this.config.apiKey) throw new Error("ACU Judge API key is not configured");
    if (this.config.promptVersion !== fewShotData.promptVersion) throw new Error("ACU Judge prompt version does not match frozen few-shot data");
    const visible = serializeVisibleContext(messages, tools);
    const contextSha256 = createHash("sha256").update(visible).digest("hex");
    const truncated = truncateVisibleContext(visible, this.config.maxContextTokens);
    const key = createHash("sha256").update(`${this.config.promptVersion}\n${this.config.judgeModel}\n${contextSha256}`).digest("hex");
    const path = cachePath(this.config);
    const cache = readCache(path);
    const cached = cache.entries[key];
    if (cached && !forceRefresh) {
      return {
        result: cached.result, status: "cache_hit", resultSource: "disk_cache", provider: cached.provider,
        endpointHost: cached.endpointHost, upstreamRequestId: cached.upstreamRequestId, latencyMs: 0, cost: 0,
        promptTokens: cached.promptTokens, completionTokens: cached.completionTokens, usageStatus: cached.usageStatus,
        contextSha256, cacheKeySha256: key, cacheCreatedAt: cached.createdAt,
        contextTokenEstimate: truncated.tokenEstimate, contextTruncated: truncated.truncated,
      };
    }

    const metadata = endpointMetadata(this.config.judgeBaseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const started = Date.now();
    try {
      let lastPayload: { id?: string; choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } } | undefined;
      let lastResponse: Response | undefined;
      let result: AcuJudgeResult | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await this.fetchImplementation(`${this.config.judgeBaseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.config.judgeModel,
            messages: [
              { role: "system", content: buildJudgeSystemPrompt() },
              { role: "user", content: `当前API上下文：\n${truncated.text}${attempt ? "\n\n上次结果的最终指数、原始总分或主要概率跨越了两个以上档位，请重新检查六因子并输出一致结果。" : ""}` },
            ],
            temperature: 0, max_tokens: Math.min(300, this.config.maxOutputTokens), response_format: { type: "json_object" },
            thinking: { type: "disabled" }, stream: false,
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`ACU Judge HTTP ${response.status}`);
        const payload = await response.json() as typeof lastPayload;
        const content = payload?.choices?.[0]?.message?.content;
        if (!content) throw new Error("ACU Judge returned no content");
        const parsed = parseJudgeResult(content);
        lastPayload = payload;
        lastResponse = response;
        if (!hasSevereTierConflict(parsed)) { result = parsed; break; }
      }
      if (!result || !lastPayload || !lastResponse) throw new Error("ACU Judge index, raw score and dominant tier remained severely inconsistent after retry");
      const usageStatus = lastPayload.usage?.prompt_tokens !== undefined && lastPayload.usage?.completion_tokens !== undefined
        ? "reported" as const : "usage_missing" as const;
      const promptTokens = lastPayload.usage?.prompt_tokens ?? truncated.tokenEstimate;
      const completionTokens = lastPayload.usage?.completion_tokens ?? this.config.maxOutputTokens;
      const cost = estimateCallCost(judgeModelPrice(), promptTokens, completionTokens);
      const upstreamRequestId = lastPayload.id ?? lastResponse.headers.get("x-request-id");
      const createdAt = new Date().toISOString();
      cache.entries[key] = {
        result, createdAt, promptVersion: this.config.promptVersion, model: this.config.judgeModel,
        provider: metadata.provider, endpointHost: metadata.host, upstreamRequestId,
        promptTokens, completionTokens, usageStatus,
      };
      writeCache(path, cache);
      return {
        result, status: "live", resultSource: "upstream_live", provider: metadata.provider,
        endpointHost: metadata.host, upstreamRequestId, latencyMs: Date.now() - started, cost,
        promptTokens, completionTokens, usageStatus, contextSha256, cacheKeySha256: key, cacheCreatedAt: createdAt,
        contextTokenEstimate: truncated.tokenEstimate, contextTruncated: truncated.truncated,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
