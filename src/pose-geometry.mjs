import { createHash } from 'node:crypto';

export const POSE_CANDIDATES = Object.freeze([
  Object.freeze({ id: 'upright', anglesDeg: Object.freeze([0, 0, 0]) }),
  Object.freeze({ id: 'tilt-x-plus', anglesDeg: Object.freeze([30, 0, 0]) }),
  Object.freeze({ id: 'tilt-x-minus', anglesDeg: Object.freeze([-30, 0, 0]) }),
  Object.freeze({ id: 'tilt-y-plus', anglesDeg: Object.freeze([0, 30, 0]) }),
]);

// Kept for historical independent experiments; new fixed-five-v2 tasks now
// include this same rigid pose, without changing legacy four-pose records.
export const EXPERIMENTAL_POSES = Object.freeze([
  Object.freeze({id:'face-up',anglesDeg:Object.freeze([-90,0,0])}),
]);
export const EXTENDED_POSE_CANDIDATES=Object.freeze([...POSE_CANDIDATES,...EXPERIMENTAL_POSES]);
export function poseCandidatesForPolicy(id='fixed-four-v1'){
  if(id==='fixed-four-v1')return POSE_CANDIDATES;
  if(id==='fixed-five-v2')return EXTENDED_POSE_CANDIDATES;
  throw new Error('POSE_POLICY_INVALID');
}
export const posePolicyFingerprint=id=>createHash('sha256').update(JSON.stringify({id,poses:poseCandidatesForPolicy(id)})).digest('hex');
export function posesForJob(job){
  const id=job.posePolicy??'fixed-four-v1',poses=poseCandidatesForPolicy(id);
  if((id!=='fixed-four-v1'&&!job.posePolicyFingerprint)||(job.posePolicyFingerprint&&job.posePolicyFingerprint!==posePolicyFingerprint(id)))throw new Error('POSE_POLICY_CHANGED');
  return poses;
}

export function transformPoint(matrix4, point3) {
  if (!matrix4 || matrix4.length !== 16 || !point3 || point3.length !== 3 ||
      [...matrix4, ...point3].some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new TypeError('matrix4 and point3 must contain finite numbers');
  }
  const [x, y, z] = point3;
  const w = matrix4[12] * x + matrix4[13] * y + matrix4[14] * z + matrix4[15];
  if (Math.abs(w) < 1e-15) throw new RangeError('point maps to zero homogeneous coordinate');
  return [
    (matrix4[0] * x + matrix4[1] * y + matrix4[2] * z + matrix4[3]) / w,
    (matrix4[4] * x + matrix4[5] * y + matrix4[6] * z + matrix4[7]) / w,
    (matrix4[8] * x + matrix4[9] * y + matrix4[10] * z + matrix4[11]) / w,
  ];
}

