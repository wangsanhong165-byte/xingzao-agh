import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PoseJobStore,assertPoseResultsForJob} from './pose-jobs.mjs';
import {createPoseCandidate,EXTENDED_POSE_CANDIDATES,posesForJob,posePolicyFingerprint,transformPoint} from './pose-geometry.mjs';
import {loadVerifiedImportedSource,loadVerifiedReconstructionSource,evaluatePrintPose,verifyPoseResult,buildPoseDecision} from './pose-comparison.mjs';
import {prepareFeatureProbes,verifyFeatureProbeEvidence,normalizeCriticalFeatures} from './critical-feature-service.mjs';
import {auditCriticalFeatures} from './critical-feature-audit.mjs';
import {normalizeRepairSpec,inspectLocalRod,applyLocalRod,verifyLocalRod,repairRadiusOptions,repairServiceInternals} from './local-repair-service.mjs';
import {featureToolpathSvg} from './repair-preview.mjs';
import {auditRodToolpathContinuity} from './rod-toolpath-continuity.mjs';
import {proposeLocalRod,normalizeProposalInput} from './rod-target-proposal.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),jobsRoot=path.join(root,'data/repair-jobs');
const {stable}=repairServiceInternals,hash=b=>createHash('sha256').update(b).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const code=e=>/^[A-Z0-9_]{1,64}$/u.test(e?.message??'')?e.message:'REPAIR_TASK_FAILED';
const execSafe=e=>e?Object.fromEntries(['mode','toolTransport','profile','provider','route','model','modelBinding','sessionId','lastSeq','turnReason','startedAt','endedAt','exitCode'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]])):null;
const poseStore=new PoseJobStore();
const parentLoader=id=>poseStore.load(id);
const sourceLoader=p=>p.source.kind==='imported'?loadVerifiedImportedSource(p.source.candidateId):loadVerifiedReconstructionSource(p.source.jobId);
const frozen=j=>({parent:j.parent,sourceSha256:j.sourceSha256,spec:j.spec,targetFeatureId:j.targetFeatureId,criticalFeatures:j.criticalFeatures,protectedRegions:j.protectedRegions,constraints:j.constraints});

