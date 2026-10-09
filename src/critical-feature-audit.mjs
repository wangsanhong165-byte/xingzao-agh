import { parseGcodeSegments } from './slicer.mjs';

const MAX_FEATURES = 4;
const MAX_GRID_CELLS = 32768;
const MAX_INDEX_ENTRIES = 2_000_000;
const CELL_MM = [1, 1, 0.2];
const EPS = 1e-7;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = (code, message) => ({ code, message });
const keyOf = (x, y, z) => `${x},${y},${z}`;

function validBounds(bounds) {
  return Array.isArray(bounds) && bounds.length === 2 && bounds.every(row => Array.isArray(row) && row.length === 3 && row.every(finite)) &&
    bounds[0].every((v, axis) => bounds[1][axis] > v);
}

function decodeMask(encoded, count) {
  if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== count || bytes.toString('base64') !== encoded) return null;
  for (const value of bytes) if (value !== 0 && value !== 1) return null;
  return bytes;
}

function decodeBitfield(encoded, count, maximum) {
  if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== count || bytes.toString('base64') !== encoded || bytes.some(value => value > maximum)) return null;
  return new Uint8Array(bytes);
}

function positiveNeighbor(index, axis, dims) {
  const coordinates = [index % dims[0], Math.floor(index / dims[0]) % dims[1], Math.floor(index / (dims[0] * dims[1]))];
  if (coordinates[axis] + 1 >= dims[axis]) return null;
  return index + (axis === 0 ? 1 : axis === 1 ? dims[0] : dims[0] * dims[1]);
}

function voxelOnFace(index, dims, direction) {
  const axis = Math.floor(direction / 2);
  const coordinate = axis === 0 ? index % dims[0] : axis === 1 ? Math.floor(index / dims[0]) % dims[1] : Math.floor(index / (dims[0] * dims[1]));
  return coordinate === (direction % 2 === 0 ? 0 : dims[axis] - 1);
}

function validateRigidMatrix(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every(finite)) return false;
  if (Math.abs(matrix[12]) > 1e-5 || Math.abs(matrix[13]) > 1e-5 || Math.abs(matrix[14]) > 1e-5 || Math.abs(matrix[15] - 1) > 1e-5) return false;
  const columns = [[matrix[0], matrix[4], matrix[8]], [matrix[1], matrix[5], matrix[9]], [matrix[2], matrix[6], matrix[10]]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const dot = columns[i].reduce((sum, v, k) => sum + v * columns[j][k], 0);
    if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-4) return false;
  }
  const [a, b, c] = columns;
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
  return Math.abs(det - 1) <= 1e-4;
}

function transformPoint(point, matrix, offset) {
  return {
    x: matrix[0] * point.x + matrix[1] * point.y + matrix[2] * point.z + matrix[3] + offset.x,
    y: matrix[4] * point.x + matrix[5] * point.y + matrix[6] * point.z + matrix[7] + offset.y,
    z: matrix[8] * point.x + matrix[9] * point.y + matrix[10] * point.z + matrix[11] + offset.z,
  };
}

