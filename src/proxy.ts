/**
 * OpenRouter Smart Proxy
 *
 * Local proxy that intercepts OpenAI-compatible requests, applies smart routing,
 * and forwards to OpenRouter with API key authentication.
 *
 * Flow:
 *   Client → http://localhost:8402/v1/chat/completions
 *        → smart routing picks cheapest capable model
 *        → proxy forwards to https://openrouter.ai/api/v1/chat/completions
 *        → streams response back to client
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import {
  route,
  getFallbackChain,
  getFallbackChainFiltered,
  filterByToolCalling,
  filterByVision,
  filterByExcludeList,
  calculateModelCost,
  DEFAULT_ROUTING_CONFIG,
  type RouterOptions,
  type RoutingDecision,
  type RoutingConfig,
  type ModelPricing,
  type Tier,
} from "./router/index.js";
import { classifyByRules } from "./router/rules.js";
import {
  BLOCKRUN_MODELS,
  resolveModelAlias,
  getModelContextWindow,
  isReasoningModel,
  supportsToolCalling as modelSupportsToolCalling,
  getUpstream,
  UnknownModelError,
  usesMaxCompletionTokens,
  supportsVision as modelSupportsVision,
} from "./models.js";
import { logUsage, type UsageEntry } from "./logger.js";
import { getStats, clearStats } from "./stats.js";
import { RequestDeduplicator } from "./dedup.js";
import { ResponseCache, type ResponseCacheConfig } from "./response-cache.js";
import { compressContext, shouldCompress, type NormalizedMessage } from "./compression/index.js";
import { VERSION, USER_AGENT } from "./version.js";
import { SessionStore, getSessionId, deriveSessionId, type SessionConfig } from "./session.js";
import { SessionJournal } from "./journal.js";
import { loadExcludeList } from "./exclude-models.js";
import { PROXY_PORT } from "./config.js";
import {
  appendResponse,
  getLast,
  listRecent,
  summarizeRequest,
} from "./response-store.js";
import {
  appendLedgerEntry,
  clearLedger,
  getLedgerEntries,
  getLedgerSummary,
  type AcuLedgerEntry,
} from "./ledger.js";
import { validateAssistantOutput, type ValidatorResult } from "./validator/index.js";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_PROXY_BASE_URL = "https://api.openai-proxy.org/v1";

const HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const PER_MODEL_TIMEOUT_MS = 60_000;
const REASONING_MODEL_TIMEOUT_MS = 180_000;
const MAX_FALLBACK_ATTEMPTS = 5;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const OVERLOAD_COOLDOWN_MS = 15_000;
const MAX_MESSAGES = 200;
const ACU_PREFIX = "/acu-router";
const DEFAULT_BASELINE_MODEL = "claude-opus-4-7";

// ── Routing profile virtual models ──
const ROUTING_PROFILES = new Set(["auto", "eco", "premium"]);

// ── Per-model error tracking ──
const rateLimitedModels = new Map<string, number>();
const overloadedModels = new Map<string, number>();

function isRateLimited(modelId: string): boolean {
  const hitTime = rateLimitedModels.get(modelId);
  if (!hitTime) return false;
  if (Date.now() - hitTime >= RATE_LIMIT_COOLDOWN_MS) {
    rateLimitedModels.delete(modelId);
    return false;
  }
  return true;
}

function markRateLimited(modelId: string): void {
  rateLimitedModels.set(modelId, Date.now());
  console.log(`[ClawRouter] Model ${modelId} rate-limited, deprioritize for 60s`);
}

function markOverloaded(modelId: string): void {
  overloadedModels.set(modelId, Date.now());
  console.log(`[ClawRouter] Model ${modelId} overloaded, deprioritize for 15s`);
}

function isOverloaded(modelId: string): boolean {
  const hitTime = overloadedModels.get(modelId);
  if (!hitTime) return false;
  if (Date.now() - hitTime >= OVERLOAD_COOLDOWN_MS) {
    overloadedModels.delete(modelId);
    return false;
  }
  return true;
}

function prioritizeNonRateLimited(models: string[]): string[] {
  const available: string[] = [];
  const degraded: string[] = [];
  for (const m of models) {
    (isRateLimited(m) || isOverloaded(m) ? degraded : available).push(m);
  }
  return [...available, ...degraded];
}

function timeoutForModel(modelId: string): number {
  return isReasoningModel(modelId) ? REASONING_MODEL_TIMEOUT_MS : PER_MODEL_TIMEOUT_MS;
}

/** Make header values safe for non-ASCII content. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\t\x20-\x7E]/gu, (c) => {
    try { return encodeURIComponent(c); } catch { return "?"; }
  });
}

/** Safe write that checks socket state. */
function canWrite(res: ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed && res.socket !== null && !res.socket.destroyed && res.socket.writable;
}
function safeWrite(res: ServerResponse, data: string | Buffer): boolean {
  if (!canWrite(res)) return false;
  return res.write(data);
}

/** Categorize upstream errors for retry logic. */
type ErrorCategory = "rate_limited" | "overloaded" | "server_error" | "auth_failure" | "config_error";
function categorizeError(status: number, body: string): ErrorCategory | null {
  if (status === 401) return "auth_failure";
  if (status === 403) return "server_error"; // OpenRouter uses 403 for content policy too
  if (status === 429) return "rate_limited";
  if (status === 529) return "overloaded";
  if (status === 503 && /overload|capacity/i.test(body)) return "overloaded";
  if (status >= 500) return "server_error";
  if (status === 400 || status === 413) return "config_error";
  return null;
}

type AcuAttemptTrace = {
  model: string;
  upstream: string;
  status: "success" | "error" | "timeout" | "skipped";
  error_category?: string;
  latency_ms: number;
};

type AcuTrace = {
  request_id: string;
  profile: string;
  tier: string;
  score?: number;
  confidence: number;
  method: string;
  signals: string[];
  agentic_score?: number;
  selected_model: string;
  actual_model_used: string;
  upstream: string;
  fallback_chain: string[];
  attempts: AcuAttemptTrace[];
  attempt_count: number;
  fallback_used: boolean;
  quality_fallback_used: boolean;
  streaming?: boolean;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost: number;
  baseline_model: string;
  baseline_cost: number;
  estimated_savings: number;
  route_reasoning: string;
  validator_result: ValidatorResult["result"];
  validator: ValidatorResult["validator"];
  validator_pass?: boolean;
  validator_reason?: string;
};

function stripAcuPrefix(url: string | undefined): string {
  if (!url?.startsWith(ACU_PREFIX)) return url || "/";
  const stripped = url.slice(ACU_PREFIX.length);
  if (!stripped) return "/";
  if (stripped.startsWith("?")) return `/${stripped}`;
  return stripped;
}

function getPathname(url: string): string {
  return new URL(url, "http://localhost").pathname;
}

function getHeaderString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeRequestHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(",");
  }
  return headers;
}

function isProtectedDemoPath(pathname: string): boolean {
  return pathname === "/"
    || pathname === "/index.html"
    || pathname.startsWith("/public/")
    || pathname === "/cache"
    || pathname === "/stats"
    || pathname === "/ledger"
    || pathname === "/ledger/summary"
    || pathname.includes("/chat/completions");
}

