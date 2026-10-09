import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listWorkflowSources} from './workflow-source.mjs';
test('source catalog accepts legacy min/max while excluding internal geometry rechecks',async t=>{
 const data=await mkdtemp(join(tmpdir(),'workflow-catalog-'));t.after(()=>rm(data,{recursive:true,force:true}));
 const original='1'.repeat(64),recheck='f'.repeat(64);
 for(const id of [original,recheck]){const dir=join(data,'import-jobs',id);await mkdir(dir,{recursive:true});await writeFile(join(dir,'summary.json'),JSON.stringify({candidateId:id,geometryChecksPassed:true,normalizedStlSha256:'a'.repeat(64),normalizedBoundsMm:{min:[-6,-4,0],max:[6,4,30]},name:'original-lamp.stl',...(id===recheck?{verificationOfCandidateId:original}:{})}));}
 const result=await listWorkflowSources({dataRoot:data});assert.equal(result.sources.length,1);assert.equal(result.sources[0].source.candidateId,original);assert.deepEqual(result.sources[0].boundsMm,[[-6,-4,0],[6,4,30]]);assert.match(result.sources[0].label,/original-lamp/);
});
