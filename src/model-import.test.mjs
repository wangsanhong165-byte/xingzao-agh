import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectModelUpload } from './model-import.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const importRoot = path.join(projectRoot, 'data', 'import-jobs')
const pythonPath = process.env.PHOTO_CAD_MESH_PYTHON
  ?? path.join(projectRoot, 'data', 'reconstruction', 'env-torch-readonly', 'Scripts', 'python.exe')

const cubeVertices = [
  [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
  [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
]
const cubeFaces = [
  [0, 2, 1], [0, 3, 2],
  [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4],
  [3, 7, 6], [3, 6, 2],
  [0, 4, 7], [0, 7, 3],
  [1, 2, 6], [1, 6, 5],
]

function binaryStl(vertices, faces) {
  const output = Buffer.alloc(84 + faces.length * 50)
  output.write('synthetic fixture; no model inference', 0, 80, 'ascii')
  output.writeUInt32LE(faces.length, 80)
  let offset = 84
  for (const face of faces) {
    offset += 12 // The importer must compute/check normals from vertices, not trust this field.
    for (const index of face) {
      const vertex = vertices[index]
      for (const coordinate of vertex) {
        output.writeFloatLE(coordinate, offset)
        offset += 4
      }
    }
    output.writeUInt16LE(0, offset)
    offset += 2
  }
  return output
}

function glb(json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPaddedLength = Math.ceil(jsonBytes.length / 4) * 4
  const binPaddedLength = Math.ceil(binary.length / 4) * 4
  const output = Buffer.alloc(12 + 8 + jsonPaddedLength + 8 + binPaddedLength, 0x20)
  output.write('glTF', 0, 4, 'ascii')
  output.writeUInt32LE(2, 4)
  output.writeUInt32LE(output.length, 8)
  output.writeUInt32LE(jsonPaddedLength, 12)
  output.writeUInt32LE(0x4e4f534a, 16)
  jsonBytes.copy(output, 20)
  const binaryHeader = 20 + jsonPaddedLength
  output.writeUInt32LE(binPaddedLength, binaryHeader)
  output.writeUInt32LE(0x004e4942, binaryHeader + 4)
  binary.copy(output, binaryHeader + 8)
  return output
}

function cubeGlb({ translation = [0, 0, 0], extraJson = {} } = {}) {
  const vertices = Buffer.alloc(cubeVertices.length * 3 * 4)
  let offset = 0
  for (const point of cubeVertices) for (const n of point) {
    vertices.writeFloatLE(n, offset)
    offset += 4
  }
  const indices = Buffer.alloc(cubeFaces.length * 3 * 2)
  offset = 0
  for (const face of cubeFaces) for (const index of face) {
    indices.writeUInt16LE(index, offset)
    offset += 2
  }
  const binary = Buffer.concat([vertices, indices])
  return glb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: vertices.length, target: 34962 },
      { buffer: 0, byteOffset: vertices.length, byteLength: indices.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [10, 10, 10] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    ...extraJson,
  }, binary)
}

async function cleanup(result) {
  if (result?.candidateId) await rm(path.join(importRoot, result.candidateId), { recursive: true, force: true })
}

