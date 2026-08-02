import { describe, expect, it } from "vitest";
import { decideReasoning, resolveSupportedReasoningEffort } from "../src/alpha/reasoning-capability.js";
import { isReasoningTransportError, prepareProviderBody } from "../src/alpha/processor.js";
import type { AlphaExecutionProfile } from "../src/alpha/routing.js";
import type { CanonicalEnvelope } from "../src/alpha/protocol/types.js";

const profile = (protocol: "responses" | "messages", mode: AlphaExecutionProfile["reasoningControlMode"] | "messages_effort" = "standard_effort"): AlphaExecutionProfile => ({
  executionProfileId: `p:${protocol}`, modelId: "gpt-5.6-luna", provider: "p", channel: "c", protocols: [protocol],
  toolCallSupport: true, thinkingSupport: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  reasoningControlMode: mode as AlphaExecutionProfile["reasoningControlMode"], health: "healthy", enabled: true, administratorAllowed: true,
});
const envelope = (protocol: "responses" | "messages", effort?: string): CanonicalEnvelope => ({ protocol, requestedModel: "acu-auto", stream: true,
  instructions: "", history: [], tools: [], requiredToolTypes: [], clientDeclaredWebTool: false, hostedWebRequired: false, webIntent: "not_required",
  webIntentConfidence: 1, webIntentReason: "test", webIntentEvidence: [], webActuallyInvoked: false, humanCandidates: [], toolCalls: [], toolResults: [],
  planning: { started: false, finished: false, updated: false, evidence: [] }, reasoningEffort: effort, containsThinking: Boolean(effort), thinkingSignatures: [], historyHash: "h", raw: {} });

describe("model-level reasoning capability", () => {
  it("maps aliases upward or caps without changing the model", () => {
    expect(resolveSupportedReasoningEffort("max", ["low", "medium", "high", "xhigh"])).toEqual({ effort: "xhigh", status: "capped_to_model_max" });
    expect(resolveSupportedReasoningEffort("xhigh", ["low", "medium", "high", "max"])).toEqual({ effort: "max", status: "upgraded_alias" });
    expect(resolveSupportedReasoningEffort("max", ["low", "medium", "high"])).toEqual({ effort: "high", status: "capped_to_model_max" });
  });

  it("combines explicit client and preset efforts", () => {
    const lunaMax = decideReasoning({ mode: "acu-auto", clientEffort: "high", presetEffort: "max", modelId: "gpt-5.6-luna", protocol: "responses" });
    expect(lunaMax).toMatchObject({ targetCanonicalReasoningEffort: "max", resolvedReasoningEffort: "max", wireReasoningEffort: "max" });
    expect(decideReasoning({ mode: "acu-auto", clientEffort: "high", modelId: "gpt-5.6-luna", protocol: "responses" })).toMatchObject({ resolvedReasoningEffort: "high", mappingStatus: "exact" });
    expect(decideReasoning({ mode: "acu-auto", clientEffort: "weird", presetEffort: "max", modelId: "gpt-5.6-luna", protocol: "responses" })).toMatchObject({ resolvedReasoningEffort: "weird", mappingStatus: "unknown_client_value" });
  });

  it("preserves explicit effort and body exactly apart from model resolution", () => {
    const decision = decideReasoning({ mode: "explicit", clientEffort: "max", modelId: "gpt-5.6-luna", protocol: "responses" });
    const body = prepareProviderBody(Buffer.from(JSON.stringify({ model: "gpt-5.6-luna", input: [], reasoning: { effort: "max", summary: "auto" } })), "gpt-5.6-luna", envelope("responses", "max"), profile("responses"), decision);
    expect(JSON.parse(body.body.toString()).reasoning).toEqual({ effort: "max", summary: "auto" });
    expect(body.providerReasoningOverrideApplied).toBe(false);
  });

  it("injects Responses and Messages effort without deleting thinking", () => {
    const decision = { ...decideReasoning({ mode: "acu-auto", clientEffort: "high", modelId: "gpt-5.6-luna", protocol: "responses" }), reasoningControlMode: "standard_effort" as const };
    expect(JSON.parse(prepareProviderBody(Buffer.from('{"model":"acu-auto","input":[],"reasoning":{"summary":"auto"}}'), "gpt-5.6-luna", envelope("responses"), profile("responses"), decision).body.toString()).reasoning).toEqual({ summary: "auto", effort: "high" });
    const messagesDecision = { ...decision, reasoningControlMode: "messages_effort" as const };
    const messages = JSON.parse(prepareProviderBody(Buffer.from('{"model":"acu-auto","messages":[],"thinking":{"type":"enabled","budget_tokens":1000}}'), "gpt-5.6-luna", envelope("messages"), profile("messages", "messages_effort"), messagesDecision).body.toString());
    expect(messages.output_config.effort).toBe("high");
    expect(messages.thinking).toEqual({ type: "enabled", budget_tokens: 1000 });
  });

  it("removes only the auto effort for provider-default fallback", () => {
    const decision = decideReasoning({ mode: "acu-auto", clientEffort: "high", modelId: "gpt-5.6-luna", protocol: "responses" });
    const fallback = { ...decision, resolvedReasoningEffort: undefined, wireReasoningEffort: undefined,
      mappingStatus: "provider_fallback_to_default" as const, providerReasoningOverrideApplied: false };
    const prepared = prepareProviderBody(
      Buffer.from('{"model":"acu-auto","input":[],"reasoning":{"effort":"high","summary":"auto"}}'),
      "gpt-5.6-luna", envelope("responses", "high"), profile("responses"), fallback,
    );
    expect(JSON.parse(prepared.body.toString()).reasoning).toEqual({ summary: "auto" });
  });

  it("falls back from a preset to the mapped client effort without deleting it", () => {
    const initial = decideReasoning({ mode: "acu-auto", clientEffort: "high", presetEffort: "max", modelId: "gpt-5.6-luna", protocol: "responses" });
    const client = decideReasoning({ mode: "acu-auto", clientEffort: "high", modelId: "gpt-5.6-luna", protocol: "responses" });
    const fallback = { ...initial, resolvedReasoningEffort: client.resolvedReasoningEffort,
      wireReasoningEffort: client.wireReasoningEffort, mappingStatus: "provider_fallback_to_client_effort" as const };
    const prepared = prepareProviderBody(
      Buffer.from('{"model":"acu-auto","input":[],"reasoning":{"effort":"high","summary":"auto"}}'),
      "gpt-5.6-luna", envelope("responses", "high"), profile("responses"), fallback,
    );
    expect(JSON.parse(prepared.body.toString()).reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(prepared).toMatchObject({ resolvedReasoningEffort: "high", wireReasoningEffort: "high",
      mappingStatus: "provider_fallback_to_client_effort", providerReasoningOverrideApplied: true });
  });

  it("classifies only explicit pre-output reasoning parameter rejection", () => {
    const failure = (body: string, status = 400, visible = 0) => ({ status, headers: {}, body: Buffer.from(body),
      observation: { rawResponseBytes: body.length, modelVisibleOutputBytes: visible } });
    expect(isReasoningTransportError(failure('{"error":{"message":"unsupported output_config.effort max"}}'))).toBe(true);
    expect(isReasoningTransportError(failure('{"error":{"message":"invalid reasoning effort"}}'))).toBe(true);
    expect(isReasoningTransportError(failure("provider unavailable", 503))).toBe(false);
    expect(isReasoningTransportError(failure("invalid reasoning effort", 400, 1))).toBe(false);
  });
});
