import test from 'node:test';
import assert from 'node:assert/strict';
import {auditRodToolpathContinuity} from './rod-toolpath-continuity.mjs';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const options={centerLineMm:[[0,0,0],[0,0,1]],sourceToPrintMatrix4:identity,placementOffsetMm:{x:0,y:0,z:0},placementVerified:true};
function layers(values,role='Perimeter'){
 return 'G21\nG90\nM83\n'+values.map(z=>`;TYPE:${role}\n;WIDTH:0.4\n;HEIGHT:0.2\nG0 X-0.2 Y0 Z${z}\nG1 X0.2 Y0 E1\n`).join('');
}
test('requires continuous planned MODEL coverage rather than sparse surface samples',()=>{
 const complete=auditRodToolpathContinuity(layers([.2,.4,.6,.8,1]),options);
 assert.equal(complete.verified,true);assert.equal(complete.passed,true);assert.equal(complete.coverageFraction,1);assert.deepEqual(complete.gaps,[]);
 const missing=auditRodToolpathContinuity(layers([.2,.4,.8,1]),options);
 assert.equal(missing.verified,true);assert.equal(missing.passed,false);
 assert.ok(Math.abs(missing.coveredLengthMm-.8)<1e-6);
 assert.ok(Math.abs(missing.gaps[0].lengthMm-.2)<1e-6);
});
test('support cannot fill a gap in permanent MODEL extrusion',()=>{
 const gcode=layers([.2,.4,.8,1])+layers([.6],'Support material');
 assert.equal(auditRodToolpathContinuity(gcode,options).passed,false);
});
test('applies the actual source pose and bed placement to a horizontal centerline',()=>{
 const rotationY90=[0,0,1,0,0,1,0,0,-1,0,0,0,0,0,0,1];
 const gcode='G21\nG90\nM83\n;TYPE:Perimeter\n;WIDTH:0.4\n;HEIGHT:0.2\nG0 X90 Y90 Z0.2\nG1 X92 Y90 E1\n';
 const result=auditRodToolpathContinuity(gcode,{...options,centerLineMm:[[-.1,0,0],[-.1,0,2]],sourceToPrintMatrix4:rotationY90,placementOffsetMm:{x:90,y:90,z:0}});
 assert.equal(result.passed,true);assert.equal(result.coveredLengthMm,2);
});
test('accounts for the round extrusion end caps without extending outside them',()=>{
 const gcode='G21\nG90\nM83\n;TYPE:Perimeter\n;WIDTH:0.4\n;HEIGHT:0.2\nG0 X-1 Y0 Z0.2\nG1 X1 Y0 E1\n';
 assert.equal(auditRodToolpathContinuity(gcode,{...options,centerLineMm:[[-1.19,0,.1],[1.19,0,.1]]}).passed,true);
 assert.equal(auditRodToolpathContinuity(gcode,{...options,centerLineMm:[[-1.21,0,.1],[1.21,0,.1]]}).passed,false);
});
test('unknown width, height, roles, arcs and non-planar extrusion stay unverified',()=>{
 const valid=layers([.2,.4,.6,.8,1]);
 for(const gcode of [valid.replaceAll(';WIDTH:0.4\n',''),valid.replaceAll(';HEIGHT:0.2\n',''),layers([.2],'unrecognized'),valid+'G2 X1 Y1 E1\n',valid+'G1 X1 Z1.2 E1\n',valid+'G1 X1e309 E1\n']){
  const result=auditRodToolpathContinuity(gcode,options);assert.equal(result.verified,false);assert.equal(result.passed,false);
 }
});
test('refuses unverified placement and non-rigid matrices',()=>{
 assert.equal(auditRodToolpathContinuity(layers([.2]),{...options,placementVerified:false}).verified,false);
 const scaled=[...identity];scaled[0]=2;
 assert.equal(auditRodToolpathContinuity(layers([.2]),{...options,sourceToPrintMatrix4:scaled}).verified,false);
});
test('finite inputs that overflow during transformation cannot make an empty toolpath pass',()=>{
 const moved=[...identity];moved[3]=1e308;
 const result=auditRodToolpathContinuity('',{...options,sourceToPrintMatrix4:moved,placementOffsetMm:{x:1e308,y:0,z:0}});
 assert.equal(result.verified,false);assert.equal(result.passed,false);
});
