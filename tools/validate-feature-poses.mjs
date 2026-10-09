import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {inspectModelUpload} from '../src/model-import.mjs';
import {loadVerifiedImportedSource,evaluatePrintPose,buildPoseDecision,verifyPoseResult} from '../src/pose-comparison.mjs';
import {POSE_CANDIDATES} from '../src/pose-geometry.mjs';
import {fixtureFeatureDeclarations} from './critical-feature-fixtures.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const input=process.argv[2],diameter=Number(process.argv[3]);
if(!input||!Number.isFinite(diameter)||diameter<.05||diameter>1)throw new Error('FEATURE_POSE_ARGUMENTS_INVALID');
const absolute=path.resolve(root,input),rel=path.relative(path.join(root,'data'),absolute);
if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('FEATURE_POSE_INPUT_OUTSIDE_DATA');
const uploaded=await inspectModelUpload({name:'controlled-pin-and-hole.stl',mime:'model/stl',dataBase64:(await readFile(absolute)).toString('base64'),sourceUnits:'mm',targetLongestEdgeMm:20});
const source=await loadVerifiedImportedSource(uploaded.candidateId),features=fixtureFeatureDeclarations(diameter);
const out=path.join(root,'data/feature-pose-validation',randomUUID());await mkdir(out,{recursive:true});
const rows=[];
for(const pose of POSE_CANDIDATES){
  try{rows.push(await evaluatePrintPose({sourceStlPath:source.sourceStlPath,expectedSourceSha256:source.sourceSha256,poseId:pose.id,outputDir:path.join(out,pose.id),criticalFeatures:features}));}
  catch(error){rows.push({poseId:pose.id,sourceSha256:source.sourceSha256,status:'failed',reason:error.message});}
  const r=rows.at(-1);process.stdout.write(JSON.stringify({poseId:r.poseId,status:r.status,audit:r.featureAudit,reason:r.reason??null})+'\n');
}
const decision=buildPoseDecision(rows),chosen=rows.find(r=>r.poseId===decision.recommendedPoseId),recheck=chosen?await verifyPoseResult(chosen):{verified:false,reason:'NO_VERIFIED_FEATURE_POSE'};
const output=path.join(out,'report.json');await writeFile(output,JSON.stringify({source:{kind:'imported',candidateId:source.candidateId,sourceSha256:source.sourceSha256},pinDiameterMm:diameter,features,decision,recheck,results:rows,scope:'same-source-feature-constrained-four-poses',physicalPrintVerified:false},null,2));
console.log(JSON.stringify({sourceCandidateId:source.candidateId,decision,recheck,output}));
