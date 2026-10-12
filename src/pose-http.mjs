import { PoseJobStore } from './pose-jobs.mjs';
import { getCriticalFeatureStatus } from './critical-feature-service.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));return true;};
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>64*1024)throw new Error('POSE_REQUEST_TOO_LARGE');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('POSE_JSON_INVALID');}}

export function createPoseRouter({store=new PoseJobStore(),runAgent,status}={}){
  return {store,async handle(req,res){
    const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;
    const tools=p.match(/^\/api\/poses\/tool\/(inspect|evaluate|select|verify|submit)$/u);
    const jobs=p.match(/^\/api\/poses\/jobs\/([a-f0-9-]{36})(?:\/(stl|gcode)\/(upright|tilt-x-plus|tilt-x-minus|tilt-y-plus|face-up))?$/u);
    if(!['/api/poses/start','/api/poses/status'].includes(p)&&!tools&&!jobs)return false;
    if(req.headers.origin&&!['http://127.0.0.1:4337','http://localhost:4337'].includes(req.headers.origin))return json(res,403,{error:'ORIGIN_DENIED'});
    try{
      if(p==='/api/poses/status'&&req.method==='GET'){
        const result=status?await status():await import('./pose-agh.mjs').then(m=>m.getPoseAghStatus()).catch(()=>({ready:false}));
        return json(res,200,{ready:result.ready===true,model:result.model??null,profileId:'fdm-pla-04-auto-support',featureAudit:await getCriticalFeatureStatus()});
      }
      if(p==='/api/poses/start'&&req.method==='POST'){const input=await body(req),job=await store.create(input);json(res,202,{id:job.id,stage:job.stage});void store.startAgent(job.id,runAgent);return true;}
      if(tools&&req.method==='POST'){
        const input=await body(req),job=typeof input.jobId==='string'&&UUID.test(input.jobId)?store.get(input.jobId):null;
        if(!job||!job.agentRunActive||typeof job.accessToken!=='string'||req.headers['x-print-task-access']!==job.accessToken)return json(res,403,{success:false,code:'POSE_TASK_ACCESS_DENIED'});
        return json(res,200,await store.execute(job.id,tools[1],input,'agh'));
      }
      if(jobs&&UUID.test(jobs[1])&&req.method==='GET'){
        const job=await store.load(jobs[1]);if(!job)return json(res,404,{error:'POSE_JOB_NOT_FOUND'});
        if(!jobs[2])return json(res,200,store.publicJob(job));
        const poseId=jobs[3],candidate=job.results[poseId],sha=url.searchParams.get('sha');
        if(jobs[2]==='gcode'){
          if(!candidate?.slice?.proof?.gcodeSha256)return json(res,404,{error:'POSE_NOT_FOUND'});
          if(sha!==candidate.slice.proof.gcodeSha256)return json(res,409,{error:'POSE_STALE_SHA'});
          const bytes=await store.readGcode(job,poseId,sha);res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="${poseId}.gcode"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return true;
        }
        if(!candidate?.poseProof)return json(res,404,{error:'POSE_NOT_FOUND'});
        if(sha!==candidate.poseProof.candidateSha256)return json(res,409,{error:'POSE_STALE_SHA'});
        const bytes=await store.readStl(job,poseId);res.writeHead(200,{'Content-Type':'model/stl','Content-Disposition':`attachment; filename="${poseId}.stl"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return true;
      }
      return json(res,404,{error:'POSE_RESOURCE_NOT_FOUND'});
    }catch(error){return json(res,400,{error:/^[A-Z0-9_]{1,64}$/u.test(error?.message??'')?error.message:'POSE_REQUEST_FAILED'});}
  }};
}
