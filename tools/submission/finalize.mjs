import {readFile,writeFile,mkdir,lstat,access} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=c=>{throw new Error(c);};
const inside=(root,p)=>{const r=path.relative(root,p);return !r||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
const forbidden=/(?:^|\/)\.env(?:\.|$)|\.(?:mp4|webm|mov|avi|wav|mp3|db|sqlite3?|safetensors|pth|pt|onnx|gguf)$/iu;
function relativeName(s){if(typeof s!=='string'||!s||s.includes('\\')||s.includes(':')||s.startsWith('/')||/[\x00-\x1f\x7f]/u.test(s)||s.split('/').some(x=>!x||x==='.'||x==='..'))fail('PATH_INVALID');return s;}
function text(s,max=100){if(typeof s!=='string'||!s.trim())fail('METADATA_REQUIRED');s=s.trim();if([...s].length>max||/[\p{Cc}\p{Zl}\p{Zp}]/u.test(s))fail('NAME_INVALID');return s;}
function name(s,max=100){s=text(s,max);if(/[<>:"/\\|?*]/u.test(s)||/[. ]$/u.test(s)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu.test(s))fail('NAME_INVALID');return s;}
function publicUrl(s){if(typeof s!=='string'||!s.trim())fail('METADATA_REQUIRED');let u;try{u=new URL(s.trim());}catch{fail('PUBLIC_URL_INVALID');}const h=u.hostname.toLowerCase().replace(/\.$/u,'');if(s.length>500||!['https:','http:'].includes(u.protocol)||u.username||u.password||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.includes(':')||/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(h))fail('PUBLIC_URL_INVALID');return u.href;}
export function validateSubmissionInfo(raw){
 const allowed=new Set(['group','entryId','teamName','leaderName','projectName','videoUrl','backupVideoUrl','videoAccessCode','videoAnonymousChecked','publicPostUrl','publicPostDate','publicPostAnonymousChecked','publicScreenshot','memberDeclarationConfirmed','memberDeclarationFile','members']);
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!allowed.has(k)))fail('METADATA_FIELD_FORBIDDEN');
 const j={...raw};for(const k of ['group','entryId','teamName','leaderName','projectName'])j[k]=name(j[k],k==='entryId'?64:100);
 if(!['本科生组','硕博组'].includes(j.group))fail('GROUP_INVALID');
 for(const k of ['videoAnonymousChecked','publicPostAnonymousChecked','memberDeclarationConfirmed'])if(j[k]!==true)fail('HUMAN_CONFIRMATION_REQUIRED');
 j.videoUrl=publicUrl(j.videoUrl);j.publicPostUrl=publicUrl(j.publicPostUrl);j.backupVideoUrl=j.backupVideoUrl?publicUrl(j.backupVideoUrl):'';
 j.videoAccessCode=typeof j.videoAccessCode==='string'?j.videoAccessCode.trim():'';if(j.videoAccessCode.length>100||/[\p{Cc}]/u.test(j.videoAccessCode))fail('NAME_INVALID');
 if(!/^\d{4}-\d{2}-\d{2}$/u.test(j.publicPostDate??'')||Number.isNaN(Date.parse(j.publicPostDate))||new Date(j.publicPostDate).toISOString().slice(0,10)!==j.publicPostDate)fail('PUBLISH_DATE_INVALID');
 j.publicScreenshot=relativeName(j.publicScreenshot);j.memberDeclarationFile=j.memberDeclarationFile?relativeName(j.memberDeclarationFile):'';
 if(!Array.isArray(j.members)||!j.members.length||j.members.length>3)fail('MEMBERS_REQUIRED');
 j.members=j.members.map(m=>{if(!m||Object.keys(m).some(k=>!['name','school','degree','contribution'].includes(k)))fail('METADATA_FIELD_FORBIDDEN');const x={name:text(m.name),school:text(m.school),degree:text(m.degree),contribution:text(m.contribution,700)};if(!['本科','硕士','博士'].includes(x.degree))fail('DEGREE_INVALID');return x;});
 if(!j.members.some(m=>m.name===j.leaderName)||new Set(j.members.map(m=>m.name)).size!==j.members.length)fail('MEMBERS_INVALID');
 if((j.members.some(m=>m.degree!=='本科')?'硕博组':'本科生组')!==j.group)fail('GROUP_DEGREE_MISMATCH');
 if(/(?:sk-[A-Za-z0-9_-]{24,}|user_[A-Za-z0-9]{24,})/u.test(JSON.stringify(j)))fail('SECRET_VALUE_FORBIDDEN');
 return j;
}
async function regular(root,relative){
 relativeName(relative);let p=root;for(const part of relative.split('/')){p=path.join(p,part);const s=await lstat(p).catch(()=>null);if(!s||s.isSymbolicLink())fail('ATTACHMENT_REQUIRED');}
 if(!(await lstat(p)).isFile())fail('ATTACHMENT_REQUIRED');return readFile(p);
}
const table=Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(b){let c=0xffffffff;for(const v of b)c=table[(c^v)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export function storedZip(entries){
 const local=[],central=[];let offset=0;
 for(const [name,bytes] of entries){const n=Buffer.from(relativeName(name),'utf8'),crc=crc32(bytes);if(n.length>65535||bytes.length>0xffffffff)fail('PAYLOAD_TOO_LARGE');
  const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(0x21,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(bytes.length,18);h.writeUInt32LE(bytes.length,22);h.writeUInt16LE(n.length,26);local.push(h,n,bytes);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(0x21,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);central.push(c,n);offset+=h.length+n.length+bytes.length;
 }
 const centralSize=central.reduce((n,b)=>n+b.length,0),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,...central,end]);
}
export async function finalizeSubmission({root,release,info,outputRoot,maxBytes=190*1024*1024}){
 root=path.resolve(root);release=path.resolve(release);outputRoot=path.resolve(outputRoot);if(!inside(root,release)||!inside(root,outputRoot)||outputRoot===root)fail('OUTPUT_OUTSIDE_ROOT');
 const data=validateSubmissionInfo(info),manifestBytes=await regular(release,'release-manifest.json'),manifest=JSON.parse(manifestBytes);
 if(manifest.schema!=='xingzao-submission-ready/v1'||!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>1500)fail('RELEASE_MANIFEST_INVALID');
 const entries=new Map();let size=0;const add=(n,b)=>{relativeName(n);if(entries.has(n))fail('PAYLOAD_DUPLICATE');if(forbidden.test(n))fail('PAYLOAD_FORBIDDEN');size+=b.length;if(size>maxBytes)fail('PAYLOAD_TOO_LARGE');entries.set(n,b);};
 for(const item of manifest.files){relativeName(item.path);if(forbidden.test(item.path))fail('PAYLOAD_FORBIDDEN');const b=await regular(release,item.path);if(b.length!==item.bytes||sha(b)!==item.sha256)fail('SOURCE_HASH_MISMATCH');add(item.path,b);}
 add('release-manifest.json',manifestBytes);
 const screenshot=await regular(root,data.publicScreenshot);if(!/\.(?:png|jpe?g|webp)$/iu.test(data.publicScreenshot)||screenshot.length>10*1024*1024||!((screenshot.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(screenshot[0]===255&&screenshot[1]===216)||(screenshot.subarray(0,4).toString()==='RIFF'&&screenshot.subarray(8,12).toString()==='WEBP')))fail('ATTACHMENT_INVALID');
 add('公开内容/'+path.basename(data.publicScreenshot),screenshot);
 if(data.memberDeclarationFile){const b=await regular(root,data.memberDeclarationFile);if(!/\.(?:pdf|png|jpe?g)$/iu.test(data.memberDeclarationFile)||b.length>15*1024*1024)fail('ATTACHMENT_INVALID');add('成员声明/'+path.basename(data.memberDeclarationFile),b);}
 add('提交信息.json',Buffer.from(JSON.stringify(data,null,2)));
 add('报名信息与发布链接.md',Buffer.from(`# ${data.projectName}\n\n组别：${data.group}\n参赛编号：${data.entryId}\n队伍：${data.teamName}\n队长：${data.leaderName}\n\n视频主链接：${data.videoUrl}\n备用：${data.backupVideoUrl||'无'}\n视频访问码：${data.videoAccessCode||'不需要'}\n\n真实公开内容：${data.publicPostUrl}\n发布日期：${data.publicPostDate}\n\n成员：\n${data.members.map(m=>`- ${m.name}，${m.school}，${m.degree}；负责：${m.contribution}`).join('\n')}\n\n队长在信息文件中确认已核对成员声明及未登录访问。该记录不生成或代替成员本人签名，平台要求的确认仍须由本人完成。\n`));
 const index={schema:'xingzao-final-submission/v1',createdAt:new Date().toISOString(),sourceRevision:manifest.sourceRevision,files:[...entries].map(([path,b])=>({path,bytes:b.length,sha256:sha(b)})),manifestExcludesSelf:true};add('submission-manifest.json',Buffer.from(JSON.stringify(index,null,2)));
 const zip=storedZip([...entries]);if(zip.length>maxBytes)fail('PAYLOAD_TOO_LARGE');
 const filename=[data.group,data.entryId,data.teamName,data.leaderName].join('-')+'.zip';if(filename.length>250)fail('NAME_INVALID');const target=path.join(outputRoot,filename),receiptFile=target+'.receipt.json';if(!inside(outputRoot,target))fail('OUTPUT_OUTSIDE_ROOT');
 if(await access(target).then(()=>true,()=>false)||await access(receiptFile).then(()=>true,()=>false))fail('OUTPUT_EXISTS');await mkdir(outputRoot,{recursive:true});await writeFile(target,zip,{flag:'wx'});
 const receipt={filename,path:target,bytes:zip.length,sha256:sha(zip),fileCount:entries.size,sourceRevision:manifest.sourceRevision,createdAt:index.createdAt,automaticUpload:false,physicalPrintVerified:false};await writeFile(receiptFile,JSON.stringify(receipt,null,2),{flag:'wx'});return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const root=path.resolve(process.argv[2]??process.cwd()),info=JSON.parse(await readFile(path.join(root,'报名与发布信息.json'),'utf8'));const r=await finalizeSubmission({root,release:path.join(root,'待补信息底包'),info,outputRoot:path.join(root,'正式提交包')});process.stdout.write(`已生成：${r.path}\n大小：${r.bytes} 字节\nSHA-256：${r.sha256}\n请由队长核对后上传，程序没有自动提交。\n`);}catch(e){process.stderr.write(`未生成正式包：${e.message}\n请按08-你需要执行的步骤.md补齐真实信息；没有的链接、截图或本人确认不能用占位值代替。\n`);process.exitCode=1;}
}
