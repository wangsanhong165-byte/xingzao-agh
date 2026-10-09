import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { analyzeDevPhotos, getDevStatus } from './dev-runner.mjs'

const pngBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
const spec = {
  name: 'simple plate',
  type: 'plate',
  dimensions: { width: 80, depth: 60, height: 6, wallThickness: 3 },
  holes: [],
}
const traceDirs = new Set()

function photo(index) {
  return { name: `view-${index}.png`, mime: 'image/png', dataBase64: pngBase64 }
}

function payload(count = 8, overrides = {}) {
  return {
    photos: Array.from({ length: count }, (_, index) => photo(index + 1)),
    reference: { valueMm: 80, description: 'long outer edge' },
    description: 'A simple flat plate with no holes',
    preferredType: 'plate',
    ...overrides,
  }
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function lastCandidateId(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'tool') continue
    try {
      const result = JSON.parse(message.content)
      if (result.success === true && typeof result.candidateId === 'string') return result.candidateId
    } catch { }
  }
  return null
}

function response(message, { finishReason = 'tool_calls', usage } = {}) {
  return { ok: true, async json() { return { choices: [{ message, finish_reason: finishReason }], ...(usage ? { usage } : {}) } } }
}

const validGeometryResult = () => ({ mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }, checks: [{ name: 'input-dimensions', status: 'pass' }], metrics: { volumeMm3: 28800 } })
const validRenderResult = () => ({
  id: 'render-fixture',
  views: [{ name: 'front', mime: 'image/png', dataBase64: pngBase64 }, { name: 'side', mime: 'image/png', dataBase64: pngBase64 }, { name: 'top', mime: 'image/png', dataBase64: pngBase64 }],
  checks: { dimensionsMm: { width: 80, depth: 60, height: 6 }, boundaryEdges: 0, nonManifoldEdges: 0, volumeMm3: 28800 },
})

afterEach(async () => {
  await Promise.all([...traceDirs].map((dir) => rm(dir, { recursive: true, force: true })))
  traceDirs.clear()
})

test('development status depends only on DEEPSEEK_API_KEY and is clearly labeled', () => {
  assert.deepEqual(getDevStatus({ env: {} }), {
    modelConfigured: false,
    provider: null,
    model: null,
    analysisMode: 'development-deepseek',
  })
  assert.equal(getDevStatus({ env: { DEEPSEEK_API_KEY: 'local-test-key' } }).modelConfigured, true)
  assert.equal(getDevStatus({ env: { DEEPSEEK_API_KEY: 'local-test-key' } }).model, 'deepseek-flash')
})

test('Command Code status requires a chosen model and an official fixed endpoint', () => {
  const command = { COMMAND_CODE_API_KEY: 'local-test-key', PHOTO_CAD_DEV_MODEL: 'deepseek/deepseek-v4.1-flash' }
  assert.deepEqual(getDevStatus({ env: command }), {
    modelConfigured: true,
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
    analysisMode: 'development-deepseek',
  })
  assert.equal(getDevStatus({ env: { ...command, PHOTO_CAD_DEV_BASE_URL: 'https://attacker.invalid/v1', DEEPSEEK_API_KEY: 'fallback-must-not-be-used' } }).modelConfigured, false)
})

