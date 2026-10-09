import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const moduleUrl = new URL('../pose-agh-plugin/index.mjs', import.meta.url)
const poseIds = ['upright', 'tilt-x-plus', 'tilt-x-minus', 'tilt-y-plus']

async function freshPlugin() {
  return import(`${moduleUrl.href}?case=${Math.random()}`)
}

async function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value
  }
}

async function installTools(plugin, names) {
  const installed = new Map()
  for (const item of plugin.poseTools) item.apply({ extension: () => ({ registerTool: (tool) => installed.set(tool.name, tool) }) })
  assert.deepEqual([...installed.keys()], names)
  return installed
}

test('exports five bounded native tools and a preset that preserves the standard timeout', async () => {
  const plugin = await freshPlugin()
  const tools = await installTools(plugin, ['pose_inspect', 'pose_evaluate', 'pose_select', 'pose_verify', 'pose_submit'])
  assert.deepEqual(plugin.presets['pose-tools'].extends, 'standard')
  assert.equal(plugin.presets['pose-tools'].tools?.timeouts, undefined)
  for (const [name, tool] of tools) {
    assert.deepEqual(tool.meta, { isReadOnly: name === 'pose_inspect', isDestructive: false, isConcurrencySafe: false, isOpenWorld: false, replay: name === 'pose_inspect' ? 'safe' : 'never', costHint: undefined, deferLoading: false, requiresApproval: 'never' })
  }
  assert.deepEqual(tools.get('pose_evaluate').parameters.properties.poseId.enum, [...poseIds, 'face-up'])
  assert.equal(tools.get('pose_select').parameters.properties.rationale.maxLength, 400)
  assert.equal(tools.get('pose_submit').parameters.additionalProperties, false)
})

test('enforces inspect, unique successful evaluations, select, verify, submit and a 12 call budget', async () => {
  const plugin = await freshPlugin()
  const tools = await installTools(plugin, ['pose_inspect', 'pose_evaluate', 'pose_select', 'pose_verify', 'pose_submit'])
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init, body: JSON.parse(init.body) })
    const operation = new URL(url).pathname.split('/').at(-1)
    return Response.json({ success: true, ...(operation === 'select' ? { decision: 'selected', selectedPoseId: 'upright' } : {}) })
  }
  try {
    await withEnv({ PRINT_TASK_JOB_ID: 'pose-job', PRINT_TASK_JOB_ACCESS: 'x'.repeat(24) }, async () => {
      const call = (name, args = {}) => tools.get(`pose_${name}`).execute(args, {})
      await assert.rejects(call('evaluate', { poseId: 'upright' }), /pose_inspect/)
      await call('inspect')
      await assert.rejects(call('select', { poseId: 'upright' }), /successful evaluation/)
      await call('evaluate', { poseId: 'upright' })
      await assert.rejects(call('evaluate', { poseId: 'upright' }), /already been evaluated/)
      await call('evaluate', { poseId: 'tilt-x-plus' })
      await call('select', { poseId: 'upright' })
      await assert.rejects(call('submit'), /pose_verify/)
      await call('verify')
      await call('submit')
      for (let i = 0; i < 6; i++) await call('inspect')
      await assert.rejects(call('inspect'), /budget exhausted/)
      assert.deepEqual(requests.map((request) => request.url.split('/').at(-1)), ['inspect', 'evaluate', 'evaluate', 'select', 'verify', 'submit', 'inspect', 'inspect', 'inspect', 'inspect', 'inspect', 'inspect'])
      for (const request of requests) {
        assert.equal(request.url.startsWith('http://127.0.0.1:4337/api/poses/tool/'), true)
        assert.equal(request.body.jobId, 'pose-job')
        assert.equal(request.init.headers['X-Print-Task-Access'], 'x'.repeat(24))
      }
    })
  } finally { globalThis.fetch = originalFetch }
})

