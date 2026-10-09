import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const $ = id => document.getElementById(id);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const poseIdPattern = /^[a-z][a-z0-9-]{0,63}$/i;
const featureIdPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const labels = { prepared:'准备中', 'agent-running':'AGH 执行中', completed:'已完成', failed:'执行失败', interrupted:'已中断', 'no-feasible':'无可行修正' };
const axes = ['x','y','z'];
let statusReady = false, parentTask = null, currentJob = null, selectedCandidateId = null, selectedPoseId = null, eligibleFeatures = [], pollTimer = null, loadingParent = false, starting = false;
const views = {};
let picking=false, fitting=false, proposalVersion=0, parentLoadVersion=0, proposal=null, selectionOverlay=null, pointerStart=null;

function clearSelectionOverlay(){if(!selectionOverlay)return;views.original.scene.remove(selectionOverlay);selectionOverlay.traverse(obj=>{obj.geometry?.dispose();if(Array.isArray(obj.material))obj.material.forEach(m=>m.dispose());else obj.material?.dispose();});selectionOverlay=null;}
function setPicking(value){picking=value;views.original.controls.enabled=!value;$('original-canvas').classList.toggle('picking',value);$('pick-target').setAttribute('aria-pressed',String(value));$('pick-target').textContent=value?'取消选取':'点击模型选取细杆';}
function invalidateProposal({clearFields=false}={}){
 proposalVersion++;proposal=null;fitting=false;setPicking(false);clearSelectionOverlay();$('coordinates-confirmed').checked=false;
 if(clearFields)document.querySelectorAll('#line-fields input,#bounds-fields input').forEach(el=>el.value='');
 text('proposal-summary','尚未选取，或选取条件已修改。请重新测量并确认；也可使用高级坐标入口。');text('pick-note','选取条件已更新；请重新测量，或在高级入口核对手填坐标。');$('proposal-summary').classList.remove('error');updateControls();
}
function poseMatrix(){const p=currentParentSourceResult(selectedPoseId)?.poseProof,m=p?.sourceToPrintMatrix4;return p?.rigidTransformVerified===true&&Array.isArray(m)&&m.length===16&&m.every(Number.isFinite)?new THREE.Matrix4().set(...m):null;}
function selectionBounds(){return proposal?.spec?.allowedBoundsMm??featureById($('feature-select').value)?.boundsMm;}
function focusTarget(){
 const bounds=selectionBounds(),matrix=poseMatrix(),view=views.original;
 if(!matrix||!view.mesh||!Array.isArray(bounds)||bounds.length!==2)return;
 const box=new THREE.Box3(new THREE.Vector3(...bounds[0]),new THREE.Vector3(...bounds[1])).applyMatrix4(matrix),center=box.getCenter(new THREE.Vector3()),radius=Math.max(box.getSize(new THREE.Vector3()).length()*.7,1);
 view.controls.target.copy(center);view.camera.position.set(center.x+radius*1.35,center.y-radius*1.7,center.z+radius*1.2);view.camera.near=Math.max(radius/1000,.005);view.camera.far=Math.max(radius*50,100);view.camera.updateProjectionMatrix();view.controls.update();
}
function drawSelection(){
 clearSelectionOverlay();const matrix=poseMatrix();if(!matrix||!proposal)return;
 const group=new THREE.Group(),spec=proposal.spec,box=new THREE.Box3(new THREE.Vector3(...spec.allowedBoundsMm[0]),new THREE.Vector3(...spec.allowedBoundsMm[1]));
 group.add(new THREE.Box3Helper(box,'#b5893c'));
 const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(spec.centerLineMm.map(p=>new THREE.Vector3(...p))),new THREE.LineBasicMaterial({color:'#be6541',depthTest:false}));line.renderOrder=5;group.add(line);
 group.applyMatrix4(matrix);views.original.scene.add(group);selectionOverlay=group;
}
function proposalReason(code){return ({REPAIR_PICK_OUTSIDE_FEATURE:'点击点不在所选申报特征中。请聚焦特征后重选。',ROD_TARGET_NOT_CIRCULAR:'截面不符合直圆杆，请选杆中部并检查源轴方向。',ROD_TARGET_NOT_STRAIGHT_CIRCULAR:'完整段不符合直圆杆，无法给出可靠建议。',ROD_TARGET_CLICK_OFF_SURFACE:'点击点没有匹配杆表面，请重新选取。',ROD_TARGET_CAP_OR_BOUNDARY:'请点杆中部，端面或边界不能作为可靠选取点。',ROD_INSPECTION_FAILED:'完整杆段或周围增长空间未通过检查。可用高级入口复核，不能自动猜测。',ROD_TARGET_TOO_MANY_AXIS_EVENTS:'几何分段过多，超出只读测量范围。',REPAIR_PROPOSAL_TIMEOUT:'测量超时，当前几何未获得可靠建议。',REPAIR_PROPOSAL_BUSY:'工具正在测量另一个目标，请稍后重试。'})[code]||`测量未通过：${safe(code)}`;}
async function fitPickedTarget(point){
 if(currentJob||fitting||!parentTask||!featureById($('feature-select').value))return;
 const axis=$('axis').value,growth=finite($('max-growth').value),volume=finite($('max-volume').value);
 if(!axes.includes(axis)||growth===null||growth<=0||growth>1||volume===null||volume<=0||volume>10000){text('pick-note','先选择源轴方向，并输入有效的增长与体积预算。');return;}
 invalidateProposal({clearFields:true});const version=proposalVersion,source=currentParentSourceResult(selectedPoseId),parentId=parentTask.id,poseId=selectedPoseId,featureId=$('feature-select').value;
 fitting=true;setPicking(false);updateControls();text('proposal-summary','正在对已验证的源网格做截面测量…');text('pick-note','正在拟合；不会修改模型或调用 LLM。');
 try{
  const result=await request('/api/repair/target-proposal',{method:'POST',body:JSON.stringify({parentPoseJobId:parentId,parentPoseId:poseId,targetFeatureId:featureId,pointInPrintMm:point,axis,maxRadialGrowthMm:growth,maxAddedVolumeMm3:volume})});
  if(version!==proposalVersion)return;
  if(result?.sourceSha256!==source?.poseProof?.sourceSha256||result?.poseCandidateSha256!==source?.poseProof?.candidateSha256||result?.inspection?.verified!==true||result?.spec?.axis!==axis||result.spec.maxRadialGrowthMm!==growth||result.spec.maxAddedVolumeMm3!==volume)throw new Error('REPAIR_PROPOSAL_INVALID');
  proposal=result;const spec=result.spec;
  for(const [selector,values] of [['#line-fields input',spec.centerLineMm.flat()],['#bounds-fields input',spec.allowedBoundsMm.flat()]])document.querySelectorAll(selector).forEach((el,i)=>el.value=String(values[i]));
  if(!readSpec().value)throw new Error('REPAIR_PROPOSAL_INVALID');
  $('coordinates-confirmed').checked=false;
  const a=axes.indexOf(axis),length=spec.centerLineMm[1][a]-spec.centerLineMm[0][a];
  text('proposal-summary',`实测直径 ${fmt(result.inspection.measuredRadiusMm*2,' mm')} · 完整杆段 ${fmt(length,' mm')} · 源 ${axis.toUpperCase()} 轴。橙色框为允许修改范围，轴线标出完整杆段。请确认预算与范围；此结果仅为几何建议。`);
  text('pick-note','拟合完成。可以旋转检查高亮范围，确认后启动 AGH。');drawSelection();
 }catch(error){if(version===proposalVersion){proposal=null;clearSelectionOverlay();document.querySelectorAll('#line-fields input,#bounds-fields input').forEach(el=>el.value='');text('proposal-summary',proposalReason(error.message));$('proposal-summary').classList.add('error');text('pick-note','没有可靠建议，未启动修正。');}}
 finally{if(version===proposalVersion){fitting=false;updateControls();}}
}
function setupPicking(){
 const canvas=$('original-canvas');
 $('pick-target').addEventListener('click',()=>{setPicking(!picking);text('pick-note',picking?'请点原始模型的杆中部；选取期间暂停视角旋转。':'已退出选取，可以旋转视角。');});
 $('focus-target').addEventListener('click',focusTarget);
 canvas.addEventListener('pointerdown',event=>{pointerStart=picking&&event.isPrimary?{x:event.clientX,y:event.clientY,id:event.pointerId}:null;});
 canvas.addEventListener('pointerup',event=>{
  const start=pointerStart;pointerStart=null;if(!picking||!start||start.id!==event.pointerId||Math.hypot(event.clientX-start.x,event.clientY-start.y)>6||!views.original.mesh)return;
  const rect=canvas.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),views.original.camera);
  const hit=ray.intersectObject(views.original.mesh,false)[0];if(!hit){text('pick-note','没有点到模型表面，请重选。');return;}void fitPickedTarget(hit.point.toArray());
 });
 canvas.addEventListener('pointercancel',()=>{pointerStart=null;});
}

