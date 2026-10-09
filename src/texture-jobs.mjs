import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ReconstructionJobStore} from './reconstruction-jobs.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA=/^[a-f0-9]{64}$/u;
const ATTEMPT=/^t0[12]$/u;
const MODEL='9cd649ba6913f7a852e3286bad86bfa9a2d83dcf';
const SOURCE='f8db63096c8282cb27354314d896feba5ba6ff8a';
const FRAME='Z-up mm to Y-up metres [x,z,-y]/1000';
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw new Error(code);};
const safeCode=e=>/^[A-Z0-9_]{1,64}$/u.test(e?.message??'')?e.message:'TEXTURE_TASK_FAILED';
const publicExecution=e=>e?Object.fromEntries(['mode','toolTransport','profile','provider','route','model','sessionId','lastSeq','turnReason','startedAt','endedAt','exitCode'].filter(k=>e[k]===null||['string','number','boolean'].includes(typeof e[k])).map(k=>[k,e[k]])):null;

async function realFile(file,base,maxBytes){
 const absolute=path.resolve(file),root=path.resolve(base),rel=path.relative(root,absolute);
 if(!rel||rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))fail('TEXTURE_PATH_INVALID');
 const parts=rel.split(path.sep);let current=root;
 for(const part of [null,...parts]){if(part!==null)current=path.join(current,part);const stat=await lstat(current);if(stat.isSymbolicLink()||path.resolve(await realpath(current))!==path.resolve(current))fail('TEXTURE_PATH_INVALID');}
 const stat=await lstat(absolute);if(!stat.isFile()||stat.size<=0||stat.size>maxBytes)fail('TEXTURE_FILE_INVALID');
 return readFile(absolute);
}
async function realDirectory(dir,root){
 const rel=path.relative(root,dir);if(!rel||rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))fail('TEXTURE_PATH_INVALID');
 let current=root;for(const part of rel.split(path.sep)){current=path.join(current,part);await mkdir(current).catch(e=>{if(e.code!=='EEXIST')throw e;});const stat=await lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink()||path.resolve(await realpath(current))!==path.resolve(current))fail('TEXTURE_PATH_INVALID');}
}
function cleanResult(result,j,a){
 if(result?.success!==true||result.attemptId!==a.attemptId||result.profile!==a.profile||result.sourceSha256!==j.source.sha256||result.referenceSha256!==j.reference.sha256||!SHA.test(result.glbSha256??'')||!Number.isSafeInteger(result.glbBytes)||result.glbBytes<=0||result.glbBytes>32*1024*1024)fail('TEXTURE_RESULT_INVALID');
 const m=result.metrics,p=result.proof,size=a.profile==='standard'?2048:1024;
 if(!Number.isSafeInteger(m?.faces)||m.faces<=0||m.faces>250000||JSON.stringify(m.textureSizePixels)!==JSON.stringify([size,size])||m.geometryPreservedAtFloat32!==true||!SHA.test(p?.inputGeometrySignature??'')||p.inputGeometrySignature!==p.outputGeometrySignature||p.coordinateTransform!==FRAME||p.modelRevision!==MODEL||p.sourceRevision!==SOURCE)fail('TEXTURE_RESULT_INVALID');
 const metrics={faces:m.faces,textureSizePixels:[size,size],geometryPreservedAtFloat32:true};
 for(const key of ['peakAllocatedGpuMiB','elapsedSeconds'])if(typeof m[key]==='number'&&Number.isFinite(m[key])&&m[key]>=0)metrics[key]=m[key];
 return {success:true,code:'OK',attemptId:a.attemptId,profile:a.profile,sourceSha256:j.source.sha256,referenceSha256:j.reference.sha256,glbSha256:result.glbSha256,glbBytes:result.glbBytes,metrics,proof:{inputGeometrySignature:p.inputGeometrySignature,outputGeometrySignature:p.outputGeometrySignature,coordinateTransform:FRAME,modelRevision:MODEL,sourceRevision:SOURCE}};
}

