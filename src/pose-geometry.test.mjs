import test from 'node:test';
test('explicit 90-degree experiment preserves source geometry and does not expand the production pose list',async()=>{
 const {createPoseCandidate,POSE_CANDIDATES,EXPERIMENTAL_POSES}=await import('./pose-geometry.mjs');
 assert.equal(POSE_CANDIDATES.some(p=>p.id==='face-up'),false);
 assert.deepEqual(EXPERIMENTAL_POSES[0].anglesDeg,[-90,0,0]);
 const source=boxStl(),result=createPoseCandidate({sourceBuffer:source,poseId:'face-up'});
 assert.equal(result.proof.rigidTransformVerified,true);
 assert.equal(result.proof.sourceVolumeMm3,60);
 assert.ok(Math.abs(result.proof.printVolumeMm3-60)<1e-4);
 assert.deepEqual(result.proof.printBoundsMm[1].map((v,i)=>v-result.proof.printBoundsMm[0][i]),[4,5,3]);
});
import assert from 'node:assert/strict';
import { createPoseCandidate, transformPoint, POSE_CANDIDATES } from './pose-geometry.mjs';

function boxStl({ reverse = false, nan = false, huge = false, scale = [1,1,1], offset = [0,0,0] } = {}) {
  const p = [[10, 20, 30], [14, 20, 30], [14, 23, 30], [10, 23, 30], [10, 20, 35], [14, 20, 35], [14, 23, 35], [10, 23, 35]];
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]];
  for (const point of p) for (let k=0;k<3;k++) point[k]=huge
    ? (point[k]-[12,21.5,32.5][k])*3e38/[2,1.5,2.5][k]
    : (point[k]-[12,21.5,32.5][k])*scale[k]+[12,21.5,32.5][k]+offset[k];
  const b = Buffer.alloc(84 + faces.length * 50);
  b.writeUInt32LE(faces.length, 80);
  faces.forEach((f, i) => {
    let v = f.map(k => p[k]);
    if (reverse) v = [v[0], v[2], v[1]];
    const o = 84 + i * 50;
    const a = v[0], c = v[1], d = v[2];
    const u = c.map((x,k)=>x-a[k]), w = d.map((x,k)=>x-a[k]);
    const n = [u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]];
    [...n, ...v.flat()].forEach((x,j)=>b.writeFloatLE(nan && i === 0 && j === 3 ? NaN : x, o + j*4));
  });
  return b;
}
const readVerts = b => Array.from({length:b.readUInt32LE(80)*9}, (_,j)=>b.readFloatLE(84 + Math.floor(j/9)*50 + 12 + (j%9)*4));

test('fixed pose list and row-major column-vector transform', () => {
  assert.deepEqual(POSE_CANDIDATES.map(x=>x.id), ['upright','tilt-x-plus','tilt-x-minus','tilt-y-plus']);
  assert(Object.isFrozen(POSE_CANDIDATES));
  assert.deepEqual(transformPoint([1,0,0,2, 0,1,0,3, 0,0,1,4, 0,0,0,1], [5,6,7]), [7,9,11]);
});

test('all four poses preserve the rectangular solid and provide inverse proof', () => {
  for (const pose of POSE_CANDIDATES) {
    const { buffer, proof } = createPoseCandidate({ sourceBuffer: boxStl(), poseId: pose.id });
    assert.equal(buffer.length, 84 + 12 * 50);
    assert.equal(proof.triangleCount, 12);
    assert.equal(proof.rigidTransformVerified, true);
    assert.equal(proof.sourceVolumeMm3, 60);
    assert.ok(Math.abs(proof.printVolumeMm3 - 60) < 1e-4);
    assert.ok(Math.abs(proof.printBoundsMm[0][2]) < 1e-6);
    for (const v of readVerts(buffer)) assert.ok(Number.isFinite(v));
    const inv = proof.printToSourceMatrix4;
    const src = readVerts(boxStl()), out = readVerts(buffer);
    for (let i=0;i<src.length;i+=3) {
      const back=transformPoint(inv,out.slice(i,i+3));
      for(let k=0;k<3;k++) assert.ok(Math.abs(back[k]-src[i+k])<1e-5);
    }
    const edges = (values) => {
      const result=[];
      for(let i=0;i<values.length;i+=9) for(const [a,b] of [[0,1],[1,2],[2,0]])
        result.push(Math.hypot(...[0,1,2].map(k=>values[i+a*3+k]-values[i+b*3+k])));
      return result.sort((a,b)=>a-b).map(x=>+x.toFixed(5));
    };
    assert.deepEqual(edges(readVerts(buffer)), edges(readVerts(boxStl())));
    assert.ok(Math.abs((proof.printBoundsMm[0][0]+proof.printBoundsMm[1][0])/2)<1e-6);
    assert.ok(Math.abs((proof.printBoundsMm[0][1]+proof.printBoundsMm[1][1])/2)<1e-6);
  }
});

test('serialized proof handles ordinary 180 mm geometry and large source offsets', () => {
  for (const sourceBuffer of [boxStl({scale:[45,60,36]}), boxStl({offset:[1000000,-2000000,3000000]})]) {
    const {proof}=createPoseCandidate({sourceBuffer,poseId:'tilt-x-plus'});
    assert.equal(proof.rigidTransformVerified,true);
    assert.ok(Number.isFinite(proof.printVolumeMm3));
    assert.ok(Math.abs(proof.printVolumeMm3-proof.sourceVolumeMm3)<=Math.abs(proof.sourceVolumeMm3)*1e-5+1e-4);
  }
});

test('rejects invalid pose and malformed, oversized, non-finite, empty, negative and degenerate STLs', () => {
  assert.throws(()=>createPoseCandidate({sourceBuffer:boxStl(),poseId:'spin'}), /pose/i);
  assert.throws(()=>createPoseCandidate({sourceBuffer:boxStl({nan:true}),poseId:'upright'}), /finite|有限/i);
  assert.throws(()=>createPoseCandidate({sourceBuffer:Buffer.alloc(30*1024*1024+1),poseId:'upright'}), /size|大小|30/i);
  assert.throws(()=>createPoseCandidate({sourceBuffer:boxStl().subarray(0,100),poseId:'upright'}), /trunc|length|截断|长度/i);
  const empty=Buffer.alloc(84); empty.writeUInt32LE(0,80);
  assert.throws(()=>createPoseCandidate({sourceBuffer:empty,poseId:'upright'}), /triangle|三角|empty|空/i);
  assert.throws(()=>createPoseCandidate({sourceBuffer:boxStl({reverse:true}),poseId:'upright'}), /volume|体积|orientation|方向/i);
  const deg=boxStl(); [0,0,0,0,0,0].forEach((x,j)=>deg.writeFloatLE(x,84+12+j*4));
  assert.throws(()=>createPoseCandidate({sourceBuffer:deg,poseId:'upright'}), /degenerate|volume|退化|体积/i);
  assert.throws(()=>createPoseCandidate({sourceBuffer:boxStl({huge:true}),poseId:'tilt-x-plus'}), /finite|volume|有限|体积/i);
});
