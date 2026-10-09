import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import modeling from '@jscad/modeling';
import serializer from '@jscad/stl-serializer';
import {createPoseCandidate,transformPoint} from './pose-geometry.mjs';
import {RepairJobStore} from './repair-jobs.mjs';

const spec={axis:'z',centerLineMm:[[0,0,3],[0,0,5]],allowedBoundsMm:[[-.5,-.5,3],[.5,.5,5]],maxRadialGrowthMm:.2,maxAddedVolumeMm3:2};
const feature={id:'pin',kind:'solid',boundsMm:[[-.3,-.3,3.35],[.3,.3,4.85]],minRetention:.9,surfaceToleranceMm:.05};
async function fixture(){
 const bytes=Buffer.concat(serializer.serialize({binary:true},modeling.transforms.translate([0,0,5],modeling.primitives.cuboid({size:[10,10,10]}))).map(p=>Buffer.from(p)));
 const sha=createHash('sha256').update(bytes).digest('hex'),dir=path.resolve('data/repair-tests',randomUUID());await mkdir(dir,{recursive:true});const source=path.join(dir,'source.stl');await writeFile(source,bytes);
 const id=randomUUID(),proof=createPoseCandidate({sourceBuffer:bytes,poseId:'upright'}).proof;
 const parent={id,stage:'no-feasible',agentRunActive:false,source:{kind:'imported',candidateId:sha,sourceSha256:sha},criticalFeatures:[structuredClone(feature)],protectedRegions:[],constraints:{maxRegionSupportPathLengthMm:null},results:{upright:{poseId:'upright',status:'verified',sourceSha256:sha,poseProof:proof,slice:{proof:{profileSha256:'a'.repeat(64)}},featureAudit:{verified:true,passed:false,features:[{...feature,verified:true,passed:false}]}}}};
 const store=new RepairJobStore({persist:false,parentLoader:async()=>parent,sourceLoader:async()=>({sourceStlPath:source,sourceSha256:sha}),inspect:async()=>({geometry:{inspection:{measuredRadiusMm:.25,fitToleranceMm:.001}}}),apply:async args=>({candidateStlPath:source,candidateSha256:sha,sourceSha256:sha,spec:args.spec,radiusMm:args.radiusMm,geometry:{validation:{verified:true,addedVolumeMm3:.5}}}),evaluate:async args=>({candidateId:args.candidateId,feasible:args.candidateId!=='original',geometryProofSafe:true,featureAudits:[{verified:true,passed:args.candidateId!=='original'}],result:{sourceSha256:sha,poseId:'upright',poseProof:proof,slice:{proof:{profileSha256:'a'.repeat(64)}},criticalFeatures:[feature],stlPath:source}}),verifyCandidate:async()=>({verified:true,candidateSha256:proof.candidateSha256})});
 return {store,parent,input:{parentPoseJobId:id,parentPoseId:'upright',targetFeatureId:'pin',spec,coordinatesConfirmed:true}};
}
test('repair requires failed original evaluation, allowed radius and fresh candidate recheck before submit',async()=>{
 const {store,input}=await fixture(),j=await store.create(input);j.agentRunActive=true;
 assert.equal((await store.execute(j.id,'apply',{radiusMm:.4})).success,false);
 await store.execute(j.id,'inspect');
 assert.equal((await store.execute(j.id,'apply',{radiusMm:.4})).code,'REPAIR_BASELINE_REQUIRED');
 await store.execute(j.id,'evaluate',{candidateId:'original'});
 assert.equal((await store.execute(j.id,'apply',{radiusMm:1})).code,'REPAIR_RADIUS_NOT_OFFERED');
 const a=await store.execute(j.id,'apply',{radiusMm:.4});assert.equal(a.success,true);assert.equal(a.candidateId,'r01');
 assert.equal((await store.execute(j.id,'verify',{candidateId:'r01'})).code,'REPAIR_CANDIDATE_NOT_FEASIBLE');
 await store.execute(j.id,'evaluate',{candidateId:'r01'});await store.execute(j.id,'verify',{candidateId:'r01'});
 const originalSha=j.candidates.r01.receipt.sourceSha256;j.candidates.r01.receipt.sourceSha256='f'.repeat(64);
 assert.equal((await store.execute(j.id,'submit')).code,'REPAIR_SOURCE_ANCHOR_CHANGED');j.candidates.r01.receipt.sourceSha256=originalSha;
 j.candidates.r01.result.poseId='tilt-x-plus';assert.throws(()=>store.assertCandidate(j,j.candidates.r01),/REPAIR_FIXED_POSE_CHANGED/);j.candidates.r01.result.poseId='upright';
 assert.equal((await store.execute(j.id,'submit')).success,true);
 await store.finish(j.id,{success:true,execution:{model:'deepseek/deepseek-v4.1-flash',recordDir:'private'}});
 assert.equal(j.stage,'completed');const p=store.publicJob(j);assert.equal('accessToken' in p,false);assert.equal('recordDir' in p.execution,false);
});
test('an agent error after baseline evaluation is a failure, not a completed infeasibility result',async()=>{
 const {store,input}=await fixture(),j=await store.create(input);j.agentRunActive=true;
 await store.execute(j.id,'inspect');await store.execute(j.id,'evaluate',{candidateId:'original'});
 await store.finish(j.id,{success:false,reason:'AGH_RUN_FAILED'});assert.equal(j.stage,'failed');assert.equal(j.error,'AGH_RUN_FAILED');
});
test('mutated user budget cannot obtain a geometry operation or delivery',async()=>{
 const {store,input}=await fixture(),j=await store.create(input);j.agentRunActive=true;j.spec.maxRadialGrowthMm=1;
 assert.equal((await store.execute(j.id,'inspect')).code,'REPAIR_POLICY_CHANGED');
});
test('a tight budget stops without producing a fake repaired candidate',async()=>{
 const {store,input}=await fixture();input.spec={...spec,maxRadialGrowthMm:.02};const j=await store.create(input);j.agentRunActive=true;
 await store.execute(j.id,'inspect');await store.execute(j.id,'evaluate',{candidateId:'original'});assert.deepEqual(j.repairOptionsMm,[]);
 await store.finish(j.id,{success:true});assert.equal(j.stage,'no-feasible');assert.equal(j.submittedCandidateId,null);
});
test('requires explicit coordinate confirmation and a failed solid feature in a finished parent',async()=>{
 const {store,input,parent}=await fixture();await assert.rejects(store.create({...input,coordinatesConfirmed:false}),/REPAIR_CONFIRMATION_REQUIRED/);
 parent.results.upright.featureAudit.features[0].passed=true;await assert.rejects(store.create(input),/REPAIR_TARGET_NOT_FAILED/);
 parent.agentRunActive=true;await assert.rejects(store.create(input),/REPAIR_PARENT_NOT_FINISHED/);
});
test('a changed slicer profile cannot become a comparable repaired evaluation',async()=>{
 const {store,input}=await fixture(),normal=store.evaluate;store.evaluate=async args=>{const e=await normal(args);if(args.candidateId!=='original')e.result.slice.proof.profileSha256='b'.repeat(64);return e;};
 const j=await store.create(input);j.agentRunActive=true;await store.execute(j.id,'inspect');await store.execute(j.id,'evaluate',{candidateId:'original'});await store.execute(j.id,'apply',{radiusMm:.4});
 assert.equal((await store.execute(j.id,'evaluate',{candidateId:'r01'})).code,'REPAIR_PROFILE_CHANGED');
});
test('target proposal transforms a surface click to source coordinates and never starts a repair',async()=>{
 const {store,input,parent}=await fixture();let captured;
 store.propose=async args=>{captured=args;return {sourceSha256:parent.source.sourceSha256,spec,inspection:{verified:true,measuredRadiusMm:.25},scope:'axis-aligned-circular-rod-proposal',physicalPrintVerified:false};};
 const point=[.25,0,4],pointInPrintMm=transformPoint(parent.results.upright.poseProof.sourceToPrintMatrix4,point);
 const r=await store.proposeTarget({...input,pointInPrintMm,axis:'z',maxRadialGrowthMm:.2,maxAddedVolumeMm3:2});
 assert.deepEqual(captured.pointInSourceMm,point);assert.deepEqual(r.spec,spec);assert.equal(r.poseCandidateSha256,parent.results.upright.poseProof.candidateSha256);assert.equal(store.jobs.size,0);
 assert.equal('sourceStlPath' in r,false);assert.equal(r.physicalPrintVerified,false);
});
test('proposal rejects stale pose, outside target clicks and expanded returned budgets',async()=>{
 const {store,input,parent}=await fixture();store.propose=async()=>({sourceSha256:parent.source.sourceSha256,spec:{...spec,maxRadialGrowthMm:1},inspection:{verified:true,measuredRadiusMm:.25}});
 const args={...input,pointInPrintMm:[.25,0,4],axis:'z',maxRadialGrowthMm:.2,maxAddedVolumeMm3:2};
 await assert.rejects(store.proposeTarget({...args,pointInPrintMm:[4,4,4]}),/REPAIR_PICK_OUTSIDE_FEATURE/);
 await assert.rejects(store.proposeTarget(args),/REPAIR_PROPOSAL_INVALID/);
 parent.results.upright.poseProof.candidateSha256='b'.repeat(64);await assert.rejects(store.proposeTarget(args),/REPAIR_PARENT_SOURCE_CHANGED/);
});
test('proposal rechecks source and parent after the read-only fitter returns',async()=>{
 const {store,input,parent}=await fixture();store.propose=async()=>{parent.criticalFeatures[0].boundsMm=[[2,2,2],[3,3,3]];return {sourceSha256:parent.source.sourceSha256,spec,inspection:{verified:true,measuredRadiusMm:.25}};};
 await assert.rejects(store.proposeTarget({...input,pointInPrintMm:[.25,0,4],axis:'z',maxRadialGrowthMm:.2,maxAddedVolumeMm3:2}),/REPAIR_PARENT_SOURCE_CHANGED/);
});
test('clicks in a rotated parent STL use its verified inverse, not bed G-code placement',async()=>{
 const {store,input,parent}=await fixture(),source=await store.sourceLoader(parent),{readFile}=await import('node:fs/promises');
 const proof=createPoseCandidate({sourceBuffer:await readFile(source.sourceStlPath),poseId:'tilt-x-plus'}).proof;
 parent.results['tilt-x-plus']={...parent.results.upright,poseId:'tilt-x-plus',poseProof:proof};let measured;
 store.propose=async args=>{measured=args.pointInSourceMm;return {sourceSha256:parent.source.sourceSha256,spec,inspection:{verified:true,measuredRadiusMm:.25}};};
 const sourcePoint=[.25,0,4];await store.proposeTarget({...input,parentPoseId:'tilt-x-plus',pointInPrintMm:transformPoint(proof.sourceToPrintMatrix4,sourcePoint),axis:'z',maxRadialGrowthMm:.2,maxAddedVolumeMm3:2});
 assert.ok(measured.every((v,i)=>Math.abs(v-sourcePoint[i])<1e-10));
});

