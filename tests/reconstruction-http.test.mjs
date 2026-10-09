import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReconstructionRouter } from '../src/reconstruction-http.mjs';
import { ReconstructionJobStore, reconstructionPaths } from '../src/reconstruction-jobs.mjs';

const png = () => { const b=Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(b); b.write('IHDR',12); b.writeUInt32BE(2,16); b.writeUInt32BE(2,20); return b.toString('base64'); };
const views=()=>Object.fromEntries(['front','left','back'].map(name=>[name,{name,mime:'image/png',dataBase64:png()}]));
const validPng='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP8//8/AwMDEwMYAAAkBgMBXaJOiAAAAABJRU5ErkJggg==';
async function fixture(options={}) {
  const store=new ReconstructionJobStore({persist:false,...options}); const router=createReconstructionRouter({store,runAgent:async()=>new Promise(()=>{})});
  const server=createServer(async(req,res)=>{ if(!await router.handle(req,res)){res.statusCode=404;res.end();} });
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); const base=`http://127.0.0.1:${server.address().port}`;
  return {store,server,base,close:()=>new Promise(r=>server.close(r))};
}

test('multiview input validation requires exact named views, valid images and bounded scale', async()=>{
  const {store,server,close}=await fixture();
  try {
    await assert.rejects(store.create({views:{front:views().front,left:views().left},targetLongestEdgeMm:20}),/VIEW_SET_INVALID/);
    await assert.rejects(store.create({views:views(),targetLongestEdgeMm:181}),/TARGET_SCALE_INVALID/);
    const bad=views(); bad.left.mime='image/jpeg';
    await assert.rejects(store.create({views:bad,targetLongestEdgeMm:20}),/VIEW_IMAGE_INVALID/);
  } finally { await close(); }
});
test('right-facing profile is retained in the task and inspect contract',async()=>{
 const {store,close}=await fixture();try{
  const job=await store.create({views:views(),targetLongestEdgeMm:100,sideView:'right'});job.agentRunActive=true;
  assert.equal(job.sideView,'right');assert.equal(store.publicJob(job).sideView,'right');
  const info=await store.execute(job.id,'inspect',{},'agh');assert.equal(info.sideView,'right');assert.equal(info.views.left.viewTag,'right');
  await assert.rejects(store.create({views:views(),targetLongestEdgeMm:100,sideView:'up'}),/SIDE_VIEW_INVALID/);
 }finally{await close()}
});

test('persistent job creation decodes actual image pixels and rejects forged PNG headers', async()=>{
  const validStore=new ReconstructionJobStore(); let job;
  try {
    job=await validStore.create({views:Object.fromEntries(['front','left','back'].map(name=>[name,{name,mime:'image/png',dataBase64:validPng}])),targetLongestEdgeMm:20});
    assert.ok(job.id); assert.equal(job.views.front.width,2);
  } finally { if(job) await (await import('node:fs/promises')).rm(path.join(reconstructionPaths.jobsRoot,job.id),{recursive:true,force:true}); }
  const badStore=new ReconstructionJobStore();
  await assert.rejects(badStore.create({views:views(),targetLongestEdgeMm:20}),/VIEW_IMAGE_INVALID/);
});

test('HTTP router leaves unmatched routes, blocks bad Origin, and requires active-job token', async()=>{
  const {store,server,base,close}=await fixture();
  try {
    const unmatched=await fetch(`${base}/api/elsewhere`); assert.equal(unmatched.status,404);
    const denied=await fetch(`${base}/api/reconstruction/start`,{method:'POST',headers:{origin:'https://evil.invalid','content-type':'application/json'},body:JSON.stringify({views:views(),targetLongestEdgeMm:20})}); assert.equal(denied.status,403);
    const job=await store.create({views:views(),targetLongestEdgeMm:20}); job.agentRunActive=true;
    const noToken=await fetch(`${base}/api/reconstruction/tool/inspect`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:job.id})}); assert.equal(noToken.status,403);
    const mismatch=await fetch(`${base}/api/reconstruction/tool/inspect`,{method:'POST',headers:{'content-type':'application/json','x-print-task-access':'wrong'},body:JSON.stringify({jobId:job.id})}); assert.equal(mismatch.status,403);
    const ok=await fetch(`${base}/api/reconstruction/tool/inspect`,{method:'POST',headers:{'content-type':'application/json','x-print-task-access':job.accessToken},body:JSON.stringify({jobId:job.id})}); assert.equal(ok.status,200);
    const inspection=await ok.json();
    assert.deepEqual(inspection.referenceGenerationSettings,{steps:25,resolution:256,numChunks:8000,seed:12345});
  } finally { await close(); }
});

