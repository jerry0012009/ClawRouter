(() => {
  const prefix = location.pathname.match(/^\/(acu-router(?:-dev)?)(?:\/|$)/)?.[1];
  const api = prefix ? `${location.origin}/${prefix}/acu/api` : `${location.origin}/acu/api`;
  const safeFetch = (target, options) => window.AcuApiPrefix.fetchFrom(location.pathname, target, options);
  const core = window.AcuChartCore;
  const colors = ['#90e8a0', '#ffd76a', '#9fc7ff', '#ff8fa3', '#b7a1ff', '#67d8c2', '#f6a96b', '#85d7ff', '#d3e47d', '#d7a4ff', '#80c4aa', '#ffadbf'];
  const state = {
    catalog: null, plan: null, evaluation: null, trace: null, mode: 'featured',
    views: { featured: { x: [0, 100], global: true }, all: null },
    locked: new Set(), hovered: null, selected: null, geometry: null,
    dragging: null, touches: new Map(), pinchDistance: null,
  };
  const $ = (id) => document.getElementById(id);
  const money = (value) => `US$${Number(value || 0).toFixed(value < 0.01 ? 5 : 3)}`;
  const score = (value) => `${Number(value).toFixed(1)}分`;
  const healthLabel = (status) => ({ healthy: '正常', degraded: '当前性能波动', cooldown: '冷却中', unknown: '样本不足' })[status] || '样本不足';
  const evidenceLabel = (confidence) => ({ high: '高可信公开证据', medium: '公开Benchmark锚定估算', low: '相对估算' })[confidence] || '相对估算';
  const modeLabel = (candidate) => candidate?.thinkingMode === 'disabled' ? 'Non-thinking' : candidate?.thinkingMode === 'enabled' ? 'Thinking' : 'Default';

  function sourceLabel(evaluation) {
    if (evaluation.judgeStatus === 'live') return ['实时任务评估', 'live'];
    if (evaluation.judgeStatus === 'cache_hit') return ['任务评估缓存', 'cache'];
    return ['规则估算', 'rules'];
  }

  function difficultyLevel(value) { return value < 30 ? '简单' : value < 55 ? '标准' : value < 80 ? '复杂' : '高难度'; }
  function inputScale(tokens) { return tokens < 500 ? '短上下文' : tokens <= 4000 ? '中等上下文' : '长上下文'; }
  function qualityMode(value) { return value < 75 ? '成本优先' : value < 88 ? '质量成本均衡' : '质量优先'; }

  function candidates() {
    if (!state.plan || !state.catalog) return [];
    return core.visibleCandidates(state.plan.displayCandidates || [], Object.keys(state.catalog.curves || {}));
  }

  function candidate(modelId) { return candidates().find((item) => item.modelId === modelId); }

  function roleLabels(modelId) {
    const labels = [];
    if (modelId === state.plan?.qualityCeilingModel?.modelId) labels.push('质量上界');
    if (modelId === state.plan?.recommendation?.recommended?.modelId) labels.push('ACU推荐');
    if (modelId === (state.evaluation?.actualModel || state.trace?.actual_model_used)) labels.push('实际执行');
    (state.trace?.attempts || []).forEach((attempt, index) => { if (attempt.model === modelId) labels.push(`第${index + 1}次尝试`); });
    if (candidate(modelId)?.evidenceConfidence === 'low') labels.push('相对估算');
    if (candidate(modelId)?.healthStatus === 'degraded') labels.push('当前性能波动');
    return [...new Set(labels)];
  }

  function visibleModelIds() {
    const all = candidates();
    if (state.mode === 'all') return all.map((item) => item.modelId);
    return core.featuredModelIds({
      candidates: all,
      ceilingId: state.plan?.qualityCeilingModel?.modelId,
      recommendedId: state.plan?.recommendation?.recommended?.modelId,
      actualId: state.evaluation?.actualModel || state.trace?.actual_model_used,
      attemptIds: (state.trace?.attempts || []).map((attempt) => attempt.model),
    });
  }

  function autoFit(mode = state.mode) {
    if (!state.evaluation) return;
    state.views[mode] = mode === 'all'
      ? { x: core.autoDifficultyDomain(state.evaluation.difficultyScore), global: false }
      : { x: [0, 100], global: true };
    drawChart();
  }

  function currentView() {
    if (!state.views[state.mode]) autoFit(state.mode);
    return state.views[state.mode] || { x: [0, 100], global: true };
  }

  function interpolateCurve(curve, difficulty) {
    if (!curve?.length) return null;
    const bounded = Math.max(0, Math.min(100, difficulty));
    const lower = curve[Math.floor(bounded)], upper = curve[Math.ceil(bounded)];
    if (!lower || !upper) return null;
    const fraction = bounded - Math.floor(bounded);
    return (lower.estimatedQuality + (upper.estimatedQuality - lower.estimatedQuality) * fraction) * 100;
  }

  function executionStatus() {
    const evaluation = state.evaluation, trace = state.trace;
    if (!evaluation) return '等待路由结果';
    if (trace?.format_repair_succeeded === true) return '同模型格式修复成功';
    if (trace?.quality_review_required === true) return '当前结果需要复核';
    if (trace?.quality_fallback_used === true) return '质量复核后升级';
    const attempts = trace?.attempts || [];
    if (attempts.length > 1 && ['error', 'timeout'].includes(attempts[0]?.status) && attempts.some((attempt) => attempt.status === 'success')) {
      const reason = attempts[0].status === 'timeout' ? '超时' : attempts[0].error_category === 'rate_limited' ? '上游限流' : (attempts[0].error_category || '调用错误');
      return `推荐模型${reason}，已切换`;
    }
    if ((evaluation.actualModel || trace?.actual_model_used) !== evaluation.recommendation.recommended.modelId) return '执行模型发生切换';
    return evaluation.recommendationApplied === true ? '推荐已执行' : evaluation.shadowMode ? 'Shadow模式未执行推荐' : '推荐未执行';
  }

  function updateOverview() {
    const evaluation = state.evaluation || state.plan;
    if (!evaluation) return;
    const context = window.__acuPageContext || {};
    $('acu-task-type').textContent = context.taskType || '通用任务';
    $('acu-live-difficulty').textContent = `${evaluation.difficultyScore.toFixed(1)} / 100`;
    $('acu-difficulty-level').textContent = difficultyLevel(evaluation.difficultyScore);
    const preference = context.qualityTarget ?? evaluation.qualityTarget * 100;
    $('acu-quality-preference').textContent = `${Number(preference).toFixed(0)}分`;
    $('acu-quality-mode').textContent = qualityMode(preference);
    $('acu-input-tokens').textContent = `${evaluation.contextTokenEstimate} tokens`;
    $('acu-input-scale').textContent = inputScale(evaluation.contextTokenEstimate);
  }

  function updateSummary() {
    const evaluation = state.evaluation || state.plan;
    if (!evaluation) return;
    const [label, cls] = sourceLabel(evaluation);
    const badge = $('acu-source-badge');
    badge.textContent = label;
    badge.className = `acu-source-badge ${cls}`;
    $('acu-routing-mode').textContent = evaluation.shadowMode ? '路由模式：Shadow观察' : '路由模式：ACU实际执行';
    const recommended = state.plan?.recommendation?.recommended || evaluation.recommendation.recommended;
    const actualId = state.evaluation?.actualModel || state.trace?.actual_model_used;
    const actual = candidate(actualId);
    $('acu-live-recommendation').textContent = `${recommended.displayName} · ${score(recommended.predictedScore)} · ${money(recommended.expectedTotalCost)}`;
    $('acu-live-actual').textContent = actualId ? `${actual?.displayName || actualId} · ${modeLabel(actual)}` : '等待模型执行';
    $('acu-live-application').textContent = executionStatus();
    const ceiling = state.plan?.qualityCeilingModel;
    $('acu-live-reason').textContent = ceiling?.modelId === recommended.modelId
      ? '该任务已接近质量上界，当前没有可靠的降配空间。'
      : evaluation.recommendation.reason;
    updateOverview();
  }

  function chartDomain(modelIds) {
    const view = currentView();
    const y = view.global ? [0, 100] : core.autoScoreDomain(state.catalog.curves, modelIds, view.x);
    return { x: view.x, y };
  }

  function drawAxes(ctx, bounds, domain, xScale, yScale) {
    ctx.font = '10px ui-monospace, monospace';
    ctx.lineWidth = 1;
    for (let index = 0; index <= 5; index += 1) {
      const yValue = domain.y[0] + (domain.y[1] - domain.y[0]) * index / 5;
      const py = yScale(yValue);
      ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.beginPath(); ctx.moveTo(bounds.left, py); ctx.lineTo(bounds.right, py); ctx.stroke();
      ctx.fillStyle = '#898990'; ctx.textAlign = 'right'; ctx.fillText(yValue.toFixed(0), bounds.left - 7, py + 3);
      const xValue = domain.x[0] + (domain.x[1] - domain.x[0]) * index / 5;
      ctx.textAlign = 'center'; ctx.fillText(xValue.toFixed(0), xScale(xValue), bounds.bottom + 18);
    }
  }

  function labelModels(modelIds) {
    if (state.mode === 'featured') return modelIds;
    const permanent = [state.plan?.qualityCeilingModel?.modelId, state.plan?.recommendation?.recommended?.modelId, state.evaluation?.actualModel || state.trace?.actual_model_used];
    return [...new Set([...permanent, ...state.locked].filter((id) => modelIds.includes(id)))];
  }

  function drawLabels(ctx, points, bounds) {
    const selected = new Set(labelModels(points.map((point) => point.modelId)));
    const labels = points.filter((point) => selected.has(point.modelId)).sort((left, right) => left.py - right.py);
    const gap = 40;
    labels.forEach((item, index) => {
      item.labelY = Math.max(bounds.top + 18, item.py);
      if (index && item.labelY < labels[index - 1].labelY + gap) item.labelY = labels[index - 1].labelY + gap;
    });
    const overflow = (labels.at(-1)?.labelY || 0) - (bounds.bottom - 18);
    if (overflow > 0) labels.forEach((item) => { item.labelY -= overflow; });
    for (const item of labels) {
      const width = 176, height = 34;
      const placeRight = item.px < (bounds.left + bounds.right) / 2;
      const boxX = placeRight ? Math.min(bounds.right - width, item.px + 13) : Math.max(bounds.left, item.px - width - 13);
      ctx.strokeStyle = item.color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(item.px, item.py); ctx.lineTo(placeRight ? boxX : boxX + width, item.labelY); ctx.stroke();
      ctx.fillStyle = item.modelId === state.plan?.recommendation?.recommended?.modelId ? 'rgba(70,65,28,.97)' : 'rgba(15,15,17,.97)';
      ctx.fillRect(boxX, item.labelY - height / 2, width, height); ctx.strokeStyle = item.color; ctx.strokeRect(boxX, item.labelY - height / 2, width, height);
      ctx.textAlign = 'left'; ctx.fillStyle = '#f3f3f4'; ctx.font = '600 10px sans-serif'; ctx.fillText(item.candidate.displayName, boxX + 7, item.labelY - 3);
      ctx.font = '600 9px ui-monospace, monospace'; ctx.fillText(`${score(item.candidate.predictedScore)}    ${money(item.candidate.expectedTotalCost)}`, boxX + 7, item.labelY + 11);
    }
  }

  function drawChart() {
    if (!state.catalog || !(state.evaluation || state.plan)) return;
    const canvas = $('acu-integrated-chart');
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(540, canvas.clientWidth || 760), height = Math.max(410, canvas.clientHeight || 460);
    canvas.width = width * ratio; canvas.height = height * ratio;
    const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
    const bounds = { left: 48, right: width - 18, top: 22, bottom: height - 38 };
    const modelIds = visibleModelIds();
    const domain = chartDomain(modelIds);
    const xScale = (value) => bounds.left + (value - domain.x[0]) / (domain.x[1] - domain.x[0]) * (bounds.right - bounds.left);
    const yScale = (value) => bounds.bottom - (value - domain.y[0]) / (domain.y[1] - domain.y[0]) * (bounds.bottom - bounds.top);
    drawAxes(ctx, bounds, domain, xScale, yScale);
    const points = [], paths = [];
    modelIds.forEach((modelId, index) => {
      const curve = state.catalog.curves[modelId], item = candidate(modelId);
      if (!curve || !item) return;
      const color = colors[index % colors.length];
      const highlighted = state.hovered === modelId || state.selected === modelId || state.locked.has(modelId);
      ctx.strokeStyle = color; ctx.globalAlpha = state.hovered && !highlighted ? 0.24 : 1; ctx.lineWidth = highlighted ? 3.2 : roleLabels(modelId).length ? 2.4 : 1.25; ctx.beginPath();
      const visiblePoints = curve.filter((point) => point.difficultyScore >= domain.x[0] - 1 && point.difficultyScore <= domain.x[1] + 1);
      visiblePoints.forEach((point, pointIndex) => { const px = xScale(point.difficultyScore), py = yScale(point.estimatedQuality * 100); if (!pointIndex) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      ctx.stroke(); ctx.globalAlpha = 1;
      paths.push({ modelId, curve, color });
      const pointScore = interpolateCurve(curve, (state.evaluation || state.plan).difficultyScore);
      if (pointScore === null) return;
      const px = xScale((state.evaluation || state.plan).difficultyScore), py = yScale(pointScore);
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(px, py, roleLabels(modelId).length ? 5 : 3.2, 0, Math.PI * 2); ctx.fill();
      points.push({ modelId, candidate: item, px, py, color, pointScore });
    });
    const difficulty = (state.evaluation || state.plan).difficultyScore;
    if (difficulty >= domain.x[0] && difficulty <= domain.x[1]) {
      const lineX = xScale(difficulty); ctx.strokeStyle = 'rgba(255,255,255,.60)'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(lineX, bounds.top); ctx.lineTo(lineX, bounds.bottom); ctx.stroke(); ctx.setLineDash([]);
    }
    drawLabels(ctx, points, bounds);
    state.geometry = { width, height, bounds, domain, xScale, yScale, points, paths };
    $('acu-local-view-note').hidden = currentView().global;
    renderModelList();
  }

  function tooltipHtml(item) {
    const roles = roleLabels(item.modelId);
    return `<strong>${item.displayName} · ${modeLabel(item)}</strong><div class="acu-tooltip-roles">${roles.map((role) => `<span>${role}</span>`).join('')}</div><dl><dt>预计模型得分</dt><dd>${score(item.predictedScore)}</dd><dt>保守预计得分</dt><dd>${score(item.conservativeScore)}</dd><dt>预计综合成本</dt><dd>${money(item.expectedTotalCost)}</dd><dt>预计模型调用成本</dt><dd>${money(item.estimatedCallCost)}</dd><dt>预计P50延迟</dt><dd>${item.p50LatencyMs === null ? '样本不足' : `${(item.p50LatencyMs / 1000).toFixed(1)}秒`}</dd><dt>当前健康状态</dt><dd>${healthLabel(item.healthStatus)}</dd><dt>执行模式</dt><dd>${modeLabel(item)}</dd><dt>证据等级</dt><dd>${evidenceLabel(item.evidenceConfidence)}</dd><dt>Pareto有效前沿</dt><dd>${item.paretoEfficient ? '是' : '否'}</dd></dl>`;
  }

  function showTooltip(modelId, clientX, clientY, lock = false) {
    const item = candidate(modelId), tooltip = $('acu-chart-tooltip'), wrap = tooltip.parentElement;
    if (!item) return;
    tooltip.innerHTML = tooltipHtml(item); tooltip.hidden = false;
    if (window.innerWidth > 700) {
      const rect = wrap.getBoundingClientRect();
      let left = clientX - rect.left + 14, top = clientY - rect.top + 14;
      if (left + 280 > rect.width) left = Math.max(8, left - 300);
      if (top + 260 > rect.height) top = Math.max(8, top - 270);
      tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
    }
    state.selected = lock ? modelId : state.selected;
  }

  function hideTooltip() { if (!state.selected) $('acu-chart-tooltip').hidden = true; }

  function renderModelList() {
    const sortKey = $('acu-model-sort').value;
    const selectedIds = new Set(visibleModelIds());
    const items = core.sortCandidates(candidates().filter((item) => selectedIds.has(item.modelId)), sortKey);
    $('acu-integrated-legend').innerHTML = items.map((item) => {
      const roles = roleLabels(item.modelId);
      return `<button type="button" class="acu-model-row${state.selected === item.modelId || state.locked.has(item.modelId) ? ' selected' : ''}" data-model-id="${item.modelId}"><span class="acu-model-title"><b>${item.displayName}</b><em>${roles.map((role) => `<i>${role}</i>`).join('')}</em></span><span class="acu-model-metrics"><strong>${score(item.predictedScore)}<small>预计得分</small></strong><strong>${money(item.expectedTotalCost)}<small>预计综合成本</small></strong></span><span class="acu-model-detail">${item.p50LatencyMs === null ? 'P50 样本不足' : `P50 ${(item.p50LatencyMs / 1000).toFixed(1)}s`} · ${healthLabel(item.healthStatus)} · ${evidenceLabel(item.evidenceConfidence)}</span></button>`;
    }).join('');
  }

  function technicalDetails() {
    if (!state.evaluation || !state.trace) return;
    const evaluation = state.evaluation, trace = state.trace, latency = trace.latency_breakdown || {}, usage = trace.usage_audit || {}, costs = trace.cost_audit || {};
    const attempts = (trace.attempts || []).map((item, index) => `#${index + 1} ${item.model}: ${item.status}${item.error_category ? `/${item.error_category}` : ''} · ${item.attempt_type || 'initial'} · ${item.execution_profile_id || 'default'} · ${item.latency_ms}ms`).join('<br>') || '—';
    const fields = [
      ['任务评估来源', sourceLabel(evaluation)[0]], ['执行状态', executionStatus()], ['路由模式', evaluation.shadowMode ? 'Shadow观察' : 'ACU实际执行'],
      ['Judge模型', evaluation.judgeModel], ['Prompt版本', evaluation.promptVersion], ['缓存状态', evaluation.judgeStatus], ['Context Hash', `…${evaluation.contextSha256.slice(-8)}`],
      ['曲线计算', '冻结曲线线性插值'], ['Routing Model Version', evaluation.routingModelVersion], ['Request ID', evaluation.requestId],
      ['executionProfileId', trace.execution_profile_id], ['完整Attempts', attempts], ['validator_result', trace.validator_result], ['validator', trace.validator],
      ['validator_reason', trace.validator_reason], ['quality_fallback_used', String(trace.quality_fallback_used === true)], ['任务评估耗时', `${latency.judge_latency_ms ?? evaluation.judgeLatencyMs} ms`],
      ['Router总耗时', `${latency.total_router_latency_ms ?? 0} ms`], ['Completion / Reasoning Token', `${usage.completionTokens ?? '—'} / ${usage.reasoningTokens ?? '—'}`],
      ['Usage来源', usage.usageSource], ['Judge成本', money(costs.judge_cost)], ['模型成本', money(costs.model_call_cost)], ['本次实际总成本', money(costs.total_acu_cost)],
    ];
    $('acu-technical-details').innerHTML = fields.map(([key, value]) => `<div><dt>${key}</dt><dd>${value ?? '—'}</dd></div>`).join('');
  }

  function render() { updateSummary(); drawChart(); technicalDetails(); }

  function setMode(mode) {
    if (!['featured', 'all'].includes(mode) || state.mode === mode) return;
    state.mode = mode; state.hovered = null; state.selected = null; $('acu-chart-tooltip').hidden = true;
    document.querySelectorAll('[data-chart-mode]').forEach((button) => button.classList.toggle('active', button.dataset.chartMode === mode));
    if (!state.views[mode]) autoFit(mode); else drawChart();
  }

  function zoom(factor, center) {
    const view = currentView(), [minimum, maximum] = view.x, span = maximum - minimum;
    const newSpan = Math.max(8, Math.min(100, span * factor));
    const focus = center ?? (minimum + maximum) / 2;
    const ratio = span ? (focus - minimum) / span : 0.5;
    view.x = core.normalizeDomain([focus - newSpan * ratio, focus + newSpan * (1 - ratio)], Math.min(8, newSpan));
    view.global = view.x[0] === 0 && view.x[1] === 100;
    drawChart();
  }

  function pan(delta) {
    const view = currentView(), span = view.x[1] - view.x[0];
    view.x = core.normalizeDomain([view.x[0] + delta, view.x[1] + delta], span);
    view.global = view.x[0] === 0 && view.x[1] === 100;
    drawChart();
  }

  function nearestModel(event) {
    const geometry = state.geometry;
    if (!geometry) return null;
    const rect = $('acu-integrated-chart').getBoundingClientRect();
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    const xValue = geometry.domain.x[0] + (px - geometry.bounds.left) / (geometry.bounds.right - geometry.bounds.left) * (geometry.domain.x[1] - geometry.domain.x[0]);
    let nearest = null, distance = 12;
    for (const path of geometry.paths) {
      const value = interpolateCurve(path.curve, xValue);
      if (value === null) continue;
      const candidateDistance = Math.abs(geometry.yScale(value) - py);
      if (candidateDistance < distance) { distance = candidateDistance; nearest = path.modelId; }
    }
    for (const point of geometry.points) {
      const pointDistance = Math.hypot(point.px - px, point.py - py);
      if (pointDistance < distance + 5) { distance = pointDistance; nearest = point.modelId; }
    }
    return { modelId: nearest, px, py, xValue };
  }

  function lockModel(modelId) {
    if (!modelId) return;
    const permanent = new Set([state.plan?.qualityCeilingModel?.modelId, state.plan?.recommendation?.recommended?.modelId, state.evaluation?.actualModel]);
    if (!permanent.has(modelId)) {
      if (state.locked.has(modelId)) state.locked.delete(modelId);
      else { while (state.locked.size >= 3) state.locked.delete(state.locked.values().next().value); state.locked.add(modelId); }
    }
    state.selected = modelId; drawChart();
  }

  function bindInteractions() {
    const canvas = $('acu-integrated-chart');
    canvas.addEventListener('wheel', (event) => {
      if (!state.geometry) return; event.preventDefault();
      const nearest = nearestModel(event); zoom(event.deltaY < 0 ? 0.82 : 1.22, nearest?.xValue);
    }, { passive: false });
    canvas.addEventListener('mousedown', (event) => { state.dragging = { x: event.clientX, domain: [...currentView().x] }; });
    window.addEventListener('mousemove', (event) => {
      if (state.dragging && state.geometry) {
        const span = state.dragging.domain[1] - state.dragging.domain[0];
        const delta = -(event.clientX - state.dragging.x) / (state.geometry.bounds.right - state.geometry.bounds.left) * span;
        currentView().x = core.normalizeDomain([state.dragging.domain[0] + delta, state.dragging.domain[1] + delta], span); currentView().global = false; drawChart(); return;
      }
    });
    canvas.addEventListener('mousemove', (event) => {
      if (state.dragging) return;
      const nearest = nearestModel(event); state.hovered = nearest?.modelId || null; drawChart();
      if (nearest?.modelId) showTooltip(nearest.modelId, event.clientX, event.clientY); else hideTooltip();
    });
    window.addEventListener('mouseup', () => { state.dragging = null; });
    canvas.addEventListener('mouseleave', () => { if (!state.dragging) { state.hovered = null; hideTooltip(); drawChart(); } });
    canvas.addEventListener('dblclick', () => autoFit());
    canvas.addEventListener('click', (event) => { const nearest = nearestModel(event); if (nearest?.modelId) { lockModel(nearest.modelId); showTooltip(nearest.modelId, event.clientX, event.clientY, true); } else { state.selected = null; $('acu-chart-tooltip').hidden = true; drawChart(); } });
    canvas.addEventListener('pointerdown', (event) => { if (event.pointerType === 'touch') { canvas.setPointerCapture(event.pointerId); state.touches.set(event.pointerId, { x: event.clientX, y: event.clientY }); } });
    canvas.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'touch' || !state.touches.has(event.pointerId)) return;
      const previous = state.touches.get(event.pointerId); state.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const touches = [...state.touches.values()];
      if (touches.length === 1 && state.geometry) pan(-(event.clientX - previous.x) / (state.geometry.bounds.right - state.geometry.bounds.left) * (currentView().x[1] - currentView().x[0]));
      if (touches.length === 2) { const distance = Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y); if (state.pinchDistance) zoom(state.pinchDistance / distance); state.pinchDistance = distance; }
    });
    const endTouch = (event) => { state.touches.delete(event.pointerId); if (state.touches.size < 2) state.pinchDistance = null; };
    canvas.addEventListener('pointerup', endTouch); canvas.addEventListener('pointercancel', endTouch);
    document.querySelectorAll('[data-chart-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.chartMode)));
    document.querySelectorAll('[data-chart-action]').forEach((button) => button.addEventListener('click', () => {
      const action = button.dataset.chartAction;
      if (action === 'zoom-in') zoom(0.8); else if (action === 'zoom-out') zoom(1.25); else if (action === 'fit') autoFit();
      else if (action === 'global') { state.views[state.mode] = { x: [0, 100], global: true }; drawChart(); }
    }));
    $('acu-model-sort').addEventListener('change', renderModelList);
    $('acu-integrated-legend').addEventListener('click', (event) => { const row = event.target.closest('[data-model-id]'); if (row) { lockModel(row.dataset.modelId); const point = state.geometry?.points.find((item) => item.modelId === row.dataset.modelId); if (point) { const rect = $('acu-integrated-chart').getBoundingClientRect(); showTooltip(row.dataset.modelId, rect.left + point.px, rect.top + point.py, true); } } });
  }

  window.addEventListener('acu:plan', (event) => {
    state.plan = event.detail.plan; state.evaluation = null; state.trace = null; state.views = { featured: { x: [0, 100], global: true }, all: null }; state.locked.clear(); updateSummary(); drawChart();
  });
  window.addEventListener('acu:evaluation', (event) => { state.trace = event.detail.trace; state.evaluation = state.trace.acu_demo; if (!state.plan) state.plan = state.evaluation; render(); });
  window.addEventListener('resize', drawChart);
  safeFetch(`${api}/catalog`).then((response) => response.json()).then((catalog) => { state.catalog = catalog; drawChart(); }).catch(() => {});
  bindInteractions();
  window.AcuInteractiveChart = { setMode, autoFit, zoom, getState: () => ({ mode: state.mode, view: currentView(), visibleModelIds: visibleModelIds(), locked: [...state.locked], recommendedModel: state.plan?.recommendation?.recommended?.modelId, qualityCeilingModel: state.plan?.qualityCeilingModel?.modelId, actualModel: state.evaluation?.actualModel }) };
})();
