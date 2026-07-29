import { describe, expect, it } from "vitest";
import { inspectWebSearchEvidence, WebSearchStreamObserver } from "../src/alpha/web-search.js";
import { normalizeResponsesRequest } from "../src/alpha/protocol/responses.js";
import { prepareProviderBody } from "../src/alpha/processor.js";
import type { AlphaExecutionProfile } from "../src/alpha/routing.js";

describe("Responses Web Search evidence", () => {
  it("recognizes actual streaming Web Search lifecycle events", () => {
    const observer = new WebSearchStreamObserver();
    observer.observe(Buffer.from('data: {"type":"response.web_search_call.in_progress"}\n\n'));
    observer.observe(Buffer.from('data: {"type":"response.web_search_call.searching"}\n\n'));
    observer.observe(Buffer.from('data: {"type":"response.web_search_call.completed","item":{"type":"web_search_call","status":"completed"}}\n\n'));
    expect(observer.evidence()).toMatchObject({
      actuallyInvoked: true,
      eventStatus: ["in_progress", "searching", "completed"],
      executionCompleted: true,
      resultVerified: true,
    });
    expect(observer.evidence().searchLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("does not infer invocation from a declaration-only response", () => {
    const evidence = inspectWebSearchEvidence(Buffer.from(JSON.stringify({
      type: "response.completed",
      response: { output: [{ type: "message", content: [] }] },
    })), "application/json");
    expect(evidence.actuallyInvoked).toBe(false);
  });

  it("prunes only an unneeded hosted Web Tool for an incompatible Profile", () => {
    const raw = Buffer.from(JSON.stringify({
      model: "acu-auto",
      input: "Modify one file and run check.sh",
      tools: [
        { type: "web_search" },
        { type: "function", name: "exec_command" },
        { type: "function", name: "apply_patch" },
        { type: "local_shell" },
      ],
    }));
    const envelope = normalizeResponsesRequest(JSON.parse(raw.toString("utf8")));
    const profile: AlphaExecutionProfile = {
      executionProfileId: "test:mini:responses",
      modelId: "gpt-5.4-mini",
      provider: "test",
      channel: "test",
      protocols: ["responses"],
      toolCallSupport: true,
      supportedToolTypes: ["function", "local_tool"],
      thinkingSupport: true,
      contextWindow: 100_000,
      health: "healthy",
      enabled: true,
      administratorAllowed: true,
      webToolDeclarationAccepted: false,
    };
    const prepared = prepareProviderBody(raw, profile.modelId, envelope, profile);
    const tools = (JSON.parse(prepared.body.toString("utf8")) as { tools: Array<{ type: string; name?: string }> }).tools;
    expect(prepared.webToolPruned).toBe(true);
    expect(tools).toEqual([
      { type: "function", name: "exec_command" },
      { type: "function", name: "apply_patch" },
      { type: "local_shell" },
    ]);
  });

  it("forwards the declaration unchanged when the Profile accepts it", () => {
    const raw = Buffer.from(JSON.stringify({ model: "gpt-5.4-mini", input: "Read one file", tools: [{ type: "web_search" }] }));
    const envelope = normalizeResponsesRequest(JSON.parse(raw.toString("utf8")));
    const profile: AlphaExecutionProfile = {
      executionProfileId: "test:mini:web",
      modelId: "gpt-5.4-mini",
      provider: "test",
      channel: "test",
      protocols: ["responses"],
      toolCallSupport: true,
      thinkingSupport: true,
      contextWindow: 100_000,
      health: "healthy",
      enabled: true,
      administratorAllowed: true,
      webToolDeclarationAccepted: true,
    };
    const prepared = prepareProviderBody(raw, profile.modelId, envelope, profile);
    expect(prepared.webToolPruned).toBe(false);
    expect(prepared.body.equals(raw)).toBe(true);
  });
});
