import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pluginUrl = new URL('../repair-agh-plugin/index.mjs', import.meta.url)
async function freshPlugin() { return import(`${pluginUrl.href}?case=${Math.random()}`) }
async function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value
  }
}
async function installTools(plugin) {
  const tools = new Map()
  for (const item of plugin.repairTools) item.apply({ extension: () => ({ registerTool: tool => tools.set(tool.name, tool) }) })
  assert.deepEqual([...tools.keys()], ['repair_inspect', 'repair_evaluate', 'repair_apply', 'repair_verify', 'repair_submit'])
  return tools
}
function mockFetch(handler) {
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ url: String(url), init, body })
    return Response.json(await handler(new URL(url).pathname.split('/').at(-1), body))
  }
  return { requests, restore: () => { globalThis.fetch = original } }
}
const env = { PRINT_TASK_JOB_ID: 'repair-job', PRINT_TASK_JOB_ACCESS: 'n'.repeat(32) }
const evaluateSuccess = (candidateId, feasible) => ({ success: true, candidateId, feasible })

test('exports five bounded tools and preserves standard timeout in its preset', async () => {
  const plugin = await freshPlugin()
  const tools = await installTools(plugin)
  assert.deepEqual(plugin.presets['feature-repair-tools'], { name: 'feature-repair-tools', extends: 'standard' })
  assert.deepEqual(tools.get('repair_evaluate').parameters.properties.candidateId.enum, ['original', 'r01', 'r02', 'r03'])
  assert.equal(tools.get('repair_apply').parameters.properties.radiusMm.minimum, 0.01)
  assert.equal(tools.get('repair_apply').parameters.properties.radiusMm.maximum, 5)
  assert.equal(tools.get('repair_submit').parameters.required.length, 0)
})

test('enforces inspect, failed original, inspected radius options, issued candidates, feasible verify and submit', async () => {
  const tools = await installTools(await freshPlugin())
  const mock = mockFetch((op, body) => {
    if (op === 'inspect') return { success: true, repairOptionsMm: [0.2, 0.4] }
    if (op === 'evaluate') return evaluateSuccess(body.candidateId, body.candidateId === 'r01')
    if (op === 'apply') return { success: true, candidateId: 'r01' }
    if (op === 'verify') return { success: true, candidateId: body.candidateId }
    if (op === 'submit') return { success: true, candidateId: 'r01' }
    throw new Error(op)
  })
  try {
    await withEnv(env, async () => {
      const call = (name, args = {}) => tools.get(`repair_${name}`).execute(args, {})
      await assert.rejects(call('evaluate', { candidateId: 'original' }), /inspect/)
      await call('inspect')
      await assert.rejects(call('apply', { radiusMm: 0.3 }), /allowed.*radius/i)
      await call('evaluate', { candidateId: 'original' })
      await assert.rejects(call('verify', { candidateId: 'original' }), /evaluated feasible candidate/)
      await call('apply', { radiusMm: 0.2 })
      await assert.rejects(call('evaluate', { candidateId: 'r02' }), /issued by repair_apply/)
      await call('evaluate', { candidateId: 'r01' })
      await call('verify', { candidateId: 'r01' })
      await call('submit')
      assert.deepEqual(mock.requests.map(r => r.body.candidateId).filter(Boolean), ['original', 'r01', 'r01'])
      assert.ok(mock.requests.every(r => r.url === `http://127.0.0.1:4337/api/repair/tool/${r.url.split('/').at(-1)}`))
      assert.ok(mock.requests.every(r => r.init.headers['X-Print-Task-Access'] === env.PRINT_TASK_JOB_ACCESS))
    })
  } finally { mock.restore() }
})

test('applying another repair invalidates the previous verification and failed evaluations can be retried', async () => {
  const tools = await installTools(await freshPlugin())
  const mock = mockFetch((op, body) => {
    if (op === 'inspect') return { success: true, repairOptionsMm: [0.1, 0.2, 0.3] }
    if (op === 'evaluate') return evaluateSuccess(body.candidateId, body.candidateId === 'r01' || body.candidateId === 'r03')
    if (op === 'apply') return { success: true, candidateId: `r${String(body.radiusMm * 10).padStart(2, '0')}` }
    if (op === 'verify') return { success: true, candidateId: body.candidateId }
    return { success: true, candidateId: 'r03' }
  })
  try {
    await withEnv(env, async () => {
      const call = (name, args = {}) => tools.get(`repair_${name}`).execute(args, {})
      await call('inspect')
      await call('evaluate', { candidateId: 'original' })
      await call('apply', { radiusMm: 0.1 })
      await call('evaluate', { candidateId: 'r01' })
      await call('verify', { candidateId: 'r01' })
      await call('apply', { radiusMm: 0.2 })
      await assert.rejects(call('submit'), /successful repair_verify/)
      await call('evaluate', { candidateId: 'r02' })
      await call('apply', { radiusMm: 0.3 })
      await call('evaluate', { candidateId: 'r03' })
      await call('verify', { candidateId: 'r03' })
      await call('submit')
    })
  } finally { mock.restore() }
})

test('caps the whole native session at twelve calls', async () => {
  const tools = await installTools(await freshPlugin())
  const mock = mockFetch(op => op === 'inspect' ? { success: true, repairOptionsMm: [] } : { success: true })
  try {
    await withEnv(env, async () => {
      const inspect = () => tools.get('repair_inspect').execute({}, {})
      await inspect()
      for (let i = 0; i < 11; i++) await inspect()
      await assert.rejects(inspect(), /budget exhausted/)
      assert.equal(mock.requests.length, 12)
    })
  } finally { mock.restore() }
})

