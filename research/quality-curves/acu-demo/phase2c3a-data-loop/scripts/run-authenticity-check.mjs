import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const baseUrl = process.env.ACU_VALIDATION_BASE_URL || 'http://127.0.0.1:8403';
const token = process.env.PROXY_API_KEY || process.env.DEMO_ACCESS_TOKEN;
if (!token) throw new Error('PROXY_API_KEY or DEMO_ACCESS_TOKEN is required');
const output = resolve(process.argv[2] || 'research/quality-curves/acu-demo/phase2c3a-data-loop/authenticity_validation.json');

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const cases = {
  A: { messages: [{ role: 'user', content: '把这句话改得更礼貌：今天把文件给我。' }] },
  B: { messages: [{ role: 'user', content: '检查一个包含多个服务的订单系统，定位重复扣款问题，修改幂等逻辑，运行测试并解释风险。' }] },
  C: { messages: [{ role: 'user', content: '把这句话改得更礼貌：今天把文件给我！' }] },
  D_base: { messages: [
    { role: 'user', content: 'Review the latest tool result and decide the next safe action.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'run_shell', arguments: '{"command":"npm test"}' } }] },
    { role: 'tool', tool_call_id: 'call_123', name: 'run_shell', content: 'FAIL duplicate rows after retry' },
  ] },
  D: { messages: [
    { role: 'user', content: 'Review the latest tool result and decide the next safe action.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'query_database', arguments: '{"sql":"SELECT order_id FROM payments GROUP BY order_id HAVING COUNT(*) > 1"}' } }] },
    { role: 'tool', tool_call_id: 'call_123', name: 'run_shell', content: 'FAIL duplicate rows after retry' },
  ] },
};

async function evaluate(body, qualityTarget = 0.8) {
  const response = await fetch(`${baseUrl}/acu/api/evaluate`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'auto', ...body, quality_target: qualityTarget, expected_output_tokens: 800 }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`);
  return payload;
}

function sanitize(name, payload) {
  return {
    case: name,
    request_id: payload.requestId,
    context_sha256: payload.contextSha256,
    cache_key_sha256: payload.cacheKeySha256,
    judge_status: payload.judgeStatus,
    judge_result_source: payload.judgeResultSource,
    judge_provider: payload.judgeProvider,
    judge_endpoint_host: payload.judgeEndpointHost,
    judge_model: payload.judgeModel,
    prompt_version: payload.promptVersion,
    upstream_request_id: payload.upstreamRequestId,
    usage_status: payload.usageStatus,
    difficulty_score: payload.difficultyScore,
    probabilities: { p_low: payload.judge.pLow, p_mid: payload.judge.pMid, p_mid_high: payload.judge.pMidHigh, p_high: payload.judge.pHigh },
    confidence: payload.judge.confidence,
    latency_ms: payload.judgeLatencyMs,
    prompt_tokens: payload.judgePromptTokens,
    completion_tokens: payload.judgeCompletionTokens,
    judge_cost: payload.judgeCost,
    cache_created_at: payload.cacheCreatedAt,
    recommended_model: payload.recommendation.recommended.modelId,
    predicted_score: payload.recommendation.recommended.predictedScore,
  };
}

const raw = {};
for (const name of ['A','B']) raw[name] = await evaluate(cases[name]);
raw.A_repeat = await evaluate(cases.A);
for (const name of ['C','D_base','D']) raw[name] = await evaluate(cases[name]);

let preference = null;
for (const name of ['A','B','C','D']) {
  const low = await evaluate(cases[name], 0.6);
  const high = await evaluate(cases[name], 0.95);
  if (low.recommendation.recommended.modelId !== high.recommendation.recommended.modelId) {
    preference = {
      case: name,
      context_sha256: low.contextSha256,
      low_preference: { status: low.judgeStatus, model: low.recommendation.recommended.modelId, value_utility: low.recommendation.recommended.valueUtility },
      high_preference: { status: high.judgeStatus, model: high.recommendation.recommended.modelId, value_utility: high.recommendation.recommended.valueUtility },
    };
    break;
  }
}

const rows = Object.fromEntries(Object.entries(raw).map(([name,payload]) => [name,sanitize(name,payload)]));
const checks = {
  a_b_hash_different: rows.A.context_sha256 !== rows.B.context_sha256,
  a_b_first_live: rows.A.judge_status === 'live' && rows.B.judge_status === 'live',
  a_repeat_cache_hit: rows.A_repeat.judge_status === 'cache_hit',
  c_one_character_new_live: rows.C.context_sha256 !== rows.A.context_sha256 && rows.C.judge_status === 'live',
  d_tool_call_change_new_live: rows.D.context_sha256 !== rows.D_base.context_sha256 && rows.D.judge_status === 'live',
  usage_provenance_complete: Object.values(rows).every((row) => row.usage_status === 'reported' || row.usage_status === 'usage_missing'),
  preference_reuses_cache_and_changes_model: Boolean(preference && preference.low_preference.status === 'cache_hit' && preference.high_preference.status === 'cache_hit'),
  difficulty_is_not_fixed_66_7: new Set(['A','B','C','D'].map((name) => rows[name].difficulty_score)).size > 1 && ['A','B','C','D'].some((name) => rows[name].difficulty_score !== 66.7),
};
const result = { generated_at: new Date().toISOString(), base_url_kind: baseUrl.includes('127.0.0.1') ? 'local_dev' : 'public_dev', cases: rows, preference_test: preference, checks };
if (Object.values(checks).some((value) => !value)) throw new Error(`Authenticity validation failed: ${JSON.stringify(checks)}`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, checks, difficulties: Object.fromEntries(['A','B','C','D'].map((name)=>[name,rows[name].difficulty_score])) }, null, 2));
