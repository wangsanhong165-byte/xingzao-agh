import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import modeling from '@jscad/modeling';
import {resolveCpuPython} from './python-runtime.mjs';

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonPath = resolveCpuPython(projectRoot);
const extractScript = path.join(projectRoot, 'tools', 'extract_detail.py');
const jobsRoot = path.join(projectRoot, 'data', 'detail-jobs');
const { primitives, measurements } = modeling;
const { cuboid } = primitives;

function finiteNumber(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label}必须在${min}～${max}范围内`);
  }
  return value;
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new TypeError('缺少细节增强输入');
  const image = input.image;
  if (!image || !['image/png', 'image/jpeg'].includes(image.mime) || typeof image.dataBase64 !== 'string') {
    throw new TypeError('图像必须是PNG或JPEG的Base64内容');
  }
  if (image.name != null && (typeof image.name !== 'string' || image.name.length > 200)) throw new TypeError('图像名称无效');
  const base64 = image.dataBase64;
  if (!base64 || base64.length > Math.ceil(5 * 1024 * 1024 * 4 / 3) + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new RangeError('图像数据不能为空且不超过5MiB');
  }
  const imageBytes = Buffer.from(base64, 'base64');
  if (!imageBytes.length || imageBytes.length > 5 * 1024 * 1024 || imageBytes.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) {
    throw new RangeError('图像Base64无效或超过5MiB');
  }
  const dimensions = input.dimensions;
  if (!dimensions || typeof dimensions !== 'object') throw new TypeError('缺少dimensions');
  const width = finiteNumber(dimensions.width, 'width', 1, 180);
  const depth = finiteNumber(dimensions.depth, 'depth', 1, 180);
  const baseThickness = finiteNumber(dimensions.baseThickness, 'baseThickness', 0.8, 10);
  const roi = input.roi;
  if (!roi || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(roi[key]))) throw new TypeError('ROI必须含整数x、y、width、height');
  if (roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0) throw new RangeError('ROI超出图像范围或为空');
  const constraints = input.constraints;
  if (!constraints || typeof constraints !== 'object') throw new TypeError('缺少constraints');
  const minFeatureWidth = finiteNumber(constraints.minFeatureWidth, 'minFeatureWidth', 0.4, 3);
  const reliefHeight = finiteNumber(constraints.reliefHeight, 'reliefHeight', 0.2, constraints.maxReliefHeight);
  const maxReliefHeight = finiteNumber(constraints.maxReliefHeight, 'maxReliefHeight', 0.2, 3);
  if (reliefHeight > maxReliefHeight) throw new RangeError('reliefHeight不得大于maxReliefHeight');
  const minFidelity = finiteNumber(constraints.minFidelity, 'minFidelity', 0, 1);
  if (typeof input.profileId !== 'string' || !input.profileId.trim() || input.profileId.length > 100) throw new TypeError('profileId无效');
  return { imageBytes, width, depth, baseThickness, roi, minFeatureWidth, reliefHeight, maxReliefHeight, minFidelity };
}

function candidateHash(input, options = {}) {
  return createHash('sha256').update(JSON.stringify({ input, options, version: 2 })).digest('hex').slice(0, 24);
}

function meshGridSize(validated, sourceWidth, sourceHeight, minFeatureWidth) {
  let width = Math.max(1, Math.min(sourceWidth, 200, Math.ceil(validated.width * 2 / minFeatureWidth)));
  let height = Math.max(1, Math.min(sourceHeight, 150, Math.ceil(validated.depth * 2 / minFeatureWidth)));
  const maxCells = 30_000;
  if (width * height > maxCells) {
    const scale = Math.sqrt(maxCells / (width * height));
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }
  return { width, height };
}

function fidelityToGrid(targetContours, sourceWidth, sourceHeight, meshMask, meshWidth, meshHeight) {
  const target = maskGridFromContours(targetContours, sourceWidth, sourceHeight, sourceWidth, sourceHeight);
  let intersection = 0;
  let union = 0;
  for (let y = 0; y < sourceHeight; y++) {
    const meshY = Math.min(meshHeight - 1, Math.floor((y + 0.5) * meshHeight / sourceHeight));
    for (let x = 0; x < sourceWidth; x++) {
      const targetValue = target[y * sourceWidth + x] !== 0;
      const meshX = Math.min(meshWidth - 1, Math.floor((x + 0.5) * meshWidth / sourceWidth));
      const meshValue = meshMask[meshY * meshWidth + meshX] !== 0;
      if (targetValue && meshValue) intersection++;
      if (targetValue || meshValue) union++;
    }
  }
  return union ? intersection / union : 1;
}

async function extract(input, validated, minFeatureWidth = validated.minFeatureWidth) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'photo-cad-detail-'));
  const imagePath = path.join(temporary, 'source.png');
  const outputPath = path.join(temporary, 'extraction.json');
  try {
    await writeFile(imagePath, validated.imageBytes);
    await execFile(pythonPath, [
      extractScript,
      '--image', imagePath,
      '--output', outputPath,
      '--width-mm', String(validated.width),
      '--depth-mm', String(validated.depth),
      '--min-width-mm', String(minFeatureWidth),
      '--roi', [validated.roi.x, validated.roi.y, validated.roi.width, validated.roi.height].join(','),
      '--min-fidelity', String(validated.minFidelity),
    ], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30000 });
    return JSON.parse(await readFile(outputPath, 'utf8'));
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) throw error;
    const details = String(error?.stderr ?? error?.message ?? '').replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`OpenCV细节提取失败${details ? `：${details}` : ''}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function safeSpec(input) {
  return {
    image: { name: input.image.name ?? 'detail.png', mime: input.image.mime },
    dimensions: { ...input.dimensions },
    roi: { ...input.roi },
    profileId: input.profileId,
    constraints: { ...input.constraints },
  };
}

