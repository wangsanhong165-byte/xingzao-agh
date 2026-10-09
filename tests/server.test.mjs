import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../src/server.mjs').catch(() => ({}));

async function withApp(run, overrides = {}) {
  assert.equal(typeof module.createApp, 'function', 'HTTP 服务尚未实现');
  const server = module.createApp({
    getStatus: async () => ({ aghAvailable: true, modelConfigured: false, model: 'agnes-3.0-flash' }),
    analyze: async () => { const error = new Error('请先在 AGH 配置 Agnes 模型'); error.code = 'MODEL_NOT_CONFIGURED'; error.status = 503; throw error; },
    generate: (spec) => ({ spec, mesh: { positions: [0, 0, 0] }, metrics: { volumeMm3: 12 } }),
    exportMesh: () => Buffer.from('mesh'),
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('状态接口明确告知没有配置模型', async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/api/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.modelConfigured, false);
    assert.equal(body.model, 'agnes-3.0-flash');
  });
});

test('未配置模型不会返回伪造照片分析', async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/api/analyze`, { method: 'POST', body: JSON.stringify({ photos: [] }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'MODEL_NOT_CONFIGURED');
  });
});

test('几何参数错误以 400 返回而非静默生成示例', async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/api/model`, { method: 'POST', body: JSON.stringify({ spec: { type: 'plate' } }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /尺寸/);
  }, { generate() { throw new Error('尺寸必须为有限正数'); } });
});

test('无效 JSON 被拒绝', async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/api/model`, { method: 'POST', body: '{broken' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_JSON');
  });
});

test('STL 导出使用同一份 spec 与 options', async () => {
  const input = { spec: { type: 'plate', dimensions: { width: 80 } }, options: { lightweight: true } };
  await withApp(async (base) => {
    const response = await fetch(`${base}/api/export/stl`, { method: 'POST', body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.equal(await response.text(), 'mesh');
  }, { exportMesh(spec, options) { assert.deepEqual({ spec, options }, input); return Buffer.from('mesh'); } });
});

test('不提供任意工作区文件', async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/package.json`);
    assert.equal(response.status, 404);
  });
});

test('普通照片测量不要求模型 Key，并明确标注执行来源', async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/api/measure`, { method: 'POST', body: JSON.stringify({ widthMm: 80, thicknessMm: 6 }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).execution.mode, 'classical-vision');
  }, { measure: async (payload) => { assert.equal(payload.widthMm, 80); return { execution: { mode: 'classical-vision' } }; } });
});

test('Blender 三视图由实际渲染工具接口返回', async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/api/render`, { method: 'POST', body: JSON.stringify({ spec: { type: 'plate' }, options: { lightweight: false } }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).execution.mode, 'blender');
  }, { render: async (spec, options) => { assert.equal(spec.type, 'plate'); assert.equal(options.lightweight, false); return { execution: { mode: 'blender' } }; } });
});
