import {TextureJobStore} from './texture-jobs.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));return true;};
async function body(req){let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>64*1024)throw new Error('TEXTURE_REQUEST_TOO_LARGE');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('TEXTURE_JSON_INVALID');}}
async function getStatus(){const [agh,engine]=await Promise.all([import('./texture-agh.mjs').then(m=>m.getTextureAghStatus()).catch(()=>({ready:false})),import('./texture-service.mjs').then(m=>m.getTextureEngineStatus()).catch(()=>({available:false}))]);return {ready:agh.ready===true&&engine.available===true,model:agh.model??null,engineAvailable:engine.available===true,scope:'flat-illustration-existing-stl'};}

export function createTextureRouter({store=new TextureJobStore(),runAgent,status=getStatus}={}){
 return {store,async handle(req,res){
  const u=new URL(req.url,'http://127.0.0.1'),p=u.pathname;
  const tool=p.match(/^\/api\/texture\/tool\/(inspect|generate|verify|submit)$/u),parent=p.match(/^\/api\/texture\/parent\/([a-f0-9-]{36})$/u),job=p.match(/^\/api\/texture\/jobs\/([a-f0-9-]{36})(?:\/glb\/(t0[12]))?$/u);
  if(!['/api/texture/status','/api/texture/start'].includes(p)&&!tool&&!parent&&!job)return false;
  if(req.headers.origin&&!['http://127.0.0.1:4337','http://localhost:4337'].includes(req.headers.origin))return json(res,403,{error:'ORIGIN_DENIED'});
  try{
   if(p==='/api/texture/status'&&req.method==='GET'){const v=await status();return json(res,200,{ready:v.ready===true,model:typeof v.model==='string'?v.model:null,engineAvailable:v.engineAvailable===true,scope:'flat-illustration-existing-stl'});}
   if(p==='/api/texture/start'&&req.method==='POST'){const j=await store.create(await body(req));json(res,202,{id:j.id,stage:j.stage});void store.startAgent(j.id,runAgent).catch(()=>{});return true;}
   if(tool&&req.method==='POST'){
    const input=await body(req),j=uuid.test(input?.jobId??'')?store.get(input.jobId):null;if(!j?.agentRunActive||typeof j.accessToken!=='string'||req.headers['x-print-task-access']!==j.accessToken)return json(res,403,{success:false,code:'TEXTURE_TASK_ACCESS_DENIED'});
    const controller=new AbortController(),onClose=()=>{if(!res.writableEnded)controller.abort();};res.once('close',onClose);
    try{const result=await store.execute(j.id,tool[1],input,'agh',{signal:controller.signal});return res.destroyed?true:json(res,200,result);}finally{res.removeListener('close',onClose);}
   }
   if(parent&&uuid.test(parent[1])&&req.method==='GET')return json(res,200,await store.publicParent(parent[1]));
   if(job&&uuid.test(job[1])&&req.method==='GET'){
    const j=await store.load(job[1]);if(!j)return json(res,404,{error:'TEXTURE_JOB_NOT_FOUND'});if(!job[2])return json(res,200,store.publicJob(j));
    const bytes=await store.readGlb(j,job[2],u.searchParams.get('sha'));
    res.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Disposition':'attachment; filename="textured-preview.glb"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return true;
   }
   return json(res,404,{error:'TEXTURE_RESOURCE_NOT_FOUND'});
  }catch(e){const code=/^[A-Z0-9_]{1,64}$/u.test(e?.message??'')?e.message:'TEXTURE_REQUEST_FAILED';return json(res,['TEXTURE_STALE_SHA','TEXTURE_DELIVERY_REQUIRED','TEXTURE_RESULT_CHANGED','TEXTURE_SOURCE_CHANGED'].includes(code)?409:400,{error:code});}
 }};
}
