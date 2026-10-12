import path from 'node:path';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const candidates=process.argv[2]?[path.resolve(process.argv[2])]:[path.resolve(root,'../测试样例'),root];
const bundle=candidates.find(p=>existsSync(path.join(p,'bundle-manifest.json')));
if(!bundle){console.error('未找到测试样例，请完整解压提交包，或指定样例目录。');process.exit(1)}
console.log('复核已有模型、真实刀轨和文件身份，不调用模型，不需要 Key 或 GPU。');
const check=spawnSync(process.execPath,[path.join(root,'tools/review/check.mjs'),'--bundle',bundle],{cwd:root,stdio:'inherit',shell:false,windowsHide:true});
if(check.error||check.status!==0){console.error('样例复核失败。');process.exit(check.status??1)}
const photo=path.join(bundle,'摄影外观保护/复核支撑.mjs');
if(existsSync(photo)){
 const result=spawnSync(process.execPath,[photo],{cwd:root,stdio:'inherit',shell:false,windowsHide:true});
 if(result.error||result.status!==0){console.error('摄影保护样例复核失败。');process.exit(result.status??1)}
}
console.log('已有结果复核通过。');