test('stubbed API loop corrects invalid geometry, renders, returns images, and accepts submit_json', async () => {
  const badSpec = { ...structuredClone(spec), dimensions: { ...spec.dimensions, width: 501 } }
  const replies = [
    { role: 'assistant', content: null, reasoning_content: 'reasoning-one', tool_calls: [toolCall('c1', 'validate_geometry', { spec: badSpec })] },
    { role: 'assistant', content: null, reasoning_content: 'reasoning-two', tool_calls: [toolCall('c2', 'validate_geometry', { spec })] },
    null,
    null,
  ]
  const requests = []
  let renders = 0
  const result = await analyzeDevPhotos(payload(), {
    env: { DEEPSEEK_API_KEY: 'local-test-key' },
    async fetchImpl(_url, options) {
      const body = JSON.parse(options.body)
      requests.push(body)
      if (requests.length === 3) return response({ role: 'assistant', content: null, reasoning_content: 'reasoning-three', tool_calls: [toolCall('c3', 'render_model', { candidateId: lastCandidateId(body.messages) })] })
      if (requests.length === 4) return response({ role: 'assistant', content: null, reasoning_content: 'reasoning-four', tool_calls: [toolCall('c4', 'submit_json', { candidateId: lastCandidateId(body.messages), assumptions: ['比例由参考边校正'], questions: [], confidence: 0.74 })] })
      return response(replies[requests.length - 1])
    },
    render: async () => {
      renders += 1
      return {
        id: 'render-fixture',
        views: [{ name: 'front', mime: 'image/png', dataBase64: pngBase64 }, { name: 'side', mime: 'image/png', dataBase64: pngBase64 }, { name: 'top', mime: 'image/png', dataBase64: pngBase64 }],
        checks: { dimensionsMm: { width: 80, depth: 60, height: 6 }, boundaryEdges: 0, nonManifoldEdges: 0, volumeMm3: 28800 },
      }
    },
    generate(candidate) {
      if (candidate?.dimensions?.width > 500) throw new RangeError('width exceeds limit')
      return { mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }, checks: [{ name: 'input-dimensions', status: 'pass' }], metrics: { volumeMm3: 28800 } }
    },
  })

  assert.equal(requests.length, 4)
  assert.equal(requests[0].model, 'deepseek-flash')
  assert.equal(requests[0].max_tokens, 12288)
  assert.equal(requests[0].messages[1].content.filter((part) => part.type === 'image_url').length, 6)
  assert.equal(requests[1].messages.at(-1).role, 'tool')
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).success, false)
  assert.equal(requests[2].messages.at(-1).role, 'tool')
  assert.equal(JSON.parse(requests[2].messages.at(-1).content).success, true)
  assert.equal(requests[3].messages.some((message) => message.role === 'assistant' && message.reasoning_content === 'reasoning-three'), true)
  assert.equal(requests[3].messages.some((message) => message.role === 'user' && message.content.some((part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,'))), true)
  assert.equal(renders, 1)
  assert.equal(result.spec.dimensions.width, 80)
  assert.equal(result.execution.mode, 'development-deepseek')
  assert.equal(result.execution.analysisMode, 'development-deepseek')
  assert.equal(result.execution.provider, 'deepseek')
  assert.deepEqual(result.execution.sampledPhotos, ['photo-1.png', 'photo-2.png', 'photo-4.png', 'photo-5.png', 'photo-7.png', 'photo-8.png'])
  assert.equal(result.execution.geometryValidated, true)
  assert.equal(result.execution.renderedViewsCompared, true)
})

test('candidate IDs survive label and hole-order changes without forcing another render', async () => {
  const holeA = { x: -20, y: -10, diameter: 6 }
  const holeB = { x: 20, y: 10, diameter: 6 }
  const firstSpec = { ...structuredClone(spec), name: 'first label', holes: [holeA, holeB] }
  const equivalentSpec = { ...structuredClone(spec), name: 'final label', dimensions: { ...spec.dimensions, width: 80.0 }, holes: [holeB, holeA] }
  const requests = []
  let validations = 0
  let renders = 0
  let index = 0
  const replies = [
    response({ role: 'assistant', content: null, tool_calls: [toolCall('v1', 'validate_geometry', { spec: firstSpec })] }),
    null,
    response({ role: 'assistant', content: null, tool_calls: [toolCall('v2', 'validate_geometry', { spec: equivalentSpec })] }),
    null,
  ]
  const result = await analyzeDevPhotos(payload(1), {
    env: { DEEPSEEK_API_KEY: 'local-test-key' },
    async fetchImpl(_url, options) {
      const body = JSON.parse(options.body)
      requests.push(body)
      const turn = index++
      if (turn === 1) return response({ role: 'assistant', content: null, tool_calls: [toolCall('r1', 'render_model', { candidateId: lastCandidateId(body.messages) })] })
      if (turn === 3) return response({ role: 'assistant', content: null, tool_calls: [toolCall('s1', 'submit_json', { candidateId: lastCandidateId(body.messages), assumptions: [], questions: [], confidence: 0.9 })] })
      return replies[turn]
    },
    generate: () => { validations += 1; return validGeometryResult() },
    render: async () => { renders += 1; return validRenderResult() },
  })
  const candidateIds = requests.slice(1).flatMap((body) => body.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content).candidateId).filter(Boolean))
  assert.equal(validations, 2)
  assert.equal(renders, 1)
  assert.equal(new Set(candidateIds).size, 1)
  assert.equal(result.spec.name, 'final label')
})