test('evaluates failed poses once, allows remaining candidates, and never promotes a service failure', async () => {
  const plugin = await freshPlugin()
  const tools = await installTools(plugin, ['pose_inspect', 'pose_evaluate', 'pose_select', 'pose_verify', 'pose_submit'])
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => Response.json(JSON.parse(init.body).poseId === 'tilt-x-plus'
    ? { success: false, code: 'POSE_REJECTED', reason: 'hard constraint' }
    : { success: true })
  try {
    await withEnv({ PRINT_TASK_JOB_ID: 'pose-fail', PRINT_TASK_JOB_ACCESS: 'y'.repeat(24) }, async () => {
      await tools.get('pose_inspect').execute({}, {})
      const failed = await tools.get('pose_evaluate').execute({ poseId: 'tilt-x-plus' }, {})
      assert.equal(failed.structured.success, false)
      assert.equal(failed.content[0].text.includes('POSE_REJECTED'), true)
      await assert.rejects(tools.get('pose_select').execute({ poseId: 'tilt-x-plus' }, {}), /successful evaluation/)
      await tools.get('pose_evaluate').execute({ poseId: 'upright' }, {})
      await assert.rejects(tools.get('pose_evaluate').execute({ poseId: 'tilt-x-plus' }, {}), /already been evaluated/)
    })
  } finally { globalThis.fetch = originalFetch }
})

test('request deadline uses the standard 120 second default and leaves native deadline margin', async () => {
  const plugin = await freshPlugin()
  assert.equal(plugin.poseAghInternals.requestTimeoutMs(), 119_000)
  assert.equal(plugin.poseAghInternals.requestTimeoutMs({ timeoutMs: 12_000 }), 11_000)
  assert.equal(plugin.poseAghInternals.requestTimeoutMs({ timeoutMs: 500_000 }), 120_000)
})

test('status requires the Agnes model plus the pose plugin trusted and enabled in its own profile state', async () => {
  const { getPoseAghStatus } = await import('../src/pose-agh.mjs')
  const env = { USERPROFILE: 'C:\\fake-home', PHOTO_CAD_AGH_CLI: 'C:\\fake-cli.mjs' }
  const lock = JSON.stringify({ profile: 'local-dev', packages: { '@photo-cad/pose-tools': { state: { trusted: true, enabled: true } } } })
  const status = await getPoseAghStatus({ env, fileExists: async () => true, readFile: async (path) => String(path).includes('agnes-lock') ? lock : JSON.stringify({ profile: 'local-dev', configured: true, provider: { id: 'agnes-ai', baseUrl: 'https://api.agnes-ai.cn/v1', model: 'agnes-3.0-flash', route: 'agnes-ai', credentialConfigured: true } }) })
  assert.equal(status.ready, true)
  assert.equal(status.provider, 'agnes-ai')
  assert.equal(status.model, 'agnes-3.0-flash')
  assert.equal(status.profile, 'local-dev')
})

test('status projects a verified CommandCode DeepSeek V4.1 Flash configuration', async () => {
  const { getPoseAghStatus } = await import('../src/pose-agh.mjs')
  const env = { USERPROFILE: 'C:\\fake-home', PHOTO_CAD_AGH_CLI: 'C:\\fake-cli.mjs' }
  const lock = JSON.stringify({ profile: 'local-dev', packages: { '@photo-cad/pose-tools': { state: { trusted: true, enabled: true } } } })
  const status = await getPoseAghStatus({
    env, fileExists: async () => true,
    readFile: async (path) => String(path).includes('agnes-lock') ? lock : '{}',
    baseStatus: async () => ({ aghAvailable: true, modelConfigured: true, provider: 'command-code', route: 'account-cc', model: 'deepseek/deepseek-v4.1-flash' }),
  })
  assert.equal(status.ready, true)
  assert.equal(status.provider, 'command-code')
  assert.equal(status.route, 'account-cc')
  assert.equal(status.model, 'deepseek/deepseek-v4.1-flash')
})