function getEnvDemoAccessToken(): string {
  return process.env.DEMO_ACCESS_TOKEN?.trim()
    || process.env.ACU_DEMO_KEY?.trim()
    || process.env.PROXY_API_KEY?.trim()
    || "";
}

function decodeBasicAuthPassword(auth: string): string | undefined {
  const encoded = auth.match(/^Basic\s+(.+)$/i)?.[1]?.trim();
  if (!encoded) return undefined;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return decoded.trim();
    return decoded.slice(separator + 1).trim();
  } catch {
    return undefined;
  }
}

function isDemoAuthorized(req: IncomingMessage, demoAccessToken: string): boolean {
  if (!demoAccessToken) return true;
  const auth = getHeaderString(req.headers.authorization) || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const basicPassword = decodeBasicAuthPassword(auth);
  const demoKey = getHeaderString(req.headers["x-acu-demo-key"])?.trim();
  const url = new URL(req.url || "/", "http://localhost");
  const queryKey = url.searchParams.get("demo_key")?.trim();
  return basicPassword === demoAccessToken
    || bearer === demoAccessToken
    || demoKey === demoAccessToken
    || queryKey === demoAccessToken;
}

function hashPrompt(messages: ChatMessage[]): string {
  const text = messages.map((message) => JSON.stringify(message.content ?? "")).join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function detectTaskType(messages: ChatMessage[]): string {
  const text = messages.map((message) => {
    if (typeof message.content === "string") return message.content;
    return JSON.stringify(message.content ?? "");
  }).join("\n").toLowerCase();
  if (/\bjson\b|schema|extract|字段|结构化|提取/.test(text)) return "structured_extraction";
  if (/fix|bug|error|stack trace|代码|报错|修复/.test(text)) return "code_fix";
  if (/summary|summarize|abstract|摘要|总结/.test(text)) return "summary";
  if (/reason|compare|prove|design|推理|比较|证明|设计/.test(text)) return "reasoning";
  if (/email|邮件|投资人|investor/.test(text)) return "writing";
  return "general";
}

function extractPromptText(messages: ChatMessage[]): { prompt: string; systemPrompt?: string } {
  const lastUserMsg = [...messages].reverse().find((message) => message.role === "user");
  const rawPrompt = lastUserMsg?.content;
  const prompt = typeof rawPrompt === "string" ? rawPrompt : Array.isArray(rawPrompt)
    ? (rawPrompt as Array<{ type: string; text?: string }>).filter((block) => block.type === "text").map((block) => block.text ?? "").join(" ")
    : "";
  const systemMsg = messages.find((message) => message.role === "system");
  const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : undefined;
  return { prompt, systemPrompt };
}

function buildRuleTraceSignals(messages: ChatMessage[], maxTokens: number, config: RoutingConfig) {
  const { prompt, systemPrompt } = extractPromptText(messages);
  if (!prompt) return { score: undefined, signals: [] as string[] };
  const ruleResult = classifyByRules(
    prompt,
    systemPrompt,
    Math.ceil((prompt.length + (systemPrompt?.length ?? 0)) / 4) + maxTokens,
    config.scoring,
  );
  return { score: ruleResult.score, signals: ruleResult.signals };
}

function extractAssistantText(responseBody: string): string {
  try {
    const parsed = JSON.parse(responseBody) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  } catch {
    return "";
  }
}

function parseUsage(responseBody: string, estimatedInputTokens: number, estimatedOutputTokens: number) {
  try {
    const parsed = JSON.parse(responseBody) as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
      };
    };
    return {
      inputTokens: parsed.usage?.prompt_tokens ?? parsed.usage?.input_tokens ?? estimatedInputTokens,
      outputTokens: parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens ?? estimatedOutputTokens,
    };
  } catch {
    return { inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens };
  }
}

function getFallbackUsed(attempts: AcuAttemptTrace[], actualModelUsed: string, selectedModel?: string): boolean {
  return attempts.length > 1 || Boolean(selectedModel && selectedModel !== actualModelUsed);
}

function buildStreamingTrace(args: {
  requestId: string;
  routingProfile: "eco" | "auto" | "premium" | null;
  routingDecision?: RoutingDecision;
  parsedMessages: ChatMessage[];
  maxTokens: number;
  config: RoutingConfig;
  modelId: string;
  actualModelUsed: string;
  upstream: string;
  modelsToTry: string[];
  attempts: AcuAttemptTrace[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  costs: { costEstimate: number; baselineCost: number; savings: number };
}): AcuTrace {
  const fallbackUsed = getFallbackUsed(args.attempts, args.actualModelUsed, args.routingDecision?.model);
  return {
    ...buildRuleTraceSignals(args.parsedMessages, args.maxTokens, args.config),
    request_id: args.requestId,
    profile: args.routingProfile ?? "explicit",
    tier: args.routingDecision?.tier ?? "EXPLICIT",
    confidence: args.routingDecision?.confidence ?? 1,
    method: args.routingDecision?.method ?? "explicit",
    ...(args.routingDecision?.agenticScore !== undefined && { agentic_score: args.routingDecision.agenticScore }),
    selected_model: args.routingDecision?.model ?? args.modelId,
    actual_model_used: args.actualModelUsed,
    upstream: args.upstream,
    fallback_chain: args.modelsToTry,
    attempts: args.attempts,
    attempt_count: args.attempts.length,
    fallback_used: fallbackUsed,
    quality_fallback_used: false,
    streaming: true,
    estimated_input_tokens: args.estimatedInputTokens,
    estimated_output_tokens: args.estimatedOutputTokens,
    estimated_cost: args.costs.costEstimate,
    baseline_model: DEFAULT_BASELINE_MODEL,
    baseline_cost: args.costs.baselineCost,
    estimated_savings: args.costs.savings,
    route_reasoning: args.routingDecision?.reasoning ?? "Explicit model request",
    validator_result: "not_applicable",
    validator: "none",
  };
}

export function transformPaymentError(body: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }

  const text = [
    parsed.error,
    parsed.details,
    parsed.debug,
    parsed.code,
  ].filter((value): value is string => typeof value === "string").join(" ");
  if (!/payment|settlement|insufficient|invalid|expired|gas/i.test(text)) return body;

  let nested: Record<string, unknown> = {};
  const nestedSource = typeof parsed.details === "string" ? parsed.details : typeof parsed.debug === "string" ? parsed.debug : "";
  const start = nestedSource.indexOf("{");
  const end = nestedSource.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      nested = JSON.parse(nestedSource.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      nested = {};
    }
  }

  const payer = String(parsed.payer || nested.payer || "");
  const network = payer.startsWith("0x") ? "Base" : "Solana";
  const reason = String(nested.invalidReason || "");
  const detail = `${text} ${nested.invalidMessage || ""}`;
  let type = "payment_invalid";
  let message = `Payment verification failed on ${network}.`;

  if (/settlement/i.test(String(parsed.error)) || /estimate gas|gas/i.test(detail)) {
    type = "settlement_failed";
    message = "Settlement failed; unable to estimate gas.";
  } else if (/insufficient/i.test(`${reason} ${detail}`)) {
    type = "insufficient_funds";
    message = `Insufficient USDC balance on ${network}.`;
  } else if (/expired/i.test(detail)) {
    type = "expired";
    message = `Payment authorization expired on ${network}.`;
  } else if (/invalid_signature/i.test(detail)) {
    type = "invalid_payload";
    message = `Invalid payment signature on ${network}.`;
  } else if (String(parsed.code) === "PAYMENT_INVALID" && /transaction_simulation_failed/i.test(detail)) {
    type = "transaction_simulation_failed";
    message = `Transaction simulation failed on ${network}.`;
  } else if (reason === "invalid_payload" && String(parsed.code) !== "PAYMENT_INVALID") {
    type = "invalid_payload";
    message = `Invalid payment payload on ${network}.`;
  }

  return JSON.stringify({ error: { type, message } });
}

