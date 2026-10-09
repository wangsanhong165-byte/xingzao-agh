import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplicationCaseRouter} from './application-case-http.mjs';
const res=()=>({status:null,body:null,writeHead(status){this.status=status},end(body){this.body=JSON.parse(body)}});
test('case GET reads an existing manifest only and never starts tasks',async()=>{
 const calls=[];const store={read:async id=>{calls.push(id);return {id,state:'verified'}},create:()=>{throw Error('MUST_NOT_CREATE')},start:()=>{throw Error('MUST_NOT_START')}};
 const router=createApplicationCaseRouter({store}),r=res();assert.equal(await router.handle({method:'GET',url:'/api/application-cases/yellow-character-print-v1',headers:{}},r),true);assert.equal(r.status,200);assert.deepEqual(calls,['yellow-character-print-v1']);
 const post=res();await router.handle({method:'POST',url:'/api/application-cases/yellow-character-print-v1',headers:{}},post);assert.equal(post.status,405);assert.equal(calls.length,1);
 const foreign=res();await router.handle({method:'GET',url:'/api/application-cases/yellow-character-print-v1',headers:{origin:'https://foreign.example'}},foreign);assert.equal(foreign.status,403);assert.equal(calls.length,1);
});
test('missing or changed case cannot claim a verified delivery',async()=>{
 const missing=createApplicationCaseRouter({store:{read:async()=>null}}),a=res();await missing.handle({method:'GET',url:'/api/application-cases/no-case',headers:{}},a);assert.equal(a.status,404);
 const changed=createApplicationCaseRouter({store:{read:async()=>{throw Error('CASE_FILE_CHANGED')}}}),b=res();await changed.handle({method:'GET',url:'/api/application-cases/changed',headers:{}},b);assert.equal(b.status,409);assert.equal(b.body.error,'CASE_FILE_CHANGED');assert.equal(b.body.print,undefined);
});
