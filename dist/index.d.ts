/**
 * OpenClaw Plugin Types (locally defined)
 *
 * OpenClaw's plugin SDK uses duck typing — these match the shapes
 * expected by registerProvider() and the plugin system.
 * Defined locally to avoid depending on internal OpenClaw paths.
 */
type ModelApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai" | "github-copilot" | "bedrock-converse-stream";
type ModelDefinitionConfig = {
    id: string;
    name: string;
    api?: ModelApi;
    reasoning: boolean;
    input: Array<"text" | "image">;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
};
type ModelProviderConfig = {
    baseUrl: string;
    apiKey?: string;
    api?: ModelApi;
    headers?: Record<string, string>;
    authHeader?: boolean;
    models: ModelDefinitionConfig[];
};
type OpenClawConfig = Record<string, unknown> & {
    models?: {
        providers?: Record<string, ModelProviderConfig>;
    };
    agents?: Record<string, unknown>;
    mcp?: {
        servers?: Record<string, unknown>;
    };
    tools?: {
        web?: {
            search?: Record<string, unknown> & {
                provider?: string;
                enabled?: boolean;
            };
        };
    };
};
type AuthProfileCredential = {
    apiKey?: string;
    type?: string;
    [key: string]: unknown;
};
type ProviderAuthResult = {
    profiles: Array<{
        profileId: string;
        credential: AuthProfileCredential;
    }>;
    configPatch?: Record<string, unknown>;
    defaultModel?: string;
    notes?: string[];
};
type WizardPrompter = {
    text: (opts: {
        message: string;
        validate?: (value: string) => string | undefined;
    }) => Promise<string | symbol>;
    note: (message: string) => void;
    progress: (message: string) => {
        stop: (message?: string) => void;
    };
};
type ProviderAuthContext = {
    config: Record<string, unknown>;
    agentDir?: string;
    workspaceDir?: string;
    prompter: WizardPrompter;
    runtime: {
        log: (message: string) => void;
    };
    isRemote: boolean;
    openUrl: (url: string) => Promise<void>;
};
type ProviderAuthMethod = {
    id: string;
    label: string;
    hint?: string;
    kind: "oauth" | "api_key" | "token" | "device_code" | "custom";
    run: (ctx: ProviderAuthContext) => Promise<ProviderAuthResult>;
};
type ProviderPlugin = {
    id: string;
    label: string;
    docsPath?: string;
    aliases?: string[];
    envVars?: string[];
    models?: ModelProviderConfig;
    auth: ProviderAuthMethod[];
    formatApiKey?: (cred: AuthProfileCredential) => string;
};
type PluginLogger = {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
};
type OpenClawPluginService = {
    id: string;
    start: () => void | Promise<void>;
    stop?: () => void | Promise<void>;
};
type ImageGenerationResolution = "1K" | "2K" | "4K";
type GeneratedImageAsset = {
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
    revisedPrompt?: string;
    metadata?: Record<string, unknown>;
};
type ImageGenerationSourceImage = {
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
    metadata?: Record<string, unknown>;
};
type ImageGenerationRequest = {
    provider: string;
    model: string;
    prompt: string;
    cfg: Record<string, unknown>;
    agentDir?: string;
    timeoutMs?: number;
    count?: number;
    size?: string;
    aspectRatio?: string;
    resolution?: ImageGenerationResolution;
    inputImages?: ImageGenerationSourceImage[];
};
type ImageGenerationResult = {
    images: GeneratedImageAsset[];
    model?: string;
    metadata?: Record<string, unknown>;
};
type ImageGenerationProviderCapabilities = {
    generate: {
        maxCount?: number;
        supportsSize?: boolean;
        supportsAspectRatio?: boolean;
        supportsResolution?: boolean;
    };
    edit: {
        enabled: boolean;
        maxInputImages?: number;
        maxCount?: number;
        supportsSize?: boolean;
    };
    geometry?: {
        sizes?: string[];
        resolutions?: ImageGenerationResolution[];
    };
};
type ImageGenerationProviderPlugin = {
    id: string;
    aliases?: string[];
    label?: string;
    defaultModel?: string;
    models?: string[];
    capabilities: ImageGenerationProviderCapabilities;
    isConfigured?: (ctx: {
        cfg?: Record<string, unknown>;
    }) => boolean;
    generateImage: (req: ImageGenerationRequest) => Promise<ImageGenerationResult>;
};
type MusicGenerationOutputFormat = "mp3" | "wav";
type GeneratedMusicAsset = {
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
    metadata?: Record<string, unknown>;
};
type MusicGenerationRequest = {
    provider: string;
    model: string;
    prompt: string;
    cfg: Record<string, unknown>;
    agentDir?: string;
    timeoutMs?: number;
    lyrics?: string;
    instrumental?: boolean;
    durationSeconds?: number;
    format?: MusicGenerationOutputFormat;
};
type MusicGenerationResult = {
    tracks: GeneratedMusicAsset[];
    model?: string;
    lyrics?: string[];
    metadata?: Record<string, unknown>;
};
type MusicGenerationProviderCapabilities = {
    maxTracks?: number;
    maxDurationSeconds?: number;
    supportsLyrics?: boolean;
    supportsInstrumental?: boolean;
    supportsDuration?: boolean;
    supportsFormat?: boolean;
    supportedFormats?: readonly MusicGenerationOutputFormat[];
};
type MusicGenerationProviderPlugin = {
    id: string;
    aliases?: string[];
    label?: string;
    defaultModel?: string;
    models?: string[];
    capabilities: MusicGenerationProviderCapabilities;
    isConfigured?: (ctx: {
        cfg?: Record<string, unknown>;
    }) => boolean;
    generateMusic: (req: MusicGenerationRequest) => Promise<MusicGenerationResult>;
};
type VideoGenerationResolution = "480P" | "720P" | "768P" | "1080P";
type GeneratedVideoAsset = {
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
    metadata?: Record<string, unknown>;
};
type VideoGenerationSourceAsset = {
    url?: string;
    buffer?: Buffer;
    mimeType?: string;
    fileName?: string;
    metadata?: Record<string, unknown>;
};
type VideoGenerationRequest = {
    provider: string;
    model: string;
    prompt: string;
    cfg: Record<string, unknown>;
    agentDir?: string;
    timeoutMs?: number;
    size?: string;
    aspectRatio?: string;
    resolution?: VideoGenerationResolution;
    durationSeconds?: number;
    audio?: boolean;
    watermark?: boolean;
    inputImages?: VideoGenerationSourceAsset[];
    inputVideos?: VideoGenerationSourceAsset[];
};
type VideoGenerationResult = {
    videos: GeneratedVideoAsset[];
    model?: string;
    metadata?: Record<string, unknown>;
};
type VideoGenerationModeCapabilities = {
    maxVideos?: number;
    maxInputImages?: number;
    maxInputVideos?: number;
    maxDurationSeconds?: number;
    supportedDurationSeconds?: readonly number[];
    supportsSize?: boolean;
    supportsAspectRatio?: boolean;
    supportsResolution?: boolean;
    supportsAudio?: boolean;
    supportsWatermark?: boolean;
};
type VideoGenerationTransformCapabilities = VideoGenerationModeCapabilities & {
    enabled: boolean;
};
type VideoGenerationProviderCapabilities = VideoGenerationModeCapabilities & {
    generate?: VideoGenerationModeCapabilities;
    imageToVideo?: VideoGenerationTransformCapabilities;
    videoToVideo?: VideoGenerationTransformCapabilities;
};
type VideoGenerationProviderPlugin = {
    id: string;
    aliases?: string[];
    label?: string;
    defaultModel?: string;
    models?: string[];
    capabilities: VideoGenerationProviderCapabilities;
    isConfigured?: (ctx: {
        cfg?: Record<string, unknown>;
    }) => boolean;
    generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};
