import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectModelUpload} from '../src/model-import.mjs';
import {loadVerifiedImportedSource,evaluatePrintPose,buildPoseDecision} from '../src/pose-comparison.mjs';
import {POSE_CANDIDATES} from '../src/pose-geometry.mjs';
import {getSlicerStatus,parseSlicerMetrics,parseGcodeSegments} from '../src/slicer.mjs';
import {auditCriticalFeatures} from '../src/critical-feature-audit.mjs';
import {buildArachneSensitivityProfile} from './slicer/profile-sensitivity.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),data=join(root,'data');
const sha=b=>createHash('sha256').update(b).digest('hex');
const run=promisify(execFile);
function inData(p){const rel=relative(data,p);return rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);}
const caseDir=await realpath(resolve(root,process.argv[2]??''));
if(!inData(caseDir))throw Error('COMPLETE_CASE_PATH_INVALID');
const inputPath=await realpath(join(caseDir,'source.stl'));
if(!inData(inputPath))throw Error('COMPLETE_CASE_PATH_INVALID');
const original=await readFile(inputPath),caseData=JSON.parse(await readFile(join(caseDir,'case.json'),'utf8'));
if(caseData.schema!=='complete-lamppost-case/v1'||caseData.source!=='team-original-parametric-design'||caseData.dimensionsMm?.rodDiameter!==.5||!caseData.features?.rodEntityRoiMm||!caseData.repairSpec)throw Error('COMPLETE_CASE_MANIFEST_INVALID');
const features=[{id:'lamp-post',kind:'solid',boundsMm:caseData.features.rodEntityRoiMm,minRetention:.9},{id:'mounting-hole',kind:'void-channel',axis:'z',boundsMm:caseData.features.throughHoleRoiMm,minRetention:.9}];
const declaredSha=caseData.sourceSha256??caseData.source?.sha256;
if(declaredSha!==sha(original))throw Error('COMPLETE_CASE_SOURCE_CHANGED');
const out=join(data,'complete-object-validation',randomUUID());await mkdir(out,{recursive:true});
const uploaded=await inspectModelUpload({name:'original-designed-scale-lamppost.stl',mime:'model/stl',dataBase64:original.toString('base64'),sourceUnits:'mm',targetLongestEdgeMm:30});
const source=await loadVerifiedImportedSource(uploaded.candidateId);
if(source.sourceSha256!==declaredSha)throw Error('COMPLETE_CASE_COORDINATES_CHANGED_BY_IMPORT');
const results=[];
for(const pose of POSE_CANDIDATES){
 const row=await evaluatePrintPose({sourceStlPath:source.sourceStlPath,expectedSourceSha256:source.sourceSha256,poseId:pose.id,outputDir:join(out,pose.id),criticalFeatures:features});
 results.push(row);
 console.log(JSON.stringify({phase:'default-arachne',pose:row.poseId,features:row.featureAudit.features.map(f=>({id:f.id,verified:f.verified,passed:f.passed,retention:f.retentionFraction,connected:f.connected,code:f.code})),cost:row.slice.metrics}));
}
const upright=results.find(r=>r.poseId==='upright');
const status=await getSlicerStatus({profileId:'fdm-pla-04-auto-support'});
const stockBytes=await readFile(status.profilePath),stock=stockBytes.toString('utf8');
const sensitivity=[];
for(const percent of [75,60]){
 const dir=join(out,`sensitivity-${percent}`);await mkdir(dir);
 const profile=buildArachneSensitivityProfile(stock,percent),profilePath=join(dir,'profile.ini'),gcodePath=join(dir,'result.gcode');
 await writeFile(profilePath,profile.text,{flag:'wx'});
 const args=['--datadir',join(data,'tools','prusaslicer-profile-data'),'--load',profilePath,'--export-gcode','--center','90,90','--output',gcodePath,upright.stlPath];
 const started=Date.now();
 await run(status.executable,args,{cwd:root,windowsHide:true,shell:false,timeout:120000,maxBuffer:512000,encoding:'utf8'});
 const bytes=await readFile(gcodePath),gcode=bytes.toString('utf8');
 const settings={};
 for(const key of ['min_bead_width','min_feature_size','perimeter_generator','support_material','layer_height','nozzle_diameter']){
  const value=gcode.match(new RegExp(`^;[ \\t]*${key}[ \\t]*=[ \\t]*([^\\r\\n]*)`,'mu'))?.[1]?.trim();
  const expected=profile.text.match(new RegExp(`^${key}[ \\t]*=[ \\t]*([^\\r\\n]*)`,'mu'))?.[1]?.trim();
  if(!value||value!==expected)throw Error('SENSITIVITY_PROFILE_NOT_VERIFIED');settings[key]=value;
 }
 const paths=parseGcodeSegments(gcode).segments.filter(s=>s.motionType==='extrusion'&&s.role==='MODEL');
 const positions=paths.flatMap(s=>[s.start,s.end]);
 const center=axis=>(Math.min(...positions.map(p=>p[axis]))+Math.max(...positions.map(p=>p[axis])))/2;
 const placementVerified=positions.length>0&&Math.abs(center('x')-90)<=.6&&Math.abs(center('y')-90)<=.6;
 const audit=auditCriticalFeatures(gcode,{probes:upright.featureProbeEvidence.probes,sourceToPrintMatrix4:upright.poseProof.sourceToPrintMatrix4,placementOffsetMm:upright.slice.placementOffsetMm,placementVerified});
 const row={profileName:`arachne-min-bead-${percent}`,changes:profile.changes,settings,sourceSha256:source.sourceSha256,poseSha256:sha(await readFile(upright.stlPath)),profileSha256:sha(await readFile(profilePath)),gcodeSha256:sha(bytes),gcodePath,elapsedSeconds:(Date.now()-started)/1000,metrics:parseSlicerMetrics(gcode),featureAudit:audit,nativeAgent:false,physicalPrintVerified:false,scope:profile.scope};
 sensitivity.push(row);await writeFile(join(dir,'evidence.json'),JSON.stringify(row,null,2));
 console.log(JSON.stringify({phase:row.profileName,features:audit.features.map(f=>({id:f.id,verified:f.verified,passed:f.passed,retention:f.retentionFraction,connected:f.connected,code:f.code})),cost:row.metrics}));
}
if(sha(await readFile(inputPath))!==declaredSha||sha(await readFile(status.profilePath))!==sha(stockBytes))throw Error('COMPLETE_CASE_SOURCE_OR_PROFILE_CHANGED');
const report={schema:'complete-object-comparison/v1',caseDirectory:caseDir,source:{...source,inputSha256:declaredSha,kind:'original-parametric-design'},features,repairSpec:caseData.repairSpec,decision:buildPoseDecision(results),results,sensitivity,nativeAgent:false,physicalPrintVerified:false};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({output:join(out,'report.json'),candidateId:source.candidateId,decision:report.decision,reasonableTuningPassed:sensitivity.some(r=>r.featureAudit.verified&&r.featureAudit.passed)}));