function text(id, value) { $(id).textContent = value == null ? '' : String(value); }
function finite(value) { if (value === null || value === undefined || String(value).trim() === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function fmt(value, suffix = '') { const n = finite(value); return n === null ? '—' : `${Number(n.toFixed(3)).toLocaleString('zh-CN')}${suffix}`; }
function safe(value, max = 400) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[本地路径]')
    .replace(/(?:\/home\/|\/Users\/|\/tmp\/|\/private\/|\\\\)[^\s"']+/g, '[本地路径]').slice(0, max);
}
function clear(node) { node.replaceChildren(); }
function addFact(dl, label, value) { if (value === null || value === undefined || value === '') return; const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = safe(value); row.append(dt, dd); dl.append(row); }
function setNote(message, isError = false) { text('start-note', message); $('start-note').classList.toggle('error', isError); }
function setStatus(message, ready = false) { text('engine-status', message); $('engine-dot').classList.toggle('ready', ready); }
function setPill(id, value, tone = '') { const el = $(id); el.textContent = value; el.className = `mode-pill${tone ? ` ${tone}` : ''}`; }
async function request(path, options) {
  const response = await fetch(path, { ...options, headers: { ...(options?.body ? { 'content-type':'application/json' } : {}), ...(options?.headers || {}) } });
  let body = null; try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(safe(body?.error?.message || body?.error || body?.message || `服务返回 HTTP ${response.status}`));
  return body;
}
function onlyUuid(value) { return typeof value === 'string' && uuid.test(value); }
function sameOriginStl(path) {
  if (typeof path !== 'string' || !path) return null;
  try { const url = new URL(path, location.origin); return url.origin === location.origin && url.pathname.startsWith('/api/repair/') ? `${url.pathname}${url.search}` : null; } catch { return null; }
}
function poseName(id) { return ({ upright:'直立', 'tilt-x-plus':'绕 X 轴 +30°', 'tilt-x-minus':'绕 X 轴 −30°', 'tilt-y-plus':'绕 Y 轴 +30°' })[id] || safe(id, 80) || '未知姿态'; }
function metric(object, candidates) { for (const key of candidates) if (object?.[key] !== undefined && object[key] !== null) return object[key]; return null; }

function setupView(key, canvasId, stage, resetId) {
  const canvas = $(canvasId), scene = new THREE.Scene(); scene.background = new THREE.Color('#fafcfb');
  const camera = new THREE.PerspectiveCamera(38, 1, .05, 3000); camera.up.set(0,0,1);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias:true }); renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene.add(new THREE.HemisphereLight('#fff','#dce6e2',2.1)); const keyLight = new THREE.DirectionalLight('#fff',2.5); keyLight.position.set(-100,-80,140); scene.add(keyLight); const fill = new THREE.DirectionalLight('#a1d4c7',1); fill.position.set(90,60,55); scene.add(fill);
  const grid = new THREE.GridHelper(220,22,'#d7e3df','#e8efec'); grid.rotation.x = Math.PI/2; grid.position.z = -.12; scene.add(grid);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = .08;
  const resize = () => { const w = Math.max(stage.clientWidth,1), h = Math.max(stage.clientHeight,1); renderer.setSize(w,h,false); camera.aspect = w/h; camera.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(stage); resize();
  const animate = () => { requestAnimationFrame(animate); controls.update(); renderer.render(scene,camera); }; animate();
  views[key] = { scene,camera,renderer,controls,mesh:null,version:0,resetId,url:null,loadedUrl:null };
  $(resetId).addEventListener('click', () => fitView(key));
}
function fitView(key) {
  const view = views[key]; if (!view?.mesh) return;
  const box = new THREE.Box3().setFromObject(view.mesh), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()), radius = Math.max(size.length()*.75,12);
  view.controls.target.copy(center); view.camera.position.set(center.x+radius*1.35,center.y-radius*1.7,center.z+radius*1.2); view.camera.near = Math.max(radius/1000,.05); view.camera.far = radius*30; view.camera.updateProjectionMatrix(); view.controls.update();
}
function clearView(key, msg) {
  const view = views[key]; view.version++;
  if (view.mesh) { view.scene.remove(view.mesh); view.mesh.geometry.dispose(); view.mesh.material.dispose(); view.mesh = null; }
  const isOriginal = key === 'original'; $(isOriginal ? 'original-message' : 'candidate-message').hidden = false;
  view.url = null;view.loadedUrl=null;
  $(isOriginal ? 'original-status' : 'candidate-status').textContent = msg;
  $(view.resetId).disabled = true;
}
function loadStl(key, stlPath, messageId, statusId) {
  const view = views[key], safeUrl = sameOriginStl(stlPath);
  if (!safeUrl) { clearView(key,'尚无可安全加载的网格'); return; }
  if (view.url === safeUrl) return;
  view.url = safeUrl;view.loadedUrl=null; const version = ++view.version;updateControls();
  new STLLoader().load(safeUrl, geometry => {
    if (version !== view.version) { geometry.dispose(); return; }
    geometry.computeVertexNormals(); const mesh = new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({ color:key === 'original' ? '#93aaa3' : '#4b9a82', metalness:.04, roughness:.74 }));
    if (view.mesh) { view.scene.remove(view.mesh); view.mesh.geometry.dispose(); view.mesh.material.dispose(); }
    view.mesh = mesh;view.loadedUrl=safeUrl; view.scene.add(mesh); $(messageId).hidden = true; text(statusId,'STL 已加载'); $(view.resetId).disabled = false; fitView(key); if(currentJob) updateFocusControl(currentJob);updateControls();
  }, undefined, () => { if (version === view.version) { clearView(key,'STL 读取失败'); view.url=safeUrl; text(statusId,'网格无法预览'); } });
}

