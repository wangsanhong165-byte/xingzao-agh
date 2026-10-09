import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPoseCandidate, EXTENDED_POSE_CANDIDATES } from './pose-geometry.mjs';
import { analyzeSupportPaths } from './support-evaluation.mjs';
import { getSlicerStatus, sliceArtifact, parseSlicerMetrics } from './slicer.mjs';
import { normalizeCriticalFeatures, prepareFeatureProbes, verifyFeatureProbeEvidence } from './critical-feature-service.mjs';
import { auditCriticalFeatures } from './critical-feature-audit.mjs';
import {normalizeContinuousRods,auditContinuousRods} from './continuous-rod-policy.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const POSE_PROFILE_ID='fdm-pla-04-auto-support';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const isSha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);

export async function loadVerifiedImportedSource(candidateId){
  if(!isSha(candidateId))throw new Error('SOURCE_CANDIDATE_ID_INVALID');
  const dir=path.join(ROOT,'data/import-jobs',candidateId),summary=JSON.parse(await readFile(await safeDataPath(path.join(dir,'summary.json')),'utf8'));
  if(summary.candidateId!==candidateId||summary.geometryChecksPassed!==true||summary.validationScope?.kind!=='geometry-only'||summary.normalizationStrategy!=='center-xy-z0-v1'||summary.normalizedStlFile!=='normalized.stl'||!isSha(summary.normalizedStlSha256)||!isSha(summary.inputSha256)||!['stl','glb'].includes(summary.format))throw new Error('IMPORTED_SOURCE_NOT_VERIFIED');
  const sourceStlPath=await safeDataPath(path.join(dir,'normalized.stl'));
  const input=await readFile(await safeDataPath(path.join(dir,`input.${summary.format}`)));
  if(hash(input)!==summary.inputSha256||hash(await readFile(sourceStlPath))!==summary.normalizedStlSha256)throw new Error('SOURCE_HASH_MISMATCH');
  // Recheck the actual original bytes in a new inspector workspace. Two
  // synchronized hashes cannot prove that unrelated normalized geometry came
  // from the submitted input. Preserve the original files and failed evidence.
  const {inspectModelUpload}=await import('./model-import.mjs');
  const fresh=await inspectModelUpload({name:`source-recheck.${summary.format}`,mime:summary.format==='stl'?'model/stl':'model/gltf-binary',dataBase64:input.toString('base64'),sourceUnits:summary.sourceUnits,targetLongestEdgeMm:summary.targetLongestEdgeMm},{verificationNonce:randomUUID()});
  if(fresh.verificationOfCandidateId!==candidateId||fresh.geometryChecksPassed!==true||fresh.normalizedStlSha256!==summary.normalizedStlSha256)throw new Error('IMPORTED_SOURCE_GEOMETRY_MISMATCH');
  return {kind:'imported',sourceJobId:null,candidateId,sourceStlPath,sourceSha256:summary.normalizedStlSha256,boundsMm:summary.normalizedBoundsMm};
}

export async function loadVerifiedReconstructionSource(jobId,{store}={}) {
  if(!store) store=new (await import('./reconstruction-jobs.mjs')).ReconstructionJobStore();
  const job=await store.load(jobId),c=job?.candidates?.[job?.submittedCandidateId];
  if(job?.stage!=='completed'||!c?.geometryChecks?.passed||c.geometryChecks.stlSha256!==c.stlSha256||!isSha(c.candidateId)||c.stlFile!==`${c.candidateId}.stl`||!isSha(c.stlSha256)) throw new Error('RECONSTRUCTION_SOURCE_NOT_VERIFIED');
  const sourceStlPath=path.join(ROOT,'data/reconstruction/generated',c.stlFile);
  if(hash(await readFile(await safeDataPath(sourceStlPath)))!==c.stlSha256) throw new Error('SOURCE_HASH_MISMATCH');
  return {sourceJobId:job.id,candidateId:c.candidateId,sourceStlPath,sourceSha256:c.stlSha256,boundsMm:c.geometryChecks.metrics?.normalizedBoundsMm??null};
}

