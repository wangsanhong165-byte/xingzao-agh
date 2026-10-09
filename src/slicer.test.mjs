import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeDetailPaths, getSlicerStatus, sliceArtifact } from './slicer.mjs';
import modeling from '@jscad/modeling';
import stlSerializer from '@jscad/stl-serializer';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'tests', 'slicer-fixtures');
const featureBoundsMm = { xMin: -10, yMin: -10, xMax: 10, yMax: 10 };
const common = {
  baseZ: 2,
  featureBoundsMm,
  placementOffsetMm: { x: 90, y: 90 },
  nozzleDiameter: 0.4,
};

test('real extrusion above base within the translated feature ROI is detected', async () => {
  const gcode = await readFile(path.join(fixtures, 'raised.gcode'), 'utf8');
  const result = analyzeDetailPaths(gcode, common);

  assert.equal(result.hasRaisedDetail, true);
  assert.ok(result.featureExtrusionLengthMm >= 20);
  assert.equal(result.featureLayerCount, 1);
  assert.equal(result.highestExtrusionZ, 2.2);
  assert.match(result.previewSvg, /<svg/);
  assert.match(result.previewSvg, /<path/);
});

test('a tall Z-hop and base-only extrusion do not masquerade as raised detail', async () => {
  const gcode = await readFile(path.join(fixtures, 'base-only.gcode'), 'utf8');
  const result = analyzeDetailPaths(gcode, common);

  assert.equal(result.hasRaisedDetail, false);
  assert.equal(result.featureExtrusionLengthMm, 0);
  assert.equal(result.featureLayerCount, 0);
  assert.equal(result.highestExtrusionZ, null);
  assert.match(result.checks.map((check) => check.name).join(' '), /raised-detail/);
});

test('model-local ROI does not match bed coordinates when the slicer placement offset is omitted', async () => {
  const gcode = await readFile(path.join(fixtures, 'raised.gcode'), 'utf8');
  const result = analyzeDetailPaths(gcode, { ...common, placementOffsetMm: { x: 0, y: 0 } });

  assert.equal(result.hasRaisedDetail, false);
  assert.equal(result.featureExtrusionLengthMm, 0);
});

test('array ROI is accepted and malformed/non-positive bounds are rejected', async () => {
  const gcode = await readFile(path.join(fixtures, 'raised.gcode'), 'utf8');
  const arrayResult = analyzeDetailPaths(gcode, { ...common, featureBoundsMm: [-10, -10, 10, 10] });
  assert.equal(arrayResult.hasRaisedDetail, true);
  assert.throws(() => analyzeDetailPaths(gcode, { ...common, featureBoundsMm: [0, 0, Number.NaN, 10] }), /finite/);
  assert.throws(() => analyzeDetailPaths(gcode, { ...common, featureBoundsMm: [1, 0, 1, 10] }), /positive width and height/);
});

test('slicer status exposes whether the controlled actual slicer and virtual profile are available', async () => {
  const status = await getSlicerStatus();
  assert.equal(typeof status.available, 'boolean');
  assert.equal(status.profileId, 'fdm-pla-04');
  assert.equal(status.mode, 'actual-slicer');
  assert.equal(typeof status.version, 'string');
});

test('actual PrusaSlicer leaves base-only STL without raised paths and detects added raised geometry', async (t) => {
  const status = await getSlicerStatus();
  if (!status.available) return t.skip('portable PrusaSlicer 2.9.6 is not present in ignored data/tools');

  const validationDir = path.join(here, '..', 'data', 'slicer-validation');
  await mkdir(validationDir, { recursive: true });
  const { primitives, booleans, transforms } = modeling;
  const base = transforms.translate([0, 0, 1], primitives.cuboid({ size: [40, 30, 2] }));
  const raised = transforms.translate([0, 0, 2.4], primitives.cuboid({ size: [8, 6, 0.8] }));
  const makeStl = async (name, solid) => {
    const serialized = stlSerializer.serialize({ binary: true }, solid);
    const stlPath = path.join(validationDir, `${name}.stl`);
    await writeFile(stlPath, Buffer.concat(serialized.map((part) => Buffer.from(part))));
    return stlPath;
  };
  const basePath = await makeStl('controlled-base-only', base);
  const raisedPath = await makeStl('controlled-base-with-raised-rectangle', booleans.union(base, raised));
  const baseSlice = await sliceArtifact({ stlPath: basePath, outputDir: path.join(validationDir, 'base-slice') });
  const raisedSlice = await sliceArtifact({ stlPath: raisedPath, outputDir: path.join(validationDir, 'raised-slice') });
  const region = { xMin: -4, yMin: -3, xMax: 4, yMax: 3 };
  const baseGcode = await readFile(baseSlice.gcodePath, 'utf8');
  const raisedGcode = await readFile(raisedSlice.gcodePath, 'utf8');
  const basePaths = analyzeDetailPaths(baseGcode, { ...common, baseZ: 2, featureBoundsMm: region, placementOffsetMm: baseSlice.placementOffsetMm });
  const raisedPaths = analyzeDetailPaths(raisedGcode, { ...common, baseZ: 2, featureBoundsMm: region, placementOffsetMm: raisedSlice.placementOffsetMm });

  assert.equal(basePaths.hasRaisedDetail, false);
  assert.equal(basePaths.featureExtrusionLengthMm, 0);
  assert.equal(raisedPaths.hasRaisedDetail, true);
  assert.ok(raisedPaths.featureLayerCount >= 2);
  assert.ok(raisedPaths.featureExtrusionLengthMm > 8);
  assert.equal(baseSlice.execution.mode, 'actual-slicer');
  assert.match(baseSlice.execution.version, /2\.9\.6/);
  assert.ok(baseSlice.metrics.filamentMm > 0);
  assert.ok(baseSlice.metrics.filamentG > 0);
  assert.ok(baseSlice.metrics.estimatedTimeSeconds > 0);
  assert.deepEqual(baseSlice.placementOffsetMm, { x: 90, y: 90, z: 0 });
  assert.equal(baseSlice.placementVerification.centeredAtRequestedPoint, true);
  assert.deepEqual(raisedSlice.placementOffsetMm, { x: 90, y: 90, z: 0 });
  assert.equal(raisedSlice.placementVerification.centeredAtRequestedPoint, true);
});
