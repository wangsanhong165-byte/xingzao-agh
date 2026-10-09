import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const $ = id => document.getElementById(id);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MODEL_IMPORT_BYTES = 25 * 1024 * 1024;
const PROFILE_FALLBACK = 'fdm-pla-04';
const stageNames = { queued: '排队中', starting: '准备中', 'agh-starting': 'AGH 启动中', agh_starting: 'AGH 启动中', incomplete: '执行未完成', interrupted: '执行中断', inspect: '细节检查', inspect_failed: '细节检查失败', build: '构造候选', build_failed: '候选构造失败', slice: '实际切片', slice_failed: '切片失败', verify: '路径复核', verify_failed: '路径复核失败', submit: '提交结果', submit_failed: '结果提交失败', submitted: '已提交', complete: '任务完成', completed: '任务完成', failed: '执行失败', error: '执行失败' };
let statusData = null, currentProfileId = null, restoringJob = false;
let imageFile = null, imageElement = null, imageObjectUrl = null;
let roi = { x: 0, y: 0, width: 512, height: 384 }, dragging = false, dragOrigin = null;
let jobs = new Map(), activeRunId = null, displayedJobId = null, selectedCandidateId = null, userSelectedCandidate = false, renderedCandidateId = null, pathVersion = 0, currentPathKey = null;
let scene, camera, renderer, controls, candidateMesh = null;
let importFile = null, importVersion = 0, importScene = null, importCamera = null, importRenderer = null, importControls = null, importedMesh = null, importResizeObserver = null, importedStlUrl = null, importedName = 'model';

