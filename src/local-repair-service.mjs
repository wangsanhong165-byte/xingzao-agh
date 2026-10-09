import {createHash,randomUUID} from 'node:crypto';
import {execFile as execCallback} from 'node:child_process';
import {lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),data=path.join(root,'data');
const helper=path.join(root,'tools/reconstruction/local_rod_repair_v2.py'),legacyHelper=path.join(root,'tools/reconstruction/local_rod_repair.py'),python=path.join(data,'reconstruction/env-torch-readonly/Scripts/python.exe');
const execFile=promisify(execCallback),sha=b=>createHash('sha256').update(b).digest('hex');
const isSha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const stable=v=>Array.isArray(v)?`[${v.map(stable)}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')}}`:JSON.stringify(v);
const fail=code=>{throw new Error(code);};
const finite=v=>typeof v==='number'&&Number.isFinite(v);
let statusPromise;

async function geometryHelperForReceipt(expectedSha256){
 if(expectedSha256!==undefined&&!isSha(expectedSha256))fail('REPAIR_GEOMETRY_RECEIPT_CHANGED');
 for(const file of expectedSha256===undefined?[helper]:[helper,legacyHelper]){
  const fingerprint=sha(await readFile(file));
  if(expectedSha256===undefined||fingerprint===expectedSha256)return {path:file,sha256:fingerprint};
 }
 fail('REPAIR_GEOMETRY_RECEIPT_CHANGED');
}

export function normalizeRepairSpec(spec){
  if(!spec||!['x','y','z'].includes(spec.axis))fail('REPAIR_AXIS_INVALID');
  const axis='xyz'.indexOf(spec.axis),line=spec.centerLineMm,bounds=spec.allowedBoundsMm;
  for(const v of [line,bounds])if(!Array.isArray(v)||v.length!==2||v.some(p=>!Array.isArray(p)||p.length!==3||p.some(n=>!finite(n)||Math.abs(n)>500)))fail('REPAIR_COORDINATES_INVALID');
  if(line[1][axis]-line[0][axis]<.1||line[1][axis]-line[0][axis]>100||line[0].some((v,i)=>i!==axis&&v!==line[1][i]))fail('REPAIR_CENTERLINE_INVALID');
  for(let i=0;i<3;i++)if(bounds[0][i]>=bounds[1][i]||line.some(p=>p[i]<bounds[0][i]-1e-6||p[i]>bounds[1][i]+1e-6))fail('REPAIR_BOUNDS_INVALID');
  if(!finite(spec.maxRadialGrowthMm)||spec.maxRadialGrowthMm<=0||spec.maxRadialGrowthMm>1||!finite(spec.maxAddedVolumeMm3)||spec.maxAddedVolumeMm3<=0||spec.maxAddedVolumeMm3>10000)fail('REPAIR_BUDGET_INVALID');
  return {axis:spec.axis,centerLineMm:line.map(p=>[...p]),allowedBoundsMm:bounds.map(p=>[...p]),maxRadialGrowthMm:spec.maxRadialGrowthMm,maxAddedVolumeMm3:spec.maxAddedVolumeMm3};
}

export function repairRadiusOptions(inspection,spec,nozzleMm=.4){
  const source=inspection?.measuredRadiusMm,tolerance=inspection?.fitToleranceMm??0;
  if(!finite(source)||source<=0||!finite(tolerance)||tolerance<0||tolerance>.02||!finite(nozzleMm)||nozzleMm<=0)fail('REPAIR_INSPECTION_INVALID');
  const axis='xyz'.indexOf(spec.axis),center=spec.centerLineMm[0];
  const room=Math.min(...[0,1,2].filter(i=>i!==axis).flatMap(i=>[center[i]-spec.allowedBoundsMm[0][i],spec.allowedBoundsMm[1][i]-center[i]]));
  // Match the inspector's nominal cylindrical growth envelope. Actual Boolean
  // added volume is still independently checked before any candidate delivery.
  const length=spec.centerLineMm[1][axis]-spec.centerLineMm[0][axis];
  const volumeRadius=Math.sqrt(source*source+spec.maxAddedVolumeMm3/(Math.PI*length));
  return [1.5,1.75,2].map(m=>Number((nozzleMm*m/2).toFixed(5))).filter(r=>r>source+1e-5&&r-source+tolerance<=spec.maxRadialGrowthMm+1e-6&&r<=room+1e-6&&r<=volumeRadius+1e-6);
}

