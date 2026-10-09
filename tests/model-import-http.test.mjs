import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import modeling from '@jscad/modeling';
import serializer from '@jscad/stl-serializer';
import { createPrintApp } from '../src/print-server.mjs';

test('HTTP model import serves the exact normalized STL and reports geometry-only scope', async () => {
  const source = Buffer.concat(serializer.serialize({ binary: true }, modeling.primitives.cuboid({ size: [10, 12, 15] })).map(chunk => Buffer.from(chunk)));
  const server = createPrintApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await fetch(`${base}/api/model-import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'cube.stl', mime: 'model/stl', dataBase64: source.toString('base64'), sourceUnits: 'target-scale', targetLongestEdgeMm: 23 }) });
    assert.equal(result.status, 200);
    const model = await result.json();
    assert.equal(model.validationScope.kind, 'geometry-only');
    assert.equal(model.normalizedStlPath, undefined, 'private server paths must stay private');
    assert.equal(model.printable, undefined, 'geometry-only checks cannot be labeled printable in the HTTP API');
    assert.equal(model.stlUrl, `/api/model-import/${model.candidateId}/stl`);
    const asset = await fetch(`${base}${model.stlUrl}`);
    assert.equal(asset.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'), model.normalizedStlSha256);
    assert.equal((await fetch(`${base}/api/model-import/${'0'.repeat(64)}/stl`)).status, 404);
    assert.equal((await fetch(`${base}/api/model-import/../state.json`)).status, 404);
    const foreign = await fetch(`${base}/api/model-import`, { method: 'POST', headers: { Origin: 'https://example.org', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(foreign.status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
