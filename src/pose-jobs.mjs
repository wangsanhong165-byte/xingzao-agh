import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPoseCandidate, poseCandidatesForPolicy,posePolicyFingerprint,posesForJob } from './pose-geometry.mjs';
import { analyzeSupportPaths } from './support-evaluation.mjs';
import { loadVerifiedReconstructionSource, loadVerifiedImportedSource, evaluatePrintPose, buildPoseDecision, verifyPoseResult, POSE_PROFILE_ID } from './pose-comparison.mjs';
import { normalizeCriticalFeatures } from './critical-feature-service.mjs';
import {normalizeContinuousRods} from './continuous-rod-policy.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const jobsRoot=path.join(root,'data/pose-jobs');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const gcodeDelivered=(job,result)=>job.stage==='completed'&&job.submittedPoseId===result?.poseId&&job.recheck?.verified===true&&/^[a-f0-9]{64}$/u.test(result?.slice?.proof?.gcodeSha256??'')&&job.recheck.gcodeSha256===result.slice.proof.gcodeSha256;
const safeCode=e=>/^[A-Z0-9_]{1,64}$/u.test(e?.message??'')?e.message:'POSE_TASK_FAILED';
const safeExecution=e=>e?Object.fromEntries(['mode','toolTransport','profile','provider','route','model','modelBinding','sessionId','lastSeq','turnReason','startedAt','endedAt','exitCode'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]])):null;

export function assertPoseResultsForJob(job){
  const allowed=posesForJob(job);
  if(!job.results||typeof job.results!=='object'||Array.isArray(job.results)||Object.entries(job.results).some(([id,result])=>!allowed.some(p=>p.id===id)||result?.poseId!==id))throw new Error('POSE_POLICY_CHANGED');
  return allowed;
}

