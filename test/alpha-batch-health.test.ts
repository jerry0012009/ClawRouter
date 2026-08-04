import { describe, expect, it } from "vitest";
import { AlphaRepository } from "../src/alpha/repository.js";

describe("batch health repository", () => {
  it("uses one query for channels and one query for Profiles", async () => {
    const calls: string[] = [];
    const parameters: unknown[][] = [];
    const database = {
      async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
        calls.push(sql);
        parameters.push(values ?? []);
        return { rows: [] };
      },
    } as never;
    const repository = new AlphaRepository(database);
    await repository.batchChannelHealth(Array.from({ length: 100 }, (_, index) => `channel-${index}`));
    await repository.batchProfileHealth(Array.from({ length: 100 }, (_, index) => `profile-${index}`));
    await repository.batchProfileRuntimeMetrics(
      Array.from({ length: 100 }, (_, index) => `profile-${index}`),
      "standard",
      {
        windowHours: 24,
        longContextThresholdTokens: 100_000,
        minimumSamples: 5,
        unknownLatencyMultiplier: 1.2,
      },
      {
        windowHours: 24,
        minimumSamples: 5,
        unknownDefault: 0.75,
        degradedMultiplier: 0.85,
      },
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("ANY($1::text[])");
    expect(calls[1]).toContain("ANY($1::text[])");
    expect(calls[2]).toContain("ANY($1::text[])");
    expect(calls[2]).toContain("percentile_cont(.5)");
    expect(calls[2]).toContain("http_status IN (408,429)");
    expect(parameters[2]?.[1]).toBe("standard");
    expect(parameters[2]?.[2]).toBe(24);
    expect(parameters[2]?.[3]).toBe(24);
  });
});
