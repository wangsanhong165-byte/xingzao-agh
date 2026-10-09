import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const dataRoot = path.join(root, 'data', 'reconstruction');
const jobsRoot = path.join(dataRoot, 'jobs');
const generatedRoot = path.join(dataRoot, 'generated');
const pythonPath = path.join(dataRoot, 'env-torch-readonly', 'Scripts', 'python.exe');
const generatorPath = path.join(root, 'tools', 'reconstruction', 'generate_hunyuan_multiview.py');
const viewInspectorPath = path.join(root, 'tools', 'reconstruction', 'inspect_views.py');
const sourceScript = path.join(dataRoot, 'source-f8db630', 'Hunyuan3D-2-f8db63096c8282cb27354314d896feba5ba6ff8a', 'hy3dgen', 'shapegen', 'pipelines.py');
const weightPath = path.join(dataRoot, 'modelcache', 'hunyuan3d-2mv', 'hunyuan3d-dit-v2-mv', 'model.fp16.safetensors');
const configPath = path.join(dataRoot, 'modelcache', 'hunyuan3d-2mv', 'hunyuan3d-dit-v2-mv', 'config.yaml');
const manifestPath = path.join(dataRoot, 'modelcache', 'hunyuan3d-2mv', 'download-manifest.json');
const referenceGenerationSettings = Object.freeze({ steps: 25, resolution: 256, numChunks: 8000, seed: 12345 });
const modelProvenance = Object.freeze({ repo:'tencent/Hunyuan3D-2mv', revision:'3a761b539b29fe4ff64714813aa9560fd66f5de0', weightsSha256:'d36f5881bcdc56726b73e517cd444c13c60732431622da7268145355c8d38e9c',sourceRevision:'f8db63096c8282cb27354314d896feba5ba6ff8a' });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const names = ['front', 'left', 'back'];
const safeMime = new Set(['image/png', 'image/jpeg']);

function dimensions(bytes, mime) {
  if (mime === 'image/png') {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('VIEW_IMAGE_INVALID');
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('VIEW_IMAGE_INVALID');
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) continue;
    let marker = bytes[offset++]; while (marker === 0xff) marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 7 || offset + 7 > bytes.length) break;
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  throw new Error('VIEW_IMAGE_INVALID');
}
function cleanImage(view) {
  if (!view || typeof view !== 'object' || !safeMime.has(view.mime) || typeof view.dataBase64 !== 'string' || view.dataBase64.length > 7_000_000) throw new Error('VIEW_IMAGE_INVALID');
  const bytes = Buffer.from(view.dataBase64, 'base64');
  if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString('base64').replace(/=+$/u, '') !== view.dataBase64.replace(/=+$/u, '')) throw new Error('VIEW_IMAGE_INVALID');
  const [width, height] = dimensions(bytes, view.mime);
  if (!width || !height || width * height > 12_000_000) throw new Error('VIEW_IMAGE_INVALID');
  const ext = view.mime === 'image/png' ? 'png' : 'jpg';
  return { bytes, mime: view.mime, ext, width, height, sha256: hash(bytes), name: String(view.name ?? '').replace(/[\x00-\x1f\x7f]/gu,'').slice(0, 80) };
}
function safeError(error) {
  const code = String(error?.message ?? 'RECONSTRUCTION_FAILED');
  return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'RECONSTRUCTION_FAILED';
}
function publicExecution(value) {
  if (!value || typeof value !== 'object') return null;
  const allowed=['mode','toolTransport','profile','provider','route','model','modelBinding','sessionId','lastSeq','turnReason','startedAt','endedAt','exitCode','source','assetSha256','virtualBaseline'];
  return Object.fromEntries(allowed.filter(key=>value[key]===null||['string','number','boolean'].includes(typeof value[key])).map(key=>[key,value[key]]));
}

