// Export a verified application case for read-only review on a fresh computer.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [base,out]=process.argv.slice(2);
if(!/^http:\/\/127\.0\.0\.1:\d+$/u.test(base??'')||!out)throw Error('Usage: node tools/review/export-character.mjs http://127.0.0.1:PORT OUTPUT');
const get=async url=>{const r=await fetch(base+url);if(!r.ok)throw Error(`${url}: HTTP ${r.status}`);return Buffer.from(await r.arrayBuffer());};
const digest=b=>createHash('sha256').update(b).digest('hex');
const c=JSON.parse(await get('/api/application-cases/yellow-character-print-v1'));
if(c.state!=='verified'||!['source','color','print'].every(k=>c.fileChecks?.[k]))throw Error('Application case did not pass current file verification');
const p=JSON.parse(await get('/api/poses/jobs/'+c.protection.poseJobId));
await mkdir(out,{recursive:true});const files=[];
async function save(name,bytes,expected){if(expected&&digest(bytes)!==expected)throw Error(`${name}: hash changed`);await writeFile(path.join(out,name),bytes);files.push({path:name,bytes:bytes.length,sha256:digest(bytes),compressedEstimate:deflateSync(bytes,{level:6}).length});}
for(const [name,url] of Object.entries(c.source.views))await save(name+'.png',await get(url));
await save('source.stl',await get(`/api/reconstruction/jobs/${c.source.jobId}/stl/${c.source.candidateId}?sha=${c.source.sha256}`),c.source.sha256);
await save('color.glb',await get(c.color.url),c.color.sha256);
await save('print.stl',await get(c.print.url),c.print.sha256);
await save('preview.png',await readFile(path.join(root,'data/application-cases/yellow-character-print-v1/case-browser.png')));
for(const pose of ['upright','face-up']){
 const r=p.results.find(r=>r.poseId===pose);
 await save(pose+'.gcode',await readFile(path.join(root,'data/pose-jobs',p.id,pose,'slice/result.gcode')),r.slice.proof.gcodeSha256);
}
const snapshot={schema:'xingzao-review-case/v1',capturedAt:new Date().toISOString(),case:c,
 poses:p.results.map(r=>({poseId:r.poseId,status:r.status,metrics:r.slice?.metrics,proof:r.slice?.proof,supportAudit:r.supportAudit})),files};
await writeFile(path.join(out,'record.json'),JSON.stringify(snapshot,null,2)+'\n');
console.log(JSON.stringify({files:files.length,bytes:files.reduce((s,f)=>s+f.bytes,0),compressedEstimate:files.reduce((s,f)=>s+f.compressedEstimate,0)}));
