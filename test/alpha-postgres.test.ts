import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlphaDatabase } from "../src/alpha/database.js";
import { AlphaRepository } from "../src/alpha/repository.js";

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

  it("creates exactly the ten P0 tables without vector or memory tables", async () => {
    const result = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name LIKE 'acu_%' ORDER BY table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "acu_attempts",
      "acu_events",
      "acu_judge_evaluations",
      "acu_logical_requests",
      "acu_payloads",
      "acu_route_decisions",
      "acu_segments",
      "acu_sessions",
      "acu_tasks",
      "acu_usage_reports",
    ]);
    expect(result.rows.some((row) => /vector|embedding|memory/i.test(row.table_name))).toBe(false);
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
    await expect(repository.createAttempt({
      attemptId: "att_a_3",
      logicalRequestId: "req_a_1",
      attemptIndex: 3,
      attemptKind: "provider",
      retryOwner: "acu",
      provider: "closeai",
      status: "success",
    })).rejects.toMatchObject({ code: "23514" });

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
    expect(trace?.route_decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ route_decision_id: "route_a_1" }),
    ]));
    expect(trace?.attempts).toHaveLength(2);
    expect(trace?.payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload_id: "payload_a_1" }),
    ]));
    expect(await repository.getAdminLogicalRequestTrace("req_missing")).toBeUndefined();
  });
});
