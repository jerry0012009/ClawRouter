import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiKey = process.env.PROXY_API_KEY;
if (!apiKey) throw new Error("PROXY_API_KEY is required");

const baseUrl = "https://eu.jerrypsy.top/acu-router-dev";
const requestUrl = `${baseUrl}/v1/chat/completions`;
const summaryUrl = `${baseUrl}/acu/api/data-summary`;
const cases = [
  { id: "structured_extraction", text: "P0验收：从文本‘王敏在周五前提交预算表’中提取姓名、截止时间和任务，返回简短JSON。" },
  { id: "ordinary_writing", text: "P0验收：写一段礼貌、简洁的会议改期通知，说明会议改到下周二上午十点。" },
  { id: "multi_step_code_fix", text: "P0验收：检查一个Node服务的重复订单问题，定位并发竞态，修改幂等逻辑，补充测试并说明验证步骤。" },
  { id: "complex_reasoning", text: "P0验收：为跨区域支付系统设计故障迁移方案，权衡一致性、延迟、重复扣款风险、回滚和演练顺序。" },
];

const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Cache-Control": "no-cache" };
const summary = async () => {
  const response = await fetch(summaryUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`summary failed: ${response.status}`);
  return response.json();
};

async function run(item, qualityTarget = 0.8) {
  const messages = item.messages || [{ role: "user", content: item.text }];
  const response = await fetch(requestUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "auto", messages, cache: false, max_tokens: 64, acu_quality_target: qualityTarget }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${item.id} failed: ${response.status} ${payload?.error?.message || "unknown"}`);
  const trace = payload.acu_trace;
  const evaluation = trace?.acu_demo;
  if (!evaluation) throw new Error(`${item.id} missing trace.acu_demo`);
  return {
    case_id: item.id,
    input_sha256: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
    network_request_url: requestUrl,
    request_id: trace.request_id,
    judge_status: evaluation.judgeStatus,
    difficulty_score: evaluation.difficultyScore,
    quality_target: evaluation.qualityTarget,
    recommended_model: evaluation.recommendation.recommended.modelId,
    actual_model: trace.actual_model_used,
    recommendation_applied: evaluation.recommendationApplied,
    fallback_used: trace.fallback_used,
    predicted_score: evaluation.recommendation.recommended.predictedScore,
    expected_total_cost: evaluation.recommendation.recommended.expectedTotalCost,
    actual_cost: trace.estimated_cost,
    final_status: payload.error ? "error" : "completed",
  };
}

const before = await summary();
const results = [];
for (const item of cases) results.push(await run(item));
const preferenceCase = {
  id: "preference",
  messages: [
    { role: "user", content: "Review the latest tool result and decide the next safe action." },
    { role: "assistant", content: null, tool_calls: [{ id: "call_123", type: "function", function: { name: "query_database", arguments: "{\"sql\":\"SELECT order_id FROM payments GROUP BY order_id HAVING COUNT(*) > 1\"}" } }] },
    { role: "tool", tool_call_id: "call_123", name: "run_shell", content: "FAIL duplicate rows after retry" },
  ],
};
const preferenceLow = await run(preferenceCase, 0.6);
const preferenceHigh = await run(preferenceCase, 0.95);
const after = await summary();

const output = {
  captured_at: new Date().toISOString(),
  public_dev_url: `${baseUrl}/`,
  cases: results,
  quality_preference_check: {
    low: preferenceLow,
    high: preferenceHigh,
    recommendation_changed: preferenceLow.recommended_model !== preferenceHigh.recommended_model,
  },
  sqlite_summary_count_before: before.realRequestCount,
  sqlite_summary_count_after: after.realRequestCount,
  sqlite_increment: after.realRequestCount - before.realRequestCount,
};

const outputPath = join(dirname(fileURLToPath(import.meta.url)), "..", "p0_e2e_validation.json");
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(output, null, 2));