type WebSearchProviderToolDefinition = {
    description: string;
    parameters: unknown;
    execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};
type WebSearchProviderContext = {
    config: OpenClawConfig;
    searchConfig?: Record<string, unknown>;
    runtimeMetadata?: Record<string, unknown>;
};
type WebSearchProviderPlugin = {
    id: string;
    label: string;
    hint: string;
    onboardingScopes?: Array<"text-inference">;
    requiresCredential?: boolean;
    credentialLabel?: string;
    envVars: string[];
    placeholder: string;
    signupUrl: string;
    docsUrl?: string;
    autoDetectOrder?: number;
    credentialPath: string;
    inactiveSecretPaths?: string[];
    getCredentialValue: (searchConfig?: Record<string, unknown>) => unknown;
    setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => void;
    getConfiguredCredentialValue?: (config?: OpenClawConfig) => unknown;
    setConfiguredCredentialValue?: (configTarget: OpenClawConfig, value: unknown) => void;
    applySelectionConfig?: (config: OpenClawConfig) => OpenClawConfig;
    resolveRuntimeMetadata?: (ctx: Record<string, unknown>) => unknown;
    createTool: (ctx: WebSearchProviderContext) => WebSearchProviderToolDefinition | null;
};
type OpenClawPluginApi = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    config: OpenClawConfig;
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    registerProvider: (provider: ProviderPlugin) => void;
    registerImageGenerationProvider: (provider: ImageGenerationProviderPlugin) => void;
    registerMusicGenerationProvider: (provider: MusicGenerationProviderPlugin) => void;
    registerVideoGenerationProvider?: (provider: VideoGenerationProviderPlugin) => void;
    registerWebSearchProvider?: (provider: WebSearchProviderPlugin) => void;
    registerTool: (tool: unknown, opts?: unknown) => void;
    registerHook: (events: string | string[], handler: unknown, opts?: unknown) => void;
    registerHttpRoute: (params: {
        path: string;
        handler: unknown;
    }) => void;
    registerService: (service: OpenClawPluginService) => void;
    registerCommand: (command: unknown) => void;
    resolvePath: (input: string) => string;
    on: (hookName: string, handler: unknown, opts?: unknown) => void;
};
type OpenClawPluginDefinition = {
    id?: string;
    name?: string;
    description?: string;
    version?: string;
    register?: (api: OpenClawPluginApi) => void | Promise<void>;
    activate?: (api: OpenClawPluginApi) => void | Promise<void>;
    deactivate?: (api: OpenClawPluginApi) => void | Promise<void>;
    reload?: {
        noopPrefixes?: string[];
    };
};