function validateProbeSet(probes) {
  if (!probes || probes.schema !== 'source-feature-probes/v1' || !/^[a-f0-9]{64}$/.test(probes.sourceSha256 ?? '') || !validBounds(probes.sourceBoundsMm)) return fail('INVALID_PROBES', 'Probe schema, source hash, or source bounds are invalid.');
  if (!Array.isArray(probes.features) || probes.features.length < 1 || probes.features.length > MAX_FEATURES) return fail('INVALID_PROBES', 'One to four source features are required.');
  const ids = new Set();
  const parsed = [];
  for (const feature of probes.features) {
    if (!feature || typeof feature.id !== 'string' || !feature.id || ids.has(feature.id) || !['solid', 'void-channel'].includes(feature.kind) || !validBounds(feature.boundsMm) || !Array.isArray(feature.grid?.dimensions) || !Array.isArray(feature.grid?.stepMm)) return fail('INVALID_PROBES', 'Feature identity, kind, bounds, or grid is invalid.');
    ids.add(feature.id);
    const dims = feature.grid.dimensions;
    const step = feature.grid.stepMm;
    if (dims.length !== 3 || step.length !== 3 || dims.some(n => !Number.isInteger(n) || n < 4 || n > 32) || step.some(v => !finite(v) || v <= 0) || dims[0] * dims[1] * dims[2] > MAX_GRID_CELLS || feature.grid.order !== 'x-fastest' || feature.grid.cellCenters !== true) return fail('INVALID_PROBES', 'Grid dimensions, step, ordering, or center convention is invalid.');
    if (feature.boundsMm[0].some((v, axis) => Math.abs(feature.boundsMm[1][axis] - v - dims[axis] * step[axis]) > Math.max(1e-5, step[axis] * 1e-5)) || feature.boundsMm[0].some((v, axis) => v < probes.sourceBoundsMm[0][axis] - 1e-5 || feature.boundsMm[1][axis] > probes.sourceBoundsMm[1][axis] + 1e-5)) return fail('INVALID_PROBES', 'Grid extent must match and fit within declared bounds.');
    const count = dims[0] * dims[1] * dims[2];
    if (feature.sampleCount !== count || !Number.isInteger(feature.solidSampleCount) || !Number.isInteger(feature.surfaceSampleCount) || !finite(feature.minRetention) || feature.minRetention < 0.5 || feature.minRetention > 1) return fail('INVALID_PROBES', 'Sample counts or retention threshold are invalid.');
    const surfaceToleranceMm = feature.surfaceToleranceMm === undefined ? 0.05 : feature.surfaceToleranceMm;
    if (!finite(surfaceToleranceMm) || surfaceToleranceMm < 0 || surfaceToleranceMm > 0.1) return fail('INVALID_PROBES', 'Surface tolerance must be finite and between 0 and 0.1 mm.');
    if (feature.kind === 'void-channel' && !['x', 'y', 'z'].includes(feature.axis)) return fail('INVALID_PROBES', 'A void channel must declare its axis.');
    const solid = decodeMask(feature.solidMaskBase64, count);
    const surface = decodeMask(feature.surfaceMaskBase64, count);
    if (!solid || !surface || solid.reduce((a, b) => a + b, 0) !== feature.solidSampleCount || surface.reduce((a, b) => a + b, 0) !== feature.surfaceSampleCount || surface.some((value, i) => value > solid[i])) return fail('INVALID_PROBES', 'Mask encoding, size, values, or declared counts are invalid.');
    let surfacePoints = null;
    let surfacePointVoxelIndices = null;
    let surfacePointDirections = null;
    let surfaceExposure = null;
    if (feature.kind === 'solid') {
      const encodedFields = [feature.surfacePointsBase64, feature.surfacePointVoxelIndicesBase64, feature.surfacePointDirectionsBase64, feature.surfaceExposureMaskBase64];
      if (encodedFields.some(encoded => typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))) return fail('INVALID_PROBES', 'Solid features require canonical directional surface-point payloads.');
      const pointCount = feature.surfacePointCount;
      if (!Number.isInteger(pointCount) || pointCount < 0 || pointCount > count * 6) return fail('INVALID_PROBES', 'Solid surface point count must be between zero and six per voxel.');
      const pointBytes = Buffer.from(feature.surfacePointsBase64, 'base64');
      const indexBytes = Buffer.from(feature.surfacePointVoxelIndicesBase64, 'base64');
      const directionBytes = Buffer.from(feature.surfacePointDirectionsBase64, 'base64');
      const exposureBytes = Buffer.from(feature.surfaceExposureMaskBase64, 'base64');
      if (pointBytes.length !== pointCount * 24 || pointBytes.toString('base64') !== feature.surfacePointsBase64 || indexBytes.length !== pointCount * 4 || indexBytes.toString('base64') !== feature.surfacePointVoxelIndicesBase64 || directionBytes.length !== pointCount || exposureBytes.length !== count || exposureBytes.toString('base64') !== feature.surfaceExposureMaskBase64) return fail('INVALID_PROBES', 'Directional surface payload lengths must match their declared counts.');
      surfacePoints = new Float64Array(pointCount * 3);
      for (let i = 0; i < pointCount * 3; i++) if (!finite(surfacePoints[i] = pointBytes.readDoubleLE(i * 8))) return fail('INVALID_PROBES', 'Surface-point coordinates must be finite.');
      surfacePointVoxelIndices = new Uint32Array(pointCount);
      surfacePointDirections = new Uint8Array(pointCount);
      surfaceExposure = new Uint8Array(exposureBytes);
      const recorded = new Uint8Array(count);
      const countsByDirection = new Uint8Array(count * 6);
      for (let p = 0; p < pointCount; p++) {
        const voxel = indexBytes.readUInt32LE(p * 4);
        const direction = directionBytes[p];
        if (voxel >= count || direction > 5) return fail('INVALID_PROBES', 'Surface-point voxel index or direction is invalid.');
        const bit = 1 << direction;
        if (!(surfaceExposure[voxel] & bit) || countsByDirection[voxel * 6 + direction] !== 0) return fail('INVALID_PROBES', 'Surface point records must match unique declared exposure bits.');
        countsByDirection[voxel * 6 + direction] = 1;
        recorded[voxel] |= bit;
        for (let axis = 0; axis < 3; axis++) {
          const coordinate = surfacePoints[p * 3 + axis];
          if (coordinate < feature.boundsMm[0][axis] - 1e-7 || coordinate > feature.boundsMm[1][axis] + 1e-7) return fail('INVALID_PROBES', 'Target surface points must lie inside declared feature bounds.');
        }
        surfacePointVoxelIndices[p] = voxel;
        surfacePointDirections[p] = direction;
      }
      if (surfaceExposure.some((mask, i) => mask > 63 || mask !== recorded[i] || (mask !== 0) !== (surface[i] === 1) || (mask !== 0 && !solid[i]))) return fail('INVALID_PROBES', 'Exposure masks, surface mask, and point records must agree exactly.');
    }
    let voidEdges = null;
    let voidBoundaries = null;
    if (feature.kind === 'void-channel') {
      voidEdges = decodeBitfield(feature.voidEdgeMaskBase64, count, 7);
      voidBoundaries = decodeBitfield(feature.voidBoundaryMaskBase64, count, 63);
      if (!voidEdges || !voidBoundaries) return fail('INVALID_PROBES', 'Void channels require exact source edge and boundary connector masks.');
      for (let i = 0; i < count; i++) {
        if ((voidEdges[i] || voidBoundaries[i]) && solid[i] !== 0) return fail('INVALID_PROBES', 'Void edge and opening connectors must originate in source-free voxels.');
        for (let axis = 0; axis < 3; axis++) if (voidEdges[i] & (1 << axis)) {
          const next = positiveNeighbor(i, axis, dims);
          if (next === null || solid[next] !== 0) return fail('INVALID_PROBES', 'Void edge masks may only connect adjacent source-free voxels.');
        }
        for (let direction = 0; direction < 6; direction++) if (voidBoundaries[i] & (1 << direction)) {
          if (!voxelOnFace(i, dims, direction)) return fail('INVALID_PROBES', 'Void boundary connectors must terminate on their declared ROI face.');
        }
      }
    }
    parsed.push({ feature, dims, step, count, solid, surface, surfacePoints, surfacePointVoxelIndices, surfacePointDirections, surfaceExposure, voidEdges, voidBoundaries, surfaceToleranceMm });
  }
  return { parsed };
}

