import { parseGcodeSegments } from './slicer.mjs';

const SCOPE = 'approximate-extrusion-envelope-in-source-aabb';
const EPSILON = 1e-9;

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function validateRegions(regions) {
  if (!Array.isArray(regions)) throw new TypeError('protectedRegions must be an array');
  return regions.map((region, index) => {
    if (!region || typeof region.id !== 'string' || !region.id.trim()) throw new TypeError(`protectedRegions[${index}].id is required`);
    const bounds = region.boundsMm;
    if (!Array.isArray(bounds) || bounds.length !== 2 || bounds.some((point) => !Array.isArray(point) || point.length !== 3)) {
      throw new TypeError(`protectedRegions[${index}].boundsMm must contain two 3D points`);
    }
    const min = bounds[0].map((value, axis) => finite(value, `protectedRegions[${index}].boundsMm.min[${axis}]`));
    const max = bounds[1].map((value, axis) => finite(value, `protectedRegions[${index}].boundsMm.max[${axis}]`));
    if (min.some((value, axis) => value >= max[axis])) throw new RangeError(`protectedRegions[${index}].boundsMm must have positive dimensions`);
    return { id: region.id, min, max };
  });
}

function validateSourceTransform(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 16 || matrix.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null;
  const close = (a, b) => Math.abs(a - b) <= 1e-6;
  if (![matrix[12], matrix[13], matrix[14], matrix[15]].every((value, i) => close(value, [0, 0, 0, 1][i]))) return null;
  const columns = [[matrix[0], matrix[4], matrix[8]], [matrix[1], matrix[5], matrix[9]], [matrix[2], matrix[6], matrix[10]]];
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
    const dot = columns[i].reduce((sum, value, k) => sum + value * columns[j][k], 0);
    if (!close(dot, i === j ? 1 : 0)) return null;
  }
  const [a, b, c, d, e, f, g, h, i] = [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9], matrix[10]];
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!close(determinant, 1)) return null;
  return (point) => [
    a * point[0] + b * point[1] + c * point[2] + matrix[3],
    d * point[0] + e * point[1] + f * point[2] + matrix[7],
    g * point[0] + h * point[1] + i * point[2] + matrix[11],
  ];
}

function clipFraction(start, end, min, max, padding) {
  let low = 0;
  let high = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const lo = min[axis] - padding;
    const hi = max[axis] + padding;
    const delta = end[axis] - start[axis];
    if (Math.abs(delta) < EPSILON) {
      if (start[axis] < lo || start[axis] > hi) return 0;
      continue;
    }
    let t0 = (lo - start[axis]) / delta;
    let t1 = (hi - start[axis]) / delta;
    if (t0 > t1) [t0, t1] = [t1, t0];
    low = Math.max(low, t0);
    high = Math.min(high, t1);
    if (low > high) return 0;
  }
  return Math.max(0, high - low);
}

function roleBucket() { return { pathLengthMm: 0, filamentLengthMm: 0, segmentCount: 0 }; }