async function dataPath(value,{directory=false}={}){
  const p=path.resolve(value),inside=q=>{const r=path.relative(data,q);return r&&r!=='..'&&!r.startsWith(`..${path.sep}`)&&!path.isAbsolute(r);};
  if(!inside(p))fail('REPAIR_PATH_INVALID');
  if(directory)await mkdir(p,{recursive:true});
  const s=await lstat(p),real=await realpath(p);
  if(s.isSymbolicLink()||!inside(real)||(directory?!s.isDirectory():!s.isFile())||(!directory&&s.size>25*1024*1024))fail('REPAIR_PATH_INVALID');
  return real;
}

export async function getLocalRepairStatus(){
  if(!statusPromise)statusPromise=(async()=>{try{await readFile(helper);await execFile(python,['-c','import trimesh, manifold3d, rtree'],{windowsHide:true,shell:false,timeout:10000,maxBuffer:1024});return {available:true,scope:'axis-aligned-confirmed-circular-rod'};}catch{return {available:false,scope:'axis-aligned-confirmed-circular-rod'};}})();
  return statusPromise;
}

async function runGeometry({mode,sourceStlPath,expectedSourceSha256,spec,radiusMm,outputDir,candidateStlPath,expectedCandidateSha256,expectedHelperSha256}){
  if(!isSha(expectedSourceSha256))fail('REPAIR_SOURCE_HASH_REQUIRED');
  const source=await dataPath(sourceStlPath),bytes=await readFile(source);
  if(sha(bytes)!==expectedSourceSha256)fail('REPAIR_SOURCE_CHANGED');
  const normalized=normalizeRepairSpec(spec),dir=await dataPath(outputDir,{directory:true});
  const rel=path.relative(path.join(data,'repair-jobs'),dir);
  if(!rel||rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))fail('REPAIR_OUTPUT_PATH_INVALID');
  const selectedHelper=await geometryHelperForReceipt(expectedHelperSha256),helperPath=selectedHelper.path,helperSha256=selectedHelper.sha256;
  const request={mode,sourceStlPath:source,expectedSourceSha256,outputDir:dir,spec:normalized};
  if(mode!=='inspect'){
    if(!finite(radiusMm)||radiusMm<=0||radiusMm>5)fail('REPAIR_RADIUS_INVALID');request.radiusMm=radiusMm;
  }
  if(mode==='verify'){
    request.candidateStlPath=await dataPath(candidateStlPath);request.expectedCandidateSha256=expectedCandidateSha256;
    if(!isSha(expectedCandidateSha256)||sha(await readFile(request.candidateStlPath))!==expectedCandidateSha256)fail('REPAIR_CANDIDATE_CHANGED');
  }
  const requestPath=path.join(dir,'request.json'),geometryPath=path.join(dir,'geometry.json');
  await writeFile(requestPath,JSON.stringify(request),{flag:'wx'});
  const env=Object.fromEntries(['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
  try{await execFile(python,[helperPath,'--request',requestPath],{cwd:root,env,windowsHide:true,shell:false,timeout:90000,maxBuffer:8192,encoding:'utf8'});}catch(e){const code=String(e.stderr??'').trim();fail(/^[A-Z0-9_]{1,64}$/u.test(code)?code:e.killed?'REPAIR_GEOMETRY_TIMEOUT':'REPAIR_GEOMETRY_FAILED');}
  if(sha(await readFile(source))!==expectedSourceSha256||sha(await readFile(helperPath))!==helperSha256)fail('REPAIR_SOURCE_OR_HELPER_CHANGED');
  const reportBytes=await readFile(await dataPath(geometryPath));if(reportBytes.length>256*1024)fail('REPAIR_REPORT_TOO_LARGE');
  const report=JSON.parse(reportBytes.toString('utf8'));
  if(report.schema!=='local-rod-repair/v1'||report.mode!==mode||report.sourceSha256!==expectedSourceSha256||stable(report.spec)!==stable(normalized)||report.validation?.verified!==true||(mode!=='inspect'&&report.radiusMm!==radiusMm))fail('REPAIR_GEOMETRY_PROOF_INVALID');
  const candidate=mode==='apply'?await dataPath(path.join(dir,'candidate.stl')):mode==='verify'?request.candidateStlPath:null;
  if(candidate&&(!isSha(report.candidateSha256)||sha(await readFile(candidate))!==report.candidateSha256))fail('REPAIR_CANDIDATE_CHANGED');
  return {sourceStlPath:source,sourceSha256:expectedSourceSha256,spec:normalized,...(radiusMm===undefined?{}:{radiusMm}),helperSha256,paramsSha256:sha(Buffer.from(stable({sourceSha256:expectedSourceSha256,spec:normalized,radiusMm:radiusMm??null}))),geometryPath,geometrySha256:sha(reportBytes),geometry:report,...(candidate?{candidateStlPath:candidate,candidateSha256:report.candidateSha256}:{}),execution:'actual-local-mesh-repair'};
}

export const inspectLocalRod=options=>runGeometry({...options,mode:'inspect'});
export const applyLocalRod=options=>runGeometry({...options,mode:'apply'});

function assertReceiptBinding(receipt){
  const g=receipt.geometry;
  if(g?.mode!=='apply'||g.sourceSha256!==receipt.sourceSha256||g.candidateSha256!==receipt.candidateSha256||g.helperSha256!==receipt.helperSha256||g.radiusMm!==receipt.radiusMm||stable(g.spec)!==stable(normalizeRepairSpec(receipt.spec)))fail('REPAIR_GEOMETRY_RECEIPT_CHANGED');
}

export async function verifyLocalRod(receipt){
  try{
    assertReceiptBinding(receipt);
    const bytes=await readFile(await dataPath(receipt.geometryPath));
    await geometryHelperForReceipt(receipt.helperSha256);
    if(receipt.execution!=='actual-local-mesh-repair'||sha(bytes)!==receipt.geometrySha256||stable(JSON.parse(bytes))!==stable(receipt.geometry))fail('REPAIR_GEOMETRY_RECEIPT_CHANGED');
    if(receipt.paramsSha256!==sha(Buffer.from(stable({sourceSha256:receipt.sourceSha256,spec:normalizeRepairSpec(receipt.spec),radiusMm:receipt.radiusMm}))))fail('REPAIR_PARAMETERS_CHANGED');
    const dir=path.join(path.dirname(path.dirname(receipt.geometryPath)),'verify-'+randomUUID());
    const result=await runGeometry({mode:'verify',sourceStlPath:receipt.sourceStlPath,expectedSourceSha256:receipt.sourceSha256,spec:receipt.spec,radiusMm:receipt.radiusMm,outputDir:dir,candidateStlPath:receipt.candidateStlPath,expectedCandidateSha256:receipt.candidateSha256,expectedHelperSha256:receipt.helperSha256});
    return {verified:true,sourceSha256:receipt.sourceSha256,candidateSha256:receipt.candidateSha256,validation:result.geometry.validation,scope:'fresh-source-candidate-boolean-budget-check'};
  }catch(e){return {verified:false,reason:/^[A-Z0-9_]{1,64}$/u.test(e.message??'')?e.message:'REPAIR_GEOMETRY_RECHECK_FAILED'};}
}

export const repairServiceInternals={stable,sha,assertReceiptBinding,geometryHelperForReceipt};