async function fivePoseFixture(){
 const f=await fixture(),{posePolicyFingerprint}=await import('./pose-geometry.mjs'),source=await f.store.sourceLoader(f.parent),{readFile}=await import('node:fs/promises');
 const proof=createPoseCandidate({sourceBuffer:await readFile(source.sourceStlPath),poseId:'face-up'}).proof;
 f.parent.posePolicy='fixed-five-v2';f.parent.posePolicyFingerprint=posePolicyFingerprint('fixed-five-v2');
 f.parent.results.upright.poseId='upright';f.parent.results['face-up']={...f.parent.results.upright,poseId:'face-up',poseProof:proof};f.input.parentPoseId='face-up';return f;
}

test('new face-up repair freezes the parent policy and fingerprint',async()=>{
 const {store,input,parent}=await fivePoseFixture(),j=await store.create(input);
 assert.equal(j.parent.posePolicy,'fixed-five-v2');assert.equal(j.parent.posePolicyFingerprint,parent.posePolicyFingerprint);
});

for(const corruption of ['downgrade','missing-policy','bad-fingerprint'])test('repair operations and delivery recheck frozen parent policy after '+corruption,async()=>{
 const {store,input,parent}=await fivePoseFixture(),j=await store.create(input),{posePolicyFingerprint}=await import('./pose-geometry.mjs');
 await store.assertPolicy(j);
 if(corruption==='downgrade'){parent.posePolicy='fixed-four-v1';parent.posePolicyFingerprint=posePolicyFingerprint('fixed-four-v1');}
 if(corruption==='missing-policy'){delete parent.posePolicy;delete parent.posePolicyFingerprint;}
 if(corruption==='bad-fingerprint')parent.posePolicyFingerprint='0'.repeat(64);
 j.agentRunActive=true;assert.equal((await store.execute(j.id,'inspect')).code,'REPAIR_PARENT_POLICY_CHANGED');
 await assert.rejects(store.readDeliveryStl(j,'r01','b'.repeat(64)),/REPAIR_PARENT_POLICY_CHANGED/);
});

test('historical repair missing frozen parent policy keeps its original digest and four-pose scope',async()=>{
 const {store,input,parent}=await fixture(),j=await store.create(input),{repairServiceInternals}=await import('./local-repair-service.mjs');
 delete j.parent.posePolicy;delete j.parent.posePolicyFingerprint;
 j.policySha256=createHash('sha256').update(repairServiceInternals.stable({parent:j.parent,sourceSha256:j.sourceSha256,spec:j.spec,targetFeatureId:j.targetFeatureId,criticalFeatures:j.criticalFeatures,protectedRegions:j.protectedRegions,constraints:j.constraints})).digest('hex');
 const oldHash=j.policySha256;await store.assertPolicy(j);assert.equal(j.policySha256,oldHash);assert.equal('posePolicy' in j.parent,false);
 parent.posePolicy='fixed-five-v2';const {posePolicyFingerprint}=await import('./pose-geometry.mjs');parent.posePolicyFingerprint=posePolicyFingerprint('fixed-five-v2');
 await assert.rejects(store.assertPolicy(j),/REPAIR_PARENT_POLICY_CHANGED/);
});
