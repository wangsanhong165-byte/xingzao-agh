import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginUrl = new URL('../texture-agh-plugin/index.mjs', import.meta.url)
async function freshPlugin() { return import(`${pluginUrl.href}?case=${Math.random()}`) }
async function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value
  }
}
async function installTools(plugin) {
  const tools = new Map()
  for (const item of plugin.textureTools) item.apply({ extension: () => ({ registerTool: tool => tools.set(tool.name, tool) }) })
  assert.deepEqual([...tools.keys()], ['texture_inspect', 'texture_generate', 'texture_verify', 'texture_submit'])
  return tools
}
function mockFetch(handler) {
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init, body: JSON.parse(init.body) })
    const result = await handler(new URL(url).pathname.split('/').at(-1), JSON.parse(init.body))
    return Response.json(result, { status: result.success === false ? 422 : 200 })
  }
  return { requests, restore: () => { globalThis.fetch = original } }
}

const token = 'texture-task-access-token-123456'
const goodEnv = { PHOTO_CAD_TASK_ID: 'texture_job_123', PHOTO_CAD_SERVICE_URL: 'http://127.0.0.1:4337', PHOTO_CAD_ACCESS_TOKEN: token }

test('exports four bounded native tools with strict schemas and a standard-derived preset', async () => {
  const plugin = await freshPlugin()
  const tools = await installTools(plugin)
  assert.deepEqual(plugin.presets['texture-tools'], {
    name: 'texture-tools', extends: 'standard', tools: { timeouts: { texture_generate: 750_000 } },
  })
  assert.deepEqual(tools.get('texture_generate').parameters.properties.profile.enum, ['standard', 'compact'])
  assert.deepEqual(tools.get('texture_verify').parameters.properties.attemptId.enum, ['t01', 't02'])
  assert.deepEqual(tools.get('texture_submit').parameters.required, ['attemptId'])
  assert.equal(tools.get('texture_generate').meta.isOpenWorld, false)
  assert.equal(plugin.textureAghPluginInternals.requestTimeoutMs('generate', {}), 750_000)
  assert.equal(plugin.textureAghPluginInternals.requestTimeoutMs('generate', { timeoutMs: 720_000 }), 719_000)
})

test('plugin binds one task, posts only to fixed texture routes, and requires inspect, verify, then submit', async () => {
  const tools = await installTools(await freshPlugin())
  const assetSha256 = 'a'.repeat(64)
  const mock = mockFetch((op, body) => ({ success: true, attemptId: body.attemptId ?? 't01', profile: body.profile ?? 'standard',
    ...(op === 'verify' ? { assetSha256 } : {}), ...(op === 'submit' ? { assetSha256, submitted: true, verified: true } : {}) }))
  try {
    await withEnv(goodEnv, async () => {
      const call = (name, args = {}) => tools.get(`texture_${name}`).execute(args, {})
      await assert.rejects(call('generate', { profile: 'standard' }), /inspect/u)
      await call('inspect')
      await assert.rejects(call('submit', { attemptId: 't01' }), /verify/u)
      await call('generate', { profile: 'standard' })
      await call('verify', { attemptId: 't01' })
      await call('submit', { attemptId: 't01' })
      assert.deepEqual(mock.requests.map(item => item.url), [
        'http://127.0.0.1:4337/api/texture/tool/inspect',
        'http://127.0.0.1:4337/api/texture/tool/generate',
        'http://127.0.0.1:4337/api/texture/tool/verify',
        'http://127.0.0.1:4337/api/texture/tool/submit',
      ])
      assert.ok(mock.requests.every(item => item.body.jobId === 'texture_job_123'))
      assert.ok(mock.requests.every(item => new Headers(item.init.headers).get('x-print-task-access') === token))
    })
  } finally { mock.restore() }
})

test('submit accepts the real receipt without a stage field and rejects accepted or mismatched receipts', async () => {
  const assetSha256 = 'b'.repeat(64)
  async function exercise(submitResult, expectedFailure) {
    const tools = await installTools(await freshPlugin())
    const mock = mockFetch(op => op === 'inspect' ? { success: true }
      : op === 'generate' ? { success: true, attemptId: 't01', profile: 'standard' }
        : op === 'verify' ? { success: true, attemptId: 't01', assetSha256 }
          : submitResult)
    try {
      await withEnv(goodEnv, async () => {
        await tools.get('texture_inspect').execute({}, {})
        await tools.get('texture_generate').execute({ profile: 'standard' }, {})
        await tools.get('texture_verify').execute({ attemptId: 't01' }, {})
        const submit = () => tools.get('texture_submit').execute({ attemptId: 't01' }, {})
        if (expectedFailure) await assert.rejects(submit(), /verified attempt and asset SHA/u)
        else await submit()
      })
    } finally { mock.restore() }
  }
  await exercise({ success: true, attemptId: 't01', assetSha256, submitted: true, verified: true }, false)
  await exercise({ success: true, attemptId: 't01', assetSha256, stage: 'accepted' }, true)
  await exercise({ success: true, attemptId: 't01', assetSha256: 'c'.repeat(64), submitted: true, verified: true }, true)
})

