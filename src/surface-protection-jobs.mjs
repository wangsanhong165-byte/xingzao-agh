import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeWorkflowSource,normalizeWorkflowBounds,loadWorkflowSource} from './workflow-source.mjs';
import {evaluatePrintPose,verifyPoseResult} from './pose-comparison.mjs';
import {PoseJobStore,assertPoseResultsForJob} from './pose-jobs.mjs';
import {posePolicyFingerprint} from './pose-geometry.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const hash=b=>createHash('sha256').update(b).digest('hex');
const stable=v=>Array.isArray(v)?`[${v.map(stable)}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')}}`:JSON.stringify(v);
const fail=c=>{throw new Error(c)},finite=n=>typeof n==='number'&&Number.isFinite(n);
const safe=e=>/^[A-Z0-9_]{1,64}$/u.test(e?.message??'')?e.message:'PROTECTION_FAILED';
const region=p=>[{id:'important-region',boundsMm:p.boundsMm}];
function support(result){const value=result?.supportAudit?.regions?.find(r=>r.id==='important-region')?.supportPathLengthMm;if(!finite(value)||value<0)fail('PROTECTION_SUPPORT_UNVERIFIED');return value;}
function fingerprint(p){return hash(Buffer.from(stable({input:p.input,sourceSha256:p.source.sourceSha256,boundsMm:p.boundsMm,profileSha256:p.baseline.slice.proof.profileSha256,gcodeSha256:p.baseline.slice.proof.gcodeSha256,baselineSupportMm:support(p.baseline)})));}
export function normalizeProtectionInput(input){
 if(!input||Object.keys(input).length!==4||!Object.keys(input).every(k=>['source','pointInSourceMm','sizeMm','reductionPercent'].includes(k)))fail('PROTECTION_INPUT_INVALID');
 const source=normalizeWorkflowSource(input.source);
 for(const [key,valid] of [['pointInSourceMm',v=>finite(v)&&Math.abs(v)<=500],['sizeMm',v=>finite(v)&&v>0&&v<=500]])if(!Array.isArray(input[key])||input[key].length!==3||input[key].some(v=>!valid(v)))fail('PROTECTION_INPUT_INVALID');
 if(!finite(input.reductionPercent)||input.reductionPercent<1||input.reductionPercent>90)fail('PROTECTION_TARGET_INVALID');
 return {source,pointInSourceMm:[...input.pointInSourceMm],sizeMm:[...input.sizeMm],reductionPercent:input.reductionPercent};
}
export function protectionBounds(input,bounds){
 input=normalizeProtectionInput(input);bounds=normalizeWorkflowBounds(bounds);
 const low=[],high=[];
 for(let i=0;i<3;i++){
  const [lo,hi]=[bounds[0][i],bounds[1][i]],p=input.pointInSourceMm[i],size=input.sizeMm[i];
  if(p<lo-1e-5||p>hi+1e-5)fail('PROTECTION_POINT_OUTSIDE_SOURCE');
  if(size>hi-lo+1e-6)fail('PROTECTION_REGION_TOO_LARGE');
  low.push(Math.max(lo,Math.min(p-size/2,hi-size)));high.push(low[i]+size);
 }
 return [low,high];
}
export class SurfaceProtectionStore{
 constructor({poses=new PoseJobStore(),sourceLoader=loadWorkflowSource,evaluate=evaluatePrintPose,verify=verifyPoseResult,persist=true,dataRoot=path.join(ROOT,'data/surface-protection')}={}){
  Object.assign(this,{poses,sourceLoader,evaluate,verify,persist,dataRoot});this.proposals=new Map();this.jobs=new Map();this.preparing=false;
 }
 async save(kind,value){if(this.persist){const dir=path.join(this.dataRoot,kind,value.id);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'state.json'),JSON.stringify(value));}}
 async load(kind,id){
  if(!UUID.test(id??''))return null;
  const map=kind==='proposals'?this.proposals:this.jobs;
  if(map.has(id))return map.get(id);if(!this.persist)return null;
  try{
   const file=path.join(this.dataRoot,kind,id,'state.json'),s=await lstat(file);
   if(!s.isFile()||s.isSymbolicLink()||s.size>1024*1024)return null;
   const value=JSON.parse(await readFile(file,'utf8'));if(value.id!==id)return null;
   // Another read may have completed while this one awaited disk I/O.
   // Return the shared object so confirmation locks cannot split on cold start.
   if(map.has(id))return map.get(id);
   if(kind==='proposals')value.starting=false;
   map.set(id,value);return value;
  }catch{return null;}
 }
 publicProposal(p){const baseline=support(p.baseline);return {proposalId:p.id,fingerprint:p.fingerprint,source:p.input.source,sourceSha256:p.source.sourceSha256,pointInSourceMm:[...p.input.pointInSourceMm],sizeMm:[...p.input.sizeMm],boundsMm:structuredClone(p.boundsMm),baseline:{protectedSupportMm:baseline,...p.baseline.slice.metrics},supportLimitMm:baseline*(1-p.input.reductionPercent/100),reductionPercent:p.input.reductionPercent,alreadyClear:baseline<=1e-8,posePolicy:'fixed-five-v2',scope:'source-region-planned-support-comparison'};}
 assertProposal(p){if(!p||p.fingerprint!==fingerprint(p)||p.baseline.sourceSha256!==p.source.sourceSha256||stable(p.baseline.protectedRegions)!==stable(region(p)))fail('PROTECTION_PROPOSAL_CHANGED');}
 async checkSource(p){if(hash(await readFile(p.source.sourceStlPath))!==p.source.sourceSha256)fail('SOURCE_HASH_MISMATCH');}
 async resolveProposal(id,expectedFingerprint){
  const p=await this.load('proposals',id);
  if(!p||typeof expectedFingerprint!=='string'||expectedFingerprint!==p.fingerprint)fail('PROTECTION_PROPOSAL_STALE');
  this.assertProposal(p);await this.checkSource(p);
  if(p.jobId){
   const j=await this.load('jobs',p.jobId);if(!j||j.proposalId!==p.id)fail('PROTECTION_RECOVERY_INCOMPLETE');
   const child=await this.poses.load(j.poseJobId);this.assertChild(p,child);
   const interrupted=child.stage==='prepared'&&!child.agentRunActive&&!p.starting;
   return {proposalId:p.id,fingerprint:p.fingerprint,state:interrupted?'interrupted':'started',jobId:j.id,poseJobId:j.poseJobId};
  }
  return {proposalId:p.id,fingerprint:p.fingerprint,state:p.starting?'starting':'prepared',jobId:null,proposal:this.publicProposal(p)};
 }
 async prepare(raw){
  if(this.preparing)fail('PROTECTION_PREPARE_BUSY');this.preparing=true;
  try{
   const input=normalizeProtectionInput(raw),source=await this.sourceLoader(input.source),id=randomUUID();
   if(hash(await readFile(source.sourceStlPath))!==source.sourceSha256)fail('SOURCE_HASH_MISMATCH');
   const boundsMm=protectionBounds(input,source.boundsMm),protectedRegions=[{id:'important-region',boundsMm}];
   const baseline=await this.evaluate({sourceStlPath:source.sourceStlPath,expectedSourceSha256:source.sourceSha256,outputDir:path.join(this.dataRoot,'proposals',id,'baseline'),poseId:'upright',protectedRegions});
   if(baseline.status!=='verified'||baseline.supportAudit?.verified!==true||!baseline.poseProof?.rigidTransformVerified||!baseline.slice?.proof?.profileSha256||!baseline.slice?.proof?.gcodeSha256)fail('PROTECTION_BASELINE_UNVERIFIED');
   const proof=await this.verify(baseline);if(!proof?.verified)fail('PROTECTION_BASELINE_RECHECK_FAILED');
   const p={id,input,source,boundsMm,baseline,jobId:null,starting:false};p.fingerprint=fingerprint(p);this.assertProposal(p);await this.checkSource(p);this.proposals.set(id,p);await this.save('proposals',p);return this.publicProposal(p);
  }finally{this.preparing=false;}
 }
 async start(input){
  if(!input||Object.keys(input).length!==3||!Object.keys(input).every(k=>['proposalId','fingerprint','confirmed'].includes(k))||input.confirmed!==true)fail('PROTECTION_CONFIRM_REQUIRED');
  const p=await this.load('proposals',input.proposalId);if(!p||input.fingerprint!==p.fingerprint)fail('PROTECTION_PROPOSAL_STALE');this.assertProposal(p);
  if(p.jobId){const j=await this.load('jobs',p.jobId);return {id:j.id,poseJobId:j.poseJobId,stage:(await this.poses.load(j.poseJobId))?.stage??'interrupted'};}
  if(p.starting)fail('PROTECTION_START_BUSY');if(this.publicProposal(p).alreadyClear)fail('PROTECTION_BASELINE_ALREADY_CLEAR');p.starting=true;
  try{
   await this.checkSource(p);const checked=await this.verify(p.baseline);if(!checked?.verified)fail('PROTECTION_BASELINE_RECHECK_FAILED');
   const ref=p.input.source,child=await this.poses.create({sourceKind:ref.kind,...(ref.kind==='imported'?{sourceCandidateId:ref.candidateId}:{sourceJobId:ref.jobId}),protectedRegions:structuredClone(region(p)),maxRegionSupportPathLengthMm:this.publicProposal(p).supportLimitMm,regionSource:'user-click-confirmed-region',posePolicy:'fixed-five-v2'});
   const j={id:randomUUID(),proposalId:p.id,poseJobId:child.id,error:null};this.jobs.set(j.id,j);p.jobId=j.id;await this.save('jobs',j);await this.save('proposals',p);
   void this.poses.startAgent(child.id).catch(async e=>{j.error=safe(e);await this.save('jobs',j);});return {id:j.id,poseJobId:child.id,stage:'agent-running'};
  }finally{p.starting=false;await this.save('proposals',p);}
 }
 assertChild(p,c){
  if(!c||c.posePolicy!=='fixed-five-v2'||c.source?.sourceSha256!==p.source.sourceSha256||c.source.kind!==p.input.source.kind||stable(c.protectedRegions)!==stable(region(p))||c.constraints?.maxRegionSupportPathLengthMm!==this.publicProposal(p).supportLimitMm)fail('PROTECTION_BINDING_CHANGED');
  if(p.input.source.kind==='imported'&&c.source.candidateId!==p.input.source.candidateId||p.input.source.kind==='reconstructed'&&c.source.jobId!==p.input.source.jobId)fail('PROTECTION_BINDING_CHANGED');
  if(c.posePolicyFingerprint!==posePolicyFingerprint('fixed-five-v2'))fail('PROTECTION_BINDING_CHANGED');
  if(c.stage==='completed'){
   const required=assertPoseResultsForJob(c);if(required.some(x=>!c.results[x.id]))fail('PROTECTION_BINDING_CHANGED');
   for(const r of Object.values(c.results)){
    if(r.status!=='verified')continue;
    if(stable(r.protectedRegions)!==stable(region(p)))fail('PROTECTION_BINDING_CHANGED');
    if(r.sourceSha256!==p.source.sourceSha256||r.slice?.proof?.profileSha256!==p.baseline.slice.proof.profileSha256)fail('PROTECTION_PROFILE_CHANGED');
   }
  }
 }
 async publicById(id){
  const j=await this.load('jobs',id);if(!j)return null;const p=await this.load('proposals',j.proposalId);if(!p)return null;const c=await this.poses.load(j.poseJobId);
  const interrupted=c?.stage==='prepared'&&!c.agentRunActive&&!p.starting;
  const out={id:j.id,poseJobId:j.poseJobId,stage:interrupted?'interrupted':c?.stage??'interrupted',source:p.input.source,sourceSha256:p.source.sourceSha256,boundsMm:structuredClone(p.boundsMm),reductionPercent:p.input.reductionPercent,baseline:this.publicProposal(p).baseline,best:null,pose:null,delivery:null,error:j.error??c?.error??(interrupted?'PROTECTION_TASK_INTERRUPTED_BEFORE_EXECUTION':null),bindingError:null};
  try{
   this.assertProposal(p);await this.checkSource(p);this.assertChild(p,c);out.pose=this.poses.publicJob(c);
   if(c.stage==='completed'){
    const r=c.results[c.submittedPoseId];if(!c.recheck?.verified||r?.status!=='verified')fail('PROTECTION_DELIVERY_UNVERIFIED');
    const baselineCheck=await this.verify(p.baseline),checked=await this.verify(r);if(!baselineCheck?.verified||!checked?.verified)fail('PROTECTION_DELIVERY_RECHECK_FAILED');
    const value=support(r),base=support(p.baseline);if(value>this.publicProposal(p).supportLimitMm+1e-6)fail('PROTECTION_TARGET_NOT_MET');
    out.best={poseId:r.poseId,protectedSupportMm:value,reductionPercent:100*(1-value/base),...r.slice.metrics};out.delivery={url:`/api/protect/jobs/${j.id}/delivery?sha=${r.poseProof.candidateSha256}`,sha256:r.poseProof.candidateSha256};
   }
  }catch(e){out.delivery=null;out.best=null;out.bindingError=safe(e);}
  return out;
 }
 async readDelivery(id,expectedSha){
  const out=await this.publicById(id);if(!out?.delivery||out.delivery.sha256!==expectedSha)fail('PROTECTION_DELIVERY_UNAVAILABLE');
  const j=await this.load('jobs',id),c=await this.poses.load(j.poseJobId);return this.poses.readStl(c,c.submittedPoseId);
 }
}
