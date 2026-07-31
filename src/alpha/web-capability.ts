import type { AlphaProtocol } from "./repository.js";
import type { WebIntent } from "./protocol/types.js";

export type ModelWebCapability = "supported" | "unsupported" | "unknown";
export type WebTransportStatus = "verified" | "compatible_unverified" | "incompatible";
export type WebEligibilityConfidence = "verified" | "optimistic" | "not_applicable";

type WebCapableProfile = {
  modelId: string;
  protocols: AlphaProtocol[];
  webTransportStatus?: WebTransportStatus;
  webSearchExecutionVerified?: boolean;
  webSearchLastVerifiedAt?: string;
  webSearchFailureReason?: string;
};

type WebRequirements = {
  protocol: AlphaProtocol;
  webIntent?: WebIntent;
  clientDeclaredWebTool?: boolean;
};

const MODEL_WEB_CAPABILITIES: Readonly<Record<string, ModelWebCapability>> = {
  "gpt-5.4-mini": "supported",
  "gpt-5.5": "supported",
  "gpt-5.6-luna": "supported",
  "gpt-5.6-terra": "supported",
  "gpt-5.6-sol": "supported",
  "claude-fable-5": "supported",
  "claude-opus-4-8": "supported",
  "claude-sonnet-5": "supported",
  "gemini-2.5-flash": "supported",
  "gemini-3.5-flash": "supported",
  "glm-5.1": "supported",
  "glm-5.2": "supported",
  "kimi-k2.6": "supported",
  "kimi-k2.7-code": "unknown",
  "kimi-k3": "supported",
  "qwen3.5-flash": "supported",
  "qwen3.6-plus": "supported",
  "qwen3.7-max": "supported",
  "deepseek-v4-flash": "unsupported",
  "deepseek-v4-pro": "unsupported",
  "deepseek/deepseek-chat-v3-0324": "unsupported",
  "meta-llama/llama-3.3-70b-instruct": "unsupported",
  "meta-llama/llama-4-maverick": "unsupported",
};

const EXPLICIT_INCOMPATIBILITY_REASONS = new Set([
  "web_search_output_item_missing",
  "web_tool_rejected",
  "web_tool_unsupported",
  "web_search_protocol_incompatible",
]);

export function modelWebCapability(modelId: string): ModelWebCapability {
  return MODEL_WEB_CAPABILITIES[modelId] ?? "unknown";
}

export function webTransportStatus(profile: WebCapableProfile): WebTransportStatus {
  if (profile.webTransportStatus) return profile.webTransportStatus;
  if (profile.webSearchExecutionVerified || profile.webSearchLastVerifiedAt) return "verified";
  if (profile.webSearchFailureReason && EXPLICIT_INCOMPATIBILITY_REASONS.has(profile.webSearchFailureReason)) {
    return "incompatible";
  }
  return "compatible_unverified";
}

export function resolveWebEligibility(
  profile: WebCapableProfile,
  requirements: WebRequirements,
): {
  eligible: boolean;
  confidence: WebEligibilityConfidence;
  modelCapability: ModelWebCapability;
  transportStatus: WebTransportStatus;
  reason: string;
} {
  const modelCapability = modelWebCapability(profile.modelId);
  const transportStatus = webTransportStatus(profile);

  // Client-side Web tools do not require Provider-hosted Web execution.
  if (requirements.webIntent !== "required" || !requirements.clientDeclaredWebTool) {
    return {
      eligible: true,
      confidence: "not_applicable",
      modelCapability,
      transportStatus,
      reason: "hosted_web_execution_not_required",
    };
  }
  if (modelCapability !== "supported") {
    return {
      eligible: false,
      confidence: "not_applicable",
      modelCapability,
      transportStatus,
      reason: modelCapability === "unsupported" ? "web_model_unsupported" : "web_model_capability_unknown",
    };
  }
  if (!profile.protocols.includes(requirements.protocol)
    || !["responses", "messages"].includes(requirements.protocol)) {
    return {
      eligible: false,
      confidence: "not_applicable",
      modelCapability,
      transportStatus,
      reason: "web_transport_protocol_unsupported",
    };
  }
  if (transportStatus === "incompatible") {
    return {
      eligible: false,
      confidence: "not_applicable",
      modelCapability,
      transportStatus,
      reason: "web_transport_incompatible",
    };
  }
  return {
    eligible: true,
    confidence: transportStatus === "verified" ? "verified" : "optimistic",
    modelCapability,
    transportStatus,
    reason: transportStatus === "verified" ? "web_transport_verified" : "web_transport_optimistic_passthrough",
  };
}

export function compareWebPreference(
  left: WebCapableProfile,
  right: WebCapableProfile,
  requirements: WebRequirements,
): number {
  if (requirements.webIntent !== "required" || !requirements.clientDeclaredWebTool) return 0;
  const rank = (profile: WebCapableProfile): number => (
    resolveWebEligibility(profile, requirements).confidence === "verified" ? 0 : 1
  );
  return rank(left) - rank(right);
}
