import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import modeling from '@jscad/modeling';
import serializer from '@jscad/stl-serializer';
import { PoseJobStore } from './pose-jobs.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceId='12345678-1234-4234-8234-123456789012';
const poses=['upright','tilt-x-plus','tilt-x-minus','tilt-y-plus'];
async function storeFixture({infeasible=false}={}){
  const bytes=Buffer.concat(serializer.serialize({binary:true},modeling.transforms.translate([0,0,5],modeling.primitives.cuboid({size:[10,10,10]}))).map(p=>Buffer.from(p)));
  const sha=createHash('sha256').update(bytes).digest('hex'),dir=path.join(root,'data/pose-tests',randomUUID());await mkdir(dir,{recursive:true});const source=path.join(dir,'source.stl');await writeFile(source,bytes);
  const store=new PoseJobStore({persist:false,sourceLoader:async()=>({sourceJobId:sourceId,candidateId:sha,sourceSha256:sha,sourceStlPath:source}),evaluate:async({poseId})=>({poseId,sourceSha256:sha,status:infeasible?'unverified':'verified',poseProof:{rigidTransformVerified:true,candidateSha256:sha,anglesDeg:[0,0,0]},slice:{metrics:{filamentG:poseId==='upright'?1:2,estimatedTimeSeconds:60},proof:{profileId:'fdm-pla-04-auto-support',profileSha256:'a'.repeat(64)}},supportAudit:{verified:!infeasible,regions:[]},protectionVerified:false}),verify:async()=>({verified:true,candidateSha256:sha,sourceSha256:sha})});
  return {store,sha};
}
test('pose state machine requires inspect, all candidates, selection and file recheck before delivery',async()=>{
  const {store}=await storeFixture(),job=await store.create({sourceJobId:sourceId});job.agentRunActive=true;
  assert.equal((await store.execute(job.id,'submit',{})).success,false);
  assert.equal((await store.execute(job.id,'inspect',{})).success,true);
  await store.execute(job.id,'evaluate',{poseId:'upright'});
  assert.equal((await store.execute(job.id,'select',{poseId:'upright'})).code,'ALL_POSES_REQUIRED');
  for(const poseId of poses.slice(1)) assert.equal((await store.execute(job.id,'evaluate',{poseId})).success,true);
  assert.equal((await store.execute(job.id,'select',{poseId:'tilt-x-plus'})).code,'POSE_SELECTION_NOT_RECOMMENDED');
  assert.equal((await store.execute(job.id,'select',{poseId:'upright'})).success,true);
  assert.equal((await store.execute(job.id,'submit',{})).code,'POSE_RECHECK_REQUIRED');
  assert.equal((await store.execute(job.id,'verify',{})).success,true);
  assert.equal((await store.execute(job.id,'submit',{})).success,true);
  await store.finish(job.id,{success:true,execution:{mode:'agh',model:'agnes-3.0-flash',recordDir:'private'}});
  const safe=store.publicJob(job);
  assert.equal(safe.stage,'completed');assert.equal('accessToken' in safe,false);assert.equal('sourceStlPath' in safe.source,false);assert.equal('recordDir' in safe.execution,false);
});
test('all unverified candidates stop without fabricating a submission',async()=>{
  const {store}=await storeFixture({infeasible:true}),job=await store.create({sourceJobId:sourceId});job.agentRunActive=true;
  await store.execute(job.id,'inspect',{});for(const poseId of poses)await store.execute(job.id,'evaluate',{poseId});
  assert.equal((await store.execute(job.id,'select',{poseId:'upright'})).code,'NO_FEASIBLE_POSE');
  await store.finish(job.id,{success:true});assert.equal(job.stage,'no-feasible');assert.equal(job.submittedPoseId,null);
});
test('tool calls outside active AGH work and malformed protection inputs are rejected',async()=>{
  const {store}=await storeFixture(),job=await store.create({sourceJobId:sourceId});
  assert.equal((await store.execute(job.id,'inspect',{})).success,false);
  await assert.rejects(store.create({sourceJobId:sourceId,protectedRegions:[],maxRegionSupportPathLengthMm:0}),/PROTECTION_REGION_REQUIRED/);
  await assert.rejects(store.create({sourceJobId:sourceId,protectedRegions:[{id:'bad',boundsMm:[[100,100,100],[101,101,101]]}],maxRegionSupportPathLengthMm:0}),/PROTECTED_REGION_OUTSIDE_SOURCE/);
});
test('a timeout after partial evaluation remains a timeout, not a no-feasible judgment',async()=>{
  const {store}=await storeFixture({infeasible:true}),job=await store.create({sourceJobId:sourceId});job.agentRunActive=true;
  await store.execute(job.id,'inspect',{});await store.execute(job.id,'evaluate',{poseId:'upright'});
  await store.finish(job.id,{success:false,reason:'AGH_RUN_TIMEOUT'});
  assert.equal(job.stage,'failed');assert.equal(job.error,'AGH_RUN_TIMEOUT');
});
test('demonstration regions are labeled separately from user-submitted bounds',async()=>{
  const {store}=await storeFixture();
  const job=await store.create({sourceJobId:sourceId,protectedRegions:[{id:'demo',boundsMm:[[-1,-1,1],[1,1,2]]}],maxRegionSupportPathLengthMm:0,regionSource:'demonstration-coordinate-bounds'});
  assert.equal(store.publicJob(job).regionSource,'demonstration-coordinate-bounds');
});
test('imported source and critical features stay explicit and are forwarded to evaluation',async()=>{
  const {store,sha}=await storeFixture();store.importSourceLoader=async()=>({...await store.sourceLoader(sourceId),kind:'imported',sourceJobId:null});
  let received;
  store.evaluate=async args=>{received=args;return {poseId:args.poseId,sourceSha256:sha,status:'verified',criticalFeatures:args.criticalFeatures,poseProof:{rigidTransformVerified:true},slice:{metrics:{filamentG:1,estimatedTimeSeconds:60},proof:{profileId:'fdm-pla-04-auto-support',profileSha256:'a'.repeat(64)}},supportAudit:{verified:true,regions:[]},featureAudit:{verified:true,passed:false},protectionVerified:false};};
  const features=[{id:'pin',kind:'solid',boundsMm:[[-5,-5,0],[5,5,10]],minRetention:.9}];
  const job=await store.create({sourceKind:'imported',sourceCandidateId:sha,criticalFeatures:features,featureSource:'demonstration-coordinate-bounds'});job.agentRunActive=true;
  await store.execute(job.id,'inspect',{});await store.execute(job.id,'evaluate',{poseId:'upright'});
  assert.equal(received.criticalFeatures[0].id,'pin');
  assert.equal(store.publicJob(job).source.kind,'imported');
  assert.equal(store.publicJob(job).featureSource,'demonstration-coordinate-bounds');
  assert.equal(job.decision.recommendedPoseId,null);
});
