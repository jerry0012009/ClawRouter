import { describe, expect, it } from "vitest";
import { prepareProviderBody } from "../src/alpha/processor.js";
import type { CanonicalEnvelope } from "../src/alpha/protocol/types.js";
import type { AlphaExecutionProfile } from "../src/alpha/routing.js";

const envelope = (protocol: "responses" | "messages"): CanonicalEnvelope => ({
  protocol,
  raw: {},
  requestedModel: "acu-auto",
  stream: true,
  input: [],
  tools: [],
  toolCalls: [],
  toolResults: [],
  humanCandidates: [],
  historyHash: "test",
  requiredToolTypes: [],
  containsThinking: true,
  reasoningEffort: "medium",
  clientDeclaredWebTool: false,
  hostedWebRequired: false,
  webIntent: "not_required",
  webIntentConfidence: 1,
  webIntentReason: "test",
  webIntentEvidence: [],
  webIntentSource: "judge",
  planning: { started: true, updated: false },
});

const profile = (protocol: "responses" | "messages"): AlphaExecutionProfile => ({
  executionProfileId: `test:${protocol}`,
  modelId: "gpt-5.6-sol",
  providerModelId: "gpt-5.6-sol",
  provider: "test",
  channel: "test",
  protocols: [protocol],
  toolCallSupport: true,
  thinkingSupport: true,
  health: "healthy",
  enabled: true,
  administratorAllowed: true,
});

describe("Plan reasoning escalation", () => {
  it.each(["responses", "messages"] as const)("writes high reasoning for %s", (protocol) => {
    const raw = protocol === "responses"
      ? { model: "acu-auto", input: [], reasoning: { effort: "medium" } }
      : { model: "acu-auto", messages: [], thinking: { type: "enabled", budget_tokens: 8_000 } };
    const body = prepareProviderBody(
      Buffer.from(JSON.stringify(raw)),
      "gpt-5.6-sol",
      envelope(protocol),
      profile(protocol),
      "high",
    );
    const parsed = JSON.parse(body.body.toString("utf8")) as Record<string, any>;
    expect(parsed.model).toBe("gpt-5.6-sol");
    if (protocol === "responses") expect(parsed.reasoning.effort).toBe("high");
    else expect(parsed.thinking.budget_tokens).toBe(8_000);
  });

  it("does not override an explicit low effort", () => {
    const body = prepareProviderBody(
      Buffer.from(JSON.stringify({ model: "acu-auto", input: [] })),
      "gpt-5.6-sol",
      envelope("responses"),
      profile("responses"),
      undefined,
    );
    expect(JSON.parse(body.body.toString("utf8")).reasoning).toBeUndefined();
  });
});
