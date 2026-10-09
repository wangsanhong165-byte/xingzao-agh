import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { evaluatePlanarDetail } from './detail-evaluation.mjs';
import { parseGcodeSegments } from './slicer.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function encodeMask(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; // 8-bit grayscale PNG, as emitted by extract_detail.py
  header[9] = 0;
  header[10] = 0; header[11] = 0; header[12] = 0;
  const scanlines = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), Buffer.from(row.map((value) => value ? 255 : 0))])));
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return { width, height, dataBase64: png.toString('base64') };
}

function blank(width, height) { return Array.from({ length: height }, () => Array(width).fill(0)); }

function options(targetMask, extras = {}) {
  return {
    targetMask,
    widthMm: targetMask.width,
    depthMm: targetMask.height,
    baseZ: 2,
    reliefHeight: 0.6,
    placementOffsetMm: { x: 90, y: 90, z: 0 },
    extrusionWidthMm: 1,
    rasterStepMm: 0.25,
    ...extras,
  };
}

function startCode() {
  return 'G21\nG90\nM82\nG92 X0 Y0 Z0 E0\nG0 Z2.2\n';
}

test('shared G-code parser preserves model, support, skirt/brim, travel, retract, and Z-hop roles', () => {
  const gcode = `${startCode()};TYPE:External perimeter\n;WIDTH:0.45\nG1 X85 Y90 E1\n;TYPE:Support material\n;WIDTH:0.45\nG1 X90 Y90 E2\n;TYPE:Skirt/Brim\n;WIDTH:0.45\nG1 X95 Y90 E3\nG1 E2\nG0 Z2.4\nG0 X96 Y90\n`;
  const { segments } = parseGcodeSegments(gcode);
  const motions = segments.map(({ motionType, role, lineWidthMm }) => ({ motionType, role, lineWidthMm }));

  assert.deepEqual(motions.filter((segment) => segment.motionType === 'extrusion'), [
    { motionType: 'extrusion', role: 'MODEL', lineWidthMm: 0.45 },
    { motionType: 'extrusion', role: 'SUPPORT', lineWidthMm: 0.45 },
    { motionType: 'extrusion', role: 'SKIRT_BRIM', lineWidthMm: 0.45 },
  ]);
  assert.ok(motions.some((segment) => segment.motionType === 'retraction' && segment.role === 'RETRACTION'));
  assert.ok(motions.some((segment) => segment.motionType === 'zhop' && segment.role === 'ZHOP'));
  assert.ok(motions.some((segment) => segment.motionType === 'travel' && segment.role === 'TRAVEL'));
});

test('one in-ROI model stroke cannot count as preserved glyph coverage', async () => {
  const mask = blank(20, 20);
  for (let y = 3; y <= 16; y += 1) { mask[y][3] = 1; mask[y][16] = 1; }
  for (let x = 3; x <= 16; x += 1) mask[9][x] = 1;
  const gcode = `${startCode()};TYPE:Perimeter\n;WIDTH:1.0\nG1 X83.5 Y90.5 E1\nG1 X96.5 Y90.5 E2\n`;

  const result = await evaluatePlanarDetail(gcode, options(encodeMask(mask)));

  assert.ok(result.targetCoverageFraction > 0);
  assert.ok(result.targetCoverageFraction < 0.5);
  assert.equal(result.evaluation.mode, 'planar-toolpath-footprint');
  assert.equal(result.checks.find((check) => check.name === 'planar-footprint').status, 'measured');
  assert.match(result.warnings.join(' '), /近似|实物/);
});

test('support extrusion is separated and cannot count as model target coverage', async () => {
  const mask = blank(20, 20);
  for (let x = 3; x <= 16; x += 1) mask[9][x] = 1;
  const gcode = `${startCode()};TYPE:Support material\n;WIDTH:1.0\nG1 X83.5 Y90.5 E1\nG1 X96.5 Y90.5 E2\n`;

  const result = await evaluatePlanarDetail(gcode, options(encodeMask(mask)));

  assert.equal(result.targetCoverageFraction, 0);
  assert.equal(result.modelExtrusionLengthMm, 0);
  assert.ok(result.roleLengthsMm.support > 10);
  assert.equal(result.roleEvidence.verified, true);
});