test('imports a watertight synthetic STL, manually normalizes to mm, and verifies saved-byte hashes', async () => {
  const inputBytes = binaryStl(cubeVertices, cubeFaces)
  const result = await inspectModelUpload({
    name: 'synthetic-cube.stl',
    mime: 'model/stl',
    dataBase64: inputBytes.toString('base64'),
    targetLongestEdgeMm: 20,
    sourceUnits: 'mm',
  }, { pythonPath })
  try {
    assert.equal(result.status, 'inspected')
    assert.equal(result.format, 'stl')
    assert.equal(result.triangleCount, 12)
    assert.equal(result.partCount, 1)
    assert.deepEqual(result.dimensionsMm, { x: 20, y: 20, z: 20, longestEdge: 20 })
    assert.deepEqual(result.normalizedBoundsMm, { min: [-10, -10, 0], max: [10, 10, 20] })
    assert.deepEqual(result.normalizationTransform, [
      [2, 0, 0, -10], [0, 2, 0, -10], [0, 0, 2, 0], [0, 0, 0, 1],
    ])
    assert.equal(result.checks.watertight, true)
    assert.equal(result.checks.windingConsistent, true)
    assert.equal(result.checks.degenerateFaceCount, 0)
    assert.equal(result.checks.volumeMm3, 8000)
    assert.equal(result.geometryChecksPassed, true)
    assert.equal(result.printable, true)
    assert.equal(result.validationScope.kind, 'geometry-only')
    assert.ok(result.validationScope.notEvaluated.includes('self-intersections'))
    assert.ok(result.validationScope.notEvaluated.includes('slicing'))
    assert.ok(result.validationScope.notEvaluated.includes('mechanical-strength'))
    const savedInput = await readFile(path.join(importRoot, result.candidateId, 'input.stl'))
    const savedSummary = JSON.parse(await readFile(path.join(importRoot, result.candidateId, 'summary.json'), 'utf8'))
    const savedMesh = await readFile(path.join(importRoot, result.candidateId, 'normalized.stl'))
    assert.equal(savedInput.toString('base64'), inputBytes.toString('base64'))
    assert.equal(savedSummary.inputSha256, result.inputSha256)
    assert.equal(savedSummary.normalizedStlSha256, result.normalizedStlSha256)
    assert.equal(savedMesh.length > 0, true)
  } finally {
    await cleanup(result)
  }
})

test('treats target-scale input units as arbitrary and applies only the user-entered longest edge', async () => {
  const inputBytes = binaryStl(cubeVertices, cubeFaces)
  const result = await inspectModelUpload({
    name: 'unitless-cube.stl',
    mime: 'application/octet-stream',
    dataBase64: inputBytes.toString('base64'),
    targetLongestEdgeMm: 5,
    sourceUnits: 'target-scale',
  }, { pythonPath })
  try {
    assert.equal(result.sourceUnits, 'target-scale')
    assert.equal(result.dimensionsMm.longestEdge, 5)
    assert.equal(result.targetLongestEdgeMm, 5)
    assert.deepEqual(result.normalizedBoundsMm, { min: [-2.5, -2.5, 0], max: [2.5, 2.5, 5] })
    assert.equal(result.checks.volumeMm3, 125)
  } finally {
    await cleanup(result)
  }
})

test('keeps GLB node transforms when calculating bounds and writing the normalized STL', async () => {
  const bytes = cubeGlb({ translation: [10, 0, 0] })
  const result = await inspectModelUpload({
    name: 'transformed-cube.glb',
    mime: 'model/gltf-binary',
    dataBase64: bytes.toString('base64'),
    targetLongestEdgeMm: 20,
    sourceUnits: 'mm',
  }, { pythonPath })
  try {
    assert.equal(result.format, 'glb')
    assert.equal(result.triangleCount, 12)
    assert.deepEqual(result.sourceBounds.min, [10, 0, 0])
    assert.deepEqual(result.sourceBounds.max, [20, 10, 10])
    assert.deepEqual(result.normalizedBoundsMm, { min: [-10, -10, 0], max: [10, 10, 20] })
    assert.deepEqual(result.normalizationTransform, [
      [2, 0, 0, -30], [0, 2, 0, -10], [0, 0, 2, 0], [0, 0, 0, 1],
    ])
    assert.equal(result.dimensionsMm.longestEdge, 20)
    assert.equal(result.checks.watertight, true)
  } finally {
    await cleanup(result)
  }
})

test('reports an open mesh as not printable without repairing it or suppressing its geometry', async () => {
  const inputBytes = binaryStl([[0, 0, 0], [10, 0, 0], [0, 10, 0]], [[0, 1, 2]])
  const result = await inspectModelUpload({
    name: 'open-triangle.stl',
    mime: 'model/stl',
    dataBase64: inputBytes.toString('base64'),
    targetLongestEdgeMm: 10,
    sourceUnits: 'mm',
  }, { pythonPath })
  try {
    assert.equal(result.status, 'inspected')
    assert.equal(result.triangleCount, 1)
    assert.equal(result.checks.watertight, false)
    assert.equal(result.checks.boundaryEdgeCount, 3)
    assert.equal(result.checks.volumeMm3, null)
    assert.equal(result.geometryChecksPassed, false)
    assert.equal(result.printable, false)
    assert.equal(result.validationScope.kind, 'geometry-only')
    assert.ok(result.normalizedStlSha256)
  } finally {
    await cleanup(result)
  }
})