test('geometric parameter changes produce a new candidate and still require a matching render', async () => {
  const changedSpec = { ...structuredClone(spec), dimensions: { ...spec.dimensions, width: 81 } }
  const replies = [
    response({ role: 'assistant', content: null, tool_calls: [toolCall('v1', 'validate_geometry', { spec })] }),
    null,
    response({ role: 'assistant', content: null, tool_calls: [toolCall('v2', 'validate_geometry', { spec: changedSpec })] }),
    null,
    response({ role: 'assistant', content: 'No result' }, { finishReason: 'stop' }),
    response({ role: 'assistant', content: 'Still no result' }, { finishReason: 'stop' }),
  ]
  let index = 0
  let firstCandidate
  let secondCandidate
  let renderCalls = 0
  await assert.rejects(analyzeDevPhotos(payload(1), {
    env: { DEEPSEEK_API_KEY: 'local-test-key' },
    async fetchImpl(_url, options) {
      const body = JSON.parse(options.body)
      const turn = index++
      if (turn === 1) {
        firstCandidate = lastCandidateId(body.messages)
        return response({ role: 'assistant', content: null, tool_calls: [toolCall('r1', 'render_model', { candidateId: firstCandidate })] })
      }
      if (turn === 3) {
        secondCandidate = lastCandidateId(body.messages)
        return response({ role: 'assistant', content: null, tool_calls: [toolCall('s1', 'submit_json', { candidateId: secondCandidate, assumptions: [], questions: [], confidence: 0.9 })] })
      }
      return replies[turn]
    },
    generate: validGeometryResult,
    render: async () => { renderCalls += 1; return validRenderResult() },
  }), { code: 'DEV_RESULT_MISSING' })
  assert.notEqual(firstCandidate, secondCandidate)
  assert.equal(renderCalls, 1)
})

test('cannot run the development API path without its own configured key', async () => {
  await assert.rejects(analyzeDevPhotos(payload(1), { env: {} }), { code: 'MODEL_NOT_CONFIGURED', status: 503 })
})

test('refuses final submission when Blender reports boundary or non-manifold edges', async () => {
  const replies = [
    { role: 'assistant', content: null, reasoning_content: 'r1', tool_calls: [toolCall('c1', 'validate_geometry', { spec })] },
    null,
    null,
    { role: 'assistant', content: 'No result can be accepted.', reasoning_content: 'r4' },
    { role: 'assistant', content: 'Still no tool result.', reasoning_content: 'r5' },
  ]
  let index = 0
  await assert.rejects(analyzeDevPhotos(payload(1), {
    env: { DEEPSEEK_API_KEY: 'local-test-key' },
    async fetchImpl(_url, options) {
      const body = JSON.parse(options.body)
      const call = index++
      if (call === 1) return response({ role: 'assistant', content: null, reasoning_content: 'r2', tool_calls: [toolCall('c2', 'render_model', { candidateId: lastCandidateId(body.messages) })] })
      if (call === 2) return response({ role: 'assistant', content: null, reasoning_content: 'r3', tool_calls: [toolCall('c3', 'submit_json', { candidateId: lastCandidateId(body.messages), assumptions: [], questions: [], confidence: 0.5 })] })
      return response(replies[call])
    },
    render: async () => ({ views: [], checks: { boundaryEdges: 12, nonManifoldEdges: 0 } }),
    generate: () => ({ mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }, checks: [{ name: 'input-dimensions', status: 'pass' }], metrics: {} }),
  }), { code: 'DEV_RESULT_MISSING' })
})

