import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = id => document.getElementById(id);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const terminalStages = new Set(['completed', 'failed', 'interrupted', 'error', 'incomplete']);
const stageLabels = { prepared:'准备中', 'agent-running':'AGH 上色中', 'tool-running':'正在检查结果', completed:'已完成并提交', failed:'执行失败', interrupted:'已中断', incomplete:'未完成', error:'执行出错' };
let scene, camera, renderer, controls, whiteMesh = null, colorGroup = null, resizeObserver;
let parentData = null, currentJob = null, engineReady = false, referenceConfirmed = false;
let parentReadVersion = 0, jobReadVersion = 0, whiteLoadVersion = 0, colorLoadVersion = 0, viewSelectionVersion = 0, pollTimer = null, animationFrame = 0;
let whiteUrl = null, colorUrl = null, colorPendingUrl = null, activeView = 'white', bfcachePaused = false, resourcesReleased = false;

function text(id, value) { $(id).textContent = value == null ? '' : String(value); }
function onlyUuid(value) { return typeof value === 'string' && uuid.test(value); }
function isSha(value) { return typeof value === 'string' && sha256Pattern.test(value); }
function safeText(value, max = 400) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[本地路径]')
    .replace(/(?:\/home\/|\/Users\/|\/tmp\/|\/private\/|\\\\)[^\s"']+/g, '[本地路径]').slice(0, max);
}
function setNote(message, error = false) { text('start-note', message); $('start-note').classList.toggle('error', error); }
function setStatus(message, ready = false) { text('engine-status', message); $('engine-dot').classList.toggle('ready', ready); }
function stageText(stage) { return stageLabels[String(stage || '').toLowerCase()] || safeText(stage, 80) || '状态未知'; }
function finite(value) { if (value === null || value === undefined || String(value).trim() === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function pretty(value) { return value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value); }

async function request(path, options) {
  const response = await fetch(path, { ...options, cache: 'no-store', headers: { ...(options?.body ? { 'content-type':'application/json' } : {}), ...(options?.headers || {}) } });
  let body = null; try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(safeText(body?.error?.message || body?.error || body?.message || `服务返回 HTTP ${response.status}`));
  return body;
}
function localApiUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.username || url.password || url.hash) return null;
    return url;
  } catch { return null; }
}
function deliverableUrl(job, attempt) {
  if (!job || job.stage !== 'completed' || typeof job.submittedAttemptId !== 'string' || attempt?.attemptId !== job.submittedAttemptId || !isSha(attempt.glbSha256) || typeof attempt.glbUrl !== 'string') return null;
  const url = localApiUrl(attempt.glbUrl);
  const expectedPath = `/api/texture/jobs/${encodeURIComponent(job.id)}/glb/${encodeURIComponent(attempt.attemptId)}`;
  if (!url || url.pathname !== expectedPath || url.searchParams.get('sha') !== attempt.glbSha256 || [...url.searchParams.keys()].some(key => key !== 'sha')) return null;
  return url;
}
function currentDelivery(job) {
  if (!job || !Array.isArray(job.attempts)) return null;
  const attempt = job.attempts.find(item => item?.attemptId === job.submittedAttemptId);
  const url = deliverableUrl(job, attempt);
  return url ? { attempt, url } : null;
}

