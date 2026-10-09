import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../src/print-server.mjs').catch(() => ({}));

function fixtureStore({ coverage = .95, holeCount = 1, survivingHoles = 1, footprintVerified = true, missingGeometryChecks = false, sliceMode = 'actual-slicer' } = {}) {
  assert.equal(typeof module.PrintJobStore, 'function', '打印任务与候选验证门禁尚未实现');
  const geometry = {
    inspect: async () => ({ success: true, constraints: { minFidelity: .75 } }),
    build: async (_input, options) => ({ candidateId: options.enhance ? 'enhanced-1' : 'baseline-1', stlPath: 'fixture.stl', mesh: { positions: [0,0,0] }, metrics: { volumeMm3: options.enhance ? 101 : 100 }, checks: missingGeometryChecks ? [] : ['closed-mesh', 'exterior-bounds', 'base-thickness', 'raised-relief'].map(name => ({ name, status: 'pass' })), detail: { baseZ: 2, fidelity: 1, featureBoundsMm: [-10,-10,10,10] } }),
  };
  return new module.PrintJobStore({ geometry, slicer: {
    slice: async () => ({ gcodeText: 'fixture', gcodePath: 'fixture.gcode', execution: { mode: sliceMode }, metrics: { filamentG: 1 } }),
    analyze: async (_text, request) => ({ hasRaisedDetail: request.enhance === true, featureLayerCount: request.enhance ? 3 : 0, featureExtrusionLengthMm: request.enhance ? 40 : 0, checks: [] }),
  }, evaluator: { evaluate: async () => ({ evaluation: { mode: 'planar-toolpath-footprint', verified: footprintVerified }, targetCoverageFraction: coverage, spillFraction: .02, targetHoleCount: holeCount, survivingTargetHoleCount: survivingHoles, holeEvidence: { verified: true }, modelRaisedLayerCount: 3, modelAboveReliefLengthMm: 0, checks: [], warnings: [] }) }, persist: false });
}

test('没有切片与路径复核不能提交候选', async () => {
  const store = fixtureStore();
  const job = await store.create({ dimensions: { width: 40, depth: 30, baseThickness: 2 }, constraints: { minFidelity: .75 } });
  const built = await store.execute(job.id, 'build', { options: { enhance: true } });
  const result = await store.execute(job.id, 'submit', { candidateId: built.candidateId });
  assert.equal(result.success, false);
  assert.match(result.reason, /切片|复核/);
});

test('缺少明确闭合与尺寸检查时不能切片或提交', async () => {
  const store = fixtureStore({ missingGeometryChecks: true });
  const job = await store.create({ dimensions: { width: 40, depth: 30, baseThickness: 2 }, constraints: { minFidelity: .75 } });
  const built = await store.execute(job.id, 'build', { options: { enhance: true } });
  assert.equal(built.success, false);
  assert.equal((await store.execute(job.id, 'slice', { candidateId: built.candidateId })).success, false);
  assert.equal((await store.execute(job.id, 'submit', { candidateId: built.candidateId })).success, false);
});

test('模拟切片结果不能经由复核或提交成为真实切片证据', async () => {
  const store = fixtureStore({ sliceMode: 'preview-only' });
  const job = await store.create({ dimensions: { width: 40, depth: 30, baseThickness: 2 }, constraints: { minFidelity: .75 } });
  const built = await store.execute(job.id, 'build', { options: { enhance: true } });
  assert.equal((await store.execute(job.id, 'slice', { candidateId: built.candidateId })).success, false);
  assert.equal((await store.execute(job.id, 'verify', { candidateId: built.candidateId })).success, false);
  store.get(job.id).candidates[built.candidateId].verification = { success: true };
  assert.equal((await store.execute(job.id, 'submit', { candidateId: built.candidateId })).success, false);
});

