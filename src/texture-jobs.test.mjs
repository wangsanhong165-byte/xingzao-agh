import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {TextureJobStore} from './texture-jobs.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const sourceId='1ac90d72-425f-4a6f-b9f8-50248baa6368',candidateId='a'.repeat(64);
async function fixture(){
 const base=path.resolve('data/texture/tests');await mkdir(base,{recursive:true});
 const rootDir=await mkdtemp(path.join(base,'state-'));
 let source=Buffer.from('canonical source'),reference=Buffer.from('reference image');
 const parent={id:sourceId,stage:'completed',submittedCandidateId:candidateId,views:{front:{sha256:sha(reference),name:'front'}},submissionProof:{candidateId,assetSha256:sha(source),sliceMode:'actual-slicer'},candidates:{[candidateId]:{jobId:sourceId,candidateId,stlSha256:sha(source),geometryChecks:{passed:true,stlSha256:sha(source),metrics:{dimensionsMm:{x:20,y:10,z:30}}},slice:{mode:'actual-slicer',execution:{mode:'actual-slicer'},sourceStlSha256:sha(source)}}}};
 const parentStore={load:async id=>id===sourceId?parent:null,readStl:async()=>source,readView:async()=>({bytes:reference,mime:'image/png'})};
 const calls=[];let failStandard=false,workerGate=null;
 const worker=async (req,options)=>{
  calls.push(req.mode);
  if(workerGate)await workerGate(req,options);
  if(req.mode==='generate'&&req.profile==='standard'&&failStandard)return {success:false,code:'TEXTURE_RESOURCE_FAILURE'};
  const bytes=Buffer.from('owned textured GLB');
  if(req.mode==='generate')await writeFile(path.join(req.outputDir,'textured.glb'),bytes);
  return {success:true,code:'OK',attemptId:req.attemptId,profile:req.profile,sourceSha256:req.sourceSha256,referenceSha256:req.referenceSha256,glbSha256:sha(bytes),glbBytes:bytes.length,metrics:{faces:12,textureSizePixels:req.profile==='standard'?[2048,2048]:[1024,1024],geometryPreservedAtFloat32:true},proof:{inputGeometrySignature:'b'.repeat(64),outputGeometrySignature:'b'.repeat(64),coordinateTransform:'Z-up mm to Y-up metres [x,z,-y]/1000',modelRevision:'9cd649ba6913f7a852e3286bad86bfa9a2d83dcf',sourceRevision:'f8db63096c8282cb27354314d896feba5ba6ff8a'}};
 };
 const store=new TextureJobStore({rootDir,parentStore,worker});
 return {store,parent,calls,rootDir,setSource:b=>{source=b;},setFail:v=>{failStandard=v;},setWorkerGate:f=>{workerGate=f;},close:()=>rm(rootDir,{recursive:true,force:true})};
}
async function activate(f){const j=await f.store.create({sourceJobId:sourceId,referenceKind:'flat-illustration'});j.agentRunActive=true;return j;}