/**
 * Tier → Model Selection
 *
 * Maps a classification tier to the cheapest capable model.
 * Builds RoutingDecision metadata with cost estimates and savings.
 */

type ModelPricing = {
    inputPrice: number;
    outputPrice: number;
    /** Active promo flat price per request (overrides token-based pricing when set) */
    flatPrice?: number;
};
/**
 * Get the ordered fallback chain for a tier: [primary, ...fallbacks].
 */
declare function getFallbackChain(tier: Tier, tierConfigs: Record<Tier, TierConfig>): string[];
declare function calculateModelCost(model: string, modelPricing: Map<string, ModelPricing>, estimatedInputTokens: number, maxOutputTokens: number, routingProfile?: "free" | "eco" | "auto" | "premium"): {
    costEstimate: number;
    baselineCost: number;
    savings: number;
};

/**
 * Smart Router Types
 *
 * Four classification tiers — REASONING is distinct from COMPLEX because
 * reasoning tasks need different models (o3, gemini-pro) than general
 * complex tasks (gpt-4o, sonnet-4).
 *
 * Scoring uses weighted float dimensions with sigmoid confidence calibration.
 */
type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";
type RoutingDecision = {
    model: string;
    tier: Tier;
    confidence: number;
    method: "rules" | "llm";
    reasoning: string;
    costEstimate: number;
    baselineCost: number;
    savings: number;
    agenticScore?: number;
    /** Which tier configs were used (auto/eco/premium/agentic) — avoids re-derivation in proxy */
    tierConfigs?: Record<Tier, TierConfig>;
    /** Which routing profile was applied */
    profile?: "auto" | "eco" | "premium" | "agentic";
};
type RouterOptions = {
    config: RoutingConfig;
    modelPricing: Map<string, ModelPricing>;
    routingProfile?: "eco" | "auto" | "premium";
    hasTools?: boolean;
    /** Override current time for promotion window checks (for testing). Default: new Date() */
    now?: Date;
};
type TierConfig = {
    primary: string;
    fallback: string[];
};
type ScoringConfig = {
    tokenCountThresholds: {
        simple: number;
        complex: number;
    };
    codeKeywords: string[];
    reasoningKeywords: string[];
    simpleKeywords: string[];
    technicalKeywords: string[];
    creativeKeywords: string[];
    imperativeVerbs: string[];
    constraintIndicators: string[];
    outputFormatKeywords: string[];
    referenceKeywords: string[];
    negationKeywords: string[];
    domainSpecificKeywords: string[];
    agenticTaskKeywords: string[];
    dimensionWeights: Record<string, number>;
    tierBoundaries: {
        simpleMedium: number;
        mediumComplex: number;
        complexReasoning: number;
    };
    confidenceSteepness: number;
    confidenceThreshold: number;
};
type ClassifierConfig = {
    llmModel: string;
    llmMaxTokens: number;
    llmTemperature: number;
    promptTruncationChars: number;
    cacheTtlMs: number;
};
type OverridesConfig = {
    maxTokensForceComplex: number;
    structuredOutputMinTier: Tier;
    ambiguousDefaultTier: Tier;
    /**
     * When enabled, prefer models optimized for agentic workflows.
     * Agentic models continue autonomously with multi-step tasks
     * instead of stopping and waiting for user input.
     */
    agenticMode?: boolean;
};
/**
 * Time-windowed promotion that temporarily overrides tier routing.
 * Active promotions are auto-applied; expired ones are ignored at runtime.
 */