async function safeDataPath(value,{directory=false}={}) {
  const absolute=path.resolve(value);
  const within=p=>{const rel=path.relative(path.join(ROOT,'data'),p);return rel&&!rel.startsWith(`..${path.sep}`)&&rel!=='..'&&!path.isAbsolute(rel);};
  if(!within(absolute)) throw new Error('POSE_PATH_OUTSIDE_DATA');
  if(directory) await mkdir(absolute,{recursive:true});
  const resolved=await realpath(absolute),info=await lstat(absolute);
  if(!within(resolved)||info.isSymbolicLink()|| (directory?!info.isDirectory():!info.isFile())) throw new Error('POSE_PATH_INVALID');
  return resolved;
}

function checkedRegions(regions,bounds) {
  if(!Array.isArray(regions)||regions.length>4) throw new Error('PROTECTED_REGIONS_INVALID');
  const seen=new Set();
  return regions.map(region=>{
    if(!region||typeof region.id!=='string'||!/^[A-Za-z0-9_-]{1,40}$/u.test(region.id)||seen.has(region.id)) throw new Error('PROTECTED_REGIONS_INVALID');
    seen.add(region.id);
    const b=region.boundsMm;
    if(!Array.isArray(b)||b.length!==2||b.some(p=>!Array.isArray(p)||p.length!==3||p.some(v=>typeof v!=='number'||!Number.isFinite(v)))) throw new Error('PROTECTED_REGIONS_INVALID');
    for(let axis=0;axis<3;axis++) if(b[0][axis]>=b[1][axis]||b[0][axis]<bounds[0][axis]-.001||b[1][axis]>bounds[1][axis]+.001) throw new Error('PROTECTED_REGION_OUTSIDE_SOURCE');
    return {id:region.id,boundsMm:b.map(p=>[...p])};
  });
}

export async function evaluatePrintPose({sourceStlPath,expectedSourceSha256,outputDir,poseId,protectedRegions=[],criticalFeatures=[],continuousRods=[],slice=sliceArtifact}) {
  if(!isSha(expectedSourceSha256)) throw new Error('SOURCE_HASH_REQUIRED');
  const source=await safeDataPath(sourceStlPath),bytes=await readFile(source);
  if(hash(bytes)!==expectedSourceSha256) throw new Error('SOURCE_HASH_MISMATCH');
  const {buffer,proof}=createPoseCandidate({sourceBuffer:bytes,poseId});
  const regions=checkedRegions(protectedRegions,proof.sourceBoundsMm);
  const features=normalizeCriticalFeatures(criticalFeatures,proof.sourceBoundsMm);
  const rods=normalizeContinuousRods(continuousRods,features,proof.sourceBoundsMm);
  const dir=await safeDataPath(outputDir,{directory:true});
  const stlPath=path.join(dir,'pose.stl'); await writeFile(stlPath,buffer);
  const base={poseId,sourceSha256:expectedSourceSha256,sourceStlPath:source,stlPath,poseProof:proof,protectedRegions:regions,criticalFeatures:features,...(rods.length?{continuousRods:rods}:{}),status:'unverified',protectionVerified:false};
  const dimensions=proof.printBoundsMm[0].map((v,i)=>proof.printBoundsMm[1][i]-v);
  if(dimensions.some(v=>!Number.isFinite(v)||v>180+1e-4||v<=0)) return {...base,status:'infeasible',reason:'BUILD_VOLUME_EXCEEDED'};
  const sliced=await slice({stlPath,outputDir:path.join(dir,'slice'),profileId:POSE_PROFILE_ID});
  const gcode=await readFile(sliced.gcodePath,'utf8');
  if(sliced.execution?.mode!=='actual-slicer'||sliced.proof?.profileId!==POSE_PROFILE_ID||sliced.proof?.settings?.supportMaterial!==true||sliced.proof?.sourceStlSha256!==proof.candidateSha256||sliced.proof?.gcodeSha256!==hash(Buffer.from(gcode))) throw new Error('POSE_SLICER_PROOF_INVALID');
  if(hash(await readFile(source))!==expectedSourceSha256||hash(await readFile(stlPath))!==proof.candidateSha256) throw new Error('SOURCE_OR_POSE_CHANGED');
  const auditOptions={printToSourceMatrix4:proof.printToSourceMatrix4,placementOffsetMm:sliced.placementOffsetMm,placementVerified:sliced.placementVerification?.centeredAtRequestedPoint===true&&sliced.placementVerification?.modelPathsUsed===true,protectedRegions:regions,layerHeightMm:sliced.proof.settings.layerHeightMm};
  const supportAudit=analyzeSupportPaths(gcode,auditOptions);
  let featureProbeEvidence=null,featureAudit=null;
  if(features.length){
    featureProbeEvidence=await prepareFeatureProbes({sourceStlPath:source,expectedSourceSha256,features});
    if(featureProbeEvidence.execution!=='actual-source-mesh-probe')throw new Error('ACTUAL_SOURCE_PROBE_REQUIRED');
    featureAudit=auditCriticalFeatures(gcode,{probes:featureProbeEvidence.probes,sourceToPrintMatrix4:proof.sourceToPrintMatrix4,placementOffsetMm:sliced.placementOffsetMm,placementVerified:auditOptions.placementVerified});
  }
  const rodContinuityAudits=auditContinuousRods(gcode,rods,{sourceToPrintMatrix4:proof.sourceToPrintMatrix4,placementOffsetMm:sliced.placementOffsetMm,placementVerified:auditOptions.placementVerified});
  const result={...base,status:supportAudit.verified?'verified':'unverified',protectionVerified:supportAudit.protectionVerified===true,slice:sliced,supportAudit,auditOptions,featureAudit,featureProbeEvidence,...(rods.length?{continuousRods:rods,rodContinuityAudits}:{})};
  await writeFile(path.join(dir,'evidence.json'),JSON.stringify(result,null,2));
  return result;
}

