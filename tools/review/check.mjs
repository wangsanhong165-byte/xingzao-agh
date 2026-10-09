import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPoseCandidate } from '../../src/pose-geometry.mjs';
import { parseGcodeSegments, parseSlicerMetrics } from '../../src/slicer.mjs';
import { auditCriticalFeatures } from '../../src/critical-feature-audit.mjs';
import { auditRodToolpathContinuity } from '../../src/rod-toolpath-continuity.mjs';
import { normalizeRepairSpec, repairRadiusOptions } from '../../src/local-repair-service.mjs';

const MANIFEST_SCHEMA = 'xingzao-review-bundle/v1';
const CASES_SCHEMA = 'xingzao-cached-cases/v1';
const MAX_FILES = 512;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 190 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')
    || value.startsWith('/') || /^[A-Za-z]:/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const parts = value.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error(`${label} must be a safe relative path`);
  return parts.join('/');
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readRegularInside(root, relative, label, maxBytes) {
  const segments = relative.split('/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`${label} must resolve through regular non-link files inside the bundle`);
    }
  }
  const absolute = path.resolve(root, ...segments);
  if (!isInside(root, absolute)) throw new Error(`${label} escapes the bundle directory`);
  const resolved = await realpath(absolute);
  if (!isInside(root, resolved)) throw new Error(`${label} resolves outside the bundle directory`);
  const bytes = await readFile(resolved);
  if (bytes.length > maxBytes) throw new Error(`${label} exceeds the allowed size`);
  return bytes;
}

function finitePoint3(point) {
  return Array.isArray(point) && point.length === 3 && point.every(value => typeof value === 'number' && Number.isFinite(value));
}