test('allows only one submit attempt, even when the service rejects it', async () => {
  const tools = await installTools(await freshPlugin())
  const mock = mockFetch((op, body) => {
    if (op === 'inspect') return { success: true, repairOptionsMm: [] }
    if (op === 'evaluate') return evaluateSuccess(body.candidateId, true)
    if (op === 'verify') return { success: true, candidateId: body.candidateId }
    if (op === 'submit') return { success: false, candidateId: body.candidateId, reason: 'delivery rejected' }
    throw new Error(op)
  })
  try {
    await withEnv(env, async () => {
      const call = (name, args = {}) => tools.get(`repair_${name}`).execute(args, {})
      await call('inspect')
      await call('evaluate', { candidateId: 'original' })
      await call('verify', { candidateId: 'original' })
      await call('submit')
      await assert.rejects(call('submit'), /already attempted submission/)
      assert.equal(mock.requests.filter(request => request.url.endsWith('/submit')).length, 1)
    })
  } finally { mock.restore() }
})

test('runner binds the configured Command Code route/model and an isolated workspace', async () => {
  const { runRepairTask } = await import('./repair-agh.mjs')
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'repair-agh-'))
  let launch
  try {
    const result = await runRepairTask({ jobId: 'repair-job', accessToken: env.PRINT_TASK_JOB_ACCESS, workspaceRoot,
      env: { USERPROFILE: 'C:\\Users\\test', PHOTO_CAD_AGH_HOME: 'C:\\Users\\test\\.agh-photo-cad-v2' },
      status: async () => ({ aghAvailable: true, modelConfigured: true, route: 'command-code/primary', model: 'deepseek/deepseek-v4.1-flash', provider: 'command-code', pluginInstalled: true, pluginTrusted: true, pluginEnabled: true }),
      spawn: async (executable, args, options) => { launch = { executable, args, options }; return { stdout: JSON.stringify({ v: 'agnes-cli-result/v1', sessionId: 's', reason: 'completed', exitCode: 0, lastSeq: 1 }) } },
    })
    assert.equal(result.success, true)
    assert.ok(launch.args.includes('--preset') && launch.args.includes('feature-repair-tools'))
    assert.ok(launch.args.includes('primary=command-code/primary/deepseek/deepseek-v4.1-flash'))
    assert.equal(launch.options.env.PRINT_TASK_JOB_ID, 'repair-job')
    assert.equal(launch.options.env.PRINT_TASK_JOB_ACCESS, env.PRINT_TASK_JOB_ACCESS)
    assert.equal(launch.options.cwd, process.cwd())
    assert.ok(launch.args[launch.args.indexOf('--cwd') + 1].endsWith('repair-job'))
    assert.equal(launch.options.timeout, 600_000)
  } finally { await rm(workspaceRoot, { recursive: true, force: true }) }
})

test('runner refuses a missing newly installed repair package', async () => {
  const { runRepairTask } = await import('./repair-agh.mjs')
  await assert.rejects(runRepairTask({ jobId: 'repair-job', accessToken: env.PRINT_TASK_JOB_ACCESS,
    status: async () => ({ aghAvailable: true, modelConfigured: true, route: 'route', model: 'model', provider: 'command-code', pluginInstalled: false, pluginTrusted: true, pluginEnabled: true }),
  }), /AGH_PLUGIN_NOT_READY/)
})

test('status requires the new repair package independently of the pose package', async () => {
  const { getRepairAghStatus } = await import('./repair-agh.mjs')
  const baseStatus = async () => ({ modelConfigured: true, provider: 'command-code', route: 'command-code/primary', model: 'deepseek/deepseek-v4.1-flash' })
  const readLock = async () => JSON.stringify({ profile: 'local-dev', packages: { '@photo-cad/pose-tools': { state: { trusted: true, enabled: true } } } })
  const missing = await getRepairAghStatus({ env: {}, fileExists: async () => true, readFile: readLock, baseStatus })
  assert.equal(missing.pluginInstalled, false)
  const ready = await getRepairAghStatus({ env: {}, fileExists: async () => true,
    readFile: async () => JSON.stringify({ profile: 'local-dev', packages: { '@photo-cad/feature-repair-tools': { state: { trusted: true, enabled: true } } } }), baseStatus })
  assert.equal(ready.ready, true)
  assert.equal(ready.model, 'deepseek/deepseek-v4.1-flash')
})

test('runner dynamically binds the verified Agnes route and model', async () => {
  const { runRepairTask } = await import('./repair-agh.mjs')
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'repair-agh-agnes-'))
  let launch
  try {
    await runRepairTask({ jobId: 'agnes-repair-job', accessToken: env.PRINT_TASK_JOB_ACCESS, workspaceRoot,
      env: { USERPROFILE: 'C:\\Users\\test' },
      status: async () => ({ aghAvailable: true, modelConfigured: true, route: 'agnes-ai/verified-route', model: 'agnes-3.0-flash', provider: 'agnes-ai', pluginInstalled: true, pluginTrusted: true, pluginEnabled: true }),
      spawn: async (_executable, args, options) => { launch = { args, options }; return { stdout: JSON.stringify({ v: 'agnes-cli-result/v1', sessionId: 's', reason: 'completed', exitCode: 0, lastSeq: 1 }) } },
    })
    assert.ok(launch.args.includes('primary=agnes-ai/verified-route/agnes-3.0-flash'))
  } finally { await rm(workspaceRoot, { recursive: true, force: true }) }
})
