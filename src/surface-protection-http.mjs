import {SurfaceProtectionStore} from './surface-protection-jobs.mjs';
import {listWorkflowSources} from './workflow-source.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));return true;};
async function body(req){let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>65536)throw new Error('PROTECTION_REQUEST_TOO_LARGE');chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('PROTECTION_JSON_INVALID');}}
export function createProtectRouter({poses,store=new SurfaceProtectionStore({poses}),listSources=listWorkflowSources}={}){
 return {store,async handle(req,res){
  const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname,jobs=p.match(/^\/api\/protect\/jobs\/([a-f0-9-]{36})(?:\/(delivery))?$/u),proposal=p.match(/^\/api\/protect\/proposals\/([a-f0-9-]{36})$/u);
  if(!['/api/protect/sources','/api/protect/prepare','/api/protect/start'].includes(p)&&!jobs&&!proposal)return false;
  if(req.headers.origin&&!['http://127.0.0.1:4337','http://localhost:4337'].includes(req.headers.origin))return json(res,403,{error:'ORIGIN_DENIED'});
  try{
   if(p==='/api/protect/sources'&&req.method==='GET')return json(res,200,await listSources());
   if(p==='/api/protect/prepare'&&req.method==='POST')return json(res,200,await store.prepare(await body(req)));
   if(p==='/api/protect/start'&&req.method==='POST')return json(res,202,await store.start(await body(req)));
   if(proposal&&UUID.test(proposal[1])&&req.method==='GET')return json(res,200,await store.resolveProposal(proposal[1],url.searchParams.get('fingerprint')));
   if(jobs&&UUID.test(jobs[1])&&req.method==='GET'){
    if(!jobs[2]){const j=await store.publicById(jobs[1]);return j?json(res,200,j):json(res,404,{error:'PROTECTION_JOB_NOT_FOUND'});}
    const bytes=await store.readDelivery(jobs[1],url.searchParams.get('sha'));res.writeHead(200,{'Content-Type':'model/stl','Content-Disposition':`attachment; filename="appearance-${jobs[1].slice(0,8)}.stl"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return true;
   }
   return json(res,404,{error:'PROTECTION_RESOURCE_NOT_FOUND'});
  }catch(e){return json(res,400,{error:/^[A-Z0-9_]{1,64}$/u.test(e?.message??'')?e.message:'PROTECTION_REQUEST_FAILED'});}
 }};
}