function initViewer() {
  const stage = $('viewer-stage');
  scene = new THREE.Scene(); scene.background = new THREE.Color('#fafcfb');
  camera = new THREE.PerspectiveCamera(38, 1, .05, 3000); camera.up.set(0, 0, 1);
  renderer = new THREE.WebGLRenderer({ canvas: $('mesh-canvas'), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene.add(new THREE.HemisphereLight('#fff', '#dce6e2', 2.1));
  const key = new THREE.DirectionalLight('#fff', 2.5); key.position.set(-100, -80, 140); scene.add(key);
  const fill = new THREE.DirectionalLight('#a1d4c7', 1); fill.position.set(90, 60, 55); scene.add(fill);
  const grid = new THREE.GridHelper(220, 22, '#d7e3df', '#e8efec'); grid.rotation.x = Math.PI / 2; grid.position.z = -.12; scene.add(grid);
  controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = .08;
  const resize = () => { const w = Math.max(stage.clientWidth, 1), h = Math.max(stage.clientHeight, 1); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  resizeObserver = new ResizeObserver(resize); resizeObserver.observe(stage); resize();
  startAnimation();
  $('reset-view').addEventListener('click', fitCamera);
  $('show-white').addEventListener('click', () => switchView('white'));
  $('show-color').addEventListener('click', showColor);
  $('download-glb').addEventListener('click', downloadColor);
  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('pageshow', handlePageShow);
}
function startAnimation() {
  if (animationFrame || !renderer || resourcesReleased) return;
  const animate = () => { animationFrame = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); };
  animate();
}
function fitCamera() {
  const object = activeView === 'color' && colorGroup ? colorGroup : whiteMesh;
  if (!object) return;
  const box = new THREE.Box3().setFromObject(object), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()), radius = Math.max(size.length() * .75, 12);
  controls.target.copy(center); camera.position.set(center.x + radius * 1.35, center.y - radius * 1.7, center.z + radius * 1.2);
  camera.near = Math.max(radius / 1000, .05); camera.far = radius * 30; camera.updateProjectionMatrix(); controls.update();
}
function disposeObject(object) {
  if (!object) return;
  object.traverse(node => {
    node.geometry?.dispose();
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
      material.dispose();
    }
  });
}
function clearColor() {
  colorLoadVersion++; colorPendingUrl = null;
  if (colorGroup) { scene.remove(colorGroup); disposeObject(colorGroup); colorGroup = null; }
  colorUrl = null;
  if (activeView === 'color') activeView = 'white';
  updateViewerControls();
}
function clearWhite() {
  whiteLoadVersion++;
  if (whiteMesh) { scene.remove(whiteMesh); disposeObject(whiteMesh); whiteMesh = null; }
  whiteUrl = null;
  updateViewerControls();
}
function updateViewerControls() {
  applyActiveView();
}
function switchView(view) {
  if (view === 'color' && !colorGroup) return;
  viewSelectionVersion++;
  activeView = view; applyActiveView();
  if (activeObject()) fitCamera();
}
function activeObject() { return activeView === 'color' ? colorGroup : whiteMesh; }
function applyActiveView() {
  if (whiteMesh) whiteMesh.visible = activeView === 'white';
  if (colorGroup) colorGroup.visible = activeView === 'color';
  const visibleObject = activeObject();
  $('viewer-message').hidden = !!visibleObject;
  $('show-white').classList.toggle('selected', activeView === 'white'); $('show-white').setAttribute('aria-pressed', String(activeView === 'white'));
  $('show-color').classList.toggle('selected', activeView === 'color'); $('show-color').setAttribute('aria-pressed', String(activeView === 'color'));
  $('mesh-dot').classList.toggle('good', !!(whiteMesh || colorGroup));
  if (visibleObject) {
    text('mesh-status', activeView === 'color' ? '已加载复核并提交的 GLB' : '已加载父任务 STL 白模');
    text('mesh-info', activeView === 'color' ? '显示变换：Y-up m → Z-up mm' : `${Math.floor(whiteMesh?.geometry?.attributes?.position?.count / 3 || 0).toLocaleString('zh-CN')} 个三角面 · Z-up · mm`);
  } else if (activeView === 'color') text('mesh-status', '正在读取已提交的彩色 GLB');
  else text('mesh-status', '等待父任务白模');
  text('preview-state', activeView === 'color' ? '上色预览' : '白模');
  text('preview-note', activeView === 'color' ? '彩色模型来自已提交尝试的 GLB；显示时转为 Z-up 与 mm 以便和白模对照。' : '白模使用父重建任务返回的原始 STL。');
  $('reset-view').disabled = !visibleObject;
  const canColor = !!currentDelivery(currentJob);
  $('show-color').disabled = !canColor;
  $('download-glb').disabled = !canColor;
}
function setWhiteGeometry(geometry, url) {
  if (!geometry.attributes.position?.count) { geometry.dispose(); throw new Error('父任务 STL 中没有可显示的三角面。'); }
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  if (whiteMesh) { scene.remove(whiteMesh); disposeObject(whiteMesh); }
  whiteMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#aebbb7', roughness: .72, metalness: .02, side: THREE.DoubleSide }));
  whiteMesh.visible = activeView === 'white'; whiteUrl = url; scene.add(whiteMesh);
  applyActiveView(); if (activeView === 'white') fitCamera();
}
async function loadWhite(urlValue) {
  const url = localApiUrl(urlValue);
  if (!url) throw new Error('父任务返回的 STL 地址不是可信的本地 API 地址。');
  const key = url.pathname + url.search;
  if (whiteUrl === key && whiteMesh) return;
  clearWhite();
  const version = whiteLoadVersion;
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`父任务 STL 读取失败（HTTP ${response.status}）。`);
    const geometry = new STLLoader().parse(await response.arrayBuffer());
    if (version !== whiteLoadVersion) { geometry.dispose(); return; }
    setWhiteGeometry(geometry, key);
  } catch (error) {
    if (version === whiteLoadVersion) { whiteUrl = null; text('mesh-status', '白模无法读取'); applyActiveView(); }
    throw error;
  }
}