function injectTraceIntoJsonResponse(responseBody: string, trace: AcuTrace): string {
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    parsed.acu_trace = trace;
    return JSON.stringify(parsed);
  } catch {
    return responseBody;
  }
}

function selectQualityFallbackModel(
  routingDecision: RoutingDecision | undefined,
  routingConfig: RoutingConfig,
  actualModelUsed: string,
  modelsTried: string[],
): string | undefined {
  if (!routingDecision) return undefined;
  const premiumTiers = routingConfig.premiumTiers ?? routingConfig.tiers;
  const premiumChain = getFallbackChain(routingDecision.tier, premiumTiers);
  return premiumChain.find((model) => model !== actualModelUsed && !modelsTried.includes(model));
}

async function fetchUpstreamChatCompletion(args: {
  body: Buffer;
  model: string;
  apiKey: string;
  proxyApiKey?: string;
  proxyBaseUrl?: string;
  signal: AbortSignal;
}): Promise<{ response: Response; upstreamProvider: string; requestBody: Buffer }> {
  const upstreamProvider = getUpstream(args.model);
  const isOpenRouter = upstreamProvider === "openrouter";
  const baseUrl = isOpenRouter
    ? process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL
    : (args.proxyBaseUrl || process.env.PROXY_BASE_URL?.trim() || DEFAULT_PROXY_BASE_URL);
  const fetchApiKey = isOpenRouter ? args.apiKey : (args.proxyApiKey || args.apiKey);
  const upstreamUrl = `${baseUrl}/chat/completions`;

  const reqParsed = JSON.parse(args.body.toString()) as Record<string, unknown>;
  reqParsed.model = args.model;
  if (usesMaxCompletionTokens(args.model) && reqParsed.max_tokens) {
    reqParsed.max_completion_tokens = reqParsed.max_tokens;
    delete reqParsed.max_tokens;
  }

  const requestBody = Buffer.from(JSON.stringify(reqParsed));
  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${fetchApiKey}`,
    "User-Agent": USER_AGENT,
  };
  if (isOpenRouter) {
    upstreamHeaders["HTTP-Referer"] = "http://localhost:8402";
    upstreamHeaders["X-Title"] = "ClawRouter";
  }

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: requestBody,
    signal: args.signal,
  });
  return { response, upstreamProvider, requestBody };
}

async function readResponseText(response: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } catch {
      // Best effort; callers handle malformed/empty bodies.
    }
  }
  return Buffer.concat(chunks).toString();
}

// ── Types ──

export type ProxyOptions = {
  apiKey?: string;
  port?: number;
  wallet?: string;
  apiBase?: string;
  proxyApiKey?: string;
  proxyBaseUrl?: string;
  routingConfig?: Partial<RoutingConfig>;
  cacheConfig?: Partial<ResponseCacheConfig>;
  sessionConfig?: Partial<SessionConfig>;
  excludeModels?: Set<string> | string[];
  demoAccessToken?: string;
  skipBalanceCheck?: boolean; // unused, kept for API compat
  onRouted?: (decision: RoutingDecision) => void;
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
  walletAddress?: string;
  close: () => Promise<void>;
};

function walletAddressFromKey(wallet?: string): string | undefined {
  const normalized = wallet?.trim();
  if (!normalized || !/^0x[0-9a-fA-F]{64}$/.test(normalized)) return undefined;
  return `0x${normalized.slice(-40)}`;
}

function normalizeMessagesForThinking(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant" && !("reasoning_content" in message)) {
      return { ...message, reasoning_content: "" };
    }
    return message;
  });
}

function stripDemoOnlyRequestFields(parsed: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of ["baseline_model", "cache", "expected_schema"]) {
    if (key in parsed) {
      delete parsed[key];
      changed = true;
    }
  }
  return changed;
}

function isDebugCommand(messages: ChatMessage[]): boolean {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return typeof lastUser?.content === "string" && lastUser.content.trim().startsWith("/debug");
}

function buildDebugCompletion(args: {
  messages: ChatMessage[];
  profile: string;
  routingDecision?: RoutingDecision;
  maxTokens: number;
  config: RoutingConfig;
}) {
  const lastUser = [...args.messages].reverse().find((message) => message.role === "user");
  const prompt = typeof lastUser?.content === "string" ? lastUser.content.replace(/^\/debug\s*/, "") : "";
  const trace = buildRuleTraceSignals([{ role: "user", content: prompt || "debug" }], args.maxTokens, args.config);
  const content = [
    "ClawRouter Debug",
    `Profile: ${args.profile}`,
    `Tier: ${args.routingDecision?.tier ?? "SIMPLE"}`,
    `Model: ${args.routingDecision?.model ?? "auto"}`,
    `Confidence: ${(args.routingDecision?.confidence ?? 1).toFixed(2)}`,
    "Scoring (weighted: rule-based)",
    `tokenCount: ${Math.ceil(prompt.length / 4)}`,
    `codePresence: ${/code|function|python|javascript|bug|debug/i.test(prompt) ? 1 : 0}`,
    `reasoningMarkers: ${/prove|step|reason|analyze|compare/i.test(prompt) ? 1 : 0}`,
    `simpleIndicators: ${prompt.length < 80 ? 1 : 0}`,
    `agenticTask: ${/plan|agent|tool|workflow/i.test(prompt) ? 1 : 0}`,
    `Signals: ${trace.signals.join(", ") || "-"}`,
    "Tier Boundaries: SIMPLE / MEDIUM / COMPLEX / REASONING",
  ].join("\n");

  return {
    id: `chatcmpl-debug-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "clawrouter/debug",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

function sendDebugResponse(res: ServerResponse, payload: ReturnType<typeof buildDebugCompletion>, stream: boolean): void {
  if (!stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const chunk = {
    id: payload.id,
    object: "chat.completion.chunk",
    created: payload.created,
    model: payload.model,
    choices: [{ index: 0, delta: { role: "assistant", content: payload.choices[0].message.content }, finish_reason: null }],
  };
  const finish = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write(`data: ${JSON.stringify(finish)}\n\n`);
  res.end("data: [DONE]\n\n");
}

// ── Build model pricing map ──

function buildModelPricing(): Map<string, ModelPricing> {
  const pricing = new Map<string, ModelPricing>();
  for (const m of BLOCKRUN_MODELS) {
    pricing.set(m.id, {
      inputPrice: m.cost.input,
      outputPrice: m.cost.output,
    });
  }
  return pricing;
}

// ── Build /v1/models response ──

export function buildProxyModelList() {
  const routingProfiles = ["auto", "eco", "free", "premium"].map((id) => ({
    id,
    name: `ACU Router ${id}`,
    object: "model" as const,
    created: 1700000000,
    owned_by: "router",
    upstream: "router",
    pricing: {
      prompt: 0,
      completion: 0,
      cache_read: 0,
      cache_write: 0,
    },
    context_length: 0,
    max_completion_tokens: 0,
    capabilities: {
      reasoning: true,
      vision: true,
      tool_calling: true,
    },
  }));
  return [...routingProfiles, ...BLOCKRUN_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    object: "model" as const,
    created: 1700000000,
    owned_by: m.upstream,
    upstream: m.upstream,
    pricing: {
      prompt: m.cost.input,
      completion: m.cost.output,
      cache_read: m.cost.cacheRead,
      cache_write: m.cost.cacheWrite,
    },
    context_length: m.contextWindow,
    max_completion_tokens: m.maxTokens,
    capabilities: {
      reasoning: m.reasoning,
      vision: m.input.includes("image"),
      tool_calling: modelSupportsToolCalling(m.id),
    },
  }))];
}