function channelTargets(parsed, axis) {
  const axisIndex = { x: 0, y: 1, z: 2 }[axis];
  const seen = new Uint8Array(parsed.count);
  let best = null;
  for (let start = 0; start < parsed.count; start++) {
    if (parsed.solid[start] !== 0 || seen[start]) continue;
    const queue = [start]; seen[start] = 1;
    let head = 0; let low = false; let high = false; let badBoundary = false;
    while (head < queue.length) {
      const current = queue[head++];
      const openings = parsed.voidBoundaries[current];
      low ||= Boolean(openings & (1 << (axisIndex * 2)));
      high ||= Boolean(openings & (1 << (axisIndex * 2 + 1)));
      for (let direction = 0; direction < 6; direction++) if (axisIndex !== Math.floor(direction / 2) && (openings & (1 << direction))) badBoundary = true;
      for (let axis = 0; axis < 3; axis++) if (parsed.voidEdges[current] & (1 << axis)) {
        const next = positiveNeighbor(current, axis, parsed.dims);
        if (!seen[next]) { seen[next] = 1; queue.push(next); }
      }
      for (let axis = 0; axis < 3; axis++) {
        const predecessor = axis === 0 ? current - 1 : axis === 1 ? current - parsed.dims[0] : current - parsed.dims[0] * parsed.dims[1];
        if (predecessor >= 0 && parsed.voidEdges[predecessor] & (1 << axis) && !seen[predecessor]) { seen[predecessor] = 1; queue.push(predecessor); }
      }
    }
    if (low && high && !badBoundary && (!best || queue.length > best.nodes.length)) best = { nodes: queue, low: queue.filter(i => parsed.voidBoundaries[i] & (1 << (axisIndex * 2))), high: queue.filter(i => parsed.voidBoundaries[i] & (1 << (axisIndex * 2 + 1))) };
  }
  return best;
}