function setText(id, text) { $(id).textContent = String(text ?? ''); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }
function finite(value) { if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function fmt(value, digits = 2) { const number = finite(value); return number === null ? '—' : number.toLocaleString('zh-CN', { maximumFractionDigits: digits }); }
function basename(value) { return String(value ?? '').split(/[\\/]/).pop() || ''; }

function initThree() {
  const stage = $('viewer-stage');
  scene = new THREE.Scene(); scene.background = new THREE.Color('#fafcfb');
  camera = new THREE.PerspectiveCamera(38, 1, .05, 2000); camera.up.set(0, 0, 1);
  renderer = new THREE.WebGLRenderer({ canvas: $('mesh-canvas'), antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  scene.add(new THREE.HemisphereLight('#ffffff', '#dce6e2', 2.15));
  const key = new THREE.DirectionalLight('#ffffff', 2.7); key.position.set(-100, -80, 140); scene.add(key);
  const fill = new THREE.DirectionalLight('#9fd6c8', 1.2); fill.position.set(90, 60, 55); scene.add(fill);
  const grid = new THREE.GridHelper(220, 22, '#d7e3df', '#e8efec'); grid.rotation.x = Math.PI / 2; grid.position.z = -.12; scene.add(grid);
  controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = .08;
  const resize = () => { const width = Math.max(stage.clientWidth, 1), height = Math.max(stage.clientHeight, 1); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(stage); resize();
  $('reset-view').addEventListener('click', fitCamera);
  const animate = () => { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); };
  animate();
}
function fitCamera() {
  if (!candidateMesh) return;
  const box = new THREE.Box3().setFromObject(candidateMesh), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()), radius = Math.max(size.length() * .72, 16);
  controls.target.copy(center); camera.position.set(center.x + radius * 1.32, center.y - radius * 1.7, center.z + radius * 1.2);
  camera.near = Math.max(radius / 1000, .05); camera.far = radius * 30; camera.updateProjectionMatrix(); controls.update();
}
function showMesh(positions, candidateId) {
  if (candidateId === renderedCandidateId && candidateMesh) return;
  if (candidateMesh) { scene.remove(candidateMesh); candidateMesh.geometry.dispose(); candidateMesh.material.dispose(); candidateMesh = null; }
  renderedCandidateId = candidateId || null;
  if (!positions?.length) { $('viewer-message').hidden = false; setText('mesh-status', '候选尚无可显示网格'); $('mesh-canvas').style.opacity = '0'; $('viewer-footer').querySelector('i').classList.remove('good'); return; }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  candidateMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#168a78', roughness: .52, metalness: .03, side: THREE.DoubleSide }));
  candidateMesh.castShadow = true; candidateMesh.receiveShadow = true; scene.add(candidateMesh); $('viewer-message').hidden = true; $('mesh-canvas').style.opacity = '1'; $('viewer-footer').querySelector('i').classList.add('good');
  fitCamera(); setText('mesh-status', '真实候选三角网格'); setText('mesh-info', `${Math.floor(positions.length / 9).toLocaleString('zh-CN')} 个三角面 · CAD 坐标 mm`);
}

function drawGeneratedSample(kind) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 384;
  const ctx = canvas.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 512, 384); ctx.fillStyle = '#050505';
  if (kind === 'O') {
    ctx.beginPath(); ctx.ellipse(256, 190, 117, 145, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(256, 190, 69, 98, 0, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.font = '900 188px Arial Black, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('AI', 256, 194, 438);
  }
  return new Promise(resolve => canvas.toBlob(blob => resolve(new File([blob], `sample-${kind}.png`, { type: 'image/png' })), 'image/png'));
}
async function useSample(kind) { const file = await drawGeneratedSample(kind); await loadImage(file, true); }
async function loadImage(file, fromSample = false) {
  if (!file || file.type !== 'image/png') throw new Error('请选择 PNG 图片。');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('PNG 图片不能超过 5 MiB。');
  const url = URL.createObjectURL(file), image = new Image();
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('图片无法读取。')); image.src = url; });
  if (image.naturalWidth * image.naturalHeight > 12_000_000) { URL.revokeObjectURL(url); throw new Error('图片解码像素不能超过 12 MP。'); }
  if (imageObjectUrl) URL.revokeObjectURL(imageObjectUrl);
  imageObjectUrl = url; imageElement = image; imageFile = file; roi = { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
  drawRoiCanvas(); $('image-editor').hidden = false; setText('image-name', `${file.name} · ${image.naturalWidth} × ${image.naturalHeight}px`); setText('start-note', fromSample ? '程序生成的高对比样例；这是输入样例，不代表分析已运行。' : '图片在本地预览；点击开始后才会提交给真实 AGH 任务。'); refreshStartState();
}
function drawRoiCanvas() {
  if (!imageElement) return;
  const canvas = $('source-canvas'); canvas.width = imageElement.naturalWidth; canvas.height = imageElement.naturalHeight;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(imageElement, 0, 0);
  const dim = Math.max(canvas.width, canvas.height) * .3; ctx.fillStyle = `rgba(24,42,38,${Math.min(.45, dim / 500)})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff'; ctx.fillRect(roi.x, roi.y, roi.width, roi.height); ctx.drawImage(imageElement, roi.x, roi.y, roi.width, roi.height, roi.x, roi.y, roi.width, roi.height);
  ctx.strokeStyle = '#16a38b'; ctx.lineWidth = Math.max(2, Math.round(Math.max(canvas.width, canvas.height) / 230)); ctx.setLineDash([ctx.lineWidth * 3, ctx.lineWidth * 2]); ctx.strokeRect(roi.x, roi.y, roi.width, roi.height); ctx.setLineDash([]);
  setText('roi-value', `${roi.x}, ${roi.y}, ${roi.width}, ${roi.height}`);
}
function pointerToImage(event) { const rect = $('source-canvas').getBoundingClientRect(); return { x: Math.round((event.clientX - rect.left) * imageElement.naturalWidth / rect.width), y: Math.round((event.clientY - rect.top) * imageElement.naturalHeight / rect.height) }; }
function clampRoi(point) { return { x: Math.max(0, Math.min(imageElement.naturalWidth, point.x)), y: Math.max(0, Math.min(imageElement.naturalHeight, point.y)) }; }

function validInputs() {
  if (!imageFile) return '先上传 PNG 或载入 AI / O 程序样例。';
  const width = finite($('width-mm').value), depth = finite($('depth-mm').value), baseThickness = finite($('base-mm').value);
  const minFeatureWidth = finite($('min-feature').value), reliefHeight = finite($('relief-height').value), maxReliefHeight = finite($('max-relief').value), minFidelity = finite($('min-fidelity').value);
  if (width === null || width < 1 || width > 180 || depth === null || depth < 1 || depth > 180 || baseThickness === null || baseThickness < .8 || baseThickness > 10) return '宽度和深度范围为 1–180 mm，底板厚度为 0.8–10 mm。';
  if (minFeatureWidth === null || minFeatureWidth < .4 || minFeatureWidth > 3 || reliefHeight === null || maxReliefHeight === null || maxReliefHeight > 3 || maxReliefHeight < .2 || reliefHeight < .2 || reliefHeight > maxReliefHeight || minFidelity === null || minFidelity < .5 || minFidelity > 1) return '检查细节约束：线宽 0.4–3 mm，凸起 0.2 mm 至上限（≤3 mm），最低保真度 0.5–1。';
  if (roi.width < 1 || roi.height < 1) return '保护区域 ROI 不能是空区域。';
  return '';
}
function refreshStartState() {
  const active = restoringJob || (activeRunId && jobs.get(activeRunId)?.agentRunActive !== false);
  const missing = statusData?.agh?.ready !== true || statusData?.slicer?.available !== true || statusData?.agh?.modelConfigured !== true;
  $('start-job').textContent = restoringJob ? '正在恢复历史任务…' : active ? 'AGH 任务进行中…' : '开始真实 AGH 验证 →';
  $('start-job').disabled = Boolean(active) || missing || Boolean(validInputs());
  $('start-note').classList.toggle('warning', missing);
  if (active) setText('start-note', '当前 AGH 任务仍在执行，完成后可提交修订版本。');
  else if (missing) setText('start-note', readinessMessage());
  else if (validInputs()) setText('start-note', validInputs());
}
async function loadStatus() {
  try {
    const response = await fetch('/api/print/status'); if (!response.ok) throw new Error(`状态查询失败（${response.status}）。`);
    statusData = await response.json(); const agh = statusData.agh || {}, slicer = statusData.slicer || {};
    const ready = agh.ready === true && slicer.available === true && agh.modelConfigured === true;
    $('agh-dot').classList.toggle('ready', !ready); setText('agh-status', ready ? `模型与切片器已配置 · ${agh.model || '模型可用'}` : `执行环境未就绪 · ${agh.reason || (!slicer.available ? '切片器不可用' : 'AGH 未 ready')}`);
    setText('profile-name', slicer.profile?.name || '虚拟 FDM PLA 0.4 / 0.2');
    setText('profile-ready', slicer.available ? `${slicer.version || '切片器可用'}` : '切片器未就绪');
    $('profile-ready').classList.toggle('good', Boolean(slicer.available));
    setText('start-note', ready ? '仅启动真实 AGH 受限工具链；不会自动放宽尺寸或细节约束。' : readinessMessage());
    refreshStartState();
  } catch (error) { statusData = null; $('agh-dot').classList.add('ready'); setText('agh-status', '服务状态不可用'); $('profile-ready').textContent = '状态不可用'; setText('start-note', `${error.message} 任务已禁用。`); refreshStartState(); }
}
function readinessMessage() {
  if (!statusData) return '无法读取 AGH 服务状态，任务保持禁用；页面不会使用模拟分析或替代模型。';
  if (statusData.agh?.ready !== true) return `AGH 尚未 ready（${statusData.agh?.reason || '执行环境待就绪'}）；页面不会使用模拟分析或替代模型。`;
  if (statusData.agh?.modelConfigured !== true) return 'AGH 模型尚未配置；完成真实配置后才能开始。';
  if (statusData.slicer?.available !== true) return '切片器不可用；任务保持禁用，不会跳过真实切片验证。';
  return 'AGH 执行环境未就绪；任务保持禁用。';
}

function imageAsBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('图片读取失败。')); reader.readAsDataURL(file); }); }
function currentInput() {
  return {
    image: { name: imageFile.name, mime: 'image/png', dataBase64: null },
    dimensions: { width: Number($('width-mm').value), depth: Number($('depth-mm').value), baseThickness: Number($('base-mm').value) },
    roi: { ...roi }, profileId: currentProfileId || statusData?.profileId || PROFILE_FALLBACK,
    constraints: { minFeatureWidth: Number($('min-feature').value), reliefHeight: Number($('relief-height').value), maxReliefHeight: Number($('max-relief').value), minFidelity: Number($('min-fidelity').value) }
  };
}
async function startJob() {
  const validation = validInputs(); if (validation) { setText('start-note', validation); return; }
  if (statusData?.agh?.ready !== true || statusData?.agh?.modelConfigured !== true || statusData?.slicer?.available !== true) { refreshStartState(); return; }
  const button = $('start-job'); button.disabled = true; button.textContent = '正在提交真实 AGH 任务…';
  try {
    const input = currentInput(); input.image.dataBase64 = await imageAsBase64(imageFile);
    const response = await fetch('/api/print/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const data = await response.json().catch(() => ({ error: '服务返回了无法读取的响应。' }));
    if (!response.ok || !data.id) throw new Error(data.error || data.message || `任务启动失败（${response.status}）。`);
    const job = { id: data.id, stage: data.stage || 'queued', agentRunActive: true, events: [], candidates: [], execution: null, error: null, requestOptions: { dimensions: input.dimensions, roi: input.roi, profileId: input.profileId, constraints: input.constraints, imageName: input.image.name } };
    jobs.set(data.id, job); activeRunId = displayedJobId = data.id; selectedCandidateId = null; userSelectedCandidate = false; pushJobHistory(); drawJob(job); setText('start-note', '任务已提交。正在每秒读取真实执行记录；只把 AGH 来源事件称为 AGH 工具调用。'); refreshStartState(); pollJob(data.id);
  } catch (error) { setText('start-note', error.message || '任务提交失败。'); button.textContent = '开始真实 AGH 验证 →'; refreshStartState(); }
}
function isTerminal(job) { return job?.agentRunActive === false && Boolean(job.execution || job.error); }
async function pollJob(jobId) {
  while (activeRunId === jobId) {
    try {
      const response = await fetch(`/api/print/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`任务状态读取失败（${response.status}）。`);
      const update = await response.json(), old = jobs.get(jobId) || { id: jobId };
      const job = { ...old, ...update, id: jobId, events: update.events || old.events || [], candidates: update.candidates || old.candidates || [] };
      jobs.set(jobId, job); if (displayedJobId === jobId) drawJob(job); pushJobHistory();
      if (isTerminal(job)) { activeRunId = null; if (displayedJobId === jobId) { refreshStartState(); setText('start-note', job.error ? '任务已结束，可修正输入后开始新任务；此任务记录仍保留。' : '任务已停止执行；结果状态以候选检查和真实路径复核为准。'); } return; }
    } catch (error) {
      const job = jobs.get(jobId); if (job) { job.pollError = error.message; jobs.set(jobId, job); if (displayedJobId === jobId) drawJob(job); }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function restoreJob(jobId) {
  restoringJob = true; displayedJobId = jobId; selectedCandidateId = null; userSelectedCandidate = false;
  setText('job-stage', '恢复历史任务…'); setText('run-id', `任务 ${jobId}`); setText('start-note', '读取既有任务状态、固定参数和原始 PNG…'); refreshStartState();
  try {
    const response = await fetch(`/api/print/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`无法读取历史任务（${response.status}）。`);
    const job = await response.json(); job.id = jobId; jobs.set(jobId, job);
    const request = job.requestOptions || {};
    if (request.dimensions) for (const [key, inputId] of [['width','width-mm'],['depth','depth-mm'],['baseThickness','base-mm']]) if (finite(request.dimensions[key]) !== null) $(inputId).value = request.dimensions[key];
    if (request.constraints) for (const [key, inputId] of [['minFeatureWidth','min-feature'],['reliefHeight','relief-height'],['maxReliefHeight','max-relief'],['minFidelity','min-fidelity']]) if (finite(request.constraints[key]) !== null) $(inputId).value = request.constraints[key];
    if (request.profileId) currentProfileId = request.profileId;
    const sourceUrl = job.sourceImageUrl || `/api/print/jobs/${encodeURIComponent(jobId)}/source`;
    const sourceResponse = await fetch(sourceUrl, { cache: 'no-store' });
    if (!sourceResponse.ok) throw new Error(`历史任务原图不可用（${sourceResponse.status}）。`);
    const sourceBlob = await sourceResponse.blob(), imageName = request.imageName || `job-${jobId}.png`;
    await loadImage(new File([sourceBlob], imageName, { type: sourceBlob.type || 'image/png' }), false);
    if (request.roi && ['x','y','width','height'].every(key => finite(request.roi[key]) !== null)) {
      roi = { x: Number(request.roi.x), y: Number(request.roi.y), width: Number(request.roi.width), height: Number(request.roi.height) }; drawRoiCanvas();
    }
    job.requestOptions = { dimensions: request.dimensions, roi: request.roi, profileId: request.profileId, constraints: request.constraints, imageName };
    jobs.set(jobId, job); displayedJobId = jobId; activeRunId = isTerminal(job) ? null : jobId;
    pushJobHistory(); drawJob(job); restoringJob = false;
    setText('start-note', activeRunId ? '已恢复实际原图、输入参数和运行中的 job；继续读取既有 AGH 执行记录。' : '已恢复此 job 的实际原图和固定参数。修改输入后可以启动新任务，既有记录保留。');
    if (activeRunId) pollJob(jobId); else refreshStartState();
  } catch (error) {
    restoringJob = false; activeRunId = null; setText('job-stage', '历史任务不可用'); setText('start-note', `${error.message || '无法恢复历史任务。'} 未载入样例或模拟结果。`); $('start-job').disabled = true;
    $('viewer-message').hidden = false; $('viewer-message').querySelector('strong').textContent = '无法恢复历史任务'; $('viewer-message').querySelector('span:last-child').textContent = '检查 job id、原图存档和服务状态。';
  }
}

function candidateIdOf(candidate) { return candidate.candidateId || candidate.id || ''; }
function candidatesFor(job) { return Array.isArray(job?.candidates) ? job.candidates : []; }
function baselineOf(job) { const list = candidatesFor(job); return list.find(candidate => candidateIdOf(candidate) === job.baselineCandidateId) || list.find(candidate => candidate.options?.enhance === false) || null; }
function enhancementsOf(job) { return candidatesFor(job).filter(candidate => candidate.options?.enhance === true); }
function currentCandidate(job) { const candidates = candidatesFor(job), selected = candidates.find(candidate => candidateIdOf(candidate) === selectedCandidateId); if (userSelectedCandidate && selected) return selected; return candidates.find(candidate => candidateIdOf(candidate) === job.submittedCandidateId) || selected || baselineOf(job) || candidates[0] || null; }
function renderCandidateTabs(job) {
  const wrapper = $('candidate-tabs'), baseline = baselineOf(job), enhanced = enhancementsOf(job), candidates = [];
  if (baseline) candidates.push({ candidate: baseline, label: '原版底板' });
  for (const [index, candidate] of enhanced.entries()) candidates.push({ candidate, label: enhanced.length > 1 ? `增强 ${index + 1}` : '增强几何' });
  if (!candidates.length) { wrapper.innerHTML = '<button type="button" disabled>等待候选</button>'; $('download-stl').disabled = true; $('download-svg').disabled = true; return; }
  const selected = currentCandidate(job); selectedCandidateId = selected ? candidateIdOf(selected) : null;
  const canDownload = Boolean(selected && selected.slice?.execution && job.id);
  $('download-stl').disabled = !canDownload; $('download-svg').disabled = !canDownload;
  wrapper.innerHTML = candidates.map(({ candidate, label }) => `<button type="button" class="${candidateIdOf(candidate) === selectedCandidateId ? 'selected' : ''}" data-candidate="${escapeHtml(candidateIdOf(candidate))}">${label}</button>`).join('');
  wrapper.querySelectorAll('[data-candidate]').forEach(button => button.addEventListener('click', () => { selectedCandidateId = button.dataset.candidate; userSelectedCandidate = true; const active = currentCandidate(job); if (active) { drawCandidate(job, active); drawPath(job, active); } renderCandidateTabs(job); }));
}
function drawCandidate(job, candidate) {
  const id = candidateIdOf(candidate); showMesh(candidate.mesh?.positions, id);
  setText('mesh-info', candidate.mesh?.positions?.length ? `${Math.floor(candidate.mesh.positions.length / 9).toLocaleString('zh-CN')} 个三角面 · ${candidate.options?.enhance ? '浮雕几何' : '平面底板'} · mm` : '候选未提供网格');
  setText('mesh-status', candidate.mesh?.positions?.length ? `${candidate.options?.enhance ? '增强几何候选' : '原版平面候选'} · ${basename(id)}` : '候选尚无可显示网格');
  drawCandidateEvidence(job, candidate);
}
function setMetric(id, value) { setText(id, value === null || value === undefined ? '—' : value); }
function drawCandidateEvidence(job, candidate) {
  const metrics = candidate.metrics || {}, slice = candidate.slice || {}, sliceMetrics = slice.metrics || {}, verify = candidate.verification || {}, minFidelity = Number(job.requestOptions?.constraints?.minFidelity ?? $('min-fidelity').value);
  setMetric('metric-volume', fmt(metrics.volumeMm3, 1)); setMetric('metric-filament', fmt(sliceMetrics.filamentG, 2)); setMetric('metric-length', fmt(sliceMetrics.filamentMm, 0)); setMetric('metric-time', fmt(Number(sliceMetrics.estimatedTimeSeconds) / 60, 1));
  const profile = slice.profile; setText('slice-profile', profile?.name || profile?.id || slice.execution?.version || '等待切片');
  const enhanced = candidate.options?.enhance === true;
  const fidelity = finite(verify.fidelity ?? candidate.detail?.fidelity);
  const featureLayers = finite(verify.featureLayerCount), extrusionLength = finite(verify.featureExtrusionLengthMm);
  const actualSlice = slice.execution?.mode === 'actual-slicer';
  const success = enhanced && verify.success === true && verify.hasRaisedDetail === true && featureLayers !== null && featureLayers > 0 && extrusionLength !== null && extrusionLength > 0 && fidelity !== null && fidelity >= minFidelity && actualSlice;
  const checkFailure = [...(candidate.checks || []), ...(verify.checks || [])].some(check => ['fail','failed','error','invalid'].includes(String(check.status || '').toLowerCase()));
  const failed = enhanced && (verify.success === false || checkFailure || (fidelity !== null && fidelity < minFidelity) || (verify.hasRaisedDetail === false));
  const pill = $('verification-pill'); pill.className = `result-pill ${success ? 'pass' : failed ? 'fail' : 'idle'}`; pill.textContent = success ? '几何与路径通过' : failed ? '未达到约束' : enhanced ? '等待复核' : '基线对照';
  let summary = enhanced ? (success ? '达到当前输入保真阈值，且凸起区域有真实切片挤出路径。' : '不得显示为成功：检查尺寸、图案、保真度或切片路径后再判断。') : '原版候选为平面底板；不应出现高于底板表面的细节挤出。';
  if (verify.message) summary += ` ${verify.message}`;
  setText('verification-summary', summary);
  const footprint = verify.footprint || candidate.footprint || {};
  const footprintMetrics = [];
  if (finite(footprint.targetCoverageFraction) !== null) footprintMetrics.push(['目标覆盖率', fmt(footprint.targetCoverageFraction, 3)]);
  if (finite(footprint.spillFraction) !== null) footprintMetrics.push(['目标外溢比例', fmt(footprint.spillFraction, 3)]);
  const survivingHoles = finite(footprint.survivingTargetHoleCount), targetHoles = finite(footprint.targetHoleCount);
  if (survivingHoles !== null && targetHoles !== null) footprintMetrics.push(['保留目标孔洞', `${survivingHoles} / ${targetHoles}`]);
  const verificationMetrics = [
    ['最低保真度', fmt(minFidelity, 2)], ['候选保真度', fmt(fidelity, 3)], ['凸起路径层数', featureLayers === null ? '—' : String(featureLayers)], ['凸起挤出长度', extrusionLength === null ? '—' : `${fmt(extrusionLength, 1)} mm`], ['凸起路径存在', verify.hasRaisedDetail === true ? '是' : verify.hasRaisedDetail === false ? '否' : '—'], ['切片来源', actualSlice ? `真实切片器 · ${slice.execution.version || ''}` : slice.execution?.mode || '—']
  ];
  $('verification-metrics').innerHTML = [...verificationMetrics, ...footprintMetrics].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  $('candidate-checks').innerHTML = checksHtml([...(candidate.checks || []), ...(verify.checks || [])]);
  const warnings = [...(candidate.warnings || []), ...(slice.warnings || [])]; $('metric-warnings').hidden = warnings.length === 0; $('metric-warnings').innerHTML = warnings.map(warning => escapeHtml(typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning))).join('<br>');
  if (job.error) { pill.className = 'result-pill fail'; pill.textContent = '任务失败'; setText('verification-summary', job.error.message || job.error); }
}
function checksHtml(checks) {
  if (!Array.isArray(checks)) return '';
  return checks.map(check => { const status = String(check.status || '').toLowerCase(), fail = ['fail','failed','error','invalid'].includes(status), warn = ['warn','warning'].includes(status), pass=['pass','passed','ok','success'].includes(status),info=!fail&&!warn&&!pass; return `<div class="check-row ${fail ? 'fail' : warn ? 'warn' : info ? 'info' : ''}"><i>${fail ? '×' : warn ? '!' : pass ? '✓' : '·'}</i><span><strong>${escapeHtml(check.name || '检查')}</strong> · ${escapeHtml(check.detail || status || '已记录')}</span></div>`; }).join('');
}
function drawJob(job) {
  const stage = job.stage || 'queued'; setText('job-stage', stageNames[stage] || stage); $('job-pulse').classList.toggle('active', job.agentRunActive === true);
  const mode = job.execution?.mode, transport = job.execution?.toolTransport;
  const modeLabel = mode === 'agh-shell-tools' ? 'AGH 命令工具桥接（非原生 detail 插件执行）' : mode === 'agh' && transport === 'native-plugin' ? `AGH 原生插件工具 · ${job.execution?.model || '模型已记录'}` : mode ? `执行模式：${mode}` : 'execution 等待记录';
  setText('run-id', `任务 ${job.id}`); setText('run-summary', job.error ? `任务异常：${job.error.message || job.error} · ${modeLabel}` : `执行状态：${stageNames[stage] || stage} · AGH 正在运行：${job.agentRunActive === true ? '是' : '否'} · ${modeLabel}`);
  renderCandidateTabs(job); const candidate = currentCandidate(job);
  if (candidate) { drawCandidate(job, candidate); drawPath(job, candidate); } else { showMesh(null, null); clearCandidateEvidence(); if (job.error) { $('verification-pill').className = 'result-pill fail'; $('verification-pill').textContent = '任务未完成'; setText('verification-summary', `没有提交可验证候选：${job.error.message || job.error}`); setText('path-meta', '无候选路径证据'); } }
  renderEvents(job); refreshStartState();
}
function clearCandidateEvidence() {
  for (const id of ['metric-volume','metric-filament','metric-length','metric-time']) setMetric(id, null);
  setText('slice-profile', '等待切片'); $('verification-pill').className = 'result-pill idle'; $('verification-pill').textContent = '待验证'; setText('verification-summary', '尚未收到切片后的路径复核结果。'); $('verification-metrics').replaceChildren(); $('candidate-checks').replaceChildren(); $('metric-warnings').hidden = true; $('path-image').hidden = true; $('path-empty').hidden = false; setText('path-meta', '尚无路径证据'); currentPathKey = null; pathVersion++;
}
function renderEvents(job) {
  const list = $('events'), events = Array.isArray(job.events) ? job.events : [];
  if (!events.length) { list.innerHTML = `<div class="event-empty">${job.pollError ? escapeHtml(job.pollError) : '等待执行事件…'}</div>`; return; }
  list.innerHTML = events.map(event => {
    const source = String(event.source || 'unknown'), isAgh = source === 'agh', sourceLabel = isAgh ? 'AGH 工具' : source === 'system' ? '服务系统' : source === 'unit' ? '单元检查' : source;
    const stamp = event.at ? new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
    return `<div class="event-row"><span class="event-time">${escapeHtml(stamp)}</span><span class="event-source ${isAgh ? 'agh' : ''}">${isAgh ? 'AGH · ' : ''}${escapeHtml(event.tool || sourceLabel)}</span><span class="event-message">${escapeHtml(event.message || (event.success === false ? '失败' : '已记录'))}${event.candidateId ? ` · 候选 ${escapeHtml(basename(event.candidateId))}` : ''}${event.success === false ? ' · 失败' : ''}</span></div>`;
  }).join('');
}
function pushJobHistory() {
  const list = $('events'); let history = document.querySelector('.history-row');
  if (!history) { history = document.createElement('div'); history.className = 'history-row'; $('run-card')?.append(history); if (!$('run-card')) $('events').after(history); }
  history.innerHTML = [...jobs.values()].map(job => `<button type="button" data-job="${escapeHtml(job.id)}" class="${job.id === displayedJobId ? 'current' : ''}">${escapeHtml(basename(job.id))} · ${escapeHtml(stageNames[job.stage] || job.stage || '排队')}</button>`).join('');
  history.querySelectorAll('[data-job]').forEach(button => button.addEventListener('click', () => { displayedJobId = button.dataset.job; selectedCandidateId = null; userSelectedCandidate = false; drawJob(jobs.get(displayedJobId)); pushJobHistory(); }));
}
async function drawPath(job, candidate) {
  const id = candidateIdOf(candidate), key = `${job.id}:${id}`, image = $('path-image');
  const slice = candidate.slice, verify = candidate.verification;
  if (!slice?.execution || typeof verify?.previewSvg !== 'string' || !verify.previewSvg.trim() || !candidateIdOf(candidate)) {
    if (currentPathKey === key) { currentPathKey = null; pathVersion++; }
    image.hidden = true; $('path-empty').hidden = false; setText('path-meta', slice?.execution ? '等待切片路径复核…' : '尚无路径证据'); return;
  }
  if (currentPathKey === key && !image.hidden) return;
  const version = ++pathVersion; currentPathKey = key; image.hidden = true; $('path-empty').hidden = false; setText('path-meta', '读取已复核切片路径…');
  try {
    const response = await fetch(`/api/print/jobs/${encodeURIComponent(job.id)}/svg/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`路径 SVG 不可用（${response.status}）。`);
    const blob = await response.blob(); if (version !== pathVersion || displayedJobId !== job.id || selectedCandidateId !== id) { if (currentPathKey === key) currentPathKey = null; return; }
    if (window.__pathObjectUrl) URL.revokeObjectURL(window.__pathObjectUrl); window.__pathObjectUrl = URL.createObjectURL(blob); image.src = window.__pathObjectUrl; image.hidden = false; $('path-empty').hidden = true;
    setText('path-meta', verify?.hasRaisedDetail === true ? '实切路径 · 已复核凸起区域' : '实切路径 · 查看基线/候选证据');
  } catch (error) { if (version !== pathVersion) return; currentPathKey = null; setText('path-meta', error.message); }
}
function makeDownloadUrl(url, filename) { return fetch(url, { cache: 'no-store' }).then(async response => { if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `下载失败（${response.status}）。`); } return response.blob(); }).then(blob => { const objectUrl = URL.createObjectURL(blob), link = document.createElement('a'); link.href = objectUrl; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1500); }); }

