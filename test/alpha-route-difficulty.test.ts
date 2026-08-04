import { describe, expect, it } from "vitest";
import type { AlphaJudgeRun } from "../src/alpha/judge-runner.js";
import { resolveRouteDifficulty, routeDisplaySummary } from "../src/alpha/processor.js";
import type { AlphaRouteDecision } from "../src/alpha/routing.js";

function judgeAt(difficultyIndex: number): AlphaJudgeRun {
  return { judge: { difficultyIndex } } as AlphaJudgeRun;
}

describe("route difficulty recovery", () => {
  it("prefers the current Judge over stored route values", () => {
    expect(resolveRouteDifficulty(judgeAt(61), {
      decisionSnapshot: { difficultyIndex: 52 },
      judge: { difficultyIndex: 43 },
    })).toBe(61);
  });

  it("restores difficulty from a stored route when a refreshed route has no current Judge", () => {
    expect(resolveRouteDifficulty(undefined, {
      decisionSnapshot: { difficultyIndex: 52 },
      judge: { difficultyIndex: 43 },
    })).toBe(52);
  });

  it("keeps stored difficulty when a refreshed route exists without a current Judge", () => {
    const route = {
      preference: "balanced",
      candidateEstimates: [{ candidateId: "luna", modelId: "gpt-5.6-luna", conservativeScore: 90, expectedTotalCost: 1 }],
      recommendation: {
        recommended: { candidateId: "luna", modelId: "gpt-5.6-luna", displayName: "Luna" },
        reason: "fixture",
      },
      providerSelectionReason: "fixture",
      selectedProfile: { provider: "lucen" },
    } as unknown as AlphaRouteDecision;
    const summary = routeDisplaySummary("acu-auto", "gpt-5.6-luna", "balanced", undefined, route, {
      formula_inputs_json: { decisionSnapshot: { difficultyIndex: 52 } },
    });
    expect(summary.difficulty).toBe(52);
  });

  it("falls back to the stored Judge when the decision snapshot is missing", () => {
    expect(resolveRouteDifficulty(undefined, { judge: { difficultyIndex: 43 } })).toBe(43);
  });

  it("keeps an explicit route without Judge data unrecorded", () => {
    expect(resolveRouteDifficulty(undefined, undefined)).toBeUndefined();
    expect(resolveRouteDifficulty(undefined, { decisionSnapshot: { difficultyIndex: null } })).toBeUndefined();
  });
});