function buildIndex(segments) {
  const index = new Map();
  let entries = 0;
  let minWidthMm = Infinity;
  let minHeightMm = Infinity;
  for (const segment of segments) {
    if (segment.motionType !== 'extrusion') continue;
    if (segment.role === 'UNKNOWN') return fail('UNKNOWN_POSITIVE_EXTRUSION', 'A positive extrusion has an unknown role.');
    if (segment.role !== 'MODEL') continue;
    if (!finite(segment.lineWidthMm) || segment.lineWidthMm <= 0 || !finite(segment.lineHeightMm) || segment.lineHeightMm <= 0) return fail('MISSING_EXTRUSION_GEOMETRY', 'MODEL extrusion is missing positive WIDTH or per-extrusion HEIGHT.');
    minWidthMm = Math.min(minWidthMm, segment.lineWidthMm);
    minHeightMm = Math.min(minHeightMm, segment.lineHeightMm);
    if (Math.abs(segment.end.z - segment.start.z) > 1e-6) return fail('NONPLANAR_MODEL_EXTRUSION', 'MODEL extrusion is not planar in Z.');
    const radius = segment.lineWidthMm / 2 + 0.1;
    // G-code coordinates already include slicer placement. Only transformed source probes receive the placement offset.
    const x0 = Math.floor((Math.min(segment.start.x, segment.end.x) - radius) / CELL_MM[0]);
    const x1 = Math.floor((Math.max(segment.start.x, segment.end.x) + radius) / CELL_MM[0]);
    const y0 = Math.floor((Math.min(segment.start.y, segment.end.y) - radius) / CELL_MM[1]);
    const y1 = Math.floor((Math.max(segment.start.y, segment.end.y) + radius) / CELL_MM[1]);
    const zTop = segment.end.z;
    const z0 = Math.floor((zTop - segment.lineHeightMm - 0.1) / CELL_MM[2]);
    const z1 = Math.floor((zTop + 0.1) / CELL_MM[2]);
    const cellCount = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (!Number.isSafeInteger(cellCount) || cellCount < 1 || entries + cellCount > MAX_INDEX_ENTRIES) return fail('RESOURCE_LIMIT', 'MODEL extrusion spatial index exceeded its two-million-entry limit.');
    entries += cellCount;
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const key = keyOf(x, y, z);
      let bucket = index.get(key);
      if (!bucket) { bucket = []; index.set(key, bucket); }
      bucket.push(segment);
    }
  }
  return { index, entries, minWidthMm, minHeightMm };
}