export function validateRoutingConfigModels(
  config: RoutingConfig,
  models = BLOCKRUN_MODELS,
): void {
  const knownModels = new Set(models.map((m) => m.id));
  const missing: string[] = [];

  const validateTierSet = (label: string, tiers: RoutingConfig["tiers"] | null | undefined) => {
    if (!tiers) return;
    for (const [tier, tierConfig] of Object.entries(tiers)) {
      for (const modelId of [tierConfig.primary, ...tierConfig.fallback]) {
        if (!knownModels.has(modelId)) missing.push(`${label}.${tier}: ${modelId}`);
      }
    }
  };

  validateTierSet("tiers", config.tiers);
  validateTierSet("ecoTiers", config.ecoTiers);
  validateTierSet("premiumTiers", config.premiumTiers);
  validateTierSet("agenticTiers", config.agenticTiers);

  if (missing.length > 0) {
    throw new Error(`Routing config references unknown model IDs:\n${missing.join("\n")}`);
  }
}

// ── Merge user routing config with defaults ──

function mergeRoutingConfig(partial?: Partial<RoutingConfig>): RoutingConfig {
  if (!partial) return DEFAULT_ROUTING_CONFIG;
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...partial,
    scoring: { ...DEFAULT_ROUTING_CONFIG.scoring, ...partial.scoring },
    overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, ...partial.overrides },
  };
}

// ── Message normalization helpers ──

type ChatMessage = { role: string; content: unknown; [key: string]: unknown };

function normalizeMessageRoles(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === "developer") return { ...m, role: "system" };
    return m;
  });
}

function truncateMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_MESSAGES) return messages;
  // Keep first (system) + last MAX_MESSAGES-1
  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  const truncated = nonSystem.slice(-MAX_MESSAGES + system.length);
  return [...system, ...truncated];
}

function isGoogleModel(modelId: string): boolean {
  return modelId.startsWith("google/");
}

function normalizeMessagesForGoogle(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const firstNonSystem = messages.findIndex((m) => m.role !== "system");
  if (firstNonSystem >= 0 && messages[firstNonSystem].role !== "user") {
    messages = [...messages];
    messages.splice(firstNonSystem, 0, { role: "user", content: "." });
  }
  return messages;
}

// ── Main proxy start ──