test('translated model paths cover a ring while retaining its target hole', async () => {
  const mask = blank(20, 20);
  for (let i = 2; i <= 17; i += 1) { mask[2][i] = 1; mask[17][i] = 1; mask[i][2] = 1; mask[i][17] = 1; }
  const gcode = `${startCode()};TYPE:External perimeter\n;WIDTH:1.0\nG1 X82.5 Y82.5 E1\nG1 X97.5 Y82.5 E2\nG1 X97.5 Y97.5 E3\nG1 X82.5 Y97.5 E4\nG1 X82.5 Y82.5 E5\n`;

  const result = await evaluatePlanarDetail(gcode, options(encodeMask(mask)));

  assert.ok(result.targetCoverageFraction > 0.75);
  assert.equal(result.targetHoleCount, 1);
  assert.equal(result.survivingTargetHoleCount, 1);
  assert.equal(result.targetHoleRemainingFraction, 0.8);
  assert.ok(result.spillAreaMm2 >= 0);

  const noRaisedPath = await evaluatePlanarDetail(startCode(), options(encodeMask(mask)));
  assert.equal(noRaisedPath.survivingTargetHoleCount, null);
  assert.equal(noRaisedPath.targetHoles[0].survives, null);
  assert.equal(noRaisedPath.holeEvidence.verified, false);
});

test('a hole that is almost fully occluded fails the default 80 percent retention rule', async () => {
  const mask = blank(20, 20);
  for (let y = 3; y <= 16; y += 1) for (let x = 3; x <= 16; x += 1) mask[y][x] = 1;
  for (let y = 9; y <= 10; y += 1) for (let x = 9; x <= 10; x += 1) mask[y][x] = 0;
  for (let y = 5; y <= 14; y += 1) for (let x = 5; x <= 14; x += 1) mask[y][x] = 0;
  const extrusionLines = [';TYPE:External perimeter', ';WIDTH:0.1', 'G0 X83 Y96.5', 'G1 X97 Y96.5 E1', ';TYPE:Solid infill', ';WIDTH:0.1'];
  let e = 1;
  for (let i = 0; i < 99; i += 1) {
    const y = -4.95 + i * 0.1;
    extrusionLines.push(`G0 X85.1 Y${(90 + y).toFixed(2)}`);
    e += 1;
    extrusionLines.push(`G1 X94.9 Y${(90 + y).toFixed(2)} E${e}`);
  }
  const gcode = `${startCode()}${extrusionLines.join('\n')}\n`;

  const result = await evaluatePlanarDetail(gcode, options(encodeMask(mask), { extrusionWidthMm: 0.1, rasterStepMm: 0.05 }));

  assert.equal(result.targetHoleCount, 1);
  assert.equal(result.targetHoles[0].remainingConnected, true);
  assert.ok(result.targetHoles[0].remainingFraction < 0.8);
  assert.equal(result.targetHoles[0].survives, false);
  assert.equal(result.survivingTargetHoleCount, 0);
  const permissive = await evaluatePlanarDetail(gcode, options(encodeMask(mask), {
    extrusionWidthMm: 0.1,
    rasterStepMm: 0.05,
    targetHoleRemainingFraction: 0.01,
  }));
  assert.equal(permissive.targetHoles[0].survives, true);
});

test('unknown roles and fallback line width remain explicitly unverified', async () => {
  const mask = blank(20, 20);
  for (let x = 3; x <= 16; x += 1) mask[9][x] = 1;
  const gcode = `${startCode()}G1 X83.5 Y90.5 E1\nG1 X96.5 Y90.5 E2\n;TYPE:Perimeter\nG1 X83.5 Y90.5 E3\nG1 X96.5 Y90.5 E4\n`;

  const result = await evaluatePlanarDetail(gcode, options(encodeMask(mask), { extrusionWidthMm: 0.45 }));

  assert.equal(result.roleEvidence.verified, false);
  assert.equal(result.lineWidthEvidence.verified, false);
  assert.ok(result.roleLengthsMm.unknown > 0);
  assert.match(result.warnings.join(' '), /unknown|未分类|宽度/);
});

test('model paths above the configured planar relief height are reported and excluded', async () => {
  const mask = blank(20, 20);
  for (let x = 3; x <= 16; x += 1) mask[9][x] = 1;
  const gcode = `${startCode()};TYPE:Perimeter\n;WIDTH:1.0\nG1 X83.5 Y90.5 E1\nG1 X96.5 Y90.5 E2\nG0 Z3.0\nG0 X83.5 Y90.5\nG1 X96.5 Y90.5 E3\n`;

  const result = await evaluatePlanarDetail(gcode, options(encodeMask(mask)));

  assert.equal(result.modelRaisedLayerCount, 1);
  assert.equal(result.highestModelExtrusionZ, 2.2);
  assert.ok(result.modelAboveReliefLengthMm >= 10);
  assert.match(result.warnings.join(' '), /高于预期浮雕高度/);
});

test('empty masks and oversized evaluation rasters fail clearly', async () => {
  const empty = encodeMask(blank(20, 20));
  await assert.rejects(evaluatePlanarDetail(startCode(), options(empty)), /前景|foreground|empty/i);
  const mask = encodeMask([[1]]);
  await assert.rejects(evaluatePlanarDetail(startCode(), options(mask, { widthMm: 180, depthMm: 180, rasterStepMm: 0.01 })), /栅格|raster|limit/i);
});