test('recognized router requests return true and status includes safe local engine configuration', async()=>{
  const store=new ReconstructionJobStore({persist:false});
  const router=createReconstructionRouter({store});
  const response={headers:{},writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};
  const request={url:'/api/reconstruction/status',method:'GET',headers:{},async *[Symbol.asyncIterator](){}};
  assert.equal(await router.handle(request,response),true);
  const body=JSON.parse(response.body); assert.equal(typeof body.engine.configured,'boolean');
  assert.equal(body.engine.python,undefined); assert.equal(body.agh.route,undefined);
});

test('public job projection omits access token, image data and filesystem paths', async()=>{
  const {store,server,base,close}=await fixture();
  try {
    const job=await store.create({views:views(),targetLongestEdgeMm:20}); job.execution={mode:'agh',recordDir:'C:\\private\\records',accessToken:'secret'}; const response=await fetch(`${base}/api/reconstruction/jobs/${job.id}`); const text=await response.text();
    assert.equal(response.status,200); assert.doesNotMatch(text,/accessToken|dataBase64|D:\\\\|python\.exe|jobsRoot/);
    assert.match(text,/"front"/);
    assert.doesNotMatch(text,/private|secret|recordDir/);
    assert.equal(store.publicJob(job).views.front.sha256,job.views.front.sha256); assert.equal(store.publicJob(job).views.front.label,'front');
    job.events.push({tool:'inspect',source:'agh',success:true,result:'success',code:'OK',message:'View hashes inspected',at:new Date().toISOString()});
    const event=store.publicJob(job).events.at(-1); assert.deepEqual({source:event.source,success:event.success,code:event.code,message:event.message},{source:'agh',success:true,code:'OK',message:'View hashes inspected'});
  } finally { await close(); }
});