function samplingIsFineEnough(parsed, matrix, index) {
  if (parsed.feature.kind !== 'void-channel') return true;
  const [sx, sy, sz] = parsed.step;
  const rotation = matrix;
  const projectedZSteps = [Math.abs(rotation[8]) * sx, Math.abs(rotation[9]) * sy, Math.abs(rotation[10]) * sz];
  const projectedXSteps = [Math.abs(rotation[0]) * sx, Math.abs(rotation[1]) * sy, Math.abs(rotation[2]) * sz];
  const projectedYSteps = [Math.abs(rotation[4]) * sx, Math.abs(rotation[5]) * sy, Math.abs(rotation[6]) * sz];
  return Math.max(...projectedZSteps) <= index.minHeightMm / 2 + EPS &&
    Math.max(...projectedXSteps, ...projectedYSteps) <= index.minWidthMm / 2 + EPS;
}

function coveredByModel(point, candidateSegments, toleranceMm = 0) {
  for (const segment of candidateSegments ?? []) {
    const dx = segment.end.x - segment.start.x;
    const dy = segment.end.y - segment.start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= EPS) continue;
    const t = Math.max(0, Math.min(1, ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / lenSq));
    const px = segment.start.x + t * dx;
    const py = segment.start.y + t * dy;
    const radius = segment.lineWidthMm / 2 + toleranceMm;
    const top = segment.end.z;
    if ((point.x - px) ** 2 + (point.y - py) ** 2 <= radius ** 2 + EPS && point.z <= top + toleranceMm + EPS && point.z >= top - segment.lineHeightMm - toleranceMm - EPS) return true;
  }
  return false;
}

function pointSegmentDistanceSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq <= EPS ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
}

function segmentsIntersect2d(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const onSegment = (p, q, r) => q.x <= Math.max(p.x, r.x) + EPS && q.x >= Math.min(p.x, r.x) - EPS && q.y <= Math.max(p.y, r.y) + EPS && q.y >= Math.min(p.y, r.y) - EPS;
  const orientation = value => Math.abs(value) <= EPS ? 0 : value > 0 ? 1 : -1;
  const abC = orientation(cross(a, b, c)); const abD = orientation(cross(a, b, d)); const cdA = orientation(cross(c, d, a)); const cdB = orientation(cross(c, d, b));
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  if (abC === 0 && onSegment(a, c, b)) return true;
  if (abD === 0 && onSegment(a, d, b)) return true;
  if (cdA === 0 && onSegment(c, a, d)) return true;
  if (cdB === 0 && onSegment(c, b, d)) return true;
  return false;
}