type Promotion = {
    /** Human-readable label (e.g. "GLM-5 Launch Promo") */
    name: string;
    /** ISO date string, promotion starts (inclusive). e.g. "2026-04-01" */
    startDate: string;
    /** ISO date string, promotion ends (exclusive). e.g. "2026-04-15" */
    endDate: string;
    /** Partial tier overrides — merged into the active tier configs (primary/fallback) */
    tierOverrides: Partial<Record<Tier, Partial<TierConfig>>>;
    /** Which profiles this applies to. Default: all profiles. */
    profiles?: Array<"auto" | "eco" | "premium" | "agentic">;
};
type RoutingConfig = {
    version: string;
    classifier: ClassifierConfig;
    scoring: ScoringConfig;
    tiers: Record<Tier, TierConfig>;
    /**
     * Tier configs for agentic mode — models that excel at multi-step tasks.
     * Set to `null` to disable agentic tier selection entirely (forces all
     * requests through `tiers`, even when tools are present in the request).
     */
    agenticTiers?: Record<Tier, TierConfig> | null;
    /** Tier configs for eco profile — ultra cost-optimized (blockrun/eco). `null` falls back to `tiers`. */
    ecoTiers?: Record<Tier, TierConfig> | null;
    /** Tier configs for premium profile — best quality (blockrun/premium). `null` falls back to `tiers`. */
    premiumTiers?: Record<Tier, TierConfig> | null;
    /** Time-windowed promotions that temporarily override tier routing */
    promotions?: Promotion[];
    overrides: OverridesConfig;
};

/**
 * Default Routing Config
 *
 * All routing parameters as a TypeScript constant.
 * Operators override via openclaw.yaml plugin config.
 *
 * Scoring uses 14 weighted dimensions with sigmoid confidence calibration.
 */

declare const DEFAULT_ROUTING_CONFIG: RoutingConfig;

