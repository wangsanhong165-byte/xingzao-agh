import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const $ = id => document.getElementById(id);
const poseIds = ['upright', 'tilt-x-plus', 'tilt-x-minus', 'tilt-y-plus', 'face-up'];
function taskPoseIds(job) { return Array.isArray(job?.poseIds) && job.poseIds.length > 0 && job.poseIds.length <= 5 && new Set(job.poseIds).size === job.poseIds.length && job.poseIds.every(id => poseIds.includes(id)) ? job.poseIds : poseIds.slice(0,4); }
const poseNames = ['直立', '绕 X 轴 +30°', '绕 X 轴 -30°', '绕 Y 轴 +30°', '侧放 X −90°'];
const terminalStages = new Set(['completed', 'failed', 'interrupted', 'no-feasible']);
const stageLabels = { prepared: '准备中', 'agent-running': '执行中', completed: '已完成', failed: '执行失败', interrupted: '已中断', 'no-feasible': '无可行姿态' };
const reasonLabels = {
  BUILD_VOLUME_EXCEEDED: '超出打印空间', EVIDENCE_NOT_VERIFIED: '检查证据未通过', COST_METRICS_UNVERIFIED: '耗材或时间数据无法验证',
  PROTECTION_NOT_CONFIRMED: '保护区结果未通过验证', PROTECTED_REGION_SUPPORT_LIMIT: '超过保护区支撑包络阈值',
  PROTECTED_REGION_OUTSIDE_SOURCE: '保护区域超出原模型范围', NO_FEASIBLE_POSE: '没有符合约束的姿态',
  POSE_SUBMISSION_REQUIRED: '尚未完成姿态提交', POSE_RECHECK_REQUIRED: '提交前重检尚未通过', POSE_RECHECK_FAILED: '提交前重检未通过',
  RECONSTRUCTION_SOURCE_NOT_VERIFIED: '源重建候选未通过校验', SOURCE_HASH_MISMATCH: '源模型校验值不匹配',
  POSE_SLICER_PROOF_INVALID: '切片配置或切片证据无效', SOURCE_OR_POSE_CHANGED: '源模型或姿态候选发生变化',
  POSE_EVIDENCE_NOT_VERIFIED: '姿态证据未通过重检', POSE_EVIDENCE_HASH_MISMATCH: '姿态证据校验值不匹配',
  POSE_TRANSFORM_MISMATCH: '姿态变换证据不匹配', POSE_AUDIT_MISMATCH: '支撑审计证据不匹配', POSE_COST_METRICS_MISMATCH: '切片成本证据不匹配',
  CRITICAL_FEATURE_NOT_RETAINED: '关键特征未达到保留阈值', CRITICAL_FEATURE_UNVERIFIED: '关键特征审计未验证', CRITICAL_FEATURE_DECLARATION_MISMATCH: '关键特征声明与审计不匹配'
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const candidatePattern = /^[0-9a-f]{64}$/i;
const coordIds = ['xmin', 'ymin', 'zmin', 'xmax', 'ymax', 'zmax'];
const featureCoordIds = ['fxmin', 'fymin', 'fzmin', 'fxmax', 'fymax', 'fzmax'];
let serviceReady = false, featureAuditAvailable = false, validatedCandidateId = null, currentJob = null, selectedPoseId = null, manuallySelectedPose = false, selectionJobId = null, pollTimer = null;
let scene, camera, renderer, controls, mesh = null, roiGroup = null, renderedKey = null, loadVersion = 0;

function setText(id, value) { $(id).textContent = value == null ? '' : String(value); }
function finite(value) { if (value === null || value === undefined || String(value).trim() === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function display(value, suffix = '') { const n = finite(value); return n === null ? '—' : `${Number(n.toFixed(2)).toLocaleString('zh-CN')}${suffix}`; }
function formatDuration(value) {
  const seconds = finite(value); if (seconds === null || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const minutes = Math.round(seconds / 60), hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return hours ? (remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`) : `${minutes} 分钟`;
}
function formatBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 2 || !bounds.every(row => Array.isArray(row) && row.length === 3)) return null;
  const values = bounds.flat().map(finite); if (values.some(value => value === null)) return null;
  return `X ${values[0]}–${values[3]} · Y ${values[1]}–${values[4]} · Z ${values[2]}–${values[5]} mm`;
}
function safeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[本地路径]')
    .replace(/(?:\/home\/|\/Users\/|\/tmp\/|\/private\/|\\\\)[^\s"']+/g, '[本地路径]')
    .slice(0, 500);
}
function safeError(value, fallback) { return safeText(typeof value === 'string' ? value : fallback, fallback) || fallback; }
function poseLabel(id) { const index = poseIds.indexOf(id); return index >= 0 ? poseNames[index] : '未知姿态'; }
function reasonLabel(value) { const raw = safeText(String(value ?? '未知原因')); return Object.hasOwn(reasonLabels, raw) ? reasonLabels[raw] : raw; }
function stageLabel(stage) { return stageLabels[stage] || safeText(String(stage || '状态未知')); }
function apiUrl(path) { return path; }

function initViewer() {
  const stage = $('viewer-stage'); scene = new THREE.Scene(); scene.background = new THREE.Color('#fafcfb');
  camera = new THREE.PerspectiveCamera(38, 1, .05, 3000); camera.up.set(0, 0, 1);
  renderer = new THREE.WebGLRenderer({ canvas: $('mesh-canvas'), antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene.add(new THREE.HemisphereLight('#fff', '#dce6e2', 2.1));
  const key = new THREE.DirectionalLight('#fff', 2.5); key.position.set(-100, -80, 140); scene.add(key);
  const fill = new THREE.DirectionalLight('#a1d4c7', 1); fill.position.set(90, 60, 55); scene.add(fill);
  // A Three.js GridHelper is the viewer's reference plane; it is not a model or inferred bed geometry.
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
function clearRoi() {
  if (roiGroup) {
    scene.remove(roiGroup);
    roiGroup.traverse(object => { if (object.geometry) object.geometry.dispose(); if (object.material) object.material.dispose(); });
    roiGroup = null;
  }
  $('roi-legend').hidden = true;
}
function renderRoi(result) {
  clearRoi();
  const regionSource = currentJob?.regionSource;
  const userConfirmed = regionSource === 'user-submitted-coordinate-bounds';
  const demonstration = regionSource === 'demonstration-coordinate-bounds';
  const regions = (userConfirmed || demonstration) && Array.isArray(currentJob?.protectedRegions) ? currentJob.protectedRegions : [];
  const matrixValues = result?.poseProof?.sourceToPrintMatrix4;
  if (!regions.length || !Array.isArray(matrixValues) || matrixValues.length !== 16 || matrixValues.some(v => finite(v) === null)) return;
  const matrix = new THREE.Matrix4().set(...matrixValues.map(Number)); roiGroup = new THREE.Group();
  const color = demonstration ? '#d38b3f' : '#27886f';
  const edges = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]];
  for (const region of regions) {
    const bounds = region?.boundsMm;
    if (!Array.isArray(bounds) || bounds.length !== 2 || !bounds.every(row => Array.isArray(row) && row.length === 3 && row.every(v => finite(v) !== null)) || bounds[0].some((v, i) => Number(v) >= Number(bounds[1][i]))) continue;
    const [lo, hi] = bounds.map(row => row.map(Number));
    const corners = [[lo[0],lo[1],lo[2]],[hi[0],lo[1],lo[2]],[lo[0],hi[1],lo[2]],[hi[0],hi[1],lo[2]],[lo[0],lo[1],hi[2]],[hi[0],lo[1],hi[2]],[lo[0],hi[1],hi[2]],[hi[0],hi[1],hi[2]]]
      .map(point => new THREE.Vector3(...point).applyMatrix4(matrix));
    const positions = [];
    for (const [a,b] of edges) positions.push(...corners[a].toArray(), ...corners[b].toArray());
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    roiGroup.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: .95 })));
  }
  if (roiGroup.children.length) {
    scene.add(roiGroup);
    const legend = $('roi-legend'); legend.className = `roi-legend ${demonstration ? 'demonstration' : 'user'}`;
    legend.replaceChildren(); const swatch = document.createElement('i'); legend.append(swatch, document.createTextNode(demonstration ? '示范体积，尚未由用户确认' : '用户保护区域体积示意 · 仅为包围体积')); legend.hidden = false;
  }
  else roiGroup = null;
}
function clearMesh(message = '尚无网格') {
  loadVersion++; renderedKey = null;
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); mesh = null; }
  clearRoi();
  $('viewer-message').hidden = false; $('reset-view').disabled = true; $('download-stl').disabled = true; $('download-stl').hidden = true;
  $('download-gcode').disabled = true; $('download-gcode').hidden = true;
  $('mesh-dot').classList.remove('good'); setText('mesh-status', message); setText('mesh-info', 'Z-up · 单位 mm');
}
function resultFor(id) { return currentJob?.results?.find(r => r && r.poseId === id) || null; }
function rejectionFor(job, id) { return Array.isArray(job?.decision?.rejected) ? job.decision.rejected.find(item => item?.poseId === id) || null : null; }
function isDelivered(result) {
  return !!result && currentJob?.stage === 'completed' && currentJob?.submittedPoseId === result.poseId && currentJob?.recheck?.verified === true && typeof result.stlUrl === 'string';
}
async function showStl(url, version) {
  if (typeof url !== 'string' || !url) return;
  const parsed = new URL(url, location.origin);
  if (parsed.origin !== location.origin || parsed.username || parsed.password) throw new Error('服务返回的 STL 地址不是本站资源。');
  const key = parsed.pathname + parsed.search;
  if (renderedKey === key && mesh) return;
  const response = await fetch(parsed.href, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`服务返回的 STL 无法读取（${response.status}）。`);
  const geometry = new STLLoader().parse(await response.arrayBuffer());
  if (!geometry.attributes.position?.count) { geometry.dispose(); throw new Error('服务返回的 STL 没有可显示的三角面。'); }
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  if (version !== loadVersion) { geometry.dispose(); return; }
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
  mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#168a78', roughness: .52, metalness: .03, side: THREE.DoubleSide }));
  renderedKey = key; scene.add(mesh); $('viewer-message').hidden = true; $('reset-view').disabled = false;
  $('mesh-dot').classList.add('good'); setText('mesh-status', '已加载服务返回的 STL 候选预览'); setText('mesh-info', `${Math.floor(geometry.attributes.position.count / 3).toLocaleString('zh-CN')} 个三角面 · Z-up · mm`); fitCamera();
}

function renderTabs(job) {
  const results = Array.isArray(job?.results) ? job.results : [];
  const activeIds = taskPoseIds(job);
  if (!activeIds.includes(selectedPoseId)) selectedPoseId = activeIds[0];
  const root = $('pose-tabs'); root.replaceChildren();
  activeIds.forEach((id, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `pose-tab${id === selectedPoseId ? ' selected' : ''}`; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(id === selectedPoseId));
    const result = results.find(r => r?.poseId === id), rejected = rejectionFor(job, id);
    button.textContent = `${poseLabel(id)} · ${rejected ? '不满足约束' : result ? qualityLabel(result.status) : '等待结果'}`;
    button.addEventListener('click', () => { manuallySelectedPose = true; selectedPoseId = id; renderJob(currentJob); }); root.append(button);
  });
  const selected = resultFor(selectedPoseId), selectedRejected = rejectionFor(job, selectedPoseId);
  setText('candidate-title', selected ? `${poseLabel(selectedPoseId)} · ${selectedRejected ? '不满足约束' : qualityLabel(selected.status)}` : '等待该姿态的候选网格');
  $('download-stl').hidden = !isDelivered(selected); $('download-stl').disabled = !isDelivered(selected);
  const gcodeReady = isDelivered(selected) && typeof selected.gcodeUrl === 'string';
  $('download-gcode').hidden = !gcodeReady; $('download-gcode').disabled = !gcodeReady;
  if (selected?.stlUrl) { clearRoi(); const version = ++loadVersion; showStl(selected.stlUrl, version).then(() => { if (version === loadVersion) renderRoi(selected); }).catch(err => { if (version === loadVersion) clearMesh(err.message); }); }
  else clearMesh(selected ? '该姿态没有可预览 STL' : '等待真实候选网格');
}
function qualityLabel(status) {
  if (status === 'verified') return '已验证';
  if (status === 'unverified') return '未验证';
  if (status === 'infeasible') return '不可行';
  if (status === 'failed') return '失败';
  if (status === 'pass' || status === 'feasible' || status === true) return '可行';
  if (status === 'fail' || status === 'rejected' || status === false) return '不合格';
  return '未知';
}
function appendCell(row, content, cls) { const td = document.createElement('td'); if (cls) td.className = cls; if (content instanceof Node) td.append(content); else td.textContent = content; row.append(td); }
function renderComparison(job) {
  const body = $('comparison-body'); body.replaceChildren();
  const results = Array.isArray(job?.results) ? job.results : [];
  const demoRegion = job?.regionSource === 'demonstration-coordinate-bounds';
  $('protection-column-title').textContent = demoRegion ? '示范体积包络' : '保护区包络';
  taskPoseIds(job).forEach((poseId, index) => {
    const result = results.find(item => item?.poseId === poseId) || null;
    const rejected = Array.isArray(job?.decision?.rejected) ? job.decision.rejected.find(item => item?.poseId === poseId) : null;
    const tr = document.createElement('tr');
    appendCell(tr, poseLabel(poseId));
    const statusWrap = document.createElement('div'), q = document.createElement('span'); q.className = 'quality';
    q.textContent = rejected ? '不满足约束' : result ? qualityLabel(result.status) : '等待结果';
    if (rejected || result?.status === 'infeasible' || result?.status === 'failed' || result?.status === 'fail' || result?.status === 'rejected' || result?.status === false) q.classList.add('fail');
    statusWrap.append(q);
    if (rejected?.reason) { const reason = document.createElement('small'); reason.className = 'reject-reason'; reason.textContent = reasonLabel(rejected.reason); statusWrap.append(reason); }
    appendCell(tr, statusWrap);
    appendCell(tr, display(result?.slice?.metrics?.filamentG, ' g'));
    appendCell(tr, formatDuration(result?.slice?.metrics?.estimatedTimeSeconds));
    const audit = result?.supportAudit;
    const selectedRegionId = job?.protectedRegions?.[0]?.id;
    const regionAudit = Array.isArray(audit?.regions) ? audit.regions.find(item => item?.id === selectedRegionId) || audit.regions[0] : null;
    const regionSupport = regionAudit?.supportPathLengthMm;
    const recognizedRegion = ['user-submitted-coordinate-bounds', 'demonstration-coordinate-bounds'].includes(job?.regionSource) && Array.isArray(job?.protectedRegions) && job.protectedRegions.length > 0;
    const envelopeVerified = audit?.verified === true && (result?.protectionVerified === true || audit?.protectionVerified === true);
    appendCell(tr, recognizedRegion && envelopeVerified && regionSupport !== null && regionSupport !== undefined ? display(regionSupport, ' mm') : '—');
    body.append(tr);
  });
  const decision = job?.decision;
  const demonstration = String(job?.regionSource || '').toLowerCase().includes('demonstration');
  const unspecified = job?.regionSource === 'none' || (Array.isArray(job?.protectedRegions) && job.protectedRegions.length === 0);
  setText('comparison-note', demonstration ? '显示示范体积的刀轨包络；区域尚未由用户确认' : unspecified ? '未指定保护区域 · 仍可比较切片成本' : Array.isArray(decision?.feasiblePoseIds) ? `${decision.feasiblePoseIds.length} 个可行姿态` : '服务尚未给出比较决策');
}
function renderFeatureAudit(job) {
  const root = $('feature-audit-results'); root.replaceChildren();
  const declarations = Array.isArray(job?.criticalFeatures) ? job.criticalFeatures : [];
  if (!declarations.length) { setText('feature-audit-state', '未启用'); setText('feature-audit-note', '此任务未启用关键特征声明。'); return; }
  const featureSource = job?.featureSource === 'demonstration-coordinate-bounds' ? '演示坐标范围 · 未经人工确认' : job?.featureSource === 'user-submitted-coordinate-bounds' ? '用户提交坐标范围' : '坐标来源未知';
  const scopes = { 'sampled-source-feature-vs-planned-model-extrusion': '按采样点比较源特征与计划挤出模型' };
  const scope = job?.results?.find(result => result?.featureAudit?.scope)?.featureAudit?.scope;
  const solidNotes = declarations.filter(feature => feature?.kind === 'solid').map(feature => `实体表面容差 ${display(feature.surfaceToleranceMm ?? .05, ' mm')}（仅软件采样比较，不代表实物公差）`);
  const toleranceNote = solidNotes.length ? ` · ${[...new Set(solidNotes)].join('；')}` : '';
  setText('feature-audit-note', `${featureSource} · 保留阈值 ${Math.round((finite(declarations[0]?.minRetention) ?? .9) * 100)}%${toleranceNote}${scope ? ` · 范围：${scopes[scope] || safeText(scope)}` : ''}`);
  const results = Array.isArray(job?.results) ? job.results : []; let anyVerified = false;
  for (const [index, poseId] of taskPoseIds(job).entries()) {
    const result = results.find(item => item?.poseId === poseId), audit = result?.featureAudit; anyVerified ||= audit?.verified === true;
    const card = document.createElement('article'); card.className = 'feature-result'; const title = document.createElement('strong'); title.textContent = poseLabel(poseId); card.append(title);
    const rows = Array.isArray(audit?.features) ? audit.features : [];
    if (!audit || audit.verified !== true) { const line = document.createElement('p'); line.textContent = '审计未验证 · —'; card.append(line); }
    else for (const declaration of declarations) {
      const item = rows.find(row => row?.id === declaration?.id), line = document.createElement('p');
      const threshold = finite(declaration.minRetention) ?? .9;
      const directions = Array.isArray(item?.directionRetentions) ? item.directionRetentions : [];
      const directionValues = directions.map(direction => ({ name: typeof direction?.direction === 'string' ? direction.direction : null, retention: finite(direction?.retentionFraction) }));
      const directionEvidenceKnown = directionValues.length > 0 && directionValues.every(direction => direction.name && direction.retention !== null);
      const worstDirection = directionEvidenceKnown ? directionValues.reduce((worst, direction) => direction.retention < worst.retention ? direction : worst) : null;
      let passed = item?.verified === true && item?.passed === true;
      if (!item || item.verified !== true) line.textContent = `${declaration.kind === 'void-channel' ? '孔道自由率 / 连通性' : '材料表面保留率'}：— · 未验证`;
      else if (declaration.kind === 'void-channel') {
        passed = item.passed === true && item.connected === true && finite(item.retentionFraction) !== null;
        line.textContent = `孔道自由率：${display(item.retentionFraction === null ? null : item.retentionFraction * 100, '%')} · 连通性：${item.connected === true ? '是' : item.connected === false ? '否' : '—'} · ${item.passed === false ? '未通过' : passed ? '审计通过' : '证据未知'}`;
      }
      else if (!directionEvidenceKnown) { passed = false; line.textContent = `材料表面保留率：${display(item.retentionFraction === null ? null : item.retentionFraction * 100, '%')} · 最差方向：— · 阈值 ${Math.round(threshold * 100)}% · 方向证据未知`;
      } else {
        const directionPass = directionValues.every(direction => direction.retention + 1e-12 >= threshold);
        const overallRetention = finite(item.retentionFraction), overallPass = overallRetention !== null && overallRetention + 1e-12 >= threshold;
        passed = item.passed === true && directionPass && overallPass;
        const directionStatus = !directionPass ? `${worstDirection.name} 未达阈值` : overallRetention === null ? '整体保留率：—' : !overallPass ? '整体保留率未达阈值' : '各方向与整体达到阈值';
        line.textContent = `材料表面保留率：${display(overallRetention === null ? null : overallRetention * 100, '%')} · 最差方向 ${worstDirection.name}：${display(worstDirection.retention * 100, '%')} · 阈值 ${Math.round(threshold * 100)}% · ${directionStatus}${item.passed === false && directionPass && overallPass ? ' · 审计未通过' : ''}`;
      }
      const solidEvidenceFailed = declaration.kind === 'solid' && directionEvidenceKnown && (directionValues.some(direction => direction.retention + 1e-12 < threshold) || (finite(item?.retentionFraction) !== null && finite(item.retentionFraction) + 1e-12 < threshold));
      const voidEvidenceFailed = declaration.kind === 'void-channel' && item?.connected === false;
      line.className = item?.verified === true && passed ? 'feature-pass' : item?.verified === true && (item?.passed === false || solidEvidenceFailed || voidEvidenceFailed) ? 'feature-fail' : 'feature-unknown'; card.append(line);
    }
    if (Array.isArray(audit?.warnings)) for (const warning of audit.warnings) { const note = document.createElement('small'); note.textContent = safeText(String(warning)); card.append(note); }
    const rejection = rejectionFor(job, poseId); if (rejection && ['CRITICAL_FEATURE_NOT_RETAINED', 'CRITICAL_FEATURE_UNVERIFIED', 'CRITICAL_FEATURE_DECLARATION_MISMATCH'].includes(rejection.reason)) { const reason = document.createElement('small'); reason.className = 'reject-reason'; reason.textContent = reasonLabel(rejection.reason); card.append(reason); }
    root.append(card);
  }
  setText('feature-audit-state', anyVerified ? '含已验证审计' : '未验证');
}
function addFact(list, label, value) {
  if (value === null || value === undefined || value === '') return;
  const wrap = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = String(value); wrap.append(dt, dd); list.append(wrap);
}
function renderFacts(job) {
  const source = job.source && typeof job.source === 'object' ? job.source : {};
  const facts = $('task-facts'); facts.replaceChildren();
  addFact(facts, '来源类型', source.kind === 'imported' ? '导入模型' : source.kind === 'reconstructed' ? '照片重建' : null);
  addFact(facts, '源任务 ID', source.jobId); addFact(facts, '源候选 ID', source.candidateId); addFact(facts, '源校验 SHA-256', typeof source.sourceSha256 === 'string' ? source.sourceSha256.slice(0, 16) + '…' : null);
  addFact(facts, '源模型边界', formatBounds(source.boundsMm));
  const regionCount = Array.isArray(job.protectedRegions) ? job.protectedRegions.length : 0;
  const demonstration = String(job.regionSource || '').toLowerCase().includes('demonstration');
  const regionSourceLabel = demonstration ? '示范区域，未由用户确认' : job.regionSource === 'user-submitted-coordinate-bounds' && regionCount > 0 ? `${regionCount} 个用户坐标区域` : job.regionSource === 'none' || regionCount === 0 ? '未指定保护区域' : '区域来源未知';
  addFact(facts, '保护区域来源', regionSourceLabel);
  addFact(facts, '支撑包络阈值', finite(job.constraints?.maxRegionSupportPathLengthMm) === null ? null : display(job.constraints.maxRegionSupportPathLengthMm, ' mm'));
  addFact(facts, '执行模型', job.execution?.model); addFact(facts, '执行模式', job.execution?.mode);
  const decision = job.decision || {}, note = $('decision-note');
  const lines = [];
  if (decision.recommendedPoseId) lines.push(`推荐姿态：${poseLabel(decision.recommendedPoseId)}`);
  const rejectedReasons = Array.isArray(decision.rejected) ? decision.rejected.filter(item => item?.reason !== null && item?.reason !== undefined && String(item.reason).trim() !== '') : [];
  if (rejectedReasons.length) lines.push(`拒绝原因：${rejectedReasons.map(item => `${poseLabel(item?.poseId)}：${reasonLabel(item.reason)}`).join('；')}`);
  const materialPct = finite(decision.materialChangePercent); if (materialPct !== null) lines.push(`相对耗材变化：${materialPct.toFixed(1)}%`);
  const timePct = finite(decision.timeChangePercent); if (timePct !== null) lines.push(`相对时间变化：${timePct.toFixed(1)}%`);
  if (demonstration) {
    const results = Array.isArray(job.results) ? job.results : [];
    const allEnvelopeChecksVerified = results.length > 0 && results.every(result => result?.supportAudit?.verified === true && (result?.protectionVerified === true || result?.supportAudit?.protectionVerified === true));
    lines.push(allEnvelopeChecksVerified ? '示范体积的刀轨包络已核查；区域尚未由用户确认' : '示范体积的刀轨包络尚未全部核查；区域尚未由用户确认');
  }
  else if (job.regionSource === 'none' || regionCount === 0) lines.push('未指定保护区域；仍可比较切片成本');
  else lines.push(decision.protectionVerified === true ? '保护区结果已验证' : '保护区关键结果未验证');
  note.textContent = lines.join(' · ') || '服务尚未返回决策信息。';
  const delivery = $('delivery-facts'); delivery.replaceChildren();
  addFact(delivery, '重检结果', job.recheck?.verified === true ? '已通过' : job.recheck?.verified === false ? '未通过' : '未知');
  const scopeLabel = decision.scope === 'best-among-tested-feasible-poses' ? '已测试且满足约束的候选比较' : decision.scope;
  addFact(delivery, '已提交姿态', job.submittedPoseId); addFact(delivery, '比较范围', scopeLabel);
  const delivered = job.stage === 'completed' && job.recheck?.verified === true && !!job.submittedPoseId;
  setText('delivery-state', delivered ? '已交付且重检通过' : '未验证交付'); $('delivery-state').classList.toggle('agh', delivered);
  setText('job-id', job.id || '—'); setText('source-mode', job.execution?.provider || job.execution?.mode || '真实任务');
}
function renderEvents(events) {
  const list = $('event-list'); list.replaceChildren();
  if (!Array.isArray(events) || !events.length) { const p = document.createElement('p'); p.className = 'event-empty'; p.textContent = '服务尚未返回执行事件。'; list.append(p); return; }
  events.forEach(event => {
    const row = document.createElement('div'); row.className = 'event-row';
    const time = document.createElement('span'); time.className = 'event-time'; time.textContent = event?.at || '—';
    const source = document.createElement('span'); source.className = `event-source${event?.source === 'agh' ? ' agh' : ''}`; source.textContent = safeText(String(event?.source || event?.tool || '服务事件'));
    const message = document.createElement('span'); message.className = 'event-message';
    const outcome = document.createElement('b'); outcome.className = `event-outcome ${event?.success === true ? 'pass' : event?.success === false ? 'fail' : 'unknown'}`; outcome.textContent = event?.success === true ? '成功' : event?.success === false ? '失败' : '未知';
    const detail = [event?.tool, event?.poseId, event?.code ? reasonLabel(event.code) : null, event?.message].filter(v => v !== null && v !== undefined && v !== '').map(v => safeText(String(v))).join(' · ');
    message.append(outcome, document.createTextNode(detail || '服务未提供详情')); row.append(time, source, message); list.append(row);
  });
}
function renderJob(job) {
  if (selectionJobId !== job.id) { selectionJobId = job.id; manuallySelectedPose = false; selectedPoseId = null; }
  if (!manuallySelectedPose) {
    const preferred = job.submittedPoseId || job.decision?.recommendedPoseId || 'upright';
    selectedPoseId = taskPoseIds(job).includes(preferred) ? preferred : 'upright';
  }
  currentJob = job; renderTabs(job); renderComparison(job); renderFeatureAudit(job); renderFacts(job); renderEvents(job.events); renderJobError(job);
  const canRepair = job.agentRunActive === false && ['completed','no-feasible'].includes(job.stage) && Array.isArray(job.results) && job.results.some(r=>r.featureAudit?.verified === true && r.featureAudit.features?.some(f=>f.kind==='solid'&&f.verified===true&&f.passed===false));
  $('repair-link').hidden = !canRepair; if (canRepair) $('repair-link').href = `/repair?parent=${encodeURIComponent(job.id)}`;
  setText('job-stage', stageLabel(job.stage)); const active = job.agentRunActive === true && !terminalStages.has(String(job.stage).toLowerCase());
  $('job-dot').classList.toggle('active', active); if (active) schedulePoll(1800); else stopPolling();
  setText('start-note', active ? '任务正在执行，页面会自动读取状态。' : `任务阶段：${stageLabel(job.stage)}`);
}
function renderJobError(job) {
  const box = $('job-error'), error = job?.error;
  if (error === null || error === undefined || error === '') { box.hidden = true; box.textContent = ''; return; }
  const code = typeof error === 'string' ? error : error.code || error.reason || error.message || JSON.stringify(error);
  box.hidden = false; box.textContent = `任务说明：${reasonLabel(code)}`;
}
function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(() => { if (currentJob?.id) fetchJob(currentJob.id, true); }, ms); }
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
async function fetchJob(id, quiet = false) {
  try {
    const response = await fetch(apiUrl(`/api/poses/jobs/${encodeURIComponent(id)}`), { cache: 'no-store', credentials: 'same-origin' }); const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(safeError(body.error || body.message, `任务读取失败（${response.status}）。`));
    if (!body || body.id !== id || typeof body.stage !== 'string') throw new Error('任务响应缺少有效的 id 或 stage 字段。');
    if (!$('source-job').value.trim() && body.source?.kind !== 'imported' && uuidPattern.test(body.source?.jobId || '')) { $('source-job').value = body.source.jobId; refreshStart(); }
    if (!$('source-candidate').value.trim() && body.source?.kind === 'imported' && candidatePattern.test(body.source?.candidateId || '')) { $('source-candidate').value = body.source.candidateId; $('source-kind').value = 'imported'; $('source-kind').dispatchEvent(new Event('change')); refreshStart(); }
    renderJob(body);
  } catch (error) { if (!quiet) { $('job-error').hidden = false; $('job-error').textContent = safeError(error.message, '无法读取任务状态。'); } stopPolling(); }
}
async function checkStatus() {
  try {
    const response = await fetch('/api/poses/status', { cache: 'no-store', credentials: 'same-origin' }); const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(safeError(body.error || body.message, `状态读取失败（${response.status}）。`));
    serviceReady = body.ready === true; featureAuditAvailable = body.featureAudit?.available === true && body.featureAudit?.maxFeatures >= 1;
    $('source-kind').querySelector('option[value="imported"]').disabled = !featureAuditAvailable; $('feature-enabled').disabled = !featureAuditAvailable;
    if ($('source-kind').value === 'imported') $('source-kind').dispatchEvent(new Event('change'));
    const parts = [serviceReady ? '服务已就绪' : '服务未就绪', featureAuditAvailable ? '关键特征审计可用' : '旧版合同：关键特征/导入不可用'];
    if (body.model) parts.push(`模型 ${safeText(String(body.model)).slice(0, 100)}`); if (body.profileId) parts.push(`切片配置 ${safeText(String(body.profileId)).slice(0, 80)}`);
    setText('engine-status', parts.join(' · ')); $('engine-dot').classList.toggle('ready', serviceReady);
    setText('start-note', serviceReady ? '默认仅比较成本；区域保护需手动勾选并确认原模型坐标。' : '姿态比较服务未就绪，暂不能开始任务。');
  } catch (error) { serviceReady = false; setText('engine-status', safeError(error.message, '服务状态暂不可用')); setText('start-note', '执行环境状态未知，暂不能开始任务。'); }
  refreshStart();
}
function regionsPayload() {
  if (!$('protect-enabled').checked) return { protectedRegions: [], maxRegionSupportPathLengthMm: null };
  const values = coordIds.map(id => finite($(id).value)); const maxPath = finite($('max-path').value);
  if (values.some(v => v === null)) throw new Error('请填写保护区域的六个原模型坐标（mm）。');
  if (values[0] >= values[3] || values[1] >= values[4] || values[2] >= values[5]) throw new Error('保护区域每个最小坐标都必须小于对应最大坐标。');
  if (maxPath === null || maxPath < 0) throw new Error('请填写不小于 0 mm 的允许支撑包络进入长度。');
  if (!$('region-confirm').checked) throw new Error('请先确认你已依据原模型核对保护区域与坐标。');
  return { protectedRegions: [{ id: 'protected-1', boundsMm: [[values[0], values[1], values[2]], [values[3], values[4], values[5]]] }], maxRegionSupportPathLengthMm: maxPath };
}
function refreshStart() {
  let regionValid = true; try { regionsPayload(); } catch { regionValid = false; }
  let featureValid = true; try { criticalFeaturesPayload(); } catch { featureValid = false; }
  const imported = $('source-kind').value === 'imported', source = imported ? $('source-candidate').value.trim() : $('source-job').value.trim();
  $('start-job').disabled = !serviceReady || !(imported ? candidatePattern.test(source) && source === validatedCandidateId : uuidPattern.test(source)) || !regionValid || !featureValid || $('start-job').dataset.busy === 'true';
}
function criticalFeaturesPayload() {
  if (!$('feature-enabled').checked) return [];
  if (!featureAuditAvailable) throw new Error('当前服务未声明支持关键特征审计。');
  const values = featureCoordIds.map(id => finite($(id).value));
  if (values.some(value => value === null)) throw new Error('请填写关键特征六个源模型坐标（mm）。');
  if (values[0] >= values[3] || values[1] >= values[4] || values[2] >= values[5]) throw new Error('关键特征每个最小坐标都必须小于对应最大坐标。');
  if (!$('feature-confirm').checked) throw new Error('请先确认已依据原模型核对关键特征范围和方向。');
  const kind = $('feature-kind').value, feature = { id: 'critical-1', kind, boundsMm: [[values[0], values[1], values[2]], [values[3], values[4], values[5]]], minRetention: .9, surfaceToleranceMm: .05 };
  if (kind === 'void-channel') feature.axis = $('feature-axis').value;
  return [feature];
}
async function startJob() {
  const imported = $('source-kind').value === 'imported', sourceId = imported ? $('source-candidate').value.trim() : $('source-job').value.trim();
  if (imported ? (!candidatePattern.test(sourceId) || sourceId !== validatedCandidateId) : !uuidPattern.test(sourceId)) { setText('start-note', imported ? '请通过模型导入检查后再使用候选 ID。' : '请输入有效的源重建任务 UUID。'); $('start-note').classList.add('error'); return; }
  let constraints; try { constraints = regionsPayload(); } catch (error) { setText('start-note', error.message); $('start-note').classList.add('error'); return; }
  let criticalFeatures; try { criticalFeatures = criticalFeaturesPayload(); } catch (error) { setText('start-note', error.message); $('start-note').classList.add('error'); return; }
  const button = $('start-job'); button.dataset.busy = 'true'; refreshStart(); stopPolling(); $('job-error').hidden = true; $('start-note').classList.remove('error'); setText('start-note', '正在创建姿态比较任务…');
  try {
    const payload = { sourceKind: imported ? 'imported' : 'reconstructed', ...(imported ? { sourceCandidateId: sourceId } : { sourceJobId: sourceId }), ...constraints, criticalFeatures, featureSource: criticalFeatures.length ? 'user-submitted-coordinate-bounds' : null };
    const response = await fetch('/api/poses/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload) });
    const result = await response.json().catch(() => ({}));
    if (response.status !== 202) throw new Error(safeError(result.error || result.message, `任务提交失败（${response.status}）。`));
    if (!result || typeof result.id !== 'string' || !uuidPattern.test(result.id) || typeof result.stage !== 'string') throw new Error('提交响应缺少有效任务 id 或 stage。');
    history.replaceState(null, '', `${location.pathname}?job=${encodeURIComponent(result.id)}`);
    currentJob = { id: result.id, stage: result.stage, agentRunActive: true, results: [], events: [] }; renderJob(currentJob); await fetchJob(result.id);
  } catch (error) { setText('start-note', safeError(error.message, '任务提交失败。')); $('start-note').classList.add('error'); }
  finally { button.dataset.busy = 'false'; refreshStart(); }
}
function bind() {
  $('source-job').addEventListener('input', refreshStart); $('protect-enabled').addEventListener('change', () => { $('region-fields').disabled = !$('protect-enabled').checked; refreshStart(); });
  [...coordIds, 'max-path', 'region-confirm'].forEach(id => $(id).addEventListener('input', refreshStart)); $('region-confirm').addEventListener('change', refreshStart);
  $('source-kind').addEventListener('change', () => { const imported = $('source-kind').value === 'imported'; $('reconstructed-source').hidden = imported; $('imported-source').hidden = !imported; refreshStart(); });
  $('source-candidate').addEventListener('input', refreshStart);
  const invalidateImport = () => { validatedCandidateId = null; $('source-candidate').value = ''; $('import-next').hidden=true; setText('import-note', '文件或尺寸已变更，请重新检查并导入。'); refreshStart(); };
  $('source-units').addEventListener('change', invalidateImport);
  $('target-edge').addEventListener('input', invalidateImport);
  $('model-file').addEventListener('change', invalidateImport);
  $('feature-enabled').addEventListener('change', () => { $('feature-fields').disabled = !$('feature-enabled').checked; refreshStart(); });
  $('feature-kind').addEventListener('change', () => { $('feature-axis-field').hidden = $('feature-kind').value !== 'void-channel'; refreshStart(); });
  [...featureCoordIds, 'feature-axis', 'feature-confirm'].forEach(id => $(id).addEventListener('input', refreshStart)); $('feature-confirm').addEventListener('change', refreshStart);
  $('import-model').addEventListener('click', importModel);
  $('start-job').addEventListener('click', startJob);
  $('download-stl').addEventListener('click', async () => {
    const result = resultFor(selectedPoseId); if (!isDelivered(result)) return;
    try {
      const parsed = new URL(result.stlUrl, location.origin); if (parsed.origin !== location.origin) throw new Error('下载地址不是本站资源。');
      const response = await fetch(parsed.href, { cache: 'no-store', credentials: 'same-origin' }); if (!response.ok) throw new Error(`STL 下载失败（${response.status}）。`);
      const blob = await response.blob(), objectUrl = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = `pose-${String(selectedPoseId).replace(/[^a-zA-Z0-9_-]/g, '_')}.stl`; anchor.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    } catch (error) { $('job-error').hidden = false; $('job-error').textContent = safeError(error.message, 'STL 下载失败。'); }
  });
  $('download-gcode').addEventListener('click', async () => {
    const result = resultFor(selectedPoseId); if (!isDelivered(result) || typeof result.gcodeUrl !== 'string') return;
    try {
      const parsed = new URL(result.gcodeUrl, location.origin);
      if (parsed.origin !== location.origin || parsed.username || parsed.password) throw new Error('下载地址不是本站资源。');
      const response = await fetch(parsed.href, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`G-code 下载失败（${response.status}）。`);
      const blob = await response.blob(), objectUrl = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = objectUrl; anchor.download = `pose-${String(selectedPoseId).replace(/[^a-zA-Z0-9_-]/g, '_')}.gcode`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    } catch (error) { $('job-error').hidden = false; $('job-error').textContent = safeError(error.message, 'G-code 下载失败。'); }
  });
}

async function importModel() {
  const button = $('import-model'), file = $('model-file').files?.[0], units = $('source-units').value, edge = finite($('target-edge').value);
  if (!featureAuditAvailable) { setText('import-note', '当前服务未声明支持导入来源和关键特征合同。'); return; }
  if (!file) { setText('import-note', '请先选择 STL 或 GLB 文件。'); return; }
  if (!/\.(stl|glb)$/i.test(file.name) || file.size > 25 * 1024 * 1024) { setText('import-note', '仅支持不超过 25 MiB 的 STL / GLB 文件。'); return; }
  if (edge === null || edge < 1 || edge > 180) { setText('import-note', '目标最长边必须在 1–180 mm 范围内。'); return; }
  button.disabled = true; $('import-next').hidden=true; setText('import-note', '正在进行服务端模型检查…');
  try {
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('无法读取所选文件。')); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file); });
    const body = { name: file.name, mime: file.type || (/\.glb$/i.test(file.name) ? 'model/gltf-binary' : 'model/stl'), dataBase64: dataUrl.split(',')[1], sourceUnits: units, targetLongestEdgeMm: edge };
    const response = await fetch('/api/model-import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(safeError(result.error || result.message, `模型导入检查失败（${response.status}）。`));
    if (result.geometryChecksPassed !== true || typeof result.candidateId !== 'string' || !candidatePattern.test(result.candidateId)) throw new Error('服务没有确认几何检查通过，候选未启用。');
    if(file!==$('model-file').files?.[0]||units!==$('source-units').value||edge!==finite($('target-edge').value))throw new Error('导入期间文件或尺寸已改变，请按当前输入重新检查。');
    $('source-candidate').value = result.candidateId; validatedCandidateId = result.candidateId; $('source-kind').value = 'imported'; $('source-kind').dispatchEvent(new Event('change'));
    const dimensions = ['x', 'y', 'z'].map(axis => finite(result.dimensionsMm?.[axis]));
    $('continue-protect').href=`/protect?sourceCandidateId=${result.candidateId}`;
    $('continue-workflow').href=`/workflow?sourceCandidateId=${result.candidateId}`;$('import-next').hidden=false;
    setText('import-note', `已通过检查 · 候选 ${result.candidateId} · 归一化尺寸 ${dimensions.every(value => value !== null) ? dimensions.map(value => display(value)).join(' × ') + ' mm' : '—'}`); refreshStart();
  } catch (error) { setText('import-note', safeError(error.message, '模型导入检查失败。')); $('source-candidate').value = ''; validatedCandidateId = null; refreshStart(); }
  finally { button.disabled = false; }
}

initViewer(); bind(); checkStatus(); renderComparison(null);
const query = new URLSearchParams(location.search), sourceParam = query.get('source'), jobParam = query.get('job');
if(query.get('mode')==='import'&&!jobParam){$('source-kind').value='imported';$('source-kind').dispatchEvent(new Event('change'));}
if (sourceParam) { if (uuidPattern.test(sourceParam)) $('source-job').value = sourceParam; else if (candidatePattern.test(sourceParam)) { $('source-candidate').value = sourceParam; $('source-kind').value = 'imported'; } else { $('job-error').hidden = false; setText('job-error', 'URL 中的 source 参数不是有效 UUID 或候选 ID。'); } }
if (jobParam) { if (uuidPattern.test(jobParam)) fetchJob(jobParam); else { setText('job-stage', '无效任务编号'); $('job-error').hidden = false; setText('job-error', 'URL 中的 job 参数不是有效 UUID。'); } }