function segmentDistanceSq2d(a, b, c, d) {
  if (segmentsIntersect2d(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistanceSq(a.x, a.y, c.x, c.y, d.x, d.y), pointSegmentDistanceSq(b.x, b.y, c.x, c.y, d.x, d.y), pointSegmentDistanceSq(c.x, c.y, a.x, a.y, b.x, b.y), pointSegmentDistanceSq(d.x, d.y, a.x, a.y, b.x, b.y));
}

function connectorBlocked(sourceA, sourceB, matrix, offset, spatialIndex, work) {
  const a = transformPoint(sourceA, matrix, offset); const b = transformPoint(sourceB, matrix, offset);
  const x0 = Math.floor(Math.min(a.x, b.x) / CELL_MM[0]); const x1 = Math.floor(Math.max(a.x, b.x) / CELL_MM[0]);
  const y0 = Math.floor(Math.min(a.y, b.y) / CELL_MM[1]); const y1 = Math.floor(Math.max(a.y, b.y) / CELL_MM[1]);
  const z0 = Math.floor(Math.min(a.z, b.z) / CELL_MM[2]); const z1 = Math.floor(Math.max(a.z, b.z) / CELL_MM[2]);
  const cellCount = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
  if (!Number.isSafeInteger(cellCount) || cellCount < 1 || work.entries + cellCount > MAX_INDEX_ENTRIES) return { resourceLimit: true };
  work.entries += cellCount;
  const candidates = new Set();
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const bucket = spatialIndex.index.get(keyOf(x, y, z));
    if (bucket) for (const segment of bucket) candidates.add(segment);
  }
  for (const segment of candidates) {
    const top = segment.end.z;
    const bottom = top - segment.lineHeightMm;
    const dz = b.z - a.z;
    let t0 = 0; let t1 = 1;
    if (Math.abs(dz) <= EPS) {
      if (a.z < bottom - EPS || a.z > top + EPS) continue;
    } else {
      const ta = (bottom - a.z) / dz; const tb = (top - a.z) / dz;
      t0 = Math.max(0, Math.min(ta, tb)); t1 = Math.min(1, Math.max(ta, tb));
      if (t0 > t1 + EPS) continue;
    }
    const clippedA = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
    const clippedB = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
    const modelA = segment.start; const modelB = segment.end;
    if (segmentDistanceSq2d(clippedA, clippedB, modelA, modelB) <= (segment.lineWidthMm / 2) ** 2 + EPS) return { blocked: true };
  }
  return { blocked: false };
}

const FACE_DIRECTIONS = ['-X', '+X', '-Y', '+Y', '-Z', '+Z'];

function sourceCenter(index, parsed) {
  const [nx, ny] = parsed.dims;
  const x = index % nx; const y = Math.floor(index / nx) % ny; const z = Math.floor(index / (nx * ny));
  return { x: parsed.feature.boundsMm[0][0] + (x + 0.5) * parsed.step[0], y: parsed.feature.boundsMm[0][1] + (y + 0.5) * parsed.step[1], z: parsed.feature.boundsMm[0][2] + (z + 0.5) * parsed.step[2] };
}

function faceConnector(index, direction, parsed) {
  const start = sourceCenter(index, parsed); const end = { ...start };
  const axis = Math.floor(direction / 2); const sign = direction % 2 === 0 ? -1 : 1;
  end[['x', 'y', 'z'][axis]] = sign < 0 ? parsed.feature.boundsMm[0][axis] : parsed.feature.boundsMm[1][axis];
  return [start, end];
}

function sourceEdgeEndpoints(index, axis, parsed) {
  return [sourceCenter(index, parsed), sourceCenter(positiveNeighbor(index, axis, parsed.dims), parsed)];
}

