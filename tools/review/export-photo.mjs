import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [base,out]=process.argv.slice(2);
if(!/^http:\/\/127\.0\.0\.1:\d+$/u.test(base??'')||!out)throw Error('Usage: export-photo.mjs LOCAL_SERVER OUTPUT');
const get=async p=>{const r=await fetch(base+p);if(!r.ok)throw Error('HTTP '+r.status);return Buffer.from(await r.arrayBuffer());};
const job=JSON.parse(await get('/api/protect/jobs/6025253a-b246-486f-9e4a-ae39cdb349c9'));
if(job.stage!=='completed'||job.bindingError||!job.delivery)throw Error('Photo case is not complete');
const source=JSON.parse(await get('/api/reconstruction/jobs/'+job.source.jobId));
if(source.stage!=='completed'||source.submission.assetSha256!==job.sourceSha256)throw Error('Photo source changed');
await mkdir(out,{recursive:true});const files=[];
for(const [name,url] of [['source.stl',`/api/reconstruction/jobs/${source.id}/stl/${source.submittedCandidateId}?sha=${job.sourceSha256}`],...['front','left','back'].map(n=>[n+'.png',`/api/reconstruction/jobs/${source.id}/view/${n}`])]){
 const bytes=await get(url),sha256=createHash('sha256').update(bytes).digest('hex');if(name==='source.stl'&&sha256!==job.sourceSha256)throw Error('Photo STL hash changed');
 await writeFile(path.join(out,name),bytes);files.push({path:name,bytes:bytes.length,sha256});
}
await writeFile(path.join(out,'record.json'),JSON.stringify({schema:'xingzao-photo-review/v1',capturedAt:new Date().toISOString(),jobId:job.id,sourceJobId:source.id,sourceSha256:job.sourceSha256,events:source.events,files},null,2)+'\n');
console.log(JSON.stringify({photoFiles:files.length,bytes:files.reduce((a,f)=>a+f.bytes,0)}));
