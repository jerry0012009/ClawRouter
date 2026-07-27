const prefixMatch = location.pathname.match(/^\/(acu-router(?:-dev)?)(?:\/|$)/);
const PREFIX = prefixMatch ? `/${prefixMatch[1]}` : '';
const API = `${PREFIX}/acu/api`;
document.getElementById('curve-gallery-link').href = `${PREFIX}/acu/curves/`;

const colors = ['#5aa7ff','#f0b44d','#58d5cf','#ef7f45','#dd79b5','#8fb86b','#a88beb','#8ec8ff','#f3cc7a','#78e0be','#ee9a6c','#b6a3ff','#d2dce6','#ff8fa3','#76b7ff','#b7e36d','#d4a5ff','#ffc46b'];
let catalog = null;
let evaluation = null;
let showAll = false;
let activeModels = new Set();
let chartState = [];
const $ = id => document.getElementById(id);
const score = value => `${(100 * value).toFixed(1)}分`;
const pct = value => `${(100 * value).toFixed(1)}%`;
const usd = value => `US$${Number(value).toFixed(value < .01 ? 5 : 4)}`;

function selectedPreset() {
  return catalog?.twinPresets?.find(item => item.id === $('preset').value);
}

function setPreset(id) {
  const preset = catalog?.twinPresets?.find(item => item.id === id);
  if (!preset) return;
  $('context-input').value = JSON.stringify(preset.request, null, 2);
  $('preset-meta').textContent = `来源：${preset.source} · 发布档位：${preset.publishedTier} · ${preset.category}`;
}

function visibleModels() {
  if (!catalog) return [];
  const provider = $('provider-filter').value;
  let base = catalog.models.filter(model => model.routingEligible && (provider === 'all' || model.provider === provider));
  if (!showAll) {
    const defaults = base.filter(model => model.defaultDisplay);
    const recommendedId = evaluation?.recommendation.recommended.modelId;
    const recommended = recommendedId ? base.find(model => model.modelId === recommendedId) : null;
    base = recommended && !recommended.defaultDisplay ? [...defaults.slice(0, 5), recommended] : defaults;
  }
  return base.filter(model => activeModels.has(model.modelId));
}

function makeProbabilityBars(judge) {
  const rows = [['Low',judge?.pLow||0,'#5aa7ff'],['Mid',judge?.pMid||0,'#58d5cf'],['Mid-high',judge?.pMidHigh||0,'#f0b44d'],['High',judge?.pHigh||0,'#ef7f45']];
  $('probability-bars').innerHTML = rows.map(([name,value,color]) => `<div class="prob-row"><span class="prob-label">${name}</span><div class="prob-track"><div class="prob-fill" style="width:${value*100}%;background:${color}"></div></div><span class="prob-value">${pct(value)}</span></div>`).join('');
}

function curveValue(modelId, difficulty) {
  return catalog.curves[modelId][Math.max(0, Math.min(100, Math.round(difficulty)))]?.estimatedQuality || 0;
}

function estimateFor(modelId) {
  return evaluation?.recommendation.estimates.find(item => item.modelId === modelId);
}

function renderLegend() {
  $('model-legend').innerHTML = visibleModels().map(model => {
    const estimate = estimateFor(model.modelId);
    const quality = estimate?.estimatedQuality ?? curveValue(model.modelId, evaluation?.difficultyScore || 50);
    const profile = model.curveProfile.replaceAll('_', ' ');
    return `<div class="legend-item" data-model="${model.modelId}"><span class="legend-swatch" style="background:${colors[catalog.models.indexOf(model)%colors.length]}"></span><div><div class="legend-name">${model.displayName}</div><div class="legend-meta">${profile} · anchor ${model.abilityAnchor.toFixed(3)} · ${model.profileConfidence}</div></div><span class="legend-value">${score(quality)}</span></div>`;
  }).join('');
  document.querySelectorAll('.legend-item').forEach(item => item.addEventListener('click', () => { activeModels.delete(item.dataset.model); renderAll(); }));
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill(); ctx.stroke();
}