function addFact(dl, label, value) {
  if (value === null || value === undefined || value === '') return;
  const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = label; dd.textContent = safeText(pretty(value)); row.append(dt, dd); dl.append(row);
}
function renderSource(sourceJobId, source, reference) {
  const facts = $('source-facts'); facts.replaceChildren();
  addFact(facts, '父重建任务', sourceJobId); addFact(facts, '已提交候选', source?.candidateId); addFact(facts, '源网格 SHA-256', source?.sha256 ?? source?.sourceSha256);
  addFact(facts, '模型尺寸（mm）', source?.dimensionsMm);
  $('reference-preview').hidden = true;
  const refUrl = localApiUrl(reference?.url);
  if (refUrl && isSha(reference?.sha256)) {
    $('reference-image').src = refUrl.href; text('reference-label', reference.label || '正面插画参考'); $('reference-preview').hidden = false;
  }
  const pill = $('source-state'); pill.textContent = source ? '父候选已绑定' : '等待父任务'; pill.className = `mode-pill${source ? ' agh' : ''}`;
}
function sourceMatchesParent(sourceJobId, source, reference) {
  return onlyUuid(sourceJobId) && typeof source?.candidateId === 'string' && source.candidateId.length > 0 &&
    isSha(source?.sha256) && !!localApiUrl(source?.stlUrl) && isSha(reference?.sha256) && !!localApiUrl(reference?.url);
}
async function loadParent(id) {
  if (!onlyUuid(id)) { setNote('父任务链接中的 UUID 无效。', true); return; }
  const version = ++parentReadVersion;
  try {
    setNote('正在读取已完成的父重建任务…');
    const parent = await request(`/api/texture/parent/${encodeURIComponent(id)}`);
    if (version !== parentReadVersion) return;
    if (parent?.sourceJobId !== id || parent?.scope !== 'flat-illustration-existing-stl' || !sourceMatchesParent(id, { candidateId: parent.candidateId, sha256: parent.sourceSha256, stlUrl: parent.sourceStlUrl }, parent.reference)) {
      throw new Error('父任务响应不符合已完成候选、平面插画与来源 SHA 合同。');
    }
    parentData = parent; currentJob = null; clearTimeout(pollTimer); clearColor();
    renderSource(id, { candidateId: parent.candidateId, sha256: parent.sourceSha256, stlUrl: parent.sourceStlUrl, dimensionsMm: parent.dimensionsMm }, parent.reference);
    $('candidate-title').textContent = `候选 ${safeText(parent.candidateId, 50)} · 原始白模`;
    $('back-link').href = `/reconstruct?job=${encodeURIComponent(id)}`;
    try { await loadWhite(parent.sourceStlUrl); setNote('父任务候选已读取。确认参考类型后可创建纹理任务。'); }
    catch (error) { setNote(`白模加载失败：${safeText(error.message)}`, true); }
    updateStartButton();
  } catch (error) {
    if (version === parentReadVersion) { setNote(`父任务读取失败：${safeText(error.message)}`, true); }
  }
}

function updateStartButton() {
  $('start-job').disabled = !parentData || !engineReady || !referenceConfirmed || !!currentJob || $('start-job').dataset.busy === 'true';
}
async function startJob() {
  if (!parentData || !engineReady || !referenceConfirmed || currentJob) return;
  $('start-job').dataset.busy = 'true'; updateStartButton(); setNote('正在创建纹理任务并绑定父候选…');
  try {
    const result = await request('/api/texture/start', { method:'POST', body:JSON.stringify({ sourceJobId:parentData.sourceJobId, referenceKind:'flat-illustration' }) });
    if (!result || !onlyUuid(result.id) || typeof result.stage !== 'string') throw new Error('服务未返回有效的纹理任务编号或阶段。');
    currentJob = { id:result.id, sourceJobId:parentData.sourceJobId, stage:result.stage };
    history.replaceState(null, '', `/texture?job=${encodeURIComponent(result.id)}`);
    await loadJob(result.id);
  } catch (error) { setNote(`无法启动上色：${safeText(error.message)}`, true); }
  finally { delete $('start-job').dataset.busy; updateStartButton(); }
}

