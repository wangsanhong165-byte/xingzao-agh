import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createTextureRouter} from '../src/texture-http.mjs';

const id='1ac90d72-425f-4a6f-b9f8-50248baa6368';
async function fixture(){
 let starts=0,reads=0;const j={id,agentRunActive:true,accessToken:'task-token-never-public',stage:'agent-running'};
 const store={get:()=>j,load:async()=>{reads++;return j;},publicJob:()=>({id,stage:j.stage}),publicParent:async()=>({sourceJobId:id}),create:async()=>j,startAgent:async()=>{starts++;},execute:async()=>({success:true}),readGlb:async(_j,_a,sha)=>{if(sha!=='a'.repeat(64))throw new Error('TEXTURE_STALE_SHA');return Buffer.from('GLB');}};
 const router=createTextureRouter({store,status:async()=>({ready:true,model:'test-model',engineAvailable:true})});
 const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));return {base:`http://127.0.0.1:${server.address().port}`,j,counts:()=>({starts,reads}),close:()=>new Promise(r=>server.close(r))};
}
test('tool origin and active task token are required, recovery GET never starts a model',async()=>{
 const f=await fixture();try{
  const request={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:id})};
  assert.equal((await fetch(`${f.base}/api/texture/tool/inspect`,request)).status,403);
  assert.equal((await fetch(`${f.base}/api/texture/tool/inspect`,{...request,headers:{...request.headers,origin:'https://evil.invalid','x-print-task-access':f.j.accessToken}})).status,403);
  assert.equal((await fetch(`${f.base}/api/texture/tool/inspect`,{...request,headers:{...request.headers,'x-print-task-access':f.j.accessToken}})).status,200);
  assert.equal((await fetch(`${f.base}/api/texture/jobs/${id}`)).status,200);assert.equal(f.counts().starts,0);
  f.j.agentRunActive=false;assert.equal((await fetch(`${f.base}/api/texture/tool/inspect`,{...request,headers:{...request.headers,'x-print-task-access':f.j.accessToken}})).status,403);
 }finally{await f.close();}
});
test('artifact requires matching SHA and receives GLB content type',async()=>{
 const f=await fixture();try{
  assert.equal((await fetch(`${f.base}/api/texture/jobs/${id}/glb/t01?sha=${'b'.repeat(64)}`)).status,409);
  const response=await fetch(`${f.base}/api/texture/jobs/${id}/glb/t01?sha=${'a'.repeat(64)}`);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/model\/gltf-binary/);
  assert.equal((await fetch(`${f.base}/api/texture/jobs/${id}/glb/t03?sha=${'a'.repeat(64)}`)).status,404);
 }finally{await f.close();}
});