function auditFeature(parsed, matrix, offset, index) {
  const { feature, dims, step } = parsed;
  const result = { id: feature.id, kind: feature.kind, verified: false, passed: false, code: null, targetSampleCount: 0, retainedSampleCount: 0, retentionFraction: null, connected: null, directionRetentions: [], sampling: { dimensions: [...dims], stepMm: [...step], surfaceToleranceMm: parsed.surfaceToleranceMm }, layerHeightEvidence: 'per-extrusion-gcode-HEIGHT' };
  const indexPoint = point => {
    const candidates = index.index.get(keyOf(Math.floor(point.x / CELL_MM[0]), Math.floor(point.y / CELL_MM[1]), Math.floor(point.z / CELL_MM[2])));
    return coveredByModel(point, candidates, feature.kind === 'solid' ? parsed.surfaceToleranceMm : 0);
  };
  if (feature.kind === 'solid') {
    const byDirection = Array.from({ length: 6 }, () => ({ target: 0, retained: 0 }));
    result.targetSampleCount = feature.surfacePointCount;
    if (result.targetSampleCount < 8) { result.code = 'SOURCE_FEATURE_NOT_FOUND'; return result; }
    for (let p = 0; p < feature.surfacePointCount; p++) {
      const sourcePoint = { x: parsed.surfacePoints[p * 3], y: parsed.surfacePoints[p * 3 + 1], z: parsed.surfacePoints[p * 3 + 2] };
      const point = transformPoint(sourcePoint, matrix, offset);
      const direction = parsed.surfacePointDirections[p];
      byDirection[direction].target++;
      if (indexPoint(point)) { byDirection[direction].retained++; result.retainedSampleCount++; }
    }
    result.retentionFraction = result.retainedSampleCount / result.targetSampleCount;
    result.directionRetentions = byDirection.flatMap((counts, direction) => counts.target ? [{ direction: FACE_DIRECTIONS[direction], targetSampleCount: counts.target, retainedSampleCount: counts.retained, retentionFraction: counts.retained / counts.target }] : []);
    result.verified = true;
    const allDirectionsPass = result.directionRetentions.every(item => item.retentionFraction + 1e-12 >= feature.minRetention);
    result.passed = result.retentionFraction + 1e-12 >= feature.minRetention && allDirectionsPass;
    result.code = result.passed ? 'PASS' : 'RETENTION_BELOW_MINIMUM';
    return result;
  }

  const sourceChannel = channelTargets(parsed, feature.axis);
  if (!sourceChannel) { result.code = 'SOURCE_FEATURE_NOT_FOUND'; return result; }
  const targets = sourceChannel.nodes;
  result.targetSampleCount = targets.length;
  if (targets.length < 8) { result.code = 'SOURCE_FEATURE_NOT_FOUND'; return result; }
  const targetMask = new Uint8Array(parsed.count); for (const i of targets) targetMask[i] = 1;
  const retainedMask = new Uint8Array(parsed.count);
  for (const i of targets) {
    const point = transformPoint(sourceCenter(i, parsed), matrix, offset);
    if (!indexPoint(point)) { retainedMask[i] = 1; result.retainedSampleCount++; }
  }
  result.retentionFraction = result.retainedSampleCount / targets.length;
  const [lowDirection, highDirection] = [{ x: 0, y: 2, z: 4 }[feature.axis], { x: 1, y: 3, z: 5 }[feature.axis]];
  const work = { entries: 0 };
  const adjacency = new Map(targets.map(i => [i, []]));
  let resourceLimit = false;
  for (const i of targets) {
    if (!retainedMask[i]) continue;
    for (let axis = 0; axis < 3; axis++) if (parsed.voidEdges[i] & (1 << axis)) {
      const next = positiveNeighbor(i, axis, dims);
      if (!retainedMask[next]) continue;
      const [a, b] = sourceEdgeEndpoints(i, axis, parsed);
      const blocked = connectorBlocked(a, b, matrix, offset, index, work);
      if (blocked.resourceLimit) { resourceLimit = true; break; }
      if (!blocked.blocked) { adjacency.get(i).push(next); adjacency.get(next).push(i); }
    }
    if (resourceLimit) break;
  }
  const openEnds = { low: [], high: [] };
  if (!resourceLimit) for (const i of targets) if (retainedMask[i]) for (const direction of [lowDirection, highDirection]) {
    if (!(parsed.voidBoundaries[i] & (1 << direction))) continue;
    const [a, b] = faceConnector(i, direction, parsed);
    const blocked = connectorBlocked(a, b, matrix, offset, index, work);
    if (blocked.resourceLimit) { resourceLimit = true; break; }
    if (!blocked.blocked) openEnds[direction === lowDirection ? 'low' : 'high'].push(i);
  }
  if (resourceLimit) { result.code = 'RESOURCE_LIMIT'; result.targetSampleCount = 0; result.retainedSampleCount = 0; result.retentionFraction = null; return result; }
  const seen = new Uint8Array(parsed.count);
  result.connected = false;
  for (const start of openEnds.low) {
    if (seen[start]) continue;
    const queue = [start]; seen[start] = 1;
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      if (openEnds.high.includes(current)) { result.connected = true; break; }
      for (const next of adjacency.get(current) ?? []) if (!seen[next]) { seen[next] = 1; queue.push(next); }
    }
    if (result.connected) break;
  }
  result.verified = true;
  result.passed = result.retentionFraction + 1e-12 >= feature.minRetention && result.connected;
  result.code = result.passed ? 'PASS' : !result.connected ? 'CHANNEL_DISCONNECTED' : 'RETENTION_BELOW_MINIMUM';
  return result;
}

