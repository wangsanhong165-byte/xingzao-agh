import { inflateSync } from 'node:zlib';
import { parseGcodeSegments } from './slicer.mjs';

const MAX_TARGET_PIXELS = 12_000_000;
const MAX_FOOTPRINT_CELLS = 4_000_000;
const MAX_TARGET_HOLES = 4096;
const DEFAULT_RASTER_STEP_MM = 0.1;

function number(value, label, { min = -Infinity, max = Infinity, minOpen = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (minOpen ? value <= min : value < min) || value > max) {
    throw new RangeError(`${label} must be a finite number in range`);
  }
  return value;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodeGrayPng(dataBase64, declaredWidth, declaredHeight) {
  if (typeof dataBase64 !== 'string' || dataBase64.length > 40 * 1024 * 1024) throw new TypeError('targetMask PNG Base64 is invalid or too large');
  const encoded = dataBase64.startsWith('data:image/png;base64,') ? dataBase64.slice('data:image/png;base64,'.length) : dataBase64;
  const png = Buffer.from(encoded, 'base64');
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 33 || !png.subarray(0, 8).equals(signature)) throw new TypeError('targetMask must contain a PNG image');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) throw new TypeError('targetMask PNG chunk is truncated');
    const type = png.toString('ascii', offset + 4, offset + 8);
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (length !== 13) throw new TypeError('targetMask PNG header is invalid');
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      if (chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] !== 0) throw new TypeError('targetMask PNG compression/interlace mode is unsupported');
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height || width !== declaredWidth || height !== declaredHeight) throw new RangeError('targetMask dimensions do not match its PNG');
  if (width * height > MAX_TARGET_PIXELS) throw new RangeError('targetMask raster exceeds the 12 million pixel limit');
  if (bitDepth !== 8 || colorType !== 0) throw new TypeError('targetMask PNG must be 8-bit grayscale');
  const stride = width + 1;
  const expectedLength = stride * height;
  const inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedLength });
  if (inflated.length !== expectedLength) throw new TypeError('targetMask PNG raster length is invalid');

  const pixels = new Uint8Array(width * height);
  let source = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[source++];
    const rowStart = row * width;
    const priorStart = rowStart - width;
    for (let col = 0; col < width; col += 1) {
      const raw = inflated[source++];
      const left = col ? pixels[rowStart + col - 1] : 0;
      const above = row ? pixels[priorStart + col] : 0;
      const upperLeft = row && col ? pixels[priorStart + col - 1] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + above;
      else if (filter === 3) value = raw + Math.floor((left + above) / 2);
      else if (filter === 4) value = raw + paeth(left, above, upperLeft);
      else throw new TypeError(`Unsupported PNG filter ${filter}`);
      pixels[rowStart + col] = value & 0xff;
    }
  }
  return { width, height, pixels, pngDataBase64: encoded };
}

function placementOffset(value) {
  const input = value ?? { x: 0, y: 0, z: 0 };
  const x = input.x ?? input[0] ?? 0;
  const y = input.y ?? input[1] ?? 0;
  const z = input.z ?? input[2] ?? 0;
  return {
    x: number(x, 'placementOffsetMm.x'),
    y: number(y, 'placementOffsetMm.y'),
    z: number(z, 'placementOffsetMm.z'),
  };
}