export async function inspectDetail(input) {
  const validated = validateInput(input);
  const detail = await extract(input, validated);
  const candidateId = candidateHash(input, { enhance: true, reliefHeight: validated.reliefHeight, minFeatureWidth: validated.minFeatureWidth });
  const grid = meshGridSize(validated, detail.enhancedMask.width, detail.enhancedMask.height, validated.minFeatureWidth);
  const meshMask = maskGridFromContours(detail.contours, detail.enhancedMask.width, detail.enhancedMask.height, grid.width, grid.height);
  const fidelity = fidelityToGrid(detail.targetContours, detail.targetMask.width, detail.targetMask.height, meshMask, grid.width, grid.height);
  const meshTopology = maskTopology(meshMask, grid.width, grid.height);
  const stepX = validated.width / grid.width;
  const stepY = validated.depth / grid.height;
  const featureResolutionPass = Math.max(stepX, stepY) <= validated.minFeatureWidth / 2;
  const meshTopologyPreserved = meshTopology.components === detail.enhancedTopology.components && meshTopology.holes === detail.enhancedTopology.holes;
  const warnings = [...detail.warnings];
  if (fidelity < validated.minFidelity) warnings.push(`最终网格掩码IoU ${fidelity.toFixed(3)}低于要求${validated.minFidelity.toFixed(3)}`);
  if (!featureResolutionPass) warnings.push('网格步长不足以表达请求的最小特征宽度');
  if (!meshTopologyPreserved) warnings.push('最终网格改变了增强掩码的组件或孔洞');
  return {
    candidateId,
    spec: safeSpec(input),
    detail: {
      ...detail,
      morphologyFidelity: detail.fidelity,
      fidelity: Number(fidelity.toFixed(6)),
      meshGrid: { width: grid.width, height: grid.height, cellSizeMm: [stepX, stepY] },
      meshTopology,
      baseZ: validated.baseThickness,
      reliefHeight: validated.reliefHeight,
      highestZ: validated.baseThickness + validated.reliefHeight,
    },
    checks: [
      { name: 'input-dimensions', status: 'pass', detail: '尺寸、ROI和特征宽度在支持范围内' },
      { name: 'detail-fidelity', status: fidelity >= validated.minFidelity ? 'pass' : 'fail', detail: `最终网格掩码IoU ${fidelity.toFixed(4)}，要求至少${validated.minFidelity}` },
      { name: 'topology-preserved', status: detail.topologyPreserved ? 'pass' : 'fail', detail: `目标组件/孔 ${detail.targetTopology.components}/${detail.targetTopology.holes}；增强后 ${detail.enhancedTopology.components}/${detail.enhancedTopology.holes}` },
      { name: 'mesh-topology', status: meshTopologyPreserved ? 'pass' : 'fail', detail: `增强掩码组件/孔 ${detail.enhancedTopology.components}/${detail.enhancedTopology.holes}；网格 ${meshTopology.components}/${meshTopology.holes}` },
      { name: 'mesh-feature-resolution', status: featureResolutionPass ? 'pass' : 'fail', detail: `网格单元 ${stepX.toFixed(4)}×${stepY.toFixed(4)}mm` },
    ],
    warnings,
  };
}