test('validation, slicing, submit and finish preserve distinct evidence contracts',async()=>{
  const id='d'.repeat(64); const stlFile=`${id}.stl`; const generated=path.join(reconstructionPaths.generatedRoot,stlFile);
  const importDir=path.join(reconstructionPaths.root,'data','import-jobs',`contract-${Date.now()}`); const normalizedPath=path.join(importDir,'normalized.stl');
  const gcodeDir=await mkdtemp(path.join(tmpdir(),'reconstruction-slice-contract-')); const gcodePath=path.join(gcodeDir,'result.gcode');
  const source=Buffer.from('source candidate'); const normalized=Buffer.from('normalized candidate');
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  await (await import('node:fs/promises')).mkdir(reconstructionPaths.generatedRoot,{recursive:true}); await (await import('node:fs/promises')).mkdir(importDir,{recursive:true});
  await writeFile(generated,source); await writeFile(normalizedPath,normalized); await writeFile(gcodePath,';LAYER_CHANGE\n;TYPE:Bridge infill\n;TYPE:Overhang perimeter\n');
  const store=new ReconstructionJobStore({persist:false,inspect:async()=>({geometryChecksPassed:true,checks:{watertight:true,windingConsistent:true,degenerateFaceCount:0,boundaryEdgeCount:0,nonManifoldEdgeCount:0,positiveVolume:true,volumeMm3:2},dimensionsMm:{x:20,y:10,z:8,longestEdge:20},normalizedBoundsMm:{min:[0,0,0],max:[20,10,8]},triangleCount:12,partCount:1,normalizedStlPath:path.relative(reconstructionPaths.root,normalizedPath),normalizedStlSha256:digest(normalized)}),slice:async()=>({execution:{mode:'actual-slicer',version:'fixture'},gcodePath,metrics:{estimatedTimeSeconds:60},sourceStlBoundsMm:{xMin:0,xMax:20}})});
  try {
    const job=await store.create({views:views(),targetLongestEdgeMm:20}); job.agentRunActive=true;
    job.candidates[id]={jobId:job.id,candidateId:id,stlFile,stlSha256:digest(source),sourceGeneratedSha256:digest(source),geometryChecks:null,slice:{mode:'actual-slicer',sourceStlSha256:digest(source),execution:{mode:'actual-slicer'}}};
    const validation=await store.execute(job.id,'validate',{candidateId:id},'agh'); assert.equal(validation.valid,true); assert.equal(validation.geometryChecks.metrics.triangleCount,12);
    assert.equal(job.candidates[id].slice,null);
    assert.deepEqual(await (await import('node:fs/promises')).readFile(generated),normalized);
    const sliced=await store.execute(job.id,'slice',{candidateId:id},'agh'); assert.equal(sliced.slice.mode,'actual-slicer'); assert.equal(sliced.slice.bridgeRoleCount,1); assert.equal(sliced.slice.overhangRoleCount,1);
    assert.equal(sliced.slice.sourceStlSha256,job.candidates[id].stlSha256);
    const submitted=await store.execute(job.id,'submit',{candidateId:id},'agh'); assert.equal(submitted.success,true); assert.equal(job.execution,undefined);
    await store.finish(job.id,{success:true,execution:{mode:'agh',recordDir:'private'}});
    assert.equal(job.stage,'completed'); assert.equal(job.execution.mode,'agh'); assert.equal(job.execution.recordDir,undefined); assert.equal(job.candidates[id].slice.mode,'actual-slicer');
    const pub=store.publicJob(job); assert.equal(pub.submission.sliceMode,'actual-slicer'); assert.equal(pub.submission.virtualBaseline,true); assert.equal(pub.execution.mode,'agh');
  } finally { await (await import('node:fs/promises')).rm(generated,{force:true}); await (await import('node:fs/promises')).rm(importDir,{recursive:true,force:true}); await rm(gcodeDir,{recursive:true,force:true}); }
});

test('a stale STL URL SHA is rejected after validation replaces candidate bytes',async()=>{
  const {store,base,close}=await fixture(); let artifact;
  try {
    const job=await store.create({views:views(),targetLongestEdgeMm:20}); const id='e'.repeat(64); const bytes=Buffer.from('candidate bytes');
    await (await import('node:fs/promises')).mkdir(reconstructionPaths.generatedRoot,{recursive:true}); artifact=path.join(reconstructionPaths.generatedRoot,`${id}.stl`); await writeFile(artifact,bytes);
    job.candidates[id]={jobId:job.id,candidateId:id,stlFile:`${id}.stl`,stlSha256:createHash('sha256').update(bytes).digest('hex'),geometryChecks:{passed:true}};
    const oldSha=job.candidates[id].stlSha256; const response=await fetch(`${base}/api/reconstruction/jobs/${job.id}/stl/${id}?sha=${oldSha}`); assert.equal(response.status,200);
    job.candidates[id].stlSha256='f'.repeat(64);
    const stale=await fetch(`${base}/api/reconstruction/jobs/${job.id}/stl/${id}?sha=${oldSha}`); assert.equal(stale.status,409);
  } finally { await close(); if(artifact) await (await import('node:fs/promises')).rm(artifact,{force:true}); }
});