test('compact retry requires an actual standard TEXTURE_RESOURCE_FAILURE and happens at most once', async () => {
  const tools = await installTools(await freshPlugin())
  const mock = mockFetch(op => op === 'inspect' ? { success: true } : op === 'generate'
    ? { success: false, code: 'TEXTURE_RESOURCE_FAILURE' }
    : { success: true })
  try {
    await withEnv(goodEnv, async () => {
      const call = (name, args = {}) => tools.get(`texture_${name}`).execute(args, {})
      await call('inspect')
      await call('generate', { profile: 'standard' })
      await call('generate', { profile: 'compact' })
      await assert.rejects(call('generate', { profile: 'compact' }), /already used|attempt/u)
      assert.deepEqual(mock.requests.filter(item => item.url.endsWith('/generate')).map(item => item.body), [
        { jobId: 'texture_job_123', attemptId: 't01', profile: 'standard' },
        { jobId: 'texture_job_123', attemptId: 't02', profile: 'compact' },
      ])
    })
  } finally { mock.restore() }
})

test('does not use compact for a non-resource failure and enforces the eight-call budget', async () => {
  const failedTools = await installTools(await freshPlugin())
  const failedMock = mockFetch(op => op === 'inspect' ? { success: true } : { success: false, code: 'TEXTURE_ENGINE_FAILURE' })
  try {
    await withEnv(goodEnv, async () => {
      await failedTools.get('texture_inspect').execute({}, {})
      await failedTools.get('texture_generate').execute({ profile: 'standard' }, {})
      await assert.rejects(failedTools.get('texture_generate').execute({ profile: 'compact' }, {}), /TEXTURE_RESOURCE_FAILURE/u)
      assert.equal(failedMock.requests.length, 2)
    })
  } finally { failedMock.restore() }

  const budgetTools = await installTools(await freshPlugin())
  const budgetMock = mockFetch((op, body) => ({ success: true, attemptId: body.attemptId ?? 't01', profile: body.profile ?? 'standard', ...(op === 'verify' ? { assetSha256: 'd'.repeat(64) } : {}) }))
  try {
    await withEnv(goodEnv, async () => {
      await budgetTools.get('texture_inspect').execute({}, {})
      await budgetTools.get('texture_generate').execute({ profile: 'standard' }, {})
      for (let i = 0; i < 6; i++) await budgetTools.get('texture_verify').execute({ attemptId: 't01' }, {})
      await assert.rejects(budgetTools.get('texture_submit').execute({ attemptId: 't01' }, {}), /budget exhausted/u)
      assert.equal(budgetMock.requests.length, 8)
    })
  } finally { budgetMock.restore() }
})

test('refuses a second job binding and any nonlocal service URL before HTTP', async () => {
  const tools = await installTools(await freshPlugin())
  const mock = mockFetch(() => ({ success: true }))
  try {
    await withEnv(goodEnv, async () => {
      await tools.get('texture_inspect').execute({}, {})
      process.env.PHOTO_CAD_TASK_ID = 'another_job'
      await assert.rejects(tools.get('texture_inspect').execute({}, {}), /different job/u)
      process.env.PHOTO_CAD_TASK_ID = goodEnv.PHOTO_CAD_TASK_ID
      process.env.PHOTO_CAD_SERVICE_URL = 'https://example.com'
      await assert.rejects(tools.get('texture_inspect').execute({}, {}), /127\.0\.0\.1:4337/u)
      assert.equal(mock.requests.length, 1)
    })
  } finally { mock.restore() }
})

test('status reports installed, trusted, enabled and configured model without credential references', async () => {
  const { getTextureAghStatus } = await import('./texture-agh.mjs')
  const status = await getTextureAghStatus({
    env: { USERPROFILE: 'C:\\Users\\tester' }, fileExists: async () => true,
    readFile: async path => path.endsWith('agnes-lock.json')
      ? JSON.stringify({ profile: 'local-dev', packages: { '@photo-cad/texture-tools': { state: { trusted: true, enabled: true } } }, credentialRef: 'secret://never-return' })
      : '{}',
    baseStatus: async () => ({ modelConfigured: true, provider: 'command-code', route: 'private-route', model: 'deepseek/deepseek-v4.1-flash' }),
  })
  assert.deepEqual(status, {
    aghAvailable: true, configured: true, modelConfigured: true, profile: 'local-dev', provider: 'command-code', route: 'private-route',
    model: 'deepseek/deepseek-v4.1-flash', pluginInstalled: true, pluginTrusted: true, pluginEnabled: true, ready: true,
  })
  assert.doesNotMatch(JSON.stringify(status), /secret:\/\/|credentialRef/u)
})