function selectedModelMime(file) { return file.name.toLowerCase().endsWith('.glb') ? 'model/gltf-binary' : 'model/stl'; }
function refreshImportButton() {
  const target = finite($('import-target-edge').value), validTarget = target !== null && target >= 1 && target <= 180;
  $('import-model-button').disabled = !importFile || !validTarget || $('import-model-button').dataset.busy === 'true';
}
function resetImportedModel() {
  if (importedMesh && importScene) { importScene.remove(importedMesh); importedMesh.geometry.dispose(); importedMesh.material.dispose(); importedMesh = null; }
  importedStlUrl = null; $('imported-model-result').hidden = true; $('download-imported-stl').disabled = true;
}
function initImportViewer() {
  if (importRenderer) return;
  const canvas = $('imported-mesh-canvas'), stage = canvas?.parentElement;
  if (!canvas || !stage) throw new Error('导入模型预览画布不可用。');
  importScene = new THREE.Scene(); importScene.background = new THREE.Color('#fafcfb');
  importCamera = new THREE.PerspectiveCamera(38, 1, .05, 2000); importCamera.up.set(0, 0, 1);
  importRenderer = new THREE.WebGLRenderer({ canvas, antialias: true }); importRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); importRenderer.outputColorSpace = THREE.SRGBColorSpace;
  importScene.add(new THREE.HemisphereLight('#ffffff', '#dce6e2', 2));
  const key = new THREE.DirectionalLight('#ffffff', 2.4); key.position.set(-100, -80, 140); importScene.add(key);
  const fill = new THREE.DirectionalLight('#a1d4c7', 1); fill.position.set(90, 60, 55); importScene.add(fill);
  const grid = new THREE.GridHelper(220, 22, '#d7e3df', '#e8efec'); grid.rotation.x = Math.PI / 2; grid.position.z = -.12; importScene.add(grid);
  importControls = new OrbitControls(importCamera, canvas); importControls.enableDamping = true; importControls.dampingFactor = .08;
  importResizeObserver = new ResizeObserver(() => { const width=Math.max(stage.clientWidth,1), height=Math.max(stage.clientHeight,1); importRenderer.setSize(width,height,false); importCamera.aspect=width/height; importCamera.updateProjectionMatrix(); });
  importResizeObserver.observe(stage); const rect=stage.getBoundingClientRect(); importRenderer.setSize(Math.max(rect.width,1),Math.max(rect.height,1),false); importCamera.aspect=Math.max(rect.width,1)/Math.max(rect.height,1); importCamera.updateProjectionMatrix();
  const animate = () => { if (!importRenderer) return; requestAnimationFrame(animate); importControls.update(); importRenderer.render(importScene, importCamera); }; animate();
}
function fitImportedCamera() {
  if (!importedMesh || !importCamera || !importControls) return;
  const bounds=new THREE.Box3().setFromObject(importedMesh), center=bounds.getCenter(new THREE.Vector3()), size=bounds.getSize(new THREE.Vector3()), radius=Math.max(size.length()*.72,12);
  importControls.target.copy(center); importCamera.position.set(center.x+radius*1.3,center.y-radius*1.7,center.z+radius*1.2); importCamera.near=Math.max(radius/1000,.05); importCamera.far=radius*30; importCamera.updateProjectionMatrix(); importControls.update();
}
function normalizedDimensions(summary, geometry) {
  const candidates=[summary.normalizedDimensionsMm,summary.actualDimensionsMm,summary.dimensionsMm,summary.targetDimensionsMm,summary.mesh?.dimensionsMm,summary.normalized?.dimensionsMm];
  for (const value of candidates) {
    if (Array.isArray(value)&&value.length>=3&&value.slice(0,3).every(item=>finite(item)!==null)) return {values:value.slice(0,3).map(Number),source:'服务返回的归一化尺寸'};
    if (value&&typeof value==='object') { const dims=[value.width??value.x,value.depth??value.y,value.height??value.z].map(finite); if (dims.every(item=>item!==null)) return {values:dims,source:'服务返回的归一化尺寸'}; }
  }
  if (geometry?.boundingBox) { const size=geometry.boundingBox.getSize(new THREE.Vector3()); return {values:[size.x,size.y,size.z],source:'服务归一化 STL 的实际包围盒'}; }
  return null;
}
function closedCheck(summary) {
  const explicit=summary.closed??summary.isClosed??summary.watertight??summary.mesh?.closed;
  if (explicit===true) return '闭合：通过'; if (explicit===false) return '闭合：未通过';
  const checkSource=summary.checks||summary.geometryChecks||summary.meshChecks||{};
  if(!Array.isArray(checkSource)&&typeof checkSource==='object'){
    const watertight=checkSource.watertight??checkSource.closed??checkSource.isClosed;
    if(watertight===true)return '闭合：通过';if(watertight===false)return '闭合：未通过';
    const boundary=finite(checkSource.boundaryEdgeCount),nonManifold=finite(checkSource.nonManifoldEdgeCount);
    if(boundary!==null&&nonManifold!==null)return boundary===0&&nonManifold===0?'闭合：通过':'闭合：未通过';
  }
  const checks=Array.isArray(checkSource)?checkSource:[];
  const item=checks.find(check=>/closed|manifold|watertight|闭合|流形/i.test(String(check.name||'')));
  if (!item) return '闭合：服务未提供该项检查';
  const status=String(item.status||'').toLowerCase(); return ['pass','passed','ok','success'].includes(status)?'闭合：通过':(['fail','failed','error'].includes(status)?'闭合：未通过':'闭合：检查结果未定');
}
function summaryChecksHtml(summary) {
  let checks=summary.checks||summary.geometryChecks||summary.meshChecks||[];
  if (!Array.isArray(checks)&&checks&&typeof checks==='object') checks=Object.entries(checks).map(([name,value])=>{const counted=/edgecount$/i.test(name)||/degeneratefacecount$/i.test(name),status=typeof value==='boolean'?(value?'pass':'fail'):counted&&finite(value)!==null?(Number(value)===0?'pass':'fail'):'info',detail=value===null||value===undefined?'未提供':typeof value==='object'?JSON.stringify(value):String(value);return{name,status,detail};});
  return checksHtml(Array.isArray(checks)?checks:[]);
}
function renderImportSummary(summary, geometry, targetLongestEdgeMm, sourceUnits) {
  const dimensions=normalizedDimensions(summary,geometry);
  setText('imported-dimensions',dimensions?`${dimensions.values.map(value=>fmt(value,3)).join(' × ')} mm`:'服务未提供归一化尺寸');
  const volume=finite(summary.volumeMm3??summary.metrics?.volumeMm3??summary.checks?.volumeMm3),closed=closedCheck(summary),boundsSource=dimensions?.source||'';
  const geometryPass=summary.geometryChecksPassed;
  const entries=[['目标最长边',`${fmt(summary.targetLongestEdgeMm??targetLongestEdgeMm,2)} mm`],['源单位',summary.sourceUnits||sourceUnits],['几何检查',geometryPass===true?'通过':geometryPass===false?'未通过':null],['闭合检查',closed],['体积',volume===null?null:`${fmt(volume,2)} mm³`],['尺寸来源',boundsSource||null]];
  $('imported-summary-extra').innerHTML=entries.filter(([,value])=>value!==null&&value!==undefined&&value!=='').map(([label,value])=>`<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  $('imported-checks').innerHTML=summaryChecksHtml(summary);
  const warnings=Array.isArray(summary.warnings)?summary.warnings:[]; $('imported-warnings').hidden=warnings.length===0; $('imported-warnings').innerHTML=warnings.map(warning=>escapeHtml(typeof warning==='string'?warning:warning.message||JSON.stringify(warning))).join('<br>');
  $('imported-model-result').hidden=false;
}
function fileBase64(file) { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('无法读取模型文件。'));reader.readAsDataURL(file);}); }
function clearImportSelection() { importFile=null; $('model-import-file').value=''; setText('model-import-name','模型文件留在本地，点击导入后才会发送给本地服务。'); refreshImportButton(); }
function selectImportFile(file) {
  importVersion++; resetImportedModel(); importFile=file||null;
  if (!file) { setText('model-import-name','模型文件留在本地，点击导入后才会发送给本地服务。'); refreshImportButton(); return; }
  const ext=file.name.toLowerCase().split('.').pop();
  if (!['stl','glb'].includes(ext)) { importFile=null; setText('model-import-name','仅支持 STL 或 GLB。'); setImportStatus('仅支持 .stl 与 .glb 文件。','error'); refreshImportButton(); return; }
  if (file.size>MAX_MODEL_IMPORT_BYTES) { importFile=null; setText('model-import-name','文件超过 25 MiB 限制。'); setImportStatus('模型文件不能超过 25 MiB。','error'); refreshImportButton(); return; }
  setText('model-import-name',`${file.name} · ${(file.size/1024/1024).toFixed(2)} MiB`); setImportStatus('模型文件已选中；输入目标最长边后即可执行几何导入。'); refreshImportButton();
}
function setImportStatus(message,kind='') { setText('model-import-status',message); $('model-import-status').classList.toggle('error',kind==='error'); $('model-import-status').classList.toggle('success',kind==='success'); }
async function loadNormalizedImportStl(url,version) {
  const response=await fetch(new URL(url,window.location.origin),{cache:'no-store'}); if(!response.ok)throw new Error(`归一化 STL 下载失败（${response.status}）。`);
  const loader=new STLLoader(),geometry=loader.parse(await response.arrayBuffer());
  if (!geometry.attributes.position?.count) { geometry.dispose(); throw new Error('归一化 STL 没有可显示的三角面。'); }
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  if (version!==importVersion) { geometry.dispose(); return null; }
  try { initImportViewer(); } catch(error) { geometry.dispose(); throw new Error(`几何检查已返回，但三维预览无法初始化：${error.message||error}`); }
  if(importedMesh){importScene.remove(importedMesh);importedMesh.geometry.dispose();importedMesh.material.dispose();}
  importedMesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:'#526fba',roughness:.5,metalness:.04,side:THREE.DoubleSide}));importedMesh.castShadow=true;importedMesh.receiveShadow=true;importScene.add(importedMesh);fitImportedCamera();return geometry;
}
async function importModelFile() {
  if (!importFile) return;
  const target=finite($('import-target-edge').value),sourceUnits=$('import-source-units').value;
  if(target===null||target<1||target>180){setImportStatus('目标最长边必须在 1–180 mm 范围内。','error');$('import-target-edge').focus();return;}
  const version=++importVersion,file=importFile,extension=file.name.toLowerCase().split('.').pop(),button=$('import-model-button');button.dataset.busy='true';button.disabled=true;button.textContent='正在导入并检查…';setImportStatus('正在向本地几何服务提交文件；不会运行 AGH 或切片任务。');resetImportedModel();
  try {
    const payload={name:file.name,mime:selectedModelMime(file),dataBase64:await fileBase64(file),targetLongestEdgeMm:target,sourceUnits};
    const response=await fetch('/api/model-import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const body=await response.json().catch(()=>({error:'导入服务返回了无法读取的响应。'}));
    if(version!==importVersion)return;
    if(!response.ok)throw new Error(body.error||body.message||`网格导入失败（${response.status}）。`);
    const summary=body.summary&&typeof body.summary==='object'?body.summary:body;
    importedName=file.name; importedStlUrl=body.stlUrl||summary.stlUrl||null;
    if(!importedStlUrl)throw new Error('导入服务没有返回归一化 STL 下载路径。');
    $('imported-model-result').hidden=false;
    let geometry=null;
    try { geometry=await loadNormalizedImportStl(importedStlUrl,version); } catch(previewError) { if(version!==importVersion) return; setImportStatus(`几何检查已返回；三维预览失败：${previewError.message||previewError}`,'error'); }
    if(version!==importVersion)return;
    renderImportSummary(summary,geometry,target,sourceUnits);
    $('download-imported-stl').disabled=false;
    if(geometry) setImportStatus(`${file.name} 已归一化；下面仅显示服务返回的几何检查。`,'success');
  } catch(error) {
    if(version!==importVersion)return;
    setImportStatus(error.message||'模型导入失败。原打印细节任务不受影响。','error');
  } finally {
    if(version===importVersion){button.dataset.busy='false';button.textContent='导入并检查几何';refreshImportButton();}
  }
}

function bind() {
  $('sample-ai').addEventListener('click', () => useSample('AI').catch(showInputError)); $('sample-o').addEventListener('click', () => useSample('O').catch(showInputError));
  const uploadBox = $('upload-box'), fileInput = $('image-file');
  uploadBox.addEventListener('click', () => fileInput.click()); uploadBox.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', async () => { try { await loadImage(fileInput.files?.[0]); } catch (error) { showInputError(error); } finally { fileInput.value = ''; } });
  for (const name of ['dragenter','dragover']) uploadBox.addEventListener(name, event => { event.preventDefault(); uploadBox.classList.add('drag'); });
  for (const name of ['dragleave','drop']) uploadBox.addEventListener(name, event => { event.preventDefault(); uploadBox.classList.remove('drag'); });
  uploadBox.addEventListener('drop', async event => { try { await loadImage(event.dataTransfer.files?.[0]); } catch (error) { showInputError(error); } });
  const importDrop=$('model-import-drop'), importFileInput=$('model-import-file');
  importDrop.addEventListener('click',()=>importFileInput.click()); importDrop.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();importFileInput.click();}});
  importFileInput.addEventListener('change',()=>{selectImportFile(importFileInput.files?.[0]);importFileInput.value='';});
  for(const name of ['dragenter','dragover'])importDrop.addEventListener(name,event=>{event.preventDefault();importDrop.classList.add('drag');});
  for(const name of ['dragleave','drop'])importDrop.addEventListener(name,event=>{event.preventDefault();importDrop.classList.remove('drag');});
  importDrop.addEventListener('drop',event=>selectImportFile(event.dataTransfer.files?.[0]));
  $('import-target-edge').addEventListener('input',refreshImportButton); $('import-model-button').addEventListener('click',importModelFile);
  $('download-imported-stl').addEventListener('click',async()=>{if(!importedStlUrl)return;const version=importVersion;try{const response=await fetch(importedStlUrl,{cache:'no-store'});if(!response.ok)throw new Error(`归一化 STL 下载失败（${response.status}）。`);const blob=await response.blob();if(version!==importVersion)return;const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`${importedName.replace(/\.(stl|glb)$/i,'')}-normalized.stl`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}catch(error){if(version===importVersion)setImportStatus(error.message||'归一化 STL 下载失败。','error');}});
  refreshImportButton();
  $('roi-reset').addEventListener('click', () => { if (!imageElement) return; roi = { x: 0, y: 0, width: imageElement.naturalWidth, height: imageElement.naturalHeight }; drawRoiCanvas(); });
  const canvas = $('source-canvas'); canvas.addEventListener('pointerdown', event => { if (!imageElement) return; dragging = true; canvas.setPointerCapture(event.pointerId); dragOrigin = clampRoi(pointerToImage(event)); roi = { x: dragOrigin.x, y: dragOrigin.y, width: 1, height: 1 }; drawRoiCanvas(); });
  canvas.addEventListener('pointermove', event => { if (!dragging || !imageElement) return; const current = clampRoi(pointerToImage(event)), x = Math.min(current.x, dragOrigin.x), y = Math.min(current.y, dragOrigin.y); roi = { x, y, width: Math.max(1, Math.abs(current.x - dragOrigin.x)), height: Math.max(1, Math.abs(current.y - dragOrigin.y)) }; drawRoiCanvas(); });
  canvas.addEventListener('pointerup', event => { dragging = false; try { canvas.releasePointerCapture(event.pointerId); } catch {} });
  $('start-job').addEventListener('click', startJob);
  for (const id of ['width-mm','depth-mm','base-mm','min-feature','relief-height','max-relief','min-fidelity']) $(id).addEventListener('input', refreshStartState);
  $('download-stl').addEventListener('click', async () => { const job = jobs.get(displayedJobId), candidate = job && currentCandidate(job); if (!job || !candidate) return; try { await makeDownloadUrl(`/api/print/jobs/${encodeURIComponent(job.id)}/stl/${encodeURIComponent(candidateIdOf(candidate))}`, `detail-${basename(candidateIdOf(candidate))}.stl`); } catch (error) { setText('start-note', error.message); } });
  $('download-svg').addEventListener('click', async () => { const job = jobs.get(displayedJobId), candidate = job && currentCandidate(job); if (!job || !candidate) return; try { await makeDownloadUrl(`/api/print/jobs/${encodeURIComponent(job.id)}/svg/${encodeURIComponent(candidateIdOf(candidate))}`, `detail-path-${basename(candidateIdOf(candidate))}.svg`); } catch (error) { setText('start-note', error.message); } });
}
function showInputError(error) { setText('start-note', error?.message || String(error)); $('start-note').classList.add('warning'); }

initThree(); bind(); loadStatus();
const restoreId = new URLSearchParams(window.location.search).get('job');
if (restoreId) restoreJob(restoreId); else useSample('AI').catch(showInputError);