test('runner explicitly binds Agnes 3.0 Flash and starts an isolated pose preset workspace', async () => {
  const { runPoseTask } = await import('../src/pose-agh.mjs')
  const root = await mkdtemp(join(tmpdir(), 'pose-agh-'))
  try {
    let spawnArgs
    const result = await runPoseTask({ jobId: 'test_pose', accessToken: 'z'.repeat(24), task: 'orient for low material', workspaceRoot: root, status: async () => ({ aghAvailable: true, modelConfigured: true, provider: 'agnes-ai', route: 'agnes-ai', model: 'agnes-3.0-flash', pluginInstalled: true, pluginTrusted: true, pluginEnabled: true }), env: { USERPROFILE: root, PHOTO_CAD_AGH_CLI: join(root, 'agnes.mjs') }, spawn: async (_exe, args, options) => { spawnArgs = { args, options }; return { stdout: JSON.stringify({ v: 'agnes-cli-result/v1', sessionId: 's', reason: 'completed', exitCode: 0, lastSeq: 1, text: 'done' }), code: 0 } } })
    assert.equal(result.success, true)
    assert.equal(spawnArgs.args.includes('--preset'), true)
    assert.equal(spawnArgs.args[spawnArgs.args.indexOf('--preset') + 1], 'pose-tools')
    assert.equal(spawnArgs.args.includes('primary=agnes-ai/agnes-3.0-flash'), true)
    assert.equal(spawnArgs.options.timeout, 600_000)
    assert.equal(spawnArgs.args[spawnArgs.args.indexOf('--cwd') + 1].includes('data\\pose-jobs\\agh-workspaces\\test_pose'), true)
    assert.equal(spawnArgs.options.env.PRINT_TASK_JOB_ACCESS, 'z'.repeat(24))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runner binds verified CommandCode model and reports matching execution evidence', async () => {
  const { runPoseTask } = await import('../src/pose-agh.mjs')
  const root = await mkdtemp(join(tmpdir(), 'pose-agh-command-code-'))
  try {
    let spawnArgs
    const result = await runPoseTask({
      jobId: 'test_pose_cc', accessToken: 'z'.repeat(24), task: 'orient safely', workspaceRoot: root,
      status: async () => ({ aghAvailable: true, modelConfigured: true, provider: 'command-code', route: 'account-cc', model: 'deepseek/deepseek-v4.1-flash', pluginInstalled: true, pluginTrusted: true, pluginEnabled: true }),
      env: { USERPROFILE: root, PHOTO_CAD_AGH_CLI: join(root, 'agnes.mjs') },
      spawn: async (_exe, args) => { spawnArgs = args; return { stdout: JSON.stringify({ v: 'agnes-cli-result/v1', sessionId: 's', reason: 'completed', exitCode: 0, lastSeq: 1, text: 'done' }), code: 0 } },
    })
    assert.equal(result.success, true)
    assert.equal(spawnArgs[spawnArgs.indexOf('--model') + 1], 'primary=account-cc/deepseek/deepseek-v4.1-flash')
    assert.equal(result.execution.provider, 'command-code')
    assert.equal(result.execution.model, 'deepseek/deepseek-v4.1-flash')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runner rejects an unconfigured or incomplete provider model status', async () => {
  const { runPoseTask } = await import('../src/pose-agh.mjs')
  const root = await mkdtemp(join(tmpdir(), 'pose-agh-unconfigured-'))
  try {
    for (const overrides of [
      { modelConfigured: false },
      { provider: '' },
      { route: '' },
      { model: '' },
    ]) {
      await assert.rejects(runPoseTask({
        jobId: 'test_pose_incomplete', accessToken: 'z'.repeat(24), workspaceRoot: root,
        status: async () => ({ aghAvailable: true, modelConfigured: true, provider: 'agnes-ai', route: 'agnes-ai', model: 'agnes-3.0-flash', pluginInstalled: true, pluginTrusted: true, pluginEnabled: true, ...overrides }),
        spawn: async () => { throw new Error('must not launch') },
      }), /model.*NOT_CONFIGURED/iu)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runner rejects service URLs outside the fixed loopback pose service', async () => {
  const { runPoseTask } = await import('../src/pose-agh.mjs')
  await assert.rejects(runPoseTask({ jobId: 'url_guard', accessToken: 'z'.repeat(24), task: '', serviceUrl: 'https://example.com', status: async () => ({ aghAvailable: true, modelConfigured: true, provider: 'agnes-ai', model: 'agnes-3.0-flash', pluginInstalled: true, pluginTrusted: true, pluginEnabled: true }) }), /serviceUrl must be the local pose service/)
})

test('select rejects a mismatched selectedPoseId and does not unlock verify', async () => {
  const plugin = await freshPlugin()
  const tools = await installTools(plugin, ['pose_inspect', 'pose_evaluate', 'pose_select', 'pose_verify', 'pose_submit'])
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => Response.json(new URL(url).pathname.endsWith('/select')
    ? { success: true, decision: 'selected', selectedPoseId: 'tilt-y-plus' }
    : { success: true })
  try {
    await withEnv({ PRINT_TASK_JOB_ID: 'pose-mismatch', PRINT_TASK_JOB_ACCESS: 'm'.repeat(24) }, async () => {
      await tools.get('pose_inspect').execute({}, {})
      await tools.get('pose_evaluate').execute({ poseId: 'upright' }, {})
      await assert.rejects(tools.get('pose_select').execute({ poseId: 'upright' }, {}), /selectedPoseId/)
      await assert.rejects(tools.get('pose_verify').execute({}, {}), /pose_select/)
    })
  } finally { globalThis.fetch = originalFetch }
})
