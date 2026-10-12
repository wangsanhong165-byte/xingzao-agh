const labels={
 baseline:'原件直立（0.5 mm）',boundary:'边界修正（0.7 mm）',normal:'正常修正（0.8 mm）',
 'strong-baseline-face-up':'原件侧放对照（0.5 mm）','native-five-original-side-up':'五姿态原件交付（0.5 mm）',
};
const esc=v=>String(v??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(v,d=2)=>Number.isFinite(v)?v.toFixed(d):'—';
const time=v=>{if(!Number.isFinite(v))return '—';const s=Math.round(v),h=Math.floor(s/3600),m=Math.floor(s%3600/60);return `${h?h+'小时':''}${m}分${s%60}秒`};

export function buildReviewerResult(review,expectedCases,photo=null,checkedAt=new Date().toISOString()){
 if(review?.valid!==true||!Array.isArray(review.cases)||review.cases.length===0)throw Error('复核结果未确认，不能生成通过报告');
 const expected=new Map(expectedCases.map(c=>[c.id,c.expectedToolpathFeasible]));
 const rows=review.cases.map(c=>{
  const want=expected.get(c.id);
  if(typeof want!=='boolean'||typeof c.toolpathFeasible!=='boolean'||want!==c.toolpathFeasible)throw Error(`案例 ${c.id} 与预期不符`);
  const reason=c.toolpathFeasible?'关键特征和细杆连续性通过':c.audits?.currentFeatures?.passed?'特征采样通过，细杆刀轨断段':'关键特征保留未通过';
  return {id:c.id,label:labels[c.id]??c.id,expected:want?'可行':'不可行',actual:c.toolpathFeasible?'可行':'不可行',reason,filamentG:c.metrics?.filamentG,timeSeconds:c.metrics?.estimatedTimeSeconds,matches:true};
 });
 return {ok:true,checkedAt,fileCount:review.fileCount,rows,photo,budgetOptions:review.budgetFailure.actualOptions,details:review};
}

export function consoleSummary(result){
 if(!result.ok)return `复核未通过：${result.error}`;
 const lines=['形造｜提交样例复核','结论：通过，所有案例结果均与预期一致。',`已核对 ${result.fileCount} 个输入文件。`];
 for(const r of result.rows)lines.push(`· ${r.label}：${r.actual}，符合预期`);
 if(result.photo)lines.push(`· 外观保护：区域支撑刀轨减少 ${num(result.photo.reductionPercent)}%`);
 lines.push('完整结果见复核报告.html。');return lines.join('\n');
}

export function renderReviewerReport(result){
 const ok=result.ok===true;
 const rows=ok?result.rows.map(r=>`<tr><td>${esc(r.label)}</td><td>${esc(r.expected)}</td><td><strong>${esc(r.actual)}</strong><small>${esc(r.reason)}</small></td><td>${num(r.filamentG)} g<small>${time(r.timeSeconds)}</small></td><td><span class="match">一致</span></td></tr>`).join(''):'';
 const p=ok?result.photo:null;
 const photo=p?`<section><h2>摄影模型的外观保护</h2><div class="photo"><div><span>保护区支撑刀轨</span><strong>${num(p.baselineMm)} → ${num(p.bestMm)} mm</strong></div><div><span>降幅</span><strong>${num(p.reductionPercent)}%</strong></div></div><p>切片估算耗材 ${num(p.baselineG)} → ${num(p.bestG)} g；时长 ${time(p.baselineTime)} → ${time(p.bestTime)}。</p></section>`:'';
 const data=ok?JSON.stringify(result.details,null,2):JSON.stringify({passed:false,error:result.error},null,2);
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>形造｜样例复核报告</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f7f8;color:#202e38;font-family:"Microsoft YaHei",sans-serif;line-height:1.65}main{max-width:1040px;margin:36px auto;padding:0 24px}header{margin-bottom:22px}.eyebrow{color:#536b76;font-size:14px;margin:0}h1{font-size:30px;margin:5px 0}h2{font-size:19px;margin:0 0 14px}.muted{color:#60737d;font-size:14px}.verdict,section{background:white;border:1px solid #dfe7eb;border-radius:12px;padding:22px;margin:18px 0}.verdict{border-left:6px solid ${ok?'#24816c':'#bd4848'}}.verdict strong{font-size:23px;color:${ok?'#1f715f':'#a13333'}}.verdict p{margin:6px 0 0}table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:#526976;font-weight:500;background:#f3f6f7}th,td{padding:13px 12px;border-bottom:1px solid #e5ecef;vertical-align:top}small{display:block;font-size:12px;color:#657780;margin-top:3px}.match{color:#207260;background:#edf7f3;border-radius:6px;padding:4px 9px;white-space:nowrap}.photo{display:flex;gap:38px;flex-wrap:wrap}.photo span{display:block;color:#60737d;font-size:13px}.photo strong{display:block;font-size:22px;margin:4px 0}details{background:#fff;border:1px solid #dfe7eb;border-radius:9px;padding:14px 18px;margin:20px 0}summary{cursor:pointer;color:#516a77}pre{white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:600px;overflow:auto}.scroll{overflow-x:auto}.note{font-size:13px;color:#617580}footer{padding:12px 0 30px;color:#71838d;font-size:12px}@media print{body{background:#fff}main{margin:0;max-width:none}details{display:none}.verdict,section{break-inside:avoid}}
</style></head><body><main><header><p class="eyebrow">形造 · 提交样例</p><h1>离线复核报告</h1><p class="muted">复核时间：${esc(new Date(result.checkedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}</p></header>
<div class="verdict"><strong>${ok?'复核通过':'复核未通过'}</strong><p>${ok?`${result.rows.length} 个刀轨案例均与预期一致，${result.fileCount} 个输入文件身份已核对。`:esc(result.error)}</p></div>
${ok?`<section><h2>案例结果</h2><p class="note">可行性按申报的关键特征和刀轨要求判断。失败、边界案例用于对照；“一致”表示实际结果符合预期。</p><div class="scroll"><table><thead><tr><th>案例</th><th>预期</th><th>本次结果</th><th>切片估算<br>耗材／时长</th><th>核验</th></tr></thead><tbody>${rows}</tbody></table></div><p class="note">修正选项边界：${result.budgetOptions.length===0?'没有可用候选，符合预设预算限制。':'候选选项与预设结果一致。'}</p></section>`:''}
${photo}<p class="note">验证方式：重新核对已有文件、摆放与真实切片刀轨；网格探针采用随包记录。本次未重新生成模型或打印实物。</p>
<details><summary>查看详细核验数据</summary><pre>${esc(data)}</pre></details><footer>原始任务的模型与工具执行过程见提交包中的 AGH运行记录。</footer></main></body></html>`;
}