function renderFacts(job) {
  const facts = $('job-facts'); facts.replaceChildren();
  addFact(facts, '父重建任务', job.sourceJobId); addFact(facts, '绑定候选', job.source?.candidateId); addFact(facts, '源网格 SHA-256', job.source?.sha256);
  addFact(facts, '执行模型', job.execution?.model); addFact(facts, '执行来源', job.execution?.source);
  addFact(facts, '后台运行状态', job.agentRunActive === true ? '运行中' : job.agentRunActive === false ? '未运行' : null);
  addFact(facts, '已提交尝试', job.submittedAttemptId);
  const technical = $('technical-facts'); technical.replaceChildren();
  addFact(technical, '纹理任务', job.id); addFact(technical, '参考类型', 'flat-illustration（平面插画）');
  addFact(technical, '参考 SHA-256', job.reference?.sha256); addFact(technical, '范围', '沿用现有 STL · 不修改几何');
  const tbody = $('attempt-rows'); tbody.replaceChildren();
  const attempts = Array.isArray(job.attempts) ? job.attempts : [];
  if (!attempts.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = '服务尚未返回生成尝试。'; row.append(cell); tbody.append(row); }
  for (const attempt of attempts) {
    const row = document.createElement('tr');
    const values = [attempt?.attemptId, attempt?.profile, attempt?.status, attempt?.metrics?.faces, attempt?.metrics?.textureSizePixels];
    for (const value of values) { const cell = document.createElement('td'); cell.textContent = safeText(pretty(value), 100); row.append(cell); }
    tbody.append(row);
  }
  const error = job.error?.message ?? job.error;
  $('job-error').hidden = error === null || error === undefined || error === '';
  $('job-error').textContent = $('job-error').hidden ? '' : safeText(typeof error === 'string' ? error : JSON.stringify(error));
}
function renderEvents(events) {
  const container = $('event-list'); container.replaceChildren();
  if (!Array.isArray(events) || events.length === 0) { const p = document.createElement('p'); p.className = 'event-empty'; p.textContent = '服务尚未返回执行事件。'; container.append(p); return; }
  for (const event of events) {
    const row = document.createElement('div'); row.className = 'event-row';
    const when = document.createElement('span'); when.className = 'event-time'; when.textContent = safeText(event?.at || '—', 40);
    const source = document.createElement('span'); source.className = `event-source${event?.source === 'agh' ? ' agh' : ''}`; source.textContent = safeText(event?.source || '服务', 40);
    const message = document.createElement('span'); message.className = 'event-message';
    const running = event?.code === 'RUNNING';
    const outcome = document.createElement('b'); outcome.className = `event-outcome ${running ? 'unknown' : event?.success === true ? 'pass' : event?.success === false ? 'fail' : 'unknown'}`; outcome.textContent = running ? '处理中' : event?.success === true ? '成功' : event?.success === false ? '失败' : '记录';
    const details = [event?.tool, event?.code, event?.message].filter(value => typeof value === 'string' && value).map(value => safeText(value, 220)).join(' · ');
    message.append(outcome, document.createTextNode(` ${details}`)); row.append(when, source, message); container.append(row);
  }
}
function setDelivery(job) {
  const delivery = currentDelivery(job), pill = $('delivery-state');
  pill.textContent = delivery ? '复核并提交' : job.stage === 'failed' ? '失败 · 无交付' : job.stage === 'completed' ? '未找到有效交付' : '未提交';
  pill.className = `mode-pill${delivery ? ' delivery-ready' : job.stage === 'failed' ? ' delivery-failed' : ''}`;
  updateViewerControls();
}
function renderJob(job) {
  currentJob = job;
  const delivery = currentDelivery(job);
  const nextColorUrl = delivery ? delivery.url.pathname + delivery.url.search : null;
  if ((colorGroup || colorPendingUrl) && colorUrl !== nextColorUrl && colorPendingUrl !== nextColorUrl) { clearColor(); switchView('white'); }
  renderSource(job.sourceJobId, job.source, job.reference); renderFacts(job); renderEvents(job.events); setDelivery(job);
  text('job-id', job.id || '—'); text('job-stage', stageText(job.stage));
  $('job-dot').classList.toggle('active', job.agentRunActive === true && !terminalStages.has(String(job.stage).toLowerCase()));
  $('candidate-title').textContent = job.source?.candidateId ? `候选 ${safeText(job.source.candidateId, 50)} · 原始白模` : '父任务候选网格';
  $('back-link').href = onlyUuid(job.sourceJobId) ? `/reconstruct?job=${encodeURIComponent(job.sourceJobId)}` : '/reconstruct';
}
async function loadJob(id) {
  if (!onlyUuid(id)) { setNote('纹理任务链接中的 UUID 无效。', true); return; }
  clearTimeout(pollTimer); const version = ++jobReadVersion;
  try {
    const job = await request(`/api/texture/jobs/${encodeURIComponent(id)}`);
    if (version !== jobReadVersion) return;
    if (!job || job.id !== id || !onlyUuid(job.sourceJobId) || job.sourceJobId !== new URLSearchParams(location.search).get('source') && new URLSearchParams(location.search).has('source') || job.source?.candidateId == null || !isSha(job.source?.sha256) || !localApiUrl(job.source?.stlUrl)) {
      throw new Error('纹理任务响应缺少有效 ID、父任务绑定或源 STL。');
    }
    const oldAttempt = currentJob?.submittedAttemptId;
    if (oldAttempt && oldAttempt !== job.submittedAttemptId) clearColor();
    renderJob(job);
    if (whiteUrl !== `${localApiUrl(job.source.stlUrl).pathname}${localApiUrl(job.source.stlUrl).search}` || !whiteMesh) {
      try { await loadWhite(job.source.stlUrl); }
      catch (error) { setNote(`纹理任务仍在跟踪，但白模无法读取：${safeText(error.message)}`, true); }
    }
    if (currentDelivery(job) && !colorGroup) text('preview-note', '纹理已复核并提交。选择“上色预览”后读取 GLB。');
    else if (job.stage === 'failed') setNote('纹理任务失败；当前没有彩色交付，父任务白模仍可查看。', true);
    else setNote(terminalStages.has(String(job.stage).toLowerCase()) ? '任务状态已恢复；此页面只读取服务状态，没有重新启动生成。' : '正在只读跟踪纹理任务；刷新页面后也会继续读取同一任务。');
    if (!bfcachePaused && !terminalStages.has(String(job.stage).toLowerCase())) pollTimer = setTimeout(() => loadJob(id), 1800);
  } catch (error) {
    if (version === jobReadVersion) { setNote(`纹理任务读取失败：${safeText(error.message)}`, true); if (!bfcachePaused) pollTimer = setTimeout(() => loadJob(id), 3500); }
  }
}