function binaryStl(positions) {
  if (!positions.length || positions.length % 9) throw new Error('STL三角网格为空或格式无效');
  const triangleCount = positions.length / 9;
  const output = Buffer.alloc(84 + triangleCount * 50);
  output.write('PhotoCAD detail relief', 0, 'ascii');
  output.writeUInt32LE(triangleCount, 80);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const source = triangle * 9;
    const ax = positions[source + 3] - positions[source];
    const ay = positions[source + 4] - positions[source + 1];
    const az = positions[source + 5] - positions[source + 2];
    const bx = positions[source + 6] - positions[source];
    const by = positions[source + 7] - positions[source + 1];
    const bz = positions[source + 8] - positions[source + 2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) { nx /= length; ny /= length; nz /= length; }
    const offset = 84 + triangle * 50;
    output.writeFloatLE(nx, offset);
    output.writeFloatLE(ny, offset + 4);
    output.writeFloatLE(nz, offset + 8);
    for (let vertex = 0; vertex < 9; vertex++) output.writeFloatLE(positions[source + vertex], offset + 12 + vertex * 4);
    output.writeUInt16LE(0, offset + 48);
  }
  return output;
}

function maskGridFromContours(contours, sourceWidth, sourceHeight, gridWidth, gridHeight) {
  const mask = new Uint8Array(gridWidth * gridHeight);
  const fillPolygon = (points, value) => {
    const polygon = points.map(([x, y]) => [
      (x + 0.5) * gridWidth / sourceWidth,
      gridHeight - (y + 0.5) * gridHeight / sourceHeight,
    ]);
    for (let row = 0; row < gridHeight; row++) {
      const scanY = row + 0.5;
      const intersections = [];
      for (let edge = 0; edge < polygon.length; edge++) {
        const [x1, y1] = polygon[edge];
        const [x2, y2] = polygon[(edge + 1) % polygon.length];
        if ((y1 <= scanY && scanY < y2) || (y2 <= scanY && scanY < y1)) {
          intersections.push(x1 + (scanY - y1) * (x2 - x1) / (y2 - y1));
        }
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i + 1 < intersections.length; i += 2) {
        const start = Math.max(0, Math.ceil(intersections[i] - 0.5));
        const end = Math.min(gridWidth, Math.ceil(intersections[i + 1] - 0.5));
        for (let column = start; column < end; column++) mask[row * gridWidth + column] = value;
      }
    }
  };
  for (const contour of contours) {
    fillPolygon(contour.outer, 1);
    for (const hole of contour.holes) fillPolygon(hole, 0);
  }
  return mask;
}

