import {createHash,randomUUID} from 'node:crypto';
import {execFile as execFileCallback} from 'node:child_process';
import {lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataRoot=path.join(root,'data');
const helper=path.join(root,'tools/reconstruction/feature_probes.py');
const python=path.join(root,'data/reconstruction/env-torch-readonly/Scripts/python.exe');
const execFile=promisify(execFileCallback);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const shaPattern=/^[a-f0-9]{64}$/u;
const gridDimensions=Object.freeze([32,32,32]);
const memo=new Map();
const verifiedProbeMemos=new WeakMap();
let statusPromise;
const stable=value=>Array.isArray(value)?`[${value.map(stable).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`:JSON.stringify(value);
const verificationKey=e=>hash(Buffer.from(stable({sourceStlPath:e.sourceStlPath,sourceSha256:e.sourceSha256,probesSha256:e.probesSha256,definitionsSha256:e.definitionsSha256,helperSha256:e.helperSha256,recipeSha256:e.recipeSha256})));
function verificationMemo(runner){let cache=verifiedProbeMemos.get(runner);if(!cache){cache=new Map();verifiedProbeMemos.set(runner,cache);}return cache;}
function rememberGeneratedProbe(e,runner){
  const cache=verificationMemo(runner);cache.set(verificationKey(e),{verified:true,sourceSha256:e.sourceSha256,probesSha256:e.probesSha256,definitionsSha256:e.definitionsSha256});
  if(cache.size>16)cache.delete(cache.keys().next().value);
}

export async function getCriticalFeatureStatus(){
  if(!statusPromise)statusPromise=(async()=>{
    try{
      await readFile(helper);
      const check=await execFile(python,['-c','import json, numpy, trimesh, rtree; print(json.dumps(trimesh.creation.box().contains([[0,0,0],[2,0,0]]).tolist()))'],{cwd:root,windowsHide:true,shell:false,timeout:10000,maxBuffer:1024,encoding:'utf8'});
      if(JSON.stringify(JSON.parse(check.stdout.trim()))!==JSON.stringify([true,false]))throw new Error('CHECK_FAILED');
      return {available:true,maxFeatures:4,defaultSurfaceToleranceMm:.05,scope:'software-feature-audit-engine'};
    }catch{return {available:false,maxFeatures:4,defaultSurfaceToleranceMm:.05,scope:'software-feature-audit-engine'};}
  })();return statusPromise;
}

export function normalizeCriticalFeatures(features=[],sourceBounds){
  if(!Array.isArray(features)||features.length>4)throw new Error('CRITICAL_FEATURES_INVALID');
  const ids=new Set();
  return features.map(f=>{
    if(!f||typeof f.id!=='string'||!/^[A-Za-z0-9_-]{1,40}$/u.test(f.id)||ids.has(f.id)||!['solid','void-channel'].includes(f.kind))throw new Error('CRITICAL_FEATURES_INVALID');ids.add(f.id);
    const bounds=f.boundsMm;
    if(!Array.isArray(bounds)||bounds.length!==2||bounds.some(p=>!Array.isArray(p)||p.length!==3||p.some(v=>typeof v!=='number'||!Number.isFinite(v))))throw new Error('CRITICAL_FEATURE_BOUNDS_INVALID');
    for(let i=0;i<3;i++){
      if(bounds[0][i]>=bounds[1][i])throw new Error('CRITICAL_FEATURE_BOUNDS_INVALID');
      if(sourceBounds&&(bounds[0][i]<sourceBounds[0][i]-1e-5||bounds[1][i]>sourceBounds[1][i]+1e-5))throw new Error('CRITICAL_FEATURE_OUTSIDE_SOURCE');
    }
    const minRetention=f.minRetention??.9;
    if(typeof minRetention!=='number'||!Number.isFinite(minRetention)||minRetention<.5||minRetention>1)throw new Error('CRITICAL_FEATURE_RETENTION_INVALID');
    const surfaceToleranceMm=f.surfaceToleranceMm??.05;
    if(typeof surfaceToleranceMm!=='number'||!Number.isFinite(surfaceToleranceMm)||surfaceToleranceMm<0||surfaceToleranceMm>.1)throw new Error('CRITICAL_FEATURE_TOLERANCE_INVALID');
    if(f.kind==='void-channel'&&!['x','y','z'].includes(f.axis))throw new Error('CRITICAL_FEATURE_AXIS_REQUIRED');
    if(f.kind==='solid'&&f.axis!==undefined)throw new Error('CRITICAL_FEATURE_AXIS_INVALID');
    return {id:f.id,kind:f.kind,boundsMm:bounds.map(p=>[...p]),minRetention,surfaceToleranceMm,...(f.kind==='void-channel'?{axis:f.axis}:{})};
  });
}

async function safeSourcePath(value){
  const absolute=path.resolve(value),rel=path.relative(dataRoot,absolute);
  if(!rel||rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))throw new Error('CRITICAL_SOURCE_PATH_INVALID');
  const actual=await realpath(absolute),info=await lstat(absolute),actualRel=path.relative(dataRoot,actual);
  if(info.isSymbolicLink()||!info.isFile()||info.size>25*1024*1024||actualRel==='..'||actualRel.startsWith(`..${path.sep}`)||path.isAbsolute(actualRel))throw new Error('CRITICAL_SOURCE_PATH_INVALID');
  return actual;
}

