import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildReviewBundle } from './bundle.mjs';

async function fixture(t) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'review-bundle-'));
  const cleanup = async () => {const parent=await realpath(os.tmpdir()),target=await realpath(repoRoot),relative=path.relative(parent,target);if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!path.basename(target).startsWith('review-bundle-')||(await lstat(repoRoot)).isSymbolicLink())throw new Error('Unsafe cleanup target');await rm(repoRoot,{recursive:true,force:true});};
  t.after(cleanup);
  await mkdir(path.join(repoRoot, 'data', 'case'), { recursive: true });
  await mkdir(path.join(repoRoot, 'tools', 'review'), { recursive: true });
  await mkdir(path.join(repoRoot,'src'));await writeFile(path.join(repoRoot,'src','core.mjs'), 'export const ok = true;\n');
  await writeFile(path.join(repoRoot, 'tools', 'review', 'check.mjs'), 'console.log("offline");\n');
  const bytes = Buffer.from('cached safe evidence');
  await writeFile(path.join(repoRoot, 'data', 'case', 'result.json'), bytes);
  const snapshotPath = path.join(repoRoot, 'data', 'snapshot.json');
  const snapshot = {
    schema: 'xingzao-review-snapshot/v1',
    artifacts: [{ name: 'case/result.json', sourcePath: 'data/case/result.json', sha256: createHash('sha256').update(bytes).digest('hex') }],
    summary: { verification: 'cached evidence only', modelRequestVerified: false },
  };
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  return { repoRoot, snapshotPath, snapshot, bytes };
}

function options(f, extra = {}) {
  return {
    ...f,
    outputRoot: 'data/review-bundles',
    archive: false,
    codeFiles: async () => ['src/core.mjs'],
    ...extra,
  };
}

test('creates a new bundle with copied evidence, code and a byte-hash manifest', async (t) => {
  const f = await fixture(t);
  const result = await buildReviewBundle(options(f));
  assert.match(path.basename(result.directory), /^[0-9a-f-]{36}$/u);
  assert.deepEqual(await readFile(path.join(result.directory, 'case', 'result.json')), f.bytes);
  assert.equal(await readFile(path.join(result.directory,'src','core.mjs'), 'utf8'), 'export const ok = true;\n');
  assert.equal(await readFile(path.join(result.directory, 'tools', 'review', 'check.mjs'), 'utf8'), 'console.log("offline");\n');
  const manifest = JSON.parse(await readFile(path.join(result.directory, 'bundle-manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 'xingzao-review-bundle/v1');
  assert.equal(manifest.claims.liveModelRequestVerified, false);
  assert.equal(manifest.claims.physicalPrintVerified, false);
  assert.ok(manifest.files.some((item) => item.path === 'case/result.json' && item.sha256 === f.snapshot.artifacts[0].sha256));
});

test('rejects traversal and absolute artifact destinations before creating output', async (t) => {
  const f = await fixture(t);
  for (const name of ['../escape.json', 'C:/escape.json', '/escape.json', 'case/../escape.json', 'case\\escape.json']) {
    f.snapshot.artifacts[0].name = name;
    await writeFile(f.snapshotPath, JSON.stringify(f.snapshot));
    await assert.rejects(buildReviewBundle(options(f)), /artifact name/u);
  }
});

test('rejects sources outside data and forbidden artifact names or extensions', async (t) => {
  const f = await fixture(t);
  f.snapshot.artifacts[0].sourcePath = 'src.mjs';
  await writeFile(f.snapshotPath, JSON.stringify(f.snapshot));
  await assert.rejects(buildReviewBundle(options(f)), /sourcePath/u);
  for (const name of ['case/.env.json', 'case/credentials.json', 'case/token.stl', 'case/debug.log', 'case/state.db', 'case/run.py']) {
    f.snapshot.artifacts[0].sourcePath = 'data/case/result.json';
    f.snapshot.artifacts[0].name = name;
    await writeFile(f.snapshotPath, JSON.stringify(f.snapshot));
    await assert.rejects(buildReviewBundle(options(f)), /artifact name/u);
  }
});

test('rejects changed evidence bytes and does not create an output bundle', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repoRoot, 'data', 'case', 'result.json'), 'changed');
  await assert.rejects(buildReviewBundle(options(f)), /SHA-256/u);
});

test('refuses existing UUID destination and preserves its contents', async (t) => {
  const f = await fixture(t);
  const outputRoot = path.join(f.repoRoot, 'data', 'review-bundles');
  const id = '11111111-1111-4111-8111-111111111111';
  await mkdir(path.join(outputRoot, id), { recursive: true });
  await writeFile(path.join(outputRoot, id, 'keep.txt'), 'keep');
  await assert.rejects(buildReviewBundle(options(f, { uuid: id })), /already exists/u);
  assert.equal(await readFile(path.join(outputRoot, id, 'keep.txt'), 'utf8'), 'keep');
});

test('rejects artifact size over the per-file cap before copying', async (t) => {
  const f = await fixture(t);
  await assert.rejects(buildReviewBundle(options(f, { maxFileBytes: 4 })), /size cap/u);
});
test('size caps apply to source files and the whole assembled payload',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.repoRoot,'src/core.mjs'),'x'.repeat(4096));
 await assert.rejects(buildReviewBundle(options(f,{maxFileBytes:2048})),/size cap/iu);
 await assert.rejects(buildReviewBundle(options(f,{maxTotalBytes:4096})),/total size/iu);
});
test('tracked model weights never enter the source bundle',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.repoRoot,'tools/weights'));await writeFile(path.join(f.repoRoot,'tools/weights/model.safetensors'),'not a weight');
 const result=await buildReviewBundle(options(f,{codeFiles:async()=>['src/core.mjs','tools/weights/model.safetensors']}));
 const manifest=JSON.parse(await readFile(path.join(result.directory,'bundle-manifest.json'),'utf8'));
 assert.equal(manifest.files.some(f=>f.path.includes('safetensors')),false);
});
