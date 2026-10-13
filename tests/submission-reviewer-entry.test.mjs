import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPrintApp} from '../src/print-server.mjs';

test('a clean submission can open case materials and their files without historical jobs',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'xingzao-submission-'));
 await mkdir(path.join(dir,'评审案例'),{recursive:true});
 await writeFile(path.join(dir,'案例与复现.html'),'<h1>已执行案例</h1><a href="评审案例/原模型.stl">下载输入</a>');
 await writeFile(path.join(dir,'评审案例/原模型.stl'),'solid included-example\nendsolid');
 const server=createPrintApp({submissionRoot:dir});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const page=await fetch(base+'/examples');assert.equal(page.status,200,'shipped cases must open without the development job database');
  const html=await page.text();assert.match(html,/已执行案例/u);
  const href=html.match(/href="([^"]+)"/u)[1];
  const model=await fetch(new URL(href,base+'/examples'));assert.equal(model.status,200);assert.match(await model.text(),/included-example/u);
  const legacy=await fetch(base+'/case?id=yellow-character-print-v1',{redirect:'manual'});
  assert.equal(legacy.status,302,'the previous demo bookmark must also reach shipped case materials');
  assert.equal(legacy.headers.get('location'),'/examples#character');
  assert.equal((await fetch(base+'/review-files/完整源码/.env')).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('homepage historical cases link to shipped materials rather than private task IDs',async()=>{
 const html=await readFile(new URL('../public/workbench.html',import.meta.url),'utf8');
 for(const name of ['character','photo','rod'])assert.ok(html.includes(`/examples#${name}`),`${name} has a portable case entry`);
 assert.doesNotMatch(html,/href="\/(?:protect|workflow)\?job=/u);
});

test('the compact submission resolves case-relative models and parent-level AGH links',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'xingzao-compact-'));
 await mkdir(path.join(dir,'案例/评审案例'),{recursive:true});await mkdir(path.join(dir,'AGH运行记录/正常任务'),{recursive:true});
 await writeFile(path.join(dir,'README.html'),'<h1>形造</h1>');
 await writeFile(path.join(dir,'案例/index.html'),'<h1>案例</h1><a href="评审案例/model.stl">模型</a><a href="../AGH运行记录/正常任务/index.html">轨迹</a><a href="../README.html">说明</a>');
 await writeFile(path.join(dir,'案例/评审案例/model.stl'),'solid compact\nendsolid');
 await writeFile(path.join(dir,'AGH运行记录/正常任务/index.html'),'<h1>原始轨迹</h1>');
 const server=createPrintApp({submissionRoot:dir});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const response=await fetch(base+'/examples');assert.equal(response.status,200);
  const html=await response.text(),links=[...html.matchAll(/href="([^"]+)"/gu)].map(m=>m[1]);assert.equal(links.length,3);
  for(const link of links)assert.equal((await fetch(new URL(link,base+'/examples'))).status,200,link);
  assert.equal((await fetch(base+'/api/submission/status').then(r=>r.json())).casesAvailable,true);
  assert.equal((await fetch(base+'/review-files/完整源码/.env')).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
