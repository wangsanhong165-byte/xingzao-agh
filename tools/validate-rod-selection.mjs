// Actual, read-only HTTP validation. Never creates a repair or starts AGH.
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {proposeLocalRod} from '../src/rod-target-proposal.mjs';
import {loadVerifiedReconstructionSource} from '../src/pose-comparison.mjs';
const base='http://127.0.0.1:4337',parentId='6d7e394a-7f41-46a5-b970-065e5741137c';
const input={parentPoseJobId:parentId,parentPoseId:'upright',targetFeatureId:'lamp-post',pointInPrintMm:[-2.75,0,15],axis:'z',maxRadialGrowthMm:.2,maxAddedVolumeMm3:20};
const before=await(await fetch(`${base}/api/repair/parent/${parentId}`)).json();
const evidence={schema:'visual-rod-selection-validation/v1',physicalPrintVerified:false,cases:[]};
for(const [name,patch,origin,expectedStatus] of [['complete-object-click',{},null,200],['outside-feature',{pointInPrintMm:[3,0,15]},null,400],['wrong-axis',{axis:'x'},null,400],['invalid-budget',{maxRadialGrowthMm:1.1},null,400],['foreign-origin',{},'https://example.com',403]]){
 const started=performance.now(),response=await fetch(`${base}/api/repair/target-proposal`,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify({...input,...patch})}),result=await response.json();
 if(response.status!==expectedStatus)throw new Error(`${name}: expected ${expectedStatus}, got ${response.status}`);
 if(response.ok&&(result.spec.maxRadialGrowthMm!==input.maxRadialGrowthMm||result.spec.maxAddedVolumeMm3!==input.maxAddedVolumeMm3||result.inspection.verified!==true||result.physicalPrintVerified!==false))throw new Error('Proposal contract mismatch');
 evidence.cases.push({name,status:response.status,durationMs:performance.now()-started,result});
}
const after=await(await fetch(`${base}/api/repair/parent/${parentId}`)).json();
if(JSON.stringify(before.events)!==JSON.stringify(after.events)||before.stage!==after.stage||after.agentRunActive)throw new Error('Readonly proposal changed parent execution');
evidence.parentExecutionUnchanged=true;
// Ordinary negative input: the retained model from the actual licensed dice photo run.
const jobId='520f4b79-0eba-4211-8bcf-5311f8b04889',verifiedSource=await loadVerifiedReconstructionSource(jobId),source=verifiedSource.sourceStlPath,bytes=await readFile(source),sha=createHash('sha256').update(bytes).digest('hex');
if(sha!==verifiedSource.sourceSha256)throw new Error('Generated input source changed');
const count=bytes.readUInt32LE(80);if(bytes.length!==84+count*50)throw new Error('Invalid generated STL');
let point=null,best=Infinity;for(let i=0;i<count;i++)for(let v=0;v<3;v++){const offset=84+i*50+12+v*12,p=[0,1,2].map(k=>bytes.readFloatLE(offset+k*4)),score=Math.abs(p[2]-15);if(score<best){point=p;best=score;}}
const started=performance.now();let rejected;
try{await proposeLocalRod({sourceStlPath:source,expectedSourceSha256:sha,pointInSourceMm:point,axis:'z',maxRadialGrowthMm:.2,maxAddedVolumeMm3:20});}catch(e){rejected=e.message;}
if(!rejected)throw new Error('Non-circular ordinary input unexpectedly fitted');
evidence.cases.push({name:'actual-photo-generated-dice-unsupported-rod',sourceJobId:jobId,sourceSha256:sha,faces:count,pointInSourceMm:point,axis:'z',rejected,durationMs:performance.now()-started,scope:'negative-input-only-not-general-repair-success'});
const dir=path.resolve('data/visual-rod-review-20261005');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'evidence.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({cases:evidence.cases.map(c=>({name:c.name,status:c.status??'rejected',code:c.rejected??c.result?.error??'OK',durationMs:Math.round(c.durationMs)})),parentExecutionUnchanged:true,evidenceFile:'data/visual-rod-review-20261005/evidence.json'}));
