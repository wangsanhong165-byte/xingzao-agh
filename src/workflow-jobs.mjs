import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeWorkflowSource,normalizeWorkflowBounds,loadWorkflowSource} from './workflow-source.mjs';
import {proposeLocalRod,normalizeProposalInput} from './rod-target-proposal.mjs';
import {normalizeRepairSpec,repairRadiusOptions} from './local-repair-service.mjs';
import {normalizeCriticalFeatures} from './critical-feature-service.mjs';
import {poseCandidatesForPolicy} from './pose-geometry.mjs';
import {assertPoseResultsForJob} from './pose-jobs.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),jobRoot=join(root,'data/workflow-jobs');
const hash=b=>createHash('sha256').update(b).digest('hex');
const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const safe=e=>/^[A-Z0-9_]{1,64}$/u.test(e?.message??'')?e.message:'WORKFLOW_FAILED';
const fail=c=>{throw new Error(c);};
const frozen=j=>({input:j.input,source:j.source,target:j.target,spec:j.spec,...(j.searchPolicy?{searchPolicy:j.searchPolicy}:{})});
const digest=j=>hash(Buffer.from(stable(frozen(j))));
const expectedFeatures=j=>normalizeCriticalFeatures([{id:j.target.id,kind:'solid',boundsMm:j.target.boundsMm,minRetention:.9,surfaceToleranceMm:.05}],j.source.boundsMm);
const expectedRods=j=>[{id:j.target.id,centerLineMm:j.target.centerLineMm}];
function searchForJob(j){const id=j.searchPolicy?.id??'fixed-four-v1',poseIds=poseCandidatesForPolicy(id).map(p=>p.id);if(j.searchPolicy&&stable(j.searchPolicy.poseIds)!==stable(poseIds))fail('WORKFLOW_SEARCH_POLICY_CHANGED');return {id,poseIds};}
function assertPoseBinding(j,p,result){const policy=searchForJob(j);let declared;try{declared=assertPoseResultsForJob(p);}catch{fail('WORKFLOW_CHILD_CONTRACT_CHANGED');}if((p.posePolicy??'fixed-four-v1')!==policy.id||stable(declared.map(x=>x.id))!==stable(policy.poseIds)||(['completed','no-feasible'].includes(p.stage)&&policy.poseIds.some(id=>!p.results[id]))||p.source?.sourceSha256!==j.source.sourceSha256||stable(p.criticalFeatures)!==stable(expectedFeatures(j))||stable(p.continuousRods)!==stable(expectedRods(j))||(result&&(result.sourceSha256!==j.source.sourceSha256||stable(result.criticalFeatures)!==stable(expectedFeatures(j))||stable(result.continuousRods)!==stable(expectedRods(j)))))fail('WORKFLOW_CHILD_CONTRACT_CHANGED');}
function assertRepairBinding(j,r){if(r?.sourceSha256!==j.source.sourceSha256||r.parent?.jobId!==j.poseJobId||r.parent?.sourceSha256!==j.source.sourceSha256||r.targetFeatureId!==j.target.id||stable(r.spec)!==stable(j.spec)||stable(r.criticalFeatures)!==stable(expectedFeatures(j)))fail('WORKFLOW_CHILD_CONTRACT_CHANGED');}
function normalizeInput(input){
  const p=normalizeProposalInput({pointInPrintMm:input?.pointInSourceMm,axis:input?.axis,maxRadialGrowthMm:input?.maxRadialGrowthMm,maxAddedVolumeMm3:input?.maxAddedVolumeMm3});
  return {source:normalizeWorkflowSource(input.source),pointInSourceMm:p.pointInPrintMm,axis:p.axis,maxRadialGrowthMm:p.maxRadialGrowthMm,maxAddedVolumeMm3:p.maxAddedVolumeMm3};
}
export function repairableWorkflowPose(parent,targetId){
  if(parent?.stage!=='no-feasible')return null;
  return Object.values(parent.results??{}).find(r=>{
    const metrics=r.slice?.metrics,rejection=parent.decision?.rejected?.find(x=>x.poseId===r.poseId)?.reason;
    if(r.status!=='verified'||r.poseProof?.rigidTransformVerified!==true||r.supportAudit?.verified!==true||r.featureAudit?.verified!==true||!r.slice?.proof?.profileSha256||!['CRITICAL_FEATURE_NOT_RETAINED','ROD_CONTINUITY_NOT_RETAINED'].includes(rejection)||!Number.isFinite(metrics?.filamentG)||metrics.filamentG<=0||!Number.isFinite(metrics?.estimatedTimeSeconds)||metrics.estimatedTimeSeconds<=0)return false;
    if(parent.constraints?.maxRegionSupportPathLengthMm!==null&&parent.constraints?.maxRegionSupportPathLengthMm!==undefined){
      if(r.protectionVerified!==true||!r.supportAudit.regions?.length||r.supportAudit.regions.some(x=>!Number.isFinite(x.supportPathLengthMm)||x.supportPathLengthMm>parent.constraints.maxRegionSupportPathLengthMm+1e-6))return false;
    }
    const features=r.featureAudit.features??[],f=features.find(x=>x.id===targetId),continuity=r.rodContinuityAudits?.find(x=>x.id===targetId)?.audit;
    if(features.some(x=>x.id!==targetId&&(x.verified!==true||x.passed!==true)))return false;
    if(f?.verified!==true||continuity?.verified!==true)return false;
    return f.passed===false||continuity.passed===false;
  })??null;
}
export class WorkflowJobStore{
  constructor({poses,repairs,loadSource=loadWorkflowSource,propose=proposeLocalRod,persist=true}={}){this.poses=poses;this.repairs=repairs;this.loadSource=loadSource;this.propose=propose;this.persist=persist;this.jobs=new Map();this.runs=new Map();this.activeId=null;}
  async save(j){if(this.persist){await mkdir(join(jobRoot,j.id),{recursive:true});await writeFile(join(jobRoot,j.id,'state.json'),JSON.stringify(j));}}
  async load(id){if(this.jobs.has(id))return this.jobs.get(id);if(!this.persist||!/^[a-f0-9-]{36}$/u.test(id??''))return null;try{const j=JSON.parse(await readFile(join(jobRoot,id,'state.json'),'utf8'));if(j.id!==id)return null;if(j.active){j.active=false;j.stage='interrupted';j.error='WORKFLOW_INTERRUPTED';await this.save(j);}this.jobs.set(id,j);return j;}catch{return null;}}
  async prepare(input){
    const normalized=normalizeInput(input),s={...await this.loadSource(normalized.source)},bytes=await readFile(s.sourceStlPath);s.boundsMm=normalizeWorkflowBounds(s.boundsMm);
    if(hash(bytes)!==s.sourceSha256)fail('SOURCE_HASH_MISMATCH');
    const proposal=await this.propose({sourceStlPath:s.sourceStlPath,expectedSourceSha256:s.sourceSha256,pointInSourceMm:normalized.pointInSourceMm,axis:normalized.axis,maxRadialGrowthMm:normalized.maxRadialGrowthMm,maxAddedVolumeMm3:normalized.maxAddedVolumeMm3});
    const spec=normalizeRepairSpec(proposal.spec),radius=proposal.inspection?.measuredRadiusMm;
    if(proposal.sourceSha256!==s.sourceSha256||proposal.inspection?.verified!==true||!Number.isFinite(radius)||radius<=0||spec.axis!==normalized.axis||spec.maxRadialGrowthMm!==normalized.maxRadialGrowthMm||spec.maxAddedVolumeMm3!==normalized.maxAddedVolumeMm3)fail('WORKFLOW_PROPOSAL_INVALID');
    const a='xyz'.indexOf(spec.axis),bounds=spec.centerLineMm.map((p,end)=>p.map((v,i)=>i===a?v:Math.max(s.boundsMm[0][i],Math.min(s.boundsMm[1][i],v+(end?1:-1)*(radius+.05)))));
    const jointMargin=Math.min(.25,(bounds[1][a]-bounds[0][a])/10);bounds[0][a]+=jointMargin;bounds[1][a]-=jointMargin;
    const target={id:'selected-rod',axis:spec.axis,centerLineMm:structuredClone(spec.centerLineMm),measuredRadiusMm:radius,boundsMm:bounds};
    normalizeCriticalFeatures([{id:target.id,kind:'solid',boundsMm:bounds,minRetention:.9,surfaceToleranceMm:.05}],s.boundsMm);
    for(let i=0;i<3;i++)if(spec.allowedBoundsMm[0][i]<s.boundsMm[0][i]-1e-5||spec.allowedBoundsMm[1][i]>s.boundsMm[1][i]+1e-5)fail('WORKFLOW_SCOPE_OUTSIDE_SOURCE');
    if(hash(await readFile(s.sourceStlPath))!==s.sourceSha256)fail('SOURCE_HASH_MISMATCH');
    const j={id:randomUUID(),stage:'prepared',active:false,input:normalized,source:{...normalized.source,sourceSha256:s.sourceSha256,boundsMm:s.boundsMm},sourceStlPath:s.sourceStlPath,target,spec,inspection:proposal.inspection,poseJobId:null,repairJobId:null,delivery:null,error:null,events:[]};
    j.searchPolicy={id:'fixed-five-v2',poseIds:poseCandidatesForPolicy('fixed-five-v2').map(p=>p.id)};
    j.contractHash=digest(j);this.jobs.set(j.id,j);await this.save(j);return this.publicById(j.id);
  }
  async assertFrozen(j){if(j.contractHash!==digest(j))fail('WORKFLOW_CONTRACT_CHANGED');searchForJob(j);if(hash(await readFile(j.sourceStlPath))!==j.source.sourceSha256)fail('SOURCE_HASH_MISMATCH');}
  async start(input){
    const j=await this.load(input?.id);if(!j)fail('WORKFLOW_NOT_FOUND');if(j.stage!=='prepared')fail('WORKFLOW_ALREADY_STARTED');
    if(input.confirmed!==true||input.contractHash!==j.contractHash||stable(normalizeWorkflowSource(input.source))!==stable(j.input.source)||['axis','maxRadialGrowthMm','maxAddedVolumeMm3'].some(k=>input[k]!==j.input[k]))fail('WORKFLOW_CONFIRMATION_CHANGED');
    if(this.activeId)fail('WORKFLOW_BUSY');this.activeId=j.id;
    try{await this.assertFrozen(j);const s=await this.loadSource(j.input.source);if(s.sourceSha256!==j.source.sourceSha256||stable(normalizeWorkflowBounds(s.boundsMm))!==stable(j.source.boundsMm))fail('SOURCE_HASH_MISMATCH');j.active=true;j.stage='pose-running';await this.save(j);}catch(e){this.activeId=null;throw e;}
    const running=this.run(j);this.runs.set(j.id,running);const release=()=>{this.runs.delete(j.id);if(this.activeId===j.id)this.activeId=null;};void running.then(release,release);return {id:j.id,stage:j.stage};
  }
  async wait(id){await this.runs.get(id);}
  async step(j,stage,code='OK'){j.stage=stage;j.events.push({at:new Date().toISOString(),stage,code});await this.save(j);}
  async run(j){
    try{
      await this.assertFrozen(j);
      const p=await this.poses.create({posePolicy:searchForJob(j).id,sourceKind:j.source.kind,sourceCandidateId:j.source.candidateId,sourceJobId:j.source.jobId,criticalFeatures:[{id:j.target.id,kind:'solid',boundsMm:j.target.boundsMm,minRetention:.9,surfaceToleranceMm:.05}],continuousRods:[{id:j.target.id,centerLineMm:j.target.centerLineMm}]});
      j.poseJobId=p.id;await this.step(j,'pose-running');await this.poses.startAgent(p.id);await this.assertFrozen(j);
      const parent=await this.poses.load(p.id);
      assertPoseBinding(j,parent);
      if(parent.stage==='completed'&&parent.submittedPoseId&&parent.recheck?.verified===true){
        const r=parent.results[parent.submittedPoseId];assertPoseBinding(j,parent,r);const fresh=await this.poses.verify(r);if(!fresh.verified)fail(fresh.reason??'WORKFLOW_DELIVERY_UNVERIFIED');
        j.delivery={kind:'original',candidateSha256:r.poseProof.candidateSha256,metrics:r.slice.metrics,poseId:r.poseId};
      }else{
        const candidate=repairableWorkflowPose(parent,j.target.id);
        if(!candidate){j.error=parent.stage==='failed'?'POSE_EXECUTION_FAILED':'NO_VERIFIED_REPAIRABLE_POSE';await this.step(j,parent.stage==='failed'?'failed':'stopped',j.error);return;}
        if(!repairRadiusOptions(j.inspection,j.spec).length){j.error='NO_ALLOWED_REPAIR';await this.step(j,'stopped',j.error);return;}
        const r=await this.repairs.create({parentPoseJobId:p.id,parentPoseId:candidate.poseId,targetFeatureId:j.target.id,spec:j.spec,coordinatesConfirmed:true});
        j.repairJobId=r.id;await this.step(j,'repair-running');await this.repairs.startAgent(r.id);await this.assertFrozen(j);
        const repair=await this.repairs.load(r.id),c=repair.candidates[repair.submittedCandidateId];
        assertRepairBinding(j,repair);
        if(repair.stage!=='completed'||!repair.recheck?.verified||!c){j.error=repair.error??'NO_FEASIBLE_REPAIR';await this.step(j,repair.stage==='no-feasible'?'stopped':'failed',j.error);return;}
        const sha=c.result.poseProof.candidateSha256;await this.repairs.readDeliveryStl(repair,c.candidateId,sha);j.delivery={kind:'repaired',candidateSha256:sha,metrics:c.metrics,candidateId:c.candidateId,poseId:candidate.poseId};
      }
      await this.assertFrozen(j);await this.step(j,'completed');
    }catch(e){j.delivery=null;j.error=safe(e);await this.step(j,'failed',j.error);}finally{j.active=false;await this.save(j);}
  }
  async publicById(id){
    const j=await this.load(id);if(!j)return null;
    const p=j.poseJobId?await this.poses.load(j.poseJobId):null,r=j.repairJobId?await this.repairs.load(j.repairJobId):null;
    let searchPolicy=null,bindingError=null,poseJob=null,repairJob=null;
    try{
      searchPolicy=searchForJob(j);await this.assertFrozen(j);
      if(j.poseJobId||j.delivery)assertPoseBinding(j,p);
      if(j.repairJobId){assertRepairBinding(j,r);if(this.repairs.assertPolicy)await this.repairs.assertPolicy(r);}
    }catch(e){bindingError=safe(e);}
    try{if(p)poseJob=this.poses.publicJob(p);}catch{bindingError??='WORKFLOW_CHILD_CONTRACT_CHANGED';}
    try{if(r)repairJob=this.repairs.publicJob(r);}catch{bindingError??='WORKFLOW_CHILD_CONTRACT_CHANGED';}
    return {searchPolicy,id:j.id,stage:j.stage,active:j.active,contractHash:j.contractHash,source:j.source,target:j.target,spec:j.spec,poseJob,repairJob,delivery:!bindingError&&j.stage==='completed'&&j.delivery?{...j.delivery,url:`/api/workflow/jobs/${j.id}/delivery?sha=${j.delivery.candidateSha256}`}:null,bindingError,error:j.error,events:j.events,physicalPrintVerified:false,limitations:['单根轴对齐直圆杆；所选杆以实际刀轨复核，其他未申报特征不作切片级保证。',searchPolicy?.id==='fixed-five-v2'?'本任务评估五个固定姿态，含X−90°侧放；结果限定于声明候选，不是全局最优。':searchPolicy?'历史任务沿用原四姿态，不重新计算或改写当时结果。':'任务搜索声明已失效，当前不提供交付。','模型与切片为软件验证，未验证实物打印或强度。']};
  }
  async readSource(id,sha){const j=await this.load(id);if(!j||sha!==j.source.sourceSha256)fail('WORKFLOW_STALE_SHA');await this.assertFrozen(j);return readFile(j.sourceStlPath);}
  async readDelivery(id,sha){
    const j=await this.load(id);if(!j||j.stage!=='completed'||j.active||!j.delivery||sha!==j.delivery.candidateSha256)fail('WORKFLOW_DELIVERY_REQUIRED');await this.assertFrozen(j);
    if(j.delivery.kind==='repaired'){const r=await this.repairs.load(j.repairJobId);assertRepairBinding(j,r);const parent=await this.poses.load(j.poseJobId);assertPoseBinding(j,parent);return this.repairs.readDeliveryStl(r,j.delivery.candidateId,sha);}
    const p=await this.poses.load(j.poseJobId),result=p?.results?.[j.delivery.poseId];assertPoseBinding(j,p,result);if(p?.stage!=='completed'||p.submittedPoseId!==j.delivery.poseId||result?.poseProof?.candidateSha256!==sha)fail('WORKFLOW_DELIVERY_CHANGED');const fresh=await this.poses.verify(result);if(!fresh.verified)fail(fresh.reason??'WORKFLOW_DELIVERY_UNVERIFIED');return this.poses.readStl(p,j.delivery.poseId);
  }
}