function buildEvaluationTarget(mask, widthMm, depthMm, stepMm) {
  let gridWidth = Math.ceil(widthMm / stepMm);
  let gridHeight = Math.ceil(depthMm / stepMm);
  if (gridWidth * gridHeight > MAX_FOOTPRINT_CELLS) {
    throw new RangeError('planar footprint raster exceeds the 4 million cell limit; increase rasterStepMm');
  }
  const stepX = widthMm / gridWidth;
  const stepY = depthMm / gridHeight;
  const target = new Uint8Array(gridWidth * gridHeight);
  let targetCount = 0;
  let minCol = gridWidth;
  let maxCol = -1;
  let minRow = gridHeight;
  let maxRow = -1;
  for (let row = 0; row < gridHeight; row += 1) {
    const sourceRow = Math.min(mask.height - 1, Math.floor(((row + 0.5) * stepY / depthMm) * mask.height));
    for (let col = 0; col < gridWidth; col += 1) {
      const sourceCol = Math.min(mask.width - 1, Math.floor(((col + 0.5) * stepX / widthMm) * mask.width));
      if (mask.pixels[sourceRow * mask.width + sourceCol] === 0) continue;
      target[row * gridWidth + col] = 1;
      targetCount += 1;
      minCol = Math.min(minCol, col); maxCol = Math.max(maxCol, col);
      minRow = Math.min(minRow, row); maxRow = Math.max(maxRow, row);
    }
  }
  if (!targetCount) throw new RangeError('targetMask must contain foreground pixels');
  const targetBoundsMm = {
    xMin: -widthMm / 2 + minCol * stepX,
    xMax: -widthMm / 2 + (maxCol + 1) * stepX,
    yMin: depthMm / 2 - (maxRow + 1) * stepY,
    yMax: depthMm / 2 - minRow * stepY,
  };
  return { target, targetCount, gridWidth, gridHeight, stepX, stepY, cellAreaMm2: stepX * stepY, targetBoundsMm };
}

function clipLineToBounds(start, end, rect) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let first = 0;
  let last = 1;
  const tests = [[-dx, start.x - rect.xMin], [dx, rect.xMax - start.x], [-dy, start.y - rect.yMin], [dy, rect.yMax - start.y]];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return 0; continue; }
    const t = q / p;
    if (p < 0) first = Math.max(first, t); else last = Math.min(last, t);
    if (first > last) return 0;
  }
  return Math.hypot(dx, dy) * Math.max(0, last - first);
}

function stampExtrusion(footprint, width, height, stepX, stepY, segment, beadWidthMm) {
  const radius = beadWidthMm / 2;
  const minCol = Math.max(0, Math.floor((Math.min(segment.start.x, segment.end.x) - radius + (width * stepX) / 2) / stepX));
  const maxCol = Math.min(width - 1, Math.floor((Math.max(segment.start.x, segment.end.x) + radius + (width * stepX) / 2) / stepX));
  const minRow = Math.max(0, Math.floor(((height * stepY) / 2 - Math.max(segment.start.y, segment.end.y) - radius) / stepY));
  const maxRow = Math.min(height - 1, Math.floor(((height * stepY) / 2 - Math.min(segment.start.y, segment.end.y) + radius) / stepY));
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const lengthSquared = dx * dx + dy * dy;
  let marked = 0;
  for (let row = minRow; row <= maxRow; row += 1) {
    const py = (height * stepY) / 2 - (row + 0.5) * stepY;
    for (let col = minCol; col <= maxCol; col += 1) {
      const px = -(width * stepX) / 2 + (col + 0.5) * stepX;
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - segment.start.x) * dx + (py - segment.start.y) * dy) / lengthSquared));
      const nearestX = segment.start.x + t * dx;
      const nearestY = segment.start.y + t * dy;
      if ((px - nearestX) ** 2 + (py - nearestY) ** 2 > radius * radius) continue;
      const index = row * width + col;
      if (!footprint[index]) { footprint[index] = 1; marked += 1; }
    }
  }
  return marked;
}

