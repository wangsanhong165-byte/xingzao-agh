import path from 'node:path';
import {readFile,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const roots=['评审案例/','测试样例/','AGH运行记录/','演示视频/'];
const pages=new Set(['开始.html','案例与复现.html','复核报告.html','README.md','作品说明.md','作品说明.html','完整源码/运行与模型配置.html']);
const allowed=s=>pages.has(s)||roots.some(p=>s.startsWith(p));
const types={'.html':'text/html; charset=utf-8','.md':'text/plain; charset=utf-8','.ini':'text/plain; charset=utf-8','.json':'application/json; charset=utf-8','.jsonl':'text/plain; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.stl':'model/stl','.gcode':'text/plain; charset=utf-8','.mp4':'video/mp4'};
const esc=s=>s.replace(/[&<>]/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
export function createSubmissionRouter({root=process.env.XINGZAO_REVIEW_ROOT||path.resolve(project,'..')}={}){
 root=path.resolve(root);
 async function read(name){
  if(!allowed(name)||name.includes('\\')||name.split('/').some(p=>p==='..'||p==='.')||!types[path.extname(name)])return null;
  const f=path.resolve(root,name);if(!f.startsWith(root+path.sep))return null;
  try{let current=root;for(const part of name.split('/')){current=path.join(current,part);if((await lstat(current)).isSymbolicLink())return null;}const st=await lstat(f);return st.isFile()?await readFile(f):null;}catch(e){if(e.code==='ENOENT')return null;throw e;}
 }
 return {async handle(req,res){
  const u=new URL(req.url,'http://127.0.0.1');if(req.method!=='GET')return false;
  if(u.pathname==='/case'&&u.searchParams.get('id')==='yellow-character-print-v1'&&await read('案例与复现.html')){
   res.writeHead(302,{'Location':'/examples#character','Cache-Control':'no-store'});res.end();return true;
  }
  if(u.pathname==='/api/submission/status'){
   const available=Boolean(await read('案例与复现.html'));
   res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({casesAvailable:available}));return true;
  }
  let name;if(u.pathname==='/examples')name='案例与复现.html';
  else if(u.pathname==='/submission-guide')name='完整源码/运行与模型配置.html';
  else if(u.pathname.startsWith('/review-files/')){try{name=decodeURIComponent(u.pathname.slice('/review-files/'.length));}catch{return false;}}
  else return false;
  let bytes=await read(name);
  if(!bytes&&u.pathname==='/submission-guide'){bytes=Buffer.from('<!doctype html><meta charset="utf-8"><h1>运行与模型配置</h1><pre style="white-space:pre-wrap;line-height:1.8">'+esc(await readFile(path.join(project,'运行与模型配置.md'),'utf8'))+'</pre>');}
  if(!bytes){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('未找到随包案例文件。请完整解压参赛包，从根目录开始.html进入。');return true;}
  if(path.extname(name)==='.html')bytes=Buffer.from(bytes.toString('utf8').replace(/(href|src)="([^"]+)"/gu,(m,a,v)=>allowed(v)?`${a}="/review-files/${encodeURI(v)}"`:m));
  res.writeHead(200,{'Content-Type':types[path.extname(name)]||'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return true;
 }};
}