/**
 * Smart Router Entry Point
 *
 * Classifies requests and routes to the cheapest capable model.
 * Delegates to pluggable RouterStrategy (default: RulesStrategy, <1ms).
 */

/**
 * Route a request to the cheapest capable model.
 * Delegates to the registered "rules" strategy by default.
 */
declare function route(prompt: string, systemPrompt: string | undefined, maxOutputTokens: number, options: RouterOptions): RoutingDecision;

/**
 * Response Cache for LLM Completions
 *
 * Caches LLM responses by request hash (model + messages + params).
 * Inspired by LiteLLM's caching system. Returns cached responses for
 * identical requests, saving both cost and latency.
 *
 * Features:
 * - TTL-based expiration (default 10 minutes)
 * - LRU eviction when cache is full
 * - Size limits per item (1MB max)
 * - Heap-based expiration tracking for efficient pruning
 */
type CachedLLMResponse = {
    body: Buffer;
    status: number;
    headers: Record<string, string>;
    model: string;
    cachedAt: number;
    expiresAt: number;
};
type ResponseCacheConfig = {
    /** Maximum number of cached responses. Default: 200 */
    maxSize?: number;
    /** Default TTL in seconds. Default: 600 (10 minutes) */
    defaultTTL?: number;
    /** Maximum size per cached item in bytes. Default: 1MB */
    maxItemSize?: number;
    /** Enable/disable cache. Default: true */
    enabled?: boolean;
};
declare class ResponseCache {
    private cache;
    private expirationHeap;
    private config;
    private stats;
    constructor(config?: ResponseCacheConfig);
    /**
     * Generate cache key from request body.
     * Hashes: model + messages + temperature + max_tokens + other params
     */
    static generateKey(body: Buffer | string): string;
    /**
     * Check if caching is enabled for this request.
     * Respects cache control headers and request params.
     */
    shouldCache(body: Buffer | string, headers?: Record<string, string>): boolean;
    /**
     * Get cached response if available and not expired.
     */
    get(key: string): CachedLLMResponse | undefined;
    /**
     * Cache a response with optional custom TTL.
     */
    set(key: string, response: {
        body: Buffer;
        status: number;
        headers: Record<string, string>;
        model: string;
    }, ttlSeconds?: number): void;
    /**
     * Evict expired and oldest entries to make room.
     */
    private evict;
    /**
     * Get cache statistics.
     */
    getStats(): {
        size: number;
        maxSize: number;
        hits: number;
        misses: number;
        evictions: number;
        hitRate: string;
    };
    /**
     * Clear all cached entries.
     */
    clear(): void;
    /**
     * Check if cache is enabled.
     */
    isEnabled(): boolean;
}

/**
 * Session Persistence Store
 *
 * Tracks model selections per session to prevent model switching mid-task.
 * When a session is active, the router will continue using the same model
 * instead of re-routing each request.
 */
type SessionEntry = {
    model: string;
    tier: string;
    createdAt: number;
    lastUsedAt: number;
    requestCount: number;
    /**
     * `true` when the user explicitly chose this model (e.g. /model command in
     * OpenClaw or sending an explicit non-profile model in the request body).
     * Explicit pins are sticky — they're NOT overridden by tier escalation when
     * a future routing-profile request comes in. The user's intent wins.
     */
    userExplicit?: boolean;
    recentHashes: string[];
    strikes: number;
    escalated: boolean;
    sessionCostMicros: bigint;
};
type SessionConfig = {
    /** Enable session persistence (default: false) */
    enabled: boolean;
    /** Session timeout in ms (default: 30 minutes) */
    timeoutMs: number;
    /** Header name for session ID (default: X-Session-ID) */
    headerName: string;
};
/**
 * Session persistence store for maintaining model selections.
 */
