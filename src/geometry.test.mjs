import test from 'node:test';
import assert from 'node:assert/strict';
import { generateModel, exportStl } from './geometry.mjs';

const plate = () => ({
  name: 'plate', type: 'plate',
  dimensions: { width: 100, depth: 70, height: 8, wallThickness: 3 },
  holes: [{ x: -28, y: 0, diameter: 8 }, { x: 28, y: 0, diameter: 8 }],
});

function bounds(positions) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      lo[axis] = Math.min(lo[axis], positions[i + axis]);
      hi[axis] = Math.max(hi[axis], positions[i + axis]);
    }
  }
  return { lo, hi };
}

function meshEdgeCounts(positions) {
  const counts = new Map();
  const vertex = (offset) => positions.slice(offset, offset + 3).map(v => v.toFixed(6)).join(',');
  for (let i = 0; i < positions.length; i += 9) {
    const vertices = [vertex(i), vertex(i + 3), vertex(i + 6)];
    for (let edge = 0; edge < 3; edge++) {
      const key = [vertices[edge], vertices[(edge + 1) % 3]].sort().join('|');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function insideMesh(point, positions) {
  // Majority vote across independent Moller-Trumbore rays avoids edge hits.
  const directions = [[1, 0.371, 0.217], [0.579, 1, 0.327], [0.239, 0.431, 1]];
  const hitCounts = directions.map((direction) => {
    let hits = 0;
    for (let i = 0; i < positions.length; i += 9) {
      const a = [positions[i], positions[i + 1], positions[i + 2]];
      const b = [positions[i + 3], positions[i + 4], positions[i + 5]];
      const c = [positions[i + 6], positions[i + 7], positions[i + 8]];
      const e1 = b.map((v, k) => v - a[k]);
      const e2 = c.map((v, k) => v - a[k]);
      const h = [direction[1] * e2[2] - direction[2] * e2[1], direction[2] * e2[0] - direction[0] * e2[2], direction[0] * e2[1] - direction[1] * e2[0]];
      const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-10) continue;
      const inv = 1 / det;
      const s = point.map((v, k) => v - a[k]);
      const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) * inv;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) * inv;
      if (v < -1e-9 || u + v > 1 + 1e-9) continue;
      const distance = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
      if (distance > 1e-8) hits++;
    }
    return hits % 2;
  });
  return hitCounts.reduce((sum, value) => sum + value, 0) >= 2;
}

test('rejects non-finite and non-numeric dimensions and holes', () => {
  for (const value of [NaN, Infinity, '80']) {
    const spec = plate();
    spec.dimensions.width = value;
    assert.throws(() => generateModel(spec), /有限|数字|正数|尺寸/i);
  }
  const spec = plate();
  spec.holes[0].x = '0';
  assert.throws(() => generateModel(spec), /有限|数字|正数|孔/i);
});

test('enforces dimension limits and rejects holes outside or overlapping', () => {
  const tooWide = plate();
  tooWide.dimensions.width = 501;
  assert.throws(() => generateModel(tooWide), /500|上限/i);

  const outside = plate();
  outside.holes[0].x = 50;
  assert.throws(() => generateModel(outside), /边界|越界/i);

  const overlap = plate();
  overlap.holes = [{ x: 0, y: 0, diameter: 10 }, { x: 8, y: 0, diameter: 10 }];
  assert.throws(() => generateModel(overlap), /重叠|孔/i);

  const tooMany = plate();
  tooMany.holes = Array.from({ length: 17 }, (_, i) => ({ x: i * 5 - 40, y: 25, diameter: 2 }));
  assert.throws(() => generateModel(tooMany), /16|孔数量/i);
});

test('rejects degenerate box cavities, tangent holes, and holes entering box or bracket walls', () => {
  const invalidBox = { type: 'box', dimensions: { width: 40, depth: 30, height: 20, wallThickness: 16 }, holes: [] };
  assert.throws(() => generateModel(invalidBox), /wallThickness|空腔|尺寸/i);

  const tangent = plate();
  tangent.holes = [{ x: 46, y: 0, diameter: 8 }];
  assert.throws(() => generateModel(tangent), /边界|相切/i);

  const boxHole = { type: 'box', dimensions: { width: 80, depth: 60, height: 40, wallThickness: 4 }, holes: [{ x: 35, y: 0, diameter: 6 }] };
  assert.throws(() => generateModel(boxHole), /侧壁|孔/i);

  const bracketHole = { type: 'bracket', dimensions: { width: 50, depth: 30, height: 40, wallThickness: 4 }, holes: [{ x: 0, y: 10, diameter: 4 }] };
  assert.throws(() => generateModel(bracketHole), /竖板|背墙|孔/i);
});

