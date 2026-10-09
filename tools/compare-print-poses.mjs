import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import modeling from '@jscad/modeling';
import serializer from '@jscad/stl-serializer';
import { POSE_CANDIDATES } from '../src/pose-geometry.mjs';
import { evaluatePrintPose, buildPoseDecision, verifyPoseResult, loadVerifiedReconstructionSource } from '../src/pose-comparison.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const caseName=option('--case')??'controlled';
if(!['controlled','character'].includes(caseName)) throw new Error('Unsupported comparison case');
const runId=`${new Date().toISOString().slice(0,10)}-${caseName}-${randomUUID()}`;
const out=path.join(root,'data/pose-comparisons',runId);await mkdir(out,{recursive:true});
let sourceStlPath,sourceSha256,regions,sourceProvenance;
if(caseName==='controlled') {
  const {primitives,transforms,booleans}=modeling;
  const stem=transforms.translate([0,0,12],primitives.cuboid({size:[8,8,24]}));
  const shelf=transforms.translate([10,0,26],primitives.cuboid({size:[28,14,4]}));
  const bytes=Buffer.concat(serializer.serialize({binary:true},booleans.union(stem,shelf)).map(p=>Buffer.from(p)));
  sourceStlPath=path.join(out,'source.stl');await writeFile(sourceStlPath,bytes);sourceSha256=hash(bytes);
  regions=[{id:'underside-demo',boundsMm:[[10,-6,24],[22,6,28]]}];
  sourceProvenance={kind:'controlled-parametric-overhang',regionSource:'explicit-demonstration-volume',physicalPrintVerified:false};
} else {
  const jobId=option('--job')??'1ac90d72-425f-4a6f-b9f8-50248baa6368';
  if(!/^[a-f0-9-]{36}$/u.test(jobId)) throw new Error('Invalid source job id');
  const source=await loadVerifiedReconstructionSource(jobId);
  sourceStlPath=source.sourceStlPath;sourceSha256=source.sourceSha256;
  regions=[{id:'upper-front-demo',boundsMm:[[-12,-24,55],[12,-8,85]]}];
  sourceProvenance={kind:'existing-generated-pressure-model',reconstructionJobId:jobId,candidateId:source.candidateId,regionSource:'demonstration-coordinate-volume-not-user-confirmed-semantic-face',physicalPrintVerified:false};
}
const limitRaw=option('--max-region-support-length');
const maxRegionSupportPathLengthMm=limitRaw===null?null:Number(limitRaw);
const results=[];
for(const pose of POSE_CANDIDATES) {
  const started=Date.now();
  try {results.push(await evaluatePrintPose({sourceStlPath,expectedSourceSha256:sourceSha256,outputDir:path.join(out,pose.id),poseId:pose.id,protectedRegions:regions}));}
  catch(error){results.push({poseId:pose.id,sourceSha256,status:'failed',reason:/^[A-Z0-9_]{1,64}$/u.test(error?.message??'')?error.message:'POSE_EVALUATION_FAILED'});}
  const r=results.at(-1);
  process.stdout.write(JSON.stringify({poseId:r.poseId,status:r.status,elapsedSeconds:(Date.now()-started)/1000,massG:r.slice?.metrics?.filamentG??null,timeSeconds:r.slice?.metrics?.estimatedTimeSeconds??null,supportPathMm:r.supportAudit?.support?.pathLengthMm??null,regionPathMm:r.supportAudit?.regions?.[0]?.supportPathLengthMm??null,warnings:r.supportAudit?.warnings??[],reason:r.reason??null})+'\n');
}
const decision=buildPoseDecision(results,{maxRegionSupportPathLengthMm});
const selected=results.find(r=>r.poseId===decision.recommendedPoseId);
const recheck=selected?await verifyPoseResult(selected):{verified:false,reason:'NO_FEASIBLE_POSE'};
const report={schema:'pose-comparison/v1',runId,sourceProvenance,sourceSha256,protectedRegions:regions,decision,recheck,results,scope:'fixed-source-scale-and-profile-four-rigid-poses',physicalPrintVerified:false};
await writeFile(path.join(out,'comparison.json'),JSON.stringify(report,null,2));
process.stdout.write(JSON.stringify({report:path.join(out,'comparison.json'),decision,recheck})+'\n');
if(!recheck.verified&&decision.recommendedPoseId)process.exitCode=1;
