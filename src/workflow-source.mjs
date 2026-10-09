import {readdir,readFile,lstat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadVerifiedImportedSource,loadVerifiedReconstructionSource} from './pose-comparison.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=/^[a-f0-9]{64}$/u,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export function normalizeWorkflowSource(ref){
  if(ref?.kind==='imported'&&sha.test(ref.candidateId??'')&&Object.keys(ref).every(k=>['kind','candidateId'].includes(k)))return {kind:'imported',candidateId:ref.candidateId};
  if(ref?.kind==='reconstructed'&&uuid.test(ref.jobId??'')&&Object.keys(ref).every(k=>['kind','jobId'].includes(k)))return {kind:'reconstructed',jobId:ref.jobId};
  throw new Error('WORKFLOW_SOURCE_INVALID');
}
export async function loadWorkflowSource(ref){
  ref=normalizeWorkflowSource(ref);
  return ref.kind==='imported'?loadVerifiedImportedSource(ref.candidateId):loadVerifiedReconstructionSource(ref.jobId);
}
const validBounds=b=>Array.isArray(b)&&b.length===2&&b.every(p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite))&&b[0].every((v,i)=>v<b[1][i]);
export function normalizeWorkflowBounds(b){const pair=Array.isArray(b)?b:[b?.min,b?.max];if(!validBounds(pair))throw new Error('WORKFLOW_SOURCE_BOUNDS_INVALID');return pair.map(p=>[...p]);}
async function readSmall(file){const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile()||info.size>2*1024*1024)throw new Error('WORKFLOW_CATALOG_INVALID');return JSON.parse(await readFile(file,'utf8'));}
export async function listWorkflowSources({dataRoot=join(root,'data')}={}){
  const rows=[];
  for(const [kind,base,pattern] of [['imported',join(dataRoot,'import-jobs'),sha],['reconstructed',join(dataRoot,'reconstruction/jobs'),uuid]]){
    const dirs=await readdir(base,{withFileTypes:true}).catch(()=>[]);
    const ordered=await Promise.all(dirs.filter(d=>d.isDirectory()&&!d.isSymbolicLink()&&pattern.test(d.name)).slice(0,1000).map(async d=>({dir:d,at:(await lstat(join(base,d.name)).catch(()=>null))?.mtimeMs??0})));
    ordered.sort((a,b)=>b.at-a.at||a.dir.name.localeCompare(b.dir.name));
    let added=0;for(const {dir} of ordered){
      try{
        const state=await readSmall(join(base,dir.name,kind==='imported'?'summary.json':'state.json'));
        let row;
        if(kind==='imported'){
          if(state.verificationOfCandidateId||state.candidateId!==dir.name||state.geometryChecksPassed!==true||!sha.test(state.normalizedStlSha256??''))continue;
          row={source:{kind,candidateId:dir.name},sourceSha256:state.normalizedStlSha256,boundsMm:normalizeWorkflowBounds(state.normalizedBoundsMm),stlUrl:`/api/model-import/${dir.name}/stl`};
        }else{
          const c=state.candidates?.[state.submittedCandidateId];
          if(state.id!==dir.name||state.stage!=='completed'||!c?.geometryChecks?.passed||c.geometryChecks.stlSha256!==c.stlSha256||!sha.test(c.stlSha256??''))continue;
          row={source:{kind,jobId:dir.name},sourceSha256:c.stlSha256,boundsMm:normalizeWorkflowBounds(c.geometryChecks.metrics?.normalizedBoundsMm),stlUrl:`/api/reconstruction/jobs/${dir.name}/stl/${c.candidateId}?sha=${c.stlSha256}`};
        }
        const name=kind==='imported'&&typeof state.name==='string'?state.name.split(/[\\/]/u).at(-1).replace(/[\r\n]/gu,' ').slice(0,70):null;
        row.label=`${kind==='imported'?'导入模型':'照片重建'}${name?' · '+name:''} · ${row.boundsMm[0].map((v,i)=>(row.boundsMm[1][i]-v).toFixed(1)).join('×')} mm · ${dir.name.slice(0,8)}`;
        rows.push(row);if(++added>=20)break;
      }catch{/* Bad historical entries stay on disk and are omitted from the chooser. */}
    }
  }
  return {sources:rows};
}
