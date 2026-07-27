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
import {
  AcuDemoStrategy,
  hashSession,
  openAcuRoutingStore,
  publicCatalogPayload,
  getAcuModel,
  recommendModel,
  serializeVisibleContext,
  estimateVisibleTokens,
  readAcuRuntimeConfig,
  executionProfileFor,
  type AcuEvaluation,
  type AcuRuntimeConfig,
  type AcuVisibleMessage,
  type AcuRoutingStore,
  type ExecutionProfileHealth,
} from "./acu/index.js";

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
const ACU_PREFIX_PATTERN = /^\/acu-router(?:-dev)?(?=\/|\?|$)/;
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

function timeoutForAttempt(modelId: string, attemptIndex: number, acuSelected: boolean, maxTokens: number): number {
  const configured = Number(process.env.ACU_FIRST_ATTEMPT_TIMEOUT_MS);
  const isDevConfigured = Number.isFinite(configured) && configured > 0;
  if (isDevConfigured && acuSelected && attemptIndex === 0 && !isReasoningModel(modelId) && maxTokens <= 1200) {
    return Math.min(timeoutForModel(modelId), configured);
  }
  return timeoutForModel(modelId);
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
  billed_cost?: number;
  usage_source?: "upstream_usage" | "upstream_cost" | "response_text_estimate" | "max_token_estimate";
  attempt_type: "initial" | "fallback" | "format_repair" | "quality_upgrade";
  execution_profile_id: string;
  thinking_mode: "disabled" | "enabled" | "default";
  request_parameter_applied: boolean;
  upstream_model?: string;
  reasoning_tokens?: number;
};

type UsageSource = "upstream_usage" | "upstream_cost" | "response_text_estimate" | "max_token_estimate";

type UsageAudit = {
  inputTokens: number;
  visibleOutputTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  usageSource: UsageSource;
  usageRawKeys: string[];
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  modelCallCost: number;
};

type LatencyBreakdown = {
  judge_latency_ms: number;
  route_compute_latency_ms: number;
  upstream_latency_ms: number;
  validator_latency_ms: number;
  fallback_latency_ms: number;
  total_router_latency_ms: number;
};

function attemptProfileFields(
  modelId: string,
  requestBody: Buffer,
  attemptType: AcuAttemptTrace["attempt_type"],
): Pick<AcuAttemptTrace, "attempt_type" | "execution_profile_id" | "thinking_mode" | "request_parameter_applied" | "upstream_model"> {
  let enableThinking: unknown;
  try {
    enableThinking = (JSON.parse(requestBody.toString()) as Record<string, unknown>).enable_thinking;
  } catch { /* malformed requests are handled by the upstream path */ }
  const profile = executionProfileFor(modelId, enableThinking);
  return {
    attempt_type: attemptType,
    execution_profile_id: profile.executionProfileId,
    thinking_mode: profile.thinkingMode,
    request_parameter_applied: profile.requestParameterApplied,
    upstream_model: modelId,
  };
}

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
  quality_review_required?: boolean;
  format_repair_used?: boolean;
  format_repair_succeeded?: boolean;
  execution_profile_id?: string;
  thinking_mode?: "disabled" | "enabled" | "default";
  request_parameter_applied?: boolean;
  upstream_model?: string;
  streaming?: boolean;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost: number;
  baseline_model: string;
  baseline_cost: number;
  estimated_savings: number;
  usage_audit?: UsageAudit;
  cost_audit?: {
    judge_cost: number;
    model_call_cost: number;
    failed_attempt_cost: number;
    total_acu_cost: number;
  };
  latency_breakdown?: LatencyBreakdown;
  route_reasoning: string;
  validator_result: ValidatorResult["result"];
  validator: ValidatorResult["validator"];
  validator_pass?: boolean;
  validator_reason?: string;
  acu_demo?: AcuEvaluation;
};

type AcuPlanCandidate = AcuEvaluation["recommendation"]["estimates"][number] & {
  routingEligible: true;
  healthStatus: ExecutionProfileHealth["availability"];
  healthPriorityPenalty: number;
  p50LatencyMs: number | null;
  evidenceConfidence: "low" | "medium" | "high";
  executionProfileId: string;
  thinkingMode: "disabled" | "enabled" | "default";
  requestParameterApplied: boolean;
};

type AcuPlanRecord = {
  evaluation: AcuEvaluation;
  createdAt: number;
  expiresAt: number;
  contextSha256: string;
  qualityTarget: number;
  expectedOutputTokens: number;
  qualityCeilingModel: AcuPlanCandidate;
  displayCandidates: AcuPlanCandidate[];
};

const ACU_PLAN_TTL_MS = 5 * 60_000;
const ACU_PLAN_MAX_ENTRIES = 100;