test('plate material saving preserves real material around every hole and outer frame', () => {
  const spec = plate();
  const base = generateModel(spec);
  const light = generateModel(spec, { lightweight: true, minWall: 2, preserveMargin: 4 });
  assert.ok(light.metrics.volumeMm3 < base.metrics.volumeMm3);
  assert.equal(light.metrics.originalVolumeMm3, base.metrics.volumeMm3);
  const lightBounds = bounds(light.mesh.positions);
  const baselineBounds = bounds(light.baselineMesh.positions);
  const baseBounds = bounds(base.mesh.positions);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(lightBounds.lo[axis] - baseBounds.lo[axis]) < 1e-3);
    assert.ok(Math.abs(lightBounds.hi[axis] - baseBounds.hi[axis]) < 1e-3);
    assert.ok(Math.abs(baselineBounds.lo[axis] - baseBounds.lo[axis]) < 1e-3);
    assert.ok(Math.abs(baselineBounds.hi[axis] - baseBounds.hi[axis]) < 1e-3);
  }
  assert.ok(insideMesh([48, 0, 4], light.mesh.positions), 'the exterior frame remains solid');
  for (const hole of spec.holes) {
    const radius = hole.diameter / 2 + 3.9;
    assert.equal(insideMesh([hole.x, hole.y, 4], light.mesh.positions), false, 'the original through hole remains open');
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
      const point = [hole.x + radius * Math.cos(angle), hole.y + radius * Math.sin(angle), 4];
      assert.equal(insideMesh(point, light.mesh.positions), true,
        `preserveMargin ring should contain real material at ${point}`);
    }
  }
  assert.equal(light.checks.find(c => c.name === 'hole-clearance')?.status, 'pass');
  assert.ok(light.metrics.estimatedMassG > 0 && light.metrics.baselineMassG > light.metrics.estimatedMassG);
  assert.equal(light.metrics.densityGPerCm3, 1.24);
});

test('lightweight plate triangulation has a closed two-face edge incidence everywhere', () => {
  const spec = { type: 'plate', dimensions: { width: 80, depth: 60, height: 6, wallThickness: 3 }, holes: [{ x: -25, y: 0, diameter: 6 }, { x: 25, y: 0, diameter: 6 }] };
  const result = generateModel(spec, { lightweight: true });
  const counts = meshEdgeCounts(result.mesh.positions);
  const open = [...counts.values()].filter(count => count === 1).length;
  const overused = [...counts.values()].filter(count => count !== 2).length;
  assert.equal(open, 0, 'every mesh edge should have two incident triangles');
  assert.equal(overused, 0, 'mesh should have no boundary or non-manifold edges');
});

test('box optimization keeps its original bottom thickness and exterior dimensions', () => {
  const spec = { name: 'box', type: 'box', dimensions: { width: 80, depth: 60, height: 40, wallThickness: 4 }, holes: [] };
  const base = generateModel(spec);
  const light = generateModel(spec, { lightweight: true, minWall: 2 });
  assert.deepEqual(bounds(light.mesh.positions), bounds(base.mesh.positions));
  assert.ok(light.metrics.volumeMm3 < base.metrics.volumeMm3);
  assert.ok(insideMesh([0, 0, 3.9], light.mesh.positions), 'the bottom must remain solid through its original thickness');
  assert.equal(insideMesh([0, 0, 4.1], light.mesh.positions), false, 'the cavity starts above the original bottom thickness');
  assert.equal(insideMesh([0, 0, 30], light.mesh.positions), false, 'the box must remain open at the top');
});

test('box cavity overcut extends only above the top and does not cut into the specified bottom', () => {
  const spec = { type: 'box', dimensions: { width: 60, depth: 40, height: 25, wallThickness: 2 }, holes: [] };
  for (const options of [{ lightweight: false }, { lightweight: true, minWall: 1.2 }]) {
    const model = generateModel(spec, options);
    assert.equal(insideMesh([.37, .33, 1.9995], model.mesh.positions), true);
    assert.equal(insideMesh([.37, .33, 2.001], model.mesh.positions), false);
  }
});

test('bracket reports unsupported material saving, while keeping the baseline mesh usable', () => {
  const spec = { name: 'bracket', type: 'bracket', dimensions: { width: 50, depth: 30, height: 40, wallThickness: 4 }, holes: [] };
  const result = generateModel(spec, { lightweight: true });
  assert.equal(result.metrics.volumeMm3, result.metrics.originalVolumeMm3);
  assert.deepEqual(result.mesh.positions, result.baselineMesh.positions);
  assert.ok(result.warnings.some(w => /bracket|支架|不支持/i.test(w)));
});

test('exports binary STL whose triangle bounds match the model', () => {
  const spec = plate();
  const model = generateModel(spec, { lightweight: true });
  const stl = exportStl(spec, { lightweight: true });
  assert.ok(Buffer.isBuffer(stl));
  assert.equal(stl.length, 84 + stl.readUInt32LE(80) * 50);
  assert.ok(stl.readUInt32LE(80) > 0);
  const stlPositions = [];
  for (let i = 84; i < stl.length; i += 50) {
    for (let j = 12; j < 48; j += 4) stlPositions.push(stl.readFloatLE(i + j));
  }
  const actual = bounds(stlPositions);
  const expected = bounds(model.mesh.positions);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(actual.lo[axis] - expected.lo[axis]) < 0.001);
    assert.ok(Math.abs(actual.hi[axis] - expected.hi[axis]) < 0.001);
  }
  const edgeCounts = meshEdgeCounts(stlPositions);
  assert.ok([...edgeCounts.values()].every(count => count === 2), 'exported STL facets should also form a closed mesh');
});

test('bbox checks pass for each supported model type within 1e-3 mm mesh tolerance', () => {
  const specs = [
    plate(),
    { type: 'bracket', dimensions: { width: 50, depth: 30, height: 40, wallThickness: 4 }, holes: [] },
    { type: 'box', dimensions: { width: 80, depth: 60, height: 40, wallThickness: 4 }, holes: [] },
  ];
  for (const spec of specs) {
    for (const options of [{}, { lightweight: true }]) {
      const result = generateModel(spec, options);
      assert.equal(result.checks.find(check => check.name === 'exterior-bounds')?.status, 'pass', spec.type);
    }
  }
});
