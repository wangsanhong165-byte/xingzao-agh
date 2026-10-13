import path from 'node:path';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {checkReviewBundle} from './check.mjs';
import {parseSlicerMetrics} from '../../src/slicer.mjs';
import {buildReviewerResult,consoleSummary,renderReviewerReport} from './report.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2),open=args.includes('--open'),details=args.includes('--details');
const positionals=args.filter(x=>!['--open','--details'].includes(x));
if(positionals.length>1||positionals.some(x=>x.startsWith('--'))){console.error('用法：node tools/review/run.mjs [样例目录] [--open] [--details]');process.exit(1)}
const candidates=positionals[0]?[path.resolve(positionals[0])]:[path.resolve(root,'../案例/测试样例'),path.resolve(root,'../测试样例'),root];
const bundle=candidates.find(p=>existsSync(path.join(p,'bundle-manifest.json')));
if(!bundle){console.error('未找到测试样例，请完整解压提交包，或指定样例目录。');process.exit(1)}
const reportPath=path.join(bundle===root?root:path.dirname(bundle),'复核报告.html');
let result;
try{
 const review=await checkReviewBundle(bundle),dataset=JSON.parse(await readFile(path.join(bundle,'case/cases.json'),'utf8'));
 const photoPath=[path.join(bundle,'摄影外观保护/复核支撑.mjs'),path.join(bundle,'examples/photo-protection/复核支撑.mjs')].find(p=>existsSync(p));let photo=null;
 if(photoPath){
  const verified=spawnSync(process.execPath,[photoPath],{cwd:root,encoding:'utf8',shell:false,windowsHide:true,maxBuffer:1024*1024});
  if(verified.error||verified.status!==0)throw Error('摄影保护样例未通过：'+String(verified.stderr??verified.error?.message??'').trim());
  const values=new Map([...verified.stdout.matchAll(/^(upright|face-up): ([0-9.]+) mm verified$/gmu)].map(m=>[m[1],Number(m[2])]));
  if(!Number.isFinite(values.get('upright'))||!Number.isFinite(values.get('face-up'))||values.get('upright')<=0||values.get('face-up')<0)throw Error('摄影支撑复核结果不完整');
  const base=path.dirname(photoPath),before=parseSlicerMetrics(await readFile(path.join(base,'upright.gcode'),'utf8')),after=parseSlicerMetrics(await readFile(path.join(base,'face-up.gcode'),'utf8'));
  photo={baselineMm:values.get('upright'),bestMm:values.get('face-up'),reductionPercent:(1-values.get('face-up')/values.get('upright'))*100,baselineG:before.filamentG,bestG:after.filamentG,baselineTime:before.estimatedTimeSeconds,bestTime:after.estimatedTimeSeconds};
 }
 result=buildReviewerResult(review,dataset.cases,photo);
}catch(error){result={ok:false,error:error.message??'复核无法完成',checkedAt:new Date().toISOString()};process.exitCode=1}
await writeFile(reportPath,renderReviewerReport(result,{flatBundle:bundle===root}),'utf8');
console.log(consoleSummary(result));console.log('报告位置：'+reportPath);
if(details)console.log(JSON.stringify(result.details??result,null,2));
if(open&&process.platform==='win32'){
 const child=spawn(path.join(process.env.SystemRoot??'C:\\Windows','explorer.exe'),[reportPath],{detached:true,stdio:'ignore',windowsHide:true,shell:false});
 child.on('error',()=>console.log('请手动打开复核报告.html。'));child.unref();
}