function candidateFeatures(job,radius){
 const axis='xyz'.indexOf(job.spec.axis),center=job.spec.centerLineMm[0];
 return job.criticalFeatures.map(f=>f.id!==job.targetFeatureId?structuredClone(f):{...structuredClone(f),boundsMm:f.boundsMm.map((p,end)=>p.map((v,i)=>i===axis?v:center[i]+(end?1:-1)*(radius+.05)))});
}
async function evaluateCandidate({job,candidateId,receipt}){
 const original=candidateId==='original',sourceStlPath=original?job.sourceStlPath:receipt.candidateStlPath;
 const expectedSourceSha256=original?job.sourceSha256:receipt.candidateSha256;
 const features=original?job.criticalFeatures:candidateFeatures(job,receipt.radiusMm);
 const result=await evaluatePrintPose({sourceStlPath,expectedSourceSha256,outputDir:path.join(jobsRoot,job.id,'slices',candidateId+'-'+randomUUID()),poseId:job.parent.poseId,protectedRegions:job.protectedRegions,criticalFeatures:features});
 let originalProbeEvidence=result.featureProbeEvidence,originalAudit=result.featureAudit;
 if(!original){
  originalProbeEvidence=await prepareFeatureProbes({sourceStlPath:job.sourceStlPath,expectedSourceSha256:job.sourceSha256,features:job.criticalFeatures});
  originalAudit=auditCriticalFeatures(await readFile(result.slice.gcodePath,'utf8'),{probes:originalProbeEvidence.probes,sourceToPrintMatrix4:result.poseProof.sourceToPrintMatrix4,placementOffsetMm:result.slice.placementOffsetMm,placementVerified:result.auditOptions.placementVerified});
 }
 const continuityAudit=auditRodToolpathContinuity(await readFile(result.slice.gcodePath,'utf8'),{centerLineMm:job.spec.centerLineMm,sourceToPrintMatrix4:result.poseProof.sourceToPrintMatrix4,placementOffsetMm:result.slice.placementOffsetMm,placementVerified:result.auditOptions.placementVerified});
 const decision=buildPoseDecision([result],job.constraints),feasible=Boolean(decision.recommendedPoseId&&originalAudit?.verified&&originalAudit.passed&&continuityAudit.verified&&continuityAudit.passed);
 return {candidateId,result,originalProbeEvidence,originalAudit,continuityAudit,feasible,geometryProofSafe:original||receipt.geometry.validation.verified===true,featureAudits:original?[result.featureAudit]:[originalAudit,result.featureAudit],metrics:result.slice?.metrics??null,reasons:[...decision.rejected.map(r=>r.reason),...(!originalAudit?.verified?['ORIGINAL_FEATURE_UNVERIFIED']:!originalAudit.passed?['ORIGINAL_FEATURE_NOT_RETAINED']:[]),...(!continuityAudit.passed?[continuityAudit.code]:[])]};
}
async function verifyCandidate({job,candidate}){
 if(stable(candidate.result.criticalFeatures)!==stable(candidateFeatures(job,candidate.radiusMm))||stable(candidate.originalProbeEvidence.definitions)!==stable(job.criticalFeatures)||candidate.originalProbeEvidence.sourceSha256!==job.sourceSha256||stable(candidate.result.protectedRegions??[])!==stable(job.protectedRegions)||!buildPoseDecision([candidate.result],job.constraints).recommendedPoseId)return {verified:false,reason:'REPAIR_FEATURE_DECLARATION_CHANGED'};
 const geometry=await verifyLocalRod(candidate.receipt);if(!geometry.verified)return geometry;
 const sliced=await verifyPoseResult(candidate.result);if(!sliced.verified)return sliced;
 const originalProbes=await verifyFeatureProbeEvidence(candidate.originalProbeEvidence);if(!originalProbes.verified)return originalProbes;
 const originalAudit=auditCriticalFeatures(await readFile(candidate.result.slice.gcodePath,'utf8'),{probes:candidate.originalProbeEvidence.probes,sourceToPrintMatrix4:candidate.result.poseProof.sourceToPrintMatrix4,placementOffsetMm:candidate.result.slice.placementOffsetMm,placementVerified:true});
 if(!originalAudit.verified||!originalAudit.passed||stable(originalAudit)!==stable(candidate.originalAudit))return {verified:false,reason:'REPAIR_ORIGINAL_FEATURE_RECHECK_FAILED'};
 const continuityAudit=auditRodToolpathContinuity(await readFile(candidate.result.slice.gcodePath,'utf8'),{centerLineMm:job.spec.centerLineMm,sourceToPrintMatrix4:candidate.result.poseProof.sourceToPrintMatrix4,placementOffsetMm:candidate.result.slice.placementOffsetMm,placementVerified:candidate.result.auditOptions.placementVerified});
 if(!continuityAudit.verified||!continuityAudit.passed)return {verified:false,reason:continuityAudit.code};
 if(candidate.continuityAudit&&stable(candidate.continuityAudit)!==stable(continuityAudit))return {verified:false,reason:'REPAIR_CONTINUITY_RECHECK_CHANGED'};
 return {...sliced,verified:true,candidateId:candidate.candidateId,originalSourceSha256:job.sourceSha256,geometry,continuityAudit,scope:'original-source-budget-sampled-features-and-continuous-centreline-rechecked',physicalPrintVerified:false};
}