test('a candidate artifact changed after slicing cannot be submitted with the old slice proof',async()=>{
  const {store,server,close}=await fixture();
  let artifact;
  try {
    const job=await store.create({views:views(),targetLongestEdgeMm:20}); const id='f'.repeat(64); job.agentRunActive=true;
    await (await import('node:fs/promises')).mkdir(reconstructionPaths.generatedRoot,{recursive:true}); artifact=path.join(reconstructionPaths.generatedRoot,`${id}.stl`); await writeFile(artifact,'current bytes'); const currentSha=createHash('sha256').update('current bytes').digest('hex');
    job.candidates[id]={jobId:job.id,candidateId:id,stlFile:`${id}.stl`,stlSha256:currentSha,geometryChecks:{passed:true,stlSha256:currentSha},slice:{mode:'actual-slicer',execution:{mode:'actual-slicer'},sourceStlSha256:'a'.repeat(64)}};
    const result=await store.execute(job.id,'submit',{candidateId:id},'agh'); assert.equal(result.success,false); assert.equal(result.code,'SUBMIT_REQUIREMENTS_NOT_MET');
  } finally { await close(); if(artifact) await (await import('node:fs/promises')).rm(artifact,{force:true}); }
});

test('candidate is job-bound, file tampering invalidates hashes, slice/submit need actual evidence', async()=>{
  const {store,server,close}=await fixture();
  try {
    const a=await store.create({views:views(),targetLongestEdgeMm:20}); const b=await store.create({views:views(),targetLongestEdgeMm:20}); a.agentRunActive=true;
    assert.equal((await store.execute(a.id,'generate',{},'agh')).code,'INSPECT_REQUIRED');
    a.candidates.fake={jobId:b.id,candidateId:'fake',stlFile:'fake.stl',stlSha256:'0'.repeat(64)};
    const result=await store.execute(a.id,'validate',{candidateId:'fake'},'agh'); assert.equal(result.success,false); assert.equal(result.code,'CANDIDATE_NOT_FOUND');
    assert.equal((await store.execute(a.id,'submit',{candidateId:'fake'},'agh')).success,false);
    a.toolCalls=12; assert.equal((await store.execute(a.id,'inspect',{},'agh')).code,'TOOL_CALL_LIMIT');
  } finally { await close(); }
});

