import {readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,SHA=/^[a-f0-9]{64}$/u,ID=/^[a-z0-9][a-z0-9-]{0,63}$/u;
const fail=code=>{throw Error(code)},hash=b=>createHash('sha256').update(b).digest('hex'),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function normalizeApplicationCase(input){
 if(!input||Object.keys(input).length!==5||!Object.keys(input).every(k=>['id','title','sourceJobId','textureJobId','protectionJobId'].includes(k))||!ID.test(input.id??'')||typeof input.title!=='string'||!input.title.trim()||input.title.length>160||['sourceJobId','textureJobId','protectionJobId'].some(k=>!UUID.test(input[k]??'')))fail('CASE_MANIFEST_INVALID');
 return {...input};
}
export function verifyApplicationCase(raw,{source,texture,protection}){
 const m=normalizeApplicationCase(raw),c=source?.candidates?.find(c=>c.candidateId===source.submittedCandidateId),sha=source?.submission?.assetSha256;
 if(source?.id!==m.sourceJobId||source.stage!=='completed'||!SHA.test(sha??'')||!SHA.test(c?.candidateId??'')||source.submission.candidateId!==c.candidateId||source.submission.sliceMode!=='actual-slicer'||c.geometryChecks?.passed!==true||c.geometryChecks.stlSha256!==sha||c.slice?.mode!=='actual-slicer'||c.slice.execution?.mode!=='actual-slicer'||c.slice.sourceStlSha256!==sha)fail('CASE_SOURCE_UNVERIFIED');
 const color=texture?.attempts?.find(a=>a.attemptId===texture.submittedAttemptId);
 if(texture?.id!==m.textureJobId||texture.stage!=='completed'||texture.sourceJobId!==source.id||texture.source?.candidateId!==c.candidateId||texture.source.sha256!==sha||!SHA.test(source.views?.front?.sha256??'')||texture.reference?.sha256!==source.views.front.sha256||color?.status!=='submitted'||color.metrics?.geometryPreservedAtFloat32!==true||!SHA.test(color.glbSha256??''))fail('CASE_COLOR_BINDING_CHANGED');
 if(protection?.id!==m.protectionJobId||protection.bindingError||protection.source?.kind!=='reconstructed'||protection.source.jobId!==source.id||protection.sourceSha256!==sha)fail('CASE_PROTECTION_BINDING_CHANGED');
 const p=protection.pose;
 if(!p||p.id!==protection.poseJobId||p.source?.kind!=='reconstructed'||p.source.jobId!==source.id||p.source.sourceSha256!==sha||!same(p.protectedRegions,[{id:'important-region',boundsMm:protection.boundsMm}]))fail('CASE_ROI_BINDING_CHANGED');
 const out={id:m.id,title:m.title,state:'running',stages:{reconstruction:source.stage,color:texture.stage,manufacturing:protection.stage},source:{jobId:source.id,candidateId:c.candidateId,sha256:sha,views:Object.fromEntries(['front','left','back'].map(n=>[n,`/api/reconstruction/jobs/${source.id}/view/${n}`]))},color:{jobId:texture.id,sha256:color.glbSha256,url:`/api/texture/jobs/${texture.id}/glb/${color.attemptId}?sha=${color.glbSha256}`},protection:{jobId:protection.id,poseJobId:p.id,boundsMm:protection.boundsMm,reductionPercent:protection.reductionPercent,error:protection.error??null},links:{source:`/reconstruct?job=${source.id}`,color:`/texture?job=${texture.id}`,protection:`/protect?job=${protection.id}`,poses:`/poses?job=${p.id}`},print:null,comparison:null,records:{reconstruction:source.events??[],color:texture.events??[],poses:p.events??[]}};
 if(protection.stage!=='completed'){out.state=['failed','interrupted','no-feasible','stopped'].includes(protection.stage)?'stopped':'running';return out;}
 const best=protection.best,baseline=protection.baseline,selected=p.results?.find(r=>r.poseId===best?.poseId),region=selected?.supportAudit?.regions?.find(r=>r.id==='important-region');
 if(p.stage!=='completed'||p.submittedPoseId!==best?.poseId||p.recheck?.verified!==true||selected?.status!=='verified'||selected.poseProof?.rigidTransformVerified!==true||!SHA.test(protection.delivery?.sha256??'')||selected.poseProof.candidateSha256!==protection.delivery.sha256)fail('CASE_DELIVERY_UNVERIFIED');
 if(![baseline?.protectedSupportMm,baseline?.filamentG,baseline?.estimatedTimeSeconds,best?.protectedSupportMm,best?.filamentG,best?.estimatedTimeSeconds,protection.reductionPercent].every(Number.isFinite)||baseline.protectedSupportMm<=0||baseline.filamentG<=0||baseline.estimatedTimeSeconds<=0||best.protectedSupportMm<0||best.filamentG<=0||best.estimatedTimeSeconds<=0)fail('CASE_METRICS_UNVERIFIED');
 const reduced=100*(1-best.protectedSupportMm/baseline.protectedSupportMm),limit=baseline.protectedSupportMm*(1-protection.reductionPercent/100);
 if(protection.reductionPercent<1||protection.reductionPercent>90||reduced+1e-6<protection.reductionPercent||!Number.isFinite(best.reductionPercent)||Math.abs(best.reductionPercent-reduced)>1e-6||region?.supportPathLengthMm!==best.protectedSupportMm||!Number.isFinite(p.constraints?.maxRegionSupportPathLengthMm)||Math.abs(p.constraints.maxRegionSupportPathLengthMm-limit)>1e-6||selected.slice?.metrics?.filamentG!==best.filamentG||selected.slice.metrics.estimatedTimeSeconds!==best.estimatedTimeSeconds)fail('CASE_TARGET_OR_METRICS_CHANGED');
 out.state='verified';out.print={sha256:protection.delivery.sha256,poseId:best.poseId,url:`/api/protect/jobs/${protection.id}/delivery?sha=${protection.delivery.sha256}`};
 out.comparison={baseline,best,supportReductionPercent:reduced,materialChangePercent:100*(best.filamentG/baseline.filamentG-1),timeChangePercent:100*(best.estimatedTimeSeconds/baseline.estimatedTimeSeconds-1)};
 return out;
}
export class ApplicationCaseStore{
 constructor({sources,textures,protections,dataRoot=path.join(ROOT,'data/application-cases')}={}){Object.assign(this,{sources,textures,protections,dataRoot});}
 async read(id){
  if(!ID.test(id??''))fail('CASE_ID_INVALID');
  const dir=path.join(this.dataRoot,id),file=path.join(dir,'manifest.json');let m;
  try{for(const p of [this.dataRoot,dir,file]){const s=await lstat(p);if(s.isSymbolicLink())fail('CASE_MANIFEST_INVALID');if(p===file&&(!s.isFile()||s.size>65536))fail('CASE_MANIFEST_INVALID');}m=normalizeApplicationCase(JSON.parse(await readFile(file,'utf8')));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(m.id!==id)fail('CASE_MANIFEST_INVALID');
  const [s,t,p]=await Promise.all([this.sources.load(m.sourceJobId),this.textures.load(m.textureJobId),this.protections.publicById(m.protectionJobId)]);
  const out=verifyApplicationCase(m,{source:s?this.sources.publicJob(s):null,texture:t?this.textures.publicJob(t):null,protection:p});
  if(out.state==='verified'){
   const [source,color,print]=await Promise.all([this.sources.readStl(s,out.source.candidateId),this.textures.readGlb(t,t.submittedAttemptId,out.color.sha256),this.protections.readDelivery(p.id,out.print.sha256)]);
   if(hash(source)!==out.source.sha256||hash(color)!==out.color.sha256||hash(print)!==out.print.sha256)fail('CASE_FILE_CHANGED');
   out.fileChecks={source:true,color:true,print:true};out.fileBytes={color:color.length,print:print.length};
  }
  const correctionFile=path.join(this.dataRoot,id,'correction.json');
  try{
   const info=await lstat(correctionFile);if(!info.isFile()||info.isSymbolicLink()||info.size>65536)fail('CASE_CORRECTION_INVALID');
   const record=JSON.parse(await readFile(correctionFile,'utf8'));
   if(Object.keys(record).length!==1||!UUID.test(record.previousProtectionJobId??''))fail('CASE_CORRECTION_INVALID');
   const previous=await this.protections.publicById(record.previousProtectionJobId);
   if(!previous||previous.stage!=='no-feasible'||previous.bindingError||previous.delivery||previous.source?.kind!=='reconstructed'||previous.source.jobId!==out.source.jobId||previous.sourceSha256!==out.source.sha256||previous.reductionPercent!==out.protection.reductionPercent)fail('CASE_CORRECTION_BINDING_CHANGED');
   out.correction={previousJobId:previous.id,previousStage:previous.stage,previousBoundsMm:previous.boundsMm,currentBoundsMm:out.protection.boundsMm,targetUnchanged:true,link:`/protect?job=${previous.id}`};
  }catch(e){if(e.code!=='ENOENT')throw e;}
  return out;
 }
}