function initCoordinateFields() {
  const line = $('line-fields'), bounds = $('bounds-fields');
  for (const [point, target] of [['端点 A',line],['端点 B',line]]) for (const axis of axes) {
    const label = document.createElement('label'), input = document.createElement('input'); label.append(`${point} · ${axis.toUpperCase()}`); input.type='number'; input.step='any'; input.dataset.point = point.endsWith('A') ? '0' : '1'; input.dataset.axis=axis; input.placeholder='mm'; input.setAttribute('aria-label',`${point} ${axis.toUpperCase()} 坐标 mm`); label.append(input); target.append(label);
  }
  for (const edge of ['最小','最大']) for (const axis of axes) {
    const label = document.createElement('label'), input = document.createElement('input'); label.append(`${axis.toUpperCase()} ${edge}`); input.type='number'; input.step='any'; input.dataset.edge=edge==='最小'?'0':'1'; input.dataset.axis=axis; input.placeholder='mm'; input.setAttribute('aria-label',`${axis.toUpperCase()} ${edge}坐标 mm`); label.append(input); bounds.append(label);
  }
}
function inputValues(selector, dataKeys, length) {
  const values = Array.from(document.querySelectorAll(selector)); if (values.length !== length) return null;
  const out = Array(length).fill(null);
  for (const input of values) { const n=finite(input.value), row=Number(input.dataset[dataKeys[0]]), axis=axes.indexOf(input.dataset[dataKeys[1]]); if (n===null || !Number.isInteger(row) || row<0 || row>1 || axis<0) return null; out[row*3+axis]=n; }
  return out.some(v=>v===null) ? null : out;
}
function readSpec() {
  const axis = $('axis').value, line = inputValues('#line-fields input',['point','axis'],6), bounds = inputValues('#bounds-fields input',['edge','axis'],6), growth=finite($('max-growth').value), volume=finite($('max-volume').value);
  if (!axes.includes(axis)) return { error:'请选择杆轴方向。' };
  if (!line || !bounds) return { error:'请填写中心线两端和局部边界的全部 12 个有限坐标。' };
  const centerLineMm=[line.slice(0,3),line.slice(3,6)], allowedBoundsMm=[bounds.slice(0,3),bounds.slice(3,6)];
  if (centerLineMm[0].every((v,i)=>v===centerLineMm[1][i])) return {error:'中心线两端不能重合。'};
  if (allowedBoundsMm[0].some((v,i)=>v>=allowedBoundsMm[1][i])) return {error:'每个边界的最小值都必须小于最大值。'};
  if (centerLineMm.some(point=>point.some((v,i)=>v<allowedBoundsMm[0][i] || v>allowedBoundsMm[1][i]))) return {error:'中心线端点必须位于填写的局部修改边界内。'};
  if (growth===null || growth<=0 || volume===null || volume<=0) return {error:'最大径向增长和最大新增体积必须是大于 0 的有限数值。'};
  const axisIndex=axes.indexOf(axis); if (centerLineMm[1][axisIndex]-centerLineMm[0][axisIndex]<.1||centerLineMm[0].some((v,i)=>i!==axisIndex&&v!==centerLineMm[1][i])) return {error:'中心线必须沿所选源轴，按最小到最大排列，两端其他坐标相同。'};
  return {value:{axis,centerLineMm,allowedBoundsMm,maxRadialGrowthMm:growth,maxAddedVolumeMm3:volume}};
}
function featureKind(feature) { return String(feature?.kind ?? feature?.type ?? feature?.featureType ?? '').toLowerCase(); }
function featureKey(feature) { return feature?.featureId ?? feature?.id ?? feature?.key ?? ''; }
function isSolid(feature) { const kind=featureKind(feature); return ['solid','solid-surface','solid-feature','实体','实体表面保留'].includes(kind); }
function featuresForPose(poseId) {
  const result=parentTask?.results?.find(item=>item?.poseId===poseId); if (!result) return [];
  const features=Array.isArray(parentTask.criticalFeatures)?parentTask.criticalFeatures:[];
  const audit=result.featureAudit, rows=Array.isArray(audit?.features)?audit.features:[];
  return features.filter(feature=>{
    const id=String(featureKey(feature)); if (!id || !featureIdPattern.test(id) || !isSolid(feature)) return false;
    const item=rows.find(row=>String(row?.id ?? row?.featureId ?? '')===id);
    return audit?.verified===true && item?.verified===true && item?.passed===false;
  });
}
function importedSource(source) { const kind=String(typeof source==='string'?source:source?.kind ?? source?.sourceKind ?? source?.type ?? '').toLowerCase(); return kind==='imported' || kind==='imported-stl' || kind==='imported-glb'; }
function rebuildFeatureOptions() {
  eligibleFeatures=featuresForPose(selectedPoseId); const select=$('feature-select'); clear(select); const first=document.createElement('option'); first.value=''; first.textContent=eligibleFeatures.length?'选择未通过的实体特征':'此姿态没有可修正的失败实体特征'; select.append(first);
  for (const feature of eligibleFeatures) { const option=document.createElement('option'); option.value=String(featureKey(feature)); option.textContent=safe(feature.label ?? feature.name ?? featureKey(feature),100); select.append(option); }
  select.disabled=!eligibleFeatures.length; $('sample-wrap').hidden=!(importedSource(parentTask?.source ?? parentTask?.sourceKind) && eligibleFeatures.some(f=>featureKey(f)==='pin-shaft'));
  if (select.options.length>1 && select.value==='' && eligibleFeatures.length===1) select.value=String(featureKey(eligibleFeatures[0]));
  updateControls();
}
function featureById(id) { return eligibleFeatures.find(feature=>String(featureKey(feature))===id) || null; }
function updateControls() {
  const parsed=readSpec(), ready=statusReady && !currentJob && parentTask && onlyUuid(parentTask.id) && poseIdPattern.test(selectedPoseId||'') && !!featureById($('feature-select').value) && !!parsed.value && $('coordinates-confirmed').checked && !starting && !loadingParent && !$('feature-select').disabled;
  $('start-job').disabled=!ready||fitting;
  $('coordinates-confirmed').disabled=fitting||!!currentJob||starting;
  for(const id of ['axis','max-growth','max-volume','parent-id','load-parent','sample-values'])$(id).disabled=!!currentJob||starting;
  document.querySelectorAll('#line-fields input,#bounds-fields input').forEach(el=>el.disabled=!!currentJob||starting);
  if(currentJob){$('pose-select').disabled=true;$('feature-select').disabled=true;}
  const pickReady=!currentJob&&!loadingParent&&!starting&&!fitting&&!!parentTask&&!!featureById($('feature-select').value)&&!!views.original?.mesh&&views.original.loadedUrl===sameOriginStl(currentParentSourceResult(selectedPoseId)?.stlUrl)&&!!poseMatrix();
  $('pick-target').disabled=!pickReady;$('focus-target').disabled=!pickReady;
}
function currentParentSourceResult(poseId) { return parentTask?.results?.find(item=>item?.poseId===poseId) || null; }
function renderParent() {
  clearView('original','等待父任务'); clear($('job-facts')); clear($('delivery-facts')); clear($('candidate-list'));
  const select=$('pose-select'); clear(select); const initial=document.createElement('option'); initial.value=''; initial.textContent='选择源姿态'; select.append(initial);
  const results=Array.isArray(parentTask?.results)?parentTask.results:[];
  for (const result of results) { if (!poseIdPattern.test(result?.poseId||'')) continue; const option=document.createElement('option'); option.value=result.poseId; option.textContent=poseName(result.poseId); select.append(option); }
  select.disabled=results.length===0;
  if (results.some(r=>r?.poseId==='upright')) select.value='upright'; else if (results.length===1) select.value=results[0].poseId;
  selectedPoseId=select.value || null;
  const demo=parentTask.featureSource==='demonstration-coordinate-bounds';
  text('parent-note',results.length?`已读取源任务。${demo?'特征坐标来自演示范围，未经人工确认。':''}请选择需要检查的姿态和审计未通过的实体特征。`:'父任务未包含可用姿态结果。');
  setPill('source-state','姿态源'); text('job-stage','父任务已读取');
  const facts=$('job-facts'); addFact(facts,'父任务',parentTask.id); addFact(facts,'来源类型',importedSource(parentTask.source)?'导入网格':'重建/其他来源'); addFact(facts,'结果数',results.length);
  rebuildFeatureOptions(); showParentModel();
}
function showParentModel() { const result=currentParentSourceResult(selectedPoseId); if (!result) { clearView('original','等待源姿态'); return; } loadStl('original',result.stlUrl,'original-message','original-status'); }
async function loadParent(id) {
  if (!onlyUuid(id)) { setNote('请输入有效的父姿态任务 UUID。',true); return; }
  const loadVersion=++parentLoadVersion;invalidateProposal({clearFields:true});loadingParent=true; updateControls(); setNote('正在读取已完成的父任务…');
  try { const data=await request(`/api/repair/parent/${encodeURIComponent(id)}`);if(loadVersion!==parentLoadVersion)return; if (!data || data.id!==id || !Array.isArray(data.results)) throw new Error('父任务响应缺少有效的任务编号或姿态结果。'); parentTask=data; renderParent(); setNote('父任务已加载；选择源轴方向与预算，在原始模型上选取细杆，查看建议后确认。'); }
  catch(error) { if(loadVersion!==parentLoadVersion)return;parentTask=null; selectedPoseId=null; eligibleFeatures=[]; $('pose-select').disabled=true; $('feature-select').disabled=true;clearView('original','父任务读取失败'); setNote(`父任务读取失败：${safe(error.message)}`,true); }
  finally { if(loadVersion===parentLoadVersion){loadingParent=false; updateControls();} }
}
function setSample() {
  if (!importedSource(parentTask?.source) || $('feature-select').value!=='pin-shaft') return;
  invalidateProposal();$('axis').value='z';
  const line=Array.from(document.querySelectorAll('#line-fields input'));
  const values=[5,0,3,5,0,5]; line.forEach((input,i)=>input.value=String(values[i]));
  const bounds=Array.from(document.querySelectorAll('#bounds-fields input'));
  const b=[4.5,-.5,3,5.5,.5,5]; bounds.forEach((input,i)=>input.value=String(b[i]));
  $('max-growth').value='0.2'; $('max-volume').value='2'; $('coordinates-confirmed').checked=false;
  setNote('已载入受控样例坐标。请对照源模型逐项确认后再勾选确认框。'); updateControls();
}