function drawPointLabels(ctx, points, width, height, xLine, margin) {
  if (!evaluation) return;
  const recommendedId = evaluation.recommendation.recommended.modelId;
  const labels = points.filter(point => point.model.defaultDisplay || point.model.modelId === recommendedId)
    .sort((a,b) => a.py - b.py);
  const minGap = 39;
  labels.forEach((label, index) => {
    label.labelY = Math.max(margin.top + 20, label.py);
    if (index && label.labelY < labels[index-1].labelY + minGap) label.labelY = labels[index-1].labelY + minGap;
  });
  const overflow = labels.length ? labels.at(-1).labelY - (height - margin.bottom - 20) : 0;
  if (overflow > 0) labels.forEach(label => { label.labelY -= overflow; });
  const boxWidth = 168, boxHeight = 34;
  const rightSide = xLine < width * .67;
  const boxX = rightSide ? Math.min(width - margin.right - boxWidth, xLine + 14) : Math.max(margin.left, xLine - boxWidth - 14);
  for (const point of labels) {
    const estimate = estimateFor(point.model.modelId);
    const selected = point.model.modelId === recommendedId;
    ctx.strokeStyle = point.color; ctx.lineWidth = selected ? 2 : 1;
    ctx.beginPath(); ctx.moveTo(point.px, point.py); ctx.lineTo(rightSide ? boxX : boxX + boxWidth, point.labelY); ctx.stroke();
    ctx.fillStyle = selected ? '#173558' : 'rgba(9,20,31,.94)'; ctx.strokeStyle = selected ? '#f0b44d' : point.color;
    roundedRect(ctx, boxX, point.labelY - boxHeight/2, boxWidth, boxHeight, 6);
    ctx.textAlign = 'left'; ctx.fillStyle = selected ? '#f0b44d' : '#edf4fa'; ctx.font = `${selected ? '700' : '600'} 10px Inter, sans-serif`;
    ctx.fillText(point.model.displayName, boxX + 8, point.labelY - 3);
    ctx.fillStyle = '#aebdca'; ctx.font = '9px ui-monospace, monospace';
    ctx.fillText(`${score(point.quality)} · ${usd(estimate?.expectedTotalCost || 0)}`, boxX + 8, point.labelY + 10);
  }
}

function drawChart() {
  const canvas = $('curve-chart'), wrap = canvas.parentElement, ratio = devicePixelRatio || 1;
  const width = wrap.clientWidth - 16, height = wrap.clientHeight - 16;
  canvas.width = width * ratio; canvas.height = height * ratio; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
  const margin = {left:58,right:22,top:24,bottom:48}, plotW=width-margin.left-margin.right, plotH=height-margin.top-margin.bottom;
  const x = v => margin.left + plotW*v/100, y = v => margin.top + plotH*(1-v);
  ctx.clearRect(0,0,width,height); ctx.font='11px ui-monospace,monospace'; ctx.lineWidth=1;
  for (let tick=0; tick<=100; tick+=20) {
    ctx.strokeStyle='#243547'; ctx.beginPath(); ctx.moveTo(margin.left,y(tick/100)); ctx.lineTo(width-margin.right,y(tick/100)); ctx.stroke();
    ctx.fillStyle='#94a6b8'; ctx.textAlign='right'; ctx.fillText(`${tick}`,margin.left-9,y(tick/100)+4); ctx.textAlign='center'; ctx.fillText(String(tick),x(tick),height-25);
  }
  ctx.fillStyle='#94a6b8'; ctx.textAlign='center'; ctx.fillText('请求难度',margin.left+plotW/2,height-5);
  ctx.save(); ctx.translate(15,margin.top+plotH/2); ctx.rotate(-Math.PI/2); ctx.fillText('预计模型得分',0,0); ctx.restore();
  chartState=[];
  for (const model of visibleModels()) {
    const color=colors[catalog.models.indexOf(model)%colors.length], points=catalog.curves[model.modelId];
    ctx.strokeStyle=color; ctx.lineWidth=evaluation?.recommendation.recommended.modelId===model.modelId?3:1.6; ctx.setLineDash(model.profileConfidence==='low'?[6,4]:[]); ctx.beginPath();
    points.forEach((point,index)=>{const px=x(point.difficultyScore),py=y(point.estimatedQuality);if(index===0)ctx.moveTo(px,py);else ctx.lineTo(px,py)}); ctx.stroke(); ctx.setLineDash([]);
    if (evaluation) {
      const quality=estimateFor(model.modelId)?.estimatedQuality,px=x(evaluation.difficultyScore),py=y(quality);ctx.fillStyle=color;ctx.beginPath();ctx.arc(px,py,evaluation.recommendation.recommended.modelId===model.modelId?5:3.5,0,Math.PI*2);ctx.fill();chartState.push({model,px,py,quality,color});
    }
  }
  if (evaluation) {
    const currentX=x(evaluation.difficultyScore);ctx.strokeStyle='#d2dce6';ctx.lineWidth=1;ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(currentX,margin.top);ctx.lineTo(currentX,height-margin.bottom);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#d2dce6';ctx.textAlign='left';ctx.fillText(`当前 ${evaluation.difficultyScore.toFixed(1)}`,Math.min(width-100,currentX+6),margin.top+12);
    drawPointLabels(ctx, chartState, width, height, currentX, margin);
  }
}

