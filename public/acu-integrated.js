(() => {
  const prefix = location.pathname.match(/^\/(acu-router(?:-dev)?)(?:\/|$)/)?.[1];
  const api = prefix ? `${location.origin}/${prefix}/acu/api` : `${location.origin}/acu/api`;
  const chatApi = prefix ? `${location.origin}/${prefix}/v1/chat/completions` : `${location.origin}/v1/chat/completions`;
  const colors = ['#90e8a0','#ffd76a','#9fc7ff','#ff8fa3','#b7a1ff','#67d8c2'];
  let catalog;
  let latestEvaluation;
  let latestMessages;

  const $ = (id) => document.getElementById(id);
  const money = (value) => `US$${Number(value || 0).toFixed(value < .01 ? 5 : 3)}`;
  const score = (value) => `${Number(value).toFixed(1)}分`;

  function currentMessages() {
    const prompt = $('prompt-input')?.value.trim() || '';
    const spec = typeof window.getQualitySpec === 'function' ? window.getQualitySpec() : null;
    const system = spec && typeof window.qualitySpecPrompt === 'function' ? window.qualitySpecPrompt(spec) : '请准确完成用户请求。';
    return [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  }

  function sourceLabel(evaluation) {
    if (evaluation.judgeStatus === 'live') return ['实时Judge','live'];
    if (evaluation.judgeStatus === 'cache_hit') return ['Judge缓存','cache'];
    return ['规则估算','rules'];
  }

  function drawChart(evaluation) {
    if (!catalog) return;
    const canvas = $('acu-integrated-chart');
    const ratio = devicePixelRatio || 1;
    const width = Math.max(620, canvas.clientWidth || 760), height = 385;
    canvas.width = width * ratio; canvas.height = height * ratio;
    const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
    const margin = { left: 46, right: 18, top: 18, bottom: 35 };
    const plotW = width - margin.left - margin.right, plotH = height - margin.top - margin.bottom;
    const x = (value) => margin.left + plotW * value / 100;
    const y = (value) => margin.top + plotH * (1 - value / 100);
    ctx.clearRect(0, 0, width, height); ctx.font = '10px ui-monospace,monospace';
    for (let tick=0; tick<=100; tick+=20) {
      ctx.strokeStyle='rgba(255,255,255,.10)';ctx.beginPath();ctx.moveTo(margin.left,y(tick));ctx.lineTo(width-margin.right,y(tick));ctx.stroke();
      ctx.fillStyle='#888';ctx.textAlign='right';ctx.fillText(String(tick),margin.left-7,y(tick)+3);ctx.textAlign='center';ctx.fillText(String(tick),x(tick),height-14);
    }
    const defaults = catalog.models.filter((model) => model.defaultDisplay && model.routingEligible).slice(0,6);
    const estimates = new Map(evaluation.recommendation.estimates.map((item) => [item.modelId,item]));
    const points=[];
    defaults.forEach((model,index) => {
      const curve=catalog.curves[model.modelId], color=colors[index%colors.length];ctx.strokeStyle=color;ctx.lineWidth=model.modelId===evaluation.recommendation.recommended.modelId?2.8:1.5;ctx.beginPath();
      curve.forEach((point,i)=>{const px=x(point.difficultyScore),py=y(point.estimatedQuality*100);if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py)});ctx.stroke();
      const estimate=estimates.get(model.modelId);if(!estimate)return;const px=x(evaluation.difficultyScore),py=y(estimate.predictedScore);ctx.fillStyle=color;ctx.beginPath();ctx.arc(px,py,model.modelId===evaluation.recommendation.recommended.modelId?5:3.5,0,Math.PI*2);ctx.fill();points.push({model,estimate,px,py,color});
    });
    const lineX=x(evaluation.difficultyScore);ctx.strokeStyle='rgba(255,255,255,.65)';ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(lineX,margin.top);ctx.lineTo(lineX,height-margin.bottom);ctx.stroke();ctx.setLineDash([]);
    const labels=points.sort((a,b)=>a.py-b.py);const gap=36;labels.forEach((item,i)=>{item.ly=Math.max(27,item.py);if(i&&item.ly<labels[i-1].ly+gap)item.ly=labels[i-1].ly+gap});const overflow=labels.at(-1)?.ly-(height-52)||0;if(overflow>0)labels.forEach(item=>item.ly-=overflow);
    const right=lineX<width*.68, boxW=170, boxH=31, boxX=right?Math.min(width-boxW-9,lineX+12):Math.max(margin.left,lineX-boxW-12);
    labels.forEach((item)=>{const selected=item.model.modelId===evaluation.recommendation.recommended.modelId;ctx.strokeStyle=item.color;ctx.lineWidth=selected?2:1;ctx.beginPath();ctx.moveTo(item.px,item.py);ctx.lineTo(right?boxX:boxX+boxW,item.ly);ctx.stroke();ctx.fillStyle=selected?'rgba(70,65,28,.97)':'rgba(15,15,17,.96)';ctx.strokeStyle=item.color;ctx.fillRect(boxX,item.ly-boxH/2,boxW,boxH);ctx.strokeRect(boxX,item.ly-boxH/2,boxW,boxH);ctx.textAlign='left';ctx.fillStyle=selected?'#ffd76a':'#f3f3f4';ctx.font='600 10px sans-serif';ctx.fillText(item.model.displayName,boxX+7,item.ly-2);ctx.fillStyle='#aaa';ctx.font='9px ui-monospace,monospace';ctx.fillText(`${score(item.estimate.predictedScore)} · ${money(item.estimate.expectedTotalCost)}`,boxX+7,item.ly+10)});
    $('acu-integrated-legend').innerHTML=defaults.map((model,index)=>{const item=estimates.get(model.modelId);return `<div class="acu-legend-row"><strong><b style="color:${colors[index]}">${model.displayName}</b><em>${item?score(item.predictedScore):'—'}</em></strong><span>${item?money(item.expectedTotalCost):'—'}</span></div>`}).join('');
  }

  function render(evaluation, messages) {
    latestEvaluation=evaluation;latestMessages=messages||latestMessages||currentMessages();
    const [label,cls]=sourceLabel(evaluation), badge=$('acu-source-badge');badge.textContent=label;badge.className=`acu-source-badge ${cls}`;
    $('acu-live-difficulty').textContent=score(evaluation.difficultyScore);
    $('acu-tier-probabilities').innerHTML=[['Low',evaluation.judge.pLow],['Mid',evaluation.judge.pMid],['Mid-high',evaluation.judge.pMidHigh],['High',evaluation.judge.pHigh]].map(([name,value])=>`<div><span>${name}</span><b>${(value*100).toFixed(1)}%</b></div>`).join('');
    const rec=evaluation.recommendation.recommended;$('acu-live-recommendation').textContent=`${rec.displayName} · ${score(rec.predictedScore)} · ${money(rec.expectedTotalCost)}`;$('acu-live-reason').textContent=evaluation.recommendation.reason;
    $('acu-server-feedback').hidden=false;
    $('acu-technical-details').innerHTML=[['状态',label],['上游模型',evaluation.judgeModel],['Provider',evaluation.judgeProvider],['Endpoint Host',evaluation.judgeEndpointHost],['延迟',`${evaluation.judgeLatencyMs} ms`],['Token',`${evaluation.judgePromptTokens}+${evaluation.judgeCompletionTokens} · ${evaluation.usageStatus}`],['Context hash',`…${evaluation.contextSha256.slice(-8)}`],['缓存键',`…${evaluation.cacheKeySha256.slice(-8)}`],['评估时间',evaluation.cacheCreatedAt],['Request ID',evaluation.requestId],['Shadow',String(evaluation.shadowMode)],['曲线版本',evaluation.routingModelVersion]].map(([key,value])=>`<div><dt>${key}</dt><dd>${value??'—'}</dd></div>`).join('');
    drawChart(evaluation);
  }

  async function evaluate(force) {
    const response=await fetch(`${api}/evaluate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'auto',messages:latestMessages||currentMessages(),quality_target:Number($('quality-threshold')?.value||80)/100,expected_output_tokens:800,force_judge_refresh:force})});
    const payload=await response.json();if(!response.ok)throw new Error(payload.error?.message||'评估失败');render(payload,latestMessages||currentMessages());return payload;
  }

  async function loadSummary(){try{const response=await fetch(`${api}/data-summary`);const data=await response.json();$('acu-real-requests').textContent=`${data.realRequestCount||0} 请求 · ${data.labeledRequestCount||0} 标签`;$('acu-data-notice').textContent=data.sampleNotice||`实时Judge ${data.realJudgeRequestCount} 次，缓存命中率 ${((data.cacheHitRate||0)*100).toFixed(1)}%。`;}catch{$('acu-data-notice').textContent='SQLite汇总暂不可用。'}}

  window.addEventListener('acu:evaluation',(event)=>{const trace=event.detail?.trace;const evaluation=trace?.acu_demo;if(evaluation)render(evaluation,currentMessages())});
  $('acu-force-refresh')?.addEventListener('click',async(event)=>{event.currentTarget.disabled=true;try{await evaluate(true)}catch(error){alert(error.message)}finally{event.currentTarget.disabled=false}});
  $('acu-execute-recommended')?.addEventListener('click',async(event)=>{if(!latestEvaluation)return;event.currentTarget.disabled=true;try{const response=await fetch(chatApi,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'auto',messages:latestMessages||currentMessages(),max_tokens:800,cache:false,acu_quality_target:Number($('quality-threshold')?.value||80)/100,acu_execute_recommended:true})});if(!response.ok)throw new Error('推荐模型执行失败');$('acu-live-reason').textContent=`已按 ${latestEvaluation.recommendation.recommended.displayName} 执行；响应保留在主路由链路。`;}catch(error){alert(error.message)}finally{event.currentTarget.disabled=false}});
  document.querySelectorAll('#acu-server-feedback button[data-accepted]').forEach((button)=>button.addEventListener('click',async()=>{if(!latestEvaluation)return;const body={request_id:latestEvaluation.requestId,accepted:button.dataset.accepted==='true',rating:Number($('acu-feedback-rating').value),required_upgrade:$('acu-feedback-upgrade').checked,final_model:latestEvaluation.recommendation.recommended.modelId};const response=await fetch(`${api}/feedback`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});$('acu-feedback-status').textContent=response.ok?'已写入 SQLite':'写入失败';if(response.ok)loadSummary()}));
  Promise.all([fetch(`${api}/catalog`).then(r=>r.json()),loadSummary()]).then(([data])=>{catalog=data;if(latestEvaluation)drawChart(latestEvaluation)}).catch(()=>{$('acu-data-notice').textContent='ACU目录加载失败。'});
  window.addEventListener('resize',()=>{if(latestEvaluation)drawChart(latestEvaluation)});
})();
