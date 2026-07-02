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

const OPENROUTER_API = "https://openrouter.ai/api/v1";

const HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const PER_MODEL_TIMEOUT_MS = 60_000;
const REASONING_MODEL_TIMEOUT_MS = 180_000;
const MAX_FALLBACK_ATTEMPTS = 5;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const OVERLOAD_COOLDOWN_MS = 15_000;
const MAX_MESSAGES = 200;

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
  if (status === 401 || status === 403) return "auth_failure";
  if (status === 429) return "rate_limited";
  if (status === 529) return "overloaded";
  if (status === 503 && /overload|capacity/i.test(body)) return "overloaded";
  if (status >= 500) return "server_error";
  if (status === 400 || status === 413) return "config_error";
  return null;
}

// ── Types ──

export type ProxyOptions = {
  apiKey: string;
  port?: number;
  routingConfig?: Partial<RoutingConfig>;
  cacheConfig?: Partial<ResponseCacheConfig>;
  sessionConfig?: Partial<SessionConfig>;
  skipBalanceCheck?: boolean; // unused, kept for API compat
  onRouted?: (decision: RoutingDecision) => void;
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
};

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
  return BLOCKRUN_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: 1700000000,
    owned_by: "openrouter",
  }));
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
  const apiKey = options.apiKey;
  const port = options.port ?? PROXY_PORT;
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts: RouterOptions = { config: routingConfig, modelPricing };

  const deduplicator = new RequestDeduplicator();
  const responseCache = new ResponseCache(options.cacheConfig);
  const sessionStore = new SessionStore(options.sessionConfig);
  const sessionJournal = new SessionJournal();
  const excludeList = loadExcludeList();

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, {
        apiKey, routerOpts, deduplicator, responseCache, sessionStore,
        sessionJournal, excludeList, onRouted: options.onRouted,
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

  console.log(`[ClawRouter] v${VERSION} listening on http://127.0.0.1:${port}`);
  console.log(`[ClawRouter] Routing via OpenRouter (${BLOCKRUN_MODELS.length} models)`);

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
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
    deduplicator: RequestDeduplicator;
    responseCache: ResponseCache;
    sessionStore: SessionStore;
    sessionJournal: SessionJournal;
    excludeList: Set<string>;
    onRouted?: (decision: RoutingDecision) => void;
  },
): Promise<void> {
  // ── Health check ──
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: VERSION, models: BLOCKRUN_MODELS.length }));
    return;
  }

  // ── Cache stats ──
  if (req.url === "/cache") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ctx.responseCache.getStats(), null, 2));
    return;
  }

  // ── Stats ──
  if (req.url?.startsWith("/stats")) {
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

  // ── /v1/models ──
  if (req.url === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: buildProxyModelList() }));
    return;
  }

  // ── Share routes ──
  if (req.url?.startsWith("/share/") && req.method === "GET") {
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
  if (!req.url?.includes("/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Not found: ${req.url}`, type: "not_found" } }));
    return;
  }

  const startTime = Date.now();
  const debugMode = req.headers["x-clawrouter-debug"] !== "false";

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
  const isChatCompletion = true;
  const sessionId = getSessionId(req.headers as Record<string, string | string[] | undefined>);
  let effectiveSessionId: string | undefined = sessionId;
  const parsedMessages: ChatMessage[] = [];

  try {
    const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
    isStreaming = parsed.stream === true;
    modelId = (parsed.model as string) || "";
    maxTokens = (parsed.max_tokens as number) || 4096;

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

    // Google model normalization
    if (isGoogleModel(modelId) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForGoogle(parsed.messages as ChatMessage[]);
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
  const respCached = ctx.responseCache.get(dedupKey);
  if (respCached) {
    const headers = { "Content-Type": "application/json", "X-Cache-Hit": "true" };
    res.writeHead(200, headers);
    res.end(respCached.body);
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

  for (let i = 0; i < modelsToTry.length; i++) {
    const tryModel = modelsToTry[i];
    if (globalController.signal.aborted) break;

    console.log(`[ClawRouter] Trying ${i + 1}/${modelsToTry.length}: ${tryModel}`);

    const perAttemptTimeout = timeoutForModel(tryModel);
    const modelController = new AbortController();
    const modelTimeoutId = setTimeout(() => modelController.abort(), perAttemptTimeout);
    const combinedSignal = AbortSignal.any([globalController.signal, modelController.signal]);

    try {
      const upstreamUrl = `${OPENROUTER_API}/chat/completions`;

      // Update model in body
      const reqParsed = JSON.parse(body.toString());
      reqParsed.model = tryModel;
      const reqBody = Buffer.from(JSON.stringify(reqParsed));

      const response = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ctx.apiKey}`,
          "HTTP-Referer": "http://localhost:8402",
          "X-Title": "ClawRouter",
          "User-Agent": USER_AGENT,
        },
        body: reqBody,
        signal: combinedSignal,
      });

      clearTimeout(modelTimeoutId);

      if (response.status === 200) {
        upstream = response;
        actualModelUsed = tryModel;
        break;
      }

      // Handle errors
      const errorBody = await response.text().catch(() => "");
      const category = categorizeError(response.status, errorBody);
      lastError = { body: errorBody, status: response.status };

      if (category === "rate_limited") {
        markRateLimited(tryModel);
      } else if (category === "overloaded") {
        markOverloaded(tryModel);
      } else if (category === "auth_failure") {
        console.error(`[ClawRouter] Auth failure for ${tryModel} — check API key`);
        break; // Don't retry auth failures
      }

      console.log(`[ClawRouter] ${category ?? "error"} from ${tryModel}: ${errorBody.slice(0, 100)}`);
    } catch (err) {
      clearTimeout(modelTimeoutId);
      if (globalController.signal.aborted) break;
      if (modelController.signal.aborted && i < modelsToTry.length - 1) {
        console.log(`[ClawRouter] ${tryModel} timed out, trying fallback`);
        continue;
      }
      lastError = { body: String(err), status: 500 };
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

    if (isStreaming && canWrite(res)) {
      // Convert non-streaming response to SSE format
      const parsed = JSON.parse(responseBody);
      const chunk = {
        id: parsed.id || `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: parsed.created || Math.floor(Date.now() / 1000),
        model: parsed.model || actualModelUsed,
        choices: parsed.choices?.map((c: Record<string, unknown>, idx: number) => ({
          index: idx,
          delta: { role: "assistant", content: (c.message as Record<string, unknown>)?.content || "" },
          finish_reason: null,
        })) || [],
      };
      safeWrite(res, `data: ${JSON.stringify(chunk)}\n\n`);

      // Send finish chunk
      const finishChunk = { ...chunk, choices: chunk.choices.map((c: Record<string, unknown>) => ({ ...c, delta: {}, finish_reason: "stop" })) };
      safeWrite(res, `data: ${JSON.stringify(finishChunk)}\n\n`);
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
  if (responseBody && responseBody.length < 1_048_576) {
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
