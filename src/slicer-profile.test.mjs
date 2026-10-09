import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import modeling from '@jscad/modeling';
import stlSerializer from '@jscad/stl-serializer';
import { getSlicerStatus, sliceArtifact } from './slicer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const parseConfig = text => Object.fromEntries(text.split(/\r?\n/).filter(line => /^[^#;][^=]*=/.test(line)).map(line => { const p=line.indexOf('='); return [line.slice(0,p).trim(),line.slice(p+1).trim()]; }));

test('automatic-support profile differs from the original only in support enablement', async () => {
  const base = parseConfig(await readFile(path.join(root,'tools/slicer/fdm-pla-04.ini'),'utf8'));
  const support = parseConfig(await readFile(path.join(root,'tools/slicer/fdm-pla-04-auto-support.ini'),'utf8'));
  assert.equal(base.support_material, '0');
  assert.equal(support.support_material, '1');
  assert.deepEqual({...support, support_material:'0'}, base);
});

test('slicer accepts only named profiles and retains the original default', async () => {
  const original = await getSlicerStatus();
  const support = await getSlicerStatus({profileId:'fdm-pla-04-auto-support'});
  assert.equal(original.profileId, 'fdm-pla-04');
  assert.equal(support.profileId, 'fdm-pla-04-auto-support');
  assert.equal(support.profile.automaticSupport, true);
  await assert.rejects(getSlicerStatus({profileId:'../external'}), /Unsupported profileId/);
});

test('actual auto-support slicing binds source/config/output hashes and checks model placement separately from support', async t => {
  const status = await getSlicerStatus({profileId:'fdm-pla-04-auto-support'});
  if (!status.available) return t.skip('portable PrusaSlicer not available');
  const dir = path.join(root,'data/slicer-validation/profile-support');
  await mkdir(dir,{recursive:true});
  const {primitives,transforms,booleans}=modeling;
  const stem=transforms.translate([0,0,12],primitives.cuboid({size:[8,8,24]}));
  const shelf=transforms.translate([10,0,26],primitives.cuboid({size:[28,14,4]}));
  const bytes=Buffer.concat(stlSerializer.serialize({binary:true},booleans.union(stem,shelf)).map(part=>Buffer.from(part)));
  const stl=path.join(dir,'asymmetric-overhang.stl'); await writeFile(stl,bytes);
  const result=await sliceArtifact({stlPath:stl,outputDir:path.join(dir,'slice'),profileId:'fdm-pla-04-auto-support'});
  const gcode=await readFile(result.gcodePath);
  assert.match(gcode.toString('utf8'), /TYPE:Support material/);
  assert.equal(result.proof.sourceStlSha256,sha(bytes));
  assert.equal(result.proof.gcodeSha256,sha(gcode));
  assert.equal(result.proof.profileSha256,sha(await readFile(status.profilePath)));
  assert.equal(result.proof.settings.supportMaterial, true);
  assert.equal(result.placementVerification.modelPathsUsed, true);
  assert.equal(result.placementVerification.centeredAtRequestedPoint, true);
});