const identity = () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
function multiply(a, b) {
  const out = Array(16).fill(0);
  for (let r=0;r<4;r++) for(let c=0;c<4;c++) for(let k=0;k<4;k++) out[r*4+c]+=a[r*4+k]*b[k*4+c];
  return out;
}
function translation(x,y,z) { const m=identity(); m[3]=x; m[7]=y; m[11]=z; return m; }
function rotation(anglesDeg) {
  const [x,y,z]=anglesDeg.map(v=>v*Math.PI/180), cx=Math.cos(x),sx=Math.sin(x),cy=Math.cos(y),sy=Math.sin(y),cz=Math.cos(z),sz=Math.sin(z);
  const rx=[1,0,0,0, 0,cx,-sx,0, 0,sx,cx,0, 0,0,0,1];
  const ry=[cy,0,sy,0, 0,1,0,0, -sy,0,cy,0, 0,0,0,1];
  const rz=[cz,-sz,0,0, sz,cz,0,0, 0,0,1,0, 0,0,0,1];
  return multiply(multiply(rz,ry),rx);
}
function inverseRigid(m) {
  const out=identity();
  for(let r=0;r<3;r++) for(let c=0;c<3;c++) out[r*4+c]=m[c*4+r];
  for(let r=0;r<3;r++) out[r*4+3]=-(out[r*4]*m[3]+out[r*4+1]*m[7]+out[r*4+2]*m[11]);
  return out;
}
function boundsOf(vertices) {
  const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<vertices.length;i+=3) for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],vertices[i+k]);hi[k]=Math.max(hi[k],vertices[i+k]);}
  return [lo,hi];
}
function signedVolume(vertices) {
  let sum=0;
  for(let i=0;i<vertices.length;i+=9){const [ax,ay,az,bx,by,bz,cx,cy,cz]=vertices.slice(i,i+9);sum+=ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx);}
  return sum/6;
}
function sha(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

export function createPoseCandidate({ sourceBuffer, poseId } = {}) {
  const pose=POSE_CANDIDATES.find(p=>p.id===poseId)??EXPERIMENTAL_POSES.find(p=>p.id===poseId);
  if(!pose) throw new TypeError(`Unknown poseId: ${poseId}`);
  if(!Buffer.isBuffer(sourceBuffer) && !(sourceBuffer instanceof Uint8Array)) throw new TypeError('sourceBuffer must be binary bytes');
  const src=Buffer.from(sourceBuffer.buffer, sourceBuffer.byteOffset, sourceBuffer.byteLength);
  if(src.byteLength>30*1024*1024) throw new RangeError('STL exceeds 30 MiB size limit');
  if(src.byteLength<84) throw new RangeError('Binary STL is truncated');
  const triangleCount=src.readUInt32LE(80);
  if(triangleCount===0) throw new RangeError('STL must contain at least one triangle');
  if(triangleCount>600000) throw new RangeError('STL exceeds 600000 triangles');
  if(src.byteLength!==84+triangleCount*50) throw new RangeError('Binary STL length does not match triangle count (truncated or trailing data)');
  const vertices=[];
  for(let i=0;i<triangleCount;i++){
    const o=84+i*50;
    for(let j=0;j<9;j++){
      const value=src.readFloatLE(o+12+j*4);
      if(!Number.isFinite(value)) throw new TypeError('STL vertices must be finite');
      vertices.push(value);
    }
  }
  const sourceBoundsMm=boundsOf(vertices), sourceVolumeMm3=signedVolume(vertices);
  if(!(sourceVolumeMm3>0) || !Number.isFinite(sourceVolumeMm3)) throw new RangeError('STL must have positive signed volume and consistent outward orientation');
  const center=sourceBoundsMm[0].map((v,k)=>(v+sourceBoundsMm[1][k])/2);
  const rot=rotation(pose.anglesDeg);
  const centeredRotation=multiply(rot,translation(-center[0],-center[1],-center[2]));
  const rotated=vertices.map((_,i)=>0);
  for(let i=0;i<vertices.length;i+=3) rotated.splice(i,3,...transformPoint(centeredRotation,vertices.slice(i,i+3)));
  const rb=boundsOf(rotated), shift=[-(rb[0][0]+rb[1][0])/2,-(rb[0][1]+rb[1][1])/2,-rb[0][2]];
  const sourceToPrintMatrix4=multiply(translation(...shift),centeredRotation);
  const printToSourceMatrix4=inverseRigid(sourceToPrintMatrix4);
  const output=Buffer.alloc(84+triangleCount*50);
  output.write('Pose geometry rigid transform',0,'ascii'); output.writeUInt32LE(triangleCount,80);
  const transformed=[];
  for(let i=0;i<triangleCount;i++){
    const o=84+i*50, base=i*9;
    const tri=[];
    for(let v=0;v<3;v++) tri.push(transformPoint(sourceToPrintMatrix4,vertices.slice(base+v*3,base+v*3+3)));
    tri.flat().forEach((n,j)=>{
      if(!Number.isFinite(n)) throw new RangeError('Transformed STL vertex is not finite');
      output.writeFloatLE(n,o+12+j*4);
      const serialized=output.readFloatLE(o+12+j*4);
      if(!Number.isFinite(serialized)) throw new RangeError('Serialized Float32 STL vertex is not finite');
      transformed.push(serialized);
    });
    const qa=transformed.slice(-9,-6), qb=transformed.slice(-6,-3), qc=transformed.slice(-3);
    const u=qb.map((n,k)=>n-qa[k]), w=qc.map((n,k)=>n-qa[k]);
    const normal=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]];
    const length=Math.hypot(...normal);
    if(!(length>0) || !Number.isFinite(length)) throw new RangeError('Serialized STL contains a degenerate triangle');
    normal.forEach((n,k)=>output.writeFloatLE(n/length,o+k*4));
    output.writeUInt16LE(0,o+48);
  }
  const printBoundsMm=boundsOf(transformed), printVolumeMm3=signedVolume(transformed);
  if(!(printVolumeMm3>0) || Math.abs(printVolumeMm3-sourceVolumeMm3)>Math.abs(sourceVolumeMm3)*1e-5+1e-4) throw new RangeError('Rigid transform volume conservation failed');
  const product=multiply(sourceToPrintMatrix4,printToSourceMatrix4);
  if(product.some((v,i)=>Math.abs(v-identity()[i])>1e-9)) throw new RangeError('Rigid transform inverse verification failed');
  const rotationRows=[0,1,2].map(r=>[sourceToPrintMatrix4[r*4],sourceToPrintMatrix4[r*4+1],sourceToPrintMatrix4[r*4+2]]);
  for(let r=0;r<3;r++) for(let c=0;c<3;c++){
    const dot=rotationRows[r].reduce((s,v,k)=>s+v*rotationRows[c][k],0);
    if(Math.abs(dot-(r===c?1:0))>1e-10) throw new RangeError('Rigid transform rotation orthogonality verification failed');
  }
  if(Math.abs(printBoundsMm[0][2])>1e-5 || Math.abs(printBoundsMm[0][0]+printBoundsMm[1][0])>1e-5 || Math.abs(printBoundsMm[0][1]+printBoundsMm[1][1])>1e-5) throw new RangeError('Print bounds placement verification failed');
  return { buffer:output, proof:{poseId,anglesDeg:[...pose.anglesDeg],sourceSha256:sha(src),candidateSha256:sha(output),sourceToPrintMatrix4,printToSourceMatrix4,sourceBoundsMm,printBoundsMm,triangleCount,sourceVolumeMm3,printVolumeMm3,rigidTransformVerified:true} };
}