function glbHasOnlyEmbeddedResources(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.byteLength) return false;
  const chunkLength = view.getUint32(12, true), chunkType = view.getUint32(16, true);
  if (chunkType !== 0x4e4f534a || chunkLength < 2 || 20 + chunkLength > buffer.byteLength) return false;
  try {
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, chunkLength)).replace(/[\u0000\u0020]+$/g, ''));
    return [...(json.buffers || []), ...(json.images || [])].every(item => !item.uri);
  } catch { return false; }
}
async function sha256Hex(buffer) {
  if (!crypto?.subtle) throw new Error('当前浏览器无法校验交付 GLB 的 SHA-256。');
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}
function disposeParsedGltf(gltf) { if (gltf?.scene) disposeObject(gltf.scene); for (const sceneNode of gltf?.scenes || []) if (sceneNode !== gltf.scene) disposeObject(sceneNode); }
async function showColor() {
  const delivery = currentDelivery(currentJob);
  if (!delivery) return;
  const urlKey = delivery.url.pathname + delivery.url.search;
  if (colorGroup && colorUrl === urlKey) { switchView('color'); return; }
  clearColor();
  const version = colorLoadVersion, selectionVersion = ++viewSelectionVersion;
  activeView = 'color'; colorPendingUrl = urlKey; applyActiveView();
  setNote('正在读取已提交并复核的 GLB…');
  try {
    const response = await fetch(delivery.url, { cache:'no-store' });
    if (!response.ok) throw new Error(`已提交 GLB 读取失败（HTTP ${response.status}）。`);
    const buffer = await response.arrayBuffer();
    if (version !== colorLoadVersion) return;
    if (await sha256Hex(buffer) !== delivery.attempt.glbSha256.toLowerCase()) throw new Error('GLB 的 SHA-256 与已提交记录不符。');
    if (!glbHasOnlyEmbeddedResources(buffer)) throw new Error('GLB 不符合内嵌资源格式要求。');
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    const stillDelivery = currentDelivery(currentJob);
    if (version !== colorLoadVersion || !stillDelivery || stillDelivery.url.pathname + stillDelivery.url.search !== urlKey) { disposeParsedGltf(gltf); return; }
    const root = gltf.scene;
    const group = new THREE.Group(); group.name = 'Y-up metres to Z-up millimetres display transform';
    group.rotation.x = Math.PI / 2; group.scale.setScalar(1000); group.add(root);
    colorGroup = group; colorGroup.visible = activeView === 'color'; colorUrl = urlKey; colorPendingUrl = null; scene.add(colorGroup);
    applyActiveView();
    if (activeView === 'color' && selectionVersion === viewSelectionVersion) fitCamera();
    setNote('已加载任务中提交并复核的纹理 GLB。');
  } catch (error) {
    if (version === colorLoadVersion) {
      colorPendingUrl = null;
      if (activeView === 'color' && viewSelectionVersion === selectionVersion) { activeView = 'white'; viewSelectionVersion++; applyActiveView(); }
      setNote(`彩色预览不可用：${safeText(error.message)} 白模仍可查看。`, true);
    }
  }
}
function downloadColor() {
  const delivery = currentDelivery(currentJob); if (!delivery) return;
  const link = document.createElement('a'); link.href = delivery.url.href; link.download = `texture-${currentJob.id}-${delivery.attempt.attemptId}.glb`;
  document.body.append(link); link.click(); link.remove();
}