export function buildPoseDecision(results,{maxRegionSupportPathLengthMm=null}={}) {
  if(!Array.isArray(results)||results.length<1||results.length>5) throw new Error('POSE_RESULTS_INVALID');
  if(maxRegionSupportPathLengthMm!==null&&(typeof maxRegionSupportPathLengthMm!=='number'||!Number.isFinite(maxRegionSupportPathLengthMm)||maxRegionSupportPathLengthMm<0||maxRegionSupportPathLengthMm>1000000)) throw new Error('PROTECTION_LIMIT_INVALID');
  const ids=new Set(),source=results[0].sourceSha256,config=results.find(r=>r.slice?.proof)?.slice.proof.profileSha256;
  for(const r of results){
    if(ids.has(r.poseId)||!EXTENDED_POSE_CANDIDATES.some(p=>p.id===r.poseId)) throw new Error('POSE_RESULTS_INVALID');ids.add(r.poseId);
    if(r.sourceSha256!==source) throw new Error('MIXED_SOURCE');
    if(r.slice?.proof&&(r.slice.proof.profileId!==POSE_PROFILE_ID||r.slice.proof.profileSha256!==config)) throw new Error('MIXED_PROFILE');
  }
  const feasible=[],rejected=[];
  for(const r of results){
    const m=r.slice?.metrics;
    let reason=r.status!=='verified'||r.supportAudit?.verified!==true||r.poseProof?.rigidTransformVerified!==true?'EVIDENCE_NOT_VERIFIED':null;
    if(!reason&&(!m||typeof m.filamentG!=='number'||!Number.isFinite(m.filamentG)||m.filamentG<=0||typeof m.estimatedTimeSeconds!=='number'||!Number.isFinite(m.estimatedTimeSeconds)||m.estimatedTimeSeconds<=0)) reason='COST_METRICS_UNVERIFIED';
    if(!reason&&r.criticalFeatures?.length){
      if(r.featureAudit?.verified!==true)reason='CRITICAL_FEATURE_UNVERIFIED';
      else if(r.featureAudit?.passed!==true)reason='CRITICAL_FEATURE_NOT_RETAINED';
    }
    if(!reason&&r.continuousRods?.length){
      const audits=r.rodContinuityAudits;
      if(!Array.isArray(audits)||audits.length!==r.continuousRods.length||r.continuousRods.some((rod,i)=>audits[i]?.id!==rod.id||audits[i]?.audit?.verified!==true))reason='ROD_CONTINUITY_UNVERIFIED';
      else if(audits.some(x=>x.audit.passed!==true))reason='ROD_CONTINUITY_NOT_RETAINED';
    }
    if(!reason&&maxRegionSupportPathLengthMm!==null){
      if(r.protectionVerified!==true||!r.supportAudit.regions?.length) reason='PROTECTION_NOT_CONFIRMED';
      else if(r.supportAudit.regions.some(roi=>!Number.isFinite(roi.supportPathLengthMm)||roi.supportPathLengthMm>maxRegionSupportPathLengthMm+1e-6)) reason='PROTECTED_REGION_SUPPORT_LIMIT';
    }
    if(reason) rejected.push({poseId:r.poseId,reason}); else feasible.push(r);
  }
  feasible.sort((a,b)=>a.slice.metrics.filamentG-b.slice.metrics.filamentG||a.slice.metrics.estimatedTimeSeconds-b.slice.metrics.estimatedTimeSeconds||a.poseId.localeCompare(b.poseId));
  const best=feasible[0]??null,baseline=results.find(r=>r.poseId==='upright');
  const baselineComparable=feasible.includes(baseline);
  const baselineMass=baselineComparable?baseline?.slice?.metrics?.filamentG:null,baselineTime=baselineComparable?baseline?.slice?.metrics?.estimatedTimeSeconds:null;
  return {recommendedPoseId:best?.poseId??null,feasiblePoseIds:feasible.map(r=>r.poseId),rejected,constraints:{maxRegionSupportPathLengthMm},materialChangePercent:best&&typeof baselineMass==='number'&&baselineMass>0?100*(best.slice.metrics.filamentG-baselineMass)/baselineMass:null,timeChangePercent:best&&typeof baselineTime==='number'&&baselineTime>0?100*(best.slice.metrics.estimatedTimeSeconds-baselineTime)/baselineTime:null,scope:'best-among-tested-feasible-poses',physicalPrintVerified:false,protectionVerified:best?.protectionVerified===true};
}

