import rawCapabilities from "../acu/catalog/reasoning-capabilities.json";
import type { AlphaProtocol } from "./repository.js";

export const CANONICAL_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type CanonicalReasoningEffort = (typeof CANONICAL_REASONING_EFFORTS)[number];
export type ReasoningControlMode = "standard_effort" | "messages_effort" | "client_thinking_passthrough" | "none";

export type ModelReasoningCapability = {
  modelId: string;
  protocols: Partial<Record<AlphaProtocol, {
    controlMode: ReasoningControlMode;
    supportedEfforts: CanonicalReasoningEffort[];
    wireMapping?: Partial<Record<CanonicalReasoningEffort, string>>;
  }>>;
  source: "official" | "observed" | "inferred";
  status: "verified" | "provisional";
  observedAt?: string;
};

export type ProfileReasoningOverride = {
  rejectedEfforts?: string[];
  supportedEffortsOverride?: string[];
  reason?: string;
  observedAt?: string;
};

export type ReasoningMappingStatus = "exact" | "upgraded_alias" | "capped_to_model_max" | "model_default" | "passthrough" | "unknown_client_value" | "provider_fallback_to_client_effort" | "provider_fallback_to_default";

export const REASONING_CAPABILITIES = rawCapabilities as ModelReasoningCapability[];

export function canonicalReasoningEffort(value: unknown): CanonicalReasoningEffort | undefined {
  return typeof value === "string" && (CANONICAL_REASONING_EFFORTS as readonly string[]).includes(value)
    ? value as CanonicalReasoningEffort : undefined;
}

export function maxCanonicalEffort(left?: CanonicalReasoningEffort, right?: CanonicalReasoningEffort): CanonicalReasoningEffort | undefined {
  if (!left) return right;
  if (!right) return left;
  return CANONICAL_REASONING_EFFORTS.indexOf(left) >= CANONICAL_REASONING_EFFORTS.indexOf(right) ? left : right;
}

export function resolveSupportedReasoningEffort(
  target: CanonicalReasoningEffort,
  supported: CanonicalReasoningEffort[],
): { effort?: CanonicalReasoningEffort; status: ReasoningMappingStatus } {
  if (supported.includes(target)) return { effort: target, status: "exact" };
  const targetRank = CANONICAL_REASONING_EFFORTS.indexOf(target);
  const ordered = [...supported].sort((a, b) => CANONICAL_REASONING_EFFORTS.indexOf(a) - CANONICAL_REASONING_EFFORTS.indexOf(b));
  const higher = ordered.find((effort) => CANONICAL_REASONING_EFFORTS.indexOf(effort) >= targetRank);
  if (higher) return { effort: higher, status: "upgraded_alias" };
  return ordered.length ? { effort: ordered.at(-1), status: "capped_to_model_max" } : { status: "model_default" };
}

export function modelReasoningCapability(modelId: string): ModelReasoningCapability | undefined {
  return REASONING_CAPABILITIES.find((capability) => capability.modelId === modelId);
}

export function resolveReasoningCapability(input: {
  modelId: string;
  protocol: AlphaProtocol;
  profileOverride?: ProfileReasoningOverride;
  legacyControlMode?: ReasoningControlMode;
  legacySupportedEfforts?: string[];
}): { controlMode: ReasoningControlMode; supportedEfforts: CanonicalReasoningEffort[]; wireMapping: Partial<Record<CanonicalReasoningEffort, string>>; source: string } {
  const model = modelReasoningCapability(input.modelId);
  const protocol = model?.protocols[input.protocol];
  const override = input.profileOverride?.supportedEffortsOverride?.map(canonicalReasoningEffort).filter((value): value is CanonicalReasoningEffort => Boolean(value));
  const legacy = input.legacySupportedEfforts?.map(canonicalReasoningEffort).filter((value): value is CanonicalReasoningEffort => Boolean(value)) ?? [];
  let supported = override?.length ? override : protocol?.supportedEfforts.length ? protocol.supportedEfforts : legacy;
  const rejected = new Set(input.profileOverride?.rejectedEfforts ?? []);
  supported = supported.filter((effort) => !rejected.has(effort));
  return {
    controlMode: protocol?.controlMode ?? input.legacyControlMode ?? "none",
    supportedEfforts: supported,
    wireMapping: protocol?.wireMapping ?? {},
    source: override?.length ? "profile_override" : protocol ? `${model!.source}:${model!.status}` : legacy.length ? "profile_legacy" : "none",
  };
}

export type ReasoningDecision = {
  clientRequestedReasoningEffort?: string;
  presetReasoningEffort?: CanonicalReasoningEffort;
  targetCanonicalReasoningEffort?: CanonicalReasoningEffort;
  resolvedReasoningEffort?: string;
  wireReasoningEffort?: string;
  mappingStatus: ReasoningMappingStatus;
  reasoningCapabilitySource: string;
  reasoningControlMode: ReasoningControlMode;
  providerReasoningOverrideApplied?: boolean;
};

export function decideReasoning(input: {
  mode: "explicit" | "acu-auto" | "acu-high";
  clientEffort?: string;
  presetEffort?: CanonicalReasoningEffort;
  modelId: string;
  protocol: AlphaProtocol;
  profileOverride?: ProfileReasoningOverride;
  legacyControlMode?: ReasoningControlMode;
  legacySupportedEfforts?: string[];
}): ReasoningDecision {
  const capability = resolveReasoningCapability(input);
  if (input.mode === "explicit") return {
    clientRequestedReasoningEffort: input.clientEffort,
    resolvedReasoningEffort: input.clientEffort,
    wireReasoningEffort: input.clientEffort,
    mappingStatus: "passthrough",
    reasoningCapabilitySource: capability.source,
    reasoningControlMode: capability.controlMode,
  };
  const client = input.clientEffort === undefined ? undefined : canonicalReasoningEffort(input.clientEffort);
  if (input.clientEffort !== undefined && !client) return {
    clientRequestedReasoningEffort: input.clientEffort,
    resolvedReasoningEffort: input.clientEffort,
    wireReasoningEffort: input.clientEffort,
    mappingStatus: "unknown_client_value",
    reasoningCapabilitySource: capability.source,
    reasoningControlMode: capability.controlMode,
  };
  const target = maxCanonicalEffort(client, input.presetEffort);
  if (!target) return {
    mappingStatus: "model_default",
    reasoningCapabilitySource: capability.source,
    reasoningControlMode: capability.controlMode,
  };
  const mapped = resolveSupportedReasoningEffort(target, capability.supportedEfforts);
  const wire = mapped.effort ? capability.wireMapping[mapped.effort] ?? capability.wireMapping[target] ?? mapped.effort : undefined;
  return {
    clientRequestedReasoningEffort: input.clientEffort,
    presetReasoningEffort: input.presetEffort,
    targetCanonicalReasoningEffort: target,
    resolvedReasoningEffort: mapped.effort,
    wireReasoningEffort: wire,
    mappingStatus: mapped.status,
    reasoningCapabilitySource: capability.source,
    reasoningControlMode: capability.controlMode,
  };
}