test('同一候选生成、切片、复核后才能提交', async () => {
  const store = fixtureStore();
  const job = await store.create({ dimensions: { width: 40, depth: 30, baseThickness: 2 }, constraints: { minFidelity: .75 } });
  const built = await store.execute(job.id, 'build', { options: { enhance: true } });
  await store.execute(job.id, 'slice', { candidateId: built.candidateId });
  const verification = await store.execute(job.id, 'verify', { candidateId: built.candidateId });
  assert.equal(verification.success, true);
  const result = await store.execute(job.id, 'submit', { candidateId: built.candidateId });
  assert.equal(result.success, true);
  assert.equal(store.get(job.id).stage, 'submitted');
});

test('基线平板不应被当作细节保护成功', async () => {
  const store = fixtureStore();
  const job = await store.create({ dimensions: { width: 40, depth: 30, baseThickness: 2 }, constraints: { minFidelity: .75 } });
  const built = await store.execute(job.id, 'build', { options: { enhance: false } });
  await store.execute(job.id, 'slice', { candidateId: built.candidateId });
  const verification = await store.execute(job.id, 'verify', { candidateId: built.candidateId });
  assert.equal(verification.success, false);
  assert.match(verification.reason, /细节|挤出/);
});

test('不接受其他任务或不存在候选的提交', async () => {
  const store = fixtureStore();
  const job = await store.create({ dimensions: { width: 40, depth: 30, baseThickness: 2 }, constraints: { minFidelity: .75 } });
  const result = await store.execute(job.id, 'submit', { candidateId: 'not-a-candidate' });
  assert.equal(result.success, false);
  assert.match(result.reason, /候选/);
});

test('AGH 超时保留准确失败原因和独立执行元数据', async () => {
  const store = fixtureStore();
  const job = await store.create({});
  job.agentRunActive = true;
  await store.finish(job.id, { success: false, reason: 'AGH_RUN_TIMEOUT', execution: { mode: 'agh', model: 'deepseek/deepseek-v4.1-flash' } });
  const publicJob = store.publicJob(job);
  assert.equal(publicJob.stage, 'failed');
  assert.equal(publicJob.error, 'AGH_RUN_TIMEOUT');
  assert.equal(publicJob.execution.mode, 'agh');
  assert.equal(publicJob.agentRunActive, false);
  assert.equal(publicJob.accessToken, undefined);
});

test('AGH 声称结束但没有有效提交时不能算成功', async () => {
  const store = fixtureStore();
  const job = await store.create({});
  await store.finish(job.id, { success: true, agentOutput: 'Done', execution: { mode: 'agh' } });
  assert.equal(job.stage, 'incomplete');
  assert.match(job.error, /没有提交/);
});

test('命令工具也不能绕过任务访问令牌', async () => {
  const store = fixtureStore();
  const job = await store.create({});
  job.agentRunActive = true;
  const server = module.createPrintApp({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/print/tool/inspect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-print-task-access': 'invalid' }, body: JSON.stringify({ jobId: job.id }),
    });
    assert.equal(response.status, 403);
    assert.equal(job.events.length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('达到预算后拒绝更多模型工具调用', async () => {
  const store = fixtureStore();
  const job = await store.create({});
  for (let i = 0; i < 12; i++) await store.execute(job.id, 'inspect', {}, 'agh');
  const result = await store.execute(job.id, 'inspect', {}, 'agh');
  assert.equal(result.success, false);
  assert.match(result.reason, /预算/);
  assert.equal(job.events.length, 12);
});

for (const scenario of [
  { name: '局部有挤出但图案覆盖不足', options: { coverage: .2 } },
  { name: '图案覆盖足够但保护孔被封', options: { survivingHoles: 0 } },
  { name: 'role或线宽未验证', options: { footprintVerified: false } },
]) {
  test(`真实切片后${scenario.name}不能提交`, async () => {
    const store = fixtureStore(scenario.options);
    const job = await store.create({ dimensions: { width: 40, depth: 30, baseThickness: 2 }, constraints: { minFidelity: .75 } });
    const built = await store.execute(job.id, 'build', { options: { enhance: true } });
    await store.execute(job.id, 'slice', { candidateId: built.candidateId });
    const checked = await store.execute(job.id, 'verify', { candidateId: built.candidateId });
    assert.equal(checked.success, false);
    const submitted = await store.execute(job.id, 'submit', { candidateId: built.candidateId });
    assert.equal(submitted.success, false);
  });
}
