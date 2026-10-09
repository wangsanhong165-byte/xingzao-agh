import assert from 'node:assert/strict'
import { test } from 'node:test'
import { photoCadTools } from './index.mjs'

test('AGH plugin registers the complete Photo CAD image, verification, rendering, and submission tools', () => {
  const tools = new Map()
  photoCadTools.apply({ extension: () => ({ registerTool: (tool) => tools.set(tool.name, tool) }) })
  assert.deepEqual([...tools.keys()].sort(), [
    'photo_cad_read_photo',
    'photo_cad_render_views',
    'photo_cad_submit_result',
    'photo_cad_validate_geometry',
  ])
  for (const tool of tools.values()) {
    assert.equal(tool.parameters[Symbol.for('TypeBox.Kind')], 'Object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.execute, 'function')
    for (const key of ['isReadOnly', 'isDestructive', 'isConcurrencySafe', 'isOpenWorld', 'replay', 'costHint', 'deferLoading', 'requiresApproval'])
      assert.equal(key in tool.meta, true, `${tool.name} meta is missing ${key}`)
  }
})
