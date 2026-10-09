import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeProtectionInput,protectionBounds,SurfaceProtectionStore} from './surface-protection-jobs.mjs';
import {posePolicyFingerprint,poseCandidatesForPolicy} from './pose-geometry.mjs';
const source={kind:'imported',candidateId:'a'.repeat(64)};
const input={source,pointInSourceMm:[0,-5,5],sizeMm:[4,4,4],reductionPercent:50};
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(){
 const dir=await mkdtemp(path.join(tmpdir(),'surface-protection-'));const file=path.join(dir,'source.stl');await writeFile(file,'synthetic-source');
 const loaded={sourceStlPath:file,sourceSha256:sha(await readFile(file)),boundsMm:[[-5,-5,0],[5,5,10]]};
 const calls=[],children=new Map();
 const poses={async create(p){calls.push(p);const c={id:'c'.repeat(8)+'-1111-4111-8111-'+'d'.repeat(12),source:{kind:'imported',candidateId:source.candidateId,sourceSha256:loaded.sourceSha256},posePolicy:p.posePolicy,posePolicyFingerprint:posePolicyFingerprint(p.posePolicy),protectedRegions:p.protectedRegions,constraints:{maxRegionSupportPathLengthMm:p.maxRegionSupportPathLengthMm},stage:'prepared',results:{},submittedPoseId:null,recheck:null};children.set(c.id,c);return c;},async startAgent(id){children.get(id).stage='agent-running';},async load(id){return children.get(id)},publicJob(c){return {id:c.id,stage:c.stage,results:[]}},async readStl(){return Buffer.from('delivery')}};
 const baseline={poseId:'upright',status:'verified',protectedRegions:[{id:'important-region',boundsMm:[[-2,-5,3],[2,-1,7]]}],sourceSha256:loaded.sourceSha256,supportAudit:{verified:true,regions:[{id:'important-region',supportPathLengthMm:100}]},slice:{metrics:{filamentG:12,estimatedTimeSeconds:600},proof:{profileSha256:'b'.repeat(64),gcodeSha256:'c'.repeat(64)}},poseProof:{candidateSha256:'d'.repeat(64),rigidTransformVerified:true}};
 const store=new SurfaceProtectionStore({poses,persist:false,dataRoot:dir,sourceLoader:async()=>loaded,evaluate:async(p)=>{assert.deepEqual(p.protectedRegions,baseline.protectedRegions);return structuredClone(baseline)},verify:async()=>({verified:true})});
 return {dir,file,loaded,calls,children,poses,baseline,store,cleanup:async()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));assert.match(path.basename(dir),/^surface-protection-[A-Za-z0-9_-]+$/);await rm(dir,{recursive:true,force:true})}};
}
test('source click produces a source-bounded region of the requested size',()=>{
 assert.deepEqual(normalizeProtectionInput(input),input);
 assert.deepEqual(protectionBounds(input,[[-5,-5,0],[5,5,10]]),[[-2,-5,3],[2,-1,7]]);
 for(const change of [{sizeMm:[0,4,4]},{pointInSourceMm:[0,NaN,3]},{reductionPercent:0},{reductionPercent:91},{unrecognized:true}])assert.throws(()=>normalizeProtectionInput({...input,...change}),/PROTECTION_/);
 assert.throws(()=>protectionBounds({...input,sizeMm:[11,4,4]},[[-5,-5,0],[5,5,10]]),/PROTECTION_/);
});
test('50 percent target uses the verified baseline and freezes a five-pose task',async()=>{
 const f=await fixture();try{
  const p=await f.store.prepare(input);assert.equal(p.baseline.protectedSupportMm,100);assert.equal(p.supportLimitMm,50);
  const started=await f.store.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:true});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].posePolicy,'fixed-five-v2');assert.equal(f.calls[0].maxRegionSupportPathLengthMm,50);
  assert.deepEqual(f.calls[0].protectedRegions,f.baseline.protectedRegions);
  assert.equal((await f.store.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:true})).id,started.id);assert.equal(f.calls.length,1);
 }finally{await f.cleanup()}
});
test('concurrent cold-cache confirmation starts only one child task',async()=>{
 const f=await fixture();try{
  f.store.persist=true;const p=await f.store.prepare(input);
  const create=f.poses.create.bind(f.poses);f.poses.create=async value=>{await new Promise(resolve=>setTimeout(resolve,20));return create(value)};
  const fresh=new SurfaceProtectionStore({poses:f.poses,sourceLoader:f.store.sourceLoader,evaluate:f.store.evaluate,verify:f.store.verify,dataRoot:f.dir});
  const results=await Promise.allSettled(Array.from({length:8},()=>fresh.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:true})));
  assert.equal(f.calls.length,1);
  const fulfilled=results.filter(r=>r.status==='fulfilled').map(r=>r.value.id);assert.ok(fulfilled.length>=1);assert.equal(new Set(fulfilled).size,1);
  for(const r of results.filter(r=>r.status==='rejected'))assert.match(r.reason.message,/PROTECTION_START_BUSY/);
 }finally{await f.cleanup()}
});
test('changed source and stale or absent confirmation cannot launch',async()=>{
 const f=await fixture();try{
  const p=await f.store.prepare(input);
  await assert.rejects(f.store.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:false}),/PROTECTION_/);
  await assert.rejects(f.store.start({proposalId:p.proposalId,fingerprint:'0'.repeat(64),confirmed:true}),/PROTECTION_/);
  await writeFile(f.file,'changed');await assert.rejects(f.store.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:true}),/SOURCE_/);assert.equal(f.calls.length,0);
 }finally{await f.cleanup()}
});
test('zero-support baseline is reported as already clear, not a fake 100 percent saving',async()=>{
 const f=await fixture();try{
  f.baseline.supportAudit.regions[0].supportPathLengthMm=0;const p=await f.store.prepare(input);
  assert.equal(p.alreadyClear,true);await assert.rejects(f.store.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:true}),/BASELINE_ALREADY_CLEAR/);assert.equal(f.calls.length,0);
 }finally{await f.cleanup()}
});
test('changed child protection declaration hides delivery while retaining its completed stage',async()=>{
 const f=await fixture();try{
  const p=await f.store.prepare(input),j=await f.store.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:true});
  const child=f.children.get(j.poseJobId);child.stage='completed';child.constraints.maxRegionSupportPathLengthMm=51;
  const out=await f.store.publicById(j.id);assert.equal(out.stage,'completed');assert.equal(out.delivery,null);assert.match(out.bindingError,/PROTECTION_/);
 }finally{await f.cleanup()}
});
test('verified selected result reports its reduction and binds the download digest',async()=>{
 const f=await fixture();try{
  const p=await f.store.prepare(input),j=await f.store.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:true}),c=f.children.get(j.poseJobId);
  for(const pose of poseCandidatesForPolicy('fixed-five-v2'))c.results[pose.id]={...structuredClone(f.baseline),poseId:pose.id,supportAudit:{verified:true,regions:[{id:'important-region',supportPathLengthMm:40}]}};
  c.stage='completed';c.submittedPoseId='face-up';c.recheck={verified:true};
  const out=await f.store.publicById(j.id);assert.equal(out.best.reductionPercent,60);assert.equal(out.delivery.sha256,'d'.repeat(64));
  assert.equal((await f.store.readDelivery(j.id,'d'.repeat(64))).toString(),'delivery');
  await assert.rejects(f.store.readDelivery(j.id,'0'.repeat(64)),/DELIVERY_UNAVAILABLE/);
  c.results['face-up'].supportAudit.regions[0].supportPathLengthMm=51;
  const changed=await f.store.publicById(j.id);assert.equal(changed.stage,'completed');assert.equal(changed.delivery,null);assert.equal(changed.bindingError,'PROTECTION_TARGET_NOT_MET');
 }finally{await f.cleanup()}
});
test('independently verified result for a different region cannot satisfy the frozen target',async()=>{
 const f=await fixture();try{
  const p=await f.store.prepare(input),j=await f.store.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:true}),c=f.children.get(j.poseJobId);
  for(const pose of poseCandidatesForPolicy('fixed-five-v2'))c.results[pose.id]={...structuredClone(f.baseline),poseId:pose.id,supportAudit:{verified:true,regions:[{id:'important-region',supportPathLengthMm:40}]}};
  c.stage='completed';c.submittedPoseId='face-up';c.recheck={verified:true};
  c.results[Object.keys(c.results).find(id=>id!=='face-up')].protectedRegions=[{id:'important-region',boundsMm:[[1,1,1],[4,4,4]]}];
  const out=await f.store.publicById(j.id);assert.equal(out.stage,'completed');assert.equal(out.delivery,null);assert.equal(out.best,null);assert.equal(out.bindingError,'PROTECTION_BINDING_CHANGED');
 }finally{await f.cleanup()}
});
test('an unsuccessful alternative does not invalidate a verified selected result',async()=>{
 const f=await fixture();try{
  const p=await f.store.prepare(input),j=await f.store.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:true}),c=f.children.get(j.poseJobId);
  for(const pose of poseCandidatesForPolicy('fixed-five-v2'))c.results[pose.id]={...structuredClone(f.baseline),poseId:pose.id,supportAudit:{verified:true,regions:[{id:'important-region',supportPathLengthMm:40}]}};
  const failedId=Object.keys(c.results).find(id=>id!=='face-up');c.results[failedId]={poseId:failedId,status:'failed',error:'SLICER_FAILED'};
  c.stage='completed';c.submittedPoseId='face-up';c.recheck={verified:true};
  const out=await f.store.publicById(j.id);assert.equal(out.bindingError,null);assert.ok(out.delivery);assert.equal(out.best.reductionPercent,60);
 }finally{await f.cleanup()}
});
test('read-only proposal recovery reports unstarted input without creating a task',async()=>{
 const f=await fixture();try{
  const p=await f.store.prepare(input),out=await f.store.resolveProposal(p.proposalId,p.fingerprint);
  assert.equal(out.state,'prepared');assert.deepEqual(out.proposal.pointInSourceMm,input.pointInSourceMm);assert.deepEqual(out.proposal.sizeMm,input.sizeMm);assert.equal(out.jobId,null);assert.equal(f.calls.length,0);
  await assert.rejects(f.store.resolveProposal(p.proposalId,'0'.repeat(64)),/PROTECTION_PROPOSAL_STALE/);
  await writeFile(f.file,'changed');await assert.rejects(f.store.resolveProposal(p.proposalId,p.fingerprint),/SOURCE_HASH_MISMATCH/);
 }finally{await f.cleanup()}
});
test('lost start response recovers the same persisted job without a second start',async()=>{
 const f=await fixture();try{
  f.store.persist=true;const p=await f.store.prepare(input),j=await f.store.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:true});
  const fresh=new SurfaceProtectionStore({poses:f.poses,sourceLoader:f.store.sourceLoader,evaluate:f.store.evaluate,verify:f.store.verify,dataRoot:f.dir});
  const out=await fresh.resolveProposal(p.proposalId,p.fingerprint);assert.equal(out.state,'started');assert.equal(out.jobId,j.id);assert.equal(out.poseJobId,j.poseJobId);assert.equal(f.calls.length,1);
 }finally{await f.cleanup()}
});
test('read-only recovery distinguishes an in-flight start from an unstarted proposal',async()=>{
 const f=await fixture();let release;try{
  const p=await f.store.prepare(input),create=f.poses.create.bind(f.poses);let entered;const ready=new Promise(r=>entered=r);
  f.poses.create=async value=>{entered();await new Promise(r=>release=r);return create(value)};
  const pending=f.store.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:true});await ready;
  const out=await f.store.resolveProposal(p.proposalId,p.fingerprint);assert.equal(out.state,'starting');assert.equal(out.jobId,null);assert.equal(f.calls.length,0);
  release();release=null;const j=await pending;assert.equal((await f.store.resolveProposal(p.proposalId,p.fingerprint)).jobId,j.id);assert.equal(f.calls.length,1);
 }finally{release?.();await f.cleanup()}
});
test('mapped prepared task after a restart is interrupted rather than polled forever',async()=>{
 const f=await fixture();try{
  f.store.persist=true;const p=await f.store.prepare(input),j=await f.store.start({proposalId:p.proposalId,fingerprint:p.fingerprint,confirmed:true});
  const child=f.children.get(j.poseJobId);child.stage='prepared';child.agentRunActive=false;
  const file=path.join(f.dir,'proposals',p.proposalId,'state.json'),saved=JSON.parse(await readFile(file,'utf8'));saved.starting=true;await writeFile(file,JSON.stringify(saved));
  const fresh=new SurfaceProtectionStore({poses:f.poses,sourceLoader:f.store.sourceLoader,evaluate:f.store.evaluate,verify:f.store.verify,dataRoot:f.dir});
  const state=await fresh.resolveProposal(p.proposalId,p.fingerprint);assert.equal(state.state,'interrupted');assert.equal(state.jobId,j.id);
  const out=await fresh.publicById(j.id);assert.equal(out.stage,'interrupted');assert.equal(out.error,'PROTECTION_TASK_INTERRUPTED_BEFORE_EXECUTION');assert.equal(out.delivery,null);assert.equal(f.calls.length,1);assert.equal(child.stage,'prepared');
 }finally{await f.cleanup()}
});