async function init() {
  initViewer();
  $('reference-confirmed').addEventListener('change', () => { referenceConfirmed = $('reference-confirmed').checked; updateStartButton(); });
  $('start-job').addEventListener('click', startJob);
  const query = new URLSearchParams(location.search), jobId = query.get('job'), sourceId = query.get('source');
  const statusPromise = request('/api/texture/status').then(status => {
    engineReady = status?.ready === true && status?.engineAvailable === true;
    const model = status?.model ? ` · ${safeText(status.model, 80)}` : '';
    setStatus(engineReady ? `纹理服务就绪${model}` : '纹理生成引擎当前不可用', engineReady);
    updateStartButton();
  }).catch(error => { engineReady = false; setStatus('无法连接上色服务'); if (!jobId) setNote(`状态读取失败：${safeText(error.message)}`, true); updateStartButton(); });
  if (jobId) {
    if (!onlyUuid(jobId)) setNote('任务链接中的 UUID 无效。', true);
    else { $('reference-confirmed').disabled = true; $('start-job').hidden = true; await loadJob(jobId); }
  } else if (sourceId) {
    if (onlyUuid(sourceId)) await loadParent(sourceId); else setNote('父任务链接中的 UUID 无效。', true);
  } else setNote('请从已完成并提交的重建候选进入本页。');
  await statusPromise;
}
function handlePageHide(event) {
  clearTimeout(pollTimer); pollTimer = null;
  if (event.persisted) {
    bfcachePaused = true;
    cancelAnimationFrame(animationFrame); animationFrame = 0;
    resizeObserver?.disconnect();
    return;
  }
  releaseEverything();
}
function handlePageShow(event) {
  if (!event.persisted || resourcesReleased) return;
  bfcachePaused = false;
  const stage = $('viewer-stage'), w = Math.max(stage.clientWidth, 1), h = Math.max(stage.clientHeight, 1);
  resizeObserver?.observe(stage); renderer?.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  applyActiveView(); startAnimation();
  if (currentJob && !terminalStages.has(String(currentJob.stage).toLowerCase())) pollTimer = setTimeout(() => loadJob(currentJob.id), 250);
}
function releaseEverything() {
  resourcesReleased = true;
  clearTimeout(pollTimer); pollTimer = null; cancelAnimationFrame(animationFrame); animationFrame = 0;
  resizeObserver?.disconnect(); controls?.dispose();
  disposeObject(whiteMesh); whiteMesh = null; disposeObject(colorGroup); colorGroup = null; renderer?.dispose();
}
init().catch(error => { setStatus('页面初始化失败'); setNote(safeText(error.message), true); });
