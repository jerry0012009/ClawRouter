import { describe, expect, it } from "vitest";
import { AlphaRepository } from "../src/alpha/repository.js";

describe("batch health repository", () => {
  it("uses one query for channels and one query for Profiles", async () => {
    const calls: string[] = [];
    const database = {
      async query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
        calls.push(sql);
        return { rows: [] };
      },
    } as never;
    const repository = new AlphaRepository(database);
    await repository.batchChannelHealth(Array.from({ length: 100 }, (_, index) => `channel-${index}`));
    await repository.batchProfileHealth(Array.from({ length: 100 }, (_, index) => `profile-${index}`));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("ANY($1::text[])");
    expect(calls[1]).toContain("ANY($1::text[])");
  });
});
