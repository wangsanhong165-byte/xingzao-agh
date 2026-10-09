import {auditRodToolpathContinuity} from './rod-toolpath-continuity.mjs';
export function normalizeContinuousRods(rods=[],features=[],bounds){
  if(!Array.isArray(rods)||rods.length>4)throw new Error('ROD_DECLARATIONS_INVALID');
  const ids=new Set();return rods.map(r=>{
    const feature=features.find(f=>f.id===r?.id&&f.kind==='solid'),line=r?.centerLineMm;
    if(!feature||ids.has(r.id)||!Array.isArray(line)||line.length!==2||line.some(p=>!Array.isArray(p)||p.length!==3||p.some(v=>typeof v!=='number'||!Number.isFinite(v))))throw new Error('ROD_DECLARATIONS_INVALID');
    ids.add(r.id);const deltas=line[0].map((v,i)=>line[1][i]-v),axes=deltas.map((d,i)=>Math.abs(d)>1e-8?i:-1).filter(i=>i>=0);
    if(axes.length!==1||deltas[axes[0]]<=0)throw new Error('ROD_DECLARATIONS_INVALID');
    for(const p of line)for(let i=0;i<3;i++)if((i!==axes[0]&&(p[i]<feature.boundsMm[0][i]-1e-5||p[i]>feature.boundsMm[1][i]+1e-5))||(bounds&&(p[i]<bounds[0][i]-1e-5||p[i]>bounds[1][i]+1e-5)))throw new Error('ROD_DECLARATIONS_OUTSIDE_FEATURE');
    if(line[0][axes[0]]>feature.boundsMm[0][axes[0]]+1e-5||line[1][axes[0]]<feature.boundsMm[1][axes[0]]-1e-5)throw new Error('ROD_DECLARATIONS_OUTSIDE_FEATURE');
    return {id:r.id,centerLineMm:line.map(p=>[...p])};
  });
}
export function auditContinuousRods(text,rods,options){return rods.map(r=>({id:r.id,audit:auditRodToolpathContinuity(text,{...options,centerLineMm:r.centerLineMm})}));}
