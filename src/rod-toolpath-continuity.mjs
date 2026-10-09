import {parseGcodeSegments} from './slicer.mjs';
import {transformPoint} from './pose-geometry.mjs';
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const numericToleranceMm=2e-6;
function rigid(m){
 if(!Array.isArray(m)||m.length!==16||!m.every(finite)||m.slice(12).some((v,i)=>Math.abs(v-(i===3?1:0))>1e-8))return false;
 const c=[[m[0],m[4],m[8]],[m[1],m[5],m[9]],[m[2],m[6],m[10]]];
 for(let i=0;i<3;i++)for(let j=0;j<3;j++)if(Math.abs(c[i].reduce((s,v,k)=>s+v*c[j][k],0)-(i===j?1:0))>1e-6)return false;
 const [a,b,d]=c,det=a[0]*(b[1]*d[2]-b[2]*d[1])-b[0]*(a[1]*d[2]-a[2]*d[1])+d[0]*(a[1]*b[2]-a[2]*b[1]);
 return Math.abs(det-1)<1e-6;
}
function intersect(a,b){if(!a||!b)return null;const lo=Math.max(a[0],b[0],0),hi=Math.min(a[1],b[1],1);return hi>=lo?[lo,hi]:null;}
function band(value,delta,lo,hi){
 if(Math.abs(delta)<1e-14)return value>=lo&&value<=hi?[0,1]:null;
 const bounds=[(lo-value)/delta,(hi-value)/delta].sort((a,b)=>a-b);return intersect(bounds,[0,1]);
}
function circle(a,d,p,r){
 const x=a[0]-p.x,y=a[1]-p.y,A=d[0]**2+d[1]**2,B=2*(x*d[0]+y*d[1]),C=x*x+y*y-r*r;
 if(A<1e-20)return C<=0?[0,1]:null;
 const discriminant=B*B-4*A*C;if(discriminant<0)return null;
 const q=Math.sqrt(discriminant);return intersect([(-B-q)/(2*A),(-B+q)/(2*A)],[0,1]);
}
function capsuleIntervals(a,d,s,r){
 const vx=s.end.x-s.start.x,vy=s.end.y-s.start.y,L2=vx*vx+vy*vy;
 const caps=[circle(a,d,s.start,r),circle(a,d,s.end,r)];
 if(L2<1e-20)return caps.filter(Boolean);
 const x=a[0]-s.start.x,y=a[1]-s.start.y;
 const along=band((x*vx+y*vy)/L2,(d[0]*vx+d[1]*vy)/L2,0,1);
 const across=band(x*vy-y*vx,d[0]*vy-d[1]*vx,-r*Math.sqrt(L2),r*Math.sqrt(L2));
 return [...caps,intersect(along,across)].filter(Boolean);
}

/** Continuous coverage of a confirmed rod's line by planned MODEL extrusion slabs/capsules. */
export function auditRodToolpathContinuity(text,{centerLineMm,sourceToPrintMatrix4,placementOffsetMm,placementVerified}={}){
 const base={verified:false,passed:false,scope:'continuous-centreline-vs-planned-model-extrusion',numericToleranceMm,physicalPrintVerified:false};
 const fail=code=>({...base,code});
 if(typeof text!=='string'||Buffer.byteLength(text)>32*1024*1024)return fail('ROD_CONTINUITY_RESOURCE_LIMIT');
 if(!rigid(sourceToPrintMatrix4)||placementVerified!==true||!placementOffsetMm||!['x','y','z'].every(k=>finite(placementOffsetMm[k])))return fail('ROD_CONTINUITY_PLACEMENT_UNVERIFIED');
 if(!Array.isArray(centerLineMm)||centerLineMm.length!==2||centerLineMm.some(p=>!Array.isArray(p)||p.length!==3||!p.every(finite)))return fail('ROD_CONTINUITY_LINE_INVALID');
 const points=centerLineMm.map(p=>transformPoint(sourceToPrintMatrix4,p).map((v,i)=>v+placementOffsetMm['xyz'[i]]));
 if(!points.every(p=>p.every(finite)))return fail('ROD_CONTINUITY_LINE_INVALID');
 const a=points[0],d=points[1].map((v,i)=>v-a[i]),lineLengthMm=Math.hypot(...d);
 if(!finite(lineLengthMm)||lineLengthMm<.1||lineLengthMm>100.000001)return fail('ROD_CONTINUITY_LINE_INVALID');
 const parsed=parseGcodeSegments(text);if(parsed.unsupportedArcMoves)return fail('ROD_CONTINUITY_UNSUPPORTED_ARCS');
 if(parsed.segments.length>1_000_000)return fail('ROD_CONTINUITY_RESOURCE_LIMIT');
 const intervals=[];
 for(const segment of parsed.segments){
  if(segment.motionType!=='extrusion')continue;
  if(segment.role==='UNKNOWN')return fail('ROD_CONTINUITY_ROLE_UNVERIFIED');
  if(segment.role!=='MODEL')continue;
  if(![segment.start,segment.end].every(p=>['x','y','z'].every(k=>finite(p[k]))))return fail('ROD_CONTINUITY_COORDINATES_UNVERIFIED');
  const width=segment.lineWidthMm,height=segment.lineHeightMm;
  if(!finite(width)||width<=0||!finite(height)||height<=0)return fail('ROD_CONTINUITY_WIDTH_HEIGHT_UNVERIFIED');
  if(Math.abs(segment.end.z-segment.start.z)>1e-7)return fail('ROD_CONTINUITY_NON_PLANAR');
  const z=band(a[2],d[2],segment.end.z-height,segment.end.z);if(!z)continue;
  for(const xy of capsuleIntervals(a,d,segment,width/2)){const t=intersect(xy,z);if(t)intervals.push(t);}
  if(intervals.length>100000)return fail('ROD_CONTINUITY_RESOURCE_LIMIT');
 }
 intervals.sort((x,y)=>x[0]-y[0]||x[1]-y[1]);
 const merged=[];
 for(const pair of intervals){const previous=merged.at(-1);if(previous&&(pair[0]-previous[1])*lineLengthMm<=numericToleranceMm)previous[1]=Math.max(previous[1],pair[1]);else merged.push([...pair]);}
 const gaps=[];let cursor=0;
 for(const [lo,hi] of merged){if((lo-cursor)*lineLengthMm>numericToleranceMm)gaps.push({fromT:cursor,toT:lo,lengthMm:(lo-cursor)*lineLengthMm});cursor=Math.max(cursor,hi);}
 if((1-cursor)*lineLengthMm>numericToleranceMm)gaps.push({fromT:cursor,toT:1,lengthMm:(1-cursor)*lineLengthMm});
 const coveredLengthMm=merged.reduce((s,[lo,hi])=>s+(hi-lo)*lineLengthMm,0),passed=gaps.length===0;
 return {...base,verified:true,passed,code:passed?'PASS':'ROD_TOOLPATH_DISCONNECTED',lineLengthMm,coveredLengthMm,coverageFraction:Math.min(1,coveredLengthMm/lineLengthMm),maxGapMm:Math.max(0,...gaps.map(g=>g.lengthMm)),gaps};
}
