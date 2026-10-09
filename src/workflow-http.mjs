import {WorkflowJobStore} from './workflow-jobs.mjs';
import {listWorkflowSources} from './workflow-source.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));return true;};
async function body(req){let n=0;const chunks=[];for await(const c of req){n+=c.length;if(n>65536)throw new Error('WORKFLOW_REQUEST_TOO_LARGE');chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('WORKFLOW_JSON_INVALID');}}
export function createWorkflowRouter({poses,repairs,store=new WorkflowJobStore({poses,repairs}),listSources=listWorkflowSources}={}){
 return {store,async handle(req,res){
  const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;
  const job=p.match(/^\/api\/workflow\/jobs\/([a-f0-9-]{36})(?:\/(source|delivery))?$/u);
  if(!['/api/workflow/sources','/api/workflow/prepare','/api/workflow/start'].includes(p)&&!job)return false;
  if(req.headers.origin&&!['http://127.0.0.1:4337','http://localhost:4337'].includes(req.headers.origin))return json(res,403,{error:'ORIGIN_DENIED'});
  try{
   if(req.method==='GET'&&p==='/api/workflow/sources')return json(res,200,await listSources());
   if(req.method==='POST'&&p==='/api/workflow/prepare')return json(res,200,await store.prepare(await body(req)));
   if(req.method==='POST'&&p==='/api/workflow/start')return json(res,202,await store.start(await body(req)));
   if(req.method==='GET'&&job&&uuid.test(job[1])){
    if(!job[2]){const j=await store.publicById(job[1]);return j?json(res,200,j):json(res,404,{error:'WORKFLOW_NOT_FOUND'});}
    const bytes=job[2]==='source'?await store.readSource(job[1],url.searchParams.get('sha')):await store.readDelivery(job[1],url.searchParams.get('sha'));
    res.writeHead(200,{'Content-Type':'model/stl','Content-Disposition':`attachment; filename="${job[2]==='source'?'source':'verified-delivery'}.stl"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return true;
   }
   return json(res,404,{error:'WORKFLOW_NOT_FOUND'});
  }catch(e){return json(res,400,{error:/^[A-Z0-9_]{1,64}$/u.test(e?.message??'')?e.message:'WORKFLOW_REQUEST_FAILED'});}
 }};
}
