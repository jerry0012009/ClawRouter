import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const baseUrl = process.env.ACU_ACCEPTANCE_URL || 'https://eu.jerrypsy.top/acu-router-dev';
const password = process.env.PROXY_API_KEY;
if (!password) throw new Error('PROXY_API_KEY is required and is never persisted');
const authorization = `Basic ${Buffer.from(`demo:${password}`).toString('base64')}`;
const inputs = [
  ['polite-rewrite', '把这句话改得更礼貌：今天把文件给我。'],
  ['json-extraction', '从“订单A-17，金额1280元，客户李梅”中提取order_id、amount、customer，只返回合法JSON。'],
  ['email-writing', '写一封简短邮件，礼貌提醒供应商周五前确认交付日期，不超过120字。'],
  ['local-code-fix', '修复Python函数 avg([]) 的除零问题，给出代码并解释边界行为。'],
  ['sql-analysis', '检查这条SQL为何造成重复订单统计，修正JOIN与聚合逻辑，并给出两个验证查询。'],
  ['multi-file-fix', '在一个Node服务中定位认证重试造成的重复写入，修改API层和存储层，补充回归测试并说明兼容风险。'],
  ['tool-debug', '检查测试日志和Git差异，定位支付回调偶发超时，修改幂等逻辑、运行相关测试并总结风险。'],
  ['research-compare', '比较三种事件流处理方案的顺序保证、故障恢复和运维成本，列出假设并给出推荐。'],
  ['migration-plan', '为两个地区的库存服务设计不停机数据库迁移，包含双写、校验、灰度、回滚和监控指标。'],
  ['security-review', '审计多租户文件上传服务的权限边界、内容扫描、配额绕过和审计日志，提出修复优先级与验证方法。'],
  ['incident-response', '调查跨多个服务的重复扣款事故，结合日志、消息重放和数据库状态定位根因，设计修复、补偿和演练方案。'],
  ['long-horizon', '为全球订单平台制定不停机架构迁移，覆盖支付幂等、库存一致性、跨区容灾、监管约束、灰度回滚、验证指标和故障演练，并给出依赖顺序。'],
];

async function evaluate(text, force) {
  const response = await fetch(`${baseUrl}/acu/api/evaluate`, {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: text }], expected_output_tokens: 300, force_judge_refresh: force }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${body.error?.message || 'evaluation failed'}`);
  return body;
}

const rows = [];
for (const [id, text] of inputs) {
  const result = await evaluate(text, true);
  const factors = result.difficultyFactors;
  const composite = 10 * (.25 * factors.reasoningDepth + .15 * factors.taskScope + .15 * factors.constraintDensity + .20 * factors.toolDependency + .15 * factors.verificationBurden + .10 * factors.contextBurden);
  const recomputed = Math.round(Math.max(0, Math.min(100, .8 * composite + .2 * result.difficultyScoreRaw)) * 10) / 10;
  rows.push({
    id, contextSha256: createHash('sha256').update(text).digest('hex'), judgeStatus: result.judgeStatus,
    difficultyScoreRaw: result.difficultyScoreRaw, factors, factorComposite: result.factorComposite,
    difficultyIndex: result.difficultyIndex, recomputedIndex: recomputed,
    probabilities: { pLow: result.judge.pLow, pMid: result.judge.pMid, pMidHigh: result.judge.pMidHigh, pHigh: result.judge.pHigh },
    confidence: result.judge.confidence, signals: result.judge.signals, explanation: result.judge.explanation,
    promptVersion: result.promptVersion, methodVersion: result.difficultyMethodVersion,
    upstreamRequestId: result.upstreamRequestId, latencyMs: result.judgeLatencyMs, cost: result.judgeCost,
  });
}
const repeated = await evaluate(inputs[0][1], false);
const first = rows[0];
const reproducible = repeated.difficultyIndex === first.difficultyIndex
  && repeated.difficultyScoreRaw === first.difficultyScoreRaw
  && JSON.stringify(repeated.difficultyFactors) === JSON.stringify(first.factors)
  && JSON.stringify({ pLow: repeated.judge.pLow, pMid: repeated.judge.pMid, pMidHigh: repeated.judge.pMidHigh, pHigh: repeated.judge.pHigh }) === JSON.stringify(first.probabilities);
const indices = rows.map((row) => row.difficultyIndex);
const summary = {
  count: rows.length,
  liveCount: rows.filter((row) => row.judgeStatus === 'live').length,
  rulesFallbackCount: rows.filter((row) => row.judgeStatus === 'rules_fallback').length,
  integerCount: indices.filter(Number.isInteger).length,
  nonIntegerCount: indices.filter((value) => !Number.isInteger(value)).length,
  multipleOfFiveCount: indices.filter((value) => Math.abs(value / 5 - Math.round(value / 5)) < 1e-9).length,
  uniqueIndexCount: new Set(indices).size,
  formulaMismatchCount: rows.filter((row) => row.difficultyIndex !== row.recomputedIndex).length,
  repeatStatus: repeated.judgeStatus,
  repeatedExactly: reproducible,
};
await writeFile(new URL('../difficulty_v3_acceptance.json', import.meta.url), `${JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, summary, rows }, null, 2)}\n`);
if (summary.liveCount !== 12 || summary.formulaMismatchCount || !summary.repeatedExactly || summary.nonIntegerCount === 0) process.exitCode = 1;