function unverifiedFeatureRows(parsed, code) {
  return parsed.map(({ feature, dims, step, surfaceToleranceMm }) => ({ id: feature.id, kind: feature.kind, verified: false, passed: false, code, targetSampleCount: 0, retainedSampleCount: 0, retentionFraction: null, connected: null, directionRetentions: [], sampling: { dimensions: [...dims], stepMm: [...step], surfaceToleranceMm }, layerHeightEvidence: 'per-extrusion-gcode-HEIGHT' }));
}

/** Audit declared sampled source features against the planned MODEL extrusion envelope. */
export function auditCriticalFeatures(gcodeText, options = {}) {
  const warnings = [];
  const emptyResult = (features = []) => ({ verified: false, passed: false, scope: 'sampled-source-feature-vs-planned-model-extrusion', features, warnings });
  if (typeof gcodeText !== 'string') return emptyResult();
  const probeResult = validateProbeSet(options.probes);
  if (probeResult.code) { warnings.push(probeResult.message); return emptyResult(); }
  const matrix = options.sourceToPrintMatrix4;
  const placement = options.placementOffsetMm;
  if (!validateRigidMatrix(matrix)) { warnings.push('Source-to-print matrix must be a finite proper rigid transform.'); return emptyResult(unverifiedFeatureRows(probeResult.parsed, 'INVALID_MATRIX')); }
  if (options.placementVerified !== true || !placement || !['x', 'y', 'z'].every(axis => finite(placement[axis]))) { warnings.push('Slicer placement must be explicitly verified with finite XYZ offsets.'); return emptyResult(unverifiedFeatureRows(probeResult.parsed, 'PLACEMENT_UNVERIFIED')); }
  let parsedGcode;
  try { parsedGcode = parseGcodeSegments(gcodeText); } catch (error) { warnings.push(`G-code parsing failed: ${error.message}`); return emptyResult(unverifiedFeatureRows(probeResult.parsed, 'GCODE_PARSE_FAILED')); }
  if (parsedGcode.unsupportedArcMoves > 0) { warnings.push('Unsupported arc extrusion moves are present.'); return emptyResult(unverifiedFeatureRows(probeResult.parsed, 'UNSUPPORTED_ARC_MOVES')); }
  const modelSegments = parsedGcode.segments.filter(segment => segment.motionType === 'extrusion' && segment.role === 'MODEL');
  if (modelSegments.length === 0) { warnings.push('No supported positive MODEL extrusion was found.'); return emptyResult(unverifiedFeatureRows(probeResult.parsed, 'MODEL_EXTRUSION_NOT_FOUND')); }
  const spatialIndex = buildIndex(parsedGcode.segments);
  if (spatialIndex.code) { warnings.push(spatialIndex.message); return emptyResult(unverifiedFeatureRows(probeResult.parsed, spatialIndex.code)); }
  const features = probeResult.parsed.map(feature => samplingIsFineEnough(feature, matrix, spatialIndex)
    ? auditFeature(feature, matrix, placement, spatialIndex)
    : { ...unverifiedFeatureRows([feature], 'CRITICAL_SAMPLING_TOO_COARSE')[0], targetSampleCount: 0 });
  const verified = features.every(feature => feature.verified);
  return { verified, passed: verified && features.every(feature => feature.passed), scope: 'sampled-source-feature-vs-planned-model-extrusion', features, warnings };
}