function renderRecommendation() {
  if (!evaluation) return;
  const rec=evaluation.recommendation.recommended;
  $('recommended-model').textContent=rec.displayName; $('recommendation-reason').textContent=evaluation.recommendation.reason;
  $('estimated-quality').textContent=score(rec.estimatedQuality); $('conservative-quality').textContent=score(rec.conservativeQuality);
  $('call-cost').textContent=usd(rec.estimatedCallCost); $('total-cost').textContent=usd(rec.expectedTotalCost);
  $('flagship-savings').textContent=`${pct(rec.savingsPercentVsFlagship)} · ${usd(rec.savingsVsFlagship)}`; $('fallback-model').textContent=evaluation.recommendation.fallbackModel.displayName;
  const entries=[['性价比备选',evaluation.recommendation.valueAlternative],['旗舰备选',evaluation.recommendation.flagshipAlternative]];
  $('alternatives').innerHTML=entries.map(([label,item])=>item?`<div class="alternative"><div class="alternative-head"><strong>${label} · ${item.displayName}</strong><span>${score(item.estimatedQuality)}</span></div><p>预计综合成本 ${usd(item.expectedTotalCost)} · ${item.paretoEfficient?'有效前沿':'被支配'}</p></div>`:'').join('');
}

function renderEvaluation() {
  const judge=evaluation.judge; $('difficulty-score').textContent=evaluation.difficultyScore.toFixed(1);
  $('judge-badge').textContent=evaluation.judgeStatus==='rules_fallback'?'规则估算':evaluation.judgeStatus==='cache_hit'?'Judge 缓存':'DeepSeek V4 Flash';
  $('judge-badge').className=`badge ${evaluation.judgeStatus==='rules_fallback'?'fallback':'live'}`;
  $('judge-explanation').textContent=judge.explanation; $('judge-signals').innerHTML=judge.signals.map(signal=>`<span class="signal">${signal}</span>`).join('');
  $('judge-confidence').textContent=pct(judge.confidence); $('judge-latency').textContent=`${evaluation.judgeLatencyMs} ms`; $('context-tokens').textContent=`${evaluation.contextTokenEstimate.toLocaleString()} visible · ${(evaluation.judgePromptTokens + evaluation.judgeCompletionTokens).toLocaleString()} Judge${evaluation.contextTruncated?' · truncated':''}`;
  $('disclaimer').textContent=evaluation.disclaimer; makeProbabilityBars(judge); renderRecommendation(); renderAll();
  const preset=selectedPreset(); if(preset)$('preset-meta').textContent=`来源：${preset.source} · 发布档位：${preset.publishedTier} · 当前推荐：${evaluation.recommendation.recommended.displayName}`;
}

