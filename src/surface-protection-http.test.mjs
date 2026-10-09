import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createProtectRouter} from './surface-protection-http.mjs';
function req(url,method='GET',data=null,origin=null){const r=Readable.from(data===null?[]:[Buffer.from(JSON.stringify(data))]);r.url=url;r.method=method;r.headers=origin?{origin}:{};return r;}
function response(){return {status:null,headers:null,bytes:null,writeHead(s,h){this.status=s;this.headers=h},end(b){this.bytes=b}};}
test('region HTTP routes source listing, preparation and a confirmed start through the store',async()=>{
 const calls=[];const store={prepare:async x=>{calls.push(x);return {proposalId:'p'}},start:async x=>({id:x.proposalId}),publicById:async()=>null};
 const router=createProtectRouter({store,listSources:async()=>({sources:[]})});
 const r=response();assert.equal(await router.handle(req('/api/protect/sources'),r),true);assert.equal(r.status,200);
 const p=response();await router.handle(req('/api/protect/prepare','POST',{hello:'world'}),p);assert.equal(p.status,200);assert.deepEqual(calls,[{hello:'world'}]);
 const s=response();await router.handle(req('/api/protect/start','POST',{proposalId:'p',confirmed:true}),s);assert.equal(s.status,202);
});
test('GET cannot create tasks and foreign origins are rejected before store calls',async()=>{
 let called=false;const router=createProtectRouter({store:{start:async()=>{called=true}},listSources:async()=>({sources:[]})});
 const g=response();await router.handle(req('/api/protect/start'),g);assert.equal(g.status,404);assert.equal(called,false);
 const f=response();await router.handle(req('/api/protect/start','POST',{},'https://foreign.example'),f);assert.equal(f.status,403);assert.equal(called,false);
 const other=response();assert.equal(await router.handle(req('/api/something-else'),other),false);
});
test('proposal recovery is a read-only GET and forwards the frozen fingerprint',async()=>{
 const id='11111111-1111-4111-8111-111111111111',fp='a'.repeat(64),calls=[];
 const router=createProtectRouter({store:{resolveProposal:async(...args)=>{calls.push(args);return {state:'started',jobId:id}},start:()=>{throw Error('MUST_NOT_START')}}});
 const r=response();assert.equal(await router.handle(req(`/api/protect/proposals/${id}?fingerprint=${fp}`),r),true);assert.equal(r.status,200);assert.deepEqual(calls,[[id,fp]]);
 const post=response();await router.handle(req(`/api/protect/proposals/${id}?fingerprint=${fp}`,'POST',{}),post);assert.equal(post.status,404);assert.equal(calls.length,1);
 const foreign=response();await router.handle(req(`/api/protect/proposals/${id}?fingerprint=${fp}`,'GET',null,'https://foreign.example'),foreign);assert.equal(foreign.status,403);assert.equal(calls.length,1);
});
