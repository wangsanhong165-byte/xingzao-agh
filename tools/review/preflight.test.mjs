import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreflightReport, parseMode, exitCodeForReport } from './preflight.mjs';

const complete = {
  runtime: { nodeVersion: 'v24.10.0', pythonAvailable: true, meshPackages: Object.fromEntries(['numpy', 'trimesh', 'rtree', 'manifold3d'].map(name => [name, { available: true, version: '1.0' }])) },
  slicer: { available: true, version: 'PrusaSlicer-2.9.6', profileAvailable: true },
  poseAgh: { ready: true }, repairAgh: { ready: true },
  hunyuan: { aghReady: true, engineConfigured: true, productionStatus: 'configured' },
};

test('offline readiness accepts mesh review without AGH or Hunyuan', () => {
  const report = buildPreflightReport('offline', { ...complete, poseAgh: { ready: false }, repairAgh: { ready: false }, hunyuan: { aghReady: false, engineConfigured: false, productionStatus: 'blocked' } });
  assert.equal(report.readiness.meshReview, 'ready');
  assert.equal(report.readiness.liveAgh, 'offline-only');
  assert.equal(report.readiness.hunyuanShape, 'offline-only');
  assert.equal(exitCodeForReport(report), 0);
});

test('live mode requires actual pose and repair AGH readiness', () => {
  const report = buildPreflightReport('live', { ...complete, repairAgh: { ready: false } });
  assert.equal(report.readiness.liveAgh, 'blocked');
  assert.equal(exitCodeForReport(report), 1);
});

test('Hunyuan is not ready from present files without production status', () => {
  const report = buildPreflightReport('shape', { ...complete, hunyuan: { aghReady: true, engineConfigured: true, productionStatus: 'unknown' } });
  assert.equal(report.readiness.hunyuanShape, 'blocked');
  assert.equal(exitCodeForReport(report), 1);
});

test('mode parser accepts only one supported mode', () => {
  assert.equal(parseMode(['--mode', 'offline']), 'offline');
  assert.throws(() => parseMode(['--mode', 'all']), /mode/);
  assert.throws(() => parseMode(['--mode', 'live', '--mode', 'shape']), /mode/);
});


test('offline collection does not inspect AGH credentials or Hunyuan', async () => {
  const calls = [];
  const report = await import('./preflight.mjs').then(({ collectPreflight }) => collectPreflight({ mode: 'offline', providers: {
    runtime: async () => (calls.push('runtime'), complete.runtime),
    slicer: async () => (calls.push('slicer'), complete.slicer),
    poseAgh: async () => (calls.push('poseAgh'), { ready: false }),
    repairAgh: async () => (calls.push('repairAgh'), { ready: false }),
    hunyuan: async () => (calls.push('hunyuan'), complete.hunyuan),
  } }));
  assert.deepEqual(calls.sort(), ['runtime', 'slicer']);
  assert.equal(report.readiness.meshReview, 'ready');
});





test('shape readiness requires mesh runtime and reports configuration only', () => {
  const missingRuntime = { ...complete, runtime: { ...complete.runtime, pythonAvailable: false }, hunyuan: { aghReady: true, engineConfigured: true, productionStatus: 'configured' } };
  const report = buildPreflightReport('shape', missingRuntime);
  assert.equal(report.overall, 'blocked');
  assert.equal(report.readiness.hunyuanShape, 'blocked');
  assert.equal(report.verification.inferenceVerified, false);
  assert.equal(report.verification.gpuExecutionVerified, false);
  assert.equal(report.verification.cleanMachineReproductionVerified, false);
});

test('shape configured result is explicit and does not claim inference verification', () => {
  const report = buildPreflightReport('shape', complete);
  assert.equal(report.overall, 'configured');
  assert.equal(report.readiness.hunyuanShape, 'configured');
  assert.equal(report.verification.inferenceVerified, false);
  assert.equal(report.verification.gpuExecutionVerified, false);
  assert.equal(report.verification.cleanMachineReproductionVerified, false);
});

test('live AGH readiness is based on accessors, not a model request', () => {
  const report = buildPreflightReport('live', complete);
  assert.equal(report.readiness.liveAgh, 'ready');
  assert.equal(report.verification.modelRequestVerified, false);
});

test('live manufacturing accepts installed pose and repair plugins without the legacy relief plugin', () => {
  const report = buildPreflightReport('live', {
    ...complete, poseAgh: { ready: true }, printAgh: { ready: false },
  });
  assert.equal(report.overall, 'ready');
  assert.equal(report.readiness.liveAgh, 'ready');
});

test('a legacy relief plugin cannot substitute for the required pose plugin', () => {
  const report = buildPreflightReport('live', {
    ...complete, poseAgh: { ready: false }, printAgh: { ready: true },
  });
  assert.equal(report.overall, 'blocked');
  assert.equal(report.readiness.liveAgh, 'blocked');
});
