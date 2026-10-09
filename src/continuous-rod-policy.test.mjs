import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPoseDecision,POSE_PROFILE_ID} from './pose-comparison.mjs';
const feature={id:'rod',kind:'solid',boundsMm:[[-.3,-.3,0],[.3,.3,3]],minRetention:.9,surfaceToleranceMm:.05};
const rod={id:'rod',centerLineMm:[[0,0,0],[0,0,3]]};
const result={poseId:'upright',sourceSha256:'a'.repeat(64),status:'verified',poseProof:{rigidTransformVerified:true},slice:{metrics:{filamentG:1,estimatedTimeSeconds:100},proof:{profileId:POSE_PROFILE_ID,profileSha256:'b'.repeat(64)}},supportAudit:{verified:true},criticalFeatures:[feature],featureAudit:{verified:true,passed:true},continuousRods:[rod],rodContinuityAudits:[{id:'rod',audit:{verified:true,passed:false}}]};
test('passing sampled surface cannot hide a missing centreline segment',()=>{const d=buildPoseDecision([result]);assert.equal(d.recommendedPoseId,null);assert.equal(d.rejected[0].reason,'ROD_CONTINUITY_NOT_RETAINED');});
test('declared rod without verified path evidence is not selectable',()=>{const d=buildPoseDecision([{...result,rodContinuityAudits:[]}]);assert.equal(d.recommendedPoseId,null);assert.equal(d.rejected[0].reason,'ROD_CONTINUITY_UNVERIFIED');});
test('same rod and independently verified continuous paths remain selectable',()=>{const d=buildPoseDecision([{...result,rodContinuityAudits:[{id:'rod',audit:{verified:true,passed:true}}]}]);assert.equal(d.recommendedPoseId,'upright');});