declare class SessionStore {
    private sessions;
    private config;
    private cleanupInterval;
    constructor(config?: Partial<SessionConfig>);
    /**
     * Get the pinned model for a session, if any.
     */
    getSession(sessionId: string): SessionEntry | undefined;
    /**
     * Pin a model to a session.
     *
     * Pass `userExplicit: true` when the user explicitly chose this model
     * (e.g. via /model command or by sending an explicit non-profile model).
     * Explicit pins are sticky — they survive tier-escalation comparisons so
     * that the user's choice keeps winning even if subsequent requests use a
     * routing profile that would normally re-route.
     */
    setSession(sessionId: string, model: string, tier: string, userExplicit?: boolean): void;
    /**
     * Touch a session to extend its timeout.
     */
    touchSession(sessionId: string): void;
    /**
     * Clear a specific session.
     */
    clearSession(sessionId: string): void;
    /**
     * Clear all sessions.
     */
    clearAll(): void;
    /**
     * Get session stats for debugging.
     */
    getStats(): {
        count: number;
        sessions: Array<{
            id: string;
            model: string;
            age: number;
        }>;
    };
    /**
     * Clean up expired sessions.
     */
    private cleanup;
    /**
     * Record a request content hash and detect repetitive patterns.
     * Returns true if escalation should be triggered (3+ consecutive similar requests).
     */
    recordRequestHash(sessionId: string, hash: string): boolean;
    /**
     * Escalate session to next tier. Returns the new model/tier or null if already at max.
     */
    escalateSession(sessionId: string, tierConfigs: Record<string, {
        primary: string;
        fallback: string[];
    }>): {
        model: string;
        tier: string;
    } | null;
    /**
     * Add cost to a session's running total for maxCostPerRun tracking.
     * Cost in micro-currency units (6 decimal places).
     * Creates a cost-tracking-only entry if none exists (e.g., explicit model requests
     * that never go through the routing path).
     */
    addSessionCost(sessionId: string, additionalMicros: bigint): void;
    /**
     * Get the total accumulated cost for a session in USD.
     */
    getSessionCostUsd(sessionId: string): number;
    /**
     * Stop the cleanup interval.
     */
    close(): void;
}
/**
 * Generate a session ID from request headers or create a default.
 */
declare function getSessionId(headers: Record<string, string | string[] | undefined>, headerName?: string): string | undefined;
/**
 * Generate a short hash fingerprint from request content.
 * Captures: last user message text + tool call names (if any).
 * Normalizes whitespace to avoid false negatives from minor formatting diffs.
 */
declare function hashRequestContent(lastUserContent: string, toolCallNames?: string[]): string;

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

type ProxyOptions = {
    apiKey: string;
    port?: number;
    proxyApiKey?: string;
    proxyBaseUrl?: string;
    routingConfig?: Partial<RoutingConfig>;
    cacheConfig?: Partial<ResponseCacheConfig>;
    sessionConfig?: Partial<SessionConfig>;
    skipBalanceCheck?: boolean;
    onRouted?: (decision: RoutingDecision) => void;
};
type ProxyHandle = {
    port: number;
    baseUrl: string;
    close: () => Promise<void>;
};
declare function startProxy(options: ProxyOptions): Promise<ProxyHandle>;
/**
 * Get the configured proxy port.
 */
declare function getProxyPort(): number;

/**
 * Authentication — Dual Upstream
 *
 * Resolves API keys for both upstream providers.
 */
declare function resolveApiKey(): string;
declare function saveApiKey(key: string): void;

/**
 * BlockRun ProviderPlugin for OpenClaw
 *
 * Registers ClawRouter as an LLM provider in OpenClaw.
 * Uses a local proxy to handle routing transparently —
 * the client sees a standard OpenAI-compatible API at localhost.
 */

declare const blockrunProvider: ProviderPlugin;

/**
 * Model Definitions — Dual Upstream (2026-07-02 updated)
 *
 * "proxy": api.openai-proxy.org (OpenAI, Anthropic, Google, DeepSeek, Kimi, Qwen, GLM)
 * "openrouter": openrouter.ai (DeepSeek, Meta, Qwen, Grok, free models)
 */

