import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const $ = id => document.getElementById(id);
const terminal = new Set(['completed', 'stopped', 'failed', 'interrupted', 'no-feasible']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let sources = [], selected = null, point = null, proposal = null, job = null;
let view = null, picking = false, pointer = null, webglAvailable = true;
let revision = 0, sourceRevision = 0, prepareBusy = false, starting = false, startAttempted = false;
let recoveryLocked = false, recoveryQuery = false, pollHandle = null;
const stageNames={prepared:'已准备','agent-running':'AGH 执行中',completed:'已完成',failed:'执行失败',interrupted:'已中断','no-feasible':'当前候选不满足目标'};

function say(id, value) { $(id).textContent = value == null ? '' : String(value); }
function clear(node) { node.replaceChildren(); }
function safe(value, max = 300) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]').replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]').replace(/[A-Za-z]:\\[^\s"']+/g, '[本地路径]').slice(0, max);
}
function finite(value) { if (value == null || String(value).trim() === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function errorMessage(value){const code=safe(typeof value==='object'?value?.message:value);return ({NO_FEASIBLE_POSE:'这五种摆放都没有达到目标。可以查看对比结果，再用同一模型调整保护范围或目标。',PROTECTION_PREPARE_BUSY:'上一项基线检查仍在进行，请稍后再准备。',PROTECTION_REGION_TOO_LARGE:'保护盒超过了模型尺寸，请缩小保护范围。',SOURCE_HASH_MISMATCH:'源模型已改变，请重新选择并检查模型。',PROTECTION_PROPOSAL_STALE:'这份提案无法恢复，请重新准备基线。',PROTECTION_RECOVERY_INCOMPLETE:'任务映射暂不完整，请保留原提案并稍后查询。',PROTECTION_TASK_INTERRUPTED_BEFORE_EXECUTION:'任务保存后执行被中断，原记录已保留，可以用同一模型新建检查。',POSE_TASK_INTERRUPTED:'执行被中断，原任务记录已保留，可以新建一次检查。',PROTECTION_BASELINE_ALREADY_CLEAR:'这个区域在基线下没有计划支撑，无需优化。'})[code]||code;}
function fmt(value, unit = '') { if (value == null || value === '') return '—'; const n = Number(value); return Number.isFinite(n) ? `${Number(n.toFixed(3)).toLocaleString('zh-CN')}${unit}` : '—'; }
function safePath(value) {
  if (typeof value !== 'string' || !value) return null;
  try { const url = new URL(value, location.origin); return url.origin === location.origin && url.pathname.startsWith('/api/') ? `${url.pathname}${url.search}` : null; } catch { return null; }
}
function validBounds(bounds) { return Array.isArray(bounds) && bounds.length === 2 && bounds.every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) && bounds[0].every((n, i) => n < bounds[1][i]); }
function sourceKey(source) {
  if (!source || !['imported', 'reconstructed'].includes(source.kind)) return '';
  const id = source.kind === 'imported' ? source.candidateId : source.jobId;
  return typeof id === 'string' && id ? `${source.kind}:${id}` : '';
}
function validSource(item) {
  return item && sourceKey(item.source) && /^[a-f0-9]{64}$/i.test(item.sourceSha256 || '') && validBounds(item.boundsMm) && safePath(item.stlUrl);
}
function readJobId() {
  const value = new URLSearchParams(location.search).get('job');
  return value && uuidPattern.test(value) ? value : null;
}
function writeJobId(id) {
  const url = new URL(location.href);
  if (id) {url.searchParams.set('job', id);url.searchParams.delete('proposal');url.searchParams.delete('fingerprint');} else url.searchParams.delete('job');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
function writeProposal(data){const url=new URL(location.href);url.searchParams.delete('job');if(data){url.searchParams.set('proposal',data.proposalId);url.searchParams.set('fingerprint',data.fingerprint);}else{url.searchParams.delete('proposal');url.searchParams.delete('fingerprint');}history.replaceState(null,'',`${url.pathname}${url.search}${url.hash}`);}
async function request(path, options) {
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...(options?.headers || {}) } });
  let data = null; try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(safe(data?.error?.message || data?.error || data?.message || `服务返回 HTTP ${response.status}`));
  return data;
}
function invalidate(message = '输入已更改；旧基线、提案和确认已清除。', { clearPoint = false } = {}) {
  revision++; proposal = null; if (clearPoint) point = null; prepareBusy = false;
  $('confirm-proposal').checked = false; $('confirm-wrap').hidden = true; $('proposal-facts').hidden = true; clear($('proposal-facts'));
  clearOverlay(); say('proposal-summary', message); $('proposal-summary').classList.remove('error');
  if (!job && !startAttempted) writeProposal(null);
  updateControls();
}
function locked() { return recoveryLocked || starting || startAttempted || !!job; }
function updateControls() {
  const hold = locked();
  $('source-select').disabled = hold || sources.length === 0;
  $('refresh-sources').disabled = hold;
  for (const id of ['size-width', 'size-depth', 'size-height', 'reduction']) $(id).disabled = hold;
  $('pick-point').disabled = hold || prepareBusy || !selected || !view?.mesh || !webglAvailable;
  $('prepare-job').disabled = hold || prepareBusy || !selected || !point || !validInputs();
  $('confirm-proposal').disabled = hold || !proposal || proposal.alreadyClear === true;
  $('start-job').disabled = hold || !proposal || proposal.alreadyClear === true || !$('confirm-proposal').checked;
  $('recover-start').disabled=recoveryQuery;
}
function validInputs() {
  const size = ['size-width', 'size-depth', 'size-height'].map(id => finite($(id).value));
  const reduction = finite($('reduction').value);
  return size.every(n => n !== null && n > 0) && reduction !== null && Number.isInteger(reduction) && reduction >= 1 && reduction <= 90;
}
function clearOverlay() {
  if (!view?.overlay) return;
  view.scene.remove(view.overlay);
  view.overlay.traverse(node => { node.geometry?.dispose(); if (Array.isArray(node.material)) node.material.forEach(m => m.dispose()); else node.material?.dispose(); });
  view.overlay = null;
}
function drawBounds(bounds) {
  clearOverlay(); if (!validBounds(bounds) || !view?.mesh) return;
  const helper = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...bounds[0]), new THREE.Vector3(...bounds[1])), '#c08a3e');
  view.scene.add(helper); view.overlay = helper;
}
function resetGeometry() {
  if (!view) return;
  view.version++;
  if (view.mesh) { view.scene.remove(view.mesh); view.mesh.geometry.dispose(); view.mesh.material.dispose(); view.mesh = null; }
  clearOverlay(); $('viewer-message').hidden = false; $('reset-view').disabled = true; say('mesh-status', '尚无网格');
}
function fitView() {
  if (!view?.mesh) return;
  const box = new THREE.Box3().setFromObject(view.mesh), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()), radius = Math.max(size.length() * .75, 12);
  view.controls.target.copy(center); view.camera.position.set(center.x + radius * 1.35, center.y - radius * 1.7, center.z + radius * 1.2);
  view.camera.near = Math.max(radius / 1000, .05); view.camera.far = radius * 30; view.camera.updateProjectionMatrix(); view.controls.update();
}
function loadSource() {
  resetGeometry(); if (!selected) { updateControls(); return; }
  const url = safePath(selected.stlUrl);
  if (!url) { say('mesh-status', '服务未返回安全的源 STL 地址'); return; }
  if (!webglAvailable || !view) { say('mesh-status', '当前浏览器无法预览源 STL'); return; }
  const version = ++view.version;
  say('mesh-status', '正在加载源 STL…');
  new STLLoader().load(url, geometry => {
    if (version !== view.version) { geometry.dispose(); return; }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#93aaa3', metalness: .04, roughness: .74 }));
    view.mesh = mesh; view.scene.add(mesh); $('viewer-message').hidden = true; $('reset-view').disabled = false;
    say('mesh-status', '源 STL 已加载；几何保持原始坐标'); fitView();
    if (!job && !point) say('pick-note', '源模型已就绪；点击按钮后选择需要保护的表面。');
    if (proposal?.boundsMm) drawBounds(proposal.boundsMm); updateControls();
  }, undefined, () => { if (version === view.version) { say('mesh-status', '源 STL 读取失败'); updateControls(); } });
}
function setPicking(value) {
  picking = value; if (view) view.controls.enabled = !value;
  $('mesh-canvas').classList.toggle('picking', value); $('pick-point').setAttribute('aria-pressed', String(value));
  $('pick-point').textContent = value ? '取消表面选择' : '点击模型选择重要表面';
}
function setupPicking() {
  const canvas = $('mesh-canvas');
  $('pick-point').addEventListener('click', () => {
    if (locked() || !view?.mesh) return;
    setPicking(!picking); say('pick-note', picking ? '请点击重要表面；选取期间会暂停视角旋转。' : '已取消点选。');
  });
  canvas.addEventListener('pointerdown', event => { pointer = picking && event.isPrimary ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null; });
  canvas.addEventListener('pointerup', event => {
    const start = pointer; pointer = null;
    if (!picking || !start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6 || !view?.mesh) return;
    const rect = canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), view.camera);
    const hit = ray.intersectObject(view.mesh, false)[0]; if (!hit) { say('pick-note', '没有点到源网格表面，请重试。'); return; }
    invalidate('已更换点击位置；旧基线、提案和确认已清除。'); point = hit.point.toArray(); setPicking(false);
    say('pick-note', `已选源坐标 (${point.map(n => fmt(n)).join(', ')}) mm。`); updateControls();
  });
  canvas.addEventListener('pointercancel', () => { pointer = null; });
}
function addFact(parent, label, value) {
  const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = label; dd.textContent = safe(value); row.append(dt, dd); parent.append(row);
}
function renderProposal(data) {
  const facts = $('proposal-facts'); clear(facts);
  addFact(facts, '源模型 SHA-256', data.sourceSha256);
  addFact(facts, '保护盒源坐标', validBounds(data.boundsMm) ? `(${data.boundsMm[0].map(v => fmt(v)).join(', ')}) 至 (${data.boundsMm[1].map(v => fmt(v)).join(', ')}) mm` : '—');
  addFact(facts, '保护区基线支撑', fmt(data.baseline?.protectedSupportMm, ' mm'));
  addFact(facts, '基线耗材 / 时间', `${fmt(data.baseline?.filamentG, ' g')} / ${fmt(data.baseline?.estimatedTimeSeconds, ' 秒')}`);
  addFact(facts, '支撑限制', fmt(data.supportLimitMm, ' mm'));
  addFact(facts, '目标降低比例', fmt(data.reductionPercent, '%'));
  facts.hidden = false; drawBounds(data.boundsMm);
  $('confirm-wrap').hidden = data.alreadyClear === true;
  if (data.alreadyClear === true) {
    say('proposal-summary', '该区域在基线姿态下没有计划支撑；没有可比较的支撑可供优化，因此不会启动 AGH 任务。');
  } else {
    say('proposal-summary', '基线已准备。金色框显示服务端确认的保护范围；查看数据并勾选确认后，才会开始 AGH 检查。');
  }
  $('proposal-summary').classList.remove('error'); updateControls();
}
async function loadSources({ restoreJob = null } = {}) {
  const token = ++sourceRevision; $('source-select').disabled = true; say('source-note', '正在读取已验证源模型目录…');
  try {
    const data = await request('/api/protect/sources'); if (token !== sourceRevision) return;
    sources = Array.isArray(data?.sources) ? data.sources.filter(validSource).sort((a,b)=>Number(b.source.kind==='reconstructed')-Number(a.source.kind==='reconstructed')) : [];
    const select = $('source-select'); clear(select);
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = sources.length ? '选择一个已验证模型' : '目录中没有可用模型'; select.append(empty);
    sources.forEach((item, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = safe(item.label || `${item.source.kind} · ${item.source.jobId || item.source.candidateId}`, 120); select.append(option); });
    if (restoreJob) {
      const source = sources.find(item => sourceKey(item.source) === sourceKey(restoreJob.source) && item.sourceSha256 === restoreJob.sourceSha256);
      selected = source || null;
      if (source) { select.value = String(sources.indexOf(source)); loadSource(); }
      else say('source-note', '任务已恢复，但目录中没有与任务哈希匹配的源模型。');
    } else {
      select.disabled = sources.length === 0;
      if (sources.length) select.value = '';
      const query=new URLSearchParams(location.search),sourceJobId=query.get('sourceJobId'),candidateId=query.get('sourceCandidateId');
      if (uuidPattern.test(sourceJobId || '') || /^[a-f0-9]{64}$/i.test(candidateId || '')) {
        const index = sources.findIndex(item => /^[a-f0-9]{64}$/i.test(candidateId || '') ? item.source.kind==='imported'&&item.source.candidateId===candidateId : item.source.kind === 'reconstructed' && item.source.jobId === sourceJobId);
        if (index >= 0) { select.value = String(index); chooseSource(); }
        else say('source-note', '指定模型不在已验证目录中，请检查来源任务。');
      }
    }
    $('source-select').disabled = recoveryLocked || !!job || sources.length === 0;
    say('source-note', sources.length ? `目录中有 ${sources.length} 个服务端验证过的源模型。` : '没有可用模型；请先在工作台完成模型验证。');
    updateControls();
  } catch (error) {
    if (token === sourceRevision) { $('source-select').disabled = true; say('source-note', `读取模型目录失败：${safe(error.message)}`); }
  }
}
function chooseSource() {
  if (locked()) return;
  invalidate('模型来源已更改；旧基线、提案和确认已清除。', { clearPoint: true });
  const raw = $('source-select').value, index = raw === '' ? -1 : Number(raw);
  selected = Number.isInteger(index) && index >= 0 ? sources[index] || null : null;
  if (selected) loadSource(); else resetGeometry(); updateControls();
}
async function prepare() {
  if (!selected || !point || !validInputs() || prepareBusy || locked()) return;
  const token = revision, sourceVersion = sourceRevision, src = selected;
  const sizeMm = ['size-width', 'size-depth', 'size-height'].map(id => finite($(id).value));
  const reductionPercent = finite($('reduction').value);
  prepareBusy = true; proposal = null; $('confirm-proposal').checked = false; $('confirm-wrap').hidden = true;
  clear($('proposal-facts')); $('proposal-facts').hidden = true; say('proposal-summary', '正在计算保护区的切片基线…'); updateControls();
  try {
    const data = await request('/api/protect/prepare', { method: 'POST', body: JSON.stringify({ source: src.source, pointInSourceMm: point, sizeMm, reductionPercent }) });
    if (token !== revision || sourceVersion !== sourceRevision) return;
    const matches = data && uuidPattern.test(data.proposalId || '') && /^[a-f0-9]{64}$/i.test(data.fingerprint || '') && sourceKey(data.source) === sourceKey(src.source) && data.sourceSha256 === src.sourceSha256 && validBounds(data.boundsMm) && data.baseline && typeof data.alreadyClear === 'boolean' && Number.isFinite(data.supportLimitMm) && data.reductionPercent === reductionPercent && data.boundsMm[0].every((v,i)=>Math.abs(data.boundsMm[1][i]-v-sizeMm[i])<1e-5) && Number.isFinite(data.baseline.protectedSupportMm) && Math.abs(data.supportLimitMm-data.baseline.protectedSupportMm*(1-reductionPercent/100))<Math.max(1e-6,data.supportLimitMm*1e-9);
    if (!matches) throw new Error('服务返回的基线与所选源或输入不匹配。');
    proposal = data; renderProposal(data);
    say('start-note', data.alreadyClear ? '基线区域没有计划支撑；任务已停止在准备阶段。' : '基线准备完成；尚未启动 AGH。');
  } catch (error) {
    if (token === revision && sourceVersion === sourceRevision) { say('proposal-summary', `基线准备失败：${errorMessage(error.message)}`); $('proposal-summary').classList.add('error'); }
  } finally { if (token === revision && sourceVersion === sourceRevision) { prepareBusy = false; updateControls(); } }
}
function renderJob(data) {
  job = data; $('job-stage').textContent = stageNames[data.stage] || '状态未知'; $('result-state').textContent = stageNames[data.stage] || '状态未知';
  say('job-summary', `任务 ${safe(data.id)} · ${stageNames[data.stage] || '状态未知'}`);
  const facts = $('result-facts'); clear(facts);
  addFact(facts, '源模型 SHA-256', data.sourceSha256);
  addFact(facts, '保护盒', validBounds(data.boundsMm) ? `(${data.boundsMm[0].map(v => fmt(v)).join(', ')}) 至 (${data.boundsMm[1].map(v => fmt(v)).join(', ')}) mm` : '—');
  addFact(facts, '降低目标', fmt(data.reductionPercent, '%'));
  addFact(facts, '基线保护区支撑', fmt(data.baseline?.protectedSupportMm, ' mm'));
  addFact(facts, '最佳候选支撑', fmt(data.best?.protectedSupportMm, ' mm'));
  addFact(facts, '实际降低比例', fmt(data.best?.reductionPercent, '%'));
  addFact(facts, '候选耗材 / 时间', `${fmt(data.best?.filamentG, ' g')} / ${fmt(data.best?.estimatedTimeSeconds, ' 秒')}`);
  const tradeoff=$('tradeoff-note');tradeoff.hidden=!data.best;
  if(data.best&&data.baseline?.filamentG>0&&data.baseline?.estimatedTimeSeconds>0){
    addFact(facts,'总耗材估算对比',`${fmt(data.baseline.filamentG,' g')} → ${fmt(data.best.filamentG,' g')}`);
    addFact(facts,'打印时间估算对比',`${fmt(data.baseline.estimatedTimeSeconds/60,' 分钟')} → ${fmt(data.best.estimatedTimeSeconds/60,' 分钟')}`);
    const material=100*(data.best.filamentG/data.baseline.filamentG-1),time=100*(data.best.estimatedTimeSeconds/data.baseline.estimatedTimeSeconds-1);
    const change=(n)=>`${n>0?'增加':n<0?'减少':'不变'}${n===0?'':fmt(Math.abs(n),'%')}`;
    tradeoff.textContent=`选区计划支撑减少${fmt(data.best.reductionPercent,'%')}；总耗材${change(material)}，预计耗时${change(time)}。${material>0||time>0?'这是本次方案的取舍，可按用途调整目标再检查。':''}`;
  }
  if (data.best && data.baseline?.filamentG > 0) addFact(facts, '总耗材变化', `${fmt(100*(data.best.filamentG/data.baseline.filamentG-1), '%')}（切片估算）`);
  if (data.best && data.baseline?.estimatedTimeSeconds > 0) addFact(facts, '预计耗时变化', `${fmt(100*(data.best.estimatedTimeSeconds/data.baseline.estimatedTimeSeconds-1), '%')}`);
  addFact(facts, '交付 SHA-256', data.delivery?.sha256 || '—');
  clear($('phase-list'));
  if (data.pose) {
    const row = document.createElement('article'); row.className = 'phase-row'; const title = document.createElement('strong'); title.textContent = `姿态检查 · ${stageNames[data.pose.stage] || '状态未知'}`; row.append(title);
    const events = Array.isArray(data.pose.events) ? data.pose.events : [];
    for (const event of events.slice(0, 20)) { const p = document.createElement('p'); p.textContent = `${safe(event.tool || event.stage || '检查')} · ${safe(event.message || event.code || '')}`; row.append(p); }
    $('phase-list').append(row);
  } else {
    const p = document.createElement('p'); p.className = 'empty'; p.textContent = '等待姿态检查记录。'; $('phase-list').append(p);
  }
  const error = data.bindingError || data.error;
  const poseLink = $('pose-link');
  if (poseLink) { poseLink.hidden = !uuidPattern.test(data.poseJobId || ''); if (!poseLink.hidden) poseLink.href = `/poses?job=${encodeURIComponent(data.poseJobId)}`; }
  $('job-error').hidden = !error;
  if (error) $('job-error').textContent = data.bindingError ? `交付复核未通过：${errorMessage(error)}` : errorMessage(error);
  const newCheck=$('new-check');newCheck.hidden=!terminal.has(data.stage)||!sourceKey(data.source);if(!newCheck.hidden)newCheck.href=`/protect?${data.source.kind==='imported'?'sourceCandidateId':'sourceJobId'}=${encodeURIComponent(data.source.kind==='imported'?data.source.candidateId:data.source.jobId)}`;
  const deliveryUrl = safePath(data.delivery?.url);
  const verified = data.stage === 'completed' && !!data.delivery && !!deliveryUrl && !data.bindingError;
  $('delivery-title').textContent = verified ? '任务完成，交付已验证' : '交付尚未验证';
  $('delivery-note').textContent = verified ? `交付文件 SHA-256：${safe(data.delivery.sha256 || '—')}` : '只有完成状态、同源 API 交付地址且无绑定错误时，才会开放下载。';
  $('download-link').hidden = !verified;
  if (verified) $('download-link').href = deliveryUrl;
  if (validBounds(data.boundsMm)) drawBounds(data.boundsMm);
  updateControls();
}
async function poll(id, token) {
  if (token !== revision || job?.id !== id) return;
  try {
    const data = await request(`/api/protect/jobs/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(15000)});
    if (token !== revision || data?.id !== id) return;
    renderJob(data);
    if (!terminal.has(data.stage)) pollHandle = setTimeout(() => void poll(id, token), 1300);
  } catch (error) {
    if (token !== revision) return;
    $('job-error').hidden = false; $('job-error').textContent = `读取任务状态失败：${safe(error.message)}；稍后继续查询同一任务。`;
    pollHandle = setTimeout(() => void poll(id, token), 2500);
  }
}
async function start() {
  if (!proposal || proposal.alreadyClear || !$('confirm-proposal').checked || starting || startAttempted || recoveryLocked || job) return;
  const token = revision, proposalId = proposal.proposalId, fingerprint = proposal.fingerprint;
  starting = true; startAttempted = true;
  writeProposal(proposal);
  say('start-note', '正在提交已确认的检查…'); updateControls();
  try {
    const data = await request('/api/protect/start', { method: 'POST', signal:AbortSignal.timeout(15000),body: JSON.stringify({ proposalId, fingerprint, confirmed: true }) });
    if (token !== revision) return;
    if (!data || typeof data.id !== 'string' || !uuidPattern.test(data.id)) throw new Error('启动响应缺少可查询的任务编号。');
    job = { id: data.id, stage: typeof data.stage === 'string' ? data.stage : 'unknown' }; writeJobId(data.id); starting = false; renderJob(job);
    say('start-note', '检查已启动；页面只会查询该任务，不会重复提交。'); void poll(data.id, token);
  } catch (error) {
    if (token !== revision) return;
    starting = false; recoveryLocked = true;
    say('start-note','启动响应未收到，正在查询原提案对应的任务。');
    $('recover-start').hidden=false;updateControls();void recoverProposal(proposalId,fingerprint);
  }
}
async function recoverProposal(id,fingerprint){
  if(recoveryQuery)return;const token=revision;recoveryQuery=true;recoveryLocked=true;updateControls();
  try{
    const data=await request(`/api/protect/proposals/${encodeURIComponent(id)}?fingerprint=${encodeURIComponent(fingerprint)}`,{signal:AbortSignal.timeout(15000)});
    if(token!==revision)return;
    if(data?.proposalId!==id||data.fingerprint!==fingerprint||!['prepared','starting','started','interrupted'].includes(data.state))throw new Error('提案恢复响应不匹配。');
    if(data.state==='started'||data.state==='interrupted'){
      if(!uuidPattern.test(data.jobId||''))throw new Error('恢复响应缺少任务编号。');
      $('recover-start').hidden=true;writeJobId(data.jobId);await restore(data.jobId);
    }else if(data.state==='starting'){
      say('start-note','原请求仍在处理，继续只读查询同一提案。');
      $('recover-start').hidden=false;pollHandle=setTimeout(()=>void recoverProposal(id,fingerprint),1300);
    }else{
      const p=data.proposal;
      if(p?.proposalId!==id||p.fingerprint!==fingerprint||!validBounds(p.boundsMm)||!Array.isArray(p.pointInSourceMm)||p.pointInSourceMm.length!==3||!p.pointInSourceMm.every(Number.isFinite)||!Array.isArray(p.sizeMm)||p.sizeMm.length!==3||p.sizeMm.some(n=>!Number.isFinite(n)||n<=0))throw new Error('恢复提案缺少有效几何信息。');
      await loadSources({restoreJob:p});if(token!==revision)return;
      if(!selected||selected.sourceSha256!==p.sourceSha256||sourceKey(selected.source)!==sourceKey(p.source))throw new Error('未找到与提案匹配的源模型。');
      proposal=p;point=[...p.pointInSourceMm];['size-width','size-depth','size-height'].forEach((name,i)=>$(name).value=p.sizeMm[i]);$('reduction').value=p.reductionPercent;
      say('pick-note',`已恢复源坐标 (${point.map(n=>fmt(n)).join(', ')}) mm。`);
      job=null;starting=false;startAttempted=false;recoveryLocked=false;$('confirm-proposal').checked=false;$('job-error').hidden=true;$('recover-start').hidden=true;renderProposal(p);
      say('start-note','原提案尚未启动，已恢复输入和基线；请重新查看并勾选确认。');
    }
  }catch(error){
    if(token!==revision)return;$('recover-start').hidden=false;$('job-error').hidden=false;$('job-error').textContent=errorMessage(error.message);say('start-note','暂时无法查询原任务。可点击重新查询，或刷新当前网址继续恢复。');
  }finally{if(token===revision){recoveryQuery=false;updateControls();}}
}
async function restore(id) {
  recoveryLocked = true; $('source-select').disabled = true; say('start-note', '正在只读恢复 URL 中的任务；不会提交 POST。'); updateControls();
  try {
    const data = await request(`/api/protect/jobs/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(15000)});
    if (data?.id !== id || typeof data.stage !== 'string') throw new Error('服务返回的任务编号或阶段无效。');
    job = data; startAttempted = true; renderJob(data);
    if (validBounds(data.boundsMm)) ['size-width','size-depth','size-height'].forEach((name,i)=>{$(name).value=Number((data.boundsMm[1][i]-data.boundsMm[0][i]).toFixed(6));});
    if (Number.isFinite(data.reductionPercent)) $('reduction').value=data.reductionPercent;
    if (validBounds(data.boundsMm)) proposal = { boundsMm: data.boundsMm };
    await loadSources({ restoreJob: data });
    recoveryLocked = false; updateControls();
    $('recover-start').hidden=true;
    say('start-note', '已恢复现有任务；页面只读取状态，不会再次启动。');
    if (!terminal.has(data.stage)) void poll(id, revision);
  } catch (error) {
    recoveryLocked = true; $('recover-start').hidden=false;$('job-error').hidden = false; $('job-error').textContent = `无法恢复已知任务 ${safe(id)}：${errorMessage(error.message)}。`;
    say('start-note', '恢复失败，可重新查询原任务；启动与编辑保持锁定。'); updateControls();
  }
}
function setupView() {
  const canvas = $('mesh-canvas'), stage = canvas.parentElement;
  try {
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#fafcfb');
    const camera = new THREE.PerspectiveCamera(38, 1, .05, 3000); camera.up.set(0, 0, 1);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene.add(new THREE.HemisphereLight('#fff', '#dce6e2', 2.1)); const key = new THREE.DirectionalLight('#fff', 2.5); key.position.set(-100, -80, 140); scene.add(key);
    const grid = new THREE.GridHelper(220, 22, '#d7e3df', '#e8efec'); grid.rotation.x = Math.PI / 2; grid.position.z = -.12; scene.add(grid);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = .08;
    const resize = () => { const w = Math.max(stage.clientWidth, 1), h = Math.max(stage.clientHeight, 1); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
    new ResizeObserver(resize).observe(stage); resize(); const animate = () => { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }; animate();
    view = { scene, camera, renderer, controls, mesh: null, overlay: null, version: 0 };
  } catch { webglAvailable = false; $('webgl-fallback').hidden = false; $('viewer-message').hidden = true; say('mesh-status', '浏览器未提供 WebGL；无法点选源表面'); }
}
function init() {
  setupView(); setupPicking();
  $('refresh-sources').addEventListener('click', () => { if (!locked()) void loadSources(); });
  $('source-select').addEventListener('change', chooseSource);
  for (const id of ['size-width', 'size-depth', 'size-height', 'reduction']) $(id).addEventListener('input', () => { invalidate('保护尺寸或降低比例已更改；旧基线、提案和确认已清除。'); updateControls(); });
  $('prepare-job').addEventListener('click', () => void prepare()); $('confirm-proposal').addEventListener('change', updateControls); $('start-job').addEventListener('click', () => void start()); $('reset-view').addEventListener('click', fitView);
  $('recover-start').addEventListener('click',()=>{const query=new URLSearchParams(location.search),id=query.get('proposal'),fp=query.get('fingerprint');if(id&&fp)void recoverProposal(id,fp);else if(readJobId())void restore(readJobId());});
  say('engine-status', '已连接到本地服务'); $('engine-dot').classList.add('ready');
  const id = readJobId(),query=new URLSearchParams(location.search),proposalId=query.get('proposal'),fp=query.get('fingerprint');
  if(id)void restore(id);else if(proposalId||fp){recoveryLocked=true;if(uuidPattern.test(proposalId||'')&&/^[a-f0-9]{64}$/i.test(fp||''))void recoverProposal(proposalId,fp);else{say('start-note','网址中的恢复提案无效，请检查原链接。');updateControls();}}else void loadSources();
}
init();
