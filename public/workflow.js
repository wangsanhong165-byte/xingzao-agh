import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const $ = id => document.getElementById(id);
const axes = ['x', 'y', 'z'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminal = new Set(['completed', 'stopped', 'failed', 'interrupted']);
const labels = { prepared: '已准备', 'agent-running': 'AGH 执行中', running: '执行中', 'pose-running': '姿态检查中', 'repair-running': '局部修正中', completed: '已完成', stopped: '已停止', failed: '执行失败', interrupted: '已中断' };
let sources = [], selected = null, proposal = null, job = null, picking = false, fitBusy = false, starting = false;
let revision = 0, sourceRevision = 0, view = null, pollHandle = null, recoveryHandle = null, selectedUrl = null, pointer = null, webglAvailable = true, startAttempted = false, recoveryLocked = false, recoveryId = null, downloadBusy = false;

function say(id, value) { $(id).textContent = value == null ? '' : String(value); }
function safe(value, max = 300) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]').replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]').replace(/[A-Za-z]:\\[^\s"']+/g, '[本地路径]').slice(0, max);
}
function finite(input) { if (!input || String(input).trim() === '') return null; const n = Number(input); return Number.isFinite(n) ? n : null; }
function fmt(n, unit = '') { return Number.isFinite(Number(n)) ? `${Number(Number(n).toFixed(3)).toLocaleString('zh-CN')}${unit}` : '—'; }
function clear(node) { node.replaceChildren(); }
async function request(path, options) {
  const response = await fetch(path, { ...options, headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...(options?.headers || {}) } });
  let data = null; try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(safe(data?.error?.message || data?.error || data?.message || `服务返回 HTTP ${response.status}`));
  return data;
}
function safePath(value) {
  if (typeof value !== 'string' || !value) return null;
  try { const url = new URL(value, location.origin); return url.origin === location.origin && url.pathname.startsWith('/api/') ? `${url.pathname}${url.search}` : null; } catch { return null; }
}
function validBounds(bounds) { return Array.isArray(bounds) && bounds.length === 2 && bounds.every(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)); }
function sameBounds(a, b) { return validBounds(a) && validBounds(b) && a.every((point, i) => point.every((value, j) => value === b[i][j])); }
function validLine(line) { return Array.isArray(line) && line.length === 2 && line.every(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)); }
function validSource(s) {
  return s && ['imported', 'reconstructed'].includes(s.source?.kind) && sourceKey(s.source) && typeof s.sourceSha256 === 'string' && /^[a-f0-9]{64}$/i.test(s.sourceSha256) && validBounds(s.boundsMm) && safePath(s.stlUrl);
}
function getBudgets() {
  const axis = $('axis').value, radial = finite($('max-growth').value), volume = finite($('max-volume').value);
  if (!axes.includes(axis) || radial === null || radial <= 0 || radial > 1 || volume === null || volume <= 0 || volume > 10000) return null;
  return { axis, maxRadialGrowthMm: radial, maxAddedVolumeMm3: volume };
}
function sourceKey(source) {
  if (!source || !['imported', 'reconstructed'].includes(source.kind)) return '';
  const id = source.kind === 'imported' ? source.candidateId : source.jobId;
  return typeof id === 'string' && id ? `${source.kind}:${id}` : '';
}
function sourceRecord(jobData, stlUrl) {
  const source = jobData?.source;
  if (!source || !sourceKey(source) || typeof source.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sourceSha256) || !validBounds(source.boundsMm)) return null;
  return { label: `${source.kind === 'imported' ? '导入模型' : '重建模型'} · 已恢复任务`, source: { kind: source.kind, ...(source.kind === 'imported' ? { candidateId: source.candidateId } : { jobId: source.jobId }) }, sourceSha256: source.sourceSha256, boundsMm: source.boundsMm, stlUrl };
}
function workflowIdFromUrl() {
  const id = new URLSearchParams(location.search).get('job');
  return id && uuidPattern.test(id) ? id : null;
}
function writeWorkflowUrl(id) {
  const url = new URL(location.href);
  if (id) { url.searchParams.set('job', id); url.searchParams.delete('sourceJobId'); }
  else url.searchParams.delete('job');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
function activeJob(data = job) { return !!data && data.stage !== 'prepared' && !terminal.has(data.stage); }
function currentProposal() {
  const b = getBudgets();
  return !!proposal && !!selected && !!b && sourceKey(proposal.source) === sourceKey(selected.source) && proposal.source?.sourceSha256 === selected.sourceSha256 && sameBounds(proposal.source?.boundsMm, selected.boundsMm) && proposal.spec?.axis === b.axis && proposal.spec?.maxRadialGrowthMm === b.maxRadialGrowthMm && proposal.spec?.maxAddedVolumeMm3 === b.maxAddedVolumeMm3 && typeof proposal.contractHash === 'string' && proposal.contractHash.length > 0;
}
function updateControls() {
  const locked = recoveryLocked || starting || activeJob();
  $('source-select').disabled = locked || sources.length === 0;
  $('refresh-sources').disabled = locked;
  for (const id of ['axis', 'max-growth', 'max-volume']) $(id).disabled = locked;
  const ready = !!selected && !!getBudgets() && webglAvailable && !!view?.mesh && selectedUrl === safePath(selected.stlUrl);
  $('pick-target').disabled = !ready || fitBusy || locked;
  $('confirm-proposal').disabled = locked || activeJob();
  $('start-job').disabled = !currentProposal() || !$('confirm-proposal').checked || starting || recoveryLocked || startAttempted || activeJob() || (!!job && job.stage !== 'prepared');
}
function clearOverlay() {
  if (!view?.overlay) return;
  view.scene.remove(view.overlay);
  view.overlay.traverse(o => { o.geometry?.dispose(); if (Array.isArray(o.material)) o.material.forEach(m => m.dispose()); else o.material?.dispose(); });
  view.overlay = null;
}
function clearProposal(message = '参数或来源已更改，旧提案已清除。请重新测量。') {
  revision++; proposal = null; fitBusy = false; startAttempted = false; $('confirm-proposal').checked = false; $('confirm-wrap').hidden = true; $('proposal-facts').hidden = true; clear($('proposal-facts')); clearOverlay(); setPicking(false);
  say('proposal-summary', message); $('proposal-summary').classList.remove('error'); if (job && !activeJob(job)) { job = null; writeWorkflowUrl(null); stopPolling(); renderJob(null); }
  starting = false; updateControls();
}
function resetGeometry() {
  if (!view) return;
  view.version++;
  if (view.mesh) { view.scene.remove(view.mesh); view.mesh.geometry.dispose(); view.mesh.material.dispose(); view.mesh = null; }
  clearOverlay(); selectedUrl = null; $('viewer-message').hidden = false; $('reset-view').disabled = true; say('mesh-status', '尚无网格'); updateControls();
}
function fitView() {
  if (!view?.mesh) return;
  const box = new THREE.Box3().setFromObject(view.mesh), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()), radius = Math.max(size.length() * .75, 12);
  view.controls.target.copy(center); view.camera.position.set(center.x + radius * 1.35, center.y - radius * 1.7, center.z + radius * 1.2); view.camera.near = Math.max(radius / 1000, .05); view.camera.far = radius * 30; view.camera.updateProjectionMatrix(); view.controls.update();
}
function loadSource() {
  resetGeometry(); if (!selected) { updateControls(); return; }
  if (!webglAvailable || !view) { say('mesh-status', '无法预览源 STL；当前环境不支持 WebGL'); updateControls(); return; }
  const url = safePath(selected.stlUrl); if (!url) { say('mesh-status', '服务未返回安全的源 STL 地址'); return; }
  const version = ++view.version;
  new STLLoader().load(url, geometry => {
    if (version !== view.version) { geometry.dispose(); return; }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#93aaa3', metalness: .04, roughness: .74 }));
    view.mesh = mesh; view.scene.add(mesh); selectedUrl = url; $('viewer-message').hidden = true; $('reset-view').disabled = false; say('mesh-status', '源 STL 已加载；几何保持原始坐标'); fitView(); drawProposal(); updateControls();
  }, undefined, () => { if (version === view.version) { say('mesh-status', '源 STL 读取失败'); selectedUrl = null; updateControls(); } });
}
function setPicking(on) {
  picking = on; if (view) view.controls.enabled = !on; $('mesh-canvas').classList.toggle('picking', on); $('pick-target').setAttribute('aria-pressed', String(on)); $('pick-target').textContent = on ? '取消选取' : '点击模型选取细杆';
}
function drawProposal() {
  clearOverlay(); if (!proposal || !view?.mesh) return;
  const spec = proposal.spec, group = new THREE.Group();
  const bounds = proposal.target?.boundsMm;
  if (Array.isArray(bounds) && bounds.length === 2) group.add(new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...bounds[0]), new THREE.Vector3(...bounds[1])), '#728983'));
  const allowed = spec.allowedBoundsMm;
  if (Array.isArray(allowed) && allowed.length === 2) group.add(new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...allowed[0]), new THREE.Vector3(...allowed[1])), '#c08a3e'));
  if (Array.isArray(spec.centerLineMm) && spec.centerLineMm.length === 2) { const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(spec.centerLineMm.map(p => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color: '#bd6042', depthTest: false })); line.renderOrder = 5; group.add(line); }
  view.scene.add(group); view.overlay = group;
}
function addFact(parent, name, value) {
  const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = safe(value); parent.append(row); row.append(dt, dd);
}
function renderProposal() {
  const f = $('proposal-facts'); clear(f); const target = proposal.target, spec = proposal.spec;
  const range = b => Array.isArray(b) && b.length === 2 ? `min (${b[0].map(x => fmt(x)).join(', ')}) · max (${b[1].map(x => fmt(x)).join(', ')}) mm` : '服务未返回';
  addFact(f, '原特征边界', range(target?.boundsMm)); addFact(f, '允许增长边界', range(spec?.allowedBoundsMm));
  addFact(f, '完整轴线', Array.isArray(spec?.centerLineMm) ? spec.centerLineMm.map(p => `(${p.map(x => fmt(x)).join(', ')})`).join(' → ') + ' mm' : '服务未返回');
  addFact(f, '实测半径', fmt(target?.measuredRadiusMm, ' mm')); addFact(f, '本次预算', `${fmt(spec?.maxRadialGrowthMm, ' mm')} 径向 · ${fmt(spec?.maxAddedVolumeMm3, ' mm³')}`);
  addFact(f, '姿态搜索策略', posePolicyLabel(proposal));
  f.hidden = false; $('confirm-wrap').hidden = false;
  say('proposal-summary', `已取得只读测量提案（${String(spec.axis).toUpperCase()} 轴）。灰框为原特征，金框为独立的允许增长范围，红线为完整轴线。`);
  $('proposal-summary').classList.remove('error'); drawProposal(); updateControls();
}
function fitReason(code) {
  return ({ ROD_TARGET_NOT_CIRCULAR: '截面不符合直圆杆条件，请检查轴向后重选。', ROD_TARGET_NOT_STRAIGHT_CIRCULAR: '完整杆段不够直或截面不稳定，服务拒绝生成建议。', ROD_TARGET_CLICK_OFF_SURFACE: '点击位置未匹配源网格表面，请重选。', ROD_TARGET_CAP_OR_BOUNDARY: '点击靠近端面或边界；请点杆身中段。', ROD_INSPECTION_FAILED: '杆段或允许增长空间未通过服务端检查。' })[code] || safe(code || '测量请求失败；服务没有提供可用提案。');
}
async function fitPoint(point) {
  const budget = getBudgets(); if (!selected || !budget) return;
  clearProposal('正在向服务端请求只读几何测量…'); const version = revision, srcRev = sourceRevision, source = selected.source;
  fitBusy = true; setPicking(false); say('pick-note', '正在测量源网格；不会修改模型或启动任务。'); updateControls();
  try {
    const result = await request('/api/workflow/prepare', { method: 'POST', body: JSON.stringify({ source, pointInSourceMm: point, axis: budget.axis, maxRadialGrowthMm: budget.maxRadialGrowthMm, maxAddedVolumeMm3: budget.maxAddedVolumeMm3 }) });
    if (version !== revision || srcRev !== sourceRevision) return;
    if (!result || result.stage !== 'prepared' || typeof result.id !== 'string' || !result.id || typeof result.contractHash !== 'string' || !result.contractHash || sourceKey(result.source) !== sourceKey(source) || result.source?.sourceSha256 !== selected.sourceSha256 || !sameBounds(result.source?.boundsMm, selected.boundsMm) || result.spec?.axis !== budget.axis || result.spec?.maxRadialGrowthMm !== budget.maxRadialGrowthMm || result.spec?.maxAddedVolumeMm3 !== budget.maxAddedVolumeMm3 || result.target?.axis !== budget.axis || typeof result.target?.id !== 'string' || !result.target.id || !Number.isFinite(result.target?.measuredRadiusMm) || !validBounds(result.target?.boundsMm) || !validLine(result.target?.centerLineMm) || !validBounds(result.spec?.allowedBoundsMm) || !validLine(result.spec?.centerLineMm) || result.target.centerLineMm.some((point, i) => point.some((value, j) => value !== result.spec.centerLineMm[i][j]))) throw new Error('工作流提案缺少已验证的来源、完整范围或合同指纹。');
    proposal = result; renderProposal(); say('pick-note', '测量完成。请查看两种边界和轴线，再勾选确认。');
  } catch (error) { if (version === revision && srcRev === sourceRevision) { proposal = null; say('proposal-summary', fitReason(error.message)); $('proposal-summary').classList.add('error'); say('pick-note', '没有可靠提案，启动按钮保持关闭。'); updateControls(); } }
  finally { if (version === revision && srcRev === sourceRevision) { fitBusy = false; updateControls(); } }
}
function setupPicking() {
  const canvas = $('mesh-canvas');
  $('pick-target').addEventListener('click', () => { setPicking(!picking); say('pick-note', picking ? '请点击圆杆中段；选取期间会暂停视角旋转。' : '已取消模型选取。'); });
  canvas.addEventListener('pointerdown', e => { pointer = picking && e.isPrimary ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null; });
  canvas.addEventListener('pointerup', e => {
    const start = pointer; pointer = null; if (!picking || !start || start.id !== e.pointerId || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6 || !view?.mesh) return;
    const rect = canvas.getBoundingClientRect(), ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), view.camera);
    const hit = ray.intersectObject(view.mesh, false)[0]; if (!hit) { say('pick-note', '没有点到网格表面，请重选。'); return; }
    void fitPoint(hit.point.toArray());
  });
  canvas.addEventListener('pointercancel', () => { pointer = null; });
}
function parseSourceFromUrl() {
  const query=new URLSearchParams(location.search),candidateId=query.get('sourceCandidateId');
  if(/^[a-f0-9]{64}$/i.test(candidateId||''))return {kind:'imported',candidateId};
  const id = query.get('sourceJobId');
  return id && /^[0-9a-f-]{36}$/i.test(id) ? { kind: 'reconstructed', jobId: id } : null;
}
async function loadSources({ jobData = null } = {}) {
  if (!jobData && (starting || recoveryLocked || activeJob())) return;
  const version = ++sourceRevision, keepJob = jobData || job, previous = selected, wantedSource = jobData?.source || previous;
  $('source-select').disabled = true; say('source-note', '正在读取已验证模型目录…');
  try {
    const data = await request('/api/workflow/sources'); if (version !== sourceRevision) return;
    sources = Array.isArray(data?.sources) ? data.sources.filter(validSource) : [];
    let match = wantedSource ? sources.findIndex(s => sourceKey(s.source) === sourceKey(wantedSource) && s.sourceSha256 === (jobData?.source?.sourceSha256 || previous?.sourceSha256)) : -1;
    if (match < 0 && jobData?.source) {
      const id = jobData.id, sha = jobData.source.sourceSha256;
      const fallback = sourceRecord(jobData, `/api/workflow/jobs/${encodeURIComponent(id)}/source?sha=${encodeURIComponent(sha)}`);
      if (fallback && safePath(fallback.stlUrl)) { match = sources.length; sources.push(fallback); }
    } else if (match < 0 && previous && safePath(previous.stlUrl)) { match = sources.length; sources.push(previous); }
    const select = $('source-select'); clear(select); const empty = document.createElement('option'); empty.value = ''; empty.textContent = sources.length ? '选择一个已验证模型' : '目录中没有可用模型'; select.append(empty);
    sources.forEach((source, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = safe(source.label || `${source.source.kind} · ${source.source.jobId || source.source.candidateId || ''}`, 120); select.append(option); });
    select.disabled = sources.length === 0;
    const urlSource = parseSourceFromUrl(), urlMatch = urlSource ? sources.findIndex(s => sourceKey(s.source) === sourceKey(urlSource)) : -1;
    if (match >= 0) select.value = String(match); else if (urlMatch >= 0) select.value = String(urlMatch);
    selected = select.value ? sources[Number(select.value)] || null : null;
    if (selected) { say('mesh-status', '正在加载源 STL…'); $('viewer-message').hidden = false; loadSource(); } else if (!keepJob) resetGeometry();
    if (jobData) {
      job = jobData; proposal = jobData;
      const spec = jobData.spec;
      if (spec) { $('axis').value = spec.axis || ''; $('max-growth').value = spec.maxRadialGrowthMm ?? ''; $('max-volume').value = spec.maxAddedVolumeMm3 ?? ''; }
      $('confirm-proposal').checked = false;
      if (proposal?.target && proposal?.spec) { renderProposal(); say('start-note', jobData.stage === 'prepared' ? '恢复到准备状态；请重新查看并勾选确认，页面不会自动启动。' : '已恢复现有任务；页面不会自动启动。'); }
      renderJob(jobData);
    } else if (keepJob) { job = keepJob; renderJob(keepJob); }
    updateControls();
    say('source-note', sources.length ? `目录中有 ${sources.length} 个服务端已检查的模型。` : '没有可用模型；请先到照片重建或工作台完成模型检查。');
  } catch (error) { if (version === sourceRevision) {
    say('source-note', `模型目录读取失败：${safe(error.message)}`); $('source-select').disabled = true;
    if (jobData) {
      const fallback = sourceRecord(jobData, `/api/workflow/jobs/${encodeURIComponent(jobData.id)}/source?sha=${encodeURIComponent(jobData.source?.sourceSha256 || '')}`);
      if (fallback && safePath(fallback.stlUrl)) { sources = [fallback]; const select = $('source-select'), option = document.createElement('option'); option.value = '0'; option.textContent = safe(fallback.label); select.replaceChildren(option); select.value = '0'; select.disabled = false; selected = fallback; loadSource(); job = jobData; proposal = jobData; if (jobData.spec) { $('axis').value = jobData.spec.axis || ''; $('max-growth').value = jobData.spec.maxRadialGrowthMm ?? ''; $('max-volume').value = jobData.spec.maxAddedVolumeMm3 ?? ''; } $('confirm-proposal').checked = false; if (proposal.target && proposal.spec) renderProposal(); renderJob(jobData); updateControls(); }
    }
    if (jobData) { job = jobData; proposal = jobData; setRestoredBudget(jobData); $('confirm-proposal').checked = false; if (proposal.target && proposal.spec) renderProposal(); renderJob(jobData); updateControls(); }
  } }
}
function chooseSource() {
  clearProposal('模型来源已更改。旧提案与确认已清除。');
  const raw = $('source-select').value, index = raw === '' ? -1 : Number(raw); selected = Number.isInteger(index) && index >= 0 ? sources[index] || null : null;
  if (selected) { say('mesh-status', '正在加载源 STL…'); $('viewer-message').hidden = false; loadSource(); }
  else resetGeometry(); updateControls();
}
function stopPolling() { if (pollHandle) clearTimeout(pollHandle); pollHandle = null; }
function setRestoredBudget(data) {
  if (!data?.spec) return;
  $('axis').value = data.spec.axis || '';
  $('max-growth').value = data.spec.maxRadialGrowthMm ?? '';
  $('max-volume').value = data.spec.maxAddedVolumeMm3 ?? '';
}
async function recoverKnownJob(id, { afterPost = false } = {}) {
  recoveryLocked = true; recoveryId = id; starting = false; writeWorkflowUrl(id); updateControls();
  if (recoveryHandle) clearTimeout(recoveryHandle); recoveryHandle = null;
  try {
    const data = await request(`/api/workflow/jobs/${encodeURIComponent(id)}`);
    if (!data || data.id !== id || !data.stage) throw new Error('服务返回的任务编号或阶段与地址不匹配。');
    job = data; proposal = data;
    setRestoredBudget(data); $('confirm-proposal').checked = false; startAttempted = activeJob(data);
    await loadSources({ jobData: data });
    recoveryLocked = false; recoveryId = null;
    if (data.stage === 'prepared') {
      startAttempted = false;
      say('start-note', afterPost ? '查询确认该提案仍处于准备状态。请检查任务与预算后重新勾选；再次启动仍使用同一任务 ID。' : '已恢复准备状态；请重新查看并勾选确认，页面不会自动启动。');
    } else {
      say('start-note', '已恢复现有任务；页面只读取和轮询，不会再次启动。');
      if (activeJob(data)) void poll(id, revision);
    }
    updateControls();
  } catch (error) {
    recoveryLocked = true; recoveryId = id; starting = false; writeWorkflowUrl(id);
    $('job-error').hidden = false; $('job-error').textContent = `无法确认已知任务 ${id}：${safe(error.message)}。页面会继续查询同一 ID，不会创建或启动其他任务。`;
    say('start-note', '任务状态暂时无法确认；所有可能重复启动的控件已锁定。'); updateControls();
    recoveryHandle = setTimeout(() => void recoverKnownJob(id, { afterPost }), 2500);
  }
}
function appendPhase(parent, title, details) {
  const row = document.createElement('article'); row.className = 'phase-row'; const head = document.createElement('strong'); head.textContent = title; row.append(head);
  details.filter(Boolean).forEach(line => { const p = document.createElement('p'); p.textContent = safe(line); row.append(p); }); parent.append(row);
}
function costLabel(m) { return m ? `切片估算 ${fmt(m.filamentG, ' g')} · ${fmt(m.estimatedTimeSeconds, ' 秒')}` : '等待切片结果'; }
function toolLabel(e) { return `${e.tool || '检查'}：${e.code === 'RUNNING' ? '执行中' : e.success === true ? '已执行' : '调用未成功'}${e.code && e.code !== 'OK' && e.code !== 'RUNNING' ? ` · ${e.code}` : ''}`; }
function poseCount(data) {
  const ids = data?.searchPolicy?.poseIds || data?.poseJob?.poseIds;
  return Array.isArray(ids) && ids.length ? ids.length : 4;
}
function posePolicyLabel(data) {
  const policy = data?.searchPolicy || data?.poseJob;
  const id = policy?.id || policy?.posePolicy;
  const count = poseCount(data);
  if (id === 'fixed-five-v2') return `固定五姿态 · ${count} 个候选（含侧放）`;
  if (id === 'legacy4' || !id) return `历史四姿态 · ${count} 个候选`;
  return `${safe(id, 80)} · ${count} 个候选`;
}
function poseLabel(r, decision) { const rejection = decision?.rejected?.find(x => x.poseId === r.poseId); const name = ({upright:'直立','tilt-x-plus':'X +30°','tilt-x-minus':'X −30°','tilt-y-plus':'Y +30°','face-up':'侧放 X −90°'})[r.poseId] || r.poseId; return `${name}：${rejection ? '未满足要求' : r.status === 'verified' ? '通过约束检查' : '尚未验证'} · ${costLabel(r.slice?.metrics)}${rejection ? ` · ${rejection.reason}` : ''}`; }
function renderJob(data) {
  const list = $('phase-list'); clear(list); clear($('result-facts')); clear($('child-links')); $('job-error').hidden = true; $('download-link').hidden = true;
  if (!data) { $('job-stage').textContent = '尚无任务'; say('result-state', '等待任务'); say('job-summary', '准备提案后，可确认并启动唯一一次任务。'); const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'AGH 阶段将在任务启动后显示。'; list.append(p); $('delivery-title').textContent = '交付尚未验证'; $('delivery-note').textContent = '只有服务确认完成且返回已验证交付时，下载才会开放。'; return; }
  $('job-stage').textContent = labels[data.stage] || safe(data.stage); say('result-state', labels[data.stage] || safe(data.stage)); say('job-summary', `任务 ${safe(data.id)} · ${safe(data.stage)}${data.active ? ' · 正在运行' : ''}`);
  addFact($('result-facts'), '合同指纹', data.contractHash || proposal?.contractHash || '—'); addFact($('result-facts'), '源模型 SHA-256', data.source?.sourceSha256 || '—');
  addFact($('result-facts'), '姿态搜索策略', posePolicyLabel(data));
  if (data.poseJob) {
    appendPhase(list, '姿态比较', [`状态：${data.poseJob.stage === 'no-feasible' ? `当前 ${poseCount(data)} 个候选均未满足要求` : data.poseJob.stage === 'completed' ? '已完成复核' : '执行中'}`, `模型记录：${data.poseJob.execution?.model || '阶段结束后归档'}`, ...(data.poseJob.results || []).map(r => poseLabel(r, data.poseJob.decision)), ...(data.poseJob.events || []).map(toolLabel)]);
  }
  if (data.repairJob) {
    appendPhase(list, '局部修正', [`状态：${data.repairJob.stage === 'completed' ? '通过独立复核' : data.repairJob.stage === 'agent-running' ? '执行中' : data.repairJob.stage}`, `模型记录：${data.repairJob.execution?.model || '阶段结束后归档'}`, ...(data.repairJob.candidates || []).map(c => `直径 ${fmt(c.radiusMm * 2, ' mm')} · ${c.feasible === true ? '通过约束' : c.feasible === false ? '未通过约束' : '尚未验证'} · ${costLabel(c.metrics)}${c.reasons?.length ? ` · ${c.reasons.join('；')}` : ''}`), ...(data.repairJob.events || []).map(toolLabel)]);
  }
  (data.events || []).forEach(e => appendPhase(list, `${e.stage || '阶段'}${e.code ? ` · ${e.code}` : ''}`, [e.at || '', e.message || '']));
  if (!list.children.length) appendPhase(list, labels[data.stage] || safe(data.stage), []);
  if (data.error || data.bindingError) { $('job-error').hidden = false; $('job-error').textContent = data.bindingError ? `交付证据复核未通过，下载已关闭：${safe(data.bindingError)}` : safe(typeof data.error === 'object' ? data.error.message || JSON.stringify(data.error) : data.error); }
  if (Array.isArray(data.limitations) && data.limitations.length) appendPhase(list, '工作流限制', data.limitations.map(item => typeof item === 'string' ? item : JSON.stringify(item)));
  if (Array.isArray(data.poseJob?.decision?.rejected) && data.poseJob.decision.rejected.length) appendPhase(list, '姿态候选拒绝原因', data.poseJob.decision.rejected.map(item => typeof item === 'string' ? item : JSON.stringify(item)));
  if (Array.isArray(data.repairJob?.decision?.rejected) && data.repairJob.decision.rejected.length) appendPhase(list, '修正候选拒绝原因', data.repairJob.decision.rejected.map(item => typeof item === 'string' ? item : JSON.stringify(item)));
  if (data.delivery?.metrics) addFact($('result-facts'), '交付指标', JSON.stringify(data.delivery.metrics));
  for (const [label, child, path] of [['姿态任务', data.poseJob, '/poses'], ['修正任务', data.repairJob, '/repair']]) if (child?.id) { const a = document.createElement('a'); a.href = `${path}?job=${encodeURIComponent(child.id)}`; a.textContent = `查看${label} ${safe(child.id, 48)} →`; $('child-links').append(a); }
  const delivery = data.delivery, url = ['original', 'repaired'].includes(delivery?.kind) ? safePath(delivery.url) : null;
  const verified = data.stage === 'completed' && delivery && url && delivery.candidateSha256 && /^[a-f0-9]{64}$/i.test(delivery.candidateSha256);
  $('delivery-title').textContent = verified ? `已验证交付可下载 · ${delivery.kind === 'original' ? '原始模型' : '修正模型'}` : '交付尚未验证';
  $('delivery-note').textContent = verified ? `候选 SHA-256：${delivery.candidateSha256}。下载前会再次校验文件内容。` : '只有完成状态、同源交付地址和带 SHA-256 的交付同时返回时，下载才会开放。';
  if (verified) { $('download-link').href = url; $('download-link').dataset.sha256 = delivery.candidateSha256.toLowerCase(); $('download-link').dataset.filename = `workflow-${String(data.id).slice(0, 8)}-${delivery.kind}.stl`; $('download-link').hidden = false; }
  updateControls();
}
async function poll(id, version) {
  if (version !== revision || job?.id !== id) return;
  writeWorkflowUrl(id);
  try {
    const data = await request(`/api/workflow/jobs/${encodeURIComponent(id)}`); if (version !== revision || job?.id !== id) return;
    job = data; renderJob(data);
    if (data.stage === 'prepared') {
      stopPolling(); starting = false; startAttempted = false; $('confirm-proposal').checked = false;
      say('start-note', '任务仍处于准备状态。请检查并重新勾选确认；不会自动重试启动。'); updateControls();
    }
    else if (!terminal.has(data.stage)) pollHandle = setTimeout(() => void poll(id, version), 1200);
    else { stopPolling(); starting = false; updateControls(); }
  } catch (error) {
    if (version !== revision || job?.id !== id) return;
    $('job-error').hidden = false; $('job-error').textContent = `读取进度失败：${safe(error.message)}；稍后继续重试。`;
    pollHandle = setTimeout(() => void poll(id, version), 2500);
  }
}
async function start() {
  if (!currentProposal() || !$('confirm-proposal').checked || starting || recoveryLocked || activeJob() || (!!job && job.stage !== 'prepared')) return;
  const version = revision, source = selected.source, budget = getBudgets(), id = proposal.id, contractHash = proposal.contractHash;
  writeWorkflowUrl(id); starting = true; startAttempted = true; say('start-note', '已提交唯一一次启动请求…'); updateControls();
  try {
    const data = await request('/api/workflow/start', { method: 'POST', body: JSON.stringify({ id, contractHash, confirmed: true, source, axis: budget.axis, maxRadialGrowthMm: budget.maxRadialGrowthMm, maxAddedVolumeMm3: budget.maxAddedVolumeMm3 }) });
    if (version !== revision) return;
    if (data?.id !== id || !data.stage) throw new Error('启动响应与已确认提案不匹配。');
    job = data; renderJob(data); say('start-note', '启动已接受；同一提案不会再次提交。');
    if (data.stage === 'prepared') await recoverKnownJob(id, { afterPost: true });
    else { starting = false; startAttempted = true; void poll(id, version); }
  } catch (error) {
    if (version === revision) {
      starting = false; recoveryLocked = true; recoveryId = id; startAttempted = true; writeWorkflowUrl(id);
      say('start-note', `启动响应未确认：${safe(error.message)}。正在查询同一任务 ID；不会另建任务或自动重试。`); updateControls();
      await recoverKnownJob(id, { afterPost: true });
    }
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
  } catch { webglAvailable = false; $('webgl-fallback').hidden = false; $('viewer-message').hidden = true; say('mesh-status', '浏览器未提供 WebGL；仍可查看已启动任务结果'); }
}
function init() {
  setupView(); setupPicking();
  $('refresh-sources').addEventListener('click', loadSources); $('source-select').addEventListener('change', chooseSource);
  for (const id of ['axis', 'max-growth', 'max-volume']) $(id).addEventListener('input', () => { clearProposal('轴向或预算已更改。旧提案、确认和旧任务状态已清除。'); updateControls(); });
  $('confirm-proposal').addEventListener('change', updateControls); $('start-job').addEventListener('click', start); $('reset-view').addEventListener('click', fitView);
  $('download-link').addEventListener('click', async event => {
    event.preventDefault(); if (downloadBusy) return;
    const link = $('download-link'), href = safePath(link.href), expected = link.dataset.sha256, filename = link.dataset.filename, taskId = job?.id, token = revision;
    if (!href || !/^[a-f0-9]{64}$/i.test(expected || '') || !globalThis.crypto?.subtle) { say('delivery-note', '无法安全验证交付文件；下载已阻止。'); return; }
    if (!taskId) return;
    downloadBusy = true; link.setAttribute('aria-disabled', 'true'); link.textContent = '正在验证文件…';
    try {
      const response = await fetch(href, { credentials: 'same-origin' }); if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer(), digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const actual = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      if (actual !== expected) throw new Error('文件 SHA-256 与交付记录不匹配');
      if (token !== revision || job?.id !== taskId) return;
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'model/stl' })), download = document.createElement('a');
      download.href = blobUrl; download.download = filename || 'verified-delivery.stl'; document.body.append(download); download.click(); download.remove(); setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
      if (token === revision && job?.id === taskId) say('delivery-note', `文件 SHA-256 已匹配：${actual}`);
    } catch (error) { if (token === revision && job?.id === taskId) say('delivery-note', `文件未通过 SHA-256 校验，下载已阻止：${safe(error.message)}`); }
    finally { downloadBusy = false; link.removeAttribute('aria-disabled'); if (token === revision && job?.id === taskId) link.textContent = '下载已验证 STL'; }
  });
  setStatus('已连接到本地服务', true);
  const existingJobId = workflowIdFromUrl();
  if (existingJobId) { recoveryLocked = true; recoveryId = existingJobId; say('start-note', '正在恢复 URL 中的任务；页面只读取，不会自动启动。'); void recoverKnownJob(existingJobId); }
  else void loadSources();
}
function setStatus(message, ready) { say('engine-status', message); $('engine-dot').classList.toggle('ready', ready); }
init();