test('Command Code key is sent only to its configured model catalog and API endpoint', async () => {
  const calls = []
  let posts = 0
  await assert.rejects(analyzeDevPhotos(payload(1), {
    env: {
      COMMAND_CODE_API_KEY: 'command-test-key',
      PHOTO_CAD_DEV_BASE_URL: 'https://api.commandcode.ai/provider/v1',
      PHOTO_CAD_DEV_MODEL: 'deepseek/deepseek-v4.1-flash',
      DEEPSEEK_API_KEY: 'must-not-be-used',
    },
    async fetchImpl(url, options) {
      calls.push({ url, authorization: options.headers.authorization, method: options.method })
      if (options.method === 'GET') return { ok: true, async json() { return { data: [{ id: 'deepseek/deepseek-v4.1-flash', supported_endpoints: ['/provider/v1/chat/completions'] }] } } }
      posts += 1
      return response({ role: 'assistant', content: 'No result' })
    },
  }), { code: 'DEV_RESULT_MISSING' })
  assert.equal(calls.length, 3)
  assert.equal(calls[0].url, 'https://api.commandcode.ai/provider/v1/models')
  assert.equal(calls[1].url, 'https://api.commandcode.ai/provider/v1/chat/completions')
  assert.equal(calls.every((call) => call.authorization === 'Bearer command-test-key'), true)
  assert.equal(posts, 2)
})

test('length response gets one larger-budget continuation and a sanitized trace is saved', async () => {
  const traceDir = await mkdtemp(path.join(os.tmpdir(), 'photo-cad-dev-trace-test-'))
  traceDirs.add(traceDir)
  const privateReasoning = 'private reasoning sentinel that must never enter a trace'
  const replies = [
    response({ role: 'assistant', content: 'truncated', reasoning_content: privateReasoning }, { finishReason: 'length', usage: { prompt_tokens: 1200, completion_tokens: 12288, total_tokens: 13488 } }),
    response({ role: 'assistant', content: null, reasoning_content: 'continued', tool_calls: [toolCall('c1', 'validate_geometry', { spec })] }),
    null,
    null,
  ]
  const requests = []
  let index = 0
  const result = await analyzeDevPhotos(payload(1), {
    env: { DEEPSEEK_API_KEY: 'trace-secret-canary', PHOTO_CAD_DEV_MAX_TOKENS: '12288' },
    traceDir,
    async fetchImpl(_url, options) {
      const body = JSON.parse(options.body)
      requests.push(body)
      const call = index++
      if (call === 2) return response({ role: 'assistant', content: null, reasoning_content: 'render', tool_calls: [toolCall('c2', 'render_model', { candidateId: lastCandidateId(body.messages) })] })
      if (call === 3) return response({ role: 'assistant', content: null, reasoning_content: 'submit', tool_calls: [toolCall('c3', 'submit_json', { candidateId: lastCandidateId(body.messages), assumptions: ['known reference used'], questions: [], confidence: 0.74 })] })
      return replies[call]
    },
    generate: validGeometryResult,
    render: async () => validRenderResult(),
  })
  assert.equal(requests.length, 4)
  assert.equal(requests[0].max_tokens, 12288)
  assert.ok(requests[1].max_tokens > requests[0].max_tokens)
  assert.ok(requests[1].max_tokens <= 16384)
  assert.ok(requests[1].messages.some((message) => message.role === 'assistant' && message.reasoning_content === privateReasoning))
  assert.equal(result.execution.submitted, true)
  assert.ok(typeof result.execution.traceId === 'string')
  const [traceName] = await readdir(traceDir)
  const trace = await readFile(path.join(traceDir, traceName), 'utf8')
  assert.ok(trace.includes('finishReason'))
  assert.ok(trace.includes('toolNames'))
  assert.ok(trace.includes('success'))
  assert.ok(trace.includes('usage'))
  assert.equal(trace.includes(privateReasoning), false)
  assert.equal(trace.includes('trace-secret-canary'), false)
  assert.equal(trace.includes(pngBase64), false)
})