type UpstreamProvider = "proxy" | "openrouter";
type ExtendedModelDefinition = ModelDefinitionConfig & {
    upstream: UpstreamProvider;
    useMaxCompletionTokens?: boolean;
};
declare const BLOCKRUN_MODELS: ExtendedModelDefinition[];
declare const OPENCLAW_MODELS: ExtendedModelDefinition[];
declare const MODEL_ALIASES: Record<string, string>;
declare function resolveModelAlias(model: string): string;
declare function buildProviderModels(baseUrl: string): ModelProviderConfig;
declare function supportsToolCalling(modelId: string): boolean;
declare function supportsVision(modelId: string): boolean;
declare function isReasoningModel(modelId: string): boolean;
declare function getModelContextWindow(modelId: string): number | undefined;

/**
 * Usage Logger
 *
 * Logs every LLM request as a JSON line to a daily log file.
 * Files: ~/.openclaw/blockrun/logs/usage-YYYY-MM-DD.jsonl
 *
 * MVP: append-only JSON lines. No rotation, no cleanup.
 * Logging never breaks the request flow — all errors are swallowed.
 */
type UsageEntry = {
    timestamp: string;
    model: string;
    tier: string;
    cost: number;
    baselineCost: number;
    savings: number;
    latencyMs: number;
    /** Whether the request completed successfully or ended in an error */
    status?: "success" | "error";
    /** Input (prompt) tokens reported by the provider */
    inputTokens?: number;
    /** Output (completion) tokens reported by the provider */
    outputTokens?: number;
    /** Partner service ID (e.g., "image_generation") — only set for partner API calls */
    partnerId?: string;
    /** Partner service name (e.g., "BlockRun") — only set for partner API calls */
    service?: string;
};
/**
 * Log a usage entry as a JSON line.
 */
declare function logUsage(entry: UsageEntry): Promise<void>;

/**
 * Request Deduplication
 *
 * Prevents double-charging when OpenClaw retries a request after timeout.
 * Tracks in-flight requests and caches completed responses for a short TTL.
 */
type CachedResponse = {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
    completedAt: number;
};
declare class RequestDeduplicator {
    private inflight;
    private completed;
    private ttlMs;
    constructor(ttlMs?: number);
    /** Hash request body to create a dedup key. */
    static hash(body: Buffer): string;
    /** Check if a response is cached for this key. */
    getCached(key: string): CachedResponse | undefined;
    /** Check if a request with this key is currently in-flight. Returns a promise to wait on. */
    getInflight(key: string): Promise<CachedResponse> | undefined;
    /** Mark a request as in-flight. */
    markInflight(key: string): void;
    /** Complete an in-flight request — cache result and notify waiters. */
    complete(key: string, result: CachedResponse): void;
    /** Remove an in-flight entry on error (don't cache failures).
     *  Also rejects any waiters so they can retry independently. */
    removeInflight(key: string): void;
    /** Prune expired completed entries. */
    private prune;
}

declare const VERSION: string;

/**
 * ClawRouter — Smart LLM Router (OpenRouter Edition)
 *
 * Routes each request to the cheapest capable model via OpenRouter.
 * 22+ models, smart 15-dimension routing, <1ms local decisions.
 *
 * Usage:
 *   clawrouter                           # Start proxy
 *   clawrouter --port 8402               # Custom port
 *   OPENROUTER_API_KEY=sk-... clawrouter # Set API key
 */

declare const plugin: OpenClawPluginDefinition;

export { BLOCKRUN_MODELS, type CachedResponse, DEFAULT_ROUTING_CONFIG, MODEL_ALIASES, OPENCLAW_MODELS, RequestDeduplicator, ResponseCache, type RoutingConfig, type RoutingDecision, type SessionConfig, type SessionEntry, SessionStore, type Tier, type UsageEntry, VERSION, blockrunProvider, buildProviderModels, calculateModelCost, plugin as default, getFallbackChain, getModelContextWindow, getProxyPort, getSessionId, hashRequestContent, isReasoningModel, logUsage, resolveApiKey, resolveModelAlias, route, saveApiKey, startProxy, supportsToolCalling, supportsVision };