test('requires completed submitted geometry/slice parent and explicit supported reference',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.store.create({sourceJobId:sourceId,referenceKind:'photo'}),/TEXTURE_REFERENCE_KIND/);
  f.parent.stage='failed';await assert.rejects(f.store.create({sourceJobId:sourceId,referenceKind:'flat-illustration'}),/TEXTURE_PARENT/);
  f.parent.stage='completed';f.parent.candidates[candidateId].slice.sourceStlSha256='f'.repeat(64);
  await assert.rejects(f.store.create({sourceJobId:sourceId,referenceKind:'flat-illustration'}),/TEXTURE_PARENT/);
 }finally{await f.close();}
});
test('real state requires inspect then generation then independent verification and submission',async()=>{
 const f=await fixture();try{const j=await activate(f);
  assert.equal((await f.store.execute(j.id,'generate',{profile:'standard'},'agh')).success,false);
  assert.equal((await f.store.execute(j.id,'inspect',{},'agh')).success,true);
  assert.equal((await f.store.execute(j.id,'generate',{profile:'standard'},'agh')).success,true);
  assert.equal((await f.store.execute(j.id,'submit',{attemptId:'t01'},'agh')).success,false);
  assert.equal((await f.store.execute(j.id,'verify',{attemptId:'t01'},'agh')).success,true);
  assert.equal((await f.store.execute(j.id,'submit',{attemptId:'t01'},'agh')).success,true);
  await f.store.finish(j.id,{success:true,execution:{mode:'agh'}});
  assert.equal(j.stage,'completed');assert.equal(j.submittedAttemptId,'t01');
  assert.deepEqual(f.calls,['generate','verify','verify']);
  const pub=f.store.publicJob(j);assert.match(pub.attempts[0].glbUrl,/sha=/);
  assert.doesNotMatch(JSON.stringify(pub),/accessToken|sourceStlPath|referenceImagePath|outputDir|dataBase64/);
 }finally{await f.close();}
});
test('compact is allowed only after actual standard resource failure and only two attempts',async()=>{
 const f=await fixture();try{const j=await activate(f);await f.store.execute(j.id,'inspect',{},'agh');
  assert.equal((await f.store.execute(j.id,'generate',{profile:'compact'},'agh')).success,false);
  f.setFail(true);assert.equal((await f.store.execute(j.id,'generate',{profile:'standard'},'agh')).code,'TEXTURE_RESOURCE_FAILURE');
  assert.equal((await f.store.execute(j.id,'generate',{profile:'compact'},'agh')).success,true);
  assert.equal((await f.store.execute(j.id,'generate',{profile:'compact'},'agh')).success,false);
  assert.equal(j.attempts.length,2);assert.equal(f.store.publicJob(j).attempts[1].glbUrl,null);
 }finally{await f.close();}
});
test('source mutation and unverified output are blocked before delivering artifacts',async()=>{
 const f=await fixture();try{const j=await activate(f);await f.store.execute(j.id,'inspect',{},'agh');await f.store.execute(j.id,'generate',{profile:'standard'},'agh');
  await assert.rejects(f.store.readGlb(j,'t01',j.attempts[0].glbSha256),/TEXTURE_DELIVERY/);
  f.setSource(Buffer.from('changed source'));
  assert.equal((await f.store.execute(j.id,'verify',{attemptId:'t01'},'agh')).success,false);
  assert.equal((await f.store.execute(j.id,'submit',{attemptId:'t01'},'agh')).success,false);
 }finally{await f.close();}
});
test('persisted active job becomes interrupted and rotates task credential without rerunning work',async()=>{
 const f=await fixture();try{const j=await activate(f);await f.store.save(j);const originalToken=j.accessToken;
  const restored=new TextureJobStore({rootDir:f.rootDir,parentStore:{load:async()=>f.parent},worker:async()=>{throw new Error('must not run');}});
  const loaded=await restored.load(j.id);assert.equal(loaded.stage,'interrupted');assert.equal(loaded.agentRunActive,false);assert.notEqual(loaded.accessToken,originalToken);
 }finally{await f.close();}
});
test('AGH failure cancels owned execution and a late submit cannot become delivered',async()=>{
 const f=await fixture();try{const j=await activate(f);await f.store.execute(j.id,'inspect',{},'agh');await f.store.execute(j.id,'generate',{profile:'standard'},'agh');await f.store.execute(j.id,'verify',{attemptId:'t01'},'agh');
  let release,entered,signal;const started=new Promise(r=>{entered=r;});
  f.setWorkerGate(async(_req,options)=>{signal=options.signal;entered();await new Promise(r=>{release=r;});});
  const pending=f.store.execute(j.id,'submit',{attemptId:'t01'},'agh');await started;
  await f.store.finish(j.id,{success:false,reason:'AGH_RUN_TIMEOUT'});release();
  const result=await pending;assert.equal(signal.aborted,true);assert.equal(result.success,false);assert.equal(j.stage,'failed');assert.equal(j.submittedAttemptId,null);assert.notEqual(j.attempts[0].status,'submitted');
 }finally{await f.close();}
});
