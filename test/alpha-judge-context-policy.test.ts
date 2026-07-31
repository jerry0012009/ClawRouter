import { describe, expect, it } from "vitest";
import { buildJudgeNativeContext } from "../src/alpha/judge-context-policy.js";

describe("Judge native context policy", () => {
  it("keeps full_native byte-for-byte identical", () => {
    const rawRequest = JSON.stringify({ input: [{ role: "user", content: "keep this" }] });
    expect(buildJudgeNativeContext({ rawRequest })).toMatchObject({
      policy: "full_native", body: rawRequest, compacted: false, compactedItemCount: 0,
    });
  });

  it("compacts only eligible large machine output and preserves user content", () => {
    const rawRequest = JSON.stringify({ input: [
      { role: "user", content: "root goal" },
      { type: "function_call_output", output: "x".repeat(20_000), status: "completed" },
    ] });
    const result = buildJudgeNativeContext({ rawRequest, policy: "loss_aware_compacted", compactThresholdTokens: 1 });
    expect(result.compacted).toBe(true);
    expect(result.compactedItemCount).toBe(1);
    expect(result.body).toContain("root goal");
    expect(result.body).toContain("COMPACTED_CONTEXT_ITEM");
  });

  it("does not compact failed or rejected evidence", () => {
    const rawRequest = JSON.stringify({ input: [{ type: "function_call_output", status: "failed", output: "error details ".repeat(2_000) }] });
    const result = buildJudgeNativeContext({ rawRequest, policy: "loss_aware_compacted", compactThresholdTokens: 1 });
    expect(result.compactedItemCount).toBe(0);
    expect(result.body).toContain("error details");
  });
});
