import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeCriticalFeatures,prepareFeatureProbes,verifyFeatureProbeEvidence} from './critical-feature-service.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const feature={id:'pin',kind:'solid',boundsMm:[[-1,-1,0],[1,1,2]],minRetention:.9};

test('feature declarations are bounded, typed and retain the requested immutable threshold',()=>{
  assert.equal(normalizeCriticalFeatures([feature],[[-2,-2,0],[2,2,3]])[0].minRetention,.9);
  assert.throws(()=>normalizeCriticalFeatures([{...feature,minRetention:0}]),/RETENTION/);
  assert.throws(()=>normalizeCriticalFeatures([{...feature,kind:'void-channel'}]),/AXIS/);
  assert.throws(()=>normalizeCriticalFeatures([feature],[[-.5,-.5,0],[.5,.5,3]]),/OUTSIDE/);
  assert.throws(()=>normalizeCriticalFeatures([feature,feature]),/INVALID/);
});
async function fixture(){const dir=path.join(root,'data/feature-service-tests',randomUUID());await mkdir(dir,{recursive:true});const stl=path.join(dir,'source.stl');const bytes=Buffer.from('fixture bytes only for service transport test');await writeFile(stl,bytes);return {stl,sourceSha:sha(bytes)};}
async function runner({requestPath}){
  const input=JSON.parse(await readFile(requestPath,'utf8'));
  const dims=input.gridDimensions,n=dims.reduce((a,b)=>a*b,1),mask=Buffer.alloc(n,1).toString('base64');
  const value={schema:'source-feature-probes/v1',sourceSha256:input.expectedSourceSha256,sourceBoundsMm:[[-2,-2,0],[2,2,3]],generator:{method:'trimesh.contains-with-halo',trimeshVersion:'test',rtreeVersion:'test'},features:input.features.map(f=>({...f,grid:{dimensions:dims,stepMm:f.boundsMm[0].map((v,a)=>(f.boundsMm[1][a]-v)/dims[a]),order:'x-fastest',cellCenters:true},sampleCount:n,solidSampleCount:n,surfaceSampleCount:n,solidMaskBase64:mask,surfaceMaskBase64:mask}))};
  await writeFile(input.outputPath,JSON.stringify(value));
}
test('probe evidence binds source and definitions, while a source change stops before the runner',async()=>{
  const f=await fixture();let calls=0;const run=async args=>{calls++;await runner(args);};
  const evidence=await prepareFeatureProbes({sourceStlPath:f.stl,expectedSourceSha256:f.sourceSha,features:[feature],runner:run,fresh:true});
  assert.equal(evidence.sourceSha256,f.sourceSha);assert.match(evidence.probesSha256,/^[a-f0-9]{64}$/);
  assert.equal((await verifyFeatureProbeEvidence(evidence,{runner:run})).verified,true);
  await writeFile(f.stl,'changed');
  const before=calls;
  await assert.rejects(prepareFeatureProbes({sourceStlPath:f.stl,expectedSourceSha256:f.sourceSha,features:[feature],runner:run,fresh:true}),/SOURCE_HASH_MISMATCH/);
  assert.equal(calls,before);
});
test('editing a probe and synchronizing its hash is detected by fresh source re-probing',async()=>{
  const f=await fixture(),e=await prepareFeatureProbes({sourceStlPath:f.stl,expectedSourceSha256:f.sourceSha,features:[feature],runner,fresh:true});
  const fake=JSON.parse(await readFile(e.probesPath,'utf8'));fake.features[0].surfaceSampleCount=1;
  const bytes=Buffer.from(JSON.stringify(fake));await writeFile(e.probesPath,bytes);e.probesSha256=sha(bytes);e.probes=fake;
  assert.equal((await verifyFeatureProbeEvidence(e,{runner})).verified,false);
});
test('inline probe data consumed by the auditor must match the verified file',async()=>{
  const f=await fixture(),e=await prepareFeatureProbes({sourceStlPath:f.stl,expectedSourceSha256:f.sourceSha,features:[feature],runner,fresh:true});
  e.probes.features[0].minRetention=.5;
  assert.equal((await verifyFeatureProbeEvidence(e,{runner})).verified,false);
});
test('reuses an actually generated probe only while source, recipe and bytes stay identical',async()=>{
  const f=await fixture();let calls=0;const run=async args=>{calls++;await runner(args);};
  const e=await prepareFeatureProbes({sourceStlPath:f.stl,expectedSourceSha256:f.sourceSha,features:[feature],runner:run,fresh:true});
  assert.equal((await verifyFeatureProbeEvidence(e,{runner:run})).verified,true);
  assert.equal((await verifyFeatureProbeEvidence(e,{runner:run})).verified,true);
  assert.equal(calls,1);
  await writeFile(f.stl,'changed after cached verification');
  assert.equal((await verifyFeatureProbeEvidence(e,{runner:run})).verified,false);
  assert.equal(calls,1);
});
test('a structurally valid forged probe with synchronized hashes misses the verified cache',async()=>{
  const f=await fixture();let calls=0;const run=async args=>{calls++;await runner(args);};
  const e=await prepareFeatureProbes({sourceStlPath:f.stl,expectedSourceSha256:f.sourceSha,features:[feature],runner:run,fresh:true});
  assert.equal((await verifyFeatureProbeEvidence(e,{runner:run})).verified,true);
  const fake=structuredClone(e.probes),item=fake.features[0],solid=Buffer.from(item.solidMaskBase64,'base64'),surface=Buffer.from(item.surfaceMaskBase64,'base64');
  solid[0]=0;surface[0]=0;item.solidMaskBase64=solid.toString('base64');item.surfaceMaskBase64=surface.toString('base64');item.solidSampleCount--;item.surfaceSampleCount--;
  const bytes=Buffer.from(JSON.stringify(fake));await writeFile(e.probesPath,bytes);e.probesSha256=sha(bytes);e.probes=fake;
  assert.equal((await verifyFeatureProbeEvidence(e,{runner:run})).verified,false);
  assert.equal(calls,2);
});
