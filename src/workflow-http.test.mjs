import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
const mod=await import('./workflow-http.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
test('new HTTP flow exposes only confirmed preparation and redacted job view',async t=>{
 assert.equal(typeof mod.createWorkflowRouter,'function');let called;
 const router=mod.createWorkflowRouter({store:{async prepare(input){called=input;return {id:'a',stage:'prepared'};},async start(){throw new Error('WORKFLOW_CONFIRMATION_CHANGED');},async publicById(){return null;}},listSources:async()=>({sources:[]})});
 const server=http.createServer(async(q,s)=>{if(!await router.handle(q,s)){s.writeHead(404);s.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}`;
 assert.deepEqual(await (await fetch(base+'/api/workflow/sources')).json(),{sources:[]});
 const prepared=await fetch(base+'/api/workflow/prepare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:{kind:'imported',candidateId:'a'.repeat(64)}})});assert.equal(prepared.status,200);assert.equal(called.source.kind,'imported');
 const blocked=await fetch(base+'/api/workflow/start',{method:'POST',body:'{}'});assert.equal(blocked.status,400);assert.equal((await blocked.json()).error,'WORKFLOW_CONFIRMATION_CHANGED');
 const foreign=await fetch(base+'/api/workflow/prepare',{method:'POST',headers:{origin:'https://foreign.example'},body:'{}'});assert.equal(foreign.status,403);
 const large=await fetch(base+'/api/workflow/prepare',{method:'POST',body:'x'.repeat(65537)});assert.equal(large.status,400);assert.equal((await large.json()).error,'WORKFLOW_REQUEST_TOO_LARGE');
});