function validateProbeData(data,sourceSha,features){
  if(data?.schema!=='source-feature-probes/v1'||data.sourceSha256!==sourceSha||data.generator?.method!=='trimesh.contains-with-halo'||!Array.isArray(data.features)||data.features.length!==features.length)throw new Error('CRITICAL_PROBE_CONTRACT_INVALID');
  normalizeCriticalFeatures(features,data.sourceBoundsMm);
  for(let i=0;i<features.length;i++){
    const f=data.features[i],definition=Object.fromEntries(['id','kind','boundsMm','minRetention','surfaceToleranceMm','axis'].filter(k=>f[k]!==undefined).map(k=>[k,f[k]]));
    if(stable(definition)!==stable(features[i])||stable(f.grid?.dimensions)!==stable(gridDimensions)||f.grid?.order!=='x-fastest'||f.grid?.cellCenters!==true)throw new Error('CRITICAL_PROBE_CONTRACT_INVALID');
    const n=gridDimensions.reduce((a,b)=>a*b,1);
    if(f.sampleCount!==n||!Array.isArray(f.grid.stepMm)||f.grid.stepMm.length!==3||f.grid.stepMm.some((v,a)=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v-(features[i].boundsMm[1][a]-features[i].boundsMm[0][a])/gridDimensions[a])>1e-9))throw new Error('CRITICAL_PROBE_CONTRACT_INVALID');
    const solid=Buffer.from(f.solidMaskBase64??'','base64'),surface=Buffer.from(f.surfaceMaskBase64??'','base64');
    if(solid.length!==n||surface.length!==n||solid.some(v=>v!==0&&v!==1)||surface.some((v,j)=>v!==0&&v!==1||v>solid[j])||solid.reduce((a,b)=>a+b,0)!==f.solidSampleCount||surface.reduce((a,b)=>a+b,0)!==f.surfaceSampleCount)throw new Error('CRITICAL_PROBE_MASK_INVALID');
  }
}