export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const apiKey = options.apiKey || options.wallet || "test-api-key";
  const proxyBaseUrl = options.proxyBaseUrl || options.apiBase;
  const walletAddress = walletAddressFromKey(options.wallet);
  const port = options.port ?? PROXY_PORT;
  let boundPort = port;
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  validateRoutingConfigModels(routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts: RouterOptions = { config: routingConfig, modelPricing };
  const demoAccessToken = options.demoAccessToken?.trim() ?? getEnvDemoAccessToken();

  const deduplicator = new RequestDeduplicator();
  const responseCache = new ResponseCache(options.cacheConfig);
  const sessionStore = new SessionStore(options.sessionConfig);
  const sessionJournal = new SessionJournal();
  const excludeList = loadExcludeList();
  if (options.excludeModels) {
    for (const model of options.excludeModels) excludeList.add(model);
  }

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, {
        apiKey, proxyApiKey: options.proxyApiKey, proxyBaseUrl, routerOpts, deduplicator, responseCache, sessionStore,
        sessionJournal, excludeList, onRouted: options.onRouted, walletAddress, demoAccessToken,
      });
    } catch (err) {
      console.error(`[ClawRouter] Unhandled error: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: { message: "Internal proxy error", type: "proxy_error" } }));
    }
  });

  // Retry port binding (handles TIME_WAIT)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          const address = server.address() as AddressInfo | null;
          boundPort = address?.port ?? port;
          resolve();
        });
      });
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && attempt < 4) {
        console.log(`[ClawRouter] Port ${port} busy, retrying (${attempt + 1}/5)...`);
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        throw err;
      }
    }
  }

  console.log(`[ClawRouter] v${VERSION} listening on http://127.0.0.1:${boundPort}`);
  console.log(`[ClawRouter] Routing via dual upstreams (${BLOCKRUN_MODELS.length} models)`);

  return {
    port: boundPort,
    baseUrl: `http://127.0.0.1:${boundPort}`,
    ...(walletAddress && { walletAddress }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ── Request handler ──

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    apiKey: string;
    routerOpts: RouterOptions;
  proxyApiKey?: string;
  proxyBaseUrl?: string;
    deduplicator: RequestDeduplicator;
    responseCache: ResponseCache;
    sessionStore: SessionStore;
    sessionJournal: SessionJournal;
    excludeList: Set<string>;
    onRouted?: (decision: RoutingDecision) => void;
    walletAddress?: string;
    demoAccessToken: string;
  },
): Promise<void> {
  req.url = stripAcuPrefix(req.url);
  const pathname = getPathname(req.url);

  if (isProtectedDemoPath(pathname)) {
    if (!isDemoAuthorized(req, ctx.demoAccessToken)) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Basic realm="ACU Router Demo"',
      });
      res.end(JSON.stringify({ error: { message: "Unauthorized", type: "unauthorized" } }));
      return;
    }
  }

  // ── Health check ──
  if (pathname === "/health") {
    const url = new URL(req.url, "http://localhost");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: VERSION,
      models: BLOCKRUN_MODELS.length,
      ...(ctx.walletAddress && { wallet: ctx.walletAddress }),
      ...(url.searchParams.get("full") === "true" && { balanceError: "balance check disabled in local proxy" }),
    }));
    return;
  }

  // ── Cache stats ──
  if (pathname === "/cache") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ctx.responseCache.getStats(), null, 2));
    return;
  }

  // ── Stats ──
  if (pathname === "/stats") {
    try {
      const url = new URL(req.url, "http://localhost");
      const days = parseInt(url.searchParams.get("days") || "7", 10);
      if (req.method === "DELETE") {
        const result = await clearStats();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cleared: true, deletedFiles: result.deletedFiles }));
      } else {
        const stats = await getStats(Math.min(days, 30));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stats, null, 2));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // ── ACU Ledger ──
  if (pathname === "/ledger" || pathname === "/ledger/summary") {
    try {
      const url = new URL(req.url, "http://localhost");
      const days = Math.min(parseInt(url.searchParams.get("days") || "7", 10), 30);
      if (req.method === "DELETE" && pathname === "/ledger") {
        const result = await clearLedger();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cleared: true, deletedFiles: result.deletedFiles }));
      } else if (req.method === "GET" && pathname === "/ledger/summary") {
        const summary = await getLedgerSummary(days);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(summary, null, 2));
      } else if (req.method === "GET" && pathname === "/ledger") {
        const entries = await getLedgerEntries(days);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: entries }, null, 2));
      } else {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // ── /v1/models ──
  if (pathname === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: buildProxyModelList() }));
    return;
  }

  // ── Share routes ──
  if (pathname.startsWith("/share/") && req.method === "GET") {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/share/list") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 100);
        const entries = await listRecent(limit);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(entries.map((e) => ({ id: e.id, timestamp: e.timestamp, model: e.model, requestSummary: e.requestSummary }))));
      } else if (url.pathname === "/share/last") {
        const entry = await getLast();
        if (!entry) { res.writeHead(404); res.end('{"error":"no responses yet"}'); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: entry.id, model: entry.model, text: entry.responseText.slice(0, 5000) }));
      } else {
        res.writeHead(404); res.end('{"error":"not found"}');
      }
    } catch {
      res.writeHead(500); res.end('{"error":"share route failed"}');
    }
    return;
  }

  // ── Only handle chat completions from here ──

  // ── Static file serving (frontend) ──
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname.startsWith("/public/"))) {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const publicDir = join(__dirname, "..", "public");
    const filePath = pathname === "/" || pathname === "/index.html"
      ? join(publicDir, "index.html")
      : join(publicDir, pathname.replace("/public/", ""));
    if (existsSync(filePath)) {
      const ext = filePath.split(".").pop() || "html";
      const mime: Record<string, string> = { html: "text/html", css: "text/css", js: "application/javascript", json: "application/json", png: "image/png", svg: "image/svg+xml" };
      res.writeHead(200, { "Content-Type": mime[ext] || "text/plain" });
      res.end(readFileSync(filePath));
      return;
    }
  }
  if (!pathname.includes("/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", detail: { message: `Not found: ${req.url}`, type: "not_found" } }));
    return;
  }

  const startTime = Date.now();
  const requestId = randomUUID();
  const debugHeader = req.headers["x-acu-debug"] ?? req.headers["x-clawrouter-debug"];
  const debugMode = debugHeader !== "false";

  // Collect body
  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let body = Buffer.concat(bodyChunks);

  // ── Dedup check ──
  const dedupKey = RequestDeduplicator.hash(body);
  const cached = ctx.deduplicator.getCached(dedupKey);
  if (cached) {
    res.writeHead(cached.status, cached.headers);
    res.end(cached.body);
    return;
  }
  const inflight = ctx.deduplicator.getInflight(dedupKey);
  if (inflight) {
    const result = await inflight;
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    return;
  }
  ctx.deduplicator.markInflight(dedupKey);

  // ── Parse request ──
  let isStreaming = false;
  let modelId = "";
  let maxTokens = 4096;
  let routingProfile: "eco" | "auto" | "premium" | null = null;
  let routingDecision: RoutingDecision | undefined;
  let hasTools = false;
  let hasVision = false;
  let bodyModified = false;
  const sessionId = getSessionId(req.headers as Record<string, string | string[] | undefined>);
  let effectiveSessionId: string | undefined = sessionId;
  const parsedMessages: ChatMessage[] = [];
  let responseFormat: unknown;
  let expectedSchema: unknown;

  try {
    const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
    isStreaming = parsed.stream === true;
    modelId = (parsed.model as string) || "";
    maxTokens = (parsed.max_tokens as number) || 4096;
    responseFormat = parsed.response_format;
    expectedSchema = parsed.expected_schema;
    if (stripDemoOnlyRequestFields(parsed)) bodyModified = true;

    const messages = Array.isArray(parsed.messages) ? (parsed.messages as ChatMessage[]) : [];
    parsedMessages.push(...messages);

    // Normalize message roles
    parsed.messages = normalizeMessageRoles(messages);
    parsed.messages = truncateMessages(parsed.messages as ChatMessage[]);

    // Tool/vision detection
    hasTools = Array.isArray(parsed.tools) && (parsed.tools as unknown[]).length > 0;
    hasVision = messages.some((m) =>
      Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((p) => p.type === "image_url")
    );

      const normalizedModel = modelId.toLowerCase().trim();
      const resolvedModel = resolveModelAlias(normalizedModel);
      const isRoutingProfile = ROUTING_PROFILES.has(normalizedModel) || ROUTING_PROFILES.has(resolvedModel);

    if (isRoutingProfile) {
      const profileName = resolvedModel.replace("blockrun/", "");
      routingProfile = profileName as "eco" | "auto" | "premium";

      // Smart routing
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const rawPrompt = lastUserMsg?.content;
      const prompt = typeof rawPrompt === "string" ? rawPrompt : Array.isArray(rawPrompt)
        ? (rawPrompt as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ")
        : "";
      const systemMsg = messages.find((m) => m.role === "system");
      const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : undefined;

      // Session persistence
      effectiveSessionId = sessionId ?? deriveSessionId(messages);
      const existingSession = effectiveSessionId ? ctx.sessionStore.getSession(effectiveSessionId) : undefined;

      routingDecision = route(prompt, systemPrompt, maxTokens, {
        ...ctx.routerOpts,
        routingProfile: routingProfile ?? undefined,
        hasTools,
      });

      if (existingSession?.userExplicit) {
        modelId = existingSession.model;
        parsed.model = modelId;
        bodyModified = true;
      } else if (existingSession) {
        const tierRank: Record<string, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
        const existingRank = tierRank[existingSession.tier] ?? 0;
        const newRank = tierRank[routingDecision.tier] ?? 0;
        if (newRank > existingRank) {
          modelId = routingDecision.model;
          parsed.model = modelId;
          bodyModified = true;
          ctx.sessionStore.setSession(effectiveSessionId!, routingDecision.model, routingDecision.tier);
        } else {
          modelId = existingSession.model;
          parsed.model = modelId;
          bodyModified = true;
          ctx.sessionStore.touchSession(effectiveSessionId!);
        }
      } else {
        modelId = routingDecision.model;
        parsed.model = modelId;
        bodyModified = true;
        if (effectiveSessionId) {
          ctx.sessionStore.setSession(effectiveSessionId!, routingDecision.model, routingDecision.tier);
        }
      }

      ctx.onRouted?.(routingDecision);
    } else {
      // Explicit model request
      modelId = resolvedModel;
      parsed.model = modelId;
      bodyModified = true;

      const explicitSessionId = sessionId ?? deriveSessionId(messages);
      if (explicitSessionId) {
        ctx.sessionStore.setSession(explicitSessionId, resolvedModel, "MEDIUM", true);
        effectiveSessionId = explicitSessionId;
      }
    }

    if (isDebugCommand(parsed.messages as ChatMessage[])) {
      const payload = buildDebugCompletion({
        messages: parsed.messages as ChatMessage[],
        profile: routingProfile ?? resolvedModel.replace("blockrun/", ""),
        routingDecision,
        maxTokens,
        config: ctx.routerOpts.config,
      });
      sendDebugResponse(res, payload, isStreaming);
      ctx.deduplicator.removeInflight(dedupKey);
      return;
    }

    // Google model normalization
    if (isGoogleModel(modelId) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForGoogle(parsed.messages as ChatMessage[]);
    }
    if ((modelId.startsWith("kimi-") || isReasoningModel(modelId)) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForThinking(parsed.messages as ChatMessage[]);
    }

    // Disable streaming for upstream (we handle SSE ourselves)
    if (parsed.stream === true) {
      parsed.stream = false;
      bodyModified = true;
    }

    if (bodyModified) {
      body = Buffer.from(JSON.stringify(parsed));
    }
  } catch {
    // If body isn't valid JSON, forward as-is
  }

  // ── Compression ──
  if (parsedMessages.length > 0 && shouldCompress(parsedMessages as NormalizedMessage[])) {
    try {
      const compressed = await compressContext(parsedMessages as NormalizedMessage[]);
      if (compressed.compressionRatio < 0.95) {
        console.log(`[ClawRouter] Compression: ${(compressed.compressionRatio * 100).toFixed(0)}% of original`);
      }
    } catch {
      // Compression failure is non-fatal
    }
  }

  // ── Response cache check ──
  const requestHeaders = normalizeRequestHeaders(req);
  const allowResponseCache = ctx.responseCache.shouldCache(body, requestHeaders);
  const respCached = allowResponseCache ? ctx.responseCache.get(dedupKey) : undefined;
  if (respCached) {
    const headers = { "Content-Type": "application/json", "X-Cache-Hit": "true" };
    res.writeHead(200, headers);
    res.end(respCached.body);
    const estimatedInputTokens = Math.ceil(body.length / 4);
    const usage = parseUsage(respCached.body.toString(), estimatedInputTokens, maxTokens);
    const costs = calculateModelCost(respCached.model, ctx.routerOpts.modelPricing, usage.inputTokens, usage.outputTokens, routingProfile ?? undefined);
    await appendLedgerEntry({
      request_id: requestId,
      timestamp: new Date().toISOString(),
      prompt_hash: hashPrompt(parsedMessages),
      task_type: detectTaskType(parsedMessages),
      profile: routingProfile ?? "explicit",
      tier: routingDecision?.tier ?? "EXPLICIT",
      method: routingDecision?.method ?? "cache_hit",
      selected_model: routingDecision?.model ?? respCached.model,
      actual_model_used: respCached.model,
      upstream: getUpstream(respCached.model),
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      estimated_cost: 0,
      actual_cost: 0,
      baseline_model: DEFAULT_BASELINE_MODEL,
      baseline_cost: costs.baselineCost,
      savings: costs.baselineCost,
      latency_ms: Date.now() - startTime,
      fallback_attempts: 0,
      fallback_used: false,
      quality_fallback_used: false,
      validator_result: "not_applicable",
      cache_hit: true,
    });
    ctx.deduplicator.complete(dedupKey, { status: 200, headers, body: Buffer.from(respCached.body), completedAt: Date.now() });
    return;
  }

  // ── Build models to try (fallback chain) ──
  let modelsToTry: string[] = [];

  if (routingDecision) {
    // Use routing decision's tier config
    const tierConfigs = routingDecision.tierConfigs ?? ctx.routerOpts.config.tiers;
    let chain = getFallbackChainFiltered(
      routingDecision.tier, tierConfigs,
      Math.ceil(body.length / 4) + maxTokens,
      getModelContextWindow,
    );
    chain = filterByToolCalling(chain, hasTools, modelSupportsToolCalling);
    chain = filterByVision(chain, hasVision, modelSupportsVision);
    chain = filterByExcludeList(chain, ctx.excludeList);
    modelsToTry = chain.slice(0, MAX_FALLBACK_ATTEMPTS);
    modelsToTry = prioritizeNonRateLimited(modelsToTry);
  } else {
    modelsToTry = [modelId];
  }

  // ── Global timeout ──
  const globalController = new AbortController();
  const timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const timeoutId = setTimeout(() => globalController.abort(), timeoutMs);

  const onClientClose = () => {
    if (!res.writableEnded) globalController.abort();
  };
  req.on("close", onClientClose);

  // ── SSE heartbeat (streaming only) ──
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let headersSentEarly = false;

  if (isStreaming) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-ClawRouter-Version": VERSION,
    });
    headersSentEarly = true;
    safeWrite(res, ": heartbeat\n\n");
    heartbeatInterval = setInterval(() => {
      if (canWrite(res)) safeWrite(res, ": heartbeat\n\n");
      else clearInterval(heartbeatInterval);
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ── Fallback loop ──
  let upstream: Response | undefined;
  let actualModelUsed = modelId;
  let lastError: { body: string; status: number } | undefined;
  let lastErrorCategory: string | undefined;
  let upstreamProviderUsed = "";
  const attempts: AcuAttemptTrace[] = [];

  for (let i = 0; i < modelsToTry.length; i++) {
    const tryModel = modelsToTry[i];
    if (globalController.signal.aborted) break;

    console.log(`[ClawRouter] Trying model ${tryModel} (${i + 1}/${modelsToTry.length})`);
    const attemptStart = Date.now();

    const perAttemptTimeout = timeoutForModel(tryModel);
    const modelController = new AbortController();
    const modelTimeoutId = setTimeout(() => modelController.abort(), perAttemptTimeout);
    const combinedSignal = AbortSignal.any([globalController.signal, modelController.signal]);

    try {
      const { response, upstreamProvider } = await fetchUpstreamChatCompletion({
        body,
        model: tryModel,
        apiKey: ctx.apiKey,
        proxyApiKey: ctx.proxyApiKey,
        proxyBaseUrl: ctx.proxyBaseUrl,
        signal: combinedSignal,
      });
      if (response.status === 200) {
        upstream = response;
        actualModelUsed = tryModel;
        upstreamProviderUsed = upstreamProvider;
        attempts.push({
          model: tryModel,
          upstream: upstreamProvider,
          status: "success",
          latency_ms: Date.now() - attemptStart,
        });
        break;
      }

      // Handle errors
      const errorBody = await response.text().catch(() => "");
      const category = categorizeError(response.status, errorBody);
      lastErrorCategory = category ?? "upstream_error";
      lastError = { body: errorBody, status: response.status };
      attempts.push({
        model: tryModel,
        upstream: upstreamProvider,
        status: "error",
        error_category: lastErrorCategory,
        latency_ms: Date.now() - attemptStart,
      });

      if (category === "rate_limited") {
        markRateLimited(tryModel);
      } else if (category === "overloaded") {
        markOverloaded(tryModel);
      } else if (category === "auth_failure" && response.status === 401) {
        console.error(`[ClawRouter] Auth failure for ${tryModel} — check API key`);
        break; // Don't retry auth failures
      }

      console.log(`[ClawRouter] ${category ?? "error"} from ${tryModel}: ${errorBody.slice(0, 100)}`);
    } catch (err) {
      clearTimeout(modelTimeoutId);
      if (globalController.signal.aborted) break;
      if (err instanceof UnknownModelError) {
        lastError = { body: err.message, status: 500 };
        lastErrorCategory = "unknown_model";
        attempts.push({
          model: tryModel,
          upstream: "unknown",
          status: "skipped",
          error_category: lastErrorCategory,
          latency_ms: Date.now() - attemptStart,
        });
        console.error(`[ClawRouter] ${err.message}; skipping fallback candidate`);
        continue;
      }
      if (modelController.signal.aborted && i < modelsToTry.length - 1) {
        lastErrorCategory = "timeout";
        attempts.push({
          model: tryModel,
          upstream: "unknown",
          status: "timeout",
          error_category: lastErrorCategory,
          latency_ms: Date.now() - attemptStart,
        });
        console.log(`[ClawRouter] ${tryModel} timed out, trying fallback`);
        continue;
      }
      lastError = { body: String(err), status: 500 };
      lastErrorCategory = "server_error";
      attempts.push({
        model: tryModel,
        upstream: "unknown",
        status: "error",
        error_category: lastErrorCategory,
        latency_ms: Date.now() - attemptStart,
      });
    }
  }

  clearTimeout(timeoutId);
  req.removeListener("close", onClientClose);
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  // ── All models failed ──
  if (!upstream) {
    const errorPayload = JSON.stringify({
      error: {
        message: lastError?.body ? `Upstream error: ${lastError.body.slice(0, 200)}` : "All models failed",
        type: "upstream_error",
        status: lastError?.status,
      },
    });
    if (headersSentEarly) {
      safeWrite(res, `data: ${errorPayload}\n\ndata: [DONE]\n\n`);
      res.end();
    } else {
      res.writeHead(lastError?.status ?? 502, { "Content-Type": "application/json" });
      res.end(errorPayload);
    }
    ctx.deduplicator.removeInflight(dedupKey);
    return;
  }

  // ── Debug headers ──
  if (debugMode && routingDecision) {
    const debugInfo = `profile=${routingProfile ?? "explicit"} tier=${routingDecision.tier} model=${actualModelUsed} confidence=${routingDecision.confidence.toFixed(2)} savings=${(routingDecision.savings * 100).toFixed(0)}%`;
    if (headersSentEarly) {
      safeWrite(res, `: x-clawrouter-debug ${debugInfo}\n\n`);
    }
  }

  // ── Stream response ──
  const contentType = upstream.headers.get("content-type") || "application/json";
  const isSSE = contentType.includes("text/event-stream");

  if (isStreaming && !headersSentEarly) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
  }

  let responseBody = "";

  if (isSSE) {
    // Stream SSE events
    const reader = upstream.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          responseBody += chunk;
          if (isStreaming && canWrite(res)) {
            safeWrite(res, chunk);
          }
        }
      } catch (err) {
        if (!globalController.signal.aborted) {
          console.error(`[ClawRouter] Stream read error: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    if (isStreaming && debugMode && canWrite(res)) {
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, estimatedInputTokens, maxTokens, routingProfile ?? undefined);
      const trace = buildStreamingTrace({
        requestId,
        routingProfile,
        routingDecision,
        parsedMessages,
        maxTokens,
        config: ctx.routerOpts.config,
        modelId,
        actualModelUsed,
        upstream: upstreamProviderUsed || getUpstream(actualModelUsed),
        modelsToTry,
        attempts,
        estimatedInputTokens,
        estimatedOutputTokens: maxTokens,
        costs,
      });
      safeWrite(res, `event: acu_trace\ndata: ${JSON.stringify(trace)}\n\n`);
    }

    // Ensure [DONE] is sent
    if (isStreaming && canWrite(res) && !responseBody.includes("[DONE]")) {
      safeWrite(res, "data: [DONE]\n\n");
    }
  } else {
    // Non-streaming: read full body
    const chunks: Uint8Array[] = [];
    const reader = upstream.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } catch { /* ignore */ }
    }
    responseBody = Buffer.concat(chunks).toString();

    if (!isStreaming) {
      let validator = validateAssistantOutput({
        messages: parsedMessages,
        assistantText: extractAssistantText(responseBody),
        responseFormat,
        expectedSchema,
      });
      let qualityFallbackUsed = false;

      if (validator.result === "fail" && routingDecision) {
        const qualityFallbackModel = selectQualityFallbackModel(
          routingDecision,
          ctx.routerOpts.config,
          actualModelUsed,
          attempts.map((attempt) => attempt.model),
        );
        if (qualityFallbackModel) {
          const qualityStart = Date.now();
          const qualityController = new AbortController();
          const qualityTimeout = setTimeout(() => qualityController.abort(), timeoutForModel(qualityFallbackModel));
          try {
            const { response, upstreamProvider } = await fetchUpstreamChatCompletion({
              body,
              model: qualityFallbackModel,
              apiKey: ctx.apiKey,
              proxyApiKey: ctx.proxyApiKey,
              proxyBaseUrl: ctx.proxyBaseUrl,
              signal: AbortSignal.any([globalController.signal, qualityController.signal]),
            });
            if (response.status === 200) {
              responseBody = await readResponseText(response);
              actualModelUsed = qualityFallbackModel;
              upstreamProviderUsed = upstreamProvider;
              qualityFallbackUsed = true;
              attempts.push({
                model: qualityFallbackModel,
                upstream: upstreamProvider,
                status: "success",
                latency_ms: Date.now() - qualityStart,
              });
              validator = validateAssistantOutput({
                messages: parsedMessages,
                assistantText: extractAssistantText(responseBody),
                responseFormat,
                expectedSchema,
              });
            } else {
              const errorBody = await response.text().catch(() => "");
              const category = categorizeError(response.status, errorBody) ?? "validation_fallback_error";
              lastErrorCategory = category;
              attempts.push({
                model: qualityFallbackModel,
                upstream: upstreamProvider,
                status: "error",
                error_category: category,
                latency_ms: Date.now() - qualityStart,
              });
            }
          } catch (err) {
            const category = qualityController.signal.aborted ? "timeout" : "validation_fallback_error";
            lastErrorCategory = category;
            attempts.push({
              model: qualityFallbackModel,
              upstream: "unknown",
              status: qualityController.signal.aborted ? "timeout" : "error",
              error_category: category,
              latency_ms: Date.now() - qualityStart,
            });
          } finally {
            clearTimeout(qualityTimeout);
          }
        }
      }

      const latencyMs = Date.now() - startTime;
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const usage = parseUsage(responseBody, estimatedInputTokens, maxTokens);
      let costEstimate = 0;
      let baselineCost = 0;
      let savings = 0;

      if (routingDecision) {
        if (actualModelUsed !== routingDecision.model) {
          const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, usage.inputTokens, usage.outputTokens, routingProfile ?? undefined);
          costEstimate = costs.costEstimate;
          baselineCost = costs.baselineCost;
          savings = costs.savings;
        } else {
          const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, usage.inputTokens, usage.outputTokens, routingProfile ?? undefined);
          costEstimate = costs.costEstimate;
          baselineCost = costs.baselineCost;
          savings = costs.savings;
        }
      } else {
        const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, usage.inputTokens, usage.outputTokens);
        costEstimate = costs.costEstimate;
        baselineCost = costs.baselineCost;
        savings = costs.savings;
      }

	      const fallbackUsed = getFallbackUsed(attempts, actualModelUsed, routingDecision?.model);
	      const trace: AcuTrace = {
        ...buildRuleTraceSignals(parsedMessages, maxTokens, ctx.routerOpts.config),
        request_id: requestId,
        profile: routingProfile ?? "explicit",
        tier: routingDecision?.tier ?? "EXPLICIT",
        confidence: routingDecision?.confidence ?? 1,
        method: routingDecision?.method ?? "explicit",
        ...(routingDecision?.agenticScore !== undefined && { agentic_score: routingDecision.agenticScore }),
        selected_model: routingDecision?.model ?? modelId,
        actual_model_used: actualModelUsed,
        upstream: upstreamProviderUsed || getUpstream(actualModelUsed),
	        fallback_chain: modelsToTry,
	        attempts,
	        attempt_count: attempts.length,
	        fallback_used: fallbackUsed,
	        quality_fallback_used: qualityFallbackUsed,
	        estimated_input_tokens: usage.inputTokens,
        estimated_output_tokens: usage.outputTokens,
        estimated_cost: costEstimate,
        baseline_model: DEFAULT_BASELINE_MODEL,
        baseline_cost: baselineCost,
        estimated_savings: savings,
	        route_reasoning: routingDecision?.reasoning ?? "Explicit model request",
	        validator_result: validator.result,
	        validator: validator.validator,
        ...(validator.result !== "not_applicable" && { validator_pass: validator.result === "pass" }),
        validator_reason: validator.reason ?? "not_applicable",
      };

      if (debugMode) responseBody = injectTraceIntoJsonResponse(responseBody, trace);

      const ledgerEntry: AcuLedgerEntry = {
        request_id: requestId,
        timestamp: new Date().toISOString(),
        prompt_hash: hashPrompt(parsedMessages),
        task_type: detectTaskType(parsedMessages),
        profile: trace.profile,
        tier: trace.tier,
        method: trace.method,
        selected_model: trace.selected_model,
        actual_model_used: actualModelUsed,
        upstream: trace.upstream,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        estimated_cost: costEstimate,
        actual_cost: costEstimate,
        baseline_model: DEFAULT_BASELINE_MODEL,
        baseline_cost: baselineCost,
        savings: baselineCost - costEstimate,
	        latency_ms: latencyMs,
	        fallback_attempts: Math.max(0, attempts.length - 1),
	        fallback_used: fallbackUsed,
	        quality_fallback_used: qualityFallbackUsed,
	        validator_result: validator.result,
        ...(validator.qualityScore !== undefined && { quality_score: validator.qualityScore }),
        cache_hit: false,
        ...(lastErrorCategory && { error_category: lastErrorCategory }),
      };
      await appendLedgerEntry(ledgerEntry);
    }

    if (isStreaming && canWrite(res)) {
      // Convert non-streaming response to SSE format
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(responseBody) as Record<string, unknown>;
      } catch {
        const errorPayload = JSON.stringify({
          error: {
            message: "Upstream response could not be parsed",
            type: "proxy_error",
          },
        });
        safeWrite(res, `data: ${errorPayload}\n\ndata: [DONE]\n\n`);
        res.end();
        ctx.deduplicator.removeInflight(dedupKey);
        return;
      }
      const chunk = {
        id: parsed.id || `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: parsed.created || Math.floor(Date.now() / 1000),
        model: parsed.model || actualModelUsed,
        choices: Array.isArray(parsed.choices) ? parsed.choices.map((c: Record<string, unknown>, idx: number) => ({
          index: idx,
          delta: { role: "assistant", content: (c.message as Record<string, unknown>)?.content || "" },
          finish_reason: null,
        })) : [],
      };
      safeWrite(res, `data: ${JSON.stringify(chunk)}\n\n`);

      // Send finish chunk
      const finishChunk = { ...chunk, choices: chunk.choices.map((c: Record<string, unknown>) => ({ ...c, delta: {}, finish_reason: "stop" })) };
      safeWrite(res, `data: ${JSON.stringify(finishChunk)}\n\n`);
      if (debugMode) {
        const estimatedInputTokens = Math.ceil(body.length / 4);
        const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, estimatedInputTokens, maxTokens, routingProfile ?? undefined);
        const trace = buildStreamingTrace({
          requestId,
          routingProfile,
          routingDecision,
          parsedMessages,
          maxTokens,
          config: ctx.routerOpts.config,
          modelId,
          actualModelUsed,
          upstream: upstreamProviderUsed || getUpstream(actualModelUsed),
          modelsToTry,
          attempts,
          estimatedInputTokens,
          estimatedOutputTokens: maxTokens,
          costs,
        });
        safeWrite(res, `event: acu_trace\ndata: ${JSON.stringify(trace)}\n\n`);
      }
      safeWrite(res, "data: [DONE]\n\n");
    } else if (!isStreaming) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(responseBody);
    }
  }

  if (isStreaming && canWrite(res)) {
    res.end();
  }

  // ── Logging ──
  const latencyMs = Date.now() - startTime;
  const estimatedInputTokens = Math.ceil(body.length / 4);
  let costEstimate = 0;
  let baselineCost = 0;
  let savings = 0;

  if (routingDecision) {
    if (actualModelUsed !== routingDecision.model) {
      const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, estimatedInputTokens, maxTokens, routingProfile ?? undefined);
      costEstimate = costs.costEstimate;
      baselineCost = costs.baselineCost;
      savings = costs.savings;
    } else {
      costEstimate = routingDecision.costEstimate;
      baselineCost = routingDecision.baselineCost;
      savings = routingDecision.savings;
    }
  }

  logUsage({
    timestamp: new Date().toISOString(),
    model: actualModelUsed,
    tier: routingDecision?.tier ?? "EXPLICIT",
    cost: costEstimate,
    baselineCost,
    savings,
    latencyMs,
  }).catch(() => {});

  // Cache response
  if (allowResponseCache && responseBody && responseBody.length < 1_048_576) {
    ctx.responseCache.set(dedupKey, { body: Buffer.from(responseBody), status: 200, headers: { "Content-Type": contentType }, model: actualModelUsed });
  }

  // Complete dedup
  ctx.deduplicator.complete(dedupKey, {
    status: 200,
    headers: { "Content-Type": contentType },
    body: Buffer.from(responseBody),
    completedAt: Date.now(),
  });

  console.log(`[ClawRouter] ${actualModelUsed} → ${latencyMs}ms ($${costEstimate.toFixed(4)})`);
}

/**
 * Get the configured proxy port.
 */
export function getProxyPort(): number {
  return PROXY_PORT;
}