test('normal final text without tools receives one tool-use nudge, then fails closed', async () => {
  let requests = 0
  await assert.rejects(analyzeDevPhotos(payload(1), {
    env: { DEEPSEEK_API_KEY: 'local-test-key' },
    async fetchImpl(_url, options) {
      const body = JSON.parse(options.body)
      requests += 1
      if (requests === 2) assert.ok(body.messages.some((message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('submit_json')))
      return response({ role: 'assistant', content: 'I think this looks like a plate.', reasoning_content: 'private thought' }, { finishReason: 'stop' })
    },
  }), { code: 'DEV_RESULT_MISSING' })
  assert.equal(requests, 2)
})

test('plate measurement uses only the stated longest edge and manual thickness, then keeps all submission gates', async () => {
  const measuredSpec = {
    name: 'Measured plate',
    type: 'plate',
    dimensions: { width: 80, depth: 60, height: 6, wallThickness: 3 },
    holes: [{ x: -20, y: -10, diameter: 6 }, { x: 20, y: 10, diameter: 6 }],
  }
  const replies = [
    response({ role: 'assistant', content: null, reasoning_content: 'measure', tool_calls: [toolCall('m1', 'measure_plate', { photoIndex: 1, knownLongestWidthMm: 80, thicknessMm: 6 })] }),
    response({ role: 'assistant', content: null, reasoning_content: 'validate', tool_calls: [toolCall('g1', 'validate_geometry', { spec: measuredSpec })] }),
    null,
    null,
  ]
  const requests = []
  let index = 0
  let measuredInput
  const result = await analyzeDevPhotos(payload(1, {
    description: '根据照片生成平板模型，保持观察到的圆孔与外尺寸。不要加省料孔，不要把画面背景当零件。',
    reference: { valueMm: 80, description: '物体最长外边80mm，板厚实测6mm；这是一张近正俯拍，平板外轮廓为矩形，内部圆孔为贯穿孔。' },
  }), {
    env: { DEEPSEEK_API_KEY: 'local-test-key' },
    async fetchImpl(_url, options) {
      const body = JSON.parse(options.body)
      requests.push(body)
      const call = index++
      if (call === 2) return response({ role: 'assistant', content: null, reasoning_content: 'render', tool_calls: [toolCall('r1', 'render_model', { candidateId: lastCandidateId(body.messages) })] })
      if (call === 3) return response({ role: 'assistant', content: null, reasoning_content: 'submit', tool_calls: [toolCall('s1', 'submit_json', { candidateId: lastCandidateId(body.messages), assumptions: [], questions: [], confidence: 0.9 })] })
      return replies[call]
    },
    measure: async (input) => {
      measuredInput = input
      return { spec: measuredSpec, measurements: { longEdgePixels: 100, overlayPath: 'C:/private/temporary/overlay.png' }, warnings: ['visual check required'] }
    },
    generate: validGeometryResult,
    render: async () => validRenderResult(),
  })
  assert.equal(measuredInput.widthMm, 80)
  assert.equal(measuredInput.thicknessMm, 6)
  assert.equal(measuredInput.photo.name, 'photo-1.png')
  assert.equal(result.spec.type, 'plate')
  assert.equal(requests[1].messages.at(-1).content.includes('private/temporary'), false)
  assert.equal(result.execution.submitted, true)
})

test('measure_plate refuses an unknown object or an unstated thickness before running CV', async () => {
  const replies = [
    response({ role: 'assistant', content: null, tool_calls: [toolCall('m1', 'measure_plate', { photoIndex: 1, knownLongestWidthMm: 80, thicknessMm: 4 })] }),
    response({ role: 'assistant', content: 'I cannot measure this object.' }, { finishReason: 'stop' }),
    response({ role: 'assistant', content: 'No result.' }, { finishReason: 'stop' }),
  ]
  const requests = []
  let index = 0
  let measureCalls = 0
  await assert.rejects(analyzeDevPhotos(payload(1, {
    description: 'An unknown sculpted character, with no plate thickness supplied.',
    preferredType: 'box',
  }), {
    env: { DEEPSEEK_API_KEY: 'local-test-key' },
    async fetchImpl(_url, options) {
      requests.push(JSON.parse(options.body))
      return replies[index++]
    },
    async measure() { measureCalls += 1; throw new Error('should not run') },
  }), { code: 'DEV_RESULT_MISSING' })
  const rejected = JSON.parse(requests[1].messages.at(-1).content)
  assert.equal(rejected.errorCode, 'MEASURE_REFERENCE_INCOMPLETE')
  assert.equal(measureCalls, 0)
})