async function runInspector({requestPath}){
  const env=Object.fromEntries(['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
  try{await execFile(python,[helper,'--request',requestPath],{cwd:root,env,windowsHide:true,shell:false,timeout:90000,maxBuffer:8192,encoding:'utf8'});}
  catch(error){const code=String(error.stderr??'').trim();throw new Error(/^[A-Z0-9_]{1,64}$/u.test(code)?code:error.killed?'CRITICAL_PROBE_TIMEOUT':'CRITICAL_PROBE_FAILED');}
}

export async function prepareFeatureProbes({sourceStlPath,expectedSourceSha256,features,fresh=false,runner=runInspector}){
  if(!shaPattern.test(expectedSourceSha256??''))throw new Error('CRITICAL_SOURCE_HASH_REQUIRED');
  const source=await safeSourcePath(sourceStlPath),sourceBytes=await readFile(source);
  if(hash(sourceBytes)!==expectedSourceSha256)throw new Error('SOURCE_HASH_MISMATCH');
  const definitions=normalizeCriticalFeatures(features);if(!definitions.length)throw new Error('CRITICAL_FEATURES_REQUIRED');
  const helperSha256=hash(await readFile(helper)),definitionsSha256=hash(Buffer.from(stable(definitions))),recipeSha256=hash(Buffer.from(stable({helperSha256,definitions,gridDimensions,schema:'source-feature-probes/v1'})));
  const key=hash(Buffer.from(`${expectedSourceSha256}:${recipeSha256}`));
  if(!fresh&&runner===runInspector&&memo.has(key)){
    const evidence=await memo.get(key);
    const bytes=await readFile(evidence.probesPath);
    if(hash(bytes)!==evidence.probesSha256)throw new Error('CRITICAL_PROBE_HASH_MISMATCH');
    if(stable(JSON.parse(bytes.toString('utf8')))!==stable(evidence.probes))throw new Error('CRITICAL_INLINE_PROBE_MISMATCH');
    return structuredClone(evidence);
  }
  const generate=async()=>{
    const probeId=randomUUID(),dir=path.join(dataRoot,'critical-features',probeId);await mkdir(dir,{recursive:true});
    const requestPath=path.join(dir,'request.json'),probesPath=path.join(dir,'probes.json');
    await writeFile(requestPath,JSON.stringify({sourceStlPath:source,expectedSourceSha256,outputPath:probesPath,features:definitions,gridDimensions}));
    await runner({requestPath});
    if(hash(await readFile(source))!==expectedSourceSha256)throw new Error('SOURCE_HASH_MISMATCH');
    const bytes=await readFile(probesPath);if(bytes.length>32*1024*1024)throw new Error('CRITICAL_PROBE_OUTPUT_TOO_LARGE');
    const probes=JSON.parse(bytes.toString('utf8'));validateProbeData(probes,expectedSourceSha256,definitions);
    const evidence={probeId,sourceStlPath:source,sourceSha256:expectedSourceSha256,definitions,definitionsSha256,helperSha256,recipeSha256,probesPath,probesSha256:hash(bytes),probes,execution:runner===runInspector?'actual-source-mesh-probe':'injected-test-runner'};
    rememberGeneratedProbe(evidence,runner);
    return evidence;
  };
  const pending=generate();
  if(!fresh&&runner===runInspector){memo.set(key,pending);if(memo.size>16)memo.delete(memo.keys().next().value);pending.catch(()=>memo.delete(key));}
  return structuredClone(await pending);
}

export async function verifyFeatureProbeEvidence(evidence,{runner=runInspector}={}){
  try{
    const bytes=await readFile(evidence.probesPath);
    if(hash(bytes)!==evidence.probesSha256)throw new Error('CRITICAL_PROBE_HASH_MISMATCH');
    const probes=JSON.parse(bytes.toString('utf8'));
    if(stable(probes)!==stable(evidence.probes))throw new Error('CRITICAL_INLINE_PROBE_MISMATCH');
    const source=await safeSourcePath(evidence.sourceStlPath);
    if(hash(await readFile(source))!==evidence.sourceSha256)throw new Error('SOURCE_HASH_MISMATCH');
    const helperSha256=hash(await readFile(helper)),definitions=normalizeCriticalFeatures(evidence.definitions),definitionsSha256=hash(Buffer.from(stable(definitions)));
    const recipeSha256=hash(Buffer.from(stable({helperSha256,definitions,gridDimensions,schema:'source-feature-probes/v1'})));
    if(evidence.helperSha256!==helperSha256||evidence.recipeSha256!==recipeSha256||evidence.definitionsSha256!==definitionsSha256)throw new Error('CRITICAL_PROBE_RECIPE_CHANGED');
    validateProbeData(probes,evidence.sourceSha256,definitions);
    // Only a probe actually generated in this process/runner namespace can be reused.
    // Re-read all bytes and bindings first; a synchronized forged digest misses this cache.
    const cached=verificationMemo(runner).get(verificationKey({...evidence,sourceStlPath:source}));
    if(cached)return structuredClone(cached);
    const fresh=await prepareFeatureProbes({sourceStlPath:source,expectedSourceSha256:evidence.sourceSha256,features:definitions,fresh:true,runner});
    if(fresh.probesSha256!==evidence.probesSha256||fresh.definitionsSha256!==evidence.definitionsSha256||fresh.recipeSha256!==evidence.recipeSha256)throw new Error('CRITICAL_SOURCE_PROBE_MISMATCH');
    return {verified:true,sourceSha256:evidence.sourceSha256,probesSha256:evidence.probesSha256,definitionsSha256:evidence.definitionsSha256};
  }catch(error){return {verified:false,reason:/^[A-Z0-9_]{1,64}$/u.test(error?.message??'')?error.message:'CRITICAL_PROBE_RECHECK_FAILED'};}
}