function requireSha(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function gcodeModelBounds(gcode) {
  const parsed = parseGcodeSegments(gcode);
  if (parsed.unsupportedArcMoves > 0) throw new Error('G-code contains unsupported arc extrusion moves');
  const modelSegments = parsed.segments.filter(segment => segment.motionType === 'extrusion' && segment.role === 'MODEL');
  if (!modelSegments.length) throw new Error('G-code has no MODEL extrusion segments');
  const bounds = { xMin: Infinity, yMin: Infinity, zMin: Infinity, xMax: -Infinity, yMax: -Infinity, zMax: -Infinity };
  for (const segment of modelSegments) for (const point of [segment.start, segment.end]) {
    for (const axis of ['x', 'y', 'z']) {
      if (typeof point[axis] !== 'number' || !Number.isFinite(point[axis])) throw new Error('G-code MODEL coordinates must be finite');
      bounds[`${axis}Min`] = Math.min(bounds[`${axis}Min`], point[axis]);
      bounds[`${axis}Max`] = Math.max(bounds[`${axis}Max`], point[axis]);
    }
  }
  return { parsed, modelSegments, bounds, center: { x: (bounds.xMin + bounds.xMax) / 2, y: (bounds.yMin + bounds.yMax) / 2 } };
}

function close(actual, expected, tolerance) {
  return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function verifiedPlacement(proof, placementOffsetMm, gcodeBounds) {
  requireObject(placementOffsetMm, 'placementOffsetMm');
  for (const axis of ['x', 'y', 'z']) if (typeof placementOffsetMm[axis] !== 'number' || !Number.isFinite(placementOffsetMm[axis])) {
    throw new Error('placementOffsetMm must contain finite XYZ offsets');
  }
  const printBounds = proof.printBoundsMm;
  if (!Array.isArray(printBounds) || printBounds.length !== 2 || !printBounds.every(finitePoint3)) throw new Error('Recomputed pose print bounds are invalid');
  if (proof.rigidTransformVerified !== true || !close((printBounds[0][0] + printBounds[1][0]) / 2, 0, 1e-5)
    || !close((printBounds[0][1] + printBounds[1][1]) / 2, 0, 1e-5)) throw new Error('Recomputed pose proof does not verify rigid transform and source print XY center at zero');
  const expectedOffset = {
    x: Number((90 - (printBounds[0][0] + printBounds[1][0]) / 2).toFixed(4)),
    y: Number((90 - (printBounds[0][1] + printBounds[1][1]) / 2).toFixed(4)),
    z: Number(Math.max(0, -printBounds[0][2]).toFixed(4)),
  };
  if (['x', 'y', 'z'].some(axis => !close(placementOffsetMm[axis], expectedOffset[axis], 1e-4))) {
    throw new Error('Declared placement offset does not match recomputed pose placement');
  }
  if (!close(gcodeBounds.center.x, 90, 0.6) || !close(gcodeBounds.center.y, 90, 0.6)
    || !close(gcodeBounds.center.x, placementOffsetMm.x, 0.6) || !close(gcodeBounds.center.y, placementOffsetMm.y, 0.6)) {
    throw new Error('G-code MODEL extrusion XY bounds are not centered at the virtual bed center and declared offset');
  }
  return true;
}

async function loadJSON(files, relative, label) {
  const bytes = files.get(relative);
  if (!bytes) throw new Error(`${label} is missing from the bundle manifest`);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

function requireCasePath(value, label, files) {
  const relative = safeRelative(value, label);
  if (!relative.startsWith('case/')) throw new Error(`${label} must be under case/`);
  if (!files.has(relative)) throw new Error(`${label} is not listed in the bundle manifest`);
  return relative;
}

function compareAudit(expected, ...audits) {
  if (typeof expected !== 'boolean') throw new Error('expectedToolpathFeasible must be boolean');
  if(audits.some(audit=>audit?.verified!==true||typeof audit.passed!=='boolean'))throw new Error('Case audit is unverified; unknown evidence cannot count as a negative result');
  const actual = audits.every(audit => audit.passed === true);
  return { actual, expected, matches: actual === expected };
}

async function recheckCase(record, files) {
  requireObject(record, 'case');
  if (typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(record.id)) throw new Error('case id is invalid');
  if (typeof record.poseId !== 'string') throw new Error(`case ${record.id} poseId is invalid`);
  const input = Object.fromEntries([
    ['source', 'source STL'], ['originalSource', 'original source STL'], ['posed', 'posed STL'],
    ['gcode', 'G-code'], ['probes', 'current probes'], ['originalProbes', 'original probes'],
  ].map(([key, label]) => [key, requireCasePath(record[key], `case ${record.id} ${label} path`, files)]));
  const sourceBytes = files.get(input.source);
  const originalSourceBytes = files.get(input.originalSource);
  const posedBytes = files.get(input.posed);
  const rawSha256 = sha256(sourceBytes);
  const originalSourceSha256 = requireSha(record.originalSourceSha256, `case ${record.id} originalSourceSha256`);
  if (sha256(originalSourceBytes) !== originalSourceSha256) throw new Error(`case ${record.id} original source SHA-256 mismatch`);
  const posed = createPoseCandidate({ sourceBuffer: sourceBytes, poseId: record.poseId });
  const posedSha256 = sha256(posedBytes);
  if (posed.proof.sourceSha256 !== rawSha256 || posed.proof.candidateSha256 !== posedSha256) throw new Error(`case ${record.id} recomputed pose candidate SHA-256 mismatch`);
  const currentProbes = await loadJSON(files, input.probes, `case ${record.id} current probes`);
  const originalProbes = await loadJSON(files, input.originalProbes, `case ${record.id} original probes`);
  if (currentProbes?.sourceSha256 !== rawSha256) throw new Error(`case ${record.id} current probes are not SHA-bound to raw source`);
  if (originalProbes?.sourceSha256 !== originalSourceSha256) throw new Error(`case ${record.id} original probes are not SHA-bound to original source`);
  const gcode = files.get(input.gcode).toString('utf8');
  const bounds = gcodeModelBounds(gcode);
  const placementVerified = verifiedPlacement(posed.proof, record.placementOffsetMm, bounds);
  const auditOptions = { sourceToPrintMatrix4: posed.proof.sourceToPrintMatrix4, placementOffsetMm: record.placementOffsetMm, placementVerified };
  const currentAudit = auditCriticalFeatures(gcode, { probes: currentProbes, ...auditOptions });
  const originalAudit = auditCriticalFeatures(gcode, { probes: originalProbes, ...auditOptions });
  const continuityAudit = auditRodToolpathContinuity(gcode, {
    centerLineMm: record.centerLineMm,
    sourceToPrintMatrix4: posed.proof.sourceToPrintMatrix4,
    placementOffsetMm: record.placementOffsetMm,
    placementVerified,
  });
  const auditComparison = compareAudit(record.expectedToolpathFeasible, currentAudit, originalAudit, continuityAudit);
  if (!auditComparison.matches) throw new Error(`case ${record.id} expectedToolpathFeasible mismatch`);
  return {
    id: record.id,
    sourceSha256: rawSha256,
    originalSourceSha256,
    posedSha256,
    poseId: record.poseId,
    placement: { verified: placementVerified, modelExtrusionBoundsMm: bounds.bounds, observedCenterMm: bounds.center, declaredOffsetMm: record.placementOffsetMm },
    metrics: parseSlicerMetrics(gcode),
    audits: { currentFeatures: currentAudit, originalFeatures: originalAudit, rodContinuity: continuityAudit },
    toolpathFeasible: auditComparison.actual,
  };
}

export async function checkReviewBundle(directory = process.cwd()) {
  if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('bundle directory must be a non-empty path');
  const requestedRoot = path.resolve(directory);
  const rootInfo = await lstat(requestedRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('bundle path must be an existing non-link directory');
  const bundleRoot = await realpath(requestedRoot);
  const manifestInfo = await lstat(path.join(bundleRoot, 'bundle-manifest.json')).catch(() => null);
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 4 * 1024 * 1024) throw new Error('bundle-manifest.json must be a regular file no larger than 4 MiB');
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(bundleRoot, 'bundle-manifest.json'), 'utf8')); }
  catch { throw new Error('bundle-manifest.json is not valid JSON'); }
  requireObject(manifest, 'bundle manifest');
  if (manifest.schema !== MANIFEST_SCHEMA || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_FILES) throw new Error('bundle manifest schema or file count is invalid');
  requireObject(manifest.summary, 'bundle summary');
  requireObject(manifest.claims, 'bundle claims');
  const files = new Map();
  const seen = new Set();
  let totalBytes = 0;
  for (const entry of manifest.files) {
    requireObject(entry, 'manifest file entry');
    const relative = safeRelative(entry.path, 'manifest path');
    if (typeof entry.kind !== 'string' || entry.kind.length === 0) throw new Error(`manifest file kind is invalid: ${relative}`);
    const duplicateKey = process.platform === 'win32' ? relative.toLocaleLowerCase('en-US') : relative;
    if (seen.has(duplicateKey)) throw new Error(`duplicate manifest path: ${relative}`);
    seen.add(duplicateKey);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES) throw new Error(`manifest file byte size is invalid or over 25 MiB: ${relative}`);
    const digest = requireSha(entry.sha256, `manifest SHA-256 for ${relative}`);
    totalBytes += entry.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('bundle listed file bytes exceed 190 MiB');
    const bytes = await readRegularInside(bundleRoot, relative, `manifest file ${relative}`, MAX_FILE_BYTES);
    if (bytes.length !== entry.bytes) throw new Error(`manifest file byte size mismatch: ${relative}`);
    if (sha256(bytes) !== digest) throw new Error(`manifest file SHA-256 mismatch: ${relative}`);
    files.set(relative, bytes);
  }
  const casePath = requireCasePath('case/cases.json', 'cases metadata path', files);
  const dataset = await loadJSON(files, casePath, 'case metadata');
  requireObject(dataset, 'case metadata');
  if (dataset.schema !== CASES_SCHEMA || !Array.isArray(dataset.cases) || dataset.cases.length < 1 || dataset.cases.length > 64) throw new Error('case metadata schema or case count is invalid');
  const ids = new Set();
  const caseResults = [];
  for (const record of dataset.cases) {
    if (ids.has(record?.id)) throw new Error('case ids must be unique');
    ids.add(record?.id);
    caseResults.push(await recheckCase(record, files));
  }
  requireObject(dataset.budgetFailure, 'budgetFailure');
  if (!Array.isArray(dataset.budgetFailure.expectedOptions)) throw new Error('budgetFailure.expectedOptions must be an array');
  let actualOptions;
  try {
    const spec = normalizeRepairSpec(dataset.budgetFailure.spec);
    actualOptions = repairRadiusOptions(dataset.budgetFailure.inspection, spec);
  } catch { throw new Error('budgetFailure inspection or repair spec is invalid'); }
  if (JSON.stringify(actualOptions) !== JSON.stringify(dataset.budgetFailure.expectedOptions)) throw new Error('budgetFailure expectedOptions mismatch');
  return {
    valid: true,
    schema: MANIFEST_SCHEMA,
    fileCount: manifest.files.length,
    totalBytes,
    cases: caseResults,
    budgetFailure: { actualOptions, expectedOptions: dataset.budgetFailure.expectedOptions },
    scope: 'cached-file-bindings-and-G-code-reaudit',
    claims: {
      sourceMembershipRecomputed: false,
      geometryBudgetRecomputed: false,
      liveModelRequestVerified: false,
      physicalPrintVerified: false,
    },
  };
}

