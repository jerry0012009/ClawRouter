import { describe, expect, it } from "vitest";
import {
  modelWebCapability,
  resolveWebEligibility,
  webTransportStatus,
} from "../src/alpha/web-capability.js";

const requirements = {
  protocol: "responses" as const,
  webIntent: "required" as const,
  clientDeclaredWebTool: true,
  hostedWebRequired: true,
};

const profile = {
  modelId: "gpt-5.6-luna",
  protocols: ["responses" as const],
};

describe("Alpha Web capability", () => {
  it("keeps canonical model capability independent from Channel health", () => {
    expect(modelWebCapability("gpt-5.6-luna")).toBe("supported");
    expect(modelWebCapability("claude-sonnet-5")).toBe("supported");
    expect(modelWebCapability("gemini-2.5-flash")).toBe("supported");
    expect(modelWebCapability("glm-5.2")).toBe("supported");
    expect(modelWebCapability("kimi-k3")).toBe("supported");
    expect(modelWebCapability("qwen3.7-max")).toBe("supported");
    expect(modelWebCapability("deepseek-v4-pro")).toBe("unsupported");
    expect(modelWebCapability("kimi-k2.7-code")).toBe("unknown");
    expect(modelWebCapability("unknown-model")).toBe("unknown");
  });

  it("optimistically admits a supported model on an unverified pass-through transport", () => {
    expect(resolveWebEligibility({
      ...profile,
      webSearchFailureReason: "not_verified_for_full_pool_profile",
    }, requirements)).toMatchObject({
      eligible: true,
      confidence: "optimistic",
      transportStatus: "compatible_unverified",
    });
  });

  it("prefers runtime success evidence over an old static failure reason", () => {
    expect(webTransportStatus({
      ...profile,
      webTransportStatus: "verified",
      webSearchFailureReason: "web_search_output_item_missing",
    })).toBe("verified");
  });

  it("excludes only explicit transport incompatibility", () => {
    expect(resolveWebEligibility({
      ...profile,
      webSearchFailureReason: "web_search_output_item_missing",
    }, requirements)).toMatchObject({
      eligible: false,
      transportStatus: "incompatible",
      reason: "web_transport_incompatible",
    });
  });

  it("does not require hosted execution when Web is provided by client tools", () => {
    expect(resolveWebEligibility({
      modelId: "unknown-model",
      protocols: ["messages"],
    }, {
      protocol: "messages",
      webIntent: "required",
      clientDeclaredWebTool: false,
    })).toMatchObject({
      eligible: true,
      confidence: "not_applicable",
      reason: "hosted_web_execution_not_required",
    });
  });

  it("admits native Anthropic Messages Web Search for a supported Claude model", () => {
    expect(resolveWebEligibility({
      modelId: "claude-sonnet-5",
      protocols: ["messages"],
    }, {
      protocol: "messages",
      webIntent: "required",
      clientDeclaredWebTool: true,
      hostedWebRequired: true,
    })).toMatchObject({
      eligible: true,
      confidence: "optimistic",
      transportStatus: "compatible_unverified",
    });
  });
});
