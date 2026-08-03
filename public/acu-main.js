(() => {
  const API = window.AcuApiPrefix.resolve(location.pathname, location.origin);
  const ROUTER_MODEL = 'auto';
  const modelCatalogMap = {};
  let currentRun = null;
  let running = false;
  let totalBenchmarkCost = 0;
  let totalRouterCost = 0;

  const PRESETS = [
    { label: '结构化抽取', task: 'structured_extraction', checks: ['accuracy', 'completeness', 'direct_usability'], text: '请把下面这段文本提取成 JSON，字段包括 name、company、amount、deadline。只返回合法 JSON，不要 markdown，不要解释。\n\n"张三是北京字节跳动的产品经理，他在 2025 年 3 月前需要完成一笔 50 万元的采购。"' },
    { label: '代码修复', task: 'code_fix', checks: ['accuracy', 'completeness', 'direct_usability'], text: '下面这段 Python 报错，请修复并解释原因：\n\ndef avg(lst):\n    return sum(lst) / len(lst)\n\navg([])' },
    { label: '论文摘要', task: 'summary', checks: ['accuracy', 'completeness', 'direct_usability'], text: '请用中文总结下面英文摘要，并提炼 3 个创新点：\n\nWe propose a novel task-level routing framework for large language models that dynamically selects the optimal model based on input complexity, achieving 40% cost reduction with negligible quality degradation.' },
    { label: '复杂推理', task: 'reasoning', checks: ['accuracy', 'completeness', 'no_fabrication'], text: '请为跨三个地区、包含支付、库存和履约服务的订单系统设计一次不停机幂等性迁移。需要分析重复扣款竞态、消息重放、数据库约束、灰度回滚、验证指标与故障演练，并给出有依赖顺序的实施计划。' },
    { label: '投资人邮件', task: 'writing', checks: ['accuracy', 'tone', 'direct_usability', 'workflow_fit'], text: '请帮我写一封发给 AI infra 投资人的简短邮件，强调我们的 ACU Router 实现了任务级成本质量优化，有真实调用账本可验证。' },
  ];

  const $ = (id) => document.getElementById(id);
  const safeFetch = (target, options) => window.AcuApiPrefix.fetchFrom(location.pathname, target, options);

  function initPresets() {
    const bar = $('preset-bar');
    bar.innerHTML = '';
    PRESETS.forEach((preset, index) => {
      const button = document.createElement('button');
      button.textContent = preset.label;
      button.onclick = () => loadExample(index);
      bar.appendChild(button);
    });
  }

  function loadExample(index) {
    const preset = PRESETS[index];
    $('prompt-input').value = preset.text;
    $('quality-task').value = preset.task;
    setQualityChecks(preset.checks);
    document.querySelectorAll('#preset-bar button').forEach((button, buttonIndex) => button.classList.toggle('active', buttonIndex === index));
    renderQualityPreview();
  }

  function setQualityChecks(values) {
    document.querySelectorAll('#quality-checks input').forEach((input) => { input.checked = values.includes(input.value); });
  }

  function loadQualityExample() {
    $('quality-language').value = '这个任务的好结果应该：\n1. 能直接复制进入工作流，不需要大幅重写；\n2. 不编造没有给出的事实；\n3. 结构清楚，关键字段或步骤不能遗漏；\n4. 输出要简洁但足够完整；\n5. 如果有格式要求，优先遵守格式；如果不确定，进入复核而不是直接失败。';
    renderQualityPreview();
  }

  function getQualitySpec() {
    return {
      task_type: $('quality-task').value,
      threshold: Number($('quality-threshold').value),
      style: $('quality-style').value,
      dimensions: [...document.querySelectorAll('#quality-checks input:checked')].map((input) => input.value),
      user_spec: $('quality-language').value.trim(),
    };
  }

  function qualitySpecPrompt(spec) {
    const names = { accuracy: '准确性', completeness: '完整性', format_validity: '格式严格', direct_usability: '可直接使用', no_fabrication: '不编造', tone: '语气风格', code_correctness: '代码可运行', workflow_fit: '进入工作流' };
    return `Quality Contract / 什么是好:\n- task_type: ${spec.task_type}\n- quality_threshold: ${spec.threshold}%\n- output_style: ${spec.style}\n- required_dimensions: ${spec.dimensions.map((dimension) => names[dimension] || dimension).join(', ')}\n${spec.user_spec ? `- customer_defined_spec:\n${spec.user_spec}` : '- customer_defined_spec: 未额外输入'}\n请优先满足上述质量标准。若存在结构化格式要求，尽量严格遵守；不要编造未给出的事实。`;
  }

  function renderQualityPreview() {
    $('quality-threshold-output').textContent = `${$('quality-threshold').value}分`;
    $('quality-preview').textContent = qualitySpecPrompt(getQualitySpec());
  }

  function detectTaskType(text) {
    if (/JSON|提取|extract|结构/i.test(text)) return '结构化抽取';
    if (/报错|bug|fix|修复|error/i.test(text)) return '代码修复';
    if (/摘要|总结|summar/i.test(text)) return '摘要';
    if (/比较|推理|reason|设计|迁移|竞态/i.test(text)) return '复杂推理';
    if (/邮件|email|投资人/i.test(text)) return '写作';
    return '通用任务';
  }

  function estimatedOutputTokensForTask(task, prompt = '') {
    const detected = { 结构化抽取: 'structured_extraction', 写作: 'writing', 摘要: 'summary', 代码修复: 'code_fix', 复杂推理: 'reasoning', 通用任务: 'general' }[detectTaskType(prompt)] || 'general';
    return ({ structured_extraction: 256, writing: 600, summary: 600, code_fix: 900, reasoning: 4096, general: 800 })[task === 'auto' ? detected : task] || 800;
  }

  async function planTask(messages, qualityTarget, expectedOutputTokens) {
    const response = await safeFetch(`${API}/acu/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ messages, quality_target: qualityTarget, expected_output_tokens: expectedOutputTokens }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || '任务评估失败');
    return payload;
  }

  async function chatComplete(model, messages, qualityTarget, extra = {}) {
    const payload = model === ROUTER_MODEL
      ? { model, messages, cache: false, acu_quality_target: qualityTarget, ...extra }
      : { model, messages, ...extra };
    const response = await safeFetch(`${API}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `${model} 调用失败`);
    return data;
  }

  function getTrace(response) {
    const trace = response?.acu_trace || response?._acu_trace || null;
    if (trace?.acu_demo) {
      const plan = window.__latestAcuPlan;
      if (plan) {
        trace.acu_demo.benchmarkBaselineModel = plan.benchmarkBaselineModel;
        trace.acu_demo.benchmarkPricing = plan.benchmarkPricing;
        trace.acu_demo.qualityLeaderModel = plan.qualityLeaderModel;
        trace.acu_demo.qualityCeilingModel = plan.qualityCeilingModel;
        trace.acu_demo.displayCandidates = plan.displayCandidates;
      }
      window.__acuRequestId = trace.request_id;
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('acu:evaluation', { detail: { trace } })));
    }
    return trace;
  }

  function finishReason(response) { return response?.choices?.[0]?.finish_reason || null; }
  function responseText(response) {
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : (part?.text || '')).join('');
    return response?.error?.message || '';
  }
  function exhaustedWithoutVisibleOutput(response) {
    return finishReason(response) === 'length' && responseText(response).trim().length === 0;
  }
  function renderAnswer(element, response, text) {
    if (!text && exhaustedWithoutVisibleOutput(response)) {
      element.textContent = '本次未生成完整回答，请重新运行。';
      return;
    }
    element.textContent = text || '模型未返回可见文本。';
    if (finishReason(response) === 'length') element.textContent += '\n\n[回答未完整生成，请重新运行。]';
  }

  function estimateCost(model, usage) {
    if (!usage || !modelCatalogMap[model]) return 0;
    const price = modelCatalogMap[model];
    return ((usage.prompt_tokens ?? usage.input_tokens ?? 0) * price.input
      + (usage.completion_tokens ?? usage.output_tokens ?? 0) * price.output) / 1e6;
  }

  function actualModelCost(response, requestedModel) {
    const trace = response?.acu_trace || response?._acu_trace;
    if (typeof trace?.cost_audit?.total_acu_cost === 'number') return trace.cost_audit.total_acu_cost;
    if (typeof trace?.usage_audit?.modelCallCost === 'number') return trace.usage_audit.modelCallCost;
    return estimateCost(requestedModel, response?.usage);
  }

  function usageSourceLabel(response, trace) {
    const source = trace?.usage_audit?.usageSource || (response?.usage ? 'upstream_usage' : 'usage缺失');
    return ({
      upstream_cost: '上游返回金额',
      upstream_usage: '按目录价 × 上游 Token',
      response_text_estimate: '按回答文本估算',
      max_token_estimate: '按输出上限估算',
    }[source] || source);
  }

  function benchmarkCounterfactualCost(plan, response, trace) {
    const usage = trace?.usage_audit || response?.usage;
    return window.AcuChartCore.benchmarkCounterfactualCost(plan?.benchmarkPricing, usage);
  }

  function extractJsonCandidate(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) return fenced;
    const objectStart = text.indexOf('{'), objectEnd = text.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) return text.slice(objectStart, objectEnd + 1);
    const arrayStart = text.indexOf('['), arrayEnd = text.lastIndexOf(']');
    return arrayStart >= 0 && arrayEnd > arrayStart ? text.slice(arrayStart, arrayEnd + 1) : null;
  }

  function qualityStatus(value, threshold) {
    if (value >= threshold) return { label: '达标', cls: 'pass' };
    if (value >= Math.max(70, threshold - 15)) return { label: '建议复核', cls: 'review' };
    return { label: '建议升级', cls: 'escalate' };
  }

  function evaluateQuality(text, prompt, spec, trace) {
    const reasons = [];
    let value = 96;
    if (!text || text.trim().length < 20) { value = 68; reasons.push('输出较短，建议复核'); }
    if (spec.dimensions.includes('format_validity') && /json|字段|结构化|提取/i.test(prompt)) {
      try { const candidate = extractJsonCandidate(text); if (!candidate) throw new Error(); JSON.parse(candidate); reasons.push('结构化格式通过'); }
      catch { value -= 18; reasons.push('结构化格式建议复核'); }
    }
    if (spec.dimensions.includes('completeness') && text.length < 120) { value -= 8; reasons.push('完整性建议复核'); }
    if (spec.dimensions.includes('code_correctness') && !(/```|def |return |try:|except|原因|修复/.test(text))) { value -= 12; reasons.push('代码可运行性建议复核'); }
    if (trace?.validator_result === 'fail') { value -= 8; reasons.push('后端 Validator 建议复核'); }
    if (!reasons.length) reasons.push('命中质量契约基础要求');
    value = Math.max(58, Math.min(100, value));
    return { score: value, ...qualityStatus(value, spec.threshold), reasons };
  }

  function renderQualityResult(id, label, result, spec) {
    $(id).innerHTML = `<div class="score ${result.cls}">${result.score}</div><div class="scoretext"><strong style="color:#f5f5f7">${label}</strong><br>质量偏好 ${spec.threshold}分 · ${result.label}<br>${result.reasons.slice(0, 2).join('；')}</div>`;
  }

  function modeLabel(candidate) {
    if (candidate.thinkingMode === 'disabled') return 'Non-thinking';
    if (candidate.thinkingMode === 'enabled') return 'Thinking';
    return 'Default';
  }

  function updateComparisonSummary(state) {
    if (!state.benchmark || !state.router) return;
    const benchmark = state.plan.benchmarkBaselineModel || state.plan.qualityCeilingModel;
    const qualityLeader = state.plan.qualityLeaderModel || state.plan.qualityCeilingModel;
    const recommended = state.plan.recommendation.recommended;
    const normalizedBenchmarkCost = benchmarkCounterfactualCost(state.plan, state.router.response, state.router.trace);
    const actualSavings = normalizedBenchmarkCost > 0 ? (1 - state.router.cost / normalizedBenchmarkCost) * 100 : null;
    state.router.normalizedBenchmarkCost = normalizedBenchmarkCost;
    const benchmarkLabel = state.plan.benchmarkPricing?.label || 'Opus 4.8 Demo基准价';
    const banner = $('savings-banner');
    banner.className = `banner ${state.router.quality.score >= state.spec.threshold ? 'ok' : 'warn'}`;
    if (state.router.model === benchmark.modelId) {
      banner.textContent = `ACU判断当前任务需要保留${benchmark.displayName}。按 Router 同等 Token 重算（${benchmarkLabel}），旗舰基准 US$${(normalizedBenchmarkCost ?? 0).toFixed(5)}；ACU 总成本 US$${state.router.cost.toFixed(5)}。`;
    } else {
      const gap = benchmark.predictedScore - recommended.predictedScore;
      const costPhrase = actualSavings === null
        ? '成本口径暂不可用'
        : actualSavings >= 0 ? `同 Token 成本降低 ${actualSavings.toFixed(1)}%` : `同 Token 成本增加 ${Math.abs(actualSavings).toFixed(1)}%`;
      const leaderNote = qualityLeader?.modelId === recommended.modelId
        ? `；推荐接近预计质量最高模型 ${qualityLeader.displayName}`
        : '';
      banner.textContent = `相对固定旗舰基准 ${benchmark.displayName}，ACU以预计得分差 ${gap.toFixed(1)}分换取${costPhrase}${leaderNote}。${benchmarkLabel}：US$${(normalizedBenchmarkCost ?? 0).toFixed(5)}；ACU 总成本 US$${state.router.cost.toFixed(5)}。`;
    }
    if (!state.ledgerAdded) {
      state.ledgerAdded = true;
      totalBenchmarkCost += normalizedBenchmarkCost ?? 0;
      totalRouterCost += state.router.cost;
      addLedgerRow({
        time: new Date().toLocaleTimeString(), task: detectTaskType($('prompt-input').value), preference: `${state.spec.threshold}分`,
        model: state.router.model, cost: state.router.cost, benchmark: normalizedBenchmarkCost ?? 0, savings: actualSavings ?? 0,
        quality: `${state.router.quality.label} ${state.router.quality.score}分`, validator: validatorLabel(state.router.trace),
        switched: (state.router.trace?.attempts?.length || 0) > 1 ? '是' : '否',
        latency: `ACU ${state.router.latency}ms / Opus ${state.benchmark.latency}ms`,
      });
    }
  }

  function validatorLabel(trace) {
    if (!trace?.validator || trace.validator === 'not_applicable') return '不适用';
    return `${trace.validator}: ${trace.validator_result || '—'}`;
  }

  function renderTrace(trace, plan) {
    const attempts = (trace?.attempts || []).map((attempt, index) => `#${index + 1} ${attempt.model}: ${attempt.status}${attempt.error_category ? `/${attempt.error_category}` : ''} ${attempt.latency_ms}ms`).join(' → ') || '—';
    const values = {
      difficulty_index: plan.difficultyIndex ?? plan.difficultyScore,
      difficulty_raw: plan.difficultyScoreRaw ?? '—',
      benchmark_baseline: plan.benchmarkBaselineModel?.modelId || plan.qualityCeilingModel?.modelId || '—',
      quality_leader: plan.qualityLeaderModel?.modelId || plan.qualityCeilingModel?.modelId || '—',
      recommended: plan.recommendation?.recommended?.modelId || '—',
      actual: trace?.actual_model_used || '—', attempts,
      usage_source: trace?.usage_audit?.usageSource || '—',
      router_latency: `${trace?.latency_breakdown?.total_router_latency_ms ?? 0}ms`,
    };
    $('trace-grid').innerHTML = Object.entries(values).map(([key, value]) => `<span class="pill">${key}: ${value}</span>`).join('');
  }

  function addLedgerRow(row) {
    const body = $('ledger-body');
    if (body.querySelector('.subtle')) body.innerHTML = '';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.time}</td><td>${row.task}</td><td>${row.preference}</td><td>${row.model}</td><td class="green-text">$${row.cost.toFixed(5)}</td><td>$${row.benchmark.toFixed(5)}</td><td class="${row.savings >= 0 ? 'green-text' : 'yellow-text'}">${row.savings.toFixed(1)}%</td><td>${row.quality}</td><td>${row.validator}</td><td>${row.switched}</td><td>${row.latency}</td>`;
    body.prepend(tr);
    [...body.children].slice(8).forEach((node) => node.remove());
    $('ledger-summary').innerHTML = `<span>累计ACU账单估算 $${totalRouterCost.toFixed(5)}</span><span>累计Opus同Token基准 $${totalBenchmarkCost.toFixed(5)}</span><span>累计净节省 $${(totalBenchmarkCost - totalRouterCost).toFixed(5)}</span>`;
  }

  async function runComparison() {
    const prompt = $('prompt-input').value.trim();
    if (!prompt || running) return;
    running = true;
    $('run-btn').disabled = true;
    $('feedback-row').style.display = 'none';
    $('savings-banner').innerHTML = '';
    $('baseline-answer').textContent = '正在准备 Claude Opus 4.8 固定旗舰基准…';
    $('router-answer').textContent = '正在评估当前任务并规划质量成本路由…';
    const spec = getQualitySpec();
    const expectedOutputTokens = estimatedOutputTokensForTask(spec.task_type, prompt);
    const messages = [{ role: 'system', content: qualitySpecPrompt(spec) }, { role: 'user', content: prompt }];
    renderQualityPreview();
    const state = { plan: null, benchmark: null, router: null, benchmarkDone: false, routerDone: false, ledgerAdded: false, spec };
    try {
      const plan = await planTask(messages, spec.threshold / 100, expectedOutputTokens);
      state.plan = plan;
      window.__latestAcuPlan = plan;
      window.__acuPageContext = { taskType: spec.task_type === 'auto' ? detectTaskType(prompt) : ({ structured_extraction: '结构化抽取', code_fix: '代码修复', summary: '摘要', writing: '写作', reasoning: '复杂推理' }[spec.task_type] || '通用任务'), qualityTarget: spec.threshold, prompt };
      window.dispatchEvent(new CustomEvent('acu:plan', { detail: { plan } }));
      const benchmark = plan.benchmarkBaselineModel || plan.qualityCeilingModel;
      $('baseline-answer').textContent = `${benchmark.displayName} 正在生成固定旗舰质量对照…`;
      $('router-answer').textContent = `${plan.recommendation.recommended.displayName} 正在执行 ACU 推荐…`;
      const finish = () => { if (state.benchmarkDone && state.routerDone) { running = false; $('run-btn').disabled = false; } };
      const benchmarkExtra = {
        max_tokens: expectedOutputTokens,
        ...(benchmark.thinkingMode === 'disabled' ? { enable_thinking: false } : {}),
      };
      const benchmarkStarted = Date.now();
      const benchmarkPromise = chatComplete(benchmark.modelId, messages, undefined, benchmarkExtra).then(async (firstResponse) => {
        let response = firstResponse;
        let emptyOutputRetry = false;
        let retryCost = 0;
        if (exhaustedWithoutVisibleOutput(firstResponse)) {
          emptyOutputRetry = true;
          retryCost = actualModelCost(firstResponse, benchmark.modelId);
          response = await chatComplete(benchmark.modelId, messages, undefined, benchmarkExtra);
        }
        const latency = Date.now() - benchmarkStarted;
        const content = responseText(response);
        const observedCost = retryCost + actualModelCost(response, benchmark.modelId);
        const quality = evaluateQuality(content, prompt, spec, null);
        renderAnswer($('baseline-answer'), response, content);
        renderQualityResult('baseline-quality', 'Claude Opus 4.8 固定旗舰基准', quality, spec);
        $('baseline-meta').innerHTML = `<span class="pill warn">${benchmark.displayName}</span><span class="pill">预计 ${benchmark.predictedScore.toFixed(1)}分</span><span class="pill">${modeLabel(benchmark)}</span><span class="pill">模型调用 ${latency}ms</span><span class="pill warn">独立调用账单估算 US$${observedCost.toFixed(5)}</span><span class="pill">${usageSourceLabel(response)}</span><span class="pill">基准估算 ${plan.benchmarkPricing?.inputPricePerMillion ?? 10}/${plan.benchmarkPricing?.outputPricePerMillion ?? 50} $/M</span><span class="pill">仅作质量对照，不计入节省率</span>${emptyOutputRetry ? '<span class="pill warn">已自动重试，估算含两次调用</span>' : ''}`;
        state.benchmark = { response, model: benchmark.modelId, observedCost, quality, latency, predictedScore: benchmark.predictedScore };
      }).catch((error) => {
        $('baseline-answer').textContent = `固定旗舰基准调用失败：${error.message}`;
        $('baseline-meta').innerHTML = '<span class="pill bad">对照失败，不影响 ACU Router 结果</span>';
      }).finally(() => { state.benchmarkDone = true; updateComparisonSummary(state); finish(); });

      const routerStarted = Date.now();
      const routerPromise = chatComplete(ROUTER_MODEL, messages, spec.threshold / 100, {
        acu_plan_id: plan.planId,
        max_tokens: expectedOutputTokens,
      }).then((response) => {
        const wallLatency = Date.now() - routerStarted;
        const trace = getTrace(response);
        const model = trace?.actual_model_used || response.model || 'unknown';
        const content = responseText(response);
        const cost = actualModelCost(response, model);
        const quality = evaluateQuality(content, prompt, spec, trace);
        const latency = trace?.latency_breakdown || {};
        renderAnswer($('router-answer'), response, content);
        renderQualityResult('router-quality', 'ACU Router', quality, spec);
        $('router-meta').innerHTML = `<span class="pill ok">实际 ${model}</span><span class="pill">任务评估 ${latency.judge_latency_ms ?? 0}ms</span><span class="pill">模型调用 ${trace?.attempts?.[0]?.latency_ms ?? 0}ms</span><span class="pill">总耗时 ${latency.total_router_latency_ms ?? wallLatency}ms</span><span class="pill ok">ACU总账单估算 US$${cost.toFixed(5)}</span><span class="pill">${usageSourceLabel(response, trace)}</span>`;
        state.router = { response, trace, model, cost, quality, latency: wallLatency };
        renderTrace(trace, plan);
        currentRun = { routerQuality: quality, spec, model, benchmarkModel: benchmark.modelId };
        $('feedback-row').style.display = 'flex';
        if (!state.benchmarkDone) $('baseline-answer').textContent = 'ACU Router 已完成；Opus 4.8 固定旗舰基准仍在生成…';
      }).catch((error) => {
        $('router-answer').textContent = `ACU Router 失败：${error.message}`;
        $('router-meta').innerHTML = '<span class="pill bad">Router 失败，不清空已完成的旗舰基准结果</span>';
      }).finally(() => { state.routerDone = true; updateComparisonSummary(state); finish(); });
      await Promise.allSettled([benchmarkPromise, routerPromise]);
    } catch (error) {
      $('baseline-answer').textContent = `任务评估失败：${error.message}`;
      $('router-answer').textContent = '未执行模型调用。';
      running = false;
      $('run-btn').disabled = false;
    }
  }

  async function recordFeedback(type) {
    const requestId = window.__acuRequestId;
    if (!requestId) { $('feedback-summary').textContent = '当前请求没有可写入的路由ID。'; return; }
    const accepted = ['router_win', 'tie', 'router_adopted', 'router_thumb_up'].includes(type);
    const requiredUpgrade = type === 'baseline_win' || type === 'router_thumb_down';
    try {
      const response = await safeFetch(`${API}/acu/api/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: requestId, accepted, required_upgrade: requiredUpgrade, final_model: currentRun?.model }),
      });
      if (!response.ok) throw new Error('写入失败');
      $('feedback-summary').textContent = '反馈已写入，用于持续校准模型选择。';
    } catch (error) { $('feedback-summary').textContent = `反馈未保存：${error.message}`; }
  }

  async function loadModels() {
    try {
      const response = await safeFetch(`${API}/v1/models`);
      const payload = await response.json();
      const body = $('models-body');
      if (body) body.innerHTML = '';
      for (const model of payload.data || []) {
        const input = Number(model.pricing?.prompt ?? model.pricing?.input ?? 0);
        const output = Number(model.pricing?.completion ?? model.pricing?.output ?? 0);
        modelCatalogMap[model.id] = {
          input,
          output,
        };
        if (body) {
          const capabilities = model.capabilities || {};
          const tags = [capabilities.vision ? 'vision' : '', capabilities.reasoning ? 'reasoning' : '', capabilities.tool_calling ? 'tool' : '']
            .filter(Boolean).map((tag) => `<span class="tag ${tag === 'reasoning' ? 'warn' : ''}">${tag}</span>`).join('');
          const row = document.createElement('tr');
          row.innerHTML = `<td>${model.id}</td><td>${model.upstream || model.owned_by || '-'}</td><td class="green-text">$${input.toFixed(2)}</td><td class="green-text">$${output.toFixed(2)}</td><td>${model.context_length || '-'}</td><td>${tags || '-'}</td>`;
          body.appendChild(row);
        }
      }
    } catch {
      const body = $('models-body');
      if (body) body.innerHTML = '<tr><td colspan="6" class="subtle">模型列表加载失败</td></tr>';
    }
  }

  document.addEventListener('change', (event) => {
    if (event.target.closest?.('#quality-task,#quality-threshold,#quality-style,#quality-checks')) renderQualityPreview();
  });
  document.addEventListener('input', (event) => { if (event.target.id === 'quality-language') renderQualityPreview(); });
  Object.assign(window, { runComparison, recordFeedback, loadQualityExample, renderQualityPreview, getQualitySpec, qualitySpecPrompt, currentMessages: () => [{ role: 'system', content: qualitySpecPrompt(getQualitySpec()) }, { role: 'user', content: $('prompt-input').value.trim() }] });
  initPresets();
  renderQualityPreview();
  loadModels();
})();