function parseArgs(args) {
  let bundle = process.cwd();
  let json = false;
  let sawBundle = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--json') { json = true; continue; }
    if (args[index] !== '--bundle' || sawBundle || !args[index + 1] || args[index + 1].startsWith('--')) throw new TypeError('usage: node tools/review/check.mjs [--bundle directory] [--json]');
    bundle = args[++index];
    sawBundle = true;
  }
  return { bundle, json };
}

function humanReport(result) {
  const rows = [
    `Review bundle: ${result.valid ? 'valid' : 'blocked'} (${result.fileCount} listed files, ${result.totalBytes} bytes)`,
    `Scope: ${result.scope}`,
    ...result.cases.map(item => `Case ${item.id} (${item.poseId}): toolpath ${item.toolpathFeasible ? 'feasible' : 'infeasible'}; current features=${item.audits.currentFeatures.passed}, original features=${item.audits.originalFeatures.passed}, rod continuity=${item.audits.rodContinuity.passed}`),
    `Budget failure options: ${JSON.stringify(result.budgetFailure.actualOptions)}`,
    `Claims: source membership recomputed=${result.claims.sourceMembershipRecomputed}, geometry budget recomputed=${result.claims.geometryBudgetRecomputed}, live model request verified=${result.claims.liveModelRequestVerified}, physical print verified=${result.claims.physicalPrintVerified}`,
    'Cached source-bound probes were reused; probe membership was not regenerated from mesh geometry.',
  ];
  return rows.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { bundle, json } = parseArgs(process.argv.slice(2));
    const result = await checkReviewBundle(bundle);
    process.stdout.write(`${json ? JSON.stringify(result, null, 2) : humanReport(result)}\n`);
  } catch (error) {
    process.stderr.write(`Review bundle check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
