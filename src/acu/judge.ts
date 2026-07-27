import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import fewShotData from "./catalog/twin-few-shots.json";
import type { AcuJudgeResult, AcuVisibleMessage } from "./types.js";
import type { AcuRuntimeConfig } from "./config.js";
import { estimateCallCost, judgeModelPrice } from "./decision.js";
import { normalizeProbabilities } from "./math.js";

type FewShot = {
  exampleId: string;
  context: string;
  minimumSufficientTier: string;
  explanation: string;
};

type CacheRecord = {
  result: AcuJudgeResult;
  createdAt: string;
  promptVersion: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
};

type CacheFile = { schemaVersion: "acu-judge-cache-v1"; entries: Record<string, CacheRecord> };

export type JudgeRequestResult = {
  result: AcuJudgeResult;
  status: "success" | "cache_hit";
  latencyMs: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  contextSha256: string;
  contextTokenEstimate: number;
  contextTruncated: boolean;
};

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return String(part ?? "");
      const value = part as Record<string, unknown>;
      if (typeof value.text === "string") return value.text;
      if (typeof value.content === "string") return value.content;
      if (value.type === "image_url") return "[IMAGE]";
      return JSON.stringify(value);
    }).join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

export function serializeVisibleContext(messages: AcuVisibleMessage[], tools: unknown[] = []): string {
  const sections = messages.map((message) => {
    const role = message.role.toUpperCase();
    const name = message.name ? ` name=${message.name}` : "";
    return `[${role}${name}]\n${contentText(message.content)}`;
  });
  if (tools.length > 0) sections.push(`[AVAILABLE_TOOLS]\n${JSON.stringify(tools)}`);
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

export function truncateVisibleContext(
  text: string,
  maxTokens: number,
): { text: string; tokenEstimate: number; truncated: boolean } {
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
    `最低充分档位：${example.minimumSufficientTier}`,
    `解释：${example.explanation}`,
  ].join("\n")).join("\n\n---\n\n");
  return [
    "你是 ACU 任务能力需求分类器。判断当前完整、可见 API 上下文中，完成下一次模型响应所需的最低充分能力档位。",
    "不得回答原任务，不得推荐具体模型，不得输出代码，不得输出思维过程。",
    '只输出严格 JSON：{"p_low":0,"p_mid":0,"p_mid_high":0,"p_high":0,"confidence":0,"signals":[],"explanation":""}',
    "四档概率必须在0到1且总和为1；signals最多5个；explanation不超过80个中文字符。",
    "low=单一明确执行；mid=中等约束整合；mid_high=复杂上下文与工具状态整合；high=高风险或深层多步推理。",
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Judge response JSON must be an object");
  }
  return parsed as Record<string, unknown>;
}

export function parseJudgeResult(text: string): AcuJudgeResult {
  const parsed = extractJson(text);
  const probabilities = normalizeProbabilities({
    pLow: Number(parsed.p_low),
    pMid: Number(parsed.p_mid),
    pMidHigh: Number(parsed.p_mid_high),
    pHigh: Number(parsed.p_high),
    confidence: Number(parsed.confidence),
  });
  if (!Array.isArray(parsed.signals) || parsed.signals.length > 5
    || parsed.signals.some((signal) => typeof signal !== "string")) {
    throw new Error("Judge signals must contain at most five strings");
  }
  if (typeof parsed.explanation !== "string" || Array.from(parsed.explanation).length > 80) {
    throw new Error("Judge explanation must be a string no longer than 80 characters");
  }
  return {
    ...probabilities,
    signals: parsed.signals as string[],
    explanation: parsed.explanation,
  };
}

function cachePath(config: AcuRuntimeConfig): string {
  return config.cachePath || join(homedir(), ".claw-router", "acu-judge-cache-v1.json");
}

function readCache(path: string): CacheFile {
  if (!existsSync(path)) return { schemaVersion: "acu-judge-cache-v1", entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (parsed.schemaVersion !== "acu-judge-cache-v1" || !parsed.entries) throw new Error("wrong schema");
    return parsed;
  } catch {
    return { schemaVersion: "acu-judge-cache-v1", entries: {} };
  }
}

function writeCache(path: string, cache: CacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const entries = Object.entries(cache.entries).slice(-2_000);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...cache, entries: Object.fromEntries(entries) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // Cache persistence is an optimization; routing must not fail because disk
    // cache is unavailable.
  }
}

export class AcuJudgeClient {
  constructor(
    private readonly config: AcuRuntimeConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async judge(messages: AcuVisibleMessage[], tools: unknown[] = []): Promise<JudgeRequestResult> {
    if (!this.config.apiKey) throw new Error("ACU Judge API key is not configured");
    if (this.config.promptVersion !== fewShotData.promptVersion) {
      throw new Error("ACU Judge prompt version does not match frozen few-shot data");
    }
    const visible = serializeVisibleContext(messages, tools);
    const contextSha256 = createHash("sha256").update(visible).digest("hex");
    const truncated = truncateVisibleContext(visible, this.config.maxContextTokens);
    const key = createHash("sha256")
      .update(`${this.config.promptVersion}\n${this.config.judgeModel}\n${contextSha256}`)
      .digest("hex");
    const path = cachePath(this.config);
    const cache = readCache(path);
    const cached = cache.entries[key];
    if (cached) {
      return {
        result: cached.result,
        status: "cache_hit",
        latencyMs: 0,
        cost: 0,
        promptTokens: cached.promptTokens ?? 0,
        completionTokens: cached.completionTokens ?? 0,
        contextSha256,
        contextTokenEstimate: truncated.tokenEstimate,
        contextTruncated: truncated.truncated,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.config.judgeBaseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.judgeModel,
            messages: [
              { role: "system", content: buildJudgeSystemPrompt() },
              { role: "user", content: `当前API上下文：\n${truncated.text}` },
            ],
            temperature: 0,
            max_tokens: Math.min(300, this.config.maxOutputTokens),
            response_format: { type: "json_object" },
            thinking: { type: "disabled" },
            stream: false,
          }),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
    const latencyMs = Date.now() - started;
    if (!response.ok) throw new Error(`ACU Judge HTTP ${response.status}`);
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("ACU Judge returned no content");
    const result = parseJudgeResult(content);
    const price = judgeModelPrice();
    const promptTokens = payload.usage?.prompt_tokens ?? truncated.tokenEstimate;
    const completionTokens = payload.usage?.completion_tokens ?? this.config.maxOutputTokens;
    const cost = estimateCallCost(price, promptTokens, completionTokens);
    cache.entries[key] = {
      result,
      createdAt: new Date().toISOString(),
      promptVersion: this.config.promptVersion,
      model: this.config.judgeModel,
      promptTokens,
      completionTokens,
    };
    writeCache(path, cache);
    return {
      result,
      status: "success",
      latencyMs,
      cost,
      promptTokens,
      completionTokens,
      contextSha256,
      contextTokenEstimate: truncated.tokenEstimate,
      contextTruncated: truncated.truncated,
    };
  }
}
