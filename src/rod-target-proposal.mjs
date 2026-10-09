import {createHash,randomUUID} from 'node:crypto';
import {execFile as callbackExec} from 'node:child_process';
import {lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {normalizeRepairSpec} from './local-repair-service.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),data=path.join(root,'data');
const helper=path.join(root,'tools/reconstruction/rod_target_proposal.py'),dependency=path.join(root,'tools/reconstruction/local_rod_repair_v2.py');
const python=path.join(data,'reconstruction/env-torch-readonly/Scripts/python.exe'),exec=promisify(callbackExec);
const hash=b=>createHash('sha256').update(b).digest('hex'),fail=c=>{throw new Error(c);};let busy=false;

export function normalizeProposalInput(input){
 const point=input?.pointInPrintMm;
 if(!Array.isArray(point)||point.length!==3||point.some(v=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1000))fail('REPAIR_PICK_INVALID');
 if(!['x','y','z'].includes(input.axis))fail('REPAIR_AXIS_INVALID');
 for(const [key,limit] of [['maxRadialGrowthMm',1],['maxAddedVolumeMm3',10000]])if(typeof input[key]!=='number'||!Number.isFinite(input[key])||input[key]<=0||input[key]>limit)fail('REPAIR_BUDGET_INVALID');
 return {pointInPrintMm:[...point],axis:input.axis,maxRadialGrowthMm:input.maxRadialGrowthMm,maxAddedVolumeMm3:input.maxAddedVolumeMm3};
}

export async function proposeLocalRod({sourceStlPath,expectedSourceSha256,pointInSourceMm,axis,maxRadialGrowthMm,maxAddedVolumeMm3}){
 if(busy)fail('REPAIR_PROPOSAL_BUSY');busy=true;
 try{
  const source=path.resolve(sourceStlPath),relative=path.relative(data,source),info=await lstat(source),real=await realpath(source),realRelative=path.relative(data,real);
  const outside=r=>!r||r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r);
  if(outside(relative)||outside(realRelative)||info.isSymbolicLink()||!info.isFile()||info.size>25*1024*1024)fail('REPAIR_PATH_INVALID');
  const sourceHash=hash(await readFile(source));if(sourceHash!==expectedSourceSha256)fail('REPAIR_SOURCE_CHANGED');
  const helperSha256=hash(await readFile(helper)),dependencySha256=hash(await readFile(dependency));
  const dir=path.join(data,'rod-proposals',randomUUID());await mkdir(dir,{recursive:true});const requestPath=path.join(dir,'request.json');
  await writeFile(requestPath,JSON.stringify({sourceStlPath:real,expectedSourceSha256,pointInSourceMm,axis,maxRadialGrowthMm,maxAddedVolumeMm3}),{flag:'wx'});
  const env=Object.fromEntries(['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));let stdout;
  try{({stdout}=await exec(python,[helper,'--request',requestPath],{cwd:root,env,windowsHide:true,shell:false,timeout:30000,maxBuffer:256*1024,encoding:'utf8'}));}
  catch(e){const c=String(e.stderr??'').trim();fail(/^[A-Z0-9_]{1,64}$/u.test(c)?c:e.killed?'REPAIR_PROPOSAL_TIMEOUT':'REPAIR_PROPOSAL_FAILED');}
  if(hash(await readFile(source))!==sourceHash||hash(await readFile(helper))!==helperSha256||hash(await readFile(dependency))!==dependencySha256)fail('REPAIR_SOURCE_OR_HELPER_CHANGED');
  let report;try{report=JSON.parse(stdout);}catch{fail('REPAIR_PROPOSAL_INVALID');}
  if(report.schema!=='rod-target-proposal/v1'||report.sourceSha256!==sourceHash||report.helperSha256!==helperSha256||report.inspection?.verified!==true||report.physicalPrintVerified!==false)fail('REPAIR_PROPOSAL_INVALID');
  return {sourceSha256:sourceHash,helperSha256,dependencySha256,spec:normalizeRepairSpec(report.spec),inspection:report.inspection,scope:'axis-aligned-circular-rod-proposal',physicalPrintVerified:false};
 }finally{busy=false;}
}
