import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
const api=await import('./finalize.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const sha=b=>createHash('sha256').update(b).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'submission-fixture-'));assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.equal(basename(root).startsWith('submission-fixture-'),true);t.after(()=>rm(root,{recursive:true,force:true}));
 const release=join(root,'ready');await mkdir(release);const data=Buffer.from('Synthetic fixture only, not a real entry.');await writeFile(join(release,'说明.md'),data);
 const manifest={schema:'xingzao-submission-ready/v1',sourceRevision:'3e29caf',files:[{path:'说明.md',bytes:data.length,sha256:sha(data)}]};await writeFile(join(release,'release-manifest.json'),JSON.stringify(manifest));await writeFile(join(root,'公开截图.png'),png);
 const info={group:'本科生组',entryId:'TEST-01',teamName:'测试夹具队伍',leaderName:'测试成员',projectName:'测试作品',videoUrl:'https://example.com/video',backupVideoUrl:'',videoAccessCode:'',videoAnonymousChecked:true,publicPostUrl:'https://example.com/post',publicPostDate:'2026-10-08',publicPostAnonymousChecked:true,publicScreenshot:'公开截图.png',memberDeclarationConfirmed:true,memberDeclarationFile:'',members:[{name:'测试成员',school:'测试学校',degree:'本科',contribution:'仅自动化测试夹具'}]};
 return {root,release,info,manifest,run:overrides=>{assert.equal(typeof api.finalizeSubmission,'function');return api.finalizeSubmission({root,release,info,outputRoot:join(root,'out'),...overrides});}};
}
test('creates a correctly named UTF-8 ZIP with source and user metadata; refuses overwrite',async t=>{const f=await fixture(t),r=await f.run();assert.equal(r.filename,'本科生组-TEST-01-测试夹具队伍-测试成员.zip');assert.equal(r.fileCount,6);const b=await readFile(r.path);assert.equal(b.readUInt32LE(0),0x04034b50);assert.equal(sha(b),r.sha256);assert.equal(b.includes(Buffer.from('测试夹具队伍')),true);assert.equal(b.includes(Buffer.from('submission-manifest.json')),true);await assert.rejects(f.run(),/OUTPUT_EXISTS/);});
for(const k of ['videoUrl','publicPostUrl','group','entryId','teamName','leaderName','projectName'])test('requires user-provided '+k,async t=>{const f=await fixture(t);f.info[k]='';await assert.rejects(f.run(),/METADATA_REQUIRED/);});
for(const k of ['videoAnonymousChecked','publicPostAnonymousChecked','memberDeclarationConfirmed'])test('cannot synthesize a confirmation for '+k,async t=>{const f=await fixture(t);f.info[k]=false;await assert.rejects(f.run(),/HUMAN_CONFIRMATION_REQUIRED/);});
test('rejects traversal in team naming or user attachment paths',async t=>{const f=await fixture(t);f.info.teamName='../other';await assert.rejects(f.run(),/NAME_INVALID/);f.info.teamName='测试';f.info.publicScreenshot='../outside.png';await assert.rejects(f.run(),/PATH_INVALID/);});
test('rejects localhost, script and credential-bearing publication links',async t=>{const f=await fixture(t);for(const u of ['http://127.0.0.1:4337/','javascript:alert(1)','https://user:pass@example.com/a','http://192.168.1.2/']){f.info.videoUrl=u;await assert.rejects(f.run(),/PUBLIC_URL_INVALID/);}});
test('rejects mutated ready source bytes',async t=>{const f=await fixture(t);await writeFile(join(f.release,'说明.md'),'Changed');await assert.rejects(f.run(),/SOURCE_HASH_MISMATCH/);});
test('rejects source traversal and video payload even if listed in the manifest',async t=>{const f=await fixture(t);for(const path of ['../outside','video.mp4','.env','sessions.db']){f.manifest.files[0].path=path;await writeFile(join(f.release,'release-manifest.json'),JSON.stringify(f.manifest));await assert.rejects(f.run(),/PATH_INVALID|PAYLOAD_FORBIDDEN/);}});
test('requires an existing actual screenshot rather than a link or empty placeholder',async t=>{const f=await fixture(t);f.info.publicScreenshot='missing.png';await assert.rejects(f.run(),/ATTACHMENT_REQUIRED/);f.info.publicScreenshot='公开截图.png';await writeFile(join(f.root,'公开截图.png'),'not an image');await assert.rejects(f.run(),/ATTACHMENT_INVALID/);});
test('validates group against actual declared degrees and refuses key fields',async t=>{const f=await fixture(t);f.info.members[0].degree='硕士';await assert.rejects(f.run(),/GROUP_DEGREE_MISMATCH/);f.info.members[0].degree='本科';f.info.apiKey='test-only-value';await assert.rejects(f.run(),/METADATA_FIELD_FORBIDDEN/);});
test('output stays within the specified preparation root and respects size cap',async t=>{const f=await fixture(t);await assert.rejects(f.run({outputRoot:join(f.root,'..','outside')}),/OUTPUT_OUTSIDE_ROOT/);await assert.rejects(f.run({maxBytes:10}),/PAYLOAD_TOO_LARGE/);});
