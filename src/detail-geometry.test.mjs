import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDetail, exportDetailStl, inspectDetail } from './detail-geometry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(root, '.venv', 'Scripts', 'python.exe');
const png = (holeRadius = 17) => execFileSync(python, ['-c', [
  'import base64,cv2,numpy as np',
  'im=np.full((90,120,3),255,np.uint8)',
  'cv2.ellipse(im,(60,45),(29,34),0,0,360,(10,20,30),-1)',
  `cv2.ellipse(im,(60,45),(${holeRadius},${holeRadius+5}),0,0,360,(255,255,255),-1)`,
  'ok,b=cv2.imencode(".png",im)',
  'print(base64.b64encode(b.tobytes()).decode())',
].join(';')]).toString('utf8').trim();

function input(dataBase64 = png()) {
  return {
    image: { name: 'generated-logo.png', mime: 'image/png', dataBase64 },
    dimensions: { width: 40, depth: 30, baseThickness: 2 },
    roi: { x: 0, y: 0, width: 120, height: 90 },
    profileId: 'fdm-pla-04',
    constraints: { minFeatureWidth: 0.8, reliefHeight: 0.6, maxReliefHeight: 1.2, minFidelity: 0.5 },
  };
}

function edgeCounts(positions) {
  const counts = new Map();
  for (let i = 0; i < positions.length; i += 9) {
    const vertices = [0, 3, 6].map((offset) => positions.slice(i + offset, i + offset + 3).map(v => Number(v.toFixed(6)).toFixed(6)).join(','));
    for (let edge = 0; edge < 3; edge++) {
      const key = [vertices[edge], vertices[(edge + 1) % 3]].sort().join('|');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function stlPositions(stl) {
  const positions = [];
  for (let offset = 84; offset < stl.length; offset += 50) {
    for (let vertex = 0; vertex < 3; vertex++) {
      for (let axis = 0; axis < 3; axis++) positions.push(stl.readFloatLE(offset + 12 + vertex * 12 + axis * 4));
    }
  }
  return positions;
}

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[i + axis]);
      max[axis] = Math.max(max[axis], positions[i + axis]);
    }
  }
  return { min, max };
}

function insideMesh(point, positions) {
  const directions = [[1, 0.371, 0.217], [0.579, 1, 0.327], [0.239, 0.431, 1]];
  const insideVotes = directions.map(direction => {
    let hits = 0;
    for (let i = 0; i < positions.length; i += 9) {
      const a = positions.slice(i, i + 3);
      const b = positions.slice(i + 3, i + 6);
      const c = positions.slice(i + 6, i + 9);
      const e1 = b.map((v, k) => v - a[k]);
      const e2 = c.map((v, k) => v - a[k]);
      const h = [direction[1] * e2[2] - direction[2] * e2[1], direction[2] * e2[0] - direction[0] * e2[2], direction[0] * e2[1] - direction[1] * e2[0]];
      const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-10) continue;
      const inverse = 1 / det;
      const s = point.map((v, k) => v - a[k]);
      const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) * inverse;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) * inverse;
      if (v < -1e-9 || u + v > 1 + 1e-9) continue;
      const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inverse;
      if (t > 1e-8) hits++;
    }
    return hits % 2;
  });
  return insideVotes.reduce((sum, vote) => sum + vote, 0) >= 2;
}

test('inspectDetail extracts the generated logo and reports physical bounds and fidelity', async () => {
  const result = await inspectDetail(input());
  assert.ok(result.detail.fidelity >= input().constraints.minFidelity);
  assert.equal(result.detail.minWidthMm, input().constraints.minFeatureWidth);
  assert.equal(result.detail.minWidthIsTarget, true, 'width is a morphology target, not a measured minimum');
  assert.deepEqual(result.detail.featureBoundsMm.length, 4);
  assert.ok(result.detail.targetMask.dataBase64.length > 0);
  assert.ok(result.detail.enhancedMask.dataBase64.length > 0);
});

