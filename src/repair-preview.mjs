import {parseGcodeSegments} from './slicer.mjs';
import {transformPoint} from './pose-geometry.mjs';
const clip=(a,b,box)=>{let lo=0,hi=1;for(let i=0;i<3;i++){const d=b[i]-a[i];if(Math.abs(d)<1e-12){if(a[i]<box[0][i]||a[i]>box[1][i])return null;continue;}let x=(box[0][i]-a[i])/d,y=(box[1][i]-a[i])/d;if(x>y)[x,y]=[y,x];lo=Math.max(lo,x);hi=Math.min(hi,y);if(lo>hi)return null;}return [a.map((v,i)=>v+(b[i]-v)*lo),a.map((v,i)=>v+(b[i]-v)*hi)];};

export function featureToolpathSvg(text,{axis,boundsMm,printToSourceMatrix4,placementOffsetMm}){
 if(!['x','y','z'].includes(axis)||!Array.isArray(boundsMm)||boundsMm.length!==2||boundsMm.some(p=>!Array.isArray(p)||p.length!==3||p.some(v=>!Number.isFinite(v)))||[0,1,2].some(i=>boundsMm[0][i]>=boundsMm[1][i]))throw new Error('REPAIR_PREVIEW_BOUNDS_INVALID');
 const parsed=parseGcodeSegments(text);if(parsed.unsupportedArcMoves)throw new Error('REPAIR_PREVIEW_UNSUPPORTED');
 const u=[0,1,2].filter(i=>i!=='xyz'.indexOf(axis)),span=Math.max(...u.map(i=>boundsMm[1][i]-boundsMm[0][i])),scale=200/span;
 const projected=[],point=p=>transformPoint(printToSourceMatrix4,[p.x-placementOffsetMm.x,p.y-placementOffsetMm.y,p.z-placementOffsetMm.z]);
 for(const s of parsed.segments){
  if(s.motionType==='extrusion'&&s.role==='UNKNOWN')throw new Error('REPAIR_PREVIEW_UNSUPPORTED');
  if(s.motionType!=='extrusion'||s.role!=='MODEL')continue;
  const c=clip(point(s.start),point(s.end),boundsMm);if(!c)continue;if(!Number.isFinite(s.lineWidthMm)||!Number.isFinite(s.lineHeightMm))throw new Error('REPAIR_PREVIEW_UNSUPPORTED');
  if(projected.length>=2000)throw new Error('REPAIR_PREVIEW_TOO_COMPLEX');
  projected.push(c.map(p=>[30+(p[u[0]]-boundsMm[0][u[0]])*scale,230-(p[u[1]]-boundsMm[0][u[1]])*scale]));
 }
 const lines=projected.map(([a,b])=>`<line x1="${a[0].toFixed(3)}" y1="${a[1].toFixed(3)}" x2="${b[0].toFixed(3)}" y2="${b[1].toFixed(3)}"/>`).join('');
 const caption=projected.length?`${projected.length} 段 MODEL 挤出中心线`:'未找到该区域 MODEL 挤出路径';
 return {segmentCount:projected.length,svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 290" data-segment-count="${projected.length}"><rect width="260" height="290" fill="#f7faf8"/><rect x="30" y="30" width="200" height="200" fill="white" stroke="#d7e3dd"/><g stroke="#258a72" stroke-width="2" stroke-linecap="round">${lines}</g><text x="130" y="255" text-anchor="middle" font-size="11" fill="#415c52">${caption}</text><text x="130" y="275" text-anchor="middle" font-size="9" fill="#6b7e75">中心线投影 · 线宽仅作示意</text></svg>`};
}
