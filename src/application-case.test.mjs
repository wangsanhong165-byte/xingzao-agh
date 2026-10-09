import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {normalizeApplicationCase,verifyApplicationCase,ApplicationCaseStore} from './application-case.mjs';
const sourceId='11111111-1111-4111-8111-111111111111',textureId='22222222-2222-4222-8222-222222222222',protectionId='33333333-3333-4333-8333-333333333333',poseId='44444444-4444-4444-8444-444444444444';
const sha='a'.repeat(64),candidate='b'.repeat(64),image='c'.repeat(64),color='d'.repeat(64),delivery='e'.repeat(64);
const manifest={id:'yellow-character-print-v1',title:'黄衣角色摆件',sourceJobId:sourceId,textureJobId:textureId,protectionJobId:protectionId};
function snapshots(){return {
 source:{id:sourceId,stage:'completed',submittedCandidateId:candidate,submission:{candidateId:candidate,assetSha256:sha,sliceMode:'actual-slicer'},views:{front:{sha256:image,url:`/api/reconstruction/jobs/${sourceId}/view/front`}},candidates:[{candidateId:candidate,geometryChecks:{passed:true,stlSha256:sha},slice:{mode:'actual-slicer',execution:{mode:'actual-slicer'},sourceStlSha256:sha}}],events:[]},
 texture:{id:textureId,sourceJobId:sourceId,stage:'completed',source:{candidateId:candidate,sha256:sha},reference:{sha256:image},submittedAttemptId:'t01',attempts:[{attemptId:'t01',status:'submitted',glbSha256:color,metrics:{geometryPreservedAtFloat32:true}}],events:[]},
 protection:{id:protectionId,poseJobId:poseId,stage:'completed',source:{kind:'reconstructed',jobId:sourceId},sourceSha256:sha,boundsMm:[[-5,-5,30],[5,0,100]],reductionPercent:30,baseline:{protectedSupportMm:100,filamentG:20,estimatedTimeSeconds:1000},best:{poseId:'face-up',protectedSupportMm:60,reductionPercent:40,filamentG:16,estimatedTimeSeconds:900},delivery:{sha256:delivery},bindingError:null,pose:{id:poseId,stage:'completed',source:{kind:'reconstructed',jobId:sourceId,sourceSha256:sha},submittedPoseId:'face-up',recheck:{verified:true},protectedRegions:[{id:'important-region',boundsMm:[[-5,-5,30],[5,0,100]]}],constraints:{maxRegionSupportPathLengthMm:70},results:[{poseId:'face-up',status:'verified',sourceSha256:sha,slice:{metrics:{filamentG:16,estimatedTimeSeconds:900},proof:{}},poseProof:{candidateSha256:delivery,rigidTransformVerified:true},supportAudit:{verified:true,regions:[{id:'important-region',supportPathLengthMm:60}]}}],events:[]}}
 };}
test('same source case exposes verified color and rigid print delivery with actual tradeoff',()=>{
 const out=verifyApplicationCase(manifest,snapshots());assert.equal(out.state,'verified');assert.equal(out.source.sha256,sha);assert.equal(out.color.sha256,color);assert.equal(out.print.sha256,delivery);assert.ok(Math.abs(out.comparison.materialChangePercent+20)<1e-8);assert.ok(Math.abs(out.comparison.supportReductionPercent-40)<1e-8);
});
test('wrong source, candidate, reference, ROI and delivery identity cannot be combined',()=>{
 const mutations=[s=>s.texture.sourceJobId=textureId,s=>s.texture.source.sha256='f'.repeat(64),s=>s.texture.source.candidateId='f'.repeat(64),s=>s.texture.reference.sha256='f'.repeat(64),s=>s.protection.source.jobId=textureId,s=>s.protection.sourceSha256='f'.repeat(64),s=>s.protection.bindingError='SOURCE_CHANGED',s=>s.protection.pose.protectedRegions[0].boundsMm[0][0]=-6,s=>s.protection.delivery.sha256='f'.repeat(64),s=>delete s.protection.pose.constraints.maxRegionSupportPathLengthMm];
 for(const mutate of mutations){const s=snapshots();mutate(s);assert.throws(()=>verifyApplicationCase(manifest,s),/CASE_/);}
});
test('pending and stopped manufacturing tasks retain stage without inventing a download',()=>{
 for(const stage of ['agent-running','no-feasible']){const s=snapshots();s.protection.stage=stage;s.protection.best=null;s.protection.delivery=null;s.protection.pose.stage=stage;const out=verifyApplicationCase(manifest,s);assert.equal(out.state,stage==='no-feasible'?'stopped':'running');assert.equal(out.print,null);}
});
test('invalid ids and untrusted manifest fields are rejected',()=>{
 assert.deepEqual(normalizeApplicationCase(manifest),manifest);
 assert.throws(()=>normalizeApplicationCase({...manifest,id:'../private'}),/CASE_/);
 assert.throws(()=>normalizeApplicationCase({...manifest,url:'https://foreign.example'}),/CASE_/);
});

