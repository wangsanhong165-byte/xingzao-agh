import { ReconstructionJobStore, reconstructionPaths } from './reconstruction-jobs.mjs';
import { access } from 'node:fs/promises';

const MAX_BODY = 22 * 1024 * 1024;
const UUID = /^[a-f0-9-]{36}$/u;
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff' }); res.end(JSON.stringify(value)); return true; };
async function readBody(req) {
  let size=0; const chunks=[];
  for await (const chunk of req) { size+=chunk.length; if(size>MAX_BODY) throw new Error('REQUEST_TOO_LARGE'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('JSON_INVALID'); }
}
export function createReconstructionRouter({ store = new ReconstructionJobStore(), runAgent } = {}) {
  return { store, async handle(request,response) {
    const url=new URL(request.url,'http://127.0.0.1'); const p=url.pathname;
    const toolMatch=p.match(/^\/api\/reconstruction\/tool\/(inspect|generate|validate|slice|submit)$/u);
    const jobMatch=p.match(/^\/api\/reconstruction\/jobs\/([a-f0-9-]{36})(?:\/(view|stl)\/(front|left|back|[a-f0-9]{64}))?$/u);
    const matched=p==='/api/reconstruction/start'||p==='/api/reconstruction/status'||Boolean(toolMatch||jobMatch);
    if(!matched) return false;
    const origin=request.headers.origin;
    if(origin && origin!=='http://127.0.0.1:4337' && origin!=='http://localhost:4337') { json(response,403,{error:'ORIGIN_DENIED'}); return true; }
    try {
      if(p==='/api/reconstruction/status'&&request.method==='GET') {
        const agh=await import('./reconstruction-agh.mjs').then(m=>m.getReconstructionAghStatus()).catch(()=>({aghAvailable:false,modelConfigured:false,pluginInstalled:false,pluginTrusted:false,pluginEnabled:false,ready:false}));
        const safe=Object.fromEntries(['aghAvailable','modelConfigured','pluginInstalled','pluginTrusted','pluginEnabled','ready','model','provider','profile'].map(key=>[key,agh[key]??null]));
        const paths=[reconstructionPaths.pythonPath,reconstructionPaths.sourceScript,reconstructionPaths.configPath,reconstructionPaths.weightPath,reconstructionPaths.manifestPath,reconstructionPaths.generatorPath];
        const engineConfig=await Promise.all(paths.map(p=>access(p).then(()=>true,()=>false)));
        return json(response,200,{agh:safe,configured:safe.ready===true,engine:{configured:engineConfig.every(Boolean)}});
      }
      if(p==='/api/reconstruction/start'&&request.method==='POST') {
        const input=await readBody(request); const job=await store.create(input); json(response,202,{id:job.id,stage:job.stage});
        void store.startAgent(job.id,runAgent); return true;
      }
      if(toolMatch&&request.method==='POST') {
        const input=await readBody(request); const job=store.get(input.jobId);
        if(!job||!job.agentRunActive||typeof job.accessToken!=='string'||request.headers['x-print-task-access']!==job.accessToken) return json(response,403,{success:false,code:'TASK_ACCESS_DENIED',reason:'TASK_ACCESS_DENIED',message:'Task access denied'});
        return json(response,200,await store.execute(job.id,toolMatch[1],input,'agh'));
      }
      if(jobMatch&&request.method==='GET') {
        const job=await store.load(jobMatch[1]); if(!job) return json(response,404,{error:'JOB_NOT_FOUND'});
        if(!jobMatch[2]) return json(response,200,store.publicJob(job));
        if(jobMatch[2]==='view') { const file=await store.readView(job,jobMatch[3]); if(!file) return json(response,404,{error:'VIEW_NOT_FOUND'}); response.writeHead(200,{'Content-Type':file.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); response.end(file.bytes); return true; }
        if(jobMatch[2]==='stl') { const candidate=job.candidates[jobMatch[3]]; if(!candidate) return json(response,404,{error:'CANDIDATE_NOT_FOUND'}); const requestedSha=url.searchParams.get('sha'); if(requestedSha!==null&&requestedSha!==candidate.stlSha256) return json(response,409,{error:'STALE_CANDIDATE_SHA'}); const bytes=await store.readStl(job,jobMatch[3]); if(!bytes) return json(response,404,{error:'CANDIDATE_NOT_FOUND'}); response.writeHead(200,{'Content-Type':'model/stl','Content-Disposition':'attachment; filename="reconstruction.stl"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); response.end(bytes); return true; }
      }
      return json(response,404,{error:'RESOURCE_NOT_FOUND'});
    } catch(error) { return json(response,400,{error:/^[A-Z0-9_]{1,64}$/u.test(error?.message??'')?error.message:'REQUEST_FAILED'}); }
  } };
}