function renderAll(){renderLegend();drawChart()}

async function evaluate(forceJudgeRefresh=false) {
  let request; try { request=JSON.parse($('context-input').value); } catch(error) { alert(`JSON格式错误：${error.message}`); return; }
  const button=$('evaluate-button');button.disabled=true;button.textContent='Judge评估中…';
  try { const response=await fetch(`${API}/evaluate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,quality_target:Number($('quality-target').value)/100,expected_output_tokens:request.max_tokens||800,force_judge_refresh:forceJudgeRefresh})});const payload=await response.json();if(!response.ok)throw new Error(payload.error?.message||'ACU评估失败');evaluation=payload;renderEvaluation(); }
  catch(error){alert(error.message)} finally{button.disabled=false;button.textContent='评估并推荐'}
}

async function load() {
  makeProbabilityBars(); const response=await fetch(`${API}/catalog`); if(!response.ok)throw new Error('模型目录加载失败'); catalog=await response.json();
  catalog.models.filter(model=>model.routingEligible).forEach(model=>activeModels.add(model.modelId));
  $('preset').innerHTML=catalog.twinPresets.map(item=>`<option value="${item.id}">${item.title} · ${item.publishedTier}</option>`).join(''); setPreset(catalog.twinPresets[0].id);
  const providers=[...new Set(catalog.models.filter(model=>model.routingEligible).map(model=>model.provider))].sort();$('provider-filter').insertAdjacentHTML('beforeend',providers.map(provider=>`<option value="${provider}">${provider}</option>`).join(''));
  $('runtime-status').textContent=`${catalog.models.filter(model=>model.routingEligible).length} callable models · ${catalog.generatedAt}`; renderAll();
}

$('preset').addEventListener('change',event=>setPreset(event.target.value));
$('quality-target').addEventListener('input',event=>$('quality-target-label').textContent=`${event.target.value}分`);
$('evaluate-button').addEventListener('click',()=>evaluate(false)); $('provider-filter').addEventListener('change',renderAll);
$('force-evaluate-button').addEventListener('click',()=>evaluate(true));
$('expand-models').addEventListener('click',()=>{showAll=!showAll;$('expand-models').textContent=showAll?'仅看拳头模型':'查看全部模型';renderAll()});
$('curve-chart').addEventListener('mousemove',event=>{const rect=event.target.getBoundingClientRect(),mx=event.clientX-rect.left,my=event.clientY-rect.top,nearest=chartState.map(point=>({...point,distance:Math.hypot(point.px-mx,point.py-my)})).sort((a,b)=>a.distance-b.distance)[0],tip=$('chart-tooltip');if(!nearest||nearest.distance>22){tip.hidden=true;return}const estimate=estimateFor(nearest.model.modelId), evidence=nearest.model.benchmarkEvidence[0];tip.innerHTML=`<strong>${nearest.model.displayName}</strong><br>预计得分 ${score(nearest.quality)} · 区间 ${score(estimate.qualityLower)}–${score(estimate.qualityUpper)}<br>预计综合成本 ${usd(estimate.expectedTotalCost)}<br>${nearest.model.curveProfile.replaceAll('_',' ')} · ${nearest.model.profileConfidence}<br>${evidence.benchmarkName}`;tip.style.left=`${Math.min(rect.width-280,mx+14)}px`;tip.style.top=`${Math.max(8,my-65)}px`;tip.hidden=false});
$('curve-chart').addEventListener('mouseleave',()=>$('chart-tooltip').hidden=true); window.addEventListener('resize',drawChart);
load().then(()=>{if(new URLSearchParams(location.search).get('autorun')==='1')return evaluate();}).catch(error=>{$('runtime-status').textContent=error.message});
