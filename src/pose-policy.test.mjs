import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import modeling from '@jscad/modeling';
import serializer from '@jscad/stl-serializer';
import {PoseJobStore} from './pose-jobs.mjs';
import {buildPoseDecision,POSE_PROFILE_ID} from './pose-comparison.mjs';
const four=['upright','tilt-x-plus','tilt-x-minus','tilt-y-plus'],five=[...four,'face-up'];
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'pose-policy-'));const b=Buffer.concat(serializer.serialize({binary:true},modeling.transforms.translate([0,0,5],modeling.primitives.cuboid({size:[10,10,10]}))).map(x=>Buffer.from(x))),sha=createHash('sha256').update(b).digest('hex'),file=join(dir,'source.stl');await writeFile(file,b);const store=new PoseJobStore({persist:false,sourceLoader:async()=>({sourceJobId:'12345678-1234-4234-8234-123456789012',candidateId:sha,sourceSha256:sha,sourceStlPath:file}),evaluate:async({poseId})=>({poseId,sourceSha256:sha,status:poseId==='face-up'?'verified':'unverified',poseProof:{rigidTransformVerified:true,candidateSha256:sha},slice:{metrics:{filamentG:.8,estimatedTimeSeconds:346},proof:{profileId:POSE_PROFILE_ID,profileSha256:'a'.repeat(64)}},supportAudit:{verified:poseId==='face-up'},protectedRegions:[],criticalFeatures:[]}),verify:async()=>({verified:true,candidateSha256:sha})});return {store,input:{sourceJobId:'12345678-1234-4234-8234-123456789012'}};}
test('versioned five policy cannot select after just the historical four evaluations',async()=>{const {store,input}=await fixture(),j=await store.create({...input,posePolicy:'fixed-five-v2'});j.agentRunActive=true;const inspection=await store.execute(j.id,'inspect');assert.deepEqual(inspection.poses.map(x=>x.id),five);for(const id of four)await store.execute(j.id,'evaluate',{poseId:id});assert.equal((await store.execute(j.id,'select',{poseId:'face-up'})).code,'ALL_POSES_REQUIRED');assert.equal((await store.execute(j.id,'evaluate',{poseId:'face-up'})).success,true);assert.equal(j.decision.recommendedPoseId,'face-up');assert.equal((await store.execute(j.id,'select',{poseId:'face-up'})).success,true);assert.equal((await store.execute(j.id,'verify')).success,true);assert.equal((await store.execute(j.id,'submit')).success,true);await store.finish(j.id,{success:true});assert.equal(j.stage,'completed');});
test('historical/default four policy rejects face-up and remains four after creation',async()=>{const {store,input}=await fixture(),j=await store.create(input);delete j.posePolicy;j.agentRunActive=true;const p=await store.execute(j.id,'inspect');assert.deepEqual(p.poses.map(x=>x.id),four);assert.equal((await store.execute(j.id,'evaluate',{poseId:'face-up'})).code,'POSE_ID_INVALID');});
test('unknown or mutated search policy cannot expose arbitrary poses',async()=>{const {store,input}=await fixture();await assert.rejects(store.create({...input,posePolicy:'arbitrary'}),/POSE_POLICY_INVALID/);});
test('five actual candidates can be compared with a common profile',()=>{const rows=five.map((id,i)=>({poseId:id,sourceSha256:'b'.repeat(64),status:'verified',poseProof:{rigidTransformVerified:true},slice:{metrics:{filamentG:i===4?.8:1,estimatedTimeSeconds:346},proof:{profileId:POSE_PROFILE_ID,profileSha256:'a'.repeat(64)}},supportAudit:{verified:true}}));assert.equal(buildPoseDecision(rows).recommendedPoseId,'face-up');});

for(const corruption of ['mismatched-id','unknown-key'])test('job result binding rejects '+corruption+' before decisions or projection',async()=>{
  const {store,input}=await fixture(),j=await store.create(input);j.agentRunActive=true;
  await store.execute(j.id,'inspect');await store.execute(j.id,'evaluate',{poseId:'upright'});
  if(corruption==='mismatched-id')j.results.upright.poseId='face-up';
  else j.results.unknown={...j.results.upright,poseId:'unknown'};
  assert.throws(()=>store.decisionForJob(j),/POSE_POLICY_CHANGED/);
  assert.throws(()=>store.publicJob(j),/POSE_POLICY_CHANGED/);
});

test('legacy STL slot cannot serve a fifth pose under an allowed four-pose key',async()=>{
  const {store,input}=await fixture(),j=await store.create(input);delete j.posePolicy;delete j.posePolicyFingerprint;
  j.results.upright={poseId:'face-up',stlPath:j.sourceStlPath,poseProof:{candidateSha256:j.source.sourceSha256}};
  await assert.rejects(store.readStl(j,'upright'),/POSE_POLICY_CHANGED/);
});

test('finish rejects a successful submission when an evaluated result disappears',async()=>{
  const {store,input}=await fixture(),j=await store.create({...input,posePolicy:'fixed-five-v2'});j.agentRunActive=true;
  await store.execute(j.id,'inspect');for(const poseId of five)await store.execute(j.id,'evaluate',{poseId});
  await store.execute(j.id,'select',{poseId:'face-up'});await store.execute(j.id,'verify');assert.equal((await store.execute(j.id,'submit')).success,true);
  delete j.results.upright;await store.finish(j.id,{success:true});assert.equal(j.stage,'failed');
});
