import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const exampleSpec = { name: '带孔板', type: 'plate', dimensions: { width: 100, depth: 70, height: 6, wallThickness: 3 }, holes: [{ x: -28, y: 0, diameter: 8 }, { x: 28, y: 0, diameter: 8 }] };
const dimensionDefs = {
  plate: [['width','宽度'],['depth','深度'],['height','板厚']],
  bracket: [['width','宽度'],['depth','底深'],['height','总高'],['wallThickness','板厚']],
  box: [['width','外宽'],['depth','外深'],['height','外高'],['wallThickness','壁厚']]
};
const typeNames = { plate: '带孔板', bracket: 'L 形支架', box: '开口盒' };
let spec = structuredClone(exampleSpec), source = 'example', photoItems = [], modelData = null;
let modelVersion = 0, analysisVersion = 0, toolVersion = 0, measurementVersion = 0, renderVersion = 0, blendVersion = 0, debounceTimer, currentView = 'optimized', analyzeConfigured = false, analysisMode = 'none';
let scene, camera, renderer, controls, activeMesh, baselineMesh, grid;

function setStatus(text, online = false) {
  $('service-status').textContent = text;
  $('service-status').previousElementSibling.classList.toggle('online', online);
}
function safeText(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function initViewer() {
  const stage = $('viewer-stage');
  scene = new THREE.Scene(); scene.background = new THREE.Color('#f9fbfa');
  camera = new THREE.PerspectiveCamera(38, 1, .1, 3000); camera.up.set(0,0,1);
  renderer = new THREE.WebGLRenderer({ canvas: $('model-canvas'), antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  scene.add(new THREE.HemisphereLight('#ffffff','#dce6e2',2.1));
  const key = new THREE.DirectionalLight('#ffffff',3.1); key.position.set(-100,-80,150); key.castShadow = true; scene.add(key);
  const fill = new THREE.DirectionalLight('#a2d9cb',1.25); fill.position.set(100,70,75); scene.add(fill);
  grid = new THREE.GridHelper(600,30,'#d9e4e0','#e9efed'); grid.rotation.x = Math.PI / 2; grid.position.z = -.08; scene.add(grid);
  controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = .08; controls.target.set(0,0,0);
  const resize = () => { const w = Math.max(stage.clientWidth,1), h = Math.max(stage.clientHeight,1); renderer.setSize(w,h,false); camera.aspect = w/h; camera.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(stage); resize();
  $('reset-view').addEventListener('click', fitCamera);
  $('model-canvas').addEventListener('webglcontextlost', e => { e.preventDefault(); showModelError('三维预览上下文暂时不可用，请刷新页面后重试。'); });
  const animate = () => { requestAnimationFrame(animate); controls.update(); renderer.render(scene,camera); };
  animate();
}
function clearMeshes() {
  for (const mesh of [activeMesh, baselineMesh]) if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
  activeMesh = baselineMesh = null;
}
function buildMesh(positions, color, opacity=1) {
  const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.Float32BufferAttribute(positions,3)); geom.computeVertexNormals(); geom.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ color, roughness:.48, metalness:.08, transparent:opacity<1, opacity, side:THREE.DoubleSide, flatShading:false });
  const mesh = new THREE.Mesh(geom,mat); mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
}
function fitCamera() {
  const mesh = currentView === 'baseline' ? baselineMesh : activeMesh;
  if (!mesh) return;
  const box = new THREE.Box3().setFromObject(mesh), center = box.getCenter(new THREE.Vector3()), size=box.getSize(new THREE.Vector3()), radius=Math.max(size.length()*.62,10);
  controls.target.copy(center); camera.position.set(center.x+radius*1.35,center.y-radius*1.8,center.z+radius*1.25); camera.near=Math.max(radius/1000,.1); camera.far=radius*30; camera.updateProjectionMatrix(); controls.update();
  grid.position.z = box.min.z - Math.max(size.z*.02,.08);
}
function updateVisibleMesh() {
  if (!activeMesh || !baselineMesh) return;
  activeMesh.visible = currentView === 'optimized'; baselineMesh.visible = currentView === 'baseline';
  $('triangle-count').textContent = `${Math.floor((currentView === 'optimized' ? activeMesh : baselineMesh).geometry.attributes.position.count/3).toLocaleString('zh-CN')} 个三角面`;
  document.querySelectorAll('[data-view]').forEach(btn => { const selected=btn.dataset.view===currentView; btn.classList.toggle('active',selected); btn.setAttribute('aria-selected',String(selected)); });
}
function showModelError(message) {
  $('viewer-message').hidden=true; $('viewer-error').hidden=false; $('viewer-error').textContent=message;
  $('mesh-state').textContent='模型不可用'; document.querySelector('.mesh-state i').classList.remove('ready'); $('export-stl').disabled=true;
}
function renderModel(data) {
  clearMeshes(); $('viewer-error').hidden=true; $('viewer-message').hidden=true;
  baselineMesh=buildMesh(data.baselineMesh.positions,'#b8c9c4',.67); activeMesh=buildMesh(data.mesh.positions,'#0e8976',1);
  scene.add(baselineMesh,activeMesh); updateVisibleMesh(); fitCamera();
  $('mesh-state').textContent='网格已生成'; document.querySelector('.mesh-state i').classList.add('ready'); $('export-stl').disabled=false;
  $('scale-label').textContent=`${spec.dimensions.width ?? '—'} × ${spec.dimensions.depth ?? '—'} × ${spec.dimensions.height ?? '—'} mm`;
}

function syncDimensions() {
  const wrap=$('dimensions'); wrap.innerHTML='';
  for (const [key,label] of dimensionDefs[spec.type]) {
    const value=spec.dimensions[key] ?? (key==='wallThickness'?3:'');
    const div=document.createElement('div'); div.className='dimension-field'; div.dataset.key=key;
    div.innerHTML=`<label>${label}</label><span class="field-control"><input type="number" min="0.1" max="500" step="any" value="${safeText(value)}" aria-label="${label}"><em>mm</em></span>`;
    const input=div.querySelector('input');
    input.addEventListener('input',()=>{const n=input.value.trim()===''?NaN:Number(input.value); if(Number.isFinite(n)&&n>0){spec.dimensions[key]=n;div.classList.remove('invalid');source='edited';updateSource();scheduleModel();}else{div.classList.add('invalid');invalidateModel('请输入大于 0 的有限尺寸。');}});
    wrap.append(div);
  }
  $('holes-section').hidden=spec.type!=='plate'; syncHoles();
}
function syncHoles() {
  const list=$('hole-list'); list.innerHTML=''; $('hole-empty').hidden=spec.holes.length>0 || spec.type!=='plate';
  spec.holes.forEach((hole,index)=>{
    const row=document.createElement('div'); row.className='hole-row';
    for(const [key,label] of [['x','X'],['y','Y'],['diameter','直径']]){
      const val=hole[key] ?? (key==='diameter'?5:0); const cell=document.createElement('label'); cell.innerHTML=`${label}<input type="number" step="any" value="${safeText(val)}" aria-label="第 ${index+1} 个孔 ${label}">`;
      const input=cell.querySelector('input'); input.addEventListener('input',()=>{const n=input.value.trim()===''?NaN:Number(input.value); if(Number.isFinite(n) && (key!=='diameter'||n>0)){hole[key]=n;input.classList.remove('invalid');source='edited';updateSource();scheduleModel();}else{input.classList.add('invalid');invalidateModel(key==='diameter'?'孔直径必须大于 0。':'孔坐标必须为有限数字。');}}); row.append(cell);
    }
    const remove=document.createElement('button'); remove.className='hole-remove'; remove.type='button'; remove.title='删除此孔'; remove.setAttribute('aria-label',`删除第 ${index+1} 个孔`); remove.textContent='×'; remove.addEventListener('click',()=>{spec.holes.splice(index,1);source='edited';syncHoles();updateSource();scheduleModel();}); row.append(remove); list.append(row);
  });
}
function updateSource() { $('model-source').textContent=source==='example'?'示例参数':source==='analysis'?'分析建议 · 可编辑':source==='import'?'导入参数 · 可编辑':'手动编辑'; $('model-name').textContent=`${spec.name||typeNames[spec.type]} · ${source==='example'?'示例':'编辑中'}`; }
function collectSpec() {
  const candidate=structuredClone(spec); candidate.type=$('model-type').value; candidate.name=candidate.name||typeNames[candidate.type];
  for(const item of $('dimensions').querySelectorAll('.dimension-field')){const input=item.querySelector('input');const n=Number(input.value);if(!input.value.trim()||!Number.isFinite(n)||n<=0) return {error:'所有尺寸都必须是大于 0 的有限数字。'};candidate.dimensions[item.dataset.key]=n;}
  if(candidate.type==='plate') for(const [i,row] of [...$('hole-list').children].entries()){
    const vals=[...row.querySelectorAll('input')].map(inp=>inp.value.trim()===''?NaN:Number(inp.value));
    if(vals.some(v=>!Number.isFinite(v))||vals[2]<=0)return {error:`第 ${i+1} 个孔的坐标或直径无效。`};
    candidate.holes[i]={x:vals[0],y:vals[1],diameter:vals[2]};
  }
  return {spec:candidate};
}
function options() {return {lightweight:$('lightweight').checked,minWall:Number($('min-wall').value),preserveMargin:Number($('preserve-margin').value)};}
function clearMetrics() {
  for(const id of ['optimized-volume','saved-percent','baseline-volume','estimated-mass'])$(id).textContent='—';
  $('checks-list').innerHTML=''; modelData=null; $('export-stl').disabled=true;$('render-views').disabled=true;$('export-blend').disabled=true;
}
function invalidateModel(message) {
  clearTimeout(debounceTimer); modelVersion++; toolVersion++; clearMetrics(); clearMeshes(); $('viewer-error').hidden=true; $('viewer-message').hidden=false;
  $('viewer-message').querySelector('strong').textContent='参数尚未生成模型'; $('viewer-message').querySelector('span:last-child').textContent=message;
  $('mesh-state').textContent='等待有效参数'; document.querySelector('.mesh-state i').classList.remove('ready'); $('triangle-count').textContent='—'; $('parameter-error').textContent=message;
}
function scheduleModel() { modelVersion++; toolVersion++; clearTimeout(debounceTimer); clearMetrics(); clearMeshes(); $('viewer-error').hidden=true; $('viewer-message').hidden=false; $('viewer-message').querySelector('strong').textContent='参数已更新'; $('viewer-message').querySelector('span:last-child').textContent='正在准备最新模型…'; $('mesh-state').textContent='等待更新'; document.querySelector('.mesh-state i').classList.remove('ready'); $('triangle-count').textContent='—'; debounceTimer=setTimeout(generateModel,280); }
async function generateModel() {
  const version=++modelVersion, collected=collectSpec();
  if(collected.error){invalidateModel(collected.error);return;}
  const opts=options();
  if(!Number.isFinite(opts.minWall)||opts.minWall<=0||!Number.isFinite(opts.preserveMargin)||opts.preserveMargin<=0){invalidateModel('最小壁厚和保留边距必须是大于 0 的有限数字。');return;}
  spec=collected.spec; $('parameter-error').textContent=''; clearMetrics(); clearMeshes(); $('viewer-error').hidden=true; $('viewer-message').hidden=false;
  $('viewer-message').querySelector('strong').textContent='正在生成模型'; $('viewer-message').querySelector('span:last-child').textContent='正在根据当前参数计算三角网格…';
  $('mesh-state').textContent='正在生成'; document.querySelector('.mesh-state i').classList.remove('ready');
  try{
    const response=await fetch('/api/model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({spec,options:opts})});
    const data=await response.json().catch(()=>({error:'服务返回了无法读取的响应。'}));
    if(version!==modelVersion)return;
    if(!response.ok)throw new Error(data.error||data.message||`模型生成失败（${response.status}）。`);
    if(!data.mesh?.positions?.length||!data.baselineMesh?.positions?.length)throw new Error('服务未返回有效的三角网格。');
    modelData=data; renderModel(data); renderMetrics(data); $('parameter-error').textContent='';$('render-views').disabled=false;$('export-blend').disabled=false;
  }catch(error){if(version!==modelVersion)return;clearMeshes();clearMetrics();showModelError(error.message||'模型服务暂时不可用。');$('viewer-message').hidden=true;$('parameter-error').textContent=error.message||'模型生成失败。';}
}
function fmt(n,digits=1){return Number.isFinite(Number(n))?Number(n).toLocaleString('zh-CN',{maximumFractionDigits:digits}):'—';}
function renderMetrics(data){const m=data.metrics||{};$('optimized-volume').textContent=fmt(m.volumeMm3,1);$('saved-percent').textContent=`${fmt(m.savedPercent,1)}%`; $('baseline-volume').innerHTML=`${fmt(m.originalVolumeMm3,1)} <small>mm³</small>`;$('estimated-mass').innerHTML=`${fmt(m.estimatedMassG,2)} <small>g</small>`;$('density-label').textContent=`理论质量 · ${fmt(m.densityGPerCm3,2)} g/cm³`;
  $('checks-list').innerHTML=(data.checks||[]).map(c=>`<div class="check-row ${c.status==='warning'||c.status==='warn'?'warn':''}"><i>${c.status==='warning'||c.status==='warn'?'!':'✓'}</i><span><strong>${safeText(c.name)}</strong> · ${safeText(c.detail)}</span></div>`).join('')+(data.warnings||[]).map(w=>`<div class="check-row warn"><i>!</i><span>${safeText(w)}</span></div>`).join('');
  $('metric-note').textContent='来自生成网格的几何体积与理论质量估算；未验证承重、切片耗材或打印性能。';
}

async function loadStatus(){try{const r=await fetch('/api/status');const data=await r.json();if(!r.ok)throw new Error();analysisMode=data.analysisMode||'none';analyzeConfigured=analysisMode==='agh'||analysisMode==='development-deepseek';if(analysisMode==='development-deepseek')setStatus('开发验证 · DeepSeek V4.1 Flash，赛事版将使用 Agnes + AGH',true);else if(analysisMode==='agh')setStatus(`AGH 分析已配置 · ${data.model||'Agnes'}`,true);else setStatus('本地建模可用 · 照片分析未配置',true);$('analyze-button').disabled=!analyzeConfigured||photoItems.length===0;$('analyze-note').textContent=analysisMode==='development-deepseek'?'开发验证模式会将照片提交给 DeepSeek V4.1 Flash；赛事版将使用 Agnes + AGH。':analysisMode==='agh'?'照片将提交给已配置的 Agnes + AGH；分析结果仍可手动校正。':'照片分析服务尚未配置。可以测量平板照片并编辑模型，不会伪造 AI 识图结果。';$('analyze-note').classList.toggle('available',analyzeConfigured);updatePhotoActions();}catch{analysisMode='none';analyzeConfigured=false;setStatus('建模服务暂不可用',false);$('analyze-button').disabled=true;$('analyze-note').textContent='无法连接本地服务。照片不会被分析；参数建模需在服务恢复后使用。';updatePhotoActions();}}
function addPhotos(files){for(const file of files){if(photoItems.length>=12){alert('最多添加 12 张照片。');break;}if(!['image/png','image/jpeg'].includes(file.type)){alert(`${file.name} 不是 PNG 或 JPEG 图片。`);continue;}if(file.size>5*1024*1024){alert(`${file.name} 超过 5 MB 限制。`);continue;}photoItems.push({file,url:URL.createObjectURL(file)});}renderPhotos();}
function renderPhotos(){analysisVersion++;toolVersion++;const list=$('photo-list');list.innerHTML='';photoItems.forEach((p,index)=>{const row=document.createElement('div');row.className='photo-item';const img=document.createElement('img');img.src=p.url;img.alt='';const name=document.createElement('span');name.textContent=p.file.name;const remove=document.createElement('button');remove.className='remove-photo';remove.type='button';remove.title='删除照片';remove.setAttribute('aria-label',`删除照片 ${p.file.name}`);remove.textContent='×';remove.addEventListener('click',()=>{URL.revokeObjectURL(photoItems[index].url);photoItems.splice(index,1);renderPhotos();});row.append(img,name,remove);list.append(row);});$('photo-count').textContent=`${photoItems.length} / 12`;$('analyze-button').innerHTML='整理照片与建模建议 <span aria-hidden="true">→</span>';$('analyze-button').disabled=!analyzeConfigured||photoItems.length===0;updatePhotoActions();}
function updatePhotoActions(){$('measure-button').textContent='测量平板照片（无需 Key）';$('measure-button').disabled=!photoItems.length||!positiveValue($('reference-value').value)||!positiveValue($('board-thickness').value);}
function positiveValue(value){const number=Number(value);return String(value).trim()!==''&&Number.isFinite(number)&&number>0;}
function markAnalysisInputsChanged(){ $('analyze-button').innerHTML='整理照片与建模建议 <span aria-hidden="true">→</span>';analysisVersion++;toolVersion++;$('analyze-button').disabled=!analyzeConfigured||photoItems.length===0;updatePhotoActions();}
async function fileBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error(`无法读取照片 ${file.name}`));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file);});}
async function measurePhoto(){if(!photoItems.length)return;const widthMm=Number($('reference-value').value),thicknessMm=Number($('board-thickness').value);if(!positiveValue($('reference-value').value)){ $('analyze-note').textContent='请填写照片中对应的实测最长边尺寸。';$('reference-value').focus();return;}if(!positiveValue($('board-thickness').value)){ $('analyze-note').textContent='请单独填写平板厚度；不会从示例参数推测。';$('board-thickness').focus();return;}const requestToolVersion=++toolVersion,requestModelVersion=modelVersion,request=++measurementVersion,button=$('measure-button'),panel=$('measurement-result');button.disabled=true;button.textContent='正在测量第一张照片…';panel.hidden=true;try{const first=photoItems[0],payload={photo:{name:first.file.name,mime:first.file.type,dataBase64:await fileBase64(first.file)},widthMm,thicknessMm};const response=await fetch('/api/measure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json().catch(()=>({error:'服务返回了无法读取的响应。'}));if(!response.ok)throw new Error(data.error||data.message||`图像测量失败（${response.status}）。`);if(data.execution?.mode!=='classical-vision')throw new Error('服务未确认经典图像测量执行，未采用该结果。');if(request!==measurementVersion||requestToolVersion!==toolVersion||requestModelVersion!==modelVersion)return;if(!data.spec)throw new Error('测量服务没有返回可编辑参数。');spec=normalizeSpec(data.spec);source='measurement';$('model-type').value=spec.type;$('lightweight').checked=false;syncDimensions();updateSource();renderMeasurement(data);scheduleModel();}catch(error){if(request!==measurementVersion||requestToolVersion!==toolVersion)return;panel.hidden=false;panel.innerHTML=`<strong>图像测量未完成</strong><div>${safeText(error.message||'请检查照片和输入尺寸。')}</div>`;}finally{if(request===measurementVersion){button.textContent='测量平板照片（无需 Key）';updatePhotoActions();}}}
function renderMeasurement(data){const panel=$('measurement-result'),measurements=data.measurements||{};let html='<strong>图像测量，非 AI 识图</strong>';html+=`<div>实测最长边 ${safeText(measurements.longEdgeMm??measurements.longestEdgeMm??measurements.widthMm??'—')} mm · 板厚按手工输入建模</div>`;if(data.overlay?.dataBase64&&data.overlay?.mime)html+=`<img class="measurement-overlay" src="data:${safeText(data.overlay.mime)};base64,${data.overlay.dataBase64}" alt="平板轮廓与孔位测量叠加图">`;if(data.warnings?.length)html+=`<div><strong>注意：</strong>${data.warnings.map(safeText).join('；')}</div>`;panel.innerHTML=html;panel.hidden=false;}
async function renderBlenderViews(){if(!modelData)return;const request=++renderVersion,requestToolVersion=++toolVersion,requestModelVersion=modelVersion,button=$('render-views');button.disabled=true;$('render-state').textContent='正在从当前几何生成视图…';try{const collected=collectSpec();if(collected.error)throw new Error(collected.error);const response=await fetch('/api/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({spec:collected.spec,options:options()})});const data=await response.json().catch(()=>({error:'服务返回了无法读取的响应。'}));if(!response.ok)throw new Error(data.error||data.message||`三视图生成失败（${response.status}）。`);if(request!==renderVersion||requestToolVersion!==toolVersion||requestModelVersion!==modelVersion)return;if(!Array.isArray(data.views))throw new Error('服务没有返回三视图数据。');$('render-gallery').innerHTML=data.views.map(view=>`<figure class="render-view"><img src="data:${safeText(view.mime)};base64,${view.dataBase64}" alt="${safeText(view.name)}"><figcaption>${safeText(view.name)}</figcaption></figure>`).join('');$('render-checks').innerHTML=renderChecksHtml(data.checks||[]);$('render-state').textContent='Blender · 当前几何';$('render-result').hidden=false;}catch(error){if(request!==renderVersion||requestToolVersion!==toolVersion)return;$('render-result').hidden=false;$('render-gallery').innerHTML=`<div class="inline-error">${safeText(error.message||'三视图生成失败。')}</div>`;$('render-state').textContent='生成失败';}finally{if(request===renderVersion&&requestToolVersion===toolVersion)button.disabled=!modelData;}}
function renderChecksHtml(checks){if(Array.isArray(checks))return checks.map(check=>{const status=String(check.status||'').toLowerCase(),failed=['fail','failed','error','invalid'].includes(status),warn=['warning','warn'].includes(status);return `<div class="check-row ${failed?'fail':warn?'warn':''}"><i>${failed?'×':warn?'!':'✓'}</i><span><strong>${safeText(check.name)}</strong> · ${safeText(check.detail)}</span></div>`;}).join('');if(checks&&typeof checks==='object')return Object.entries(checks).map(([name,value])=>{const numeric=typeof value==='number',failed=numeric&&['boundaryEdges','nonManifoldEdges'].includes(name)&&value>0;return `<div class="check-row ${failed?'fail':''}"><i>${failed?'×':'✓'}</i><span><strong>${safeText(name)}</strong> · ${safeText(Array.isArray(value)?value.join(' × '):value)}</span></div>`;}).join('');return '';}
async function exportBlend(){if(!modelData)return;const request=++blendVersion,requestToolVersion=++toolVersion,requestModelVersion=modelVersion,button=$('export-blend');button.disabled=true;try{const collected=collectSpec();if(collected.error)throw new Error(collected.error);const response=await fetch('/api/export/blend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({spec:collected.spec,options:options()})});if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||data.message||`.blend 导出失败（${response.status}）。`);}const blob=await response.blob();if(request===blendVersion&&requestToolVersion===toolVersion&&requestModelVersion===modelVersion&&modelData)download(`${collected.spec.type}-model.blend`,blob);}catch(error){if(request===blendVersion&&requestToolVersion===toolVersion)$('parameter-error').textContent=error.message||'.blend 导出失败。';}finally{if(request===blendVersion&&requestToolVersion===toolVersion)button.disabled=!modelData;}}
async function analyze(){if(!analyzeConfigured||!photoItems.length)return;const ref=$('reference-value').value.trim();if(!positiveValue(ref)){$('analyze-note').textContent='请先填写照片中对应的实测最长边尺寸。';$('reference-value').focus();return;}const requestVersion=modelVersion,taskVersion=++analysisVersion,operationVersion=++toolVersion,button=$('analyze-button');button.disabled=true;button.textContent='正在提交照片…';$('analysis-result').hidden=true;try{const photos=await Promise.all(photoItems.map(async p=>({name:p.file.name,mime:p.file.type,dataBase64:await fileBase64(p.file)})));const payload={photos,reference:{valueMm:Number(ref),description:$('reference-description').value.trim()},description:$('object-description').value.trim(),preferredType:$('preferred-type').value};const r=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await r.json().catch(()=>({error:'服务返回了无法读取的响应。'}));if(!r.ok)throw new Error(data.error||data.message||`照片分析失败（${r.status}）。`);if(!['agh','development-deepseek'].includes(data.execution?.mode))throw new Error('服务没有确认受支持的模型执行，未采用该结果。');if(taskVersion!==analysisVersion||operationVersion!==toolVersion)return;if(requestVersion===modelVersion&&data.spec){spec=normalizeSpec(data.spec);source='analysis';$('model-type').value=spec.type;$('lightweight').checked=false;syncDimensions();updateSource();scheduleModel();}showAnalysis(data);}catch(e){if(taskVersion!==analysisVersion||operationVersion!==toolVersion)return;const panel=$('analysis-result');panel.hidden=false;panel.textContent=`照片分析未完成：${e.message||'本地服务暂不可用。'}`;panel.style.color='#a3463c';}finally{if(taskVersion===analysisVersion){button.innerHTML='整理照片与建模建议 <span aria-hidden="true">→</span>';button.disabled=!analyzeConfigured||photoItems.length===0;}}}
function showAnalysis(data){const panel=$('analysis-result');panel.style.color='';let lines=[];if(data.execution?.mode==='development-deepseek')lines.push('<strong>开发验证 · DeepSeek V4.1 Flash；赛事版将使用 Agnes + AGH</strong>');else lines.push('<strong>Agnes + AGH 分析建议</strong>');if(data.confidence!==undefined)lines.push(`<div class="confidence">模型自评（未校准）：${safeText(data.confidence)}</div>`);if(data.assumptions?.length)lines.push(`<div><strong>建模假设：</strong>${data.assumptions.map(safeText).join('；')}</div>`);if(data.suggestions?.length)lines.push(`<div><strong>补充建议：</strong>${data.suggestions.map(safeText).join('；')}</div>`);if(data.tolerance!==undefined||data.errorEstimate!==undefined)lines.push(`<div><strong>尺寸误差参考：</strong>${safeText(data.tolerance??data.errorEstimate)}</div>`);if(data.questions?.length)lines.push(`<div><strong>待确认：</strong>${data.questions.map(q=>safeText(typeof q==='string'?q:q.question??q.text??JSON.stringify(q))).join('；')}</div>`);if(data.execution?.id)lines.push(`<div>执行记录：${safeText(data.execution.id)}</div>`);panel.innerHTML=lines.join('');panel.hidden=false;}
function normalizeSpec(input){if(!input||!['plate','bracket','box'].includes(input.type))throw new Error('JSON 中的 type 必须是 plate、bracket 或 box。');return {name:String(input.name||typeNames[input.type]),type:input.type,dimensions:{...input.dimensions},holes:Array.isArray(input.holes)?input.holes.map(h=>({x:h.x,y:h.y,diameter:h.diameter})):[]};}
function download(name,blob){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function exportJson(){const collected=collectSpec(),opts=options();if(collected.error){$('parameter-error').textContent=collected.error;return;}if(!Number.isFinite(opts.minWall)||opts.minWall<=0||!Number.isFinite(opts.preserveMargin)||opts.preserveMargin<=0){$('parameter-error').textContent='最小壁厚和保留边距必须是大于 0 的有限数字。';return;}download('photo-cad-parameters.json',new Blob([JSON.stringify({spec:collected.spec,options:opts},null,2)],{type:'application/json'}));}
async function importJson(file){try{const value=JSON.parse(await file.text()),newSpec=normalizeSpec(value.spec||value);spec=newSpec;if(value.options){if(typeof value.options.lightweight==='boolean')$('lightweight').checked=value.options.lightweight;if(Number.isFinite(Number(value.options.minWall)))$('min-wall').value=value.options.minWall;if(Number.isFinite(Number(value.options.preserveMargin)))$('preserve-margin').value=value.options.preserveMargin;}source='import';$('model-type').value=spec.type;syncDimensions();updateSource();scheduleModel();}catch(e){invalidateModel(`JSON 导入失败：${e.message||'文件格式不正确。'}`);}}
async function exportStl(){if(!modelData)return;const requestVersion=modelVersion,collected=collectSpec();if(collected.error){invalidateModel(collected.error);return;}const button=$('export-stl');button.disabled=true;try{const r=await fetch('/api/export/stl',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({spec:collected.spec,options:options()})});if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||`STL 导出失败（${r.status}）。`);}const blob=await r.blob();if(requestVersion===modelVersion&&modelData)download(`${collected.spec.type}-model.stl`,blob);}catch(e){if(requestVersion===modelVersion)$('parameter-error').textContent=e.message||'STL 导出失败。';}finally{button.disabled=!modelData;}}

function bind(){
  const drop=$('dropzone'),input=$('photo-input');drop.addEventListener('click',()=>input.click());drop.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();input.click();}});input.addEventListener('change',()=>{addPhotos(input.files);input.value='';});
  for(const event of ['dragenter','dragover'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.add('dragover');});for(const event of ['dragleave','drop'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.remove('dragover');});drop.addEventListener('drop',e=>addPhotos(e.dataTransfer.files));
  $('analyze-button').addEventListener('click',analyze);$('measure-button').addEventListener('click',measurePhoto);$('render-views').addEventListener('click',renderBlenderViews);$('export-blend').addEventListener('click',exportBlend);for(const id of ['reference-value','reference-description','object-description','board-thickness'])$(id).addEventListener('input',markAnalysisInputsChanged);$('preferred-type').addEventListener('change',markAnalysisInputsChanged);document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{currentView=b.dataset.view;updateVisibleMesh();}));
  $('model-type').addEventListener('change',()=>{spec.type=$('model-type').value;spec.name=typeNames[spec.type];source='edited';syncDimensions();updateSource();invalidateModel('类型已更改，请检查参数后生成模型。');scheduleModel();});
  $('add-hole').addEventListener('click',()=>{if(spec.holes.length>=16){$('parameter-error').textContent='最多支持 16 个孔。';return;}spec.holes.push({x:0,y:0,diameter:5});source='edited';syncHoles();updateSource();scheduleModel();});
  $('lightweight').addEventListener('change',scheduleModel);for(const id of ['min-wall','preserve-margin'])$(id).addEventListener('input',()=>{const n=Number($(id).value);if(!$(id).value.trim()||!Number.isFinite(n)||n<=0)invalidateModel('最小壁厚和保留边距必须是大于 0 的有限数字。');else scheduleModel();});
  $('load-example').addEventListener('click',()=>{spec=structuredClone(exampleSpec);source='example';$('model-type').value=spec.type;$('lightweight').checked=true;$('min-wall').value=2;$('preserve-margin').value=3;syncDimensions();updateSource();scheduleModel();});
  $('export-json').addEventListener('click',exportJson);$('export-stl').addEventListener('click',exportStl);$('import-json').addEventListener('click',()=>$('json-input').click());$('json-input').addEventListener('change',()=>{if($('json-input').files[0])importJson($('json-input').files[0]);$('json-input').value='';});
}

initViewer();bind();syncDimensions();updateSource();loadStatus();generateModel();