function auditPassed(audit) { return audit?.verified===true && audit?.passed===true ? true : audit?.verified===true && audit?.passed===false ? false : null; }
function auditFeaturesPass(audit) { return Array.isArray(audit?.features) && audit.features.length>0 && audit.features.every(feature=>feature?.verified===true && feature?.passed===true); }
function overallAuditsPass(audits) { return Array.isArray(audits) && audits.length>=2 && audits.every(a=>auditPassed(a)===true && auditFeaturesPass(a)); }
function geometryBudgetPass(proof) { const checks=proof?.budgetChecks; return proof?.verified===true && checks && typeof checks==='object' && Object.keys(checks).length>0 && Object.values(checks).every(value=>value===true); }
function geometryProofComplete(proof) { return geometryBudgetPass(proof) && proof?.candidateTopology?.watertight===true && proof?.candidateTopology?.windingConsistent===true && proof?.globalBoundsUnchanged===true && finite(proof?.removedVolumeMm3)===0; }
function continuityAuditState(audit) { return audit?.verified===true && audit?.passed===true ? 'pass' : audit?.verified===true && audit?.passed===false ? 'fail' : 'unknown'; }
function candidateSafe(candidate) { return candidate?.geometryProofSafe===true && geometryProofComplete(candidate?.geometryProof) && candidate?.feasible===true && overallAuditsPass(candidate?.featureAudits) && continuityAuditState(candidate?.continuityAudit)==='pass'; }
function deliveryUrlFor(job,candidate) {
  if (!onlyUuid(job?.id) || !/^r0[1-3]$/.test(candidate?.candidateId||'') || !sha256Pattern.test(candidate?.candidateSha256||'')) return null;
  const safeUrl=sameOriginStl(candidate?.deliveryUrl); if (!safeUrl) return null;
  try {
    const url=new URL(safeUrl,location.origin), expectedPath=`/api/repair/jobs/${job.id}/delivery/${candidate.candidateId}`;
    const hashes=url.searchParams.getAll('sha');
    return url.pathname===expectedPath && hashes.length===1 && url.searchParams.size===1 && hashes[0].toLowerCase()===candidate.candidateSha256.toLowerCase() ? safeUrl : null;
  } catch { return null; }
}
function renderAudit(title, audit, declarations=[]) {
  const box=document.createElement('div'); box.className='audit'; const head=document.createElement('strong'); head.textContent=title; box.append(head);
  if (!audit || !Array.isArray(audit.features)) { const p=document.createElement('p'); p.textContent='特征审计未知'; box.append(p); return box; }
  const overall=auditPassed(audit), badge=document.createElement('span'); badge.className=`state ${overall===true?'pass':overall===false?'fail':'unknown'}`; badge.textContent=overall===true?'审计通过':overall===false?'审计未通过':'审计未验证'; box.append(badge);
  for (const feature of audit.features) {
    const p=document.createElement('p'), state=auditPassed(feature), featureBadge=document.createElement('span'); featureBadge.className=`state ${state===true?'pass':state===false?'fail':'unknown'}`; featureBadge.textContent=state===true?'通过':state===false?'未通过':'未知';
    const id=String(feature.id ?? feature.featureId ?? '特征'), declaration=declarations.find(item=>item?.id===id), kind=feature.kind ?? declaration?.kind;
    p.append(featureBadge,document.createTextNode(` ${safe(id,80)} · 保留率 ${fmt(finite(feature.retentionFraction)===null?null:Number(feature.retentionFraction)*100,'%')}`));
    if (kind==='void-channel') p.append(document.createTextNode(` · 孔道${feature.connected===true?'连通':feature.connected===false?'不连通':'连通性未知'}`));
    const directions=Array.isArray(feature.directionRetentions)?feature.directionRetentions:[];
    const validDirections=directions.map(d=>({name:d?.direction,retention:finite(d?.retentionFraction)})).filter(d=>typeof d.name==='string'&&d.retention!==null);
    if (validDirections.length) { const worst=validDirections.reduce((a,b)=>b.retention<a.retention?b:a); p.append(document.createTextNode(` · 最差方向 ${safe(worst.name,16)} ${fmt(worst.retention*100,'%')}`)); }
    else if (kind==='solid') p.append(document.createTextNode(' · 方向保留率未知'));
    box.append(p);
  }
  return box;
}
function eligibleForDelivery(job,candidate) {
  const recheck=job?.recheck, same=!!candidate && !!job?.submittedCandidateId && job.submittedCandidateId===candidate.candidateId && job.selectedCandidateId===candidate.candidateId;
  return job?.stage==='completed' && candidateSafe(candidate) && continuityAuditState(recheck?.continuityAudit)==='pass' && same && recheck?.verified===true && recheck.candidateId===candidate.candidateId && sha256Pattern.test(candidate?.candidateSha256||'') && recheck.candidateSha256===candidate.candidateSha256 && !!deliveryUrlFor(job,candidate);
}
function continuityCodeReason(code) {
  return ({
    ROD_TOOLPATH_DISCONNECTED:'模型挤出路径在申报中心线上留有空段；支撑路径不算作杆材覆盖。',
    ROD_CONTINUITY_RESOURCE_LIMIT:'切片路径超出连续性审计资源上限，无法确认覆盖。',
    ROD_CONTINUITY_PLACEMENT_UNVERIFIED:'切片摆放坐标未验证，无法把刀轨对应到模型中心线。',
    ROD_CONTINUITY_LINE_INVALID:'申报中心线无效，无法审计覆盖。',
    ROD_CONTINUITY_UNSUPPORTED_ARCS:'刀轨包含当前审计器不支持的圆弧指令，无法确认覆盖。',
    ROD_CONTINUITY_ROLE_UNVERIFIED:'挤出路径角色未验证，无法区分模型材料与支撑材料。',
    ROD_CONTINUITY_COORDINATES_UNVERIFIED:'部分模型挤出路径缺少有效坐标，无法确认覆盖。',
    ROD_CONTINUITY_WIDTH_HEIGHT_UNVERIFIED:'部分模型挤出路径缺少有效线宽或层高，无法确认覆盖。',
    ROD_CONTINUITY_NON_PLANAR:'检测到非平面挤出路径，当前连续性审计无法确认覆盖。',
  })[code] || (code && code!=='PASS' ? `连续性审计未通过（${safe(code,100)}）。` : '连续性审计结果不完整，尚不能确认覆盖。');
}
function linePointAt(line,t) {
  if (!Array.isArray(line)||line.length!==2||line.some(point=>!Array.isArray(point)||point.length!==3||point.some(value=>finite(value)===null))) return null;
  return line[0].map((value,index)=>Number(value)+(Number(line[1][index])-Number(value))*t);
}
function renderContinuity(candidate,spec) {
  const audit=candidate?.continuityAudit, state=continuityAuditState(audit), box=document.createElement('div'); box.className='proof-lines';
  const heading=document.createElement('strong'); heading.textContent='软件刀轨包络 · 中心线连续性'; box.append(heading);
  const coverage=finite(audit?.coverageFraction), validCoverage=state!=='unknown'&&coverage!==null&&coverage>=0&&coverage<=1;
  const gap=finite(audit?.maxGapMm), validGap=state!=='unknown'&&gap!==null&&gap>=0;
  const summary=document.createElement('p');
  if (state==='unknown') summary.textContent='中心线连续覆盖：尚未复核连续性；旧任务记录或不完整审计不能作为通过证据。';
  else summary.textContent=`中心线连续覆盖：${validCoverage?fmt(coverage*100,'%'):'数值无效'} · ${state==='pass'?'连续覆盖通过':state==='fail'?'存在未覆盖断段':'结果不完整'}${validGap?` · 最大断段 ${fmt(gap,' mm')}`:''}`;
  box.append(summary);
  if (state==='fail') {
    const reason=document.createElement('p'); reason.textContent=continuityCodeReason(audit?.code); box.append(reason);
    const gaps=Array.isArray(audit?.gaps)?audit.gaps:[], line=spec?.centerLineMm, shown=[];
    for (const item of gaps) {
      const from=finite(item?.fromT),to=finite(item?.toT),length=finite(item?.lengthMm);
      if(from===null||to===null||length===null||from<0||to>1||to<=from||length<0)continue;
      const start=linePointAt(line,from),end=linePointAt(line,to);
      shown.push(start&&end?`${start.map(v=>fmt(v)).join(', ')} → ${end.map(v=>fmt(v)).join(', ')} mm（${fmt(length,' mm')}）`:`中心线 ${fmt(from*100,'%')}–${fmt(to*100,'%')}（${fmt(length,' mm')}）`);
    }
    if(shown.length){const detail=document.createElement('p');detail.textContent=`未覆盖区间：${shown.slice(0,3).join('；')}${shown.length>3?`；另有 ${shown.length-3} 段`:''}`;box.append(detail);}
  }
  const scope=document.createElement('p'); scope.textContent='这是软件切片刀轨包络对申报中心线的连续性检查，不代表实物打印、材料强度或安装成功。'; box.append(scope);
  return box;
}
async function responseError(response) {
  let message=`服务返回 HTTP ${response.status}`;
  try { const body=await response.json(),detail=body?.error?.message??(typeof body?.error==='string'?body.error:body?.message); if(typeof detail==='string'||typeof detail==='number')message=detail; } catch {}
  return safe(message)||`服务返回 HTTP ${response.status}`;
}
async function downloadDelivery(job,candidate,button) {
  const errorBox=$('job-error'),url=eligibleForDelivery(job,candidate)?deliveryUrlFor(job,candidate):null;
  if(!url){errorBox.hidden=false;errorBox.textContent='正式交付链接、连续性复检或 SHA 校验无效，未启动下载。';return;}
  errorBox.hidden=true;errorBox.textContent='';button.disabled=true;button.textContent='正在复核并下载…';
  try {
    const response=await fetch(url,{headers:{accept:'application/octet-stream, application/sla'}});
    if(!response.ok)throw new Error(await responseError(response));
    if(!globalThis.crypto?.subtle)throw new Error('此浏览器不支持本地 SHA-256 校验，未下载文件。');
    const bytes=await response.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes),actual=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
    if(actual.toLowerCase()!==candidate.candidateSha256.toLowerCase())throw new Error('下载文件 SHA-256 与已复检候选不一致。');
    const blobUrl=URL.createObjectURL(new Blob([bytes],{type:response.headers.get('content-type')||'application/octet-stream'})),link=document.createElement('a');
    link.href=blobUrl;link.download=`repair-${job.id}-${candidate.candidateId}.stl`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(blobUrl),1000);
  } catch(error) { errorBox.hidden=false;errorBox.textContent=`交付下载失败：${safe(error.message)}`; }
  finally { button.disabled=!eligibleForDelivery(job,candidate);button.textContent='下载已交付 STL'; }
}
function setToolpath(imgId,noteId,jobId,candidateId,evaluated) {
  const img=$(imgId), note=$(noteId);
  if (!onlyUuid(jobId) || !evaluated || !(candidateId==='original'||/^r0[1-3]$/.test(candidateId||''))) { img.hidden=true; img.removeAttribute('src'); img.dataset.loadedUrl=''; note.textContent='尚无已评价刀轨'; note.classList.remove('error'); return; }
  const url=sameOriginStl(`/api/repair/jobs/${encodeURIComponent(jobId)}/toolpath/${candidateId}`);
  if (!url) { img.hidden=true; note.textContent='局部路径投影不可用'; note.classList.add('error'); return; }
  if (img.dataset.loadedUrl===url) return;
  img.dataset.loadedUrl=url; img.hidden=false; note.textContent='正在读取本任务切片路径…'; note.classList.remove('error');
  img.onerror=()=>{img.hidden=true;note.textContent='局部路径投影不可用';note.classList.add('error');};
  img.onload=()=>{note.textContent='本任务实际切片路径';note.classList.remove('error');};
  img.src=url;
}
function featureFocusBounds(job) { return job?.spec?.allowedBoundsMm; }
function updateFocusControl(job,selected) {
  const upright=job?.parent?.poseId==='upright', bounds=featureFocusBounds(job), valid=Array.isArray(bounds)&&bounds.length===2&&bounds.every(row=>Array.isArray(row)&&row.length===3&&row.every(v=>finite(v)!==null))&&bounds[0].every((v,i)=>Number(v)<Number(bounds[1][i]));
  const button=$('focus-feature'); button.disabled=!upright||!valid||!views.original?.mesh||!views.candidate?.mesh;
  text('focus-note',!upright?'当前为非直立姿态；源坐标没有变换，不能同步聚焦。':!valid?'任务没有有效的局部边界坐标。':button.disabled?'等待前后网格加载后可同步聚焦。':'以同一源坐标范围同步聚焦前后模型。');
  button.onclick=()=>{if(button.disabled)return;const [lo,hi]=bounds.map(row=>row.map(Number)),center=new THREE.Vector3(...lo.map((v,i)=>(v+hi[i])/2)),size=new THREE.Vector3(...lo.map((v,i)=>hi[i]-v)),radius=Math.max(size.length()*1.8,.9);for(const key of ['original','candidate']){const view=views[key];view.controls.target.copy(center);view.camera.position.set(center.x+radius*1.35,center.y-radius*1.7,center.z+radius*1.2);view.camera.near=Math.max(radius/1000,.005);view.camera.far=Math.max(radius*50,10);view.camera.updateProjectionMatrix();view.controls.update();}};
}
function renderJob(job) {
  currentJob=job;setPicking(false); const candidates=Array.isArray(job.candidates)?job.candidates:[];
  if (!candidates.some(c=>c?.candidateId===selectedCandidateId)) selectedCandidateId=job.selectedCandidateId || candidates[0]?.candidateId || null;
  const selected=candidates.find(c=>c?.candidateId===selectedCandidateId) || null;
  text('job-id',safe(job.id,80)||'—'); text('job-stage',labels[job.stage]||safe(job.stage)||'状态未知'); $('job-dot').classList.toggle('active',job.stage==='agent-running'||job.stage==='prepared');
  clear($('candidate-list')); text('candidate-count',candidates.length?`${candidates.length} 个候选`:'尚无候选');
  const original=job.original||{}; if (original.stlUrl) loadStl('original',original.stlUrl,'original-message','original-status');
  else if (parentTask && selectedPoseId) showParentModel();
  if (job.stage==='no-feasible') { const stop=document.createElement('div'); stop.className='no-feasible'; stop.textContent='没有候选满足局部修改预算与特征条件。任务已停止；当前没有可交付模型。'; $('candidate-list').append(stop); }
  if (candidates.length===0 && job.stage!=='no-feasible') { const p=document.createElement('p'); p.className='empty'; p.textContent='候选尚未生成，或服务没有返回候选。'; $('candidate-list').append(p); }
  for (const candidate of candidates) {
    const row=document.createElement('article'); row.className=`candidate-row${candidate.candidateId===selectedCandidateId?' selected':''}`;
    const proof=candidate.geometryProof||{}, checks=proof.budgetChecks, budgetPass=geometryBudgetPass(proof), featurePass=overallAuditsPass(candidate.featureAudits);
    const continuityState=continuityAuditState(candidate.continuityAudit);
    const acceptance=continuityState==='unknown'?'尚未复核连续性':continuityState==='fail'?'中心线连续覆盖未通过':candidate.feasible===true?'全部条件通过':candidate.feasible===false&&budgetPass&&!featurePass?'几何预算通过；特征未通过':candidate.feasible===false&&!budgetPass?'几何预算未通过':candidate.feasible===false?'未满足验收条件':'验收状态未知';
    const head=document.createElement('div'); head.className='candidate-head'; const title=document.createElement('strong'); title.textContent=`候选 ${safe(candidate.candidateId,16)||'编号未知'} · ${acceptance}`; const choose=document.createElement('button'); choose.type='button'; choose.className='candidate-select'; choose.textContent='预览此候选'; choose.disabled=!candidate.stlUrl; choose.addEventListener('click',()=>{selectedCandidateId=candidate.candidateId; renderJob(currentJob);}); head.append(title,choose); row.append(head);
    const topology=proof.candidateTopology; const topoState=topology?.watertight===true&&topology?.windingConsistent===true?'闭合且方向一致':topology?.watertight===false||topology?.windingConsistent===false?'拓扑检查失败':'未验证';
    const metrics=document.createElement('div'); metrics.className='metrics'; const cells=[['修正半径选项',candidate.radiusMm,' mm'],['实际径向增长',proof.radialGrowthMm,' mm'],['新增体积',proof.addedVolumeMm3,' mm³'],['移除体积',proof.removedVolumeMm3,' mm³'],['耗材估算',metric(candidate.metrics,['filamentG']),' g'],['时间估算',metric(candidate.metrics,['estimatedTimeSeconds']),' 秒'],['几何预算',budgetPass?'全部通过':checks&&Object.values(checks).some(v=>v===false)?'未通过':'未验证',''],['几何证据',geometryProofComplete(proof)?'已验证':proof.verified===true?'部分证据':'未验证',''],['原包围盒',proof.globalBoundsUnchanged===true?'未变化':proof.globalBoundsUnchanged===false?'发生变化':'未验证',''],['网格拓扑',topoState,'']];
    for(const [label,value,suffix] of cells){const item=document.createElement('div');item.className='metric';const l=document.createElement('span'),v=document.createElement('strong');l.textContent=label;v.textContent=typeof value==='string'?value:fmt(value,suffix);if(typeof value==='string')v.className=value==='全部通过'||value==='未变化'?'state pass':value==='未通过'||value==='发生变化'?'state fail':'state unknown';item.append(l,v);metrics.append(item);} row.append(metrics,renderContinuity(candidate,job.spec));
    const audits=document.createElement('div'); audits.className='audit-grid'; const declarations=Array.isArray(job.criticalFeatures)?job.criticalFeatures:[]; const originalAudits=Array.isArray(original.featureAudits)?original.featureAudits:[]; const candidateAudits=Array.isArray(candidate.featureAudits)?candidate.featureAudits:[];
    audits.append(renderAudit('原始切片基线',originalAudits[0],declarations),renderAudit('修正切片 · 原特征验收',candidateAudits[0],declarations),renderAudit('修正几何 · 特征验收',candidateAudits[1],declarations)); row.append(audits);
    const reasons=Array.isArray(candidate.reasons)?candidate.reasons:[]; if (reasons.length) { const p=document.createElement('p'); p.className='reasons'; p.textContent=reasons.map(r=>safe(typeof r==='string'?r:r?.message ?? r?.code ?? '未知原因',180)).join('；'); row.append(p); }
    $('candidate-list').append(row);
  }
  if (selected?.stlUrl) loadStl('candidate',selected.stlUrl,'candidate-message','candidate-status'); else clearView('candidate',job.stage==='no-feasible'?'无可行候选':'等待修正候选');
  text('candidate-title',selected?`候选 ${safe(selected.candidateId,16)}`:'修正候选'); text('candidate-meta',selected?`选项半径 ${fmt(selected.radiusMm,' mm')} · 实增 ${fmt(selected.geometryProof?.radialGrowthMm,' mm')}`:'—');
  const originalEvaluated=Array.isArray(original.featureAudits)&&original.featureAudits.length>0;
  setToolpath('original-toolpath','original-toolpath-note',job.id,'original',!!original.stlUrl&&originalEvaluated);
  const selectedEvaluated=!!selected?.stlUrl&&Array.isArray(selected?.featureAudits)&&selected.featureAudits.length>=2;
  setToolpath('candidate-toolpath','candidate-toolpath-note',job.id,selected?.candidateId,selectedEvaluated);
  updateFocusControl(job,selected);
  renderFacts(job,selected); renderEvents(job.events);
  const canDownload=eligibleForDelivery(job,selected),continuityState=continuityAuditState(selected?.continuityAudit),recheckContinuityState=continuityAuditState(job.recheck?.continuityAudit); $('download-stl').disabled=!canDownload; $('download-stl').onclick=()=>downloadDelivery(job,selected,$('download-stl'));
  const deliveryLabel=canDownload?'已复检并交付':job.stage==='no-feasible'?'停止交付':continuityState==='unknown'||recheckContinuityState==='unknown'?'尚未复核连续性':continuityState==='fail'||recheckContinuityState==='fail'?'连续性未通过':'未完成复检';
  setPill('delivery-state',deliveryLabel,canDownload?'agh':job.stage==='no-feasible'||continuityState==='fail'||recheckContinuityState==='fail'?'fail':'');
  updateControls();
}
function renderFacts(job,candidate) {
  const facts=$('job-facts'); clear(facts); addFact(facts,'父姿态任务',job.parent?.jobId); addFact(facts,'源姿态',poseName(job.parent?.poseId)); addFact(facts,'源模型 SHA',job.parent?.sourceSha256); addFact(facts,'来源类型',job.parent?.sourceKind); addFact(facts,'特征坐标来源',job.parent?.featureSource==='demonstration-coordinate-bounds'?'演示坐标 · 未经人工确认':job.parent?.featureSource==='user-submitted-coordinate-bounds'?'用户确认坐标':'未知'); addFact(facts,'目标特征',job.targetFeatureId); addFact(facts,'执行模型',job.execution?.model);
  const spec=$('spec-facts'), budget=job.spec||{}; spec.textContent=`轴向 ${safe(budget.axis||'未知')} · 中心线 ${Array.isArray(budget.centerLineMm)?budget.centerLineMm.map(row=>Array.isArray(row)?row.map(v=>fmt(v)).join(', '):'—').join(' → '):'—'} · 边界 ${Array.isArray(budget.allowedBoundsMm)?budget.allowedBoundsMm.map(row=>Array.isArray(row)?row.map(v=>fmt(v)).join(', '):'—').join(' / '):'—'} · 最大径向增长 ${fmt(budget.maxRadialGrowthMm,' mm')} · 新增体积上限 ${fmt(budget.maxAddedVolumeMm3,' mm³')}`;
  const d=$('delivery-facts'); clear(d); addFact(d,'重检',job.recheck?.verified===true?'已验证':job.recheck?.verified===false?'未通过':'未验证'); addFact(d,'中心线连续性复检',continuityAuditState(job.recheck?.continuityAudit)==='pass'?'通过':continuityAuditState(job.recheck?.continuityAudit)==='fail'?'未通过':'尚未复核连续性'); addFact(d,'重检候选',job.recheck?.candidateId); addFact(d,'已提交候选',job.submittedCandidateId); addFact(d,'当前候选',candidate?.candidateId); addFact(d,'交付资格',eligibleForDelivery(job,candidate)?'符合':'未满足');
  const err=$('job-error'); const message=job.error?.message ?? job.error; err.hidden=!message; err.textContent=message?safe(typeof message==='string'?message:JSON.stringify(message)):'';
}
function renderEvents(events) {
  const container=$('event-list'); clear(container); if (!Array.isArray(events)||!events.length) { const p=document.createElement('p'); p.className='empty'; p.textContent='服务尚未返回执行事件。'; container.append(p); return; }
  for (const event of events) { const row=document.createElement('div'); row.className='event-row'; const when=document.createElement('span'); when.className='event-time'; when.textContent=safe(event?.at ?? event?.timestamp ?? '—',40); const source=document.createElement('span'); source.className=`event-source${event?.source==='agh'?' agh':''}`; source.textContent=safe(event?.source ?? '服务事件',40); const message=document.createElement('span'); message.className='event-message'; const outcome=document.createElement('b'); outcome.className=`state ${event?.success===true?'pass':event?.success===false?'fail':'unknown'}`; outcome.textContent=event?.success===true?'成功':event?.success===false?'失败':'结果未知'; const details=[safe(event?.tool ?? event?.step ?? '执行事件',80),event?.candidateId?safe(event.candidateId,30):'',finite(event?.radiusMm)!==null?`选项半径 ${fmt(event.radiusMm,' mm')}`:'',event?.code?safe(event.code,100):''].filter(Boolean).join(' · '); message.append(outcome,document.createTextNode(` ${details}`)); row.append(when,source,message); container.append(row); }
}
function restoreOriginalForm(job) {
  const spec=job.spec||{}; $('axis').value=axes.includes(spec.axis)?spec.axis:'';
  const line=Array.isArray(spec.centerLineMm)?spec.centerLineMm.flat():[], bounds=Array.isArray(spec.allowedBoundsMm)?spec.allowedBoundsMm.flat():[];
  document.querySelectorAll('#line-fields input').forEach((el,i)=>el.value=finite(line[i])===null?'':String(line[i])); document.querySelectorAll('#bounds-fields input').forEach((el,i)=>el.value=finite(bounds[i])===null?'':String(bounds[i]));
  $('max-growth').value=finite(spec.maxRadialGrowthMm)===null?'':String(spec.maxRadialGrowthMm); $('max-volume').value=finite(spec.maxAddedVolumeMm3)===null?'':String(spec.maxAddedVolumeMm3); $('coordinates-confirmed').checked=false;
  text('proposal-summary','此任务的轴线、范围与预算已锁定，可展开高级入口查看。当前页面只读取结果。');text('pick-note','当前任务只读。新修正请从父姿态任务重新进入。');
  if (onlyUuid(job.parent?.jobId)) { $('parent-id').value=job.parent.jobId; }
  if (featureIdPattern.test(String(job.targetFeatureId||''))) { const select=$('feature-select'); if (![...select.options].some(option=>option.value===job.targetFeatureId)) { const option=document.createElement('option'); option.value=job.targetFeatureId; option.textContent=safe(job.targetFeatureId); select.append(option); } select.value=job.targetFeatureId; }
}
async function loadJob(id) {
  if (!onlyUuid(id)) { setNote('任务链接中的 UUID 无效。',true); return; }
  clearTimeout(pollTimer);
  try { const job=await request(`/api/repair/jobs/${encodeURIComponent(id)}`); if (!job || job.id!==id) throw new Error('任务响应编号不匹配。'); if (job.parent?.jobId && (!parentTask || parentTask.id!==job.parent.jobId)) { await loadParent(job.parent.jobId); if (!parentTask) throw new Error('修正任务的父任务无法读取。'); }
    if (job.parent?.poseId && poseIdPattern.test(job.parent.poseId) && selectedPoseId!==job.parent.poseId) { selectedPoseId=job.parent.poseId; $('pose-select').value=selectedPoseId; rebuildFeatureOptions(); showParentModel(); }
    currentJob=job; restoreOriginalForm(job); selectedCandidateId=job.selectedCandidateId||job.candidates?.[0]?.candidateId||null; renderJob(job); const active=job.agentRunActive===true && !['completed','failed','interrupted','no-feasible'].includes(job.stage); setNote(active?'正在只读跟踪后台修正任务。':'已恢复任务；本次只读取状态，没有重新启动生成。'); if (active) pollTimer=setTimeout(()=>loadJob(id),1800);
  } catch(error) { setNote(`任务读取失败：${safe(error.message)}`,true); }
}
async function beginRepair() {
  const parentId=$('parent-id').value.trim(), featureId=$('feature-select').value, parsed=readSpec();
  if (currentJob) return setNote('此页面已恢复到只读任务；如需新任务，请从父姿态任务重新进入。',true);
  if (!statusReady) return setNote('修正工具当前不可用。',true);
  if (!onlyUuid(parentId) || parentTask?.id!==parentId) return setNote('请先读取与当前输入编号一致的父任务。',true);
  if (!poseIdPattern.test(selectedPoseId||'') || !featureById(featureId)) return setNote('请选择一个审计失败的实体特征。',true);
  if (!parsed.value) return setNote(parsed.error,true);
  if (!$('coordinates-confirmed').checked) return setNote('请先确认所有坐标和修改预算。',true);
  starting=true; updateControls(); $('start-job').textContent='正在创建任务…'; setNote('正在创建受约束的 AGH 修正任务…');
  try { const result=await request('/api/repair/start',{method:'POST',body:JSON.stringify({parentPoseJobId:parentId,parentPoseId:selectedPoseId,targetFeatureId:featureId,spec:parsed.value,coordinatesConfirmed:true})}); if (!result || !onlyUuid(result.id)) throw new Error('服务未返回有效的修正任务编号。'); currentJob={id:result.id,stage:result.stage||'prepared'}; history.replaceState(null,'',`/repair?job=${encodeURIComponent(result.id)}`); await loadJob(result.id); }
  catch(error) { setNote(`无法启动修正：${safe(error.message)}`,true); }
  finally { starting=false; $('start-job').textContent='开始局部修正 →'; updateControls(); }
}
async function init() {
  initCoordinateFields(); setupView('original','original-canvas',$('original-canvas').parentElement,'reset-original'); setupView('candidate','candidate-canvas',$('candidate-canvas').parentElement,'reset-candidate');
  setupPicking();for (const id of ['axis','max-growth','max-volume']) $(id).addEventListener('input',()=>invalidateProposal({clearFields:!!proposal||fitting}));
  document.querySelectorAll('#line-fields input,#bounds-fields input').forEach(el=>el.addEventListener('input',()=>invalidateProposal())); $('coordinates-confirmed').addEventListener('change',updateControls);
  $('load-parent').addEventListener('click',()=>loadParent($('parent-id').value.trim())); $('parent-id').addEventListener('keydown',event=>{if(event.key==='Enter')loadParent($('parent-id').value.trim());});
  $('pose-select').addEventListener('change',()=>{invalidateProposal({clearFields:true});selectedPoseId=$('pose-select').value||null; rebuildFeatureOptions(); showParentModel();}); $('feature-select').addEventListener('change',()=>invalidateProposal({clearFields:true}));$('parent-id').addEventListener('input',()=>{parentLoadVersion++;loadingParent=false;invalidateProposal({clearFields:true});parentTask=null;selectedPoseId=null;eligibleFeatures=[];$('pose-select').disabled=true;$('feature-select').disabled=true;updateControls();}); $('sample-values').addEventListener('click',setSample); $('start-job').addEventListener('click',beginRepair);
  try { const status=await request('/api/repair/status'); statusReady=status?.ready===true && status?.geometryAvailable===true; const model=status?.model?` · ${safe(status.model,100)}`:''; setStatus(statusReady?`局部修正工具就绪${model}`:'修正工具不可用',statusReady); if(!statusReady) setNote('服务未报告 ready 与 geometryAvailable，暂不能启动修正。',true); }
  catch(error) { statusReady=false; setStatus('无法连接局部修正服务'); setNote(`状态读取失败：${safe(error.message)}`,true); }
  const query=new URLSearchParams(location.search), jobId=query.get('job'), parentId=query.get('parent');
  if (jobId) { await loadJob(jobId); return; }
  if (parentId) { $('parent-id').value=parentId; await loadParent(parentId); }
  updateControls();
}
init().catch(error=>{setStatus('页面初始化失败');setNote(safe(error.message),true);});
