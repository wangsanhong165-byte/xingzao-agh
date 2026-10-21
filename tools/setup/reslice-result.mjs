import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {auditRodToolpathContinuity} from '../../src/rod-toolpath-continuity.mjs';
import {parseSlicerMetrics} from '../../src/slicer.mjs';
const dir=path.resolve(process.argv[2]);
const raw=JSON.parse(await readFile(path.join(dir,'inputs.json'),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const labels={'original-upright':'原件直立 · 0.5 mm','repaired-upright':'局部加粗 · 0.8 mm','original-side':'原件侧放 · 0.5 mm'};
const rows=[];
for(const p of raw.plans){
 const stl=await readFile(path.join(dir,p.stl)),gcode=await readFile(path.join(dir,p.gcode));
 if(sha(stl)!==p.stlSha256||sha(gcode)!==p.gcodeSha256||p.watertight!==true)throw Error('重新计算文件校验失败');
 const audit=auditRodToolpathContinuity(gcode.toString('utf8'),{centerLineMm:[[-3,0,2],[-3,0,28]],sourceToPrintMatrix4:p.sourceToPrintMatrix4,placementOffsetMm:p.placementOffsetMm,placementVerified:true});
 if(!audit.verified)throw Error('刀轨无法完成检查：'+audit.code);
 rows.push({...p,audit,metrics:parseSlicerMetrics(gcode.toString('utf8'))});
}
await writeFile(path.join(dir,'results.json'),JSON.stringify({createdAt:raw.createdAt,plans:rows},null,2)+'\n');
const table=rows.map(r=>`<tr><td>${labels[r.id]}</td><td>${r.audit.passed?'细杆连续':'细杆存在断段'}</td><td>${(r.audit.coverageFraction*100).toFixed(2)}%</td><td>${r.metrics.filamentG.toFixed(2)} g / ${Math.round(r.metrics.estimatedTimeSeconds/60)} 分钟</td><td><a href="${r.stl}">STL</a> · <a href="${r.gcode}">G-code</a></td></tr>`).join('');
await writeFile(path.join(dir,'结果.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>形造｜本次重新生成与切片</title><style>body{font:16px/1.8 system-ui,"Microsoft YaHei";max-width:1040px;margin:40px auto;padding:0 24px;color:#203840}table{border-collapse:collapse;width:100%}td,th{border:1px solid #dce5e8;padding:12px;text-align:left}a{color:#146659}p{max-width:900px}</style><h1>本次重新生成与切片</h1><p>由参数化脚本重新生成灯柱、调用随包PrusaSlicer，并读取新G-code检查26 mm杆轴的连续覆盖。下面是本次计算结果，文件位于本页面同一目录。</p><table><tr><th>方案</th><th>刀轨结果</th><th>杆轴覆盖</th><th>切片估算</th><th>新文件</th></tr>${table}</table><p>标准几何和切片计算不需要模型账号或GPU。完整AGH规划任务可从工作台导入新STL执行；实物打印需另行测试。</p><p><a href="results.json">详细计算结果</a> · <a href="../../../README.html">返回作品入口</a></p></html>`);
console.log('已重新生成3个方案并完成真实切片。结果：'+path.join(dir,'结果.html'));
if(!rows.some(r=>r.audit.passed))throw Error('本次没有任何方案通过细杆连续性检查，请查看结果报告');