export class PoseJobStore {
  constructor({sourceLoader=loadVerifiedReconstructionSource,importSourceLoader=loadVerifiedImportedSource,evaluate=evaluatePrintPose,verify=verifyPoseResult,runAgent,persist=true}={}){
    this.jobs=new Map();this.sourceLoader=sourceLoader;this.importSourceLoader=importSourceLoader;this.evaluate=evaluate;this.verify=verify;this.runAgent=runAgent;this.persist=persist;
  }
  async save(job){if(this.persist){const dir=path.join(jobsRoot,job.id);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'state.json'),JSON.stringify(job));}}
  get(id){return this.jobs.get(id);}
  async load(id){
    if(this.jobs.has(id))return this.jobs.get(id);if(!this.persist||!uuid.test(id))return null;
    try{const job=JSON.parse(await readFile(path.join(jobsRoot,id,'state.json'),'utf8'));if(job.id!==id)return null;
      if(job.agentRunActive){job.agentRunActive=false;job.stage='interrupted';job.error='POSE_TASK_INTERRUPTED';job.accessToken=randomBytes(32).toString('hex');job.executing=false;await this.save(job);}this.jobs.set(id,job);return job;
    }catch{return null;}
  }
  async create(input){
    if(!input)throw new Error('SOURCE_JOB_ID_INVALID');
    const posePolicy=input.posePolicy??'fixed-four-v1';poseCandidatesForPolicy(posePolicy);
    const sourceKind=input.sourceKind??'reconstructed';
    if(!['reconstructed','imported'].includes(sourceKind))throw new Error('SOURCE_KIND_INVALID');
    if(sourceKind==='reconstructed'&&!uuid.test(input.sourceJobId??''))throw new Error('SOURCE_JOB_ID_INVALID');
    if(sourceKind==='imported'&&!/^[a-f0-9]{64}$/u.test(input.sourceCandidateId??''))throw new Error('SOURCE_CANDIDATE_ID_INVALID');
    const source=sourceKind==='imported'?await this.importSourceLoader(input.sourceCandidateId):await this.sourceLoader(input.sourceJobId),bytes=await readFile(source.sourceStlPath);
    if(hash(bytes)!==source.sourceSha256)throw new Error('SOURCE_HASH_MISMATCH');
    const pose=createPoseCandidate({sourceBuffer:bytes,poseId:'upright'});
    const criticalFeatures=normalizeCriticalFeatures(input.criticalFeatures??[],pose.proof.sourceBoundsMm);
    const continuousRods=normalizeContinuousRods(input.continuousRods??[],criticalFeatures,pose.proof.sourceBoundsMm);
    const featureSource=criticalFeatures.length?(input.featureSource==='demonstration-coordinate-bounds'?'demonstration-coordinate-bounds':'user-submitted-coordinate-bounds'):'none';
    const regions=input.protectedRegions??[];
    if(!Array.isArray(regions)||regions.length>4)throw new Error('PROTECTED_REGIONS_INVALID');
    const limit=input.maxRegionSupportPathLengthMm??null;
    if(limit!==null&&(typeof limit!=='number'||!Number.isFinite(limit)||limit<0||limit>1000000))throw new Error('PROTECTION_LIMIT_INVALID');
    if(limit!==null&&!regions.length)throw new Error('PROTECTION_REGION_REQUIRED');
    if(regions.length&&limit===null)throw new Error('PROTECTION_LIMIT_REQUIRED');
    const seen=new Set();
    for(const region of regions){
      if(!/^[A-Za-z0-9_-]{1,40}$/u.test(region?.id??'')||seen.has(region.id))throw new Error('PROTECTED_REGIONS_INVALID');seen.add(region.id);
      const bounds=region.boundsMm;
      if(!Array.isArray(bounds)||bounds.length!==2||bounds.some(p=>!Array.isArray(p)||p.length!==3||p.some(v=>typeof v!=='number'||!Number.isFinite(v))))throw new Error('PROTECTED_REGIONS_INVALID');
      for(let i=0;i<3;i++)if(bounds[0][i]>=bounds[1][i]||bounds[0][i]<pose.proof.sourceBoundsMm[0][i]-.001||bounds[1][i]>pose.proof.sourceBoundsMm[1][i]+.001)throw new Error('PROTECTED_REGION_OUTSIDE_SOURCE');
    }
    // Validate region geometry through the same auditor, without presenting the
    // empty G-code check as an experiment or successful support result.
    analyzeSupportPaths('',{printToSourceMatrix4:pose.proof.printToSourceMatrix4,placementOffsetMm:{x:90,y:90,z:0},placementVerified:true,protectedRegions:regions,layerHeightMm:.2});
    const regionSource=regions.length?(input.regionSource==='demonstration-coordinate-bounds'?'demonstration-coordinate-bounds':'user-submitted-coordinate-bounds'):'none';
    const job={id:randomUUID(),source:{kind:sourceKind,jobId:source.sourceJobId,candidateId:source.candidateId,sourceSha256:source.sourceSha256,boundsMm:pose.proof.sourceBoundsMm},sourceStlPath:source.sourceStlPath,protectedRegions:structuredClone(regions),regionSource,criticalFeatures,featureSource,constraints:{maxRegionSupportPathLengthMm:limit},profileId:POSE_PROFILE_ID,stage:'prepared',agentRunActive:false,accessToken:randomBytes(32).toString('hex'),toolCalls:0,inspected:false,executing:false,results:{},decision:null,selectedPoseId:null,submittedPoseId:null,recheck:null,events:[],execution:null,error:null};
    if(continuousRods.length)job.continuousRods=continuousRods;
    job.posePolicy=posePolicy;job.posePolicyFingerprint=posePolicyFingerprint(posePolicy);
    this.jobs.set(job.id,job);await this.save(job);return job;
  }
  publicJob(job){
    const base=`/api/poses/jobs/${job.id}`;
    const declared=assertPoseResultsForJob(job);
    return {posePolicy:job.posePolicy??'fixed-four-v1',poseIds:declared.map(p=>p.id),id:job.id,stage:job.stage,agentRunActive:job.agentRunActive,source:job.source,protectedRegions:job.protectedRegions,regionSource:job.regionSource,criticalFeatures:job.criticalFeatures??[],featureSource:job.featureSource??'none',constraints:job.constraints,profileId:job.profileId,decision:job.decision,selectedPoseId:job.selectedPoseId,submittedPoseId:job.submittedPoseId,recheck:job.recheck,error:job.error,events:job.events,execution:safeExecution(job.execution),results:Object.values(job.results).map(r=>({poseId:r.poseId,status:r.status,reason:r.reason??null,poseProof:r.poseProof??null,slice:r.slice?{metrics:r.slice.metrics,proof:r.slice.proof,execution:r.slice.execution,placementVerification:r.slice.placementVerification}:null,supportAudit:r.supportAudit??null,featureAudit:r.featureAudit??null,featureProbeEvidence:r.featureProbeEvidence?Object.fromEntries(['sourceSha256','definitionsSha256','recipeSha256','probesSha256','execution'].map(k=>[k,r.featureProbeEvidence[k]])):null,protectionVerified:r.protectionVerified===true,stlUrl:r.stlPath&&r.poseProof?`${base}/stl/${r.poseId}?sha=${r.poseProof.candidateSha256}`:null,gcodeUrl:gcodeDelivered(job,r)?`${base}/gcode/${r.poseId}?sha=${r.slice.proof.gcodeSha256}`:null}))};
  }
  decisionForJob(job){
    assertPoseResultsForJob(job);
    for(const result of Object.values(job.results))if(JSON.stringify(result.criticalFeatures??[])!==JSON.stringify(job.criticalFeatures??[]))throw new Error('CRITICAL_FEATURE_DECLARATION_MISMATCH');
    for(const result of Object.values(job.results))if(JSON.stringify(result.continuousRods??[])!==JSON.stringify(job.continuousRods??[]))throw new Error('ROD_DECLARATION_MISMATCH');
    return buildPoseDecision(Object.values(job.results),job.constraints);
  }
  async readStl(job,poseId){const allowed=assertPoseResultsForJob(job),result=job.results[poseId];if(!result?.stlPath||!allowed.some(p=>p.id===poseId))throw new Error('POSE_NOT_FOUND');const bytes=await readFile(result.stlPath);if(hash(bytes)!==result.poseProof.candidateSha256)throw new Error('POSE_HASH_MISMATCH');return bytes;}
  async readGcode(job,poseId,expectedSha){
    const allowed=assertPoseResultsForJob(job),result=job.results[poseId];
    if(!allowed.some(p=>p.id===poseId)||!gcodeDelivered(job,result))throw new Error('POSE_DELIVERY_REQUIRED');
    const sha=result.slice.proof.gcodeSha256;
    if(expectedSha!==sha)throw new Error('POSE_STALE_SHA');
    const recheck=await this.verify(result);
    if(!recheck?.verified)throw new Error(recheck?.reason??'POSE_RECHECK_FAILED');
    if(recheck.gcodeSha256!==sha)throw new Error('POSE_EVIDENCE_HASH_MISMATCH');
    const bytes=await readFile(result.slice.gcodePath);
    if(hash(bytes)!==sha)throw new Error('POSE_EVIDENCE_HASH_MISMATCH');
    return bytes;
  }
  async startAgent(id,runAgent=this.runAgent){
    const job=this.get(id);if(!job||job.agentRunActive)throw new Error('POSE_TASK_UNAVAILABLE');job.agentRunActive=true;job.stage='agent-running';await this.save(job);
    try{if(!runAgent)runAgent=(await import('./pose-agh.mjs')).runPoseTask;const result=await runAgent({jobId:job.id,accessToken:job.accessToken,task:{sourceSha256:job.source.sourceSha256,sourceKind:job.source.kind,protectedRegions:job.protectedRegions,regionSource:job.regionSource,criticalFeatures:job.criticalFeatures??[],featureSource:job.featureSource??'none',constraints:job.constraints},serviceUrl:'http://127.0.0.1:4337'});await this.finish(id,result);}catch(error){await this.finish(id,{success:false,reason:safeCode(error)});}
  }
  async finish(id,result){const job=this.get(id);if(!job||!job.agentRunActive)return;job.agentRunActive=false;job.execution=safeExecution(result?.execution);try{const required=assertPoseResultsForJob(job),fullyEvaluated=required.every(p=>job.results[p.id]),success=result?.success===true&&fullyEvaluated&&required.some(p=>p.id===job.submittedPoseId)&&job.recheck?.verified===true;job.stage=success?'completed':fullyEvaluated&&job.decision&&job.decision.recommendedPoseId===null?'no-feasible':'failed';job.error=success?null:job.stage==='no-feasible'?'NO_FEASIBLE_POSE':safeCode({message:result?.reason??'POSE_SUBMISSION_REQUIRED'});}catch(e){job.stage='failed';job.error=safeCode(e);}await this.save(job);}
  async execute(id,tool,input={},source='agh'){
    const job=this.get(id);if(!job||!job.agentRunActive||source!=='agh'||job.toolCalls>=12)return {success:false,code:'POSE_TOOL_ACCESS_DENIED'};
    if(job.executing)return {success:false,code:'POSE_TOOL_BUSY'};
    job.toolCalls++;job.executing=true;const event={tool,poseId:input.poseId??null,source:'agh',at:new Date().toISOString(),success:false,code:'RUNNING',message:'Task tool started'};job.events.push(event);await this.save(job);
    try{
      const required=assertPoseResultsForJob(job);
      let result;
      if(tool==='inspect'){job.inspected=true;result={success:true,source:job.source,protectedRegions:job.protectedRegions,regionSource:job.regionSource,criticalFeatures:job.criticalFeatures??[],featureSource:job.featureSource??'none',constraints:job.constraints,poses:required,posePolicy:job.posePolicy??'fixed-four-v1',profileId:job.profileId,scope:'declared-fixed-rigid-poses-same-source-scale-profile'};}
      else {
        if(!job.inspected)throw new Error('POSE_INSPECT_REQUIRED');
        if(tool==='evaluate'){
          if(!required.some(p=>p.id===input.poseId))throw new Error('POSE_ID_INVALID');if(job.results[input.poseId])throw new Error('POSE_ALREADY_EVALUATED');
          try{job.results[input.poseId]=await this.evaluate({sourceStlPath:job.sourceStlPath,expectedSourceSha256:job.source.sourceSha256,outputDir:path.join(jobsRoot,job.id,input.poseId),poseId:input.poseId,protectedRegions:job.protectedRegions,criticalFeatures:job.criticalFeatures??[],...(job.continuousRods?.length?{continuousRods:job.continuousRods}:{})});}
          catch(error){job.results[input.poseId]={poseId:input.poseId,sourceSha256:job.source.sourceSha256,criticalFeatures:job.criticalFeatures??[],...(job.continuousRods?.length?{continuousRods:job.continuousRods}:{}),status:'failed',reason:safeCode(error)};throw error;}
          job.decision=this.decisionForJob(job);result={success:true,result:this.publicJob(job).results.find(r=>r.poseId===input.poseId),decision:job.decision,allPosesEvaluated:required.every(p=>job.results[p.id])};
        }else if(tool==='select'){
          if(required.some(p=>!job.results[p.id]))throw new Error('ALL_POSES_REQUIRED');job.decision=this.decisionForJob(job);
          if(!job.decision.recommendedPoseId)throw new Error('NO_FEASIBLE_POSE');if(input.poseId!==job.decision.recommendedPoseId)throw new Error('POSE_SELECTION_NOT_RECOMMENDED');
          job.selectedPoseId=input.poseId;job.recheck=null;job.submittedPoseId=null;job.selectionRationale=typeof input.rationale==='string'?input.rationale.slice(0,400):null;result={success:true,selectedPoseId:job.selectedPoseId,decision:job.decision};
        }else if(tool==='verify'){
          if(!job.selectedPoseId)throw new Error('POSE_SELECT_REQUIRED');this.decisionForJob(job);job.recheck=await this.verify(job.results[job.selectedPoseId]);if(!job.recheck.verified)throw new Error(job.recheck.reason??'POSE_RECHECK_FAILED');result={success:true,recheck:job.recheck};
        }else if(tool==='submit'){
          if(!job.selectedPoseId||!job.recheck?.verified)throw new Error('POSE_RECHECK_REQUIRED');
          job.decision=this.decisionForJob(job);if(job.decision.recommendedPoseId!==job.selectedPoseId)throw new Error('POSE_SELECTION_STALE');
          job.recheck=await this.verify(job.results[job.selectedPoseId]);if(!job.recheck.verified)throw new Error(job.recheck.reason??'POSE_RECHECK_FAILED');job.submittedPoseId=job.selectedPoseId;result={success:true,submittedPoseId:job.submittedPoseId,recheck:job.recheck,physicalPrintVerified:false};
        }else throw new Error('POSE_TOOL_UNKNOWN');
      }
      event.success=true;event.code='OK';event.message=`${tool} completed`;return result;
    }catch(error){event.code=safeCode(error);event.message=`${tool} failed`;return {success:false,code:event.code,message:event.message};}
    finally{job.executing=false;await this.save(job);}
  }
}