/** Summarize support extrusion and its approximate overlap with protected source-space AABBs. */
export function analyzeSupportPaths(gcodeText, options = {}) {
  if (typeof gcodeText !== 'string') throw new TypeError('gcodeText must be a string');
  const layerHeightMm = finite(options.layerHeightMm, 'layerHeightMm');
  if (layerHeightMm <= 0) throw new RangeError('layerHeightMm must be positive');
  const regions = validateRegions(options.protectedRegions ?? []);
  const placement = options.placementOffsetMm;
  const placementValues = placement && [placement.x, placement.y, placement.z];
  const placementValid = Array.isArray(placementValues) && placementValues.every((value) => typeof value === 'number' && Number.isFinite(value));
  const placementOffset = placementValid ? placementValues : [0, 0, 0];
  const toSource = validateSourceTransform(options.printToSourceMatrix4);
  const warnings = [];
  if (!toSource) warnings.push('printToSourceMatrix4 is missing or is not a finite proper rigid transform');
  if (!placementValid) warnings.push('placementOffsetMm must contain finite x, y, and z');
  if (options.placementVerified !== true) warnings.push('placementVerified must be true before source-space ROI results are verified');
  if (regions.length === 0) warnings.push('No protected regions were supplied; critical areas were not verified');

  const parsed = parseGcodeSegments(gcodeText);
  if (parsed.unsupportedArcMoves > 0) warnings.push(`Unsupported arc extrusion moves: ${parsed.unsupportedArcMoves}`);
  const support = { pathLengthMm: 0, filamentLengthMm: 0, interfacePathLengthMm: 0, interfaceFilamentLengthMm: 0, segmentCount: 0, interfaceSegmentCount: 0, byRole: {} };
  const regionStats = regions.map(({ id }) => ({ id, supportPathLengthMm: 0, interfacePathLengthMm: 0, segmentCount: 0, interfaceSegmentCount: 0, supportFilamentLengthMm: 0, interfaceFilamentLengthMm: 0 }));
  let missingWidth = false;
  let unknownExtrusion = false;
  let supportRoleExtrusion = false;

  for (const segment of parsed.segments) {
    if (segment.motionType !== 'extrusion' || segment.deltaEMm <= 0 || segment.xyLengthMm <= EPSILON) continue;
    if (segment.role !== 'SUPPORT' && segment.role !== 'UNKNOWN') continue;
    if (segment.role === 'UNKNOWN') {
      unknownExtrusion = true;
      const unknownBucket = support.byRole.UNKNOWN ??= roleBucket();
      unknownBucket.pathLengthMm += segment.xyLengthMm;
      unknownBucket.filamentLengthMm += segment.deltaEMm;
      unknownBucket.segmentCount += 1;
      continue;
    }
    supportRoleExtrusion = true;
    const widthValid = Number.isFinite(segment.lineWidthMm) && segment.lineWidthMm > 0;
    if (!widthValid) missingWidth = true;
    const sourceRole = (segment.sourceRole ?? '').trim();
    const isInterface = /interface/i.test(sourceRole);
    const roleKey = isInterface ? 'SUPPORT_INTERFACE' : 'SUPPORT';
    const bucket = support.byRole[roleKey] ??= roleBucket();
    const startPrint = [segment.start.x - placementOffset[0], segment.start.y - placementOffset[1], segment.start.z - placementOffset[2]];
    const endPrint = [segment.end.x - placementOffset[0], segment.end.y - placementOffset[1], segment.end.z - placementOffset[2]];
    const start = toSource ? toSource(startPrint) : startPrint;
    const end = toSource ? toSource(endPrint) : endPrint;
    const length = segment.xyLengthMm;
    const filament = segment.deltaEMm;
    support.pathLengthMm += length;
    support.filamentLengthMm += filament;
    support.segmentCount += 1;
    bucket.pathLengthMm += length;
    bucket.filamentLengthMm += filament;
    bucket.segmentCount += 1;
    if (isInterface) {
      support.interfacePathLengthMm += length;
      support.interfaceFilamentLengthMm += filament;
      support.interfaceSegmentCount += 1;
    }
    // Keep total path and filament cost visible when width metadata is absent;
    // without a width, the envelope cannot be safely clipped against an ROI.
    if (!widthValid) continue;
    const padding = segment.lineWidthMm / 2 + layerHeightMm / 2;
    for (let index = 0; index < regions.length; index += 1) {
      const fraction = clipFraction(start, end, regions[index].min, regions[index].max, padding);
      if (fraction <= 0) continue;
      const stat = regionStats[index];
      stat.supportPathLengthMm += length * fraction;
      stat.supportFilamentLengthMm += filament * fraction;
      stat.segmentCount += 1;
      if (isInterface) {
        stat.interfacePathLengthMm += length * fraction;
        stat.interfaceFilamentLengthMm += filament * fraction;
        stat.interfaceSegmentCount += 1;
      }
    }
  }
  if (missingWidth) warnings.push('Positive support extrusion is missing WIDTH; it was excluded from geometric estimates');
  if (unknownExtrusion) warnings.push('Positive extrusion has UNKNOWN role; support risk cannot be ruled out');
  if (!supportRoleExtrusion) warnings.push('No classified positive support XY extrusion was found');
  const verified = Boolean(toSource && placementValid && options.placementVerified === true && parsed.unsupportedArcMoves === 0 && !missingWidth && !unknownExtrusion);
  const protectionVerified = verified && regions.length > 0;
  return { verified, protectionVerified, support, regions: regionStats, warnings, scope: SCOPE };
}