async function storedFixture(t){
 const root=path.resolve('data'),dir=await mkdtemp(path.join(root,'test-temp-case-'));
 t.after(async()=>{assert.equal(path.dirname(path.resolve(dir)),root);assert.ok(path.basename(dir).startsWith('test-temp-case-'));await rm(dir,{recursive:true,force:true});});
 const files={source:Buffer.from('source mesh'),color:Buffer.from('color mesh'),print:Buffer.from('rigid print mesh')},sum=b=>createHash('sha256').update(b).digest('hex'),s=snapshots();
 const sourceHash=sum(files.source),colorHash=sum(files.color),printHash=sum(files.print);
 s.source.submission.assetSha256=sourceHash;s.source.candidates[0].geometryChecks.stlSha256=sourceHash;s.source.candidates[0].slice.sourceStlSha256=sourceHash;
 s.texture.source.sha256=sourceHash;s.texture.attempts[0].glbSha256=colorHash;s.protection.sourceSha256=sourceHash;s.protection.pose.source.sourceSha256=sourceHash;s.protection.delivery.sha256=printHash;s.protection.pose.results[0].poseProof.candidateSha256=printHash;
 const previous=structuredClone(s.protection);previous.id='55555555-5555-4555-8555-555555555555';previous.stage='no-feasible';previous.delivery=null;previous.boundsMm=[[-5,-10,30],[5,10,100]];
 const caseDir=path.join(dir,manifest.id);await mkdir(caseDir);await writeFile(path.join(caseDir,'manifest.json'),JSON.stringify(manifest));
 await writeFile(path.join(caseDir,'correction.json'),JSON.stringify({previousProtectionJobId:previous.id}));
 const reads=[];
 const store=new ApplicationCaseStore({dataRoot:dir,sources:{load:async()=>s.source,publicJob:v=>v,readStl:async()=>{reads.push('source');return files.source;}},textures:{load:async()=>s.texture,publicJob:v=>v,readGlb:async()=>{reads.push('color');return files.color;}},protections:{publicById:async id=>id===previous.id?previous:s.protection,readDelivery:async()=>{reads.push('print');return files.print;}}});
 return {store,s,files,reads,previous};
}

test('stored case verifies all actual bytes and retains a failed same-goal correction',async t=>{
 const f=await storedFixture(t),out=await f.store.read(manifest.id);
 assert.deepEqual(out.fileChecks,{source:true,color:true,print:true});assert.deepEqual(f.reads.sort(),['color','print','source']);
 assert.equal(out.correction.previousStage,'no-feasible');assert.equal(out.correction.targetUnchanged,true);assert.notDeepEqual(out.correction.previousBoundsMm,out.correction.currentBoundsMm);
});

test('replaced file bytes and a correction with a different source or target fail closed',async t=>{
 const f=await storedFixture(t);f.files.print=Buffer.from('replaced file');await assert.rejects(f.store.read(manifest.id),/CASE_FILE_CHANGED/);
 f.files.print=Buffer.from('rigid print mesh');f.previous.reductionPercent=10;await assert.rejects(f.store.read(manifest.id),/CASE_CORRECTION_BINDING_CHANGED/);
 f.previous.reductionPercent=30;f.previous.sourceSha256='f'.repeat(64);await assert.rejects(f.store.read(manifest.id),/CASE_CORRECTION_BINDING_CHANGED/);
});

test('unfinished stored case cannot read or expose a final print file',async t=>{
 const f=await storedFixture(t);f.s.protection.stage='no-feasible';f.s.protection.delivery=null;f.s.protection.best=null;f.s.protection.pose.stage='no-feasible';
 const out=await f.store.read(manifest.id);assert.equal(out.state,'stopped');assert.equal(out.print,null);assert.equal(out.fileChecks,undefined);assert.deepEqual(f.reads,[]);
});
