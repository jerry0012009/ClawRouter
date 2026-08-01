import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlphaDatabase } from "../src/alpha/database.js";
import { AdaptiveProbeWorker } from "../src/alpha/adaptive-probe.js";
import { AlphaRepository } from "../src/alpha/repository.js";
import type { NativeProviderAdapter } from "../src/alpha/provider.js";
import type { AlphaExecutionProfile } from "../src/alpha/routing.js";

const databaseUrl = process.env.ACU_TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("Alpha PostgreSQL foundation", () => {
  let database: AlphaDatabase;
  let repository: AlphaRepository;

  beforeAll(async () => {
    database = new AlphaDatabase({ connectionString: databaseUrl!, maxConnections: 2 });
    const down = await readFile(new URL("../migrations/acu/0001_alpha_p0.down.sql", import.meta.url), "utf8");
    await database.query(down);
    await database.migrate();
    repository = new AlphaRepository(database);
  });

  afterAll(async () => {
    const down = await readFile(new URL("../migrations/acu/0001_alpha_p0.down.sql", import.meta.url), "utf8");
    await database.query(down);
    await database.close();
  });

  it("creates P0 tables plus Channel and Profile runtime health tables", async () => {
    const result = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name LIKE 'acu_%' ORDER BY table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "acu_admission_traces",
      "acu_attempts",
      "acu_channel_admin_actions",
      "acu_channel_health",
      "acu_events",
      "acu_full_pool_probe_runs",
      "acu_judge_attempts",
      "acu_judge_evaluations",
      "acu_judge_ledger_entries",
      "acu_logical_requests",
      "acu_payloads",
      "acu_probe_worker_lease",
      "acu_profile_probe_attempts",
      "acu_profile_probe_queue",
      "acu_provider_health",
      "acu_provider_model_profile_health",
      "acu_route_decisions",
      "acu_schema_migrations",
      "acu_segments",
      "acu_sessions",
      "acu_tasks",
      "acu_usage_reports",
    ]);
    expect(result.rows.some((row) => /vector|embedding|memory/i.test(row.table_name))).toBe(false);
  });

  it("applies RC2.1 and RC2.2 migrations with cost and Judge attempt fields", async () => {
    const versions = await database.query<{ migration_version: string }>(
      "SELECT migration_version FROM acu_schema_migrations ORDER BY migration_version",
    );
    expect(versions.rows.map((row) => row.migration_version)).toContain("0006_rc21_cost_semantics");
    expect(versions.rows.map((row) => row.migration_version)).toContain("0007_rc22_judge_cutover");
    expect(versions.rows.map((row) => row.migration_version)).toContain("0008_alpha_final_user_loop");
    expect(versions.rows.map((row) => row.migration_version)).toContain("0015_judge_profile_attempt_limit");
    const judgeAttemptConstraint = await database.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid='acu_judge_attempts'::regclass
       AND conname='acu_judge_attempts_attempt_index_check'`,
    );
    expect(judgeAttemptConstraint.rows[0]?.definition).toContain("attempt_index >= 1");
    expect(judgeAttemptConstraint.rows[0]?.definition).toContain("attempt_index <= 3");
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='acu_usage_reports'`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      "provider_balance_charge",
      "actual_total_cash_cost_cny",
      "judge_official_payg_equivalent_cost",
      "judge_cost_status",
    ]));
  });

  it("enforces one active segment per task and keeps users isolated", async () => {
    await repository.createSession({
      sessionId: "ses_user_a",
      newapiUserId: "user_a",
      clientName: "codex",
      nativeProtocol: "responses",
    });
    await repository.createTask({
      taskId: "task_user_a",
      sessionId: "ses_user_a",
      newapiUserId: "user_a",
      phase: "execution",
      baseQualityTarget: 80,
      status: "active",
    });
    await repository.createSegment({
      segmentId: "seg_user_a_1",
      taskId: "task_user_a",
      newapiUserId: "user_a",
      creationReason: "task_start",
      phase: "execution",
      taskBaseQualityTarget: 80,
      effectiveQualityTarget: 80,
    });
    await expect(repository.createSegment({
      segmentId: "seg_user_a_2",
      taskId: "task_user_a",
      newapiUserId: "user_a",
      creationReason: "human_message",
      phase: "execution",
      taskBaseQualityTarget: 80,
      effectiveQualityTarget: 80,
    })).rejects.toMatchObject({ code: "23505" });
    expect(await repository.findUserScoped("acu_sessions", "session_id", "ses_user_a", "user_b")).toBeUndefined();
    expect(await repository.findUserScoped("acu_sessions", "session_id", "ses_user_a", "user_a")).toBeDefined();
  });

  it("deduplicates events and logical requests within user scope", async () => {
    const firstEvent = await repository.insertEvent({
      eventId: "evt_a_1",
      sessionId: "ses_user_a",
      taskId: "task_user_a",
      segmentId: "seg_user_a_1",
      eventType: "human_message",
      eventHash: "same-event-hash",
      evidenceStrength: "high",
      sourceProtocol: "responses",
      sourceClient: "codex",
    });
    const replay = await repository.insertEvent({
      eventId: "evt_a_2",
      sessionId: "ses_user_a",
      taskId: "task_user_a",
      segmentId: "seg_user_a_1",
      eventType: "human_message",
      eventHash: "same-event-hash",
      evidenceStrength: "high",
      sourceProtocol: "responses",
      sourceClient: "codex",
    });
    expect(firstEvent).toEqual({ eventId: "evt_a_1", inserted: true });
    expect(replay).toEqual({ eventId: "evt_a_1", inserted: false });

    const request = {
      logicalRequestId: "req_a_1",
      newapiUserId: "user_a",
      sessionId: "ses_user_a",
      taskId: "task_user_a",
      segmentId: "seg_user_a_1",
      ingressIdempotencyKey: "ingress-1",
      requestProtocol: "responses" as const,
      requestedModel: "acu-auto",
      streaming: true,
    };
    expect(await repository.createLogicalRequest(request)).toEqual({ logicalRequestId: "req_a_1", inserted: true });
    expect(await repository.createLogicalRequest({ ...request, logicalRequestId: "req_a_2" }))
      .toEqual({ logicalRequestId: "req_a_1", inserted: false });
  });

  it("releases an expired inactive request lease while preserving active idempotency", async () => {
    await database.query(
      "UPDATE acu_logical_requests SET processing_lease_expires_at=now()-interval '1 minute' WHERE logical_request_id='req_a_1'",
    );
    expect(await repository.abandonStaleLogicalRequest("user_a", "ingress-1")).toBe("req_a_1");
    const replacement = {
      logicalRequestId: "req_a_3",
      newapiUserId: "user_a",
      sessionId: "ses_user_a",
      taskId: "task_user_a",
      segmentId: "seg_user_a_1",
      ingressIdempotencyKey: "ingress-1",
      requestProtocol: "responses" as const,
      requestedModel: "acu-auto",
      streaming: true,
    };
    expect(await repository.createLogicalRequest(replacement))
      .toEqual({ logicalRequestId: "req_a_3", inserted: true });
    expect(await repository.createLogicalRequest({ ...replacement, logicalRequestId: "req_a_4" }))
      .toEqual({ logicalRequestId: "req_a_3", inserted: false });
    const states = await database.query<{ logical_request_id: string; status: string }>(
      "SELECT logical_request_id,status FROM acu_logical_requests WHERE ingress_idempotency_key='ingress-1' ORDER BY started_at,logical_request_id",
    );
    expect(states.rows).toEqual([
      { logical_request_id: "req_a_1", status: "abandoned" },
      { logical_request_id: "req_a_3", status: "pending" },
    ]);
  });

  it("removes secrets before payload persistence", async () => {
    await repository.savePayload({
      payloadId: "payload_a_1",
      newapiUserId: "user_a",
      logicalRequestId: "req_a_1",
      payloadKind: "client_request",
      protocol: "responses",
      contentType: "application/json",
      headers: {
        authorization: "Bearer top-secret-value",
        cookie: "sid=private",
        "x-api-key": "private-key",
        "x-request-id": "public-request-id",
      },
      body: {
        model: "acu-auto",
        api_key: "sk-example-super-secret-value",
        input: "Clone https://user:password@example.test/repo and use Bearer local-secret-token",
      },
      isComplete: true,
    });
    const result = await database.query<{
      headers_sanitized_json: Record<string, string>;
      body_json: Record<string, unknown>;
      body_sha256: string;
    }>("SELECT headers_sanitized_json,body_json,body_sha256 FROM acu_payloads WHERE payload_id='payload_a_1'");
    expect(result.rows[0].headers_sanitized_json).toEqual({ "x-request-id": "public-request-id" });
    const serialized = JSON.stringify(result.rows[0].body_json);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("user:password");
    expect(serialized).not.toContain("local-secret-token");
    expect(result.rows[0].body_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("bounds provider attempts and makes usage reports idempotent with exact NUMERIC cost", async () => {
    await repository.createAttempt({
      attemptId: "att_a_1",
      logicalRequestId: "req_a_1",
      attemptIndex: 1,
      attemptKind: "provider",
      retryOwner: "acu",
      provider: "closeai",
      status: "failed",
      actualCostUsd: "0.0000000001",
      providerBilled: true,
    });
    await repository.createAttempt({
      attemptId: "att_a_2",
      logicalRequestId: "req_a_1",
      attemptIndex: 2,
      attemptKind: "provider",
      retryOwner: "acu",
      provider: "closeai",
      status: "success",
    });
    await repository.createAttempt({
      attemptId: "att_a_3",
      logicalRequestId: "req_a_1",
      attemptIndex: 3,
      attemptKind: "provider",
      retryOwner: "acu",
      provider: "closeai",
      status: "success",
    });

    const usage = {
      usageReportId: "usage_a_1",
      logicalRequestId: "req_a_1",
      reportIdempotencyKey: "usage-idempotency-a",
      newapiUserId: "user_a",
      finalUserCostUsd: "0.1234567890",
      costBreakdown: { provider: "0.1234567890" },
    };
    expect(await repository.createUsageReport(usage)).toEqual({ usageReportId: "usage_a_1", inserted: true });
    expect(await repository.createUsageReport({ ...usage, usageReportId: "usage_a_2" }))
      .toEqual({ usageReportId: "usage_a_1", inserted: false });
    const stored = await database.query<{ final_user_cost_usd: string }>(
      "SELECT final_user_cost_usd FROM acu_usage_reports WHERE usage_report_id='usage_a_1'",
    );
    expect(stored.rows[0].final_user_cost_usd).toBe("0.1234567890");
  });

  it("claims, reclaims after a worker crash, and acknowledges the usage outbox", async () => {
    const firstClaim = await repository.claimUsageReports(1);
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]).toMatchObject({
      usageReportId: "usage_a_1",
      reportIdempotencyKey: "usage-idempotency-a",
      sendAttemptCount: 1,
    });

    await database.query(
      "UPDATE acu_usage_reports SET next_send_at=now() WHERE usage_report_id='usage_a_1'",
    );
    const restarted = new AlphaDatabase({ connectionString: databaseUrl!, maxConnections: 1 });
    try {
      const restartedRepository = new AlphaRepository(restarted);
      const reclaimed = await restartedRepository.claimUsageReports(1);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0].sendAttemptCount).toBe(2);
      await restartedRepository.failUsageReport("usage_a_1", "temporary finalize failure", 1);
      expect(await restartedRepository.claimUsageReports(1)).toHaveLength(0);
      await restarted.query(
        "UPDATE acu_usage_reports SET next_send_at=now() WHERE usage_report_id='usage_a_1'",
      );
      expect(await restartedRepository.claimUsageReports(1)).toHaveLength(1);
      await restartedRepository.acknowledgeUsageReport("usage_a_1");
      const state = await restarted.query<{ status: string; send_attempt_count: number }>(
        "SELECT status,send_attempt_count FROM acu_usage_reports WHERE usage_report_id='usage_a_1'",
      );
      expect(state.rows[0]).toEqual({ status: "acknowledged", send_attempt_count: 3 });
    } finally {
      await restarted.close();
    }
  });

  it("restores persisted session and request state through a new pool", async () => {
    const restarted = new AlphaDatabase({ connectionString: databaseUrl!, maxConnections: 1 });
    try {
      const restored = new AlphaRepository(restarted);
      expect(await restored.findUserScoped("acu_logical_requests", "logical_request_id", "req_a_1", "user_a"))
        .toMatchObject({ session_id: "ses_user_a", segment_id: "seg_user_a_1" });
    } finally {
      await restarted.close();
    }
  });

  it("allows exactly one half-open probe and releases the lease", async () => {
    await database.query(
      `INSERT INTO acu_channel_health
       (channel_id,provider_id,circuit_state,cooldown_until,consecutive_failures,recent_success_rate,updated_at)
       VALUES ('channel_probe_test','provider_test','open',now()-interval '1 second',2,0.5,now())`,
    );
    expect(await repository.claimHalfOpenProbe("channel", "channel_probe_test")).toBe(true);
    expect(await repository.claimHalfOpenProbe("channel", "channel_probe_test")).toBe(false);
    await repository.releaseHalfOpenProbe("channel", "channel_probe_test");
    expect(await repository.claimHalfOpenProbe("channel", "channel_probe_test")).toBe(true);
  });

  it("deduplicates the global Probe queue and grants one Worker lease", async () => {
    await database.query("UPDATE acu_probe_worker_lease SET holder_id=null,lease_until=now()-interval '1 second' WHERE singleton=true");
    await database.query(
      `INSERT INTO acu_profile_probe_queue (execution_profile_id) VALUES ('profile_probe_test')
       ON CONFLICT (execution_profile_id) DO UPDATE SET enqueued_at=excluded.enqueued_at`,
    );
    await database.query(
      `INSERT INTO acu_profile_probe_queue (execution_profile_id) VALUES ('profile_probe_test')
       ON CONFLICT (execution_profile_id) DO UPDATE SET enqueued_at=excluded.enqueued_at`,
    );
    const queue = await database.query<{ count: number }>(
      "SELECT count(*)::int count FROM acu_profile_probe_queue WHERE execution_profile_id='profile_probe_test'",
    );
    expect(queue.rows[0]?.count).toBe(1);
    const first = await database.query(
      `UPDATE acu_probe_worker_lease SET holder_id='worker-a',lease_until=now()+interval '2 minutes'
       WHERE singleton=true AND lease_until<=now() RETURNING singleton`,
    );
    const second = await database.query(
      `UPDATE acu_probe_worker_lease SET holder_id='worker-b',lease_until=now()+interval '2 minutes'
       WHERE singleton=true AND lease_until<=now() RETURNING singleton`,
    );
    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(0);
  });

  it("runs one full-pool Probe serially and records reproducible cost metadata", async () => {
    await database.query("TRUNCATE acu_full_pool_probe_runs,acu_profile_probe_attempts,acu_profile_probe_queue");
    await database.query(
      "UPDATE acu_probe_worker_lease SET holder_id=null,lease_until=now()-interval '1 second' WHERE singleton=true",
    );
    await database.query("INSERT INTO acu_profile_probe_queue (execution_profile_id) VALUES ('__full_pool__')");
    const economics = {
      providerId: "lucen", displayName: "Lucen", protocol: "openai_responses",
      baseUrlEnv: "LUCEN_BASE_URL", apiKeyEnv: "LUCEN_API_KEY",
      balanceCurrency: "USD-denominated credits" as const,
      rechargeCashCny: 100, creditsReceivedUsd: 100, observedBillingMultiplier: 0.25,
      priceSource: "fixture", priceObservedAt: "2026-07-31T00:00:00Z",
      health: "healthy" as const, priority: 1, enabled: true,
      effectiveCostStatus: "verified" as const, effectiveCostSource: "fixture", effectiveCostVersion: "fixture-v1",
    };
    const profiles: AlphaExecutionProfile[] = [1, 2, 3].map((index) => ({
      executionProfileId: `full-pool-profile-${index}`,
      modelId: "gpt-5.4-mini",
      providerModelId: "gpt-5.4-mini",
      provider: "lucen",
      channel: `full-pool-channel-${index}`,
      channelId: `full-pool-channel-${index}`,
      protocols: ["responses"],
      toolCallSupport: true,
      thinkingSupport: true,
      contextWindow: 128_000,
      health: "healthy",
      enabled: true,
      administratorAllowed: true,
      usageTrusted: true,
      economics,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const adapter: NativeProviderAdapter = {
      async execute() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return new Response(
          'data: {"type":"response.completed","response":{"model":"gpt-5.4-mini","usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    };
    const failedAdapter: NativeProviderAdapter = {
      async execute() {
        return new Response('{"error":{"message":"fixture rejection"}}', {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const worker = new AdaptiveProbeWorker({
      database,
      profiles,
      adapters: new Map(profiles.map((profile, index) => [profile.executionProfileId, index === 2 ? failedAdapter : adapter])),
      dailyBudgetCny: 1,
    });

    await worker.runOnce();
    await worker.runOnce();

    const runs = await database.query<{
      status: string; profile_count: number; attempted_count: number; success_count: number; cost_cny: string;
    }>("SELECT status,profile_count,attempted_count,success_count,cost_cny::text FROM acu_full_pool_probe_runs");
    expect(runs.rows).toEqual([expect.objectContaining({
      status: "completed", profile_count: 3, attempted_count: 3, success_count: 2,
    })]);
    expect(Number(runs.rows[0]?.cost_cny)).toBeGreaterThan(0);
    expect(maxInFlight).toBe(1);
    const attempts = await database.query<{ metadata_json: Record<string, unknown> }>(
      "SELECT metadata_json FROM acu_profile_probe_attempts ORDER BY execution_profile_id",
    );
    expect(attempts.rows).toHaveLength(3);
    for (const row of attempts.rows.slice(0, 2)) {
      expect(row.metadata_json).toMatchObject({
        probeMode: "full_pool",
        trigger: "manual",
        inputTokens: "10",
        outputTokens: "1",
        actualModel: "gpt-5.4-mini",
        costBreakdown: {
          billingMultiplier: 0.25,
          providerCreditCashCostCny: 1,
        },
      });
      expect(row.metadata_json.fullPoolProbeRunId).toBeTypeOf("string");
    }
    expect(attempts.rows[2]?.metadata_json).toMatchObject({
      probeMode: "full_pool",
      usageSource: "unavailable",
      errorMessage: '{"error":{"message":"fixture rejection"}}',
      costBreakdown: {
        effectiveCostStatus: "unavailable",
        costUnavailableReason: "provider_usage_unavailable",
      },
    });
    const failedCost = await database.query<{ cost_cny: string }>(
      "SELECT cost_cny::text FROM acu_profile_probe_attempts WHERE execution_profile_id='full-pool-profile-3'",
    );
    expect(Number(failedCost.rows[0]?.cost_cny)).toBe(0);
    const marker = await database.query("SELECT 1 FROM acu_profile_probe_queue WHERE execution_profile_id='__full_pool__'");
    expect(marker.rowCount).toBe(0);
  });

  it("returns the complete logical request chain only through the explicit admin lookup", async () => {
    await repository.saveJudgeEvaluation({
      judgeEvaluationId: "judge_a_1",
      newapiUserId: "user_a",
      taskId: "task_user_a",
      segmentId: "seg_user_a_1",
      triggerEventId: "evt_a_1",
      judgeIdempotencyKey: "judge-idempotency-a",
      judgeStatus: "completed",
      judgeResultSource: "rules",
      promptVersion: "alpha-test",
      policyVersion: "alpha-test",
      difficultyMethodVersion: "alpha-test",
      contextHash: "context-hash-a",
      contextTruncated: false,
      difficultyScoreRaw: 50,
      difficultyIndex: 50,
      factors: {},
      probabilities: {},
      evidenceTags: [],
    });
    const judgeAttempt = {
      judgeAttemptId: "judge_attempt_a_1",
      judgeEvaluationId: "judge_a_1",
      logicalRequestId: "req_a_1",
      attemptIndex: 1 as const,
      attemptRole: "primary" as const,
      provider: "xiaomi_mimo",
      model: "mimo-v2.5-pro",
      endpointHost: "mimo.invalid",
      upstreamRequestId: "upstream-a",
      status: "success" as const,
      inputTokens: 1000n,
      cachedInputTokens: 200n,
      outputTokens: 100n,
      latencyMs: 200,
      nominalCostUsd: "0.0004176000",
      officialPaygEquivalentCost: "0.0029200000",
      effectiveCostCny: "0.0014600000",
      currency: "CNY" as const,
      costStatus: "estimated_blended",
      costSource: "midpoint_openrouter_payg_and_mimo99_plan_v1",
      usageStatus: "reported" as const,
    };
    await repository.saveJudgeAttempt(judgeAttempt);
    await repository.saveJudgeAttempt({ ...judgeAttempt, judgeAttemptId: "judge_attempt_a_replay" });
    await repository.saveRouteDecision({
      routeDecisionId: "route_a_1",
      newapiUserId: "user_a",
      segmentId: "seg_user_a_1",
      judgeEvaluationId: "judge_a_1",
      mode: "acu-auto",
      policyVersion: "alpha-test",
      routingModelVersion: "alpha-test",
      qualityCurveVersion: "alpha-test",
      priceVersion: "alpha-test",
      effectiveQualityTarget: 80,
      formulaInputs: {},
      candidateEstimates: [],
      paretoFrontier: [],
      selectedProfile: { executionProfileId: "profile-a" },
    });

    const trace = await repository.getAdminLogicalRequestTrace("req_a_1");
    expect(trace).toMatchObject({
      logical_request: { logical_request_id: "req_a_1", newapi_user_id: "user_a" },
      session: { session_id: "ses_user_a" },
      task: { task_id: "task_user_a" },
      usage_report: { usage_report_id: "usage_a_1" },
    });
    expect(trace?.segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ segment_id: "seg_user_a_1" }),
    ]));
    expect(trace?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: "evt_a_1" }),
    ]));
    expect(trace?.judge_evaluations).toEqual(expect.arrayContaining([
      expect.objectContaining({ judge_evaluation_id: "judge_a_1" }),
    ]));
    expect(trace?.judge_attempts).toEqual([
      expect.objectContaining({
        judge_attempt_id: "judge_attempt_a_1",
        model: "mimo-v2.5-pro",
        cost_status: "estimated_blended",
      }),
    ]);
    expect(trace?.route_decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ route_decision_id: "route_a_1" }),
    ]));
    expect(trace?.logical_requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ logical_request_id: "req_a_1" }),
    ]));
    expect(trace?.attempts).toHaveLength(3);
    expect(trace?.payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload_id: "payload_a_1" }),
    ]));
    expect(trace?.usage_reports).toEqual(expect.arrayContaining([
      expect.objectContaining({ usage_report_id: "usage_a_1" }),
    ]));
    expect(await repository.getAdminLogicalRequestTrace("req_missing")).toBeUndefined();
  });
});