function measureTargetHoles(target, footprint, width, height) {
  const size = target.length;
  const labels = new Int32Array(size);
  const queue = new Uint32Array(size);
  let head = 0;
  let tail = 0;
  const enqueueExterior = (index) => {
    if (target[index] === 0 && labels[index] === 0) { labels[index] = -1; queue[tail++] = index; }
  };
  for (let x = 0; x < width; x += 1) { enqueueExterior(x); enqueueExterior((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { enqueueExterior(y * width); enqueueExterior(y * width + width - 1); }
  const flood = (label) => {
    while (head < tail) {
      const index = queue[head++];
      const row = Math.floor(index / width);
      const col = index - row * width;
      for (const next of [col > 0 ? index - 1 : -1, col + 1 < width ? index + 1 : -1, row > 0 ? index - width : -1, row + 1 < height ? index + width : -1]) {
        if (next >= 0 && target[next] === 0 && labels[next] === 0) { labels[next] = label; queue[tail++] = next; }
      }
    }
  };
  flood(-1);
  const originalAreas = [0];
  for (let index = 0; index < size; index += 1) {
    if (target[index] !== 0 || labels[index] !== 0) continue;
    const label = originalAreas.length;
    if (label > MAX_TARGET_HOLES) throw new RangeError(`targetMask contains more than ${MAX_TARGET_HOLES} enclosed holes`);
    head = 0; tail = 0; labels[index] = label; queue[tail++] = index;
    flood(label);
    originalAreas.push(tail);
  }
  const holeCount = originalAreas.length - 1;
  if (!holeCount) return { targetHoleCount: 0, targetHoles: [] };

  const remainingAreas = new Uint32Array(originalAreas.length);
  const remainingComponents = new Uint32Array(originalAreas.length);
  const visited = new Uint8Array(size);
  const sameHoleFlood = (start, label) => {
    head = 0; tail = 0; visited[start] = 1; queue[tail++] = start;
    while (head < tail) {
      const index = queue[head++];
      const row = Math.floor(index / width);
      const col = index - row * width;
      for (const next of [col > 0 ? index - 1 : -1, col + 1 < width ? index + 1 : -1, row > 0 ? index - width : -1, row + 1 < height ? index + width : -1]) {
        if (next >= 0 && labels[next] === label && footprint[next] === 0 && visited[next] === 0) { visited[next] = 1; queue[tail++] = next; }
      }
    }
  };
  for (let index = 0; index < size; index += 1) {
    const label = labels[index];
    if (label <= 0 || footprint[index] !== 0) continue;
    remainingAreas[label] += 1;
    if (visited[index] === 0) { remainingComponents[label] += 1; sameHoleFlood(index, label); }
  }
  const targetHoles = [];
  for (let label = 1; label < originalAreas.length; label += 1) {
    const remainingFraction = remainingAreas[label] / originalAreas[label];
    targetHoles.push({
      index: label - 1,
      originalPixels: originalAreas[label],
      remainingPixels: remainingAreas[label],
      remainingComponents: remainingComponents[label],
      remainingFraction: Number(remainingFraction.toFixed(4)),
      remainingConnected: remainingAreas[label] > 0 && remainingComponents[label] === 1,
    });
  }
  return { targetHoleCount: holeCount, targetHoles };
}

function previewSvg(maskDataBase64, widthMm, depthMm, maskWidth, maskHeight, segments, truncated) {
  const scaleX = 640 / widthMm;
  const scaleY = 640 / depthMm;
  const point = (x, y) => `${(320 + x * scaleX).toFixed(2)},${(320 - y * scaleY).toFixed(2)}`;
  const shown = segments.slice(0, 5000);
  const paths = shown.map((segment) => {
    const color = segment.role === 'MODEL' ? '#d43b67' : segment.role === 'SUPPORT' ? '#2b8cbe' : '#ef9b35';
    const dash = segment.role === 'SUPPORT' || segment.role === 'UNKNOWN' ? ' stroke-dasharray="4 3"' : '';
    const width = Math.max(0.5, (segment.widthMm ?? 0.4) * scaleX);
    return `<path d="M ${point(segment.start.x, segment.start.y)} L ${point(segment.end.x, segment.end.y)}" stroke="${color}" stroke-width="${width.toFixed(2)}" fill="none"${dash}/>`;
  }).join('');
  const suffix = truncated ? '<text x="8" y="18" font-size="12" fill="#b00">Preview truncated at 5000 segments</text>' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640"><rect width="640" height="640" fill="white"/><image href="data:image/png;base64,${maskDataBase64}" width="640" height="640" opacity="0.35"/>${paths}${suffix}</svg>`;
}

/**
 * Approximate how a planar target mask intersects actual sliced bead footprints.
 * This is a raster/centerline estimate for XY planar relief, not a physical
 * print or legibility guarantee.
 */
export async function evaluatePlanarDetail(gcodeText, options = {}) {
  const widthMm = number(options.widthMm, 'widthMm', { min: 0, minOpen: true, max: 180 });
  const depthMm = number(options.depthMm, 'depthMm', { min: 0, minOpen: true, max: 180 });
  const baseZ = number(options.baseZ, 'baseZ', { min: 0, max: 500 });
  const reliefHeight = number(options.reliefHeight, 'reliefHeight', { min: 0, minOpen: true, max: 3 });
  const targetHoleRemainingFraction = number(options.targetHoleRemainingFraction ?? 0.8, 'targetHoleRemainingFraction', { min: 0, max: 1 });
  const fallbackWidth = options.extrusionWidthMm == null ? null : number(options.extrusionWidthMm, 'extrusionWidthMm', { min: 0, minOpen: true, max: 5 });
  const rasterStep = number(options.rasterStepMm ?? DEFAULT_RASTER_STEP_MM, 'rasterStepMm', { min: 0, minOpen: true, max: 1 });
  const offset = placementOffset(options.placementOffsetMm);
  const rawMask = options.targetMask;
  if (!rawMask || !Number.isSafeInteger(rawMask.width) || !Number.isSafeInteger(rawMask.height) || rawMask.width <= 0 || rawMask.height <= 0) {
    throw new TypeError('targetMask requires positive integer width and height');
  }
  if (rawMask.width * rawMask.height > MAX_TARGET_PIXELS) throw new RangeError('targetMask exceeds the 12 million pixel limit');
  const mask = decodeGrayPng(rawMask.dataBase64, rawMask.width, rawMask.height);
  const targetInfo = buildEvaluationTarget(mask, widthMm, depthMm, rasterStep);
  const { target, targetCount, gridWidth, gridHeight, stepX, stepY, cellAreaMm2, targetBoundsMm } = targetInfo;
  const parsed = parseGcodeSegments(gcodeText);
  const footprint = new Uint8Array(target.length);
  const tolerance = Math.max(0.02, Math.min(0.1, rasterStep / 2));
  const detailTopZ = baseZ + reliefHeight + tolerance;
  const roleLengthsMm = { model: 0, support: 0, skirtBrim: 0, auxiliary: 0, unknown: 0, travel: 0, retraction: 0, zhop: 0, prime: 0 };
  const roleCounts = { MODEL: 0, SUPPORT: 0, SKIRT_BRIM: 0, AUXILIARY: 0, UNKNOWN: 0, TRAVEL: 0, RETRACTION: 0, ZHOP: 0, PRIME: 0 };
  let unknownInTargetCount = 0;
  let lineWidthKnownCount = 0;
  let lineWidthFallbackCount = 0;
  let lineWidthMissingCount = 0;
  let modelSegmentCount = 0;
  let modelAboveReliefLengthMm = 0;
  let highestModelExtrusionZ = null;
  const modelLayerKeys = new Set();
  const overlaySegments = [];
  const targetRectExpanded = {
    xMin: targetBoundsMm.xMin - Math.max(fallbackWidth ?? 0.5, 0.5),
    yMin: targetBoundsMm.yMin - Math.max(fallbackWidth ?? 0.5, 0.5),
    xMax: targetBoundsMm.xMax + Math.max(fallbackWidth ?? 0.5, 0.5),
    yMax: targetBoundsMm.yMax + Math.max(fallbackWidth ?? 0.5, 0.5),
  };

  for (const source of parsed.segments) {
    const startZ = source.start.z - offset.z;
    const endZ = source.end.z - offset.z;
    const midZ = (startZ + endZ) / 2;
    if (midZ <= baseZ + 0.01) continue;
    if (midZ > detailTopZ) {
      if (source.motionType === 'extrusion' && source.role === 'MODEL') modelAboveReliefLengthMm += source.xyLengthMm;
      continue;
    }
    roleCounts[source.role] = (roleCounts[source.role] ?? 0) + 1;
    const length = source.xyLengthMm;
    if (source.motionType === 'extrusion') {
      if (source.role === 'MODEL') roleLengthsMm.model += length;
      else if (source.role === 'SUPPORT') roleLengthsMm.support += length;
      else if (source.role === 'SKIRT_BRIM') roleLengthsMm.skirtBrim += length;
      else if (source.role === 'AUXILIARY') roleLengthsMm.auxiliary += length;
      else roleLengthsMm.unknown += length;
    } else if (source.motionType === 'travel') roleLengthsMm.travel += length;
    else if (source.motionType === 'retraction') roleLengthsMm.retraction += length;
    else if (source.motionType === 'zhop') roleLengthsMm.zhop += Math.abs(endZ - startZ);
    else if (source.motionType === 'prime') roleLengthsMm.prime += Math.max(0, source.deltaEMm);

    const segment = {
      start: { x: source.start.x - offset.x, y: source.start.y - offset.y },
      end: { x: source.end.x - offset.x, y: source.end.y - offset.y },
      role: source.role,
      widthMm: source.lineWidthMm ?? fallbackWidth,
      lengthMm: length,
    };
    if (source.motionType === 'extrusion' && source.role === 'UNKNOWN'
        && clipLineToBounds(segment.start, segment.end, targetRectExpanded) > 0) unknownInTargetCount += 1;
    if (source.motionType !== 'extrusion' || source.role !== 'MODEL') continue;
    modelSegmentCount += 1;
    modelLayerKeys.add(Math.round(midZ * 1000));
    highestModelExtrusionZ = Math.max(highestModelExtrusionZ ?? -Infinity, startZ, endZ);
    if (segment.widthMm === null) {
      lineWidthMissingCount += 1;
      continue;
    }
    if (source.lineWidthMm === null) lineWidthFallbackCount += 1;
    else lineWidthKnownCount += 1;
    stampExtrusion(footprint, gridWidth, gridHeight, stepX, stepY, segment, segment.widthMm);
    overlaySegments.push(segment);
  }

  let coveredTargetPixels = 0;
  let footprintPixels = 0;
  let spillPixels = 0;
  for (let index = 0; index < target.length; index += 1) {
    if (!footprint[index]) continue;
    footprintPixels += 1;
    if (target[index]) coveredTargetPixels += 1;
    else spillPixels += 1;
  }
  const holes = measureTargetHoles(target, footprint, gridWidth, gridHeight);
  const targetCoverageFraction = coveredTargetPixels / targetCount;
  const spillAreaMm2 = spillPixels * cellAreaMm2;
  const spillFraction = footprintPixels ? spillPixels / footprintPixels : 0;
  const hasTargetModelCoverage = coveredTargetPixels > 0 && modelLayerKeys.size > 0;
  const targetHoles = holes.targetHoles.map((hole) => ({
    ...hole,
    survives: hasTargetModelCoverage
      ? hole.remainingFraction >= targetHoleRemainingFraction && hole.remainingConnected
      : null,
  }));
  const survivingTargetHoleCount = hasTargetModelCoverage
    ? targetHoles.filter((hole) => hole.survives).length
    : null;
  const holeEvidence = {
    verified: hasTargetModelCoverage,
    status: hasTargetModelCoverage ? 'measured' : 'unverified-no-target-model-coverage',
    targetHoleRemainingFraction,
    basis: 'survives iff remaining raster area fraction meets threshold and stays 4-connected',
  };
  const roleEvidence = {
    verified: unknownInTargetCount === 0 && parsed.unsupportedArcMoves === 0,
    unknownExtrusionSegmentsInTarget: unknownInTargetCount,
    unsupportedArcMoves: parsed.unsupportedArcMoves,
    classifier: 'Prusa TYPE / generic FEATURE comments; unknown roles excluded from model coverage',
  };
  const lineWidthEvidence = {
    verified: lineWidthFallbackCount === 0 && lineWidthMissingCount === 0,
    gcodeWidthSegmentCount: lineWidthKnownCount,
    configuredFallbackSegmentCount: lineWidthFallbackCount,
    missingWidthSegmentCount: lineWidthMissingCount,
    fallbackWidthMm: fallbackWidth,
  };
  const warnings = [
    '这是平面XY的切片footprint近似指标，不代表实物打印成功、结构强度或字符可读率。',
    'coverage以栅格target mask和G-code线宽膨胀近似计算；本评价器只测量，具体通过阈值由任务策略决定。',
  ];
  if (!roleEvidence.verified) warnings.push('目标范围内存在未知挤出role或不支持的G2/G3弧线；model-only coverage未完全验证。');
  if (!lineWidthEvidence.verified) warnings.push('部分model挤出没有G-code线宽；coverage含外部回退宽度或未计入该路径，线宽依据未验证。');
  if (lineWidthFallbackCount) warnings.push('部分线宽使用调用方提供的extrusionWidthMm作为回退值。');
  if (unknownInTargetCount) warnings.push('未知role路径未计入model覆盖，避免support等路径伪装成细节保真。');
  if (footprintPixels === 0) warnings.push('没有可确认的MODEL浮雕footprint。');
  if (!hasTargetModelCoverage && holes.targetHoleCount) warnings.push('没有MODEL浮雕挤出覆盖target像素；目标孔洞保持情况未验证。');
  if (holes.targetHoleCount) warnings.push(`目标孔洞按栅格余量比例 ${targetHoleRemainingFraction.toFixed(2)} 和连通性近似判定；不代表材料流动或实物孔径。`);
  if (modelAboveReliefLengthMm > 0) warnings.push('存在高于预期浮雕高度的MODEL挤出；该路径未计入本次平面coverage。');
  if (overlaySegments.length > 5000) warnings.push('SVG预览只画出前5000条model线段；面积统计使用全部线段。');
  const checks = [
    { name: 'planar-footprint', status: 'measured', detail: `target coverage ${(targetCoverageFraction * 100).toFixed(2)}%，spill ${spillAreaMm2.toFixed(2)} mm²；本次不设置通过阈值。` },
    { name: 'role-classification', status: roleEvidence.verified ? 'verified' : 'unverified', detail: `${unknownInTargetCount} 个目标范围内未知role挤出。` },
    { name: 'extrusion-width', status: lineWidthEvidence.verified ? 'verified' : 'unverified', detail: `${lineWidthKnownCount} 个路径使用G-code宽度、${lineWidthFallbackCount} 个用外部宽度、${lineWidthMissingCount} 个缺少宽度。` },
    { name: 'target-hole-survival', status: holeEvidence.status, detail: hasTargetModelCoverage ? `${survivingTargetHoleCount}/${holes.targetHoleCount} 个目标孔洞满足余量比例与连通性。` : '无目标范围内MODEL覆盖，孔洞保留未验证。' },
  ];

  return {
    evaluation: { mode: 'planar-toolpath-footprint', verified: roleEvidence.verified && lineWidthEvidence.verified, geometry: 'canonical-flat-XY' },
    targetCoverageFraction: Number(targetCoverageFraction.toFixed(6)),
    targetAreaMm2: Number((targetCount * cellAreaMm2).toFixed(4)),
    coveredTargetAreaMm2: Number((coveredTargetPixels * cellAreaMm2).toFixed(4)),
    spillAreaMm2: Number(spillAreaMm2.toFixed(4)),
    spillFraction: Number(spillFraction.toFixed(6)),
    modelExtrusionLengthMm: Number(roleLengthsMm.model.toFixed(3)),
    modelRaisedLayerCount: modelLayerKeys.size,
    highestModelExtrusionZ: highestModelExtrusionZ === null ? null : Number(highestModelExtrusionZ.toFixed(3)),
    modelAboveReliefLengthMm: Number(modelAboveReliefLengthMm.toFixed(3)),
    roleLengthsMm: Object.fromEntries(Object.entries(roleLengthsMm).map(([key, value]) => [key, Number(value.toFixed(3))])),
    roleCounts,
    roleEvidence,
    lineWidthEvidence,
    checks,
    targetHoleCount: holes.targetHoleCount,
    survivingTargetHoleCount,
    targetHoleRemainingFraction,
    holeEvidence,
    targetHoles,
    raster: { width: gridWidth, height: gridHeight, stepXmm: Number(stepX.toFixed(5)), stepYmm: Number(stepY.toFixed(5)) },
    targetBoundsMm,
    previewSvg: previewSvg(mask.pngDataBase64, widthMm, depthMm, mask.width, mask.height, overlaySegments, overlaySegments.length > 5000),
    warnings,
  };
}
