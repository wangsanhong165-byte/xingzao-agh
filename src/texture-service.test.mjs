import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {runTextureWorker} from './texture-service.mjs';

test('worker is invoked with a file argument, no shell and an environment without model credentials',async()=>{
 const base=path.resolve('data/texture/tests');await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'spawn-'));let seen;
 try{
  const result=await runTextureWorker({mode:'verify',outputDir:dir},{spawn:async(exe,args,options)=>{seen={exe,args,options};return {stdout:'{"success":true,"code":"OK"}'};}});
  assert.equal(result.success,true);assert.equal(seen.options.shell,false);assert.equal(seen.options.windowsHide,true);assert.doesNotMatch(JSON.stringify(seen.options.env),/API_KEY|ACCESS_TOKEN|AGH_HOME|AUTHORIZATION/);assert.equal(seen.args.at(-2),'--request');assert.match(seen.args.at(-1),/request-verify-/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('invalid or noisy worker response fails closed without exposing stderr',async()=>{
 const base=path.resolve('data/texture/tests');await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'response-'));
 try{
  assert.deepEqual(await runTextureWorker({mode:'verify',outputDir:dir},{spawn:async()=>({stdout:'noise\n{"success":true}'})}),{success:false,code:'TEXTURE_ENGINE_FAILURE'});
  assert.deepEqual(await runTextureWorker({mode:'verify',outputDir:dir},{spawn:async()=>{throw Object.assign(new Error('private failure'),{stderr:'do not expose this'});}}),{success:false,code:'TEXTURE_ENGINE_FAILURE'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