test('baseline stays a closed flat plate and enhanced build adds a closed real relief', async () => {
  const spec = input();
  const baseline = await buildDetail(spec, { enhance: false });
  const enhanced = await buildDetail(spec, { enhance: true });
  assert.equal(baseline.metrics.baselineVolumeMm3, 2400);
  assert.ok(enhanced.metrics.volumeMm3 > baseline.metrics.volumeMm3);
  assert.ok(enhanced.metrics.reliefVolumeMm3 > 0);
  assert.equal(enhanced.detail.baseZ, 2);
  assert.equal(insideMesh([0, 0, 1], baseline.mesh.positions), true, 'baseline contains only the solid plaque');
  assert.equal(insideMesh([0, 0, 2.3], baseline.mesh.positions), false, 'baseline has no image relief');
  assert.equal(insideMesh([0, 0, 2.3], enhanced.mesh.positions), false, 'the glyph counter remains a flat plaque area');
  assert.equal(insideMesh([8, 0, 2.3], enhanced.mesh.positions), true, 'the glyph stroke occupies real raised volume');
  const baselineBounds = bounds(baseline.mesh.positions);
  const enhancedBounds = bounds(enhanced.mesh.positions);
  for (let axis = 0; axis < 3; axis++) {
    const expectedMin = [-20, -15, 0][axis];
    const expectedMaxBase = [20, 15, 2][axis];
    const expectedMaxRelief = [20, 15, 2.6][axis];
    assert.ok(Math.abs(baselineBounds.min[axis] - expectedMin) < 0.001);
    assert.ok(Math.abs(baselineBounds.max[axis] - expectedMaxBase) < 0.002);
    assert.ok(Math.abs(enhancedBounds.min[axis] - expectedMin) < 0.001);
    assert.ok(Math.abs(enhancedBounds.max[axis] - expectedMaxRelief) < 0.002);
  }
  assert.equal(enhanced.checks.find(c => c.name === 'raised-relief')?.status, 'pass');
  assert.deepEqual([...edgeCounts(baseline.mesh.positions).values()].filter(count => count !== 2), []);
  assert.deepEqual([...edgeCounts(enhanced.mesh.positions).values()].filter(count => count !== 2), []);
  assert.match(enhanced.stlPath, new RegExp(enhanced.candidateId));
  const stl = await exportDetailStl(spec, { enhance: true });
  assert.ok(Buffer.isBuffer(stl));
  assert.equal(stl.length, 84 + stl.readUInt32LE(80) * 50);
  const exportedPositions = stlPositions(stl);
  assert.deepEqual([...edgeCounts(exportedPositions).values()].filter(count => count !== 2), []);
  const exportedBounds = bounds(exportedPositions);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(exportedBounds.min[axis] - enhancedBounds.min[axis]) < 0.001);
    assert.ok(Math.abs(exportedBounds.max[axis] - enhancedBounds.max[axis]) < 0.001);
  }
});

test('rejects invalid dimensions and marks low-fidelity detail as failed', async () => {
  const invalid = input();
  invalid.dimensions.width = 0;
  await assert.rejects(() => inspectDetail(invalid), /width|尺寸|范围/i);

  const tooSmall = input(png(5));
  tooSmall.dimensions.width = 8;
  tooSmall.dimensions.depth = 6;
  tooSmall.constraints.minFeatureWidth = 3;
  tooSmall.constraints.minFidelity = 0.98;
  const result = await buildDetail(tooSmall, { enhance: true });
  assert.equal(result.checks.find(check => check.name === 'detail-fidelity')?.status, 'fail');
  assert.ok(result.warnings.some(warning => /保真|孔|合并/.test(warning)));
});

test('fails clearly when the requested minimum feature is below the mesh grid resolution', async () => {
  const coarse = input();
  coarse.dimensions.width = 180;
  coarse.dimensions.depth = 180;
  coarse.constraints.minFeatureWidth = 0.4;
  coarse.constraints.minFidelity = 0.5;
  const result = await buildDetail(coarse, { enhance: true });
  assert.equal(result.checks.find(check => check.name === 'mesh-feature-resolution')?.status, 'fail');
  assert.ok(result.warnings.some(warning => /分辨率/.test(warning)));
});