test('loading an unfinished persisted job interrupts it and rotates its task token', async()=>{
  const id='12345678-1234-4123-8123-123456789abc'; const dir=path.join(reconstructionPaths.jobsRoot,id);
  const {mkdir,rm}=await import('node:fs/promises'); await mkdir(dir,{recursive:true});
  try {
    await writeFile(path.join(dir,'state.json'),JSON.stringify({id,stage:'agent-running',agentRunActive:true,accessToken:'old-token',events:[],candidates:{},views:{},toolCalls:1}));
    const store=new ReconstructionJobStore(); const job=await store.load(id);
    assert.equal(job.stage,'interrupted'); assert.equal(job.agentRunActive,false); assert.notEqual(job.accessToken,'old-token'); assert.equal(job.error,'TASK_INTERRUPTED');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('AGH completion without an actually submitted sliced asset remains failed', async()=>{
  const {store,server,close}=await fixture();
  try {
    const job=await store.create({views:views(),targetLongestEdgeMm:20}); job.agentRunActive=true;
    await store.finish(job.id,{success:true,execution:{mode:'agh',recordDir:'private'}});
    assert.equal(job.stage,'failed'); assert.equal(job.error,'SUBMISSION_REQUIRED'); assert.equal(job.execution.recordDir,undefined);
  } finally { await close(); }
});

test('generation accepts only matching provenance and output SHA from the pinned run', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'reconstruction-provenance-'));
  try {
    const store=new ReconstructionJobStore({persist:false,generator:async({job})=>{
      const {createHash}=await import('node:crypto'); const digest=b=>createHash('sha256').update(b).digest('hex');
      const stl=Buffer.from('bounded-test-stl'); await writeFile(path.join(dir,'print-ready-z-up-full.stl'),stl);
      const inputViews=Object.fromEntries(['front','left','back'].map(n=>[n,{sha256:job.views[n].sha256}]));
      await writeFile(path.join(dir,'generation.json'),JSON.stringify({
        model:{repo:'tencent/Hunyuan3D-2mv',revision:'3a761b539b29fe4ff64714813aa9560fd66f5de0',weightsSha256:'d36f5881bcdc56726b73e517cd444c13c60732431622da7268145355c8d38e9c',sourceRevision:'f8db63096c8282cb27354314d896feba5ba6ff8a'},inputViews,
        settings:{numInferenceSteps:25,octreeResolution:256,numChunks:8000,seed:12345,targetLongestEdgeMm:job.targetLongestEdgeMm},transformToPrintCoordinates:{normalizationStrategy:'Y-up to Z-up, uniform scale, center XY, bottom Z=0'},fullPrintMesh:{boundsMm:[[0,0,0],[20,10,8]],sha256:'0'.repeat(64)},
        importReadyStl:'print-ready-z-up-full.stl',
      })); return {dir};
    }});
    const job=await store.create({views:views(),targetLongestEdgeMm:20}); job.agentRunActive=true;
    await store.execute(job.id,'inspect',{},'agh');
    const result=await store.execute(job.id,'generate',{},'agh'); assert.equal(result.success,false); assert.equal(result.code,'GENERATION_OUTPUT_HASH_MISMATCH');
    assert.equal(Object.keys(job.candidates).length,0);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('generator contract accepts actual 240000-faces artifact and checks all applied settings',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'reconstruction-cli-contract-')); let artifact;
  let mismatchSettings=false,reportedSide,reportedTag,rightArtifact,swapEndpoints=false;
  try {
    const store=new ReconstructionJobStore({persist:false,generator:async({job,settings})=>{
      const {createHash}=await import('node:crypto'); const digest=b=>createHash('sha256').update(b).digest('hex');
      const stl=Buffer.from('actual bounded output fixture'); await writeFile(path.join(dir,'print-ready-z-up-240000-faces.stl'),stl);
      await writeFile(path.join(dir,'generation.json'),JSON.stringify({
        model:{repo:'tencent/Hunyuan3D-2mv',revision:'3a761b539b29fe4ff64714813aa9560fd66f5de0',weightsSha256:'d36f5881bcdc56726b73e517cd444c13c60732431622da7268145355c8d38e9c',sourceRevision:'f8db63096c8282cb27354314d896feba5ba6ff8a'},
        sideView:reportedSide,inputViews:Object.fromEntries(['front','left','back'].map(n=>[n,{sha256:job.views[n].sha256,...(n==='left'&&reportedTag?{viewTag:reportedTag}:swapEndpoints?{viewTag:n==='front'?'back':n==='back'?'front':n}:{})}])),
        settings:{numInferenceSteps:settings.steps,octreeResolution:settings.resolution,numChunks:settings.numChunks+(mismatchSettings?1:0),seed:settings.seed,targetLongestEdgeMm:job.targetLongestEdgeMm},
        transformToPrintCoordinates:{normalizationStrategy:'Y-up to Z-up, uniform scale, center XY, bottom Z=0'},
        fullPrintMesh:{boundsMm:[[0,0,0],[20,10,8]],sha256:digest(stl)},
        importReadyStl:'print-ready-z-up-240000-faces.stl',simplification:{algorithm:'PyMeshLab quadric edge-collapse',faces:240000,vertices:120002,sha256:digest(stl)},
      })); return {dir};
    }});
    const job=await store.create({views:views(),targetLongestEdgeMm:20}); job.agentRunActive=true;
    await store.execute(job.id,'inspect',{},'agh');
    const result=await store.execute(job.id,'generate',{options:{steps:11,resolution:128,numChunks:4000,seed:9}},'agh');
    assert.equal(result.success,true); assert.ok(job.candidates[result.candidateId]); artifact=path.join(reconstructionPaths.generatedRoot,`${result.candidateId}.stl`);
    mismatchSettings=true;
    const other=new ReconstructionJobStore({persist:false,generator:store.generator}); const second=await other.create({views:views(),targetLongestEdgeMm:20});second.agentRunActive=true;await other.execute(second.id,'inspect',{},'agh');
    const bad=await other.execute(second.id,'generate',{options:{steps:11,resolution:128,chunks:4000,seed:9}},'agh');assert.equal(bad.code,'GENERATION_SETTINGS_MISMATCH');
    mismatchSettings=false;
    const right=await store.create({views:views(),targetLongestEdgeMm:20,sideView:'right'});right.agentRunActive=true;await store.execute(right.id,'inspect',{},'agh');
    const missing=await store.execute(right.id,'generate',{},'agh');assert.equal(missing.code,'GENERATION_VIEW_TAG_MISMATCH');
    reportedSide='right';reportedTag='left';const wrong=await store.create({views:views(),targetLongestEdgeMm:20,sideView:'right'});wrong.agentRunActive=true;await store.execute(wrong.id,'inspect',{},'agh');
    const wrongTag=await store.execute(wrong.id,'generate',{},'agh');assert.equal(wrongTag.code,'GENERATION_VIEW_TAG_MISMATCH');
    reportedTag='right';const correct=await store.create({views:views(),targetLongestEdgeMm:20,sideView:'right'});correct.agentRunActive=true;await store.execute(correct.id,'inspect',{},'agh');
    const ok=await store.execute(correct.id,'generate',{},'agh');assert.equal(ok.success,true);assert.equal(ok.generation.sideView,'right');rightArtifact=path.join(reconstructionPaths.generatedRoot,`${ok.candidateId}.stl`);
    swapEndpoints=true;const swapped=await store.create({views:views(),targetLongestEdgeMm:20,sideView:'right'});swapped.agentRunActive=true;await store.execute(swapped.id,'inspect',{},'agh');
    const swappedResult=await store.execute(swapped.id,'generate',{},'agh');assert.equal(swappedResult.code,'GENERATION_VIEW_TAG_MISMATCH');
  } finally { await rm(dir,{recursive:true,force:true}); for(const file of [artifact,rightArtifact].filter(Boolean))await (await import('node:fs/promises')).rm(file,{force:true}); }
});

