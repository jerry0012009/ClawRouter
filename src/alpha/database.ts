import { readFile } from "node:fs/promises";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { Pool } from "pg";

export type SqlExecutor = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
};

export type AlphaDatabaseOptions = {
  connectionString: string;
  maxConnections?: number;
  applicationName?: string;
};

export class AlphaDatabase implements SqlExecutor {
  readonly pool: Pool;

  constructor(options: AlphaDatabaseOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      application_name: options.applicationName ?? "acu-router-alpha",
    });
  }

  query<R extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, [...values]);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async migrate(path = new URL("../../migrations/acu/0001_alpha_p0.sql", import.meta.url)): Promise<void> {
    await this.pool.query(await readFile(path, "utf8"));
    if (path.pathname.endsWith("0001_alpha_p0.sql")) {
      await this.pool.query(await readFile(new URL("../../migrations/acu/0002_provider_channel_health.sql", import.meta.url), "utf8"));
      await this.pool.query(await readFile(new URL("../../migrations/acu/0003_web_intent_source.sql", import.meta.url), "utf8"));
      await this.pool.query(await readFile(new URL("../../migrations/acu/0004_rc2_context_ledger.sql", import.meta.url), "utf8"));
      await this.pool.query(await readFile(new URL("../../migrations/acu/0005_rc2_judge_reconciliation.sql", import.meta.url), "utf8"));
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
