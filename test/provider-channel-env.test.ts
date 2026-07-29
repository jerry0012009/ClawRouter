import { describe, expect, it } from "vitest";
import { inferMultiplier, normalizedEnv, parseProviderEnv, validateDotenv } from "../tools/provider-channels/normalize-env.js";

describe("Provider Channel dotenv normalization", () => {
  it("reads the billing multiplier rather than digits embedded in a group name", () => {
    expect(inferMultiplier("cx-006-plus-0.06x")).toBe(0.06);
    expect(inferMultiplier("cx017-pro-保首字,不断-0.17x")).toBe(0.17);
    expect(inferMultiplier("cx003-低价")).toBeNull();
  });
  it("parses labels, deduplicates keys, preserves unrelated assignments, and emits valid dotenv", () => {
    const fixture = [
      "UNRELATED=value  ",
      "https://blackaicoding.com/",
      "codex混合渠道--低价1x",
      ["sk", "black-fixture-000000000000"].join("-"),
      ["sk", "black-fixture-000000000000"].join("-"),
      "https://lucen.cc",
      "cx017-pro-保首字,不断-0.17x",
      ["sk", "lucen-fixture-000000000000"].join("-"),
    ].join("\n");
    const parsed = parseProviderEnv(fixture);
    expect(parsed.preservedAssignments).toEqual([{ name: "UNRELATED", value: "value" }]);
    expect(parsed.channels).toHaveLength(2);
    expect(parsed.channels[0]).toMatchObject({ providerId: "blackai", routingGroupSlug: "codex_mix_low" });
    expect(parsed.channels[1]).toMatchObject({ providerId: "lucen", routingGroupSlug: "cx017_pro_first_token", observedBillingMultiplier: 0.17 });
    const output = normalizedEnv(parsed).replaceAll(/sk-[A-Za-z0-9._-]+/g, "<SECRET>");
    expect(output).toContain("ACU_CHANNEL_BLACKAI_CODEX_MIX_LOW_API_KEY=<SECRET>");
    expect(() => validateDotenv(normalizedEnv(parsed))).not.toThrow();
  });

  it("keeps ambiguous secrets out of mapped Channels", () => {
    const parsed = parseProviderEnv(`UNKNOWN_KEY=${["sk", "unknown-fixture-000000000000"].join("-")}\n`);
    expect(parsed.channels).toHaveLength(0);
    expect(parsed.needsMapping).toHaveLength(1);
  });
});