export async function verifyPoseResult(result) {
  try {
    if(result.status!=='verified'||!result.poseProof?.rigidTransformVerified||result.supportAudit?.verified!==true) throw new Error('POSE_EVIDENCE_NOT_VERIFIED');
    const sourcePath=await safeDataPath(result.sourceStlPath),stlPath=await safeDataPath(result.stlPath),gcodePath=await safeDataPath(result.slice.gcodePath);
    const source=await readFile(sourcePath),stl=await readFile(stlPath),gcode=await readFile(gcodePath);
    const status=await getSlicerStatus({profileId:POSE_PROFILE_ID});
    const profileBytes=await readFile(status.profilePath);
    if(hash(source)!==result.sourceSha256||hash(stl)!==result.poseProof.candidateSha256||hash(gcode)!==result.slice.proof.gcodeSha256||hash(profileBytes)!==result.slice.proof.profileSha256) throw new Error('POSE_EVIDENCE_HASH_MISMATCH');
    const reproduced=createPoseCandidate({sourceBuffer:source,poseId:result.poseId});
    if(reproduced.proof.candidateSha256!==hash(stl)||JSON.stringify(reproduced.proof.printToSourceMatrix4)!==JSON.stringify(result.auditOptions.printToSourceMatrix4)||JSON.stringify(reproduced.proof.sourceToPrintMatrix4)!==JSON.stringify(result.poseProof.sourceToPrintMatrix4)) throw new Error('POSE_TRANSFORM_MISMATCH');
    const bounds=reproduced.proof.printBoundsMm;
    checkedRegions(result.protectedRegions,reproduced.proof.sourceBoundsMm);
    const configuredLayerHeight=Number(profileBytes.toString('utf8').match(/^layer_height\s*=\s*([^\r\n]+)/mu)?.[1]);
    if(!Number.isFinite(configuredLayerHeight)||configuredLayerHeight!==result.auditOptions.layerHeightMm) throw new Error('POSE_LAYER_HEIGHT_MISMATCH');
    const expectedOffset={x:Number((90-(bounds[0][0]+bounds[1][0])/2).toFixed(4)),y:Number((90-(bounds[0][1]+bounds[1][1])/2).toFixed(4)),z:Number(Math.max(0,-bounds[0][2]).toFixed(4))};
    if(JSON.stringify(result.auditOptions.protectedRegions)!==JSON.stringify(result.protectedRegions)||['x','y','z'].some(axis=>Math.abs(result.auditOptions.placementOffsetMm[axis]-expectedOffset[axis])>1e-4||result.auditOptions.placementOffsetMm[axis]!==result.slice.placementOffsetMm[axis])||result.auditOptions.layerHeightMm!==result.slice.proof.settings.layerHeightMm||result.slice.proof.sourceStlSha256!==hash(stl)) throw new Error('POSE_AUDIT_METADATA_MISMATCH');
    const actualMetrics=parseSlicerMetrics(gcode.toString('utf8'));
    if(Object.keys(actualMetrics).length!==Object.keys(result.slice.metrics).length||Object.entries(actualMetrics).some(([key,value])=>result.slice.metrics[key]!==value)) throw new Error('POSE_COST_METRICS_MISMATCH');
    const audit=analyzeSupportPaths(gcode.toString('utf8'),result.auditOptions);
    if(!audit.verified||JSON.stringify(audit)!==JSON.stringify(result.supportAudit)||audit.protectionVerified!==result.protectionVerified) throw new Error('POSE_AUDIT_MISMATCH');
    if(result.criticalFeatures?.length){
      const definitions=normalizeCriticalFeatures(result.criticalFeatures,reproduced.proof.sourceBoundsMm),evidence=result.featureProbeEvidence;
      if(!evidence||evidence.execution!=='actual-source-mesh-probe'||evidence.sourceSha256!==result.sourceSha256||JSON.stringify(definitions)!==JSON.stringify(evidence.definitions))throw new Error('CRITICAL_FEATURE_EVIDENCE_MISMATCH');
      const verified=await verifyFeatureProbeEvidence(evidence);if(!verified.verified)throw new Error(verified.reason);
      const featureAudit=auditCriticalFeatures(gcode.toString('utf8'),{probes:evidence.probes,sourceToPrintMatrix4:reproduced.proof.sourceToPrintMatrix4,placementOffsetMm:expectedOffset,placementVerified:true});
      if(!featureAudit.verified||!featureAudit.passed||JSON.stringify(featureAudit)!==JSON.stringify(result.featureAudit))throw new Error('CRITICAL_FEATURE_RECHECK_FAILED');
    }else if(result.featureAudit||result.featureProbeEvidence)throw new Error('CRITICAL_FEATURE_DECLARATION_MISSING');
    const rods=normalizeContinuousRods(result.continuousRods??[],result.criticalFeatures??[],reproduced.proof.sourceBoundsMm);
    const continuity=auditContinuousRods(gcode.toString('utf8'),rods,{sourceToPrintMatrix4:reproduced.proof.sourceToPrintMatrix4,placementOffsetMm:expectedOffset,placementVerified:true});
    if(rods.length&&(continuity.some(x=>!x.audit.verified||!x.audit.passed)||JSON.stringify(continuity)!==JSON.stringify(result.rodContinuityAudits)))throw new Error('ROD_CONTINUITY_RECHECK_FAILED');
    if(!rods.length&&result.rodContinuityAudits?.length)throw new Error('ROD_DECLARATION_MISSING');
    return {verified:true,sourceSha256:result.sourceSha256,candidateSha256:hash(stl),profileSha256:result.slice.proof.profileSha256,gcodeSha256:hash(gcode),scope:'files-transform-and-toolpath-audit-rechecked',physicalPrintVerified:false};
  } catch(error) {return {verified:false,reason:/^[A-Z0-9_]{1,64}$/u.test(error?.message??'')?error.message:'POSE_RECHECK_FAILED'};}
}