test('GPU generation is single-flight and rejects a competing job as busy',async()=>{
  let unblock; const gate=new Promise(resolve=>{unblock=resolve;});
  const store=new ReconstructionJobStore({persist:false,generator:async()=>gate});
  const first=await store.create({views:views(),targetLongestEdgeMm:20}); const second=await store.create({views:views(),targetLongestEdgeMm:20}); first.agentRunActive=true; second.agentRunActive=true; first.viewsInspected=true; second.viewsInspected=true;
  const running=store.execute(first.id,'generate',{},'agh');
  await new Promise(resolve=>setImmediate(resolve));
  const busy=await store.execute(second.id,'generate',{},'agh'); assert.equal(busy.code,'GPU_BUSY');
  unblock({dir:path.join(tmpdir(),'missing-reconstruction-output')}); await running; assert.equal(store.gpuActive,false);
});

test('a late successful AGH return cannot overwrite interruption state',async()=>{
  let complete; const pending=new Promise(resolve=>{complete=resolve;});
  const store=new ReconstructionJobStore({persist:false}); const job=await store.create({views:views(),targetLongestEdgeMm:20});
  const running=store.startAgent(job.id,async()=>pending); await new Promise(resolve=>setImmediate(resolve));
  job.agentRunActive=false; job.stage='interrupted'; job.accessToken='rotated-token';
  complete({success:true,execution:{mode:'agh',sessionId:'late'}}); await running;
  assert.equal(job.stage,'interrupted'); assert.equal(job.accessToken,'rotated-token');
});

test('a changed candidate file fails SHA verification before it can be served', async()=>{
  const {store,server,base,close}=await fixture();
  let full;
  try {
    const job=await store.create({views:views(),targetLongestEdgeMm:20}); const id='c'.repeat(64); const file=`${id}.stl`;
    await (await import('node:fs/promises')).mkdir(reconstructionPaths.generatedRoot,{recursive:true});
    full=path.join(reconstructionPaths.generatedRoot,file); await writeFile(full,'original');
    job.candidates[id]={jobId:job.id,candidateId:id,stlFile:file,stlSha256:'0'.repeat(64),geometryChecks:{passed:true}};
    const response=await fetch(`${base}/api/reconstruction/jobs/${job.id}/stl/${id}`); assert.equal(response.status,400);
  } finally { await close(); if(full) await (await import('node:fs/promises')).rm(full,{force:true}); }
});
