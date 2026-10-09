import {ApplicationCaseStore} from './application-case.mjs';
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));return true;};
export function createApplicationCaseRouter({store,sources,textures,protections}={}){
 store??=new ApplicationCaseStore({sources,textures,protections});
 return {store,async handle(req,res){
  const u=new URL(req.url,'http://127.0.0.1'),match=u.pathname.match(/^\/api\/application-cases\/([a-z0-9][a-z0-9-]{0,63})$/u);if(!match)return false;
  if(req.headers.origin&&!['http://127.0.0.1:4337','http://localhost:4337'].includes(req.headers.origin))return json(res,403,{error:'ORIGIN_DENIED'});
  if(req.method!=='GET')return json(res,405,{error:'CASE_READ_ONLY'});
  try{const out=await store.read(match[1]);return out?json(res,200,out):json(res,404,{error:'CASE_NOT_CONFIGURED'});}
  catch(e){return json(res,409,{error:/^[A-Z0-9_]{1,64}$/u.test(e.message??'')?e.message:'CASE_RECHECK_FAILED'});}
 }};
}