test('rejects external GLB buffers and image URIs before invoking a parser', async () => {
  const externalBuffer = glb({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.invalid/model.bin', byteLength: 4 }] }, Buffer.alloc(4))
  const externalImage = cubeGlb({ extraJson: { images: [{ uri: 'file:///outside/image.png' }] } })
  for (const bytes of [externalBuffer, externalImage]) {
    await assert.rejects(inspectModelUpload({
      name: 'external.glb',
      mime: 'model/gltf-binary',
      dataBase64: bytes.toString('base64'),
      targetLongestEdgeMm: 20,
      sourceUnits: 'mm',
    }, { pythonPath: 'should-not-be-started.exe' }), (error) => {
      assert.equal(error.code, 'IMPORT_GLB_EXTERNAL_URI')
      return true
    })
  }
})

test('rejects malformed GLB headers, unsupported formats, bad sizes, and oversized STL triangle declarations', async () => {
  const malformedGlb = Buffer.from('not-glb')
  await assert.rejects(inspectModelUpload({
    name: 'broken.glb', mime: 'model/gltf-binary', dataBase64: malformedGlb.toString('base64'),
    targetLongestEdgeMm: 20, sourceUnits: 'mm',
  }), (error) => error.code === 'IMPORT_GLB_INVALID')

  await assert.rejects(inspectModelUpload({
    name: 'unsupported.obj', mime: 'model/obj', dataBase64: Buffer.from('v 0 0 0').toString('base64'),
    targetLongestEdgeMm: 20, sourceUnits: 'mm',
  }), (error) => error.code === 'IMPORT_FORMAT_UNSUPPORTED')

  await assert.rejects(inspectModelUpload({
    name: 'bad-scale.stl', mime: 'model/stl', dataBase64: binaryStl(cubeVertices, cubeFaces).toString('base64'),
    targetLongestEdgeMm: 0, sourceUnits: 'mm',
  }), (error) => error.code === 'IMPORT_INVALID_SCALE')

  await assert.rejects(inspectModelUpload({
    name: 'wrong-mime.stl', mime: 'model/gltf-binary', dataBase64: binaryStl(cubeVertices, cubeFaces).toString('base64'),
    targetLongestEdgeMm: 20, sourceUnits: 'mm',
  }), (error) => error.code === 'IMPORT_FORMAT_UNSUPPORTED')

  await assert.rejects(inspectModelUpload({
    name: 'wrong-units.stl', mime: 'model/stl', dataBase64: binaryStl(cubeVertices, cubeFaces).toString('base64'),
    targetLongestEdgeMm: 20, sourceUnits: 'inch',
  }), (error) => error.code === 'IMPORT_UNITS_INVALID')

  const tooManyBytesBase64 = 'A'.repeat(Math.ceil((25 * 1024 * 1024 + 1) / 3) * 4)
  await assert.rejects(inspectModelUpload({
    name: 'too-large.stl', mime: 'model/stl', dataBase64: tooManyBytesBase64,
    targetLongestEdgeMm: 20, sourceUnits: 'mm',
  }), (error) => error.code === 'IMPORT_BYTES_LIMIT')

  const overLimit = Buffer.alloc(84 + 50 * 250_001)
  overLimit.writeUInt32LE(250_001, 80)
  await assert.rejects(inspectModelUpload({
    name: 'too-many.stl', mime: 'model/stl', dataBase64: overLimit.toString('base64'),
    targetLongestEdgeMm: 20, sourceUnits: 'mm',
  }), (error) => error.code === 'IMPORT_TRIANGLE_LIMIT')
})
