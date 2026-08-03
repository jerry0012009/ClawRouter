import { describe, expect, it } from "vitest";
import { ModelOutputObserver } from "../src/alpha/model-output.js";

function observe(...events: Array<Record<string, unknown>>) {
  const observer = new ModelOutputObserver(Date.now());
  observer.observe(Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
  return observer.result();
}

describe("Alpha model output observation", () => {
  it.each([
    "response.reasoning_text.delta",
    "response.reasoning_summary_text.delta",
    "response.output_item.done",
    "response.function_call_arguments.delta",
    "response.custom_tool_call_input.delta",
  ])("treats %s as model-visible output", (type) => {
    expect(observe({ type, delta: "value" }).modelVisibleOutputBytes).toBeGreaterThan(0);
  });

  it("does not treat control events as model output", () => {
    expect(observe({ type: "response.created" }, { type: "ping" }).modelVisibleOutputBytes).toBe(0);
  });

  it("records max_output_tokens as an incomplete generation terminal", () => {
    expect(observe(
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
    )).toMatchObject({
      terminalKind: "incomplete",
      incompleteReason: "max_output_tokens",
      protocolCompleted: false,
    });
  });
});
