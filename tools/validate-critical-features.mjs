import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtureFeatureDeclarations} from './critical-feature-fixtures.mjs';
import {createPoseCandidate} from '../src/pose-geometry.mjs';
import {prepareFeatureProbes,verifyFeatureProbeEvidence} from '../src/critical-feature-service.mjs';
import {auditCriticalFeatures} from '../src/critical-feature-audit.mjs';
import {sliceArtifact} from '../src/slicer.mjs';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),sha=b=>createHash('sha256').update(b).digest('hex');
const execFile=promisify(execFileCallback);
const out=path.join(root,'data/critical-validation',`${new Date().toISOString().slice(0,10)}-${randomUUID()}`);await mkdir(out,{recursive:true});
const results=[];
const diameters=process.argv.includes('--larger')?[.5,.8,1]:[.07,.14,.3,.5];
for(const diameter of diameters){
  const dir=path.join(out,`pin-${diameter}`);await mkdir(dir,{recursive:true});
  const sourcePath=path.join(dir,'source.stl');
  await execFile(path.join(root,'data/reconstruction/env-torch-readonly/Scripts/python.exe'),[path.join(root,'tools/reconstruction/feature_fixture.py'),'--pin-diameter',String(diameter),'--output',sourcePath],{cwd:root,shell:false,windowsHide:true,timeout:30000});
  const bytes=await readFile(sourcePath);
  const features=fixtureFeatureDeclarations(diameter),probe=await prepareFeatureProbes({sourceStlPath:sourcePath,expectedSourceSha256:sha(bytes),features});
  const pose=createPoseCandidate({sourceBuffer:bytes,poseId:'upright'}),stlPath=path.join(dir,'pose.stl');await writeFile(stlPath,pose.buffer);
  const slice=await sliceArtifact({stlPath,outputDir:path.join(dir,'slice'),profileId:'fdm-pla-04-auto-support'});
  const audit=auditCriticalFeatures(await readFile(slice.gcodePath,'utf8'),{probes:probe.probes,sourceToPrintMatrix4:pose.proof.sourceToPrintMatrix4,placementOffsetMm:slice.placementOffsetMm,placementVerified:slice.placementVerification.centeredAtRequestedPoint});
  const recheck=await verifyFeatureProbeEvidence(probe);
  const result={pinDiameterMm:diameter,sourceSha256:sha(bytes),definitions:features,probeEvidence:{probesSha256:probe.probesSha256,recipeSha256:probe.recipeSha256,execution:probe.execution},poseProof:pose.proof,slice:{metrics:slice.metrics,proof:slice.proof,execution:slice.execution},audit,recheck};results.push(result);
  process.stdout.write(JSON.stringify({diameterMm:diameter,audit,recheck})+'\n');
}
const report={schema:'controlled-critical-feature-validation/v1',profileId:'fdm-pla-04-auto-support',source:'explicit-parametric-ground-truth',scope:'different-authorized-pin-geometries-are-not-same-source-pose-savings',allowedChange:{pinDiameterMm:[.07,1],baseSizeMm:[20,18,3],pinCenterMm:[5,0],pinTopZMm:5,holeCenterMm:[-4,0],holeDiameterMm:2},results,physicalPrintVerified:false};
const output=path.join(out,'report.json');await writeFile(output,JSON.stringify(report,null,2));process.stdout.write(JSON.stringify({output})+'\n');
