import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {poseCandidatesForPolicy,posePolicyFingerprint} from './pose-geometry.mjs';
const module = await import('./workflow-jobs.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,{pose='needs-repair',unknown=false,otherFailure=false,badCosts=false}={}){
  assert.equal(typeof module.WorkflowJobStore,'function','WorkflowJobStore must exist');
  const dir=await mkdtemp(join(tmpdir(),'workflow-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'source.stl'),bytes=Buffer.from('verified loader seam: original source'),sha=hash(bytes);await writeFile(path,bytes);
  const ref={kind:'imported',candidateId:'a'.repeat(64)};const source={kind:'imported',candidateId:ref.candidateId,sourceStlPath:path,sourceSha256:sha,boundsMm:[[-6,-4,0],[6,4,30]]};
  const spec={axis:'z',centerLineMm:[[-3,0,2],[-3,0,28]],allowedBoundsMm:[[-3.48,-.48,2],[-2.52,.48,28]],maxRadialGrowthMm:.2,maxAddedVolumeMm3:20};
  const input={source:ref,pointInSourceMm:[-2.75,0,15],axis:'z',maxRadialGrowthMm:.2,maxAddedVolumeMm3:20};
  let poseInput, repairInput, repairRuns=0,verifications=0;
  const poses={job:null,async create(i){poseInput=i;return this.job={id:'pose',source:{...ref,sourceSha256:sha},stage:'prepared',results:{},criticalFeatures:i.criticalFeatures,constraints:{maxRegionSupportPathLengthMm:null}};},async startAgent(){this.job.stage=pose==='original'?'completed':'no-feasible';this.job.submittedPoseId=pose==='original'?'upright':null;this.job.recheck=pose==='original'?{verified:true}:null;this.job.results.upright={poseId:'upright',status:'verified',sourceSha256:sha,poseProof:{candidateSha256:'b'.repeat(64)},slice:{metrics:{filamentG:.8,estimatedTimeSeconds:346},proof:{profileSha256:'d'.repeat(64)}},supportAudit:{verified:!unknown,protectionVerified:true,regions:pose==='support'?[{supportPathLengthMm:12}]:[]},protectionVerified:true,featureAudit:{verified:!unknown,passed:pose==='original'||pose==='support',features:[{id:'selected-rod',verified:!unknown,passed:pose==='original'||pose==='support'},...(otherFailure?[{id:'hole',verified:true,passed:false}]:[])]},continuousRods:poseInput.continuousRods,rodContinuityAudits:[{id:'selected-rod',audit:{verified:!unknown,passed:pose==='original'||pose==='support'}}]};if(pose==='support')this.job.constraints.maxRegionSupportPathLengthMm=0;},async load(){return this.job;},publicJob(j){return {...j};},async verify(){verifications++;return {verified:true};},async readStl(){return bytes;}};
  const runPose=poses.startAgent.bind(poses);poses.startAgent=async()=>{await runPose();poses.job.posePolicy=poseInput.posePolicy;poses.job.posePolicyFingerprint=posePolicyFingerprint(poseInput.posePolicy);poses.job.continuousRods=poseInput.continuousRods;poses.job.results.upright.criticalFeatures=poseInput.criticalFeatures;poses.job.results.upright.poseProof.rigidTransformVerified=true;if(badCosts)poses.job.results.upright.slice.metrics.filamentG=0;for(const p of poseCandidatesForPolicy(poseInput.posePolicy))if(!poses.job.results[p.id])poses.job.results[p.id]={...structuredClone(poses.job.results.upright),poseId:p.id};poses.job.decision={rejected:Object.values(poses.job.results).map(r=>({poseId:r.poseId,reason:badCosts?'COST_METRICS_UNVERIFIED':'CRITICAL_FEATURE_NOT_RETAINED'}))};};
  const repairs={job:null,async create(i){repairInput=i;return this.job={id:'repair',stage:'prepared',candidates:{},sourceSha256:sha,parent:{jobId:poses.job.id,sourceSha256:sha},targetFeatureId:'selected-rod',criticalFeatures:poseInput.criticalFeatures,spec:i.spec};},async startAgent(){repairRuns++;this.job.stage='completed';this.job.submittedCandidateId='r01';this.job.recheck={verified:true};this.job.candidates.r01={candidateId:'r01',result:{poseProof:{candidateSha256:'c'.repeat(64)}},metrics:{filamentG:.69,estimatedTimeSeconds:557}};},async load(){return this.job;},publicJob(j){return {...j};},async readDeliveryStl(){verifications++;return bytes;}};
  const store=new module.WorkflowJobStore({persist:false,loadSource:async()=>source,propose:async(args)=>({sourceSha256:sha,spec:{...spec,maxRadialGrowthMm:args.maxRadialGrowthMm,maxAddedVolumeMm3:args.maxAddedVolumeMm3},inspection:{verified:true,measuredRadiusMm:.25}}),poses,repairs});
  return {store,input,path,bytes,source,poses,repairs,get poseInput(){return poseInput;},get repairInput(){return repairInput;},get repairRuns(){return repairRuns;},get verifications(){return verifications;}};
}
const confirmation=(f,j)=>({id:j.id,contractHash:j.contractHash,confirmed:true,source:f.input.source,axis:f.input.axis,maxRadialGrowthMm:f.input.maxRadialGrowthMm,maxAddedVolumeMm3:f.input.maxAddedVolumeMm3});
test('preparation freezes original feature separately from growth envelope and budgets',async t=>{const f=await fixture(t),j=await f.store.prepare(f.input);assert.equal(j.stage,'prepared');assert.equal(j.target.measuredRadiusMm,.25);assert.notDeepEqual(j.target.boundsMm,j.spec.allowedBoundsMm);assert.equal(j.source.sourceSha256,f.source.sourceSha256);assert.equal(j.delivery,null);});
test('verified original is delivered without modifying geometry',async t=>{const f=await fixture(t,{pose:'original'}),j=await f.store.prepare(f.input);await f.store.start(confirmation(f,j));await f.store.wait(j.id);const state=await f.store.publicById(j.id);assert.equal(state.stage,'completed');assert.equal(state.delivery.kind,'original');assert.equal(f.repairRuns,0);await f.store.readDelivery(j.id,state.delivery.candidateSha256);assert.ok(f.verifications>0);assert.equal(f.poseInput.continuousRods[0].id,'selected-rod');});
test('only verified target failure chains into repair with same confirmed spec',async t=>{const f=await fixture(t),j=await f.store.prepare(f.input);await f.store.start(confirmation(f,j));await f.store.wait(j.id);const state=await f.store.publicById(j.id);assert.equal(state.stage,'completed');assert.equal(state.delivery.kind,'repaired');assert.equal(f.repairInput.parentPoseJobId,'pose');assert.deepEqual(f.repairInput.spec,j.spec);assert.equal(f.repairInput.coordinatesConfirmed,true);assert.equal(f.repairRuns,1);});
for(const config of [{pose:'support'},{unknown:true},{otherFailure:true}])test('unsupported/unknown/non-target failure never causes blind repair '+JSON.stringify(config),async t=>{const f=await fixture(t,config),j=await f.store.prepare(f.input);await f.store.start(confirmation(f,j));await f.store.wait(j.id);const state=await f.store.publicById(j.id);assert.equal(state.stage,'stopped');assert.equal(state.delivery,null);assert.equal(f.repairRuns,0);});
test('changed budget or source invalidates start confirmation',async t=>{const f=await fixture(t),j=await f.store.prepare(f.input);await assert.rejects(f.store.start({...confirmation(f,j),maxRadialGrowthMm:.02}),/WORKFLOW_CONFIRMATION_CHANGED/);await assert.rejects(f.store.start({...confirmation(f,j),source:{kind:'imported',candidateId:'e'.repeat(64)}}),/WORKFLOW_CONFIRMATION_CHANGED/);assert.equal(f.poses.job,null);});
test('changed source bytes are rejected before AGH runs',async t=>{const f=await fixture(t),j=await f.store.prepare(f.input);await writeFile(f.path,'changed');await assert.rejects(f.store.start(confirmation(f,j)),/SOURCE_HASH_MISMATCH/);assert.equal(f.poses.job,null);});
test('tiny permitted growth stops without another model session',async t=>{const f=await fixture(t);f.input.maxRadialGrowthMm=.02;const j=await f.store.prepare(f.input);await f.store.start(confirmation(f,j));await f.store.wait(j.id);const state=await f.store.publicById(j.id);assert.equal(state.stage,'stopped');assert.equal(state.error,'NO_ALLOWED_REPAIR');assert.equal(f.repairRuns,0);});
test('same delegation cannot be started twice',async t=>{const f=await fixture(t,{pose:'original'}),j=await f.store.prepare(f.input);await f.store.start(confirmation(f,j));await assert.rejects(f.store.start(confirmation(f,j)),/WORKFLOW_ALREADY_STARTED/);await f.store.wait(j.id);});
test('existing inspector min/max object bounds are normalized without changing source scale',async t=>{const f=await fixture(t);f.source.boundsMm={min:[-6,-4,0],max:[6,4,30]};const j=await f.store.prepare(f.input);assert.deepEqual(j.source.boundsMm,[[-6,-4,0],[6,4,30]]);await f.store.start(confirmation(f,j));await f.store.wait(j.id);assert.equal((await f.store.publicById(j.id)).stage,'completed');});
test('invalid cost evidence does not authorize a second repair session',async t=>{const f=await fixture(t,{badCosts:true}),j=await f.store.prepare(f.input);await f.store.start(confirmation(f,j));await f.store.wait(j.id);assert.equal((await f.store.publicById(j.id)).stage,'stopped');assert.equal(f.repairRuns,0);});
test('deleting child continuous-rod evidence cannot downgrade an established delivery contract',async t=>{const f=await fixture(t,{pose:'original'}),j=await f.store.prepare(f.input);await f.store.start(confirmation(f,j));await f.store.wait(j.id);const state=await f.store.publicById(j.id);delete f.poses.job.results.upright.continuousRods;delete f.poses.job.results.upright.rodContinuityAudits;await assert.rejects(f.store.readDelivery(j.id,state.delivery.candidateSha256),/WORKFLOW_CHILD_CONTRACT_CHANGED/);});
test('tiny volume budget stops within the fixed radius recipe before a repair session',async t=>{const f=await fixture(t);f.input.maxAddedVolumeMm3=.001;const j=await f.store.prepare(f.input);await f.store.start(confirmation(f,j));await f.store.wait(j.id);assert.equal((await f.store.publicById(j.id)).error,'NO_ALLOWED_REPAIR');assert.equal(f.repairRuns,0);});
test('new delegation freezes five-candidate search in the confirmation',async t=>{const f=await fixture(t),j=await f.store.prepare(f.input);assert.equal(j.searchPolicy?.id,'fixed-five-v2');assert.equal(j.searchPolicy.poseIds.length,5);f.store.jobs.get(j.id).searchPolicy.poseIds.pop();await assert.rejects(f.store.start(confirmation(f,j)),/WORKFLOW_CONTRACT_CHANGED/);});
test('child search policy cannot change after an original delivery',async t=>{const f=await fixture(t,{pose:'original'}),j=await f.store.prepare(f.input);await f.store.start(confirmation(f,j));await f.store.wait(j.id);const result=await f.store.publicById(j.id);f.poses.job.posePolicy='fixed-four-v1';await assert.rejects(f.store.readDelivery(j.id,result.delivery.candidateSha256),/WORKFLOW_CHILD_CONTRACT_CHANGED/);});

for(const corruption of ['missing-fifth','changed-policy','mismatched-id','unknown-key','changed-contract'])test('public delivery is hidden without rewriting completed history after '+corruption,async t=>{
  const f=await fixture(t,{pose:'original'}),j=await f.store.prepare(f.input);await f.store.start(confirmation(f,j));await f.store.wait(j.id);
  const saved=f.store.jobs.get(j.id),originalError=saved.error;
  if(corruption==='missing-fifth')delete f.poses.job.results['face-up'];
  if(corruption==='changed-policy'){f.poses.job.posePolicy='fixed-four-v1';f.poses.job.posePolicyFingerprint=posePolicyFingerprint('fixed-four-v1');}
  if(corruption==='mismatched-id')f.poses.job.results.upright.poseId='face-up';
  if(corruption==='unknown-key')f.poses.job.results.unknown={...f.poses.job.results.upright,poseId:'unknown'};
  if(corruption==='changed-contract')saved.target.measuredRadiusMm=.5;
  const projected=await f.store.publicById(j.id);
  assert.equal(projected.stage,'completed');assert.equal(saved.stage,'completed');assert.equal(projected.error,originalError);
  assert.equal(projected.delivery,null);assert.equal(projected.bindingError,corruption==='changed-contract'?'WORKFLOW_CONTRACT_CHANGED':'WORKFLOW_CHILD_CONTRACT_CHANGED');
});

for(const corruption of ['mismatched-id','unknown-key'])test('workflow download rejects '+corruption+' in the complete child result map',async t=>{
  const f=await fixture(t,{pose:'original'}),j=await f.store.prepare(f.input);await f.store.start(confirmation(f,j));await f.store.wait(j.id);
  const state=await f.store.publicById(j.id);
  if(corruption==='mismatched-id')f.poses.job.results.upright.poseId='face-up';
  else f.poses.job.results.unknown={...f.poses.job.results.upright,poseId:'unknown'};
  await assert.rejects(f.store.readDelivery(j.id,state.delivery.candidateSha256),/WORKFLOW_CHILD_CONTRACT_CHANGED/);
});

test('legacy workflow keeps the exact four-field digest and missing child policy remains four',async t=>{
  const f=await fixture(t,{pose:'original'}),prepared=await f.store.prepare(f.input),saved=f.store.jobs.get(prepared.id);
  delete saved.searchPolicy;
  const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
  const legacyHash=hash(Buffer.from(stable({input:saved.input,source:saved.source,target:saved.target,spec:saved.spec})));saved.contractHash=legacyHash;
  const j=await f.store.publicById(saved.id);await f.store.start(confirmation(f,j));await f.store.wait(j.id);
  delete f.poses.job.posePolicy;delete f.poses.job.posePolicyFingerprint;
  const state=await f.store.publicById(j.id);assert.equal(state.contractHash,legacyHash);assert.equal(saved.contractHash,legacyHash);
  assert.equal(state.searchPolicy.id,'fixed-four-v1');assert.equal(state.searchPolicy.poseIds.length,4);assert.equal(state.bindingError,null);assert.equal(state.delivery.kind,'original');
  await f.store.readDelivery(j.id,state.delivery.candidateSha256);
});
