import modeling from '@jscad/modeling';
import stlSerializer from '@jscad/stl-serializer';

const { primitives, booleans, transforms, measurements, modifiers, geometries } = modeling;
const { cuboid, cylinder, rectangle, circle } = primitives;
const { subtract, union } = booleans;
const { translate } = transforms;
const { extrudeLinear } = modeling.extrusions;

const DEFAULTS = Object.freeze({ lightweight: false, minWall: 2, preserveMargin: 3, densityGPerCm3: 1.24 });

function finitePositive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label}必须是有限正数`);
  }
  return value;
}

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || !['plate', 'bracket', 'box'].includes(spec.type)) {
    throw new TypeError('type必须为plate、bracket或box');
  }
  const d = spec.dimensions;
  if (!d || typeof d !== 'object') throw new TypeError('缺少dimensions尺寸');
  const width = finitePositive(d.width, 'width尺寸');
  const depth = finitePositive(d.depth, 'depth尺寸');
  const height = finitePositive(d.height, 'height尺寸');
  const wall = finitePositive(d.wallThickness, 'wallThickness尺寸');
  if (width > 500 || depth > 500 || height > 500) throw new RangeError('width、depth、height尺寸上限为500mm');
  if (wall < 1) throw new RangeError('wallThickness不得小于1mm');
  if (spec.type === 'box' && (2 * wall >= width || 2 * wall >= depth || wall >= height)) {
    throw new RangeError('box的wallThickness必须让空腔宽、深、高均为正数');
  }
  if (spec.type === 'bracket' && wall >= Math.min(width, depth, height)) {
    throw new RangeError('wallThickness必须小于相关外部尺寸');
  }
  const holes = spec.holes ?? [];
  if (!Array.isArray(holes) || holes.length > 16) throw new RangeError('孔数量最多16个');
  const normalizedHoles = holes.map((hole, index) => {
    const x = hole?.x;
    const y = hole?.y;
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
      throw new TypeError(`孔${index + 1}坐标必须是有限数字`);
    }
    const diameter = finitePositive(hole?.diameter, `孔${index + 1}直径`);
    const radius = diameter / 2;
    if (Math.abs(x) + radius >= width / 2 || Math.abs(y) + radius >= depth / 2) {
      throw new RangeError(`孔${index + 1}超出或相切于模型边界`);
    }
    if (spec.type === 'box' && (Math.abs(x) + radius >= width / 2 - wall || Math.abs(y) + radius >= depth / 2 - wall)) {
      throw new RangeError(`孔${index + 1}侵入box侧壁`);
    }
    if (spec.type === 'bracket' && y + radius >= depth / 2 - wall) {
      throw new RangeError(`孔${index + 1}侵入bracket背墙竖板`);
    }
    return { x, y, diameter, radius };
  });
  for (let i = 0; i < normalizedHoles.length; i++) {
    for (let j = i + 1; j < normalizedHoles.length; j++) {
      const a = normalizedHoles[i];
      const b = normalizedHoles[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) <= a.radius + b.radius + 1e-9) {
        throw new RangeError(`孔${i + 1}与孔${j + 1}重叠`);
      }
    }
  }
  if (spec.type === 'plate' && normalizedHoles.length && height <= 0) throw new RangeError('板厚无效');
  return { width, depth, height, wall, holes: normalizedHoles };
}

function validateOptions(options) {
  if (options == null) options = {};
  if (typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options必须是对象');
  const result = { ...DEFAULTS, ...options };
  if (typeof result.lightweight !== 'boolean') throw new TypeError('lightweight必须是布尔值');
  result.minWall = finitePositive(result.minWall, 'minWall');
  if (typeof result.preserveMargin !== 'number' || !Number.isFinite(result.preserveMargin) || result.preserveMargin < 0) {
    throw new TypeError('preserveMargin必须是有限非负数');
  }
  result.densityGPerCm3 = finitePositive(result.densityGPerCm3, 'densityGPerCm3');
  return result;
}

const centeredCuboid = (x, y, z, width, depth, height) => translate([x, y, z], cuboid({ size: [width, depth, height] }));

function subtractHoles(solid, holes, zCenter, zDepth) {
  if (!holes.length) return solid;
  const cutters = holes.map(({ x, y, radius }) => translate([x, y, zCenter], cylinder({ radius, height: zDepth, segments: 48 })));
  return subtract(solid, ...cutters);
}

function makeBase(type, d) {
  if (type === 'plate') {
    return centeredCuboid(0, 0, d.height / 2, d.width, d.depth, d.height);
  }
  if (type === 'bracket') {
    const base = centeredCuboid(0, 0, d.wall / 2, d.width, d.depth, d.wall);
    const upright = centeredCuboid(0, d.depth / 2 - d.wall / 2, d.height / 2, d.width, d.wall, d.height);
    return union(base, upright);
  }
  const outer = centeredCuboid(0, 0, d.height / 2, d.width, d.depth, d.height);
  const innerWidth = d.width - 2 * d.wall;
  const innerDepth = d.depth - 2 * d.wall;
  const innerHeight = d.height - d.wall;
  const cavity = centeredCuboid(0, 0, d.wall + (innerHeight + 0.002) / 2, innerWidth, innerDepth, innerHeight + 0.002);
  return subtract(outer, cavity);
}

function perforatePlate(d, holes, options) {
  const { width, depth, height, wall } = d;
  const frame = Math.max(wall, options.minWall);
  const availableArea = Math.max(0, (width - 2 * frame) * (depth - 2 * frame));
  const pitch = Math.max(12, options.minWall * 3, Math.sqrt(availableArea / 350) * 1.1);
  const slot = pitch - options.minWall;
  const section = rectangle({ size: [width, depth] });
  const cutters = [];
  for (const hole of holes) cutters.push(translate([hole.x, hole.y], circle({ radius: hole.radius, segments: 48 })));
  if (slot <= 0 || width <= 2 * frame || depth <= 2 * frame) {
    return extrudeLinear({ height }, subtract(section, ...cutters));
  }
  const startX = -width / 2 + frame + pitch / 2;
  const endX = width / 2 - frame - pitch / 2;
  const startY = -depth / 2 + frame + pitch / 2;
  const endY = depth / 2 - frame - pitch / 2;
  const columns = Math.floor((endX - startX) / pitch) + 1;
  const rows = Math.floor((endY - startY) / pitch) + 1;
  if (columns <= 0 || rows <= 0) return extrudeLinear({ height }, subtract(section, ...cutters));
  if (columns * rows > 450) throw new RangeError('省料网格超过安全开孔数量，请增大minWall');
  for (let row = 0; row < rows; row++) {
    const y = startY + row * pitch;
    for (let column = 0; column < columns; column++) {
      const x = startX + column * pitch;
      const half = slot / 2;
      const nearHole = holes.some((hole) => {
        const dx = Math.max(Math.abs(hole.x - x) - half, 0);
        const dy = Math.max(Math.abs(hole.y - y) - half, 0);
        return Math.hypot(dx, dy) < hole.radius + options.preserveMargin - 1e-9;
      });
      if (!nearHole) cutters.push(translate([x, y], rectangle({ size: [slot, slot] })));
    }
  }
  return extrudeLinear({ height }, subtract(section, ...cutters));
}

function triangulatedPositions(solid) {
  const triangles = modifiers.generalize({ snap: true, triangulate: true }, solid);
  const positions = [];
  for (const polygon of geometries.geom3.toPolygons(triangles)) {
    for (let i = 1; i < polygon.vertices.length - 1; i++) {
      positions.push(...polygon.vertices[0], ...polygon.vertices[i], ...polygon.vertices[i + 1]);
    }
  }
  return positions;
}

function meshFor(solid) {
  return { positions: triangulatedPositions(solid) };
}

function meshBounds(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], mesh.positions[i + axis]);
      max[axis] = Math.max(max[axis], mesh.positions[i + axis]);
    }
  }
  return { min, max };
}

function modelInternal(spec, options) {
  const d = validateSpec(spec);
  const o = validateOptions(options);
  const base = makeBase(spec.type, d);
  const holeZ = spec.type === 'plate' ? d.height / 2 : d.wall / 2;
  const holeDepth = spec.type === 'plate' ? d.height + 0.002 : d.wall + 0.002;
  const baseline = subtractHoles(base, d.holes, holeZ, holeDepth);
  let model = baseline;
  const warnings = [];
  if (o.lightweight) {
    if (spec.type === 'plate') model = perforatePlate(d, d.holes, o);
    else if (spec.type === 'box') {
      if (o.minWall >= d.wall) {
        warnings.push('box现有侧壁厚度不大于minWall，无法在该限制下减薄');
      } else {
        const outer = centeredCuboid(0, 0, d.height / 2, d.width, d.depth, d.height);
        const innerWidth = d.width - 2 * o.minWall;
        const innerDepth = d.depth - 2 * o.minWall;
        const innerHeight = d.height - d.wall;
        const cavity = centeredCuboid(0, 0, d.wall + (innerHeight + 0.002) / 2, innerWidth, innerDepth, innerHeight + 0.002);
        model = subtract(outer, cavity);
        model = subtractHoles(model, d.holes, holeZ, holeDepth);
      }
    } else {
      warnings.push('bracket省料暂不支持，返回原始几何体');
    }
  }
  const baselineVolume = Math.abs(measurements.measureVolume(baseline));
  const volume = Math.abs(measurements.measureVolume(model));
  if (o.lightweight && spec.type === 'plate' && volume >= baselineVolume - 1e-7) {
    warnings.push('当前plate尺寸与保留条件下没有可开设的省料网格孔');
  }
  const density = o.densityGPerCm3;
  const mesh = meshFor(model);
  const baselineMesh = meshFor(baseline);
  const bounds = meshBounds(mesh);
  const expectedBounds = [[-d.width / 2, -d.depth / 2, 0], [d.width / 2, d.depth / 2, d.height]];
  const exteriorPreserved = bounds.min.every((value, axis) => Math.abs(value - expectedBounds[0][axis]) <= 1e-3) &&
    bounds.max.every((value, axis) => Math.abs(value - expectedBounds[1][axis]) <= 1e-3);
  const checks = [
    { name: 'input-dimensions', status: 'pass', detail: '尺寸为有限正数并满足几何构造的尺寸范围' },
    { name: 'hole-geometry', status: 'pass', detail: '孔不超界、不相切或重叠，也不穿入指定侧壁' },
    { name: 'hole-clearance', status: 'pass', detail: '省料矩形切口的XY范围避开孔边及保留余量' },
    { name: 'exterior-bounds', status: exteriorPreserved ? 'pass' : 'fail', detail: exteriorPreserved ? '三角网格边界匹配请求的width、depth、height' : '三角网格外边界与请求尺寸不一致' },
  ];
  return {
    solid: model,
    result: {
      spec,
      mesh,
      baselineMesh,
      metrics: {
        originalVolumeMm3: baselineVolume,
        volumeMm3: volume,
        savedPercent: baselineVolume === 0 ? 0 : (baselineVolume - volume) / baselineVolume * 100,
        estimatedMassG: volume / 1000 * density,
        baselineMassG: baselineVolume / 1000 * density,
        densityGPerCm3: density,
      },
      checks,
      warnings,
    },
  };
}

export function generateModel(spec, options = {}) {
  return modelInternal(spec, options).result;
}

export function exportStl(spec, options = {}) {
  const { solid } = modelInternal(spec, options);
  const parts = stlSerializer.serialize({ binary: true }, solid);
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}