export class ReconstructionJobStore {
  constructor({ persist = true, inspect = null, slice = null, generator = null, runAgent = null } = {}) {
    this.persist = persist; this.inspect = inspect; this.slice = slice; this.generator = generator; this.runAgent = runAgent; this.jobs = new Map(); this.gpuActive = false;
  }
  async create(input) {
    const sideView=input?.sideView??'left';if(!['left','right'].includes(sideView))throw new Error('SIDE_VIEW_INVALID');
    const edge = Number(input?.targetLongestEdgeMm);
    if (!Number.isFinite(edge) || edge < 1 || edge > 180) throw new Error('TARGET_SCALE_INVALID');
    if (!input?.views || Object.keys(input.views).sort().join(',') !== 'back,front,left') throw new Error('VIEW_SET_INVALID');
    const views = Object.fromEntries(names.map((name) => [name, cleanImage(input.views[name])]));
    const id = randomUUID();
    const job = { id, sideView,targetLongestEdgeMm: edge, views: {}, stage: 'created', createdAt: new Date().toISOString(), events: [], candidates: {}, accessToken: randomBytes(32).toString('hex'), agentRunActive: false, toolCalls: 0, generationAttempts: 0 };
    this.jobs.set(id, job);
    if (this.persist) {
      const dir = path.join(jobsRoot, id); await mkdir(dir, { recursive: true });
      for (const name of names) { const v = views[name], file = `${name}.${v.ext}`; await writeFile(path.join(dir, file), v.bytes, { flag: 'wx' }); job.views[name] = { file, sha256: v.sha256, mime: v.mime, bytes: v.bytes.length, width: v.width, height: v.height, name: v.name }; }
      try {
        const args=names.flatMap(name=>[`--${name}`,path.join(dir,job.views[name].file)]);
        const env={PATH:process.env.PATH??'',SYSTEMROOT:process.env.SYSTEMROOT??'',WINDIR:process.env.WINDIR??'',TEMP:process.env.TEMP??'',TMP:process.env.TMP??''};
        const decoded=await execFile(pythonPath,[viewInspectorPath,...args],{cwd:root,env,windowsHide:true,shell:false,timeout:30_000,maxBuffer:32*1024,encoding:'utf8'});
        const report=JSON.parse(decoded.stdout);
        for(const name of names) if(report[name]?.width!==job.views[name].width||report[name]?.height!==job.views[name].height||report[name]?.format!==(job.views[name].mime==='image/png'?'PNG':'JPEG')) throw new Error('VIEW_IMAGE_INVALID');
      } catch { await rm(dir,{recursive:true,force:true}); throw new Error('VIEW_IMAGE_INVALID'); }
      await this.save(job);
    } else for (const name of names) job.views[name] = { ...views[name] };
    return job;
  }
  async save(job) {
    if (!this.persist) return;
    const dir = path.join(jobsRoot, job.id); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'state.json'), JSON.stringify(job));
  }
  get(id) { return this.jobs.get(id); }
  async load(id) {
    if (this.jobs.has(id)) return this.jobs.get(id);
    if (!this.persist || !/^[a-f0-9-]{36}$/u.test(id)) return null;
    try { const job = JSON.parse(await readFile(path.join(jobsRoot, id, 'state.json'), 'utf8')); if (job.id !== id) return null; if (job.agentRunActive) { job.agentRunActive = false; job.stage = 'interrupted'; job.accessToken = randomBytes(32).toString('hex'); job.error = 'TASK_INTERRUPTED'; await this.save(job); } this.jobs.set(id, job); return job; } catch { return null; }
  }
  publicJob(job, base = `/api/reconstruction/jobs/${job.id}`) {
    return { id: job.id,sideView:job.sideView??'left', stage: job.stage, agentRunActive: job.agentRunActive, events: job.events.slice(-80).map(e=>({tool:e.tool,source:e.source,success:e.success===true,result:e.result??null,code:e.code??null,msg:e.message??null,message:e.message??null,at:e.at})), execution: publicExecution(job.execution), submission:job.submissionProof?{candidateId:job.submissionProof.candidateId,assetSha256:job.submissionProof.assetSha256,sliceMode:job.submissionProof.sliceMode,virtualBaseline:job.submissionProof.virtualBaseline}:null,error: job.error ?? null, submittedCandidateId: job.submittedCandidateId ?? null,
      views: Object.fromEntries(names.map((name) => [name, { name: job.views[name]?.name ?? name, label:job.views[name]?.name ?? name, sha256:job.views[name]?.sha256??null, url: `${base}/view/${name}` }])),
      candidates: Object.values(job.candidates).map(c => ({ candidateId: c.candidateId, generation: c.generation, geometryChecks: c.geometryChecks, metrics: c.geometryChecks?.metrics ?? null, slice: c.slice ?? null, stlUrl: `${base}/stl/${c.candidateId}?sha=${c.stlSha256}` })) };
  }
  async readView(job, name) {
    if (!names.includes(name)) return null;
    const meta = job.views[name]; if(!meta||!['png','jpg'].includes(path.extname(meta.file??'').slice(1))||meta.file!==`${name}.${path.extname(meta.file).slice(1)}`||meta.mime!==(meta.file.endsWith('.png')?'image/png':'image/jpeg')) throw new Error('VIEW_FILE_INVALID');
    const file = path.join(jobsRoot, job.id, meta.file); const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('VIEW_FILE_INVALID');
    const bytes = await readFile(file); if (hash(bytes) !== meta.sha256) throw new Error('VIEW_HASH_MISMATCH'); return { bytes, mime: meta.mime };
  }
  async readStl(job, candidateId) {
    const c = job.candidates[candidateId]; if (!c?.stlFile || c.jobId !== job.id) return null;
    if(!/^[a-f0-9]{64}\.stl$/u.test(c.stlFile)||c.stlFile!==`${candidateId}.stl`) throw new Error('CANDIDATE_FILE_INVALID');
    const file = path.join(generatedRoot, c.stlFile); const bytes = await readFile(file); if (hash(bytes) !== c.stlSha256) throw new Error('CANDIDATE_HASH_MISMATCH'); return bytes;
  }
  async startAgent(id, runAgent = this.runAgent) {
    const job = this.get(id); if (!job || job.agentRunActive) throw new Error('TASK_UNAVAILABLE');
    job.agentRunActive = true; job.stage = 'agent-running'; await this.save(job);
    try { if(!runAgent) runAgent=(await import('./reconstruction-agh.mjs')).runReconstructionTask; if(typeof runAgent!=='function') throw new Error('TASK_UNAVAILABLE'); const result = await runAgent({ jobId: job.id, task: { targetLongestEdgeMm: job.targetLongestEdgeMm,sideView:job.sideView??'left', constraints: ['shape-only',`three-views-front-${job.sideView??'left'}-back`,'z-up-stl','no-texture','no-physical-print-claim'] }, accessToken: job.accessToken, serviceUrl: 'http://127.0.0.1:4337' }); await this.finish(id, result); }
    catch (error) { await this.finish(id, { success: false, reason: safeError(error) }); }
  }
  async finish(id, result) { const j=this.get(id); if (!j || !j.agentRunActive) return; j.agentRunActive=false; const submitted=j.submittedCandidateId?j.candidates[j.submittedCandidateId]:null; j.execution=publicExecution(result?.execution); const success=result?.success===true&&Boolean(submitted); j.stage=success?'completed':'failed'; j.error=success?null:safeError({message:result?.reason??(result?.success?'SUBMISSION_REQUIRED':'RECONSTRUCTION_FAILED')}); await this.save(j); }
  async execute(id, tool, input, source = 'agh') {
    const job=this.get(id); if (!job || !job.agentRunActive || source !== 'agh' || ++job.toolCalls > 12) return { success:false, code:'TOOL_CALL_LIMIT' };
    const event={ tool, source, at:new Date().toISOString() }; job.events.push(event); await this.save(job);
    const record=async(result)=>{event.success=result.success===true;event.result=event.success?'success':'failure';event.code=result.code??(event.success?'OK':'TOOL_FAILED');event.message=result.message??(event.success?`${tool} completed`:`${tool} failed`);await this.save(job);return result;};
    try {
      if (tool === 'inspect') { job.viewsInspected=true; await this.save(job); return await record({ success:true, code:'OK', message:'View hashes and scale inspected',sideView:job.sideView??'left', views:Object.fromEntries(names.map(n=>[n,{viewTag:n==='left'?(job.sideView??'left'):n,sha256:job.views[n].sha256,width:job.views[n].width,height:job.views[n].height}])), targetLongestEdgeMm:job.targetLongestEdgeMm, referenceGenerationSettings, samplingPolicy:'Use reference settings first; lower sampling is a preview and cannot establish material optimization or preserved appearance.' }); }
      if (tool === 'generate') { if(!job.viewsInspected) throw new Error('INSPECT_REQUIRED'); return await record(await this.generate(job, input.options ?? {})); }
      const c=job.candidates[input.candidateId]; if (!c || c.jobId !== job.id) throw new Error('CANDIDATE_NOT_FOUND');
      if (tool === 'validate') return await record(await this.validate(job,c));
      if (tool === 'slice') return await record(await this.sliceCandidate(job,c));
      if (tool === 'submit') return await record(await this.submit(job,c));
      throw new Error('TOOL_UNKNOWN');
    } catch(e) { event.success=false;event.result='failure';event.code=safeError(e);event.message=`${tool} failed`;await this.save(job); return { success:false, code:event.code, reason:event.code, message:event.message }; }
  }
  async generate(job, options) {
    if (job.generationAttempts >= 2) throw new Error('GENERATION_ATTEMPT_LIMIT');
      const settings={ steps: options.steps ?? 25, resolution: options.resolution ?? 256, numChunks: options.chunks ?? options.numChunks ?? 8000, seed: options.seed ?? 12345 };
    if (!Number.isInteger(settings.steps)||settings.steps<5||settings.steps>50||![128,256].includes(settings.resolution)||![4000,8000,20000].includes(settings.numChunks)||!Number.isInteger(settings.seed)||settings.seed<0||settings.seed>0xffffffff) throw new Error('GENERATION_SETTINGS_INVALID');
    if(this.gpuActive) throw new Error('GPU_BUSY');
    this.gpuActive=true; job.generationAttempts++;
    try {
      await this.save(job);
      const runId=`reconstruction-${job.id}-attempt${job.generationAttempts}`;
      let result;
      if (this.generator) result=await this.generator({job,settings,runId,generatedRoot});
      else {
        const args=['--front',path.join(jobsRoot,job.id,job.views.front.file),'--left',path.join(jobsRoot,job.id,job.views.left.file),'--side-view',job.sideView??'left','--back',path.join(jobsRoot,job.id,job.views.back.file),'--target-longest-edge-mm',String(job.targetLongestEdgeMm),'--steps',String(settings.steps),'--resolution',String(settings.resolution),'--num-chunks',String(settings.numChunks),'--seed',String(settings.seed),'--run-id',runId];
        const env={PATH:process.env.PATH ?? '',SYSTEMROOT:process.env.SYSTEMROOT ?? '',WINDIR:process.env.WINDIR ?? '',TEMP:process.env.TEMP ?? '',TMP:process.env.TMP ?? '',CUDA_VISIBLE_DEVICES:process.env.CUDA_VISIBLE_DEVICES ?? '0'};
        await execFile(pythonPath,[generatorPath,...args],{cwd:root,env,windowsHide:true,shell:false,timeout:300_000,maxBuffer:512*1024,encoding:'utf8'});
        result={dir:path.join(generatedRoot,runId)};
      }
      const dir=result?.dir ?? path.join(generatedRoot,runId); const report=JSON.parse(await readFile(path.join(dir,'generation.json'),'utf8'));
      const expectedHashes=Object.fromEntries(names.map(n=>[n,job.views[n].sha256]));
      if (report.model?.repo!==modelProvenance.repo || report.model?.revision!==modelProvenance.revision || report.model?.weightsSha256!==modelProvenance.weightsSha256 || report.model?.sourceRevision!==modelProvenance.sourceRevision) throw new Error('GENERATION_PROVENANCE_INVALID');
      for(const n of names){
        if(report.inputViews?.[n]?.sha256!==expectedHashes[n])throw new Error('GENERATION_INPUT_MISMATCH');
        const expectedTag=n==='left'?(job.sideView??'left'):n;
        if((report.inputViews?.[n]?.viewTag??n)!==expectedTag)throw new Error('GENERATION_VIEW_TAG_MISMATCH');
      }
      if((report.sideView??'left')!==(job.sideView??'left'))throw new Error('GENERATION_VIEW_TAG_MISMATCH');
      if(report.settings?.numInferenceSteps!==settings.steps||report.settings?.octreeResolution!==settings.resolution||report.settings?.numChunks!==settings.numChunks||report.settings?.seed!==settings.seed) throw new Error('GENERATION_SETTINGS_MISMATCH');
      if(report.transformToPrintCoordinates?.normalizationStrategy!=='Y-up to Z-up, uniform scale, center XY, bottom Z=0') throw new Error('GENERATION_COORDINATES_INVALID');
      const bounds=report.fullPrintMesh?.boundsMm;
      const actualEdge=Array.isArray(bounds)&&bounds.length===2&&Array.isArray(bounds[0])&&Array.isArray(bounds[1])?Math.max(...bounds[0].map((v,i)=>Math.abs(bounds[1][i]-v))):NaN;
      if(report.settings?.targetLongestEdgeMm!==job.targetLongestEdgeMm || !Number.isFinite(actualEdge) || Math.abs(actualEdge-job.targetLongestEdgeMm)>0.1) throw new Error('GENERATION_SCALE_MISMATCH');
      const file=report.importReadyStl; if(!['print-ready-z-up-full.stl','print-ready-z-up-240000-faces.stl'].includes(file)) throw new Error('GENERATION_OUTPUT_INVALID');
      const stlPath=path.join(dir,file); const bytes=await readFile(stlPath); if(!bytes.length||bytes.length>25*1024*1024) throw new Error('GENERATION_OUTPUT_INVALID');
      const actual=hash(bytes); if(file==='print-ready-z-up-full.stl' ? report.fullPrintMesh?.sha256!==actual : report.simplification?.sha256!==actual) throw new Error('GENERATION_OUTPUT_HASH_MISMATCH');
      if(file!=='print-ready-z-up-full.stl'&&(report.simplification?.algorithm!=='PyMeshLab quadric edge-collapse'||!Number.isSafeInteger(report.simplification?.faces)||!Number.isSafeInteger(report.simplification?.vertices))) throw new Error('GENERATION_REPORT_INVALID');
      if(!job.agentRunActive) throw new Error('TASK_INTERRUPTED');
      const candidateId=hash(Buffer.from(JSON.stringify({stl:actual,inputs:expectedHashes,settings,edge:job.targetLongestEdgeMm,sideView:job.sideView??'left'})));
      const safeName=`${candidateId}.stl`; const dst=path.join(generatedRoot,safeName); await mkdir(generatedRoot,{recursive:true});
      try { await writeFile(dst,bytes,{flag:'wx'}); } catch(error) { if(error?.code!=='EEXIST'||hash(await readFile(dst))!==actual) throw new Error('CANDIDATE_HASH_MISMATCH'); }
      const simplification=report.simplification?{algorithm:'PyMeshLab quadric edge-collapse',faces:report.simplification.faces,vertices:report.simplification.vertices,sha256:actual}:null;
      const c={jobId:job.id,candidateId,stlFile:safeName,stlSha256:actual,sourceGeneratedSha256:actual,generation:{model:modelProvenance,sideView:job.sideView??'left',settings:{steps:settings.steps,resolution:settings.resolution,chunks:settings.numChunks,seed:settings.seed,targetLongestEdgeMm:job.targetLongestEdgeMm},transform:{normalizationStrategy:'Y-up to Z-up, uniform scale, center XY, bottom Z=0',targetLongestEdgeMm:job.targetLongestEdgeMm},simplification},geometryChecks:null,slice:null}; job.candidates[candidateId]=c; await this.save(job); return {success:true,candidateId,generation:c.generation,message:'Candidate generated and provenance verified'};
    } finally { this.gpuActive=false; }
  }
  async validate(job,c) {
    const bytes=await this.readStl(job,c.candidateId); if(!bytes) throw new Error('CANDIDATE_NOT_FOUND');
    let result;
    if(this.inspect) result=await this.inspect({bytes,format:'stl',sourceUnits:'mm',targetLongestEdgeMm:job.targetLongestEdgeMm});
    else result=await (await import('./model-import.mjs')).inspectModelUpload({name:'candidate.stl',mime:'model/stl',dataBase64:bytes.toString('base64'),sourceUnits:'mm',targetLongestEdgeMm:job.targetLongestEdgeMm});
    const raw=result.checks ?? {};
    const checks=Array.isArray(raw) ? raw : [
      {name:'closed-mesh',status:raw.watertight?'pass':'fail'},
      {name:'face-orientation',status:raw.windingConsistent?'pass':'fail'},
      {name:'degenerate-faces',status:raw.degenerateFaceCount===0?'pass':'fail'},
      {name:'boundary-edges',status:raw.boundaryEdgeCount===0?'pass':'fail'},
      {name:'non-manifold-edges',status:raw.nonManifoldEdgeCount===0?'pass':'fail'},
      {name:'positive-volume',status:raw.positiveVolume?'pass':'fail'},
    ];
    const pass=(Array.isArray(result.checks) ? checks.length>0&&checks.every(x=>x.status==='pass') : result.geometryChecksPassed===true&&checks.every(x=>x.status==='pass'));
    const normalizedPath=path.resolve(root,result.normalizedStlPath??''); const importRoot=path.join(root,'data','import-jobs'); const relative=path.relative(importRoot,normalizedPath);
    if(!result.normalizedStlPath||relative.startsWith('..')||path.isAbsolute(relative)) throw new Error('NORMALIZED_STL_PATH_INVALID');
    const normalized=await readFile(normalizedPath); if(normalized.length>25*1024*1024||hash(normalized)!==result.normalizedStlSha256) throw new Error('NORMALIZED_STL_HASH_MISMATCH');
    const priorSha=c.stlSha256; const target=path.join(generatedRoot,c.stlFile); const temp=`${target}.tmp-${randomUUID()}`; await writeFile(temp,normalized,{flag:'wx'}); await rm(target,{force:true}); await import('node:fs/promises').then(({rename})=>rename(temp,target));
    c.sourceGeneratedSha256=c.sourceGeneratedSha256??priorSha; c.stlSha256=result.normalizedStlSha256; if(c.stlSha256!==priorSha)c.slice=null;
    const dimensions=result.dimensionsMm??{};
    const metrics={normalizedDimensionsMm:dimensions,normalizedBoundsMm:result.normalizedBoundsMm??null,longestEdgeMm:dimensions.longestEdge??null,triangleCount:result.triangleCount??null,partCount:result.partCount??null,volumeMm3:raw.volumeMm3??null};
    c.geometryChecks={passed:pass,checks,metrics,execution:'actual-model-import',stlSha256:c.stlSha256};
    await this.save(job); return {success:pass,valid:pass,candidateId:c.candidateId,geometryChecks:c.geometryChecks,message:pass?'Geometry validation passed':'Geometry validation failed'};
  }
  async sliceCandidate(job,c) {
    const bytes=await this.readStl(job,c.candidateId); if(!bytes||!c.geometryChecks?.passed||c.geometryChecks.stlSha256!==c.stlSha256) throw new Error('GEOMETRY_CHECK_REQUIRED');
    const stlPath=path.join(generatedRoot,c.stlFile); const out=path.join(generatedRoot,`${c.candidateId}-slice`);
    const result=this.slice?await this.slice({stlPath,outputDir:out}):await (await import('./slicer.mjs')).sliceArtifact({stlPath,outputDir:out});
    if(result.execution?.mode!=='actual-slicer') throw new Error('ACTUAL_SLICER_REQUIRED');
    const gcode=await readFile(result.gcodePath,'utf8'); const roles={}; for(const match of gcode.matchAll(/^;\s*TYPE:\s*([^\r\n]+)/gimu)){const role=match[1].trim();roles[role]=(roles[role]??0)+1;}
    c.slice={mode:'actual-slicer',sourceStlSha256:c.stlSha256,execution:result.execution,metrics:result.metrics,layerCount:(gcode.match(/^;\s*LAYER_CHANGE\s*$/gimu)??[]).length,bridgeRoleCount:Object.entries(roles).filter(([name])=>/bridge/iu.test(name)).reduce((n,[,count])=>n+count,0),overhangRoleCount:Object.entries(roles).filter(([name])=>/overhang/iu.test(name)).reduce((n,[,count])=>n+count,0),roleCounts:roles,roleSource:'actual-slicer-gcode-comments',placementVerification:result.placementVerification,sourceStlBoundsMm:result.sourceStlBoundsMm,warnings:result.warnings}; await this.save(job); return {success:true,candidateId:c.candidateId,slice:c.slice,message:'Actual slicer baseline completed'};
  }
  async submit(job,c) {
    if(!c.geometryChecks?.passed||c.geometryChecks.stlSha256!==c.stlSha256||c.slice?.mode!=='actual-slicer'||c.slice?.execution?.mode!=='actual-slicer'||c.slice?.sourceStlSha256!==c.stlSha256) throw new Error('SUBMIT_REQUIREMENTS_NOT_MET');
    const bytes=await this.readStl(job,c.candidateId); if(!bytes) throw new Error('CANDIDATE_HASH_MISMATCH');
    job.submittedCandidateId=c.candidateId; job.submissionProof={candidateId:c.candidateId,assetSha256:c.stlSha256,sliceMode:c.slice.mode,virtualBaseline:true}; await this.save(job); return {success:true,candidateId:c.candidateId,assetSha256:c.stlSha256,submissionProof:job.submissionProof,message:'Candidate submitted with actual geometry and slicer evidence'};
  }
}

export const reconstructionPaths = Object.freeze({ root, jobsRoot, generatedRoot, pythonPath, generatorPath, sourceScript, weightPath, configPath, manifestPath });
