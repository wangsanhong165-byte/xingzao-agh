import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSupportPaths } from './support-evaluation.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const roi = [{ id: 'hotspot', boundsMm: [[0, 0, 0], [10, 10, 10]] }];
const base = { printToSourceMatrix4: identity, placementOffsetMm: { x: 0, y: 0, z: 0 }, placementVerified: true, protectedRegions: roi, layerHeightMm: 0.2 };
const gcode = (moves) => `;TYPE:Support material\n;WIDTH:0.4\n${moves}`;

test('counts support/interface extrusion with 3D ROI clipping and filament E', () => {
  const report = analyzeSupportPaths(gcode('G0 X-5 Y5 Z1\nG1 E0\nG1 X-5 Y5 Z1 E2\nG1 X15 Y5 Z1 E4\n;TYPE:Support material interface\n;WIDTH:0.4\nG1 X5 Y5 Z1 E5'), base);
  assert.equal(report.verified, true);
  assert.equal(report.support.pathLengthMm, 30);
  assert.equal(report.support.interfacePathLengthMm, 10);
  assert.equal(report.support.filamentLengthMm, 3);
  assert.ok(report.regions[0].supportPathLengthMm > 10);
  assert.equal(report.regions[0].segmentCount, 2);
  assert.ok(report.regions[0].interfacePathLengthMm > 0);
  assert.equal(report.scope, 'approximate-extrusion-envelope-in-source-aabb');
});

test('print-to-source rigid transform removes 90 degree placement rotation and bed translation', () => {
  const rotated = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const options = { ...base, printToSourceMatrix4: rotated, placementOffsetMm: { x: 90, y: 0, z: 0 } };
  // Source segment x=5, y=-5..15 maps to print x=95..75, y=5 after bed translation.
  const report = analyzeSupportPaths(gcode('G0 X95 Y5 Z1\nG1 E0\nG1 X95 Y5 Z1 E2\nG1 X75 Y5 Z1 E4'), options);
  assert.ok(Math.abs(report.regions[0].supportPathLengthMm - 10.6) < 1e-9);
  assert.equal(report.regions[0].segmentCount, 1);
});

test('applies print-to-source X30 rigid transform directly, including translation', () => {
  const cosine = Math.sqrt(3) / 2;
  const sine = 0.5;
  const printToSource = [
    1, 0, 0, 12,
    0, cosine, sine, 21.5,
    0, -sine, cosine, 30,
    0, 0, 0, 1,
  ];
  const options = {
    ...base,
    printToSourceMatrix4: printToSource,
    placementOffsetMm: { x: 0, y: 0, z: 0 },
    protectedRegions: [{ id: 'asymmetric', boundsMm: [[10.9, 22.4, 30.1], [11.1, 22.9, 30.9]] }],
  };
  // print [-1,0,1] maps to source [11,22,30.866...] using the supplied matrix.
  const report = analyzeSupportPaths(gcode('G0 X-1 Y0 Z1\nG1 X-1 Y0 Z1\nG1 X-1 Y2 Z1 E2'), options);
  assert.equal(report.verified, true);
  assert.equal(report.protectionVerified, true);
  assert.ok(report.regions[0].supportPathLengthMm > 0);
});

test('excludes model, skirt, prime, travel, retraction, and z-hop', () => {
  const text = `G0 X5 Y5 Z1\n;TYPE:Perimeter\n;WIDTH:0.4\nG1 X6 Y5 Z1 E2\n;TYPE:Support material\n;WIDTH:0.4\nG1 X7 Y5 Z1 E3\nG1 X8 Y5 Z1\nG1 E2\nG1 Z2\n;TYPE:Skirt\n;WIDTH:0.4\nG1 X9 Y5 Z2 E4`;
  const report = analyzeSupportPaths(text, base);
  assert.equal(report.support.pathLengthMm, 1);
  assert.equal(report.support.filamentLengthMm, 1);
});

test('interface lengths are separately attributed and ROI absence warns', () => {
  const report = analyzeSupportPaths(gcode('G0 X4 Y5 Z1\n;TYPE:Support material interface\n;WIDTH:0.4\nG1 X5 Y5 Z1 E2'), { ...base, protectedRegions: [] });
  assert.equal(report.verified, true);
  assert.equal(report.protectionVerified, false);
  assert.equal(report.support.interfacePathLengthMm, 1);
  assert.equal(report.support.interfaceFilamentLengthMm, 2);
  assert.equal(report.regions.length, 0);
  assert.ok(report.warnings.some((warning) => /未验证|no protected/i.test(warning)));
  const withRoi = analyzeSupportPaths(gcode('G0 X4 Y5 Z1\n;TYPE:Support material interface\n;WIDTH:0.4\nG1 X5 Y5 Z1 E2'), base);
  assert.equal(withRoi.verified, true);
  assert.equal(withRoi.protectionVerified, true);
});

test('invalid placement evidence, matrix, missing width, arcs, and unknown extrusion fail closed', () => {
  const clean = gcode('G0 X5 Y5 Z1\nG1 X6 Y5 Z1 E1');
  assert.equal(analyzeSupportPaths(clean, { ...base, placementVerified: false }).verified, false);
  assert.equal(analyzeSupportPaths(clean, { ...base, placementOffsetMm: undefined }).verified, false);
  assert.equal(analyzeSupportPaths(clean, { ...base, printToSourceMatrix4: [...identity.slice(0, 12), 1, 0, 0, 1] }).verified, false);
  const missingWidth = analyzeSupportPaths(';TYPE:Support material\nG0 X5 Y5 Z1\nG1 X6 Y5 Z1 E1', base);
  assert.equal(missingWidth.verified, false);
  assert.equal(missingWidth.support.filamentLengthMm, 1);
  assert.equal(analyzeSupportPaths(gcode('G2 X5 Y5 E1 I1 J0'), base).verified, false);
  const unknown = analyzeSupportPaths('G0 X5 Y5 Z1\n;TYPE:custom mystery\n;WIDTH:0.4\nG1 X6 Y5 Z1 E1', base);
  assert.equal(unknown.verified, false);
  assert.equal(unknown.support.byRole.UNKNOWN.pathLengthMm, 1);
});

test('rejects malformed protected regions and invalid layer height', () => {
  assert.throws(() => analyzeSupportPaths('', { ...base, layerHeightMm: 0 }), /layerHeightMm/);
  assert.throws(() => analyzeSupportPaths('', { ...base, layerHeightMm: NaN }), /layerHeightMm/);
  assert.throws(() => analyzeSupportPaths('', { ...base, protectedRegions: [{ id: 'bad', boundsMm: [[0, 2, 0], [1, 1, 1]] }] }), /boundsMm/);
});
