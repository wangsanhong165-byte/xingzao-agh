import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const $ = id => document.getElementById(id);
const directions = [
  { id: 'front', label: '正面', note: 'Front view' },
  { id: 'left', label: '左侧', note: 'Left view' },
  { id: 'back', label: '背面', note: 'Back view' },
];
const maxBytes = 5 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminalStages = new Set(['complete', 'completed', 'submitted', 'failed', 'error', 'interrupted', 'incomplete']);
const files = new Map();
let currentJob = null, selectedCandidateId = null, mesh = null, renderedStlKey = null;
let scene, camera, renderer, controls, pollTimer = null, loadVersion = 0;
let serviceReady = false;

function text(id, value) { $(id).textContent = value == null ? '' : String(value); }
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
function valueText(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function finite(value) { if (value === null || value === undefined || String(value).trim() === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function makeViewCards() {
  $('view-grid').innerHTML = directions.map(({ id, label, note }) => `<article class="view-card" id="card-${id}">
    <div class="view-main"><div class="view-label"><strong>${label}</strong><span>${note}</span></div>
      <span class="view-file" id="name-${id}">尚未选择图片</span>
      <div class="view-actions"><label for="file-${id}">选择 PNG / JPEG</label><input id="file-${id}" type="file" accept="image/png,image/jpeg,.jpg,.jpeg,.png"><button type="button" id="clear-${id}" hidden>移除</button></div>
    </div><img class="view-preview" id="preview-${id}" alt="${label}视图预览" hidden>
  </article>`).join('');
  for (const { id } of directions) {
    $(`file-${id}`).addEventListener('change', e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) setFile(id, file); });
    $(`clear-${id}`).addEventListener('click', () => clearFile(id));
  }
}
function setFile(id, file) {
  const allowed = ['image/png', 'image/jpeg'];
  if (!allowed.includes(file.type)) return inputError(`${labelOf(id)}只支持 PNG 或 JPEG 图片。`);
  if (file.size <= 0 || file.size > maxBytes) return inputError(`${labelOf(id)}图片大小需大于 0 且不超过 5 MiB。`);
  const previous = files.get(id); if (previous?.url) URL.revokeObjectURL(previous.url);
  const entry = { file, url: URL.createObjectURL(file) };
  files.set(id, entry);
  const img = $(`preview-${id}`); img.src = entry.url; img.hidden = false;
  $(`card-${id}`).classList.add('has-file'); text(`name-${id}`, `${file.name} · ${(file.size / 1048576).toFixed(2)} MiB`);
  $(`clear-${id}`).hidden = false; $('start-note').classList.remove('error'); text('start-note', '图片已在本地预览；开始后才会提交到本地服务。'); refreshStart();
}
function labelOf(id) { return directions.find(item => item.id === id)?.label || '视图'; }
function clearFile(id) {
  const old = files.get(id); if (old?.url) URL.revokeObjectURL(old.url); files.delete(id);
  $(`preview-${id}`).removeAttribute('src'); $(`preview-${id}`).hidden = true; $(`card-${id}`).classList.remove('has-file');
  text(`name-${id}`, '尚未选择图片'); $(`clear-${id}`).hidden = true; refreshStart();
}
function inputError(message) { $('start-note').classList.add('error'); text('start-note', message); refreshStart(); }
function validEdge() { const edge = finite($('target-edge').value); return edge !== null && edge >= 1 && edge <= 180; }
function refreshStart() { $('start-job').disabled = files.size !== directions.length || !validEdge() || !serviceReady || $('start-job').dataset.busy === 'true'; }
function initViewer() {
  const stage = $('viewer-stage'); scene = new THREE.Scene(); scene.background = new THREE.Color('#fafcfb');
  camera = new THREE.PerspectiveCamera(38, 1, .05, 3000); camera.up.set(0, 0, 1);
  renderer = new THREE.WebGLRenderer({ canvas: $('mesh-canvas'), antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene.add(new THREE.HemisphereLight('#fff', '#dce6e2', 2.1));
  const key = new THREE.DirectionalLight('#fff', 2.5); key.position.set(-100, -80, 140); scene.add(key);
  const fill = new THREE.DirectionalLight('#a1d4c7', 1); fill.position.set(90, 60, 55); scene.add(fill);
  const grid = new THREE.GridHelper(220, 22, '#d7e3df', '#e8efec'); grid.rotation.x = Math.PI / 2; grid.position.z = -.12; scene.add(grid);
  controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = .08;
  const resize = () => { const w = Math.max(stage.clientWidth, 1), h = Math.max(stage.clientHeight, 1); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(stage); resize();
  const animate = () => { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }; animate();
  $('reset-view').addEventListener('click', fitCamera);
}
function fitCamera() {
  if (!mesh) return;
  const box = new THREE.Box3().setFromObject(mesh), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()), radius = Math.max(size.length() * .75, 12);
  controls.target.copy(center); camera.position.set(center.x + radius * 1.35, center.y - radius * 1.7, center.z + radius * 1.2); camera.near = Math.max(radius / 1000, .05); camera.far = radius * 30; camera.updateProjectionMatrix(); controls.update();
}
function clearMesh() {
  loadVersion++; renderedStlKey = null;
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); mesh = null; }
  $('viewer-message').hidden = false; $('reset-view').disabled = true; $('download-stl').disabled = true;
  $('mesh-dot').classList.remove('good'); text('mesh-status', '尚无网格'); text('mesh-info', 'Z-up · 单位 mm');
}
async function showStl(url, version) {
  if (typeof url !== 'string' || !url) return;
  if (renderedStlKey === url && mesh) return;
  const response = await fetch(new URL(url, location.origin), { cache: 'no-store' });
  if (!response.ok) throw new Error(`服务返回的 STL 无法读取（${response.status}）。`);
  const geometry = new STLLoader().parse(await response.arrayBuffer());
  if (!geometry.attributes.position?.count) { geometry.dispose(); throw new Error('服务返回的 STL 没有可显示的三角面。'); }
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  if (version !== loadVersion) { geometry.dispose(); return; }
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
  mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#168a78', roughness: .52, metalness: .03, side: THREE.DoubleSide }));
  renderedStlKey = url;
  mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh); $('viewer-message').hidden = true; $('reset-view').disabled = false; $('download-stl').disabled = false;
  $('mesh-dot').classList.add('good'); text('mesh-status', '已加载服务返回的 STL'); text('mesh-info', `${Math.floor(geometry.attributes.position.count / 3).toLocaleString('zh-CN')} 个三角面 · Z-up · mm`); fitCamera();
}
function renderFacts(job) {
  const execution = job.execution && typeof job.execution === 'object' ? job.execution : {};
  const events = Array.isArray(job.events) ? job.events : [];
  const hasAgh = execution.source === 'agh' || events.some(event => event && event.source === 'agh');
  const mode = $('source-mode'); mode.classList.toggle('agh', hasAgh); text('source-mode', hasAgh ? 'AGH 实际事件' : '形状基线');
  const pairs = [
    ['任务阶段', job.stage], ['AGH 执行来源', execution.source], ['模型', execution.model],
    ['AGH 运行状态', job.agentRunActive === true ? '运行中' : job.agentRunActive === false ? '未运行' : null],
  ];
  $('task-facts').innerHTML = pairs.filter(([, v]) => valueText(v) !== null).map(([k, v]) => `<div><dt>${escape(k)}</dt><dd>${escape(valueText(v))}</dd></div>`).join('') || '<div><dt>任务</dt><dd>等待服务状态字段</dd></div>';
  const err = job.error;
  $('job-error').hidden = err === null || err === undefined || err === '';
  if (!$('job-error').hidden) $('job-error').textContent = typeof err === 'string' ? err : JSON.stringify(err);
  const views = job.views && typeof job.views === 'object' ? job.views : {};
  for (const { id } of directions) {
    const view = views[id]; if (!view || typeof view.url !== 'string') continue;
    const img = $(`preview-${id}`); img.src = new URL(view.url, location.origin).href; img.hidden = false;
    $(`card-${id}`).classList.add('has-file'); if (typeof view.name === 'string') text(`name-${id}`, view.name);
  }
  text('job-id', job.id || '—');
  const active = job.agentRunActive === true && !terminalStages.has(String(job.stage).toLowerCase());
  $('job-dot').classList.toggle('active', active);
}
function fieldRows(object, fields) {
  return fields.filter(([label, getter]) => valueText(getter(object)) !== null).map(([label, getter]) => `<div class="summary-row"><span>${escape(label)}</span><strong>${escape(valueText(getter(object)))}</strong></div>`).join('');
}
function knownRows(object, fields) {
  if (!object || typeof object !== 'object') return '';
  return fields.filter(([, key]) => valueText(object[key]) !== null).map(([label, key, unit = '', format]) => {
    const value = typeof format === 'function' ? format(object[key]) : valueText(object[key]);
    return `<div class="summary-row"><span>${escape(label)}</span><strong>${escape(value)}${unit ? ` ${escape(unit)}` : ''}</strong></div>`;
  }).join('');
}
function formatDimensions(value) {
  if (!value || typeof value !== 'object') return valueText(value);
  const axes = ['x', 'y', 'z'].map(axis => finite(value[axis]));
  return axes.every(axis => axis !== null) ? axes.map(axis => Number(axis.toFixed(2))).join(' × ') : valueText(value);
}
function formatBounds(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.min) || !Array.isArray(value.max)) return valueText(value);
  const labels = ['X', 'Y', 'Z'];
  return labels.map((label, index) => {
    const min = finite(value.min[index]), max = finite(value.max[index]);
    return min === null || max === null ? null : `${label} ${Number(min.toFixed(2))}–${Number(max.toFixed(2))}`;
  }).filter(Boolean).join(' · ') || valueText(value);
}
function resultCheckStatus(status) {
  if (status === 'pass' || status === true) return ['通过', 'pass'];
  if (status === 'fail' || status === false) return ['未通过', 'fail'];
  return ['状态未知', 'unknown'];
}
function renderGeometry(geometry, metrics) {
  if (!geometry || typeof geometry !== 'object') return '<div class="summary-block">服务尚未提供几何检查。</div>';
  const [label, tone] = resultCheckStatus(geometry.passed);
  let html = `<div class="check-result ${tone}"><span>几何检查</span><strong>${label}</strong></div>`;
  html += knownRows(metrics && typeof metrics === 'object' ? metrics : geometry.metrics, [
    ['归一化尺寸', 'normalizedDimensionsMm', 'mm', formatDimensions], ['归一化边界', 'normalizedBoundsMm', 'mm', formatBounds], ['最长边', 'longestEdgeMm', 'mm'],
    ['三角面', 'triangleCount'], ['连通部件', 'partCount'], ['体积', 'volumeMm3', 'mm³'],
  ]);
  if (Array.isArray(geometry.checks)) {
    html += geometry.checks.map(check => {
      if (!check || typeof check !== 'object') return '';
      const [statusLabel, statusTone] = resultCheckStatus(check.status);
      const detail = valueText(check.detail ?? check.message);
      return `<div class="check-row ${statusTone}"><span>${escape(check.name ?? '几何检查')}</span><strong>${statusLabel}</strong>${detail ? `<small>${escape(detail)}</small>` : ''}</div>`;
    }).join('');
  }
  if (geometry.execution !== undefined) html += `<div class="summary-caption">检查来源：${escape(geometry.execution)}</div>`;
  return html;
}
function renderGeneration(generation) {
  if (!generation || typeof generation !== 'object') return '<div class="summary-caption">服务尚未提供生成参数。</div>';
  const model = generation.model && typeof generation.model === 'object' ? generation.model : {};
  const settings = generation.settings && typeof generation.settings === 'object' ? generation.settings : {};
  const transform = generation.transform && typeof generation.transform === 'object' ? generation.transform : {};
    const steps = finite(settings.steps), resolution = finite(settings.resolution);
  let html = knownRows({ ...settings, repo: model.repo, targetLongestEdgeMm: settings.targetLongestEdgeMm ?? transform.targetLongestEdgeMm }, [
    ['模型', 'repo'], ['生成步数', 'steps'], ['分辨率', 'resolution'], ['Chunks', 'chunks'], ['Seed', 'seed'], ['目标最长边', 'targetLongestEdgeMm', 'mm'],
  ]);
  if (transform.normalizationStrategy !== undefined) html += `<div class="summary-caption">坐标与归一化：${escape(transform.normalizationStrategy)}</div>`;
    if (steps !== null && resolution !== null && (steps < 25 || resolution < 256)) html += '<div class="summary-caption warning">低采样预览档：造型可能退化，不能将体积或耗材变少当作省料优化。</div>';
    html += '<div class="summary-caption">几何检查验证封闭与尺寸，不证明外观还原；当前需结合源图人工复核。</div>';
  if (generation.simplification !== undefined && generation.simplification !== null) html += `<div class="summary-caption">简化记录：${escape(valueText(generation.simplification))}</div>`;
  return html || '<div class="summary-caption">服务未返回生成参数。</div>';
}
function renderSlice(slice) {
  if (!slice || typeof slice !== 'object') return '<div class="summary-block">服务尚未提供切片结果。</div>';
  const actual = slice.mode === 'actual-slicer';
  let html = `<div class="check-result ${actual ? 'pass' : 'unknown'}"><span>切片来源</span><strong>${actual ? '实际切片' : '非实际切片基线'}</strong></div>`;
  html += knownRows(slice.metrics, [['耗材', 'filamentG', 'g'], ['预计时间', 'estimatedTimeSeconds', '秒']]);
  html += knownRows(slice, [['层数', 'layerCount'], ['Bridge 角色声明', 'bridgeRoleCount'], ['Overhang 角色声明', 'overhangRoleCount']]);
  if (slice.bridgeRoleCount !== undefined || slice.overhangRoleCount !== undefined) html += '<div class="summary-caption">Bridge / Overhang 数值统计自 G-code TYPE 注释中的角色声明次数，不代表线段数量或风险比例。</div>';
  if (slice.roleSource !== undefined) html += `<div class="summary-caption">角色数据来源：${escape(slice.roleSource)}</div>`;
  if (Array.isArray(slice.warnings) && slice.warnings.length) html += `<div class="summary-caption warning">${slice.warnings.map(item => escape(typeof item === 'string' ? item : valueText(item))).join('<br>')}</div>`;
  return html;
}
function renderCandidates(job) {
  const candidates = Array.isArray(job.candidates) ? job.candidates : [];
  text('candidate-count', `${candidates.length} 个候选`);
  if (!candidates.length) { $('candidate-summary').className = 'summary-empty'; $('candidate-summary').textContent = '服务尚未返回候选检查结果。'; text('candidate-title', '候选模型'); clearMesh(); return; }
  const submitted = job.submittedCandidateId;
  let candidate = candidates.find(item => item && item.candidateId === selectedCandidateId) || candidates.find(item => item && item.candidateId === submitted) || candidates[0];
  if (!candidate || typeof candidate !== 'object') return;
  selectedCandidateId = candidate.candidateId || null;
  const candidateTabs = candidates.filter(item => item && typeof item.candidateId === 'string').map(item => `<button type="button" class="candidate-choice ${item.candidateId === selectedCandidateId ? 'selected' : ''}" data-candidate-id="${escape(item.candidateId)}">${escape(item.candidateId === submitted ? '已提交' : item.candidateId.slice(0, 12))}</button>`).join('');
  text('candidate-title', candidate.candidateId ? `候选 ${candidate.candidateId}` : '候选模型');
  const checks = candidate.geometryChecks;
  const slice = candidate.slice;
  let html = `${candidateTabs ? `<div class="candidate-choices">${candidateTabs}</div>` : ''}<div class="summary-content">`;
  html += fieldRows(candidate, [['候选 ID', x => x.candidateId], ['已提交候选', x => x.candidateId && x.candidateId === submitted ? '是' : null]]);
  html += `<div class="summary-block"><strong>生成参数</strong>${renderGeneration(candidate.generation)}</div>`;
  html += `<div class="summary-block"><strong>几何检查</strong>${renderGeometry(checks, candidate.metrics)}</div>`;
  html += `<div class="summary-block"><strong>虚拟切片</strong>${renderSlice(slice)}</div>`;
  html += '</div>'; $('candidate-summary').className = ''; $('candidate-summary').innerHTML = html;
  const sourceSlice = slice && typeof slice === 'object' && slice.mode === 'actual-slicer';
  if (sourceSlice) text('source-mode', $('source-mode').textContent + ' · 实际切片');
  const url = candidate.stlUrl;
  if (typeof url !== 'string' || !url) clearMesh();
  const version = ++loadVersion;
  if (typeof url === 'string' && url) showStl(url, version).catch(error => { if (version === loadVersion) { $('download-stl').disabled = true; text('mesh-status', error.message); } });
  else { $('download-stl').disabled = true; }
}
function renderEvents(events) {
  if (!Array.isArray(events) || !events.length) { $('event-list').innerHTML = '<p class="event-empty">服务尚未返回执行事件。</p>'; return; }
  $('event-list').innerHTML = events.map(event => {
    const when = event?.at;
    const source = event?.source;
    const [outcome, tone] = typeof event?.success === 'boolean' ? (event.success ? ['成功', 'pass'] : ['失败', 'fail']) : ['结果未知', 'unknown'];
    const message = event?.message ?? event?.msg ?? event?.result;
    const parts = [event?.tool, event?.code, message].filter(value => valueText(value) !== null).map(valueText);
    return `<div class="event-row"><span class="event-time">${escape(when ?? '—')}</span><span class="event-source ${source === 'agh' ? 'agh' : ''}">${escape(source ?? '服务事件')}</span><span class="event-message"><b class="event-outcome ${tone}">${outcome}</b>${parts.map(part => `<span>${escape(part)}</span>`).join('')}</span></div>`;
  }).join('');
}
function renderJob(job) {
  if(['left','right'].includes(job.sideView)){$('side-view').value=job.sideView;updateSideLabel();}
  currentJob = job; renderFacts(job); renderEvents(job.events); renderCandidates(job);
  const compare = $('compare-poses');
  const canCompare = job.stage === 'completed' && typeof job.submittedCandidateId === 'string';
  compare.hidden = !canCompare;
  compare.href = canCompare ? `/workflow?sourceJobId=${encodeURIComponent(job.id)}` : '/workflow';
  $('protect-region').hidden = !canCompare;
  $('protect-region').href = canCompare ? `/protect?sourceJobId=${encodeURIComponent(job.id)}` : '/protect';
  $('preview-color').hidden = !canCompare;
  $('preview-color').href = canCompare ? `/texture?source=${encodeURIComponent(job.id)}` : '/texture';
  text('job-stage', valueText(job.stage) ?? '状态未知');
  const active = job.agentRunActive === true && !terminalStages.has(String(job.stage).toLowerCase());
  if (active) schedulePoll(1800); else stopPolling();
}
function schedulePoll(ms = 1800) { clearTimeout(pollTimer); pollTimer = setTimeout(() => { if (currentJob?.id) fetchJob(currentJob.id, true); }, ms); }
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
async function fetchJob(id, quiet = false) {
  try {
    const response = await fetch(`/api/reconstruction/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || `任务读取失败（${response.status}）。`);
    if (!body || body.id !== id || typeof body.stage !== 'string') throw new Error('任务响应缺少有效的 id 或 stage 字段。');
    renderJob(body);
  } catch (error) {
    if (!quiet) { $('job-error').hidden = false; $('job-error').textContent = error.message || '无法读取任务状态。'; }
    stopPolling();
  }
}
async function checkStatus() {
  try {
    const response = await fetch('/api/reconstruction/status', { cache: 'no-store' });
    const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `状态读取失败（${response.status}）。`);
    const agh = body.agh && typeof body.agh === 'object' ? body.agh : {}, engine = body.engine && typeof body.engine === 'object' ? body.engine : {};
    const parts = [];
    const aghReady = agh.ready === true && agh.modelConfigured === true;
    serviceReady = aghReady && engine.configured === true;
    if (aghReady) parts.push('AGH 已配置');
    else if (agh.ready === false || agh.modelConfigured === false) parts.push('AGH 未就绪');
    else parts.push('AGH 状态未知');
    if (agh.model !== undefined && agh.model !== null) parts.push(`模型 ${valueText(agh.model)}`);
    if (engine.configured === true) parts.push('本地引擎已配置'); else if (engine.configured === false) parts.push('本地引擎未配置'); else parts.push('本地引擎状态未知');
    if (engine.message) parts.push(valueText(engine.message));
    text('engine-status', parts.length ? parts.join(' · ') : '服务未提供配置状态字段');
    $('engine-dot').classList.toggle('ready', serviceReady);
    text('start-note', serviceReady ? 'AGH 与本地引擎已配置；实际执行状态以任务事件为准。' : '需要 AGH 模型与本地引擎均明确已配置，才可开始任务。');
  } catch (error) { serviceReady = false; text('engine-status', error.message || '状态暂不可用'); text('start-note', '执行环境状态未知，暂不能开始任务。'); }
  refreshStart();
}
function fileBase64(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(new Error('图片读取失败。')); reader.readAsDataURL(file); });
}
async function payloadViews() {
  const views = {};
  for (const { id } of directions) {
    const file = files.get(id)?.file;
    if (!file) throw new Error(`请先选择${labelOf(id)}图片。`);
    views[id] = { name: file.name, mime: file.type, dataBase64: await fileBase64(file) };
  }
  return views;
}
async function startJob() {
  const edge = finite($('target-edge').value);
  if (edge === null || edge < 1 || edge > 180) { inputError('目标最长边必须在 1–180 mm 范围内。'); $('target-edge').focus(); return; }
  const button = $('start-job'); button.dataset.busy = 'true'; refreshStart(); text('start-note', '正在提交三张视图…'); $('start-note').classList.remove('error'); stopPolling();
  try {
    const body = { views: await payloadViews(), targetLongestEdgeMm: edge,sideView:$('side-view').value };
    const response = await fetch('/api/reconstruction/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || result.message || `任务提交失败（${response.status}）。`);
    if (!result || typeof result.id !== 'string' || !uuidPattern.test(result.id) || typeof result.stage !== 'string') throw new Error('提交响应缺少有效的任务 id 或 stage；不会把它显示为已启动。');
    history.replaceState(null, '', `${location.pathname}?job=${encodeURIComponent(result.id)}`);
    currentJob = { id: result.id, stage: result.stage, agentRunActive: true, events: [], candidates: [] };
    text('start-note', '任务已创建，正在读取服务实际进度。'); renderJob(currentJob); await fetchJob(result.id);
  } catch (error) { inputError(error.message || '任务提交失败。'); }
  finally { button.dataset.busy = 'false'; refreshStart(); }
}
function bind() {
  $('target-edge').addEventListener('input', refreshStart); $('start-job').addEventListener('click', startJob);
  $('candidate-summary').addEventListener('click', event => {
    const button = event.target.closest('[data-candidate-id]'); if (!button || !currentJob) return;
    selectedCandidateId = button.dataset.candidateId; renderCandidates(currentJob);
  });
  $('download-stl').addEventListener('click', async () => {
    const candidate = currentJob?.candidates?.find(item => item?.candidateId === selectedCandidateId);
    if (typeof candidate?.stlUrl !== 'string') return;
    try { const r = await fetch(new URL(candidate.stlUrl, location.origin), { cache: 'no-store' }); if (!r.ok) throw new Error(`STL 下载失败（${r.status}）。`); const blob = await r.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `reconstruction-${candidate.candidateId || 'candidate'}.stl`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500); }
    catch (error) { $('job-error').hidden = false; $('job-error').textContent = error.message || 'STL 下载失败。'; }
  });
}

makeViewCards(); initViewer(); bind(); refreshStart(); checkStatus();
function updateSideLabel(){const right=$('side-view').value==='right';directions[1].label=right?'右侧':'左侧';const title=document.querySelector('#card-left .view-label strong');if(title)title.textContent=directions[1].label;}
$('side-view').addEventListener('change',updateSideLabel);
const restoreId = new URLSearchParams(location.search).get('job');
if (restoreId) { if (uuidPattern.test(restoreId)) fetchJob(restoreId); else { text('job-stage', '无效任务编号'); $('job-error').hidden = false; text('job-error', 'URL 中的 job 参数不是有效 UUID。'); } }
