import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createPoseRouter } from '../src/pose-http.mjs';
const id='12345678-1234-4234-8234-123456789012';
test('pose API strips private task state and rejects wrong origins and tool credentials',async t=>{
  const job={id,agentRunActive:true,accessToken:'a'.repeat(64)};
  const store={create:async()=>({...job,stage:'prepared'}),startAgent:async()=>{},get:()=>job,load:async()=>job,publicJob:()=>({id,stage:'agent-running'}),execute:async()=>({success:true}),readStl:async()=>Buffer.from('stl')};
  const router=createPoseRouter({store,status:async()=>({ready:true,model:'agnes-3.0-flash',profileId:'fdm-pla-04-auto-support'})});
  const server=http.createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end();}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/poses/status`).then(r=>r.json())).ready,true);
  const safe=await fetch(`${base}/api/poses/jobs/${id}`).then(r=>r.json());assert.equal('accessToken' in safe,false);
  assert.equal((await fetch(`${base}/api/poses/start`,{method:'POST',headers:{origin:'https://external.example','content-type':'application/json'},body:JSON.stringify({sourceJobId:id})})).status,403);
  assert.equal((await fetch(`${base}/api/poses/tool/inspect`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:id})})).status,403);
  assert.equal((await fetch(`${base}/api/poses/tool/inspect`,{method:'POST',headers:{'content-type':'application/json','x-print-task-access':job.accessToken},body:JSON.stringify({jobId:id})}).then(r=>r.json())).success,true);
});
