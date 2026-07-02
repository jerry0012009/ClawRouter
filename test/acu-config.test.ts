import { describe, expect, it } from "vitest";
import { buildProxyModelList, validateRoutingConfigModels } from "../src/proxy.js";
import { DEFAULT_ROUTING_CONFIG } from "../src/router/config.js";
import { BLOCKRUN_MODELS, getUpstream, UnknownModelError } from "../src/models.js";

describe("ACU routing model configuration", () => {
  it("references only models defined in BLOCKRUN_MODELS", () => {
    expect(() => validateRoutingConfigModels(DEFAULT_ROUTING_CONFIG, BLOCKRUN_MODELS)).not.toThrow();
  });

  it("throws for unknown model IDs instead of defaulting to proxy", () => {
    expect(() => getUpstream("missing/provider-model")).toThrow(UnknownModelError);
  });

  it("returns pricing, context, upstream, and capability metadata from /v1/models builder", () => {
    const models = buildProxyModelList();
    const sample = models.find((model) => model.id === "gpt-4o");

    expect(sample).toMatchObject({
      id: "gpt-4o",
      name: "GPT-4o",
      object: "model",
      owned_by: "proxy",
      upstream: "proxy",
      pricing: {
        prompt: 2.5,
        completion: 10,
        cache_read: 1.25,
        cache_write: 2.5,
      },
      context_length: 128_000,
      max_completion_tokens: 16_384,
      capabilities: {
        reasoning: false,
        vision: true,
        tool_calling: true,
      },
    });
  });
});
