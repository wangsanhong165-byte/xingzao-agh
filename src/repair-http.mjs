import {RepairJobStore} from './repair-jobs.mjs';
import {PoseJobStore} from './pose-jobs.mjs';
import {getLocalRepairStatus} from './local-repair-service.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const json=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));return true;};
async function body(req){let n=0;const chunks=[];for await(const c of req){n+=c.length;if(n>64*1024)throw new Error('REPAIR_REQUEST_TOO_LARGE');chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('REPAIR_JSON_INVALID');}}
const stl=(res,b,name)=>{res.writeHead(200,{'Content-Type':'model/stl','Content-Disposition':`attachment; filename="${name}.stl"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(b);return true;};

export function createRepairRouter({store,parentStore=new PoseJobStore(),runAgent}={}){
 const parents=parentStore;store??=new RepairJobStore({parentLoader:id=>parents.load(id)});
 return {store,async handle(req,res){
  const u=new URL(req.url,'http://127.0.0.1'),p=u.pathname;
  const tool=p.match(/^\/api\/repair\/tool\/(inspect|evaluate|apply|verify|submit)$/u);
  const job=p.match(/^\/api\/repair\/jobs\/([a-f0-9-]{36})(?:\/stl\/(original|r0[1-3]))?$/u);
  const delivery=p.match(/^\/api\/repair\/jobs\/([a-f0-9-]{36})\/delivery\/(r0[1-3])$/u);
  const preview=p.match(/^\/api\/repair\/jobs\/([a-f0-9-]{36})\/toolpath\/(original|r0[1-3])$/u);
  const parent=p.match(/^\/api\/repair\/parent\/([a-f0-9-]{36})(?:\/stl\/(upright|tilt-x-plus|tilt-x-minus|tilt-y-plus|face-up))?$/u);
  if(!['/api/repair/status','/api/repair/start','/api/repair/target-proposal'].includes(p)&&!tool&&!job&&!parent&&!preview&&!delivery)return false;
  if(req.headers.origin&&!['http://127.0.0.1:4337','http://localhost:4337'].includes(req.headers.origin))return json(res,403,{error:'ORIGIN_DENIED'});
  try{
   if(p==='/api/repair/status'&&req.method==='GET'){
    const [runtime,geometry]=await Promise.all([import('./repair-agh.mjs').then(m=>m.getRepairAghStatus()).catch(()=>({ready:false})),getLocalRepairStatus()]);
    return json(res,200,{ready:runtime.ready===true&&geometry.available,model:runtime.model??null,geometryAvailable:geometry.available,scope:geometry.scope});
   }
   if(p==='/api/repair/start'&&req.method==='POST'){const j=await store.create(await body(req));json(res,202,{id:j.id,stage:j.stage});void store.startAgent(j.id,runAgent);return true;}
   if(p==='/api/repair/target-proposal'&&req.method==='POST')return json(res,200,await store.proposeTarget(await body(req)));
   if(tool&&req.method==='POST'){
    const input=await body(req),j=typeof input.jobId==='string'&&uuid.test(input.jobId)?store.get(input.jobId):null;
    if(!j?.agentRunActive||req.headers['x-print-task-access']!==j.accessToken)return json(res,403,{success:false,code:'REPAIR_TASK_ACCESS_DENIED'});
    return json(res,200,await store.execute(j.id,tool[1],input,'agh'));
   }
   if(parent&&uuid.test(parent[1])&&req.method==='GET'){
    const j=await parents.load(parent[1]);if(!j)return json(res,404,{error:'REPAIR_PARENT_NOT_FOUND'});
    if(!parent[2])return json(res,200,await store.publicParent(parent[1]));
    const r=j.results[parent[2]],sha=u.searchParams.get('sha');if(!r?.poseProof||sha!==r.poseProof.candidateSha256)return json(res,409,{error:'REPAIR_STALE_SHA'});
    return stl(res,await parents.readStl(j,parent[2]),`parent-${parent[2]}`);
   }
   if(job&&uuid.test(job[1])&&req.method==='GET'){
    const j=await store.load(job[1]);if(!j)return json(res,404,{error:'REPAIR_JOB_NOT_FOUND'});
    if(!job[2])return json(res,200,store.publicJob(j));
    return stl(res,await store.readStl(j,job[2],u.searchParams.get('sha')),`repair-${job[2]}`);
   }
   if(delivery&&uuid.test(delivery[1])&&req.method==='GET'){
    const j=await store.load(delivery[1]);if(!j)return json(res,404,{error:'REPAIR_JOB_NOT_FOUND'});
    return stl(res,await store.readDeliveryStl(j,delivery[2],u.searchParams.get('sha')),`verified-repair-${delivery[2]}`);
   }
   if(preview&&uuid.test(preview[1])&&req.method==='GET'){const j=await store.load(preview[1]);if(!j)return json(res,404,{error:'REPAIR_JOB_NOT_FOUND'});const result=await store.toolpathPreview(j,preview[2]);res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"});res.end(result.svg);return true;}
   return json(res,404,{error:'REPAIR_RESOURCE_NOT_FOUND'});
  }catch(e){return json(res,400,{error:/^[A-Z0-9_]{1,64}$/u.test(e?.message??'')?e.message:'REPAIR_REQUEST_FAILED'});}
 }};
}