test('runner preserves the local-dev V4.1 model, exact task bindings, isolated workspace and bounded timeouts', async () => {
  const { runTextureTask, textureAghInternals } = await import('./texture-agh.mjs')
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'texture-agh-'))
  let launch
  try {
    const result = await runTextureTask({ jobId: 'texture_job_123', accessToken: token, workspaceRoot,
      env: { USERPROFILE: 'C:\\Users\\test', COMMAND_CODE_API_KEY: 'must-not-leak', PRINT_TASK_JOB_ID: 'old-job' },
      status: async () => ({ aghAvailable: true, modelConfigured: true, provider: 'command-code', route: 'private-route', model: 'deepseek/deepseek-v4.1-flash', pluginInstalled: true, pluginTrusted: true, pluginEnabled: true }),
      spawn: async (_exe, args, options) => { launch = { args, options }; return { stdout: JSON.stringify({ v: 'agnes-cli-result/v1', sessionId: 's', reason: 'completed', exitCode: 0, lastSeq: 1, text: 'verified' }) } },
    })
    assert.equal(result.success, true)
    assert.equal(launch.args[launch.args.indexOf('--profile') + 1], 'local-dev')
    assert.equal(launch.args[launch.args.indexOf('--preset') + 1], 'texture-tools')
    assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'primary=private-route/deepseek/deepseek-v4.1-flash')
    const cwd = launch.args[launch.args.indexOf('--cwd') + 1]
    assert.equal(basename(cwd), 'texture_job_123')
    assert.equal(dirname(cwd), join(workspaceRoot, 'data', 'texture', 'agh-workspaces'))
    assert.deepEqual(await readdir(cwd), [])
    assert.equal(launch.options.env.PHOTO_CAD_TASK_ID, 'texture_job_123')
    assert.equal(launch.options.env.PHOTO_CAD_SERVICE_URL, 'http://127.0.0.1:4337')
    assert.equal(launch.options.env.PHOTO_CAD_ACCESS_TOKEN, token)
    assert.equal(launch.options.env.PRINT_TASK_JOB_ID, undefined)
    assert.equal(launch.options.env.COMMAND_CODE_API_KEY, undefined)
    assert.equal(launch.options.timeout, 1_200_000)
    assert.equal(textureAghInternals.TOOL_TIMEOUT_MS, 750_000)
    assert.equal(textureAghInternals.MAX_TIMEOUT_MS, 1_200_000)
    assert.ok(!launch.args.join(' ').includes(token))
    assert.equal(result.execution.model, 'deepseek/deepseek-v4.1-flash')
  } finally { await rm(workspaceRoot, { recursive: true, force: true }) }
})

test('runner rejects arbitrary service origins, missing plugin states, and reused or linked workspaces', async () => {
  const { runTextureTask, textureAghInternals } = await import('./texture-agh.mjs')
  const ready = { aghAvailable: true, modelConfigured: true, provider: 'command-code', route: 'r', model: 'deepseek/deepseek-v4.1-flash', pluginInstalled: true, pluginTrusted: true, pluginEnabled: true }
  await assert.rejects(runTextureTask({ jobId: 'texture_job_123', accessToken: token, serviceUrl: 'http://127.0.0.1:4338', status: async () => ready }), /4337/u)
  await assert.rejects(runTextureTask({ jobId: 'texture_job_123', accessToken: token, status: async () => ({ ...ready, pluginTrusted: false }) }), /AGH_PLUGIN_NOT_READY/u)
  const root = await mkdtemp(join(tmpdir(), 'texture-workspace-'))
  try {
    const first = await textureAghInternals.createTextureWorkspace('texture_job_123', root)
    await assert.rejects(textureAghInternals.createTextureWorkspace('texture_job_123', root), /ALREADY_EXISTS/u)
    const parent = join(root, 'data', 'texture', 'agh-workspaces')
    await symlink(first, join(parent, 'texture_link'), 'junction')
    await assert.rejects(textureAghInternals.createTextureWorkspace('texture_link', root), /WORKSPACE_INVALID/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})
