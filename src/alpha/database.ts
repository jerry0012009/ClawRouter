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
    if (!path.pathname.endsWith("0001_alpha_p0.sql")) {
      await this.pool.query(await readFile(path, "utf8"));
      return;
    }
    const foundation = await this.pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.acu_sessions')::text name",
    );
    if (!foundation.rows[0]?.name) {
      await this.pool.query(await readFile(path, "utf8"));
    }
    const migrations = [
      "0002_provider_channel_health", "0003_web_intent_source", "0004_rc2_context_ledger",
      "0005_rc2_judge_reconciliation", "0006_rc21_cost_semantics", "0007_rc22_judge_cutover",
      "0008_alpha_final_user_loop", "0009_raw_judge_context", "0010_supply_observability",
      "0011_verified_model_pool_probe", "0012_profile_policy_probe_worker", "0013_full_pool_probe_runs",
      "0014_judge_same_model_failover", "0015_judge_profile_attempt_limit", "0016_judge_profile_attempt_limit_5",
    ];
    for (const migration of migrations) {
      const migrationTable = await this.pool.query<{ name: string | null }>(
        "SELECT to_regclass('public.acu_schema_migrations')::text name",
      );
      if (migrationTable.rows[0]?.name) {
        const applied = await this.pool.query(
          "SELECT 1 FROM acu_schema_migrations WHERE migration_version=$1",
          [migration],
        );
        if (applied.rowCount) continue;
      }
      await this.pool.query(await readFile(
        new URL(`../../migrations/acu/${migration}.sql`, import.meta.url),
        "utf8",
      ));
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