export class TextureJobStore{
 constructor({rootDir=ROOT,parentStore=new ReconstructionJobStore(),worker=null,runAgent=null}={}){this.root=path.resolve(rootDir);this.jobsRoot=path.join(this.root,'data/texture/jobs');this.parents=parentStore;this.worker=worker;this.runAgent=runAgent;this.jobs=new Map();this.activeTools=new Map();}
 dir(id){if(!UUID.test(id??''))fail('TEXTURE_JOB_ID_INVALID');return path.join(this.jobsRoot,id);}
 get(id){return this.jobs.get(id);}
 async parentSource(id){
  if(!UUID.test(id??''))fail('TEXTURE_PARENT_INVALID');
  const parent=await this.parents.load(id),c=parent?.candidates?.[parent.submittedCandidateId];
  if(parent?.stage!=='completed'||!SHA.test(c?.candidateId??'')||c.jobId!==id||!SHA.test(c.stlSha256??'')||!c.geometryChecks?.passed||c.geometryChecks.stlSha256!==c.stlSha256||c.slice?.mode!=='actual-slicer'||c.slice?.execution?.mode!=='actual-slicer'||c.slice.sourceStlSha256!==c.stlSha256||parent.submissionProof?.candidateId!==c.candidateId||parent.submissionProof?.assetSha256!==c.stlSha256||parent.submissionProof?.sliceMode!=='actual-slicer')fail('TEXTURE_PARENT_INVALID');
  const bytes=await this.parents.readStl(parent,c.candidateId),view=await this.parents.readView(parent,'front');
  if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>25*1024*1024||hash(bytes)!==c.stlSha256||!view?.bytes||view.bytes.length>5*1024*1024||hash(view.bytes)!==parent.views?.front?.sha256||!['image/png','image/jpeg'].includes(view.mime))fail('TEXTURE_SOURCE_CHANGED');
  return {parent,c,bytes,view};
 }
 async publicParent(id){const {parent,c}=await this.parentSource(id);return {sourceJobId:id,candidateId:c.candidateId,sourceSha256:c.stlSha256,sourceStlUrl:`/api/reconstruction/jobs/${id}/stl/${c.candidateId}?sha=${c.stlSha256}`,dimensionsMm:c.geometryChecks.metrics?.dimensionsMm??null,reference:{url:`/api/reconstruction/jobs/${id}/view/front`,sha256:parent.views.front.sha256,label:parent.views.front.name??'正面参考'},scope:'flat-illustration-existing-stl'};}
 async create(input){
  if(input?.referenceKind!=='flat-illustration')fail('TEXTURE_REFERENCE_KIND_UNSUPPORTED');
  if(Object.keys(input).some(k=>!['sourceJobId','referenceKind'].includes(k)))fail('TEXTURE_INPUT_INVALID');
  const {parent,c,bytes,view}=await this.parentSource(input.sourceJobId);
  const id=randomUUID(),dir=this.dir(id);await realDirectory(this.jobsRoot,this.root);await mkdir(dir);
  const referenceFile=view.mime==='image/png'?'front.png':'front.jpg';
  await writeFile(path.join(dir,'source.stl'),bytes,{flag:'wx'});await writeFile(path.join(dir,referenceFile),view.bytes,{flag:'wx'});
  const j={id,sourceJobId:parent.id,referenceKind:input.referenceKind,source:{candidateId:c.candidateId,sha256:c.stlSha256,dimensionsMm:c.geometryChecks.metrics?.dimensionsMm??null},reference:{file:referenceFile,sha256:parent.views.front.sha256,label:parent.views.front.name??'正面参考'},stage:'created',createdAt:new Date().toISOString(),agentRunActive:false,accessToken:randomBytes(32).toString('hex'),toolCalls:0,inspected:false,executing:false,attempts:[],submittedAttemptId:null,events:[],error:null,execution:null};
  this.jobs.set(id,j);await this.save(j);return j;
 }
 async save(j){await writeFile(path.join(this.dir(j.id),'state.json'),JSON.stringify(j));}
 async load(id){
  if(this.jobs.has(id))return this.jobs.get(id);if(!UUID.test(id??''))return null;
  try{const b=await realFile(path.join(this.dir(id),'state.json'),this.jobsRoot,256*1024),j=JSON.parse(b);if(j.id!==id||!UUID.test(j.sourceJobId??'')||!Array.isArray(j.attempts)||j.attempts.length>2||!Array.isArray(j.events))return null;
   if(j.agentRunActive){j.agentRunActive=false;j.stage='interrupted';j.error='TEXTURE_TASK_INTERRUPTED';j.accessToken=randomBytes(32).toString('hex');j.executing=false;await this.save(j);}this.jobs.set(id,j);return j;
  }catch{return null;}
 }
 async checkSources(j){
  const {parent,c}=await this.parentSource(j.sourceJobId);
  if(c.candidateId!==j.source.candidateId||c.stlSha256!==j.source.sha256||parent.views.front.sha256!==j.reference.sha256)fail('TEXTURE_SOURCE_CHANGED');
  if(!['front.png','front.jpg'].includes(j.reference.file))fail('TEXTURE_SOURCE_CHANGED');
  const dir=this.dir(j.id),[source,ref]=await Promise.all([realFile(path.join(dir,'source.stl'),this.jobsRoot,25*1024*1024),realFile(path.join(dir,j.reference.file),this.jobsRoot,5*1024*1024)]);
  if(hash(source)!==j.source.sha256||hash(ref)!==j.reference.sha256)fail('TEXTURE_SOURCE_CHANGED');
 }
 publicJob(j){
  const base=`/api/texture/jobs/${j.id}`;
  return {id:j.id,sourceJobId:j.sourceJobId,stage:j.stage,agentRunActive:j.agentRunActive,error:j.error,execution:publicExecution(j.execution),source:{...j.source,stlUrl:`/api/reconstruction/jobs/${j.sourceJobId}/stl/${j.source.candidateId}?sha=${j.source.sha256}`},reference:{url:`/api/reconstruction/jobs/${j.sourceJobId}/view/front`,sha256:j.reference.sha256,label:j.reference.label},events:j.events.map(e=>({tool:e.tool,source:e.source,success:e.success,code:e.code,message:e.message,at:e.at})),attempts:j.attempts.map(a=>({attemptId:a.attemptId,profile:a.profile,status:a.status,errorCode:a.errorCode??null,metrics:a.result?.metrics??null,glbSha256:a.glbSha256??null,glbUrl:j.stage==='completed'&&j.submittedAttemptId===a.attemptId&&a.status==='submitted'?`${base}/glb/${a.attemptId}?sha=${a.glbSha256}`:null})),submittedAttemptId:j.submittedAttemptId};
 }
 request(j,a,mode){return {mode,jobId:j.id,attemptId:a.attemptId,profile:a.profile,sourceStlPath:path.join(this.dir(j.id),'source.stl'),sourceSha256:j.source.sha256,referenceImagePath:path.join(this.dir(j.id),j.reference.file),referenceSha256:j.reference.sha256,outputDir:path.join(this.dir(j.id),a.attemptId)};}
 async invoke(j,a,mode,signal){const request=this.request(j,a,mode);return this.worker?this.worker(request,{signal}):(await import('./texture-service.mjs')).runTextureWorker(request,{signal});}
 async verify(j,a,signal){
  if(!['generated','verified','submitted'].includes(a.status)||!SHA.test(a.glbSha256??''))fail('TEXTURE_VERIFY_REQUIRED');
  await this.checkSources(j);const r=cleanResult(await this.invoke(j,a,'verify',signal),j,a);
  if(r.glbSha256!==a.glbSha256||r.glbBytes!==a.result.glbBytes||r.proof.inputGeometrySignature!==a.result.proof.inputGeometrySignature)fail('TEXTURE_RESULT_CHANGED');
  const bytes=await realFile(path.join(this.dir(j.id),a.attemptId,'textured.glb'),this.jobsRoot,32*1024*1024);
  if(hash(bytes)!==a.glbSha256||bytes.length!==r.glbBytes)fail('TEXTURE_RESULT_CHANGED');
  return r;
 }
 async startAgent(id,runAgent=this.runAgent){const j=this.get(id);if(!j||j.agentRunActive||j.stage!=='created')fail('TEXTURE_TASK_UNAVAILABLE');j.agentRunActive=true;j.stage='agent-running';await this.save(j);
  try{runAgent??=(await import('./texture-agh.mjs')).runTextureTask;const r=await runAgent({jobId:id,accessToken:j.accessToken,task:{sourceSha256:j.source.sha256,referenceSha256:j.reference.sha256,referenceKind:j.referenceKind,scope:'texture-only-same-geometry'},serviceUrl:'http://127.0.0.1:4337'});await this.finish(id,r);}catch(e){await this.finish(id,{success:false,reason:safeCode(e)});}
 }
 async finish(id,result){const j=this.get(id);if(!j?.agentRunActive)return;this.activeTools.get(id)?.abort();j.agentRunActive=false;j.execution=publicExecution(result?.execution);const a=j.attempts.find(a=>a.attemptId===j.submittedAttemptId);j.stage=result?.success===true&&a?.status==='submitted'?'completed':'failed';j.error=j.stage==='completed'?null:safeCode({message:result?.reason??j.events.findLast(e=>e.success===false&&e.code!=='RUNNING')?.code??'TEXTURE_SUBMISSION_REQUIRED'});await this.save(j);}
 async execute(id,tool,input={},source='agh',{signal}={}){
  const j=this.get(id);if(!j?.agentRunActive||source!=='agh'||j.toolCalls>=8||!['inspect','generate','verify','submit'].includes(tool))return {success:false,code:'TEXTURE_TOOL_ACCESS_DENIED'};
  if(j.executing)return {success:false,code:'TEXTURE_TOOL_BUSY'};
  const controller=new AbortController(),onAbort=()=>controller.abort();
  if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',onAbort,{once:true});
  this.activeTools.set(id,controller);
  const active=()=>{if(!j.agentRunActive||controller.signal.aborted)fail('TEXTURE_TASK_INTERRUPTED');};
  j.executing=true;j.toolCalls++;const event={tool,source:'agh',success:false,code:'RUNNING',message:'纹理工具开始',at:new Date().toISOString()};j.events.push(event);await this.save(j);
  try{active();await this.checkSources(j);active();let result;
   if(tool==='inspect'){j.inspected=true;result={success:true,sourceSha256:j.source.sha256,referenceSha256:j.reference.sha256,scope:'flat-illustration-existing-stl',profiles:['standard','compact'],policy:'standard first; compact only after a resource failure; no mesh simplification or shape edits'};}
   else if(tool==='generate'){
    if(!j.inspected)fail('TEXTURE_INSPECT_REQUIRED');if(j.attempts.length>=2)fail('TEXTURE_ATTEMPT_LIMIT');
    const profile=input.profile??'standard';if(!['standard','compact'].includes(profile)||(j.attempts.length===0&&profile!=='standard')||(j.attempts.length===1&&(profile!=='compact'||j.attempts[0].errorCode!=='TEXTURE_RESOURCE_FAILURE')))fail('TEXTURE_PROFILE_NOT_ALLOWED');
    const a={attemptId:`t0${j.attempts.length+1}`,profile,status:'running'};j.attempts.push(a);await mkdir(path.join(this.dir(id),a.attemptId));await this.save(j);
    const raw=await this.invoke(j,a,'generate',controller.signal);active();if(raw?.success!==true){a.status='failed';a.errorCode=['TEXTURE_GPU_BUSY','TEXTURE_RESOURCE_FAILURE','TEXTURE_ENGINE_FAILURE','TEXTURE_SOURCE_CHANGED','TEXTURE_RESULT_INVALID','TEXTURE_INPUT_INVALID'].includes(raw?.code)?raw.code:'TEXTURE_ENGINE_FAILURE';result={success:false,code:a.errorCode,attemptId:a.attemptId};}
    else{const r=cleanResult(raw,j,a);await this.checkSources(j);active();const bytes=await realFile(path.join(this.dir(id),a.attemptId,'textured.glb'),this.jobsRoot,32*1024*1024);active();if(hash(bytes)!==r.glbSha256||bytes.length!==r.glbBytes)fail('TEXTURE_RESULT_INVALID');a.result=r;a.glbSha256=r.glbSha256;a.status='generated';result={success:true,attemptId:a.attemptId,profile:a.profile,metrics:r.metrics,glbSha256:r.glbSha256};}
   }else{
    const a=j.attempts.find(a=>a.attemptId===input.attemptId);if(!ATTEMPT.test(input.attemptId??'')||!a)fail('TEXTURE_ATTEMPT_NOT_FOUND');
    if(tool==='verify'){await this.verify(j,a,controller.signal);active();a.status='verified';result={success:true,attemptId:a.attemptId,verified:true,glbSha256:a.glbSha256,assetSha256:a.glbSha256};}
    else{if(a.status!=='verified')fail('TEXTURE_VERIFY_REQUIRED');await this.verify(j,a,controller.signal);active();a.status='submitted';j.submittedAttemptId=a.attemptId;result={success:true,attemptId:a.attemptId,assetSha256:a.glbSha256,submitted:true,verified:true,scope:'experimental-color-preview-not-physical-print'};}
   }
   event.success=result.success===true;event.code=result.code??(result.success?'OK':'TEXTURE_TOOL_FAILED');event.message=result.success?`${tool} 已完成`:`${tool} 失败`;return result;
  }catch(e){event.code=safeCode(e);event.message=`${tool} 失败`;if(tool==='generate'&&j.attempts.at(-1)?.status==='running'){j.attempts.at(-1).status='failed';j.attempts.at(-1).errorCode=event.code;}return {success:false,code:event.code};}
  finally{signal?.removeEventListener('abort',onAbort);if(this.activeTools.get(id)===controller)this.activeTools.delete(id);j.executing=false;await this.save(j);}
 }
 async readGlb(j,attemptId,expectedSha){const a=j.attempts.find(a=>a.attemptId===attemptId);if(j.stage!=='completed'||j.submittedAttemptId!==attemptId||a?.status!=='submitted')fail('TEXTURE_DELIVERY_REQUIRED');if(expectedSha!==a.glbSha256)fail('TEXTURE_STALE_SHA');await this.verify(j,a);const bytes=await realFile(path.join(this.dir(j.id),attemptId,'textured.glb'),this.jobsRoot,32*1024*1024);if(hash(bytes)!==a.glbSha256||bytes.length!==a.result.glbBytes)fail('TEXTURE_RESULT_CHANGED');return bytes;}
}