function stripAcuPrefix(url: string | undefined): string {
  if (!url) return "/";
  const match = url.match(ACU_PREFIX_PATTERN);
  if (!match) return url;
  const stripped = url.slice(match[0].length);
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
    || pathname === "/acu"
    || pathname === "/acu/"
    || pathname.startsWith("/acu/")
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

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function messageContentAsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

function routingTierFromAcu(evaluation: AcuEvaluation): Tier {
  const values: Array<[number, Tier]> = [
    [evaluation.judge.pLow, "SIMPLE"],
    [evaluation.judge.pMid, "MEDIUM"],
    [evaluation.judge.pMidHigh, "COMPLEX"],
    [evaluation.judge.pHigh, "REASONING"],
  ];
  return values.reduce((best, current) => current[0] > best[0] ? current : best)[1];
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

function finiteNonNegative(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function extractExplicitUpstreamCost(responseBody: string): number | undefined {
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage as Record<string, unknown> : undefined;
    return finiteNonNegative(usage?.cost) ?? finiteNonNegative(usage?.total_cost)
      ?? finiteNonNegative(parsed.cost) ?? finiteNonNegative(parsed.provider_cost);
  } catch {
    return undefined;
  }
}

function parseUsage(
  responseBody: string,
  estimatedInputTokens: number,
  maxOutputTokens: number,
  pricing?: ModelPricing,
): UsageAudit {
  const inputPrice = pricing?.inputPrice ?? 0;
  const outputPrice = pricing?.outputPrice ?? 0;
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    const usage = parsed.usage && typeof parsed.usage === "object"
      ? parsed.usage as Record<string, unknown> : undefined;
    const details = usage?.completion_tokens_details && typeof usage.completion_tokens_details === "object"
      ? usage.completion_tokens_details as Record<string, unknown> : undefined;
    const promptDetails = usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? usage.prompt_tokens_details as Record<string, unknown> : undefined;
    const inputTokens = finiteNonNegative(usage?.prompt_tokens)
      ?? finiteNonNegative(usage?.input_tokens) ?? estimatedInputTokens;
    const upstreamCompletion = finiteNonNegative(usage?.completion_tokens)
      ?? finiteNonNegative(usage?.output_tokens);
    const reasoningTokens = finiteNonNegative(details?.reasoning_tokens)
      ?? finiteNonNegative(usage?.reasoning_tokens) ?? 0;
    const cachedInputTokens = finiteNonNegative(promptDetails?.cached_tokens)
      ?? finiteNonNegative(usage?.cached_input_tokens) ?? 0;
    const assistantText = extractAssistantText(responseBody);
    const visibleOutputTokens = assistantText.length > 0 ? Math.max(1, Math.ceil(assistantText.length / 4)) : 0;
    const explicitCost = finiteNonNegative(usage?.cost)
      ?? finiteNonNegative(usage?.total_cost)
      ?? finiteNonNegative(parsed.cost)
      ?? finiteNonNegative(parsed.provider_cost);
    const hasUsage = Boolean(usage && (
      upstreamCompletion !== undefined
      || finiteNonNegative(usage.prompt_tokens) !== undefined
      || finiteNonNegative(usage.input_tokens) !== undefined
    ));
    const completionTokens = upstreamCompletion
      ?? (visibleOutputTokens > 0 ? visibleOutputTokens : maxOutputTokens);
    const usageSource: UsageSource = explicitCost !== undefined
      ? "upstream_cost"
      : hasUsage ? "upstream_usage"
        : visibleOutputTokens > 0 ? "response_text_estimate" : "max_token_estimate";
    const calculatedCost = (inputTokens * inputPrice + completionTokens * outputPrice) / 1_000_000;
    return {
      inputTokens,
      visibleOutputTokens,
      completionTokens,
      reasoningTokens,
      cachedInputTokens,
      usageSource,
      usageRawKeys: usage ? [
        ...Object.keys(usage),
        ...Object.keys(details ?? {}).map((key) => `completion_tokens_details.${key}`),
        ...Object.keys(promptDetails ?? {}).map((key) => `prompt_tokens_details.${key}`),
      ].sort() : [],
      inputPricePerMillion: inputPrice,
      outputPricePerMillion: outputPrice,
      modelCallCost: explicitCost ?? calculatedCost,
    };
  } catch {
    return {
      inputTokens: estimatedInputTokens,
      visibleOutputTokens: 0,
      completionTokens: maxOutputTokens,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      usageSource: "max_token_estimate",
      usageRawKeys: [],
      inputPricePerMillion: inputPrice,
      outputPricePerMillion: outputPrice,
      modelCallCost: (estimatedInputTokens * inputPrice + maxOutputTokens * outputPrice) / 1_000_000,
    };
  }
}

function getFallbackUsed(attempts: AcuAttemptTrace[], actualModelUsed: string, selectedModel?: string): boolean {
  return attempts.some((attempt) => attempt.attempt_type === "fallback" || attempt.attempt_type === "quality_upgrade")
    || Boolean(selectedModel && selectedModel !== actualModelUsed);
}

function setAcuExecutionResult(
  evaluation: AcuEvaluation,
  recommendationSelected: boolean,
  actualModel: string,
): void {
  evaluation.actualModel = actualModel;
  evaluation.recommendationApplied = recommendationSelected
    && actualModel === evaluation.recommendation.recommended.modelId;
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
  const finalAttempt = [...args.attempts].reverse().find((attempt) => attempt.model === args.actualModelUsed && attempt.status === "success");
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
    execution_profile_id: finalAttempt?.execution_profile_id,
    thinking_mode: finalAttempt?.thinking_mode,
    request_parameter_applied: finalAttempt?.request_parameter_applied,
    upstream_model: finalAttempt?.upstream_model ?? args.actualModelUsed,
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

const QUALITY_FALLBACK_CONSERVATIVE_TOLERANCE_POINTS = 1;

function executionHealthForModel(store: AcuRoutingStore | null | undefined, modelId: string): ExecutionProfileHealth | undefined {
  if (!store) return undefined;
  const profile = executionProfileFor(modelId, modelId === "qwen3.6-plus" ? false : undefined);
  return store.getExecutionProfileHealth(profile.executionProfileId);
}

function applyPassiveHealthAvailability(modelIds: string[], store: AcuRoutingStore | null | undefined): string[] {
  if (!store) return modelIds;
  const assessed = modelIds.map((modelId) => ({ modelId, health: executionHealthForModel(store, modelId) }));
  const healthy = assessed.filter(({ health }) => health?.availability === "healthy" || health?.availability === "unknown");
  if (healthy.length > 0) return healthy.map(({ modelId }) => modelId);
  const degraded = assessed.filter(({ health }) => health?.availability === "degraded");
  if (degraded.length > 0) return degraded.map(({ modelId }) => modelId);
  return modelIds;
}

function executionProfileForDifficulty(modelId: string, difficultyScore: number) {
  return executionProfileFor(modelId, modelId === "qwen3.6-plus" && difficultyScore < 55 ? false : undefined);
}

function compatibleAcuModelIds(args: {
  store: AcuRoutingStore | null;
  excludeList: Set<string>;
  hasTools: boolean;
  hasVision: boolean;
  requiredContextTokens: number;
  includeCooldown?: boolean;
}): string[] {
  return BLOCKRUN_MODELS.filter((model) => {
    const catalogModel = getAcuModel(model.id);
    if (!catalogModel?.routingEligible || args.excludeList.has(model.id)) return false;
    if (args.hasTools && !modelSupportsToolCalling(model.id)) return false;
    if (args.hasVision && !modelSupportsVision(model.id)) return false;
    const contextWindow = getModelContextWindow(model.id);
    if (contextWindow === undefined || contextWindow < args.requiredContextTokens) return false;
    const health = executionHealthForModel(args.store, model.id);
    return args.includeCooldown || health?.availability !== "cooldown";
  }).map((model) => model.id);
}

function healthRank(status: ExecutionProfileHealth["availability"]): number {
  return ({ healthy: 0, unknown: 1, degraded: 2, cooldown: 3 } as const)[status];
}

function evidenceRank(confidence: "low" | "medium" | "high"): number {
  return ({ high: 0, medium: 1, low: 2 } as const)[confidence];
}

function decoratePlanCandidate(
  estimate: AcuEvaluation["recommendation"]["estimates"][number],
  difficultyScore: number,
  store: AcuRoutingStore | null,
): AcuPlanCandidate {
  const model = getAcuModel(estimate.modelId)!;
  const health = executionHealthForModel(store, estimate.modelId);
  const profile = executionProfileForDifficulty(estimate.modelId, difficultyScore);
  return {
    ...estimate,
    routingEligible: true,
    healthStatus: health?.availability ?? "unknown",
    healthPriorityPenalty: health?.priorityPenalty ?? 0,
    p50LatencyMs: health?.p50LatencyMs ?? null,
    evidenceConfidence: model.evidenceConfidence,
    ...profile,
  };
}

function qualityCeilingCandidate(candidates: AcuPlanCandidate[]): AcuPlanCandidate {
  if (candidates.length === 0) throw new Error("No compatible ACU quality-ceiling candidate");
  return [...candidates].sort((left, right) => {
    const displayedScoreDifference = Number(right.predictedScore.toFixed(1)) - Number(left.predictedScore.toFixed(1));
    return displayedScoreDifference
      || right.conservativeScore - left.conservativeScore
      || healthRank(left.healthStatus) - healthRank(right.healthStatus)
      || (left.p50LatencyMs ?? Number.POSITIVE_INFINITY) - (right.p50LatencyMs ?? Number.POSITIVE_INFINITY)
      || evidenceRank(left.evidenceConfidence) - evidenceRank(right.evidenceConfidence)
      || left.modelId.localeCompare(right.modelId);
  })[0];
}

function buildPlanRecord(args: {
  evaluation: AcuEvaluation;
  allCompatibleModelIds: string[];
  expectedOutputTokens: number;
  store: AcuRoutingStore | null;
}): AcuPlanRecord {
  const displayRecommendation = recommendModel({
    probabilities: args.evaluation.judge,
    difficultyScore: args.evaluation.difficultyScore,
    inputTokens: args.evaluation.contextTokenEstimate,
    expectedOutputTokens: args.expectedOutputTokens,
    judgeCost: args.evaluation.judgeCost,
    qualityTarget: args.evaluation.qualityTarget,
    eligibleModelIds: args.allCompatibleModelIds,
  });
  const displayCandidates = displayRecommendation.estimates.map((estimate) => (
    decoratePlanCandidate(estimate, args.evaluation.difficultyScore, args.store)
  ));
  const now = Date.now();
  return {
    evaluation: args.evaluation,
    createdAt: now,
    expiresAt: now + ACU_PLAN_TTL_MS,
    contextSha256: args.evaluation.contextSha256,
    qualityTarget: args.evaluation.qualityTarget,
    expectedOutputTokens: args.expectedOutputTokens,
    qualityCeilingModel: qualityCeilingCandidate(displayCandidates),
    displayCandidates,
  };
}

function pruneAcuPlans(plans: Map<string, AcuPlanRecord>): void {
  const now = Date.now();
  for (const [planId, plan] of plans) if (plan.expiresAt <= now) plans.delete(planId);
  while (plans.size >= ACU_PLAN_MAX_ENTRIES) plans.delete(plans.keys().next().value as string);
}

function selectQualityFallbackModel(args: {
  evaluation: AcuEvaluation | undefined;
  currentModel: string;
  modelsTried: string[];
  store?: AcuRoutingStore | null;
  hasTools: boolean;
  hasVision: boolean;
  requiredContextTokens: number;
}): string | undefined {
  if (!args.evaluation) return undefined;
  const current = args.evaluation.recommendation.estimates.find((estimate) => estimate.modelId === args.currentModel);
  if (!current) return undefined;
  const compatible = args.evaluation.recommendation.estimates.filter((estimate) => {
    const model = getAcuModel(estimate.modelId);
    return Boolean(model?.routingEligible)
      && !args.modelsTried.includes(estimate.modelId)
      && (!args.hasTools || model?.toolCallSupport)
      && (!args.hasVision || model?.visionSupport)
      && (model?.contextWindow === null || (model?.contextWindow ?? 0) >= args.requiredContextTokens)
      && estimate.predictedScore >= current.predictedScore
      && estimate.conservativeScore >= current.conservativeScore - QUALITY_FALLBACK_CONSERVATIVE_TOLERANCE_POINTS;
  }).map((estimate) => ({ estimate, health: executionHealthForModel(args.store, estimate.modelId) }));
  if (compatible.length === 0) return undefined;
  const available = compatible.filter(({ health }) => health?.availability !== "cooldown");
  const pool = available.length > 0 ? available : compatible;
  return pool.sort((left, right) => (
    right.estimate.predictedScore - left.estimate.predictedScore
    || (left.health?.priorityPenalty ?? 0) - (right.health?.priorityPenalty ?? 0)
    || left.estimate.estimatedCallCost - right.estimate.estimatedCallCost
    || (left.health?.p50LatencyMs ?? Number.POSITIVE_INFINITY) - (right.health?.p50LatencyMs ?? Number.POSITIVE_INFINITY)
  ))[0]?.estimate.modelId;
}

function buildFormatRepairBody(body: Buffer, validator: ValidatorResult, maxTokens: number): Buffer {
  const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
  const messages = Array.isArray(parsed.messages) ? [...parsed.messages] : [];
  messages.push({
    role: "user",
    content: `上一条响应未通过${validator.validator === "schema_validator" ? "Schema" : "JSON"}格式校验（${validator.reason ?? "格式无效"}）。只修复格式，不重新扩写内容；只返回目标格式，不要附加说明。`,
  });
  parsed.messages = messages;
  parsed.stream = false;
  parsed.enable_thinking = false;
  parsed.max_tokens = Math.min(384, Math.max(64, maxTokens));
  delete parsed.max_completion_tokens;
  return Buffer.from(JSON.stringify(parsed));
}

function upstreamModelFromBody(responseBody: string, fallback: string): string {
  try {
    const model = (JSON.parse(responseBody) as { model?: unknown }).model;
    return typeof model === "string" && model ? model : fallback;
  } catch {
    return fallback;
  }
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
  acuRuntimeConfig?: Partial<AcuRuntimeConfig>;
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
  for (const key of ["baseline_model", "cache", "expected_schema", "acu_quality_target", "acu_execute_recommended", "acu_plan_id"]) {
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
  const acuStrategy = new AcuDemoStrategy(readAcuRuntimeConfig(options.acuRuntimeConfig));
  const acuStore = acuStrategy.enabled ? openAcuRoutingStore(acuStrategy.databasePath) : null;
  const acuPlans = new Map<string, AcuPlanRecord>();

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
        acuStrategy, acuStore, acuPlans,
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
    close: () => new Promise((resolve) => server.close(() => { acuStore?.close(); resolve(); })),
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
    acuStrategy: AcuDemoStrategy;
    acuStore: AcuRoutingStore | null;
    acuPlans: Map<string, AcuPlanRecord>;
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

  // ── Phase 2A ACU catalog and request evaluation ──
  if (pathname === "/acu/api/catalog" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(publicCatalogPayload()));
    return;
  }
  if (pathname === "/acu/api/data-summary" && req.method === "GET") {
    const summary = ctx.acuStore?.summary() ?? {
      generatedAt: new Date().toISOString(),
      realRequestCount: 0,
      sampleNotice: "当前样本量较小，仅用于产品验证。",
      storageStatus: "unavailable",
    };
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(summary));
    return;
  }
  if (pathname === "/acu/api/feedback" && req.method === "POST") {
    try {
      if (!ctx.acuStore) throw new Error("ACU data store is unavailable");
      const parsed = await readJsonRequest(req);
      const requestId = String(parsed.request_id ?? "");
      if (!requestId) throw new Error("request_id is required");
      ctx.acuStore.recordFeedback({
        requestId,
        accepted: typeof parsed.accepted === "boolean" ? parsed.accepted : undefined,
        rating: parsed.rating === undefined ? undefined : Number(parsed.rating),
        requiredUpgrade: typeof parsed.required_upgrade === "boolean" ? parsed.required_upgrade : undefined,
        finalModel: typeof parsed.final_model === "string" ? parsed.final_model : undefined,
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ saved: true, request_id: requestId }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "feedback rejected" } }));
    }
    return;
  }
  if (pathname === "/acu/api/outcome" && req.method === "POST") {
    try {
      if (!ctx.acuStore) throw new Error("ACU data store is unavailable");
      const parsed = await readJsonRequest(req);
      const source = String(parsed.outcome_source ?? "");
      if (!new Set(["validator", "test_result", "retry_signal", "model_upgrade_signal"]).has(source)) {
        throw new Error("invalid outcome_source");
      }
      ctx.acuStore.recordOutcome({
        requestId: String(parsed.request_id ?? ""),
        outcomeSource: source as "validator" | "test_result" | "retry_signal" | "model_upgrade_signal",
        validatorResult: typeof parsed.validator_result === "string" ? parsed.validator_result : undefined,
        testResult: typeof parsed.test_result === "string" ? parsed.test_result : undefined,
        toolErrorCount: parsed.tool_error_count === undefined ? undefined : Number(parsed.tool_error_count),
        retryCount: parsed.retry_count === undefined ? undefined : Number(parsed.retry_count),
        modelSwitched: typeof parsed.model_switched === "boolean" ? parsed.model_switched : undefined,
        userRetried: typeof parsed.user_retried === "boolean" ? parsed.user_retried : undefined,
        outcomeScore: parsed.outcome_score === undefined ? undefined : Number(parsed.outcome_score),
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ saved: true }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "outcome rejected" } }));
    }
    return;
  }
  if (pathname === "/acu/api/plan" && req.method === "POST") {
    try {
      const parsed = await readJsonRequest(req);
      const messages = Array.isArray(parsed.messages) ? parsed.messages as AcuVisibleMessage[] : [];
      if (messages.length === 0) throw new Error("messages must contain at least one visible API message");
      const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
      const expectedOutputTokens = Number(parsed.expected_output_tokens ?? 800);
      const qualityTarget = Number(parsed.quality_target ?? 0.8);
      if (!Number.isFinite(expectedOutputTokens) || expectedOutputTokens <= 0) throw new Error("expected_output_tokens must be positive");
      if (!Number.isFinite(qualityTarget) || qualityTarget < 0 || qualityTarget > 1) throw new Error("quality_target must be between 0 and 1");
      const requireTools = tools.length > 0;
      const requireVision = messages.some((message) => Array.isArray(message.content)
        && message.content.some((part) => Boolean(part && typeof part === "object" && (part as { type?: string }).type === "image_url")));
      const visible = serializeVisibleContext(messages, tools);
      const requiredContextTokens = estimateVisibleTokens(visible) + expectedOutputTokens;
      const allCompatibleModelIds = compatibleAcuModelIds({
        store: ctx.acuStore, excludeList: ctx.excludeList, hasTools: requireTools,
        hasVision: requireVision, requiredContextTokens,
      });
      const eligibleModelIds = applyPassiveHealthAvailability(allCompatibleModelIds, ctx.acuStore);
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const system = messages.find((message) => message.role === "system");
      const rulesDecision = route(
        messageContentAsText(lastUser?.content), messageContentAsText(system?.content) || undefined,
        expectedOutputTokens, { ...ctx.routerOpts, routingProfile: "auto", hasTools: requireTools },
      );
      const evaluation = await ctx.acuStrategy.evaluate({
        messages, tools, qualityTarget, expectedOutputTokens, eligibleModelIds,
        requireToolCallSupport: requireTools, requireVisionSupport: requireVision,
        requestId: randomUUID(), requestedModel: "planning_only",
      }, rulesDecision);
      const plan = buildPlanRecord({ evaluation, allCompatibleModelIds, expectedOutputTokens, store: ctx.acuStore });
      pruneAcuPlans(ctx.acuPlans);
      const planId = randomUUID();
      ctx.acuPlans.set(planId, plan);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        ...evaluation,
        planId,
        planExpiresAt: new Date(plan.expiresAt).toISOString(),
        qualityCeilingModel: plan.qualityCeilingModel,
        displayCandidates: plan.displayCandidates,
        planningOnly: true,
        databaseWrites: 0,
      }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "acu_plan_error", message: error instanceof Error ? error.message : "Invalid ACU plan request" } }));
    }
    return;
  }
  if (pathname === "/acu/api/evaluate" && req.method === "POST") {
    try {
      const parsed = await readJsonRequest(req);
      const messages = Array.isArray(parsed.messages) ? parsed.messages as AcuVisibleMessage[] : [];
      if (messages.length === 0) throw new Error("messages must contain at least one visible API message");
      const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const system = messages.find((message) => message.role === "system");
      const expectedOutputTokens = Number(parsed.expected_output_tokens ?? 800);
      const qualityTarget = Number(parsed.quality_target ?? 0.8);
      const forceJudgeRefresh = parsed.force_judge_refresh === true;
      if (forceJudgeRefresh && !ctx.acuStrategy.allowForceRefresh) throw new Error("force_judge_refresh is disabled");
      const requireTools = tools.length > 0;
      const requireVision = messages.some((message) => Array.isArray(message.content)
        && message.content.some((part) => Boolean(part && typeof part === "object" && (part as { type?: string }).type === "image_url")));
      const rulesDecision = route(
        messageContentAsText(lastUser?.content),
        messageContentAsText(system?.content) || undefined,
        Number.isFinite(expectedOutputTokens) ? expectedOutputTokens : 800,
        { ...ctx.routerOpts, routingProfile: "auto", hasTools: requireTools },
      );
      const eligibleModelIds = applyPassiveHealthAvailability(BLOCKRUN_MODELS.filter((model) => (
        !ctx.excludeList.has(model.id)
        && (!requireTools || modelSupportsToolCalling(model.id))
        && (!requireVision || modelSupportsVision(model.id))
      )).map((model) => model.id), ctx.acuStore);
      const evaluation = await ctx.acuStrategy.evaluate({
        messages,
        tools,
        qualityTarget: Number.isFinite(qualityTarget) ? qualityTarget : 0.8,
        expectedOutputTokens: Number.isFinite(expectedOutputTokens) ? expectedOutputTokens : 800,
        eligibleModelIds,
        requireToolCallSupport: requireTools,
        requireVisionSupport: requireVision,
        forceJudgeRefresh,
        requestId: randomUUID(),
        requestedModel: typeof parsed.model === "string" ? parsed.model : "evaluation_only",
      }, rulesDecision);
      try {
        ctx.acuStore?.recordEvaluation(evaluation, {
          requestedModel: typeof parsed.model === "string" ? parsed.model : "evaluation_only",
          finalStatus: "evaluated_only",
          hadTools: requireTools,
        });
      } catch (error) {
        console.error(`[ClawRouter] ACU SQLite evaluation write failed: ${error instanceof Error ? error.message : "unknown"}`);
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(evaluation));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "acu_evaluation_error", message: error instanceof Error ? error.message : "Invalid ACU request" } }));
    }
    return;
  }
  if (pathname === "/acu/curves" && req.method === "GET") {
    res.writeHead(308, { Location: "curves/" });
    res.end();
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
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/acu" || pathname === "/acu/" || pathname === "/acu-debug" || pathname === "/acu-debug/" || pathname === "/acu/curves" || pathname === "/acu/curves/" || pathname.startsWith("/public/") || pathname.startsWith("/acu/public/") || pathname.startsWith("/acu-debug/public/"))) {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const publicDir = join(__dirname, "..", "public");
    const filePath = pathname === "/" || pathname === "/index.html" || pathname === "/acu" || pathname === "/acu/"
      ? join(publicDir, "index.html")
      : pathname === "/acu-debug" || pathname === "/acu-debug/"
        ? join(publicDir, "acu.html")
      : pathname === "/acu/curves" || pathname === "/acu/curves/"
        ? join(publicDir, "acu-curves.html")
      : join(publicDir, pathname.replace(/^\/acu-debug\/public\//, "").replace(/^\/acu\/public\//, "").replace(/^\/public\//, ""));
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
  let acuEvaluation: AcuEvaluation | undefined;
  let acuRecommendationSelected = false;
  let hasTools = false;
  let hasVision = false;
  let bodyModified = false;
  const sessionId = getSessionId(req.headers as Record<string, string | string[] | undefined>);
  let effectiveSessionId: string | undefined = sessionId;
  const parsedMessages: ChatMessage[] = [];
  let responseFormat: unknown;
  let expectedSchema: unknown;
  let acuQualityTarget = 0.8;
  let acuPlanId: string | undefined;
  let executeAcuRecommended: boolean;
  let routeComputeLatencyMs = 0;

  try {
    const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
    isStreaming = parsed.stream === true;
    modelId = (parsed.model as string) || "";
    maxTokens = (parsed.max_tokens as number) || 4096;
    responseFormat = parsed.response_format;
    expectedSchema = parsed.expected_schema;
    const requestedQualityTarget = Number(parsed.acu_quality_target);
    if (Number.isFinite(requestedQualityTarget)) acuQualityTarget = requestedQualityTarget;
    acuPlanId = typeof parsed.acu_plan_id === "string" ? parsed.acu_plan_id : undefined;
    executeAcuRecommended = parsed.acu_execute_recommended === true;
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
      const prompt = messageContentAsText(lastUserMsg?.content);
      const systemMsg = messages.find((m) => m.role === "system");
      const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : undefined;

      // Session persistence
      effectiveSessionId = sessionId ?? deriveSessionId(messages);
      const existingSession = effectiveSessionId ? ctx.sessionStore.getSession(effectiveSessionId) : undefined;

      const rulesDecision = route(prompt, systemPrompt, maxTokens, {
        ...ctx.routerOpts,
        routingProfile: routingProfile ?? undefined,
        hasTools,
      });
      routingDecision = rulesDecision;
      if (ctx.acuStrategy.enabled) {
        const acuRouteStart = Date.now();
        const tools = Array.isArray(parsed.tools) ? parsed.tools as unknown[] : [];
        const planned = acuPlanId ? ctx.acuPlans.get(acuPlanId) : undefined;
        const contextSha256 = createHash("sha256")
          .update(serializeVisibleContext(messages as AcuVisibleMessage[], tools)).digest("hex");
        if (planned
          && planned.expiresAt > Date.now()
          && planned.contextSha256 === contextSha256
          && Math.abs(planned.qualityTarget - acuQualityTarget) < 1e-9
          && planned.expectedOutputTokens === maxTokens) {
          acuEvaluation = structuredClone(planned.evaluation);
          acuEvaluation.requestId = requestId;
          ctx.acuPlans.delete(acuPlanId!);
        } else {
          if (acuPlanId) ctx.acuPlans.delete(acuPlanId);
          const requiredContextTokens = estimateVisibleTokens(serializeVisibleContext(messages as AcuVisibleMessage[], tools)) + maxTokens;
          const compatibleModelIds = compatibleAcuModelIds({
            store: ctx.acuStore, excludeList: ctx.excludeList, hasTools, hasVision, requiredContextTokens,
          });
          const eligibleModelIds = applyPassiveHealthAvailability(compatibleModelIds, ctx.acuStore);
          acuEvaluation = await ctx.acuStrategy.evaluate({
            messages: messages as AcuVisibleMessage[], tools, qualityTarget: acuQualityTarget,
            expectedOutputTokens: maxTokens, eligibleModelIds,
            requireToolCallSupport: hasTools, requireVisionSupport: hasVision,
            requestId, requestedModel: modelId, sessionHash: hashSession(effectiveSessionId),
          }, rulesDecision);
        }
        routeComputeLatencyMs = Math.max(0, Date.now() - acuRouteStart - acuEvaluation.judgeLatencyMs);
        try {
          ctx.acuStore?.recordEvaluation(acuEvaluation, {
            sessionHash: hashSession(effectiveSessionId),
            requestedModel: modelId,
            finalStatus: "routing_pending",
            hadTools: hasTools,
          });
        } catch (error) {
          console.error(`[ClawRouter] ACU SQLite routing write failed: ${error instanceof Error ? error.message : "unknown"}`);
        }
        if (acuEvaluation.judgeStatus !== "rules_fallback" && (!ctx.acuStrategy.shadowMode || executeAcuRecommended)) {
          const selected = acuEvaluation.recommendation.recommended;
          const fallback = acuEvaluation.recommendation.fallbackModel.modelId;
          const tier = routingTierFromAcu(acuEvaluation);
          const baseTiers = routingDecision.tierConfigs ?? ctx.routerOpts.config.tiers;
          const originalPrimary = baseTiers[tier].primary;
          const existingFallbacks = baseTiers[tier].fallback;
          routingDecision = {
            ...rulesDecision,
            model: selected.modelId,
            tier,
            confidence: acuEvaluation.judge.confidence,
            method: "llm",
            reasoning: `${acuEvaluation.judge.explanation} | ${acuEvaluation.recommendation.reason}`,
            costEstimate: selected.expectedTotalCost,
            baselineCost: acuEvaluation.recommendation.flagshipAlternative.estimatedCallCost,
            savings: selected.savingsPercentVsFlagship,
            tierConfigs: {
              ...baseTiers,
              [tier]: {
                primary: selected.modelId,
                fallback: [...new Set([fallback, originalPrimary, ...existingFallbacks])]
                  .filter((modelId) => modelId !== selected.modelId),
              },
            },
          };
          acuRecommendationSelected = true;
        }
      }

      if (acuRecommendationSelected) {
        modelId = routingDecision.model;
        parsed.model = modelId;
        if (modelId === "qwen3.6-plus" && acuEvaluation && acuEvaluation.difficultyScore < 55 && parsed.enable_thinking === undefined) {
          parsed.enable_thinking = false;
        }
        bodyModified = true;
        if (effectiveSessionId) {
          ctx.sessionStore.setSession(effectiveSessionId, routingDecision.model, routingDecision.tier);
        }
      } else if (existingSession?.userExplicit) {
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
  // Routed requests must produce a fresh trace/request_id and a distinct SQLite row.
  // The Judge has its own content-addressed cache, so disabling response caching here
  // does not add Judge cost for repeated contexts.
  const allowResponseCache = routingProfile === null && ctx.responseCache.shouldCache(body, requestHeaders);
  const respCached = allowResponseCache ? ctx.responseCache.get(dedupKey) : undefined;
  if (respCached) {
    const headers = { "Content-Type": "application/json", "X-Cache-Hit": "true" };
    res.writeHead(200, headers);
    res.end(respCached.body);
    const estimatedInputTokens = Math.ceil(body.length / 4);
    const usage = parseUsage(respCached.body.toString(), estimatedInputTokens, maxTokens, ctx.routerOpts.modelPricing.get(respCached.model));
    const costs = calculateModelCost(respCached.model, ctx.routerOpts.modelPricing, usage.inputTokens, usage.completionTokens, routingProfile ?? undefined);
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
      output_tokens: usage.completionTokens,
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
    if (acuEvaluation) {
      try {
        ctx.acuStore?.finalizeRequest(requestId, {
          actualModel: respCached.model, inputTokens: usage.inputTokens, outputTokens: usage.completionTokens,
          actualCost: 0, latencyMs: Date.now() - startTime, finalStatus: "response_cache_hit",
        });
      } catch { /* telemetry must not affect the response */ }
    }
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

    const perAttemptTimeout = timeoutForAttempt(tryModel, i, acuRecommendationSelected, maxTokens);
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
          ...attemptProfileFields(tryModel, body, i === 0 ? "initial" : "fallback"),
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
        ...attemptProfileFields(tryModel, body, i === 0 ? "initial" : "fallback"),
        model: tryModel,
        upstream: upstreamProvider,
        status: "error",
        error_category: lastErrorCategory,
        latency_ms: Date.now() - attemptStart,
        ...(extractExplicitUpstreamCost(errorBody) !== undefined && {
          billed_cost: extractExplicitUpstreamCost(errorBody), usage_source: "upstream_cost" as const,
        }),
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
          ...attemptProfileFields(tryModel, body, i === 0 ? "initial" : "fallback"),
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
          ...attemptProfileFields(tryModel, body, i === 0 ? "initial" : "fallback"),
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
        ...attemptProfileFields(tryModel, body, i === 0 ? "initial" : "fallback"),
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
    if (acuEvaluation) {
      try {
        ctx.acuStore?.recordAttempts(requestId, attempts);
        ctx.acuStore?.finalizeRequest(requestId, { finalStatus: "upstream_error", errorCategory: lastErrorCategory });
      }
      catch { /* telemetry must not affect the response */ }
    }
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
      if (acuEvaluation) {
        setAcuExecutionResult(acuEvaluation, acuRecommendationSelected, actualModelUsed);
        trace.acu_demo = acuEvaluation;
      }
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
      const initialValidatorStart = Date.now();
      let validator = validateAssistantOutput({
        messages: parsedMessages,
        assistantText: extractAssistantText(responseBody),
        responseFormat,
        expectedSchema,
      });
      let validatorLatencyMs = Date.now() - initialValidatorStart;
      let qualityFallbackUsed = false;
      let qualityReviewRequired = false;
      let formatRepairUsed = false;
      let formatRepairSucceeded = false;
      const originalResponseBody = responseBody;
      const originalModel = actualModelUsed;
      const originalProvider = upstreamProviderUsed;
      const originalAttempt = [...attempts].reverse().find((attempt) => attempt.model === originalModel && attempt.status === "success");
      const billAttempt = (attempt: AcuAttemptTrace | undefined, payload: string, model: string): void => {
        if (!attempt) return;
        const attemptUsage = parseUsage(payload, Math.ceil(body.length / 4), maxTokens, ctx.routerOpts.modelPricing.get(model));
        attempt.billed_cost = attemptUsage.modelCallCost;
        attempt.usage_source = attemptUsage.usageSource;
        attempt.reasoning_tokens = attemptUsage.reasoningTokens;
        attempt.upstream_model = upstreamModelFromBody(payload, model);
      };

      if (validator.result === "fail" && (validator.validator === "json_validator" || validator.validator === "schema_validator")) {
        formatRepairUsed = true;
        const repairBody = buildFormatRepairBody(body, validator, maxTokens);
        const repairStart = Date.now();
        const repairController = new AbortController();
        const repairTimeout = setTimeout(() => repairController.abort(), timeoutForModel(originalModel));
        try {
          const { response, upstreamProvider } = await fetchUpstreamChatCompletion({
            body: repairBody, model: originalModel, apiKey: ctx.apiKey,
            proxyApiKey: ctx.proxyApiKey, proxyBaseUrl: ctx.proxyBaseUrl,
            signal: AbortSignal.any([globalController.signal, repairController.signal]),
          });
          if (response.status === 200) {
            const repairedBody = await readResponseText(response);
            const repairAttempt: AcuAttemptTrace = {
              ...attemptProfileFields(originalModel, repairBody, "format_repair"),
              model: originalModel, upstream: upstreamProvider, status: "success", latency_ms: Date.now() - repairStart,
            };
            attempts.push(repairAttempt);
            const checkStart = Date.now();
            const repairedValidator = validateAssistantOutput({
              messages: parsedMessages, assistantText: extractAssistantText(repairedBody), responseFormat, expectedSchema,
            });
            validatorLatencyMs += Date.now() - checkStart;
            if (repairedValidator.result === "pass") {
              billAttempt(originalAttempt, originalResponseBody, originalModel);
              responseBody = repairedBody;
              validator = repairedValidator;
              upstreamProviderUsed = upstreamProvider;
              formatRepairSucceeded = true;
            } else {
              repairAttempt.status = "error";
              repairAttempt.error_category = "format_repair_validation_failed";
              billAttempt(repairAttempt, repairedBody, originalModel);
              validator = repairedValidator;
            }
          } else {
            const errorBody = await response.text().catch(() => "");
            const category = categorizeError(response.status, errorBody) ?? "format_repair_error";
            attempts.push({
              ...attemptProfileFields(originalModel, repairBody, "format_repair"),
              model: originalModel, upstream: upstreamProvider, status: "error", error_category: category,
              latency_ms: Date.now() - repairStart,
              ...(extractExplicitUpstreamCost(errorBody) !== undefined && {
                billed_cost: extractExplicitUpstreamCost(errorBody), usage_source: "upstream_cost" as const,
              }),
            });
          }
        } catch {
          const category = repairController.signal.aborted ? "timeout" : "format_repair_error";
          attempts.push({
            ...attemptProfileFields(originalModel, repairBody, "format_repair"),
            model: originalModel, upstream: "unknown", status: repairController.signal.aborted ? "timeout" : "error",
            error_category: category, latency_ms: Date.now() - repairStart,
          });
        } finally {
          clearTimeout(repairTimeout);
        }

        if (!formatRepairSucceeded) {
          const qualityFallbackModel = selectQualityFallbackModel({
            evaluation: acuEvaluation, currentModel: originalModel,
            modelsTried: attempts.map((attempt) => attempt.model), store: ctx.acuStore,
            hasTools, hasVision, requiredContextTokens: Math.ceil(body.length / 4) + maxTokens,
          });
          if (qualityFallbackModel) {
            const qualityStart = Date.now();
            const qualityController = new AbortController();
            const qualityTimeout = setTimeout(() => qualityController.abort(), timeoutForModel(qualityFallbackModel));
            try {
              const { response, upstreamProvider } = await fetchUpstreamChatCompletion({
                body: repairBody, model: qualityFallbackModel, apiKey: ctx.apiKey,
                proxyApiKey: ctx.proxyApiKey, proxyBaseUrl: ctx.proxyBaseUrl,
                signal: AbortSignal.any([globalController.signal, qualityController.signal]),
              });
              if (response.status === 200) {
                const replacementBody = await readResponseText(response);
                const replacementAttempt: AcuAttemptTrace = {
                  ...attemptProfileFields(qualityFallbackModel, repairBody, "quality_upgrade"),
                  model: qualityFallbackModel, upstream: upstreamProvider, status: "success", latency_ms: Date.now() - qualityStart,
                };
                attempts.push(replacementAttempt);
                const checkStart = Date.now();
                const replacementValidator = validateAssistantOutput({
                  messages: parsedMessages, assistantText: extractAssistantText(replacementBody), responseFormat, expectedSchema,
                });
                validatorLatencyMs += Date.now() - checkStart;
                if (replacementValidator.result === "pass") {
                  billAttempt(originalAttempt, originalResponseBody, originalModel);
                  responseBody = replacementBody;
                  actualModelUsed = qualityFallbackModel;
                  upstreamProviderUsed = upstreamProvider;
                  validator = replacementValidator;
                  qualityFallbackUsed = true;
                } else {
                  replacementAttempt.status = "error";
                  replacementAttempt.error_category = "quality_upgrade_validation_failed";
                  billAttempt(replacementAttempt, replacementBody, qualityFallbackModel);
                  qualityReviewRequired = true;
                }
              } else {
                const errorBody = await response.text().catch(() => "");
                const category = categorizeError(response.status, errorBody) ?? "quality_upgrade_error";
                attempts.push({
                  ...attemptProfileFields(qualityFallbackModel, repairBody, "quality_upgrade"),
                  model: qualityFallbackModel, upstream: upstreamProvider, status: "error", error_category: category,
                  latency_ms: Date.now() - qualityStart,
                  ...(extractExplicitUpstreamCost(errorBody) !== undefined && {
                    billed_cost: extractExplicitUpstreamCost(errorBody), usage_source: "upstream_cost" as const,
                  }),
                });
                qualityReviewRequired = true;
              }
            } catch {
              const category = qualityController.signal.aborted ? "timeout" : "quality_upgrade_error";
              attempts.push({
                ...attemptProfileFields(qualityFallbackModel, repairBody, "quality_upgrade"),
                model: qualityFallbackModel, upstream: "unknown", status: qualityController.signal.aborted ? "timeout" : "error",
                error_category: category, latency_ms: Date.now() - qualityStart,
              });
              qualityReviewRequired = true;
            } finally {
              clearTimeout(qualityTimeout);
            }
          } else {
            qualityReviewRequired = true;
          }
          if (!qualityFallbackUsed) {
            responseBody = originalResponseBody;
            actualModelUsed = originalModel;
            upstreamProviderUsed = originalProvider;
          }
        }
      }

      const latencyMs = Date.now() - startTime;
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const usage = parseUsage(responseBody, estimatedInputTokens, maxTokens, ctx.routerOpts.modelPricing.get(actualModelUsed));
      const finalAttempt = [...attempts].reverse().find((attempt) => attempt.model === actualModelUsed && attempt.status === "success");
      if (finalAttempt) {
        finalAttempt.reasoning_tokens = usage.reasoningTokens;
        finalAttempt.upstream_model = upstreamModelFromBody(responseBody, actualModelUsed);
      }
      const finalExecutionProfile = finalAttempt
        ? {
            executionProfileId: finalAttempt.execution_profile_id,
            thinkingMode: finalAttempt.thinking_mode,
            requestParameterApplied: finalAttempt.request_parameter_applied,
          }
        : executionProfileFor(actualModelUsed, undefined);
      let costEstimate = 0;
      let baselineCost = 0;
      let savings = 0;

      if (routingDecision) {
        if (actualModelUsed !== routingDecision.model) {
          const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, usage.inputTokens, usage.completionTokens, routingProfile ?? undefined);
          costEstimate = costs.costEstimate;
          baselineCost = costs.baselineCost;
          savings = costs.savings;
        } else {
          const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, usage.inputTokens, usage.completionTokens, routingProfile ?? undefined);
          costEstimate = costs.costEstimate;
          baselineCost = costs.baselineCost;
          savings = costs.savings;
        }
      } else {
        const costs = calculateModelCost(actualModelUsed, ctx.routerOpts.modelPricing, usage.inputTokens, usage.completionTokens);
        costEstimate = costs.costEstimate;
        baselineCost = costs.baselineCost;
        savings = costs.savings;
      }

	      const fallbackUsed = getFallbackUsed(attempts, actualModelUsed, routingDecision?.model);
	      if (acuEvaluation) setAcuExecutionResult(acuEvaluation, acuRecommendationSelected, actualModelUsed);
	      const upstreamLatencyMs = attempts.reduce((sum, attempt) => sum + attempt.latency_ms, 0);
        const fallbackLatencyMs = attempts.slice(1).reduce((sum, attempt) => sum + attempt.latency_ms, 0);
        const failedAttemptCost = attempts.reduce((sum, attempt, index) => (
          index === attempts.length - 1 && attempt.status === "success"
            ? sum : sum + (attempt.billed_cost ?? 0)
        ), 0);
        const totalAcuCost = usage.modelCallCost + failedAttemptCost + (acuEvaluation?.judgeCost ?? 0);
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
	        quality_review_required: qualityReviewRequired,
	        format_repair_used: formatRepairUsed,
	        format_repair_succeeded: formatRepairSucceeded,
	        execution_profile_id: finalExecutionProfile.executionProfileId,
	        thinking_mode: finalExecutionProfile.thinkingMode,
	        request_parameter_applied: finalExecutionProfile.requestParameterApplied,
	        upstream_model: upstreamModelFromBody(responseBody, actualModelUsed),
	        estimated_input_tokens: usage.inputTokens,
        estimated_output_tokens: usage.completionTokens,
        estimated_cost: costEstimate,
        baseline_model: DEFAULT_BASELINE_MODEL,
        baseline_cost: baselineCost,
        estimated_savings: savings,
        usage_audit: usage,
        cost_audit: {
          judge_cost: acuEvaluation?.judgeCost ?? 0,
          model_call_cost: usage.modelCallCost,
          failed_attempt_cost: failedAttemptCost,
          total_acu_cost: totalAcuCost,
        },
        latency_breakdown: {
          judge_latency_ms: acuEvaluation?.judgeLatencyMs ?? 0,
          route_compute_latency_ms: routeComputeLatencyMs,
          upstream_latency_ms: upstreamLatencyMs,
          validator_latency_ms: validatorLatencyMs,
          fallback_latency_ms: fallbackLatencyMs,
          total_router_latency_ms: latencyMs,
        },
	        route_reasoning: routingDecision?.reasoning ?? "Explicit model request",
	        validator_result: validator.result,
	        validator: validator.validator,
        ...(validator.result !== "not_applicable" && { validator_pass: validator.result === "pass" }),
        validator_reason: validator.reason ?? "not_applicable",
        ...(acuEvaluation && { acu_demo: acuEvaluation }),
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
        output_tokens: usage.completionTokens,
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
      if (acuEvaluation) {
        try {
          ctx.acuStore?.recordAttempts(requestId, attempts);
          ctx.acuStore?.finalizeRequest(requestId, {
            actualModel: actualModelUsed, inputTokens: usage.inputTokens, outputTokens: usage.completionTokens,
            actualCost: totalAcuCost, latencyMs, finalStatus: "completed", errorCategory: lastErrorCategory,
            visibleOutputTokens: usage.visibleOutputTokens, completionTokens: usage.completionTokens,
            reasoningTokens: usage.reasoningTokens, cachedInputTokens: usage.cachedInputTokens,
            usageSource: usage.usageSource, usageRawKeys: usage.usageRawKeys,
            inputPricePerMillion: usage.inputPricePerMillion, outputPricePerMillion: usage.outputPricePerMillion,
            modelCallCost: usage.modelCallCost, totalAcuCost,
            executionProfileId: finalExecutionProfile.executionProfileId,
            thinkingMode: finalExecutionProfile.thinkingMode,
            requestParameterApplied: finalExecutionProfile.requestParameterApplied,
            upstreamModel: upstreamModelFromBody(responseBody, actualModelUsed),
          });
          if (validator.result !== "not_applicable") {
            ctx.acuStore?.recordOutcome({
              requestId, validatorResult: validator.result, outcomeSource: "validator",
              outcomeScore: validator.result === "pass" ? 1 : 0,
              executionProfileId: finalExecutionProfile.executionProfileId,
            });
          }
          if (attempts.length > 1) {
            ctx.acuStore?.recordOutcome({ requestId, retryCount: attempts.length - 1, outcomeSource: "retry_signal", executionProfileId: finalExecutionProfile.executionProfileId });
          }
          if (actualModelUsed !== routingDecision?.model) {
            ctx.acuStore?.recordOutcome({ requestId, modelSwitched: true, outcomeSource: "model_upgrade_signal", executionProfileId: finalExecutionProfile.executionProfileId });
          }
        } catch { /* telemetry must not affect the response */ }
      }
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
        if (acuEvaluation) {
          setAcuExecutionResult(acuEvaluation, acuRecommendationSelected, actualModelUsed);
          trace.acu_demo = acuEvaluation;
        }
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

  if (acuEvaluation && isStreaming) {
    try {
      const streamingUsage = parseUsage(responseBody, estimatedInputTokens, maxTokens, ctx.routerOpts.modelPricing.get(actualModelUsed));
      const streamingTotalAcuCost = streamingUsage.modelCallCost + acuEvaluation.judgeCost;
      const finalAttempt = [...attempts].reverse().find((attempt) => attempt.model === actualModelUsed && attempt.status === "success");
      if (finalAttempt) {
        finalAttempt.reasoning_tokens = streamingUsage.reasoningTokens;
        finalAttempt.upstream_model = upstreamModelFromBody(responseBody, actualModelUsed);
      }
      const finalProfile = finalAttempt ?? attemptProfileFields(actualModelUsed, body, "initial");
      ctx.acuStore?.recordAttempts(requestId, attempts);
      ctx.acuStore?.finalizeRequest(requestId, {
        actualModel: actualModelUsed, inputTokens: streamingUsage.inputTokens, outputTokens: streamingUsage.completionTokens,
        actualCost: streamingTotalAcuCost, latencyMs, finalStatus: "completed_streaming", errorCategory: lastErrorCategory,
        visibleOutputTokens: streamingUsage.visibleOutputTokens, completionTokens: streamingUsage.completionTokens,
        reasoningTokens: streamingUsage.reasoningTokens, cachedInputTokens: streamingUsage.cachedInputTokens,
        usageSource: streamingUsage.usageSource, usageRawKeys: streamingUsage.usageRawKeys,
        inputPricePerMillion: streamingUsage.inputPricePerMillion,
        outputPricePerMillion: streamingUsage.outputPricePerMillion,
        modelCallCost: streamingUsage.modelCallCost, totalAcuCost: streamingTotalAcuCost,
        executionProfileId: finalProfile.execution_profile_id,
        thinkingMode: finalProfile.thinking_mode,
        requestParameterApplied: finalProfile.request_parameter_applied,
        upstreamModel: upstreamModelFromBody(responseBody, actualModelUsed),
      });
    } catch { /* telemetry must not affect the response */ }
  }

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