export class RepairJobStore{
 constructor({persist=true,parentLoader:loadParent=parentLoader,sourceLoader:loadSource=sourceLoader,inspect=inspectLocalRod,apply=applyLocalRod,evaluate=evaluateCandidate,verifyCandidate:verify=verifyCandidate,propose=proposeLocalRod,runAgent}={}){
  this.jobs=new Map();Object.assign(this,{persist,parentLoader:loadParent,sourceLoader:loadSource,inspect,apply,evaluate,verify,propose,runAgent});
 }
 async save(j){if(this.persist){const d=path.join(jobsRoot,j.id);await mkdir(d,{recursive:true});await writeFile(path.join(d,'state.json'),JSON.stringify(j));}}
 get(id){return this.jobs.get(id);}
 async load(id){if(this.jobs.has(id))return this.jobs.get(id);if(!this.persist||!uuid.test(id??''))return null;try{const j=JSON.parse(await readFile(path.join(jobsRoot,id,'state.json'),'utf8'));if(j.id!==id)return null;if(j.agentRunActive){j.agentRunActive=false;j.stage='interrupted';j.error='REPAIR_TASK_INTERRUPTED';j.accessToken=randomBytes(32).toString('hex');j.executing=false;await this.save(j);}this.jobs.set(id,j);return j;}catch{return null;}}
 async publicParent(id){const p=await this.parentLoader(id);if(!p)return null;const result=poseStore.publicJob(p);result.results=result.results.map(r=>({...r,stlUrl:r.poseProof?`/api/repair/parent/${id}/stl/${r.poseId}?sha=${r.poseProof.candidateSha256}`:null}));return result;}
 async resolveParent(input){
  if(!uuid.test(input.parentPoseJobId??'')||!EXTENDED_POSE_CANDIDATES.some(p=>p.id===input.parentPoseId))throw new Error('REPAIR_PARENT_INVALID');
  const parent=await this.parentLoader(input.parentPoseJobId);
  if(!parent||parent.agentRunActive||!['completed','no-feasible'].includes(parent.stage))throw new Error('REPAIR_PARENT_NOT_FINISHED');
  if(!assertPoseResultsForJob(parent).some(p=>p.id===input.parentPoseId))throw new Error('REPAIR_PARENT_INVALID');
  const previous=parent.results[input.parentPoseId],target=parent.criticalFeatures?.find(f=>f.id===input.targetFeatureId);
  const failure=previous?.featureAudit?.features?.find(f=>f.id===target?.id);
  const rodFailure=previous?.rodContinuityAudits?.find(r=>r.id===target?.id)?.audit;
  if(!target||target.kind!=='solid'||previous?.featureAudit?.verified!==true||failure?.verified!==true||(failure.passed!==false&&!(rodFailure?.verified===true&&rodFailure.passed===false)))throw new Error('REPAIR_TARGET_NOT_FAILED');
  if(!/^[a-f0-9]{64}$/u.test(previous.slice?.proof?.profileSha256??''))throw new Error('REPAIR_PARENT_PROFILE_MISSING');
  const source=await this.sourceLoader(parent),bytes=await readFile(source.sourceStlPath),proof=createPoseCandidate({sourceBuffer:bytes,poseId:input.parentPoseId}).proof;
  if(hash(bytes)!==source.sourceSha256||source.sourceSha256!==parent.source.sourceSha256||previous.sourceSha256!==source.sourceSha256||previous.poseProof?.candidateSha256!==proof.candidateSha256)throw new Error('REPAIR_PARENT_SOURCE_CHANGED');
  return {parent,previous,target,source,proof};
 }
 async proposeTarget(input){
  const parsed=normalizeProposalInput(input),{parent,target,source,proof}=await this.resolveParent(input),declaration=stable(parent.criticalFeatures);
  const pointInSourceMm=transformPoint(proof.printToSourceMatrix4,parsed.pointInPrintMm);
  if(pointInSourceMm.some((v,i)=>!Number.isFinite(v)||v<target.boundsMm[0][i]-.05||v>target.boundsMm[1][i]+.05))throw new Error('REPAIR_PICK_OUTSIDE_FEATURE');
  const report=await this.propose({sourceStlPath:source.sourceStlPath,expectedSourceSha256:source.sourceSha256,pointInSourceMm,axis:parsed.axis,maxRadialGrowthMm:parsed.maxRadialGrowthMm,maxAddedVolumeMm3:parsed.maxAddedVolumeMm3});
  const spec=normalizeRepairSpec(report.spec);
  if(report.sourceSha256!==source.sourceSha256||report.inspection?.verified!==true||!Number.isFinite(report.inspection.measuredRadiusMm)||report.inspection.measuredRadiusMm<=0||spec.axis!==parsed.axis||spec.maxRadialGrowthMm!==parsed.maxRadialGrowthMm||spec.maxAddedVolumeMm3!==parsed.maxAddedVolumeMm3)throw new Error('REPAIR_PROPOSAL_INVALID');
  for(let i=0;i<3;i++)if(spec.allowedBoundsMm[0][i]<proof.sourceBoundsMm[0][i]-1e-5||spec.allowedBoundsMm[1][i]>proof.sourceBoundsMm[1][i]+1e-5||pointInSourceMm[i]<spec.allowedBoundsMm[0][i]-.05||pointInSourceMm[i]>spec.allowedBoundsMm[1][i]+.05)throw new Error('REPAIR_PROPOSAL_INVALID');
  const fresh=await this.resolveParent(input);
  if(fresh.source.sourceSha256!==source.sourceSha256||fresh.proof.candidateSha256!==proof.candidateSha256||stable(fresh.parent.criticalFeatures)!==declaration)throw new Error('REPAIR_PARENT_SOURCE_CHANGED');
  return {sourceSha256:source.sourceSha256,poseCandidateSha256:proof.candidateSha256,spec,inspection:report.inspection,helperSha256:report.helperSha256??null,dependencySha256:report.dependencySha256??null,scope:'axis-aligned-circular-rod-proposal',physicalPrintVerified:false};
 }
 async create(input){
  if(input?.coordinatesConfirmed!==true)throw new Error('REPAIR_CONFIRMATION_REQUIRED');
  const {parent,previous,target,source,proof}=await this.resolveParent(input);
  const spec=normalizeRepairSpec(input.spec),criticalFeatures=normalizeCriticalFeatures(parent.criticalFeatures,proof.sourceBoundsMm);
  for(let i=0;i<3;i++)if(spec.allowedBoundsMm[0][i]<proof.sourceBoundsMm[0][i]-1e-5||spec.allowedBoundsMm[1][i]>proof.sourceBoundsMm[1][i]+1e-5)throw new Error('REPAIR_SCOPE_OUTSIDE_SOURCE');
  const j={id:randomUUID(),stage:'prepared',agentRunActive:false,accessToken:randomBytes(32).toString('hex'),parent:{jobId:parent.id,poseId:input.parentPoseId,posePolicy:parent.posePolicy??'fixed-four-v1',posePolicyFingerprint:posePolicyFingerprint(parent.posePolicy??'fixed-four-v1'),sourceSha256:source.sourceSha256,poseCandidateSha256:proof.candidateSha256,profileSha256:previous.slice.proof.profileSha256,sourceKind:parent.source.kind,featureSource:parent.featureSource},sourceStlPath:source.sourceStlPath,sourceSha256:source.sourceSha256,spec,targetFeatureId:target.id,criticalFeatures,protectedRegions:structuredClone(parent.protectedRegions??[]),constraints:structuredClone(parent.constraints??{}),repairOptionsMm:[],candidates:{},original:null,events:[],attempts:0,toolCalls:0,inspected:false,selectedCandidateId:null,submittedCandidateId:null,recheck:null,error:null};
  j.policySha256=hash(Buffer.from(stable(frozen(j))));await this.save(j);this.jobs.set(j.id,j);return j;
 }
 async assertPolicy(j){
  if(j.policySha256!==hash(Buffer.from(stable(frozen(j))))||hash(await readFile(j.sourceStlPath))!==j.sourceSha256)throw new Error('REPAIR_POLICY_CHANGED');
  const p=await this.parentLoader(j.parent.jobId);
  try{
   const expected=posesForJob(j.parent),actual=assertPoseResultsForJob(p);
   if((p.posePolicy??'fixed-four-v1')!==(j.parent.posePolicy??'fixed-four-v1')||!expected.some(pose=>pose.id===j.parent.poseId)||!actual.some(pose=>pose.id===j.parent.poseId))throw new Error('REPAIR_PARENT_POLICY_CHANGED');
  }catch{throw new Error('REPAIR_PARENT_POLICY_CHANGED');}
  if(!p||p.source.sourceSha256!==j.sourceSha256||p.results[j.parent.poseId]?.poseProof?.candidateSha256!==j.parent.poseCandidateSha256||stable(normalizeCriticalFeatures(p.criticalFeatures))!==stable(j.criticalFeatures))throw new Error('REPAIR_PARENT_SOURCE_CHANGED');
  if(p.results[j.parent.poseId].slice?.proof?.profileSha256!==j.parent.profileSha256)throw new Error('REPAIR_PROFILE_CHANGED');
 }
 assertCandidate(j,c){if(!c||c.receipt.sourceSha256!==j.sourceSha256||c.receipt.radiusMm!==c.radiusMm||stable(c.receipt.spec)!==stable(j.spec)||(c.result&&c.result.sourceSha256!==c.receipt.candidateSha256))throw new Error('REPAIR_SOURCE_ANCHOR_CHANGED');if(c.result&&c.result.poseId!==j.parent.poseId)throw new Error('REPAIR_FIXED_POSE_CHANGED');if(c.result?.slice?.proof?.profileSha256!==undefined&&c.result.slice.proof.profileSha256!==j.parent.profileSha256)throw new Error('REPAIR_PROFILE_CHANGED');}
 async startAgent(id,run=this.runAgent){const j=this.get(id);if(!j||j.agentRunActive)throw new Error('REPAIR_TASK_UNAVAILABLE');j.agentRunActive=true;j.stage='agent-running';await this.save(j);try{run??=(await import('./repair-agh.mjs')).runRepairTask;const r=await run({jobId:j.id,accessToken:j.accessToken,task:{parent:j.parent,targetFeatureId:j.targetFeatureId,spec:j.spec},serviceUrl:'http://127.0.0.1:4337/'});await this.finish(id,r);}catch(e){await this.finish(id,{success:false,reason:code(e)});}}
 async finish(id,r){const j=this.get(id);if(!j?.agentRunActive)return;j.agentRunActive=false;j.execution=execSafe(r?.execution);const ok=r?.success===true&&j.submittedCandidateId&&j.recheck?.verified;const exhausted=!j.repairOptionsMm.length||j.repairOptionsMm.every(radius=>Object.values(j.candidates).some(c=>c.radiusMm===radius&&c.evaluated&&c.feasible===false));j.stage=ok?'completed':r?.success===true&&j.original?.feasible===false&&exhausted?'no-feasible':'failed';j.error=ok?null:j.stage==='no-feasible'?'NO_FEASIBLE_REPAIR':r?.reason??'REPAIR_SUBMISSION_REQUIRED';await this.save(j);}
 async execute(id,tool,input={},source='agh'){
  const j=this.get(id);if(!j?.agentRunActive||source!=='agh'||j.toolCalls>=12)return {success:false,code:'REPAIR_TOOL_ACCESS_DENIED'};if(j.executing)return {success:false,code:'REPAIR_TOOL_BUSY'};
  j.toolCalls++;j.executing=true;const event={tool,candidateId:input.candidateId??null,radiusMm:input.radiusMm??null,source:'agh',at:new Date().toISOString(),success:false,code:'RUNNING'};j.events.push(event);await this.save(j);
  try{
   await this.assertPolicy(j);let result;
   if(tool==='inspect'){
    if(j.inspected)throw new Error('REPAIR_ALREADY_INSPECTED');
    j.inspection=await this.inspect({sourceStlPath:j.sourceStlPath,expectedSourceSha256:j.sourceSha256,spec:j.spec,outputDir:path.join(jobsRoot,j.id,'inspect')});
    j.repairOptionsMm=repairRadiusOptions(j.inspection.geometry.inspection,j.spec);j.inspected=true;result={success:true,repairOptionsMm:j.repairOptionsMm,inspection:j.inspection.geometry.inspection,spec:j.spec,originalCandidateId:'original',targetFeatureId:j.targetFeatureId,maxRepairAttempts:3};
   }else{
    if(!j.inspected)throw new Error('REPAIR_INSPECT_REQUIRED');
    if(tool==='evaluate'){
     const cid=input.candidateId,c=cid==='original'?null:j.candidates[cid];if(cid!=='original'&&!c)throw new Error('REPAIR_CANDIDATE_INVALID');if(cid==='original'?j.original:c.evaluated)throw new Error('REPAIR_ALREADY_EVALUATED');
     if(c)this.assertCandidate(j,c);
     const evaluation=await this.evaluate({job:j,candidateId:cid,receipt:c?.receipt});if(evaluation.result?.slice?.proof?.profileSha256!==j.parent.profileSha256||evaluation.result.poseId!==j.parent.poseId)throw new Error('REPAIR_PROFILE_CHANGED');if(cid==='original')j.original=evaluation;else Object.assign(c,evaluation,{evaluated:true});
     result={success:true,candidateId:cid,feasible:evaluation.feasible,metrics:evaluation.metrics,featureAudits:evaluation.featureAudits,continuityAudit:evaluation.continuityAudit??null,reasons:evaluation.reasons??[]};
    }else if(tool==='apply'){
     if(!j.original||j.original.feasible!==false)throw new Error('REPAIR_BASELINE_REQUIRED');if(j.attempts>=3)throw new Error('REPAIR_ATTEMPT_LIMIT');if(!j.repairOptionsMm.includes(input.radiusMm)||Object.values(j.candidates).some(c=>c.radiusMm===input.radiusMm))throw new Error('REPAIR_RADIUS_NOT_OFFERED');
     const cid=`r0${++j.attempts}`;j.recheck=null;j.selectedCandidateId=null;
     const receipt=await this.apply({sourceStlPath:j.sourceStlPath,expectedSourceSha256:j.sourceSha256,spec:j.spec,radiusMm:input.radiusMm,outputDir:path.join(jobsRoot,j.id,cid)});
     if(receipt.sourceSha256!==j.sourceSha256||receipt.radiusMm!==input.radiusMm||stable(receipt.spec)!==stable(j.spec)||receipt.geometry?.validation?.verified!==true)throw new Error('REPAIR_GEOMETRY_CONTRACT_INVALID');
     j.candidates[cid]={candidateId:cid,radiusMm:input.radiusMm,receipt,feasible:null,evaluated:false};result={success:true,candidateId:cid,radiusMm:input.radiusMm,geometry:receipt.geometry.validation};
    }else if(tool==='verify'){
     const c=j.candidates[input.candidateId];if(!c?.evaluated||c.feasible!==true)throw new Error('REPAIR_CANDIDATE_NOT_FEASIBLE');
     this.assertCandidate(j,c);
     if(c.receipt.sourceSha256!==j.sourceSha256||c.receipt.radiusMm!==c.radiusMm||stable(c.receipt.spec)!==stable(j.spec))throw new Error('REPAIR_POLICY_CHANGED');
     const check=await this.verify({job:j,candidate:c});if(!check.verified)throw new Error(check.reason??'REPAIR_RECHECK_FAILED');
     if(check.candidateSha256!==c.result.poseProof.candidateSha256)throw new Error('REPAIR_RECHECK_CANDIDATE_MISMATCH');j.recheck={...check,candidateId:c.candidateId};j.selectedCandidateId=c.candidateId;result={success:true,candidateId:c.candidateId,recheck:j.recheck};
    }else if(tool==='submit'){
     const c=j.candidates[j.selectedCandidateId];if(!c||!j.recheck?.verified||j.recheck.candidateId!==c.candidateId||j.recheck.candidateSha256!==c.result.poseProof.candidateSha256||j.submittedCandidateId)throw new Error('REPAIR_RECHECK_REQUIRED');
     this.assertCandidate(j,c);
     const fresh=await this.verify({job:j,candidate:c});if(!fresh.verified||fresh.candidateSha256!==j.recheck.candidateSha256)throw new Error(fresh.reason??'REPAIR_SUBMIT_RECHECK_FAILED');j.submittedCandidateId=c.candidateId;result={success:true,candidateId:c.candidateId,candidateSha256:fresh.candidateSha256,scope:'verified-virtual-manufacturing-candidate',physicalPrintVerified:false};
    }else throw new Error('REPAIR_TOOL_INVALID');
   }
   await this.assertPolicy(j);event.success=true;event.code='OK';return result;
  }catch(e){event.code=code(e);return {success:false,code:event.code};}finally{j.executing=false;await this.save(j);}
 }
 publicJob(j){
  const expose=c=>{if(!c)return null;const sha=c.result?.poseProof?.candidateSha256;return {candidateId:c.candidateId,radiusMm:c.radiusMm,feasible:c.feasible,geometryProofSafe:c.geometryProofSafe===true,geometryProof:c.receipt?.geometry?.validation??null,metrics:c.metrics??null,featureAudits:c.featureAudits??[],continuityAudit:c.continuityAudit??null,reasons:c.reasons??[],candidateSha256:sha??null,deliveryUrl:j.stage==='completed'&&j.submittedCandidateId===c.candidateId&&j.recheck?.verified===true&&sha?`/api/repair/jobs/${j.id}/delivery/${c.candidateId}?sha=${sha}`:null,stlUrl:sha?`/api/repair/jobs/${j.id}/stl/${c.candidateId}?sha=${sha}`:null};};
  return {id:j.id,stage:j.stage,agentRunActive:j.agentRunActive,parent:j.parent,spec:j.spec,targetFeatureId:j.targetFeatureId,repairOptionsMm:j.repairOptionsMm,criticalFeatures:j.criticalFeatures,events:j.events,execution:execSafe(j.execution),original:expose(j.original),candidates:Object.values(j.candidates).map(expose),selectedCandidateId:j.selectedCandidateId,submittedCandidateId:j.submittedCandidateId,recheck:j.recheck,error:j.error,scope:'confirmed-local-rod-repair-virtual-validation'};
 }
 async readStl(j,cid,sha){await this.assertPolicy(j);const c=cid==='original'?j.original:j.candidates[cid];if(!c?.result?.poseProof||sha!==c.result.poseProof.candidateSha256)throw new Error('REPAIR_STALE_SHA');const bytes=await readFile(c.result.stlPath);if(hash(bytes)!==sha)throw new Error('REPAIR_STL_CHANGED');return bytes;}
 async readDeliveryStl(j,cid,sha){
  await this.assertPolicy(j);const c=j.candidates[cid];
  if(j.stage!=='completed'||j.submittedCandidateId!==cid||j.recheck?.verified!==true||c?.feasible!==true)throw new Error('REPAIR_DELIVERY_REQUIRED');
  if(sha!==c.result?.poseProof?.candidateSha256)throw new Error('REPAIR_STALE_SHA');
  this.assertCandidate(j,c);const fresh=await this.verify({job:j,candidate:c});
  if(!fresh.verified)throw new Error(fresh.reason??'REPAIR_RECHECK_FAILED');
  if(fresh.candidateSha256!==sha)throw new Error('REPAIR_RECHECK_CANDIDATE_MISMATCH');
  return this.readStl(j,cid,sha);
 }
 async toolpathPreview(j,cid){await this.assertPolicy(j);const c=cid==='original'?j.original:j.candidates[cid];if(!c?.result?.slice)throw new Error('REPAIR_PREVIEW_UNAVAILABLE');const bytes=await readFile(c.result.slice.gcodePath);if(hash(bytes)!==c.result.slice.proof.gcodeSha256)throw new Error('REPAIR_GCODE_CHANGED');const bounds=structuredClone(j.spec.allowedBoundsMm),a='xyz'.indexOf(j.spec.axis),feature=j.criticalFeatures.find(f=>f.id===j.targetFeatureId);bounds[0][a]=feature.boundsMm[0][a];bounds[1][a]=feature.boundsMm[1][a];return featureToolpathSvg(bytes.toString('utf8'),{axis:j.spec.axis,boundsMm:bounds,printToSourceMatrix4:c.result.poseProof.printToSourceMatrix4,placementOffsetMm:c.result.slice.placementOffsetMm});}
}