function rasterReliefMesh(mask, gridWidth, gridHeight, width, depth, baseThickness, reliefHeight) {
  const vertices = [];
  const vertexIds = new Map();
  const faces = [];
  const zValues = [0, baseThickness, baseThickness + reliefHeight];
  const xStep = width / gridWidth;
  const yStep = depth / gridHeight;
  const vertex = (ix, iy, iz) => {
    const key = `${ix},${iy},${iz}`;
    let index = vertexIds.get(key);
    if (index == null) {
      index = vertices.length;
      vertexIds.set(key, index);
      vertices.push([
        Math.round((ix * xStep - width / 2) * 1000) / 1000,
        Math.round((iy * yStep - depth / 2) * 1000) / 1000,
        Math.round(zValues[iz] * 1000) / 1000,
      ]);
    }
    return index;
  };
  const quad = (a, b, c, d) => faces.push([vertex(...a), vertex(...b), vertex(...c), vertex(...d)]);
  const raised = (ix, iy) => mask[iy * gridWidth + ix] !== 0;

  for (let iy = 0; iy < gridHeight; iy++) {
    for (let ix = 0; ix < gridWidth; ix++) {
      quad([ix, iy, 0], [ix, iy + 1, 0], [ix + 1, iy + 1, 0], [ix + 1, iy, 0]);
      const top = raised(ix, iy) ? 2 : 1;
      quad([ix, iy, top], [ix + 1, iy, top], [ix + 1, iy + 1, top], [ix, iy + 1, top]);
    }
  }

  for (let iy = 0; iy < gridHeight; iy++) {
    quad([0, iy, 0], [0, iy, 1], [0, iy + 1, 1], [0, iy + 1, 0]);
    quad([gridWidth, iy, 0], [gridWidth, iy + 1, 0], [gridWidth, iy + 1, 1], [gridWidth, iy, 1]);
  }
  for (let ix = 0; ix < gridWidth; ix++) {
    quad([ix, 0, 0], [ix + 1, 0, 0], [ix + 1, 0, 1], [ix, 0, 1]);
    quad([ix, gridHeight, 0], [ix, gridHeight, 1], [ix + 1, gridHeight, 1], [ix + 1, gridHeight, 0]);
  }

  for (let iy = 0; iy < gridHeight; iy++) {
    for (let ix = 0; ix < gridWidth; ix++) {
      if (!raised(ix, iy)) continue;
      if (ix === 0 || !raised(ix - 1, iy)) quad([ix, iy, 1], [ix, iy, 2], [ix, iy + 1, 2], [ix, iy + 1, 1]);
      if (ix + 1 === gridWidth || !raised(ix + 1, iy)) quad([ix + 1, iy, 1], [ix + 1, iy + 1, 1], [ix + 1, iy + 1, 2], [ix + 1, iy, 2]);
      if (iy === 0 || !raised(ix, iy - 1)) quad([ix, iy, 1], [ix + 1, iy, 1], [ix + 1, iy, 2], [ix, iy, 2]);
      if (iy + 1 === gridHeight || !raised(ix, iy + 1)) quad([ix, iy + 1, 1], [ix, iy + 1, 2], [ix + 1, iy + 1, 2], [ix + 1, iy + 1, 1]);
    }
  }

  const positions = [];
  for (const face of faces) {
    const a = vertices[face[0]], b = vertices[face[1]], c = vertices[face[2]], d = vertices[face[3]];
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  const raisedCells = mask.reduce((sum, value) => sum + value, 0);
  return { positions, raisedCells, gridWidth, gridHeight, voxelAreaMm2: xStep * yStep };
}

function maskTopology(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const queue = new Uint32Array(mask.length);
  const countValueComponents = (value, connectivity) => {
    visited.fill(0);
    let components = 0;
    for (let start = 0; start < mask.length; start++) {
      if (visited[start] || (mask[start] ? 1 : 0) !== value) continue;
      components++;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;
      let touchesBorder = false;
      while (head < tail) {
        const current = queue[head++];
        const x = current % width;
        const y = Math.floor(current / width);
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
        const neighbors = connectivity === 8
          ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
          : [[0, -1], [-1, 0], [1, 0], [0, 1]];
        for (const [dx, dy] of neighbors) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (visited[next] || (mask[next] ? 1 : 0) !== value) continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
      if (value === 0 && touchesBorder) components--;
    }
    return components;
  };
  return { components: countValueComponents(1, 8), holes: countValueComponents(0, 4) };
}

function edgeIncidence(positions) {
  const counts = new Map();
  const vertex = (offset) => positions.slice(offset, offset + 3).map(value => Number(value.toFixed(6)).toFixed(6)).join(',');
  for (let i = 0; i < positions.length; i += 9) {
    const triangle = [vertex(i), vertex(i + 3), vertex(i + 6)];
    for (let edge = 0; edge < 3; edge++) {
      const key = [triangle[edge], triangle[(edge + 1) % 3]].sort().join('|');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function modelFor(input, validated, options, extracted, candidateId) {
  const grid = options.enhance
    ? meshGridSize(validated, extracted.enhancedMask.width, extracted.enhancedMask.height, validated.minFeatureWidth)
    : { width: 1, height: 1 };
  const gridWidth = grid.width;
  const gridHeight = grid.height;
  let reliefMask = new Uint8Array(1);
  if (options.enhance) {
    const sourceWidth = extracted.enhancedMask.width;
    const sourceHeight = extracted.enhancedMask.height;
    reliefMask = maskGridFromContours(extracted.contours, sourceWidth, sourceHeight, gridWidth, gridHeight);
  }
  const raster = rasterReliefMesh(
    reliefMask,
    gridWidth,
    gridHeight,
    validated.width,
    validated.depth,
    validated.baseThickness,
    options.enhance ? validated.reliefHeight : 0,
  );
  const positions = raster.positions;
  const mesh = { positions };
  const counts = edgeIncidence(positions);
  const nonManifoldEdgeCount = [...counts.values()].filter(count => count !== 2).length;
  const baseVolume = Math.abs(measurements.measureVolume(cuboid({ size: [validated.width, validated.depth, validated.baseThickness] })));
  const reliefVolume = raster.raisedCells * raster.voxelAreaMm2 * (options.enhance ? validated.reliefHeight : 0);
  const volume = baseVolume + reliefVolume;
  const rasterTopology = options.enhance ? maskTopology(reliefMask, gridWidth, gridHeight) : { components: 0, holes: 0 };
  const meshFidelity = options.enhance ? fidelityToGrid(extracted.targetContours, extracted.targetMask.width, extracted.targetMask.height, reliefMask, gridWidth, gridHeight) : 1;
  const meshTopologyPreserved = !options.enhance || (rasterTopology.components === extracted.enhancedTopology.components && rasterTopology.holes === extracted.enhancedTopology.holes);
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      bounds[axis] = Math.min(bounds[axis], positions[i + axis]);
      bounds[axis + 3] = Math.max(bounds[axis + 3], positions[i + axis]);
    }
  }
  const checks = [
    { name: 'closed-mesh', status: nonManifoldEdgeCount === 0 ? 'pass' : 'fail', detail: `${nonManifoldEdgeCount}条边的三角面邻接数不等于2` },
    { name: 'exterior-bounds', status: Math.abs(bounds[0] + validated.width / 2) <= 0.001 && Math.abs(bounds[1] + validated.depth / 2) <= 0.001 && Math.abs(bounds[3] - validated.width / 2) <= 0.001 && Math.abs(bounds[4] - validated.depth / 2) <= 0.001 ? 'pass' : 'fail', detail: '底板外边界匹配输入宽深，数值容差1e-3mm' },
    { name: 'base-thickness', status: Math.abs(bounds[2]) <= 0.001 && Math.abs(bounds[5] - (validated.baseThickness + (options.enhance ? validated.reliefHeight : 0))) <= 0.002 ? 'pass' : 'fail', detail: `模型Z范围 ${bounds[2].toFixed(4)}～${bounds[5].toFixed(4)}mm` },
    { name: 'raised-relief', status: options.enhance ? (raster.raisedCells > 0 ? 'pass' : 'fail') : 'pass', detail: options.enhance ? `图案为真实挤出几何，底部z=${validated.baseThickness}mm` : 'baseline仅包含平板，无浮雕几何' },
  ];
  const warnings = [...extracted.warnings];
  if (options.enhance) {
    const stepX = validated.width / gridWidth;
    const stepY = validated.depth / gridHeight;
    const resolutionPass = Math.max(stepX, stepY) <= validated.minFeatureWidth / 2;
    checks.push({ name: 'mesh-feature-resolution', status: resolutionPass ? 'pass' : 'fail', detail: `网格单元 ${stepX.toFixed(4)}×${stepY.toFixed(4)}mm；需小于等于最小特征宽度的一半` });
    checks.push({ name: 'mesh-topology', status: meshTopologyPreserved ? 'pass' : 'fail', detail: `增强掩码组件/孔 ${extracted.enhancedTopology.components}/${extracted.enhancedTopology.holes}；网格 ${rasterTopology.components}/${rasterTopology.holes}` });
    checks.push({ name: 'detail-fidelity', status: meshFidelity >= validated.minFidelity ? 'pass' : 'fail', detail: `最终网格掩码IoU ${meshFidelity.toFixed(4)}，要求至少${validated.minFidelity}` });
    if (!resolutionPass) warnings.push('网格分辨率不足以表达请求的最小特征宽度，请降低尺寸或提高最小特征宽度');
    if (!meshTopologyPreserved) warnings.push('浮雕网格分辨率改变了字形组件或孔洞，请放大尺寸或降低细节复杂度');
    if (meshFidelity < validated.minFidelity) warnings.push(`最终网格保真IoU ${meshFidelity.toFixed(3)}低于要求${validated.minFidelity.toFixed(3)}`);
    if (!raster.raisedCells) warnings.push('增强轮廓未能映射到网格单元，无法生成凸起几何');
  }
  if (options.enhance) {
    checks.push({ name: 'morphology-fidelity', status: extracted.fidelity >= validated.minFidelity ? 'pass' : 'fail', detail: `形态学掩码IoU ${extracted.fidelity}，要求至少${validated.minFidelity}` });
    checks.push({ name: 'topology-preserved', status: extracted.topologyPreserved ? 'pass' : 'fail', detail: `目标组件/孔 ${extracted.targetTopology.components}/${extracted.targetTopology.holes}；增强后 ${extracted.enhancedTopology.components}/${extracted.enhancedTopology.holes}` });
  }
  return {
    result: {
      candidateId,
      spec: safeSpec(input),
      mesh,
      metrics: {
        volumeMm3: volume,
        baselineVolumeMm3: baseVolume,
        reliefVolumeMm3: reliefVolume,
        widthMm: validated.width,
        depthMm: validated.depth,
        baseThicknessMm: validated.baseThickness,
        maximumZMm: bounds[5],
        reliefCells: raster.raisedCells,
      },
      detail: {
        ...extracted,
        morphologyFidelity: extracted.fidelity,
        fidelity: Number(meshFidelity.toFixed(6)),
        modelingMethod: 'enhanced binary mask converted to a bounded pixel-cell surface mesh with real raised Z volume',
        limitations: [
          '仅支持用户确认ROI内的高对比平面字样或简单徽标；图像颜色和纹理不会变成几何。',
          '网格单元造成小尺度台阶；fidelity、孔洞拓扑和网格分辨率需全部通过后再切片。',
          '没有实物打印或载荷测试，不能据此承诺保真打印、强度或可承重。',
        ],
        baseZ: validated.baseThickness,
        reliefHeight: options.enhance ? validated.reliefHeight : 0,
        highestZ: bounds[5],
        meshGrid: { width: gridWidth, height: gridHeight, cellSizeMm: [validated.width / gridWidth, validated.depth / gridHeight] },
        meshTopology: rasterTopology,
      },
      checks,
      warnings: options.enhance ? [...warnings, '浮雕轮廓由受限网格单元构成，边缘会有小尺度台阶；未验证实物打印或承重。'] : warnings,
    },
  };
}

function validateOptions(options, validated) {
  if (options == null) options = {};
  if (typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options必须是对象');
  const allowed = new Set(['enhance', 'reliefHeight', 'minFeatureWidth']);
  if (Object.keys(options).some(key => !allowed.has(key))) throw new TypeError('options仅支持enhance、reliefHeight、minFeatureWidth');
  const enhance = options.enhance ?? false;
  if (typeof enhance !== 'boolean') throw new TypeError('enhance必须是布尔值');
  const reliefHeight = finiteNumber(options.reliefHeight ?? validated.reliefHeight, 'reliefHeight', 0.2, validated.maxReliefHeight);
  const minFeatureWidth = finiteNumber(options.minFeatureWidth ?? validated.minFeatureWidth, 'minFeatureWidth', 0.4, 3);
  return { enhance, reliefHeight, minFeatureWidth };
}

export async function buildDetail(input, options = {}) {
  const validated = validateInput(input);
  const normalizedOptions = validateOptions(options, validated);
  const extracted = await extract(input, validated, normalizedOptions.minFeatureWidth);
  const candidateId = candidateHash(input, normalizedOptions);
  const { result } = modelFor(input, { ...validated, reliefHeight: normalizedOptions.reliefHeight, minFeatureWidth: normalizedOptions.minFeatureWidth }, normalizedOptions, extracted, candidateId);
  const stl = binaryStl(result.mesh.positions);
  const directory = path.join(jobsRoot, candidateId);
  await mkdir(directory, { recursive: true });
  const stlPath = path.join(directory, `${candidateId}.stl`);
  await writeFile(stlPath, stl);
  return { ...result, stlPath, artifactSha256: createHash('sha256').update(stl).digest('hex') };
}

export async function exportDetailStl(input, options = {}) {
  const built = await buildDetail(input, options);
  return readFile(built.stlPath);
}
