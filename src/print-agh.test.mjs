import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { getPrintAghStatus, printAghInternals, runPrintTask } from './print-agh.mjs'
import { compactResult } from '../tools/print-tool-bridge.mjs'
import { createOfflineFetchGate } from '../tools/diagnostics/offline-agnes-tools.mjs'

const execFile = promisify(execFileCallback)

test('offline Command Code probe captures Responses tool names without making a network request', async () => {
  const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const outputRoot = path.join(projectRoot, 'data', 'print-validation')
  await mkdir(outputRoot, { recursive: true })
  const directory = await mkdtemp(path.join(outputRoot, '.offline-command-tools-'))
  const tracePath = path.join(directory, 'trace.json')
  let fetched = false
  const gate = createOfflineFetchGate({ projectRoot, tracePath, originalFetch: async () => { fetched = true } })
  try {
    await assert.rejects(gate('https://api.commandcode.ai/provider/v1/responses', {
      method: 'POST', body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash',
        input: 'private-prompt-not-recorded', tools: [{ type: 'function', name: 'pose_inspect' }, { type: 'function', name: 'pose_submit' }] }),
    }), error => error.code === 'OFFLINE_TOOL_PROBE_BLOCKED')
    const trace = JSON.parse(await readFile(tracePath, 'utf8'))
    assert.equal(trace.model, 'deepseek/deepseek-v4.1-flash')
    assert.deepEqual(trace.toolNames, ['pose_inspect', 'pose_submit'])
    assert.equal(trace.blockedBeforeFetch, true)
    assert.equal(fetched, false)
    assert.doesNotMatch(JSON.stringify(trace), /private-prompt-not-recorded/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('offline Agnes probe records only model/tool names and blocks before original fetch', async () => {
  const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const outputRoot = path.join(projectRoot, 'data', 'print-validation')
  await mkdir(outputRoot, { recursive: true })
  const directory = await mkdtemp(path.join(outputRoot, '.offline-tool-names-'))
  const tracePath = path.join(directory, 'trace.json')
  let originalFetchCalled = false
  const gate = createOfflineFetchGate({
    projectRoot,
    tracePath,
    originalFetch: async () => { originalFetchCalled = true; return new Response('must not run') },
    now: () => '2026-10-02T00:00:00.000Z',
  })
  try {
    await assert.rejects(gate('https://api.agnes-ai.cn/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer never-store-this-token' },
      body: JSON.stringify({
        model: 'agnes-3.0-flash',
        messages: [{ role: 'user', content: 'never-store-this-prompt' }],
        tools: [
          { type: 'function', function: { name: 'detail_inspect', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'detail_submit', parameters: { type: 'object' } } },
        ],
      }),
    }), (error) => error.code === 'OFFLINE_TOOL_PROBE_BLOCKED')
    const trace = JSON.parse(await readFile(tracePath, 'utf8'))
    assert.deepEqual(trace, {
      at: '2026-10-02T00:00:00.000Z',
      endpoint: 'agnes-chat-completions',
      model: 'agnes-3.0-flash',
      toolNames: ['detail_inspect', 'detail_submit'],
      blockedBeforeFetch: true,
    })
    assert.equal(originalFetchCalled, false)
    assert.doesNotMatch(JSON.stringify(trace), /never-store-this-token|never-store-this-prompt|parameters/u)
    await assert.rejects(gate('https://unexpected.example/v1/chat/completions', { method: 'POST' }),
      (error) => error.code === 'OFFLINE_TOOL_PROBE_BLOCKED')
    assert.equal(originalFetchCalled, false)
    assert.deepEqual(JSON.parse(await readFile(tracePath, 'utf8')), trace)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('AGH child stdin is closed immediately so positional -p prompts do not wait for EOF', async () => {
  const result = await printAghInternals.execFileWithClosedStdin(process.execPath, [
    '-e',
    'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("stdin-closed"));',
  ], { timeout: 1500, encoding: 'utf8' })
  assert.equal(result.stdout, 'stdin-closed')
})

test('status uses only the dedicated AGH home and reports missing profile model without secrets', async () => {
  const status = await getPrintAghStatus({
    env: { USERPROFILE: 'C:\\Users\\tester', AGH_HOME: undefined, COMMAND_CODE_API_KEY: 'present' },
    fileExists: async (path) => path.endsWith('agnes.mjs'),
    readFile: async () => JSON.stringify({
      version: 2,
      profile: 'local-dev',
      accounts: [],
      defaultAccountId: null,
    }),
  })

  assert.equal(status.aghAvailable, true)
  assert.equal(status.modelConfigured, false)
  assert.equal(status.provider, null)
  assert.equal(status.profile, 'local-dev')
  assert.equal(JSON.stringify(status).includes('present'), false)
  assert.match(status.reason, /model/i)
})

test('dedicated home stays on the old private path by default and allows only the explicit v2 sibling', async () => {
  const oldHome = 'C:\\Users\\tester\\.agh-print-detail'
  const nextHome = 'C:\\Users\\tester\\.agh-print-detail-v2'
  assert.equal(printAghInternals.dedicatedHome({ USERPROFILE: 'C:\\Users\\tester' }), oldHome)
  assert.equal(printAghInternals.dedicatedHome({ USERPROFILE: 'C:\\Users\\tester', PHOTO_CAD_AGH_HOME: nextHome }), nextHome)

  const seen = []
  await getPrintAghStatus({
    env: { USERPROFILE: 'C:\\Users\\tester', PHOTO_CAD_AGH_HOME: nextHome },
    fileExists: async (path) => path.endsWith('agnes.mjs'),
    readFile: async (path) => {
      seen.push(path)
      return path.endsWith('agnes-lock.json')
        ? '{}'
        : JSON.stringify({
            profile: 'local-dev',
            accounts: [{
              accountId: 'legacy-agnes-ai', id: 'agnes-ai', route: 'agnes-ai',
              baseUrl: 'https://api.agnes-ai.cn/v1', model: 'agnes-3.0-flash',
              credentialRef: 'secret://agnes-ai/profile-v2-r1', enabled: true,
            }],
            defaultAccountId: 'legacy-agnes-ai',
          })
    },
  })
  assert.ok(seen.length > 0)
  assert.ok(seen.every((path) => path.startsWith(nextHome)))

  for (const invalid of [
    'C:\\Users\\tester\\.agh',
    'C:\\other\\.agh-print-detail-v2',
    '.agh-print-detail-v2',
  ]) assert.throws(() => printAghInternals.dedicatedHome({ USERPROFILE: 'C:\\Users\\tester', PHOTO_CAD_AGH_HOME: invalid }), /PHOTO_CAD_AGH_HOME/u)
})

test('status accepts only the CommandCode V4.1 model saved in the dedicated AGH route', async () => {
  const status = await getPrintAghStatus({
    env: { USERPROFILE: 'C:\\Users\\tester' },
    fileExists: async (path) => path.endsWith('agnes.mjs'),
    readFile: async () => JSON.stringify({
      version: 2,
      profile: 'local-dev',
      accounts: [{
        accountId: 'safe-id',
        id: 'command-code',
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        route: 'command-code',
        model: 'deepseek/deepseek-v4.1-flash',
        credentialRef: 'secret://command-code/default',
        enabled: true,
      }],
      defaultAccountId: 'safe-id',
    }),
  })
  assert.equal(status.modelConfigured, true)
  assert.equal(status.provider, 'command-code')
  assert.equal(status.model, 'deepseek/deepseek-v4.1-flash')
  assert.equal(status.baseUrl, 'https://api.commandcode.ai/provider/v1')
  assert.equal(status.ready, false)
})

test('status accepts the official Agnes stock account projection without exposing its secret reference', async () => {
  const status = await getPrintAghStatus({
    env: { USERPROFILE: 'C:\\Users\\tester' },
    fileExists: async (path) => path.endsWith('agnes.mjs'),
    readFile: async (path) => path.endsWith('agnes-lock.json') ? '{}' : JSON.stringify({
      profile: 'local-dev',
      revision: 8,
      configured: true,
      defaultAccountId: 'legacy-agnes-ai',
      provider: {
        id: 'agnes-ai',
        route: 'agnes-ai',
        baseUrl: 'https://api.agnes-ai.cn/v1',
        model: 'agnes-3.0-flash',
        credentialConfigured: true,
      },
      accounts: [{
        accountId: 'legacy-agnes-ai',
        providerId: 'agnes-ai',
        route: 'agnes-ai',
        baseUrl: 'https://api.agnes-ai.cn/v1',
        model: 'agnes-3.0-flash',
        enabled: true,
        authType: 'api-key',
        credentialConfigured: true,
      }],
      apiKey: 'snapshot-secret-sentinel',
    }),
  })
  assert.equal(status.modelConfigured, true)
  assert.equal(status.provider, 'agnes-ai')
  assert.equal(status.route, 'agnes-ai')
  assert.equal(status.model, 'agnes-3.0-flash')
  assert.equal(status.baseUrl, 'https://api.agnes-ai.cn/v1')
  assert.equal(JSON.stringify(status).includes('snapshot-secret-sentinel'), false)
  assert.equal(JSON.stringify(status).includes('secret://agnes-ai/'), false)
  assert.equal(JSON.stringify(status).includes('credentialConfigured'), false)
})

test('status accepts Agnes persisted accounts only with the official endpoint, model and Agnes secret ref', async () => {
  const account = {
    accountId: 'legacy-agnes-ai',
    id: 'agnes-ai',
    route: 'agnes-ai',
    baseUrl: 'https://api.agnes-ai.cn/v1',
    model: 'agnes-3.0-flash',
    credentialRef: 'secret://agnes-ai/profile-123-r4',
    enabled: true,
  }
  const read = (value) => async (path) => path.endsWith('agnes-lock.json')
    ? '{}'
    : JSON.stringify({ profile: 'local-dev', accounts: [value], defaultAccountId: value.accountId })
  const options = {
    env: { USERPROFILE: 'C:\\Users\\tester' },
    fileExists: async (path) => path.endsWith('agnes.mjs'),
  }
  const accepted = await getPrintAghStatus({ ...options, readFile: read(account) })
  assert.equal(accepted.modelConfigured, true)

  for (const invalid of [
    { ...account, baseUrl: 'https://evil.example/v1' },
    { ...account, model: 'agnes-3.0-pro' },
    { ...account, credentialRef: 'secret://command-code/profile-123-r4' },
    { ...account, credentialRef: 'secret://agnes-ai/' },
    { ...account, id: 'unreviewed-provider' },
  ]) {
    const rejected = await getPrintAghStatus({ ...options, readFile: read(invalid) })
    assert.equal(rejected.modelConfigured, false)
    assert.equal(rejected.provider, null)
  }
})

test('status projects only plugin lifecycle booleans from the isolated AGH lockfile', async () => {
  const status = await getPrintAghStatus({
    env: { USERPROFILE: 'C:\\Users\\tester' },
    fileExists: async () => true,
    readFile: async (path) => path.endsWith('agnes-lock.json')
      ? JSON.stringify({ profile: 'local-dev', packages: { '@photo-cad/print-detail-tools': { state: { trusted: '2026-10-01T00:00:00Z', enabled: true } } } })
      : '{}',
  })
  assert.equal(status.pluginInstalled, true)
  assert.equal(status.pluginTrusted, true)
  assert.equal(status.pluginEnabled, true)
  assert.equal(JSON.stringify(status).includes('2026-10-01'), false)
})

test('Agnes setup script refuses a missing key before importing or mutating configuration', async () => {
  const setup = new URL('../tools/setup-agnes-print.mjs', import.meta.url)
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    USERPROFILE: 'C:\\Users\\tester',
  }
  await assert.rejects(execFile(process.execPath, [fileURLToPath(setup)], { env }), (error) => {
    assert.equal(error.code, 2)
    assert.match(error.stderr, /AGNES_API_KEY/u)
    assert.doesNotMatch(error.stdout + error.stderr, /secret|sk-[A-Za-z0-9]/iu)
    return true
  })
})

test('runner fails closed before spawning when isolated AGH model is not configured', async () => {
  let spawned = false
  await assert.rejects(runPrintTask({
    jobId: 'job-1',
    accessToken: 'test-access-token-12345',
    task: 'Inspect and enhance this print detail job.',
    env: { USERPROFILE: 'C:\\Users\\tester' },
    status: async () => ({ aghAvailable: true, modelConfigured: false, reason: 'No profile model.' }),
    spawn: async () => { spawned = true; throw new Error('should not spawn') },
  }), /No profile model/)
  assert.equal(spawned, false)
})

test('runner requires validated job id and never falls back outside AGH', async () => {
  let spawned = false
  await assert.rejects(runPrintTask({
    jobId: '../other',
    accessToken: 'test-access-token-12345',
    task: 'Do work.',
    env: { USERPROFILE: 'C:\\Users\\tester' },
    status: async () => ({ aghAvailable: true, modelConfigured: true, provider: 'command-code', route: 'command-code', model: 'deepseek/deepseek-v4.1-flash' }),
    spawn: async () => { spawned = true; throw new Error('should not spawn') },
  }), /jobId/)
  assert.equal(spawned, false)
})

test('runner refuses to start until the reviewed plugin is trusted and enabled', async () => {
  let spawned = false
  await assert.rejects(runPrintTask({
    jobId: 'job_123',
    accessToken: 'test-access-token-12345',
    task: 'Do work.',
    env: { USERPROFILE: 'C:\\Users\\tester' },
    status: async () => ({ aghAvailable: true, modelConfigured: true, pluginInstalled: true, pluginTrusted: false, pluginEnabled: false, provider: 'command-code', route: 'command-code', model: 'deepseek/deepseek-v4.1-flash' }),
    spawn: async () => { spawned = true; throw new Error('should not spawn') },
  }), /AGH_PLUGIN_NOT_READY/)
  assert.equal(spawned, false)
})

test('runner passes an approved v2 home selector through to AGH without forwarding API keys', async () => {
  let invocation
  const selectedHome = 'C:\\Users\\tester\\.agh-print-detail-v2'
  const result = await runPrintTask({
    jobId: 'job_v2_home',
    accessToken: 'diagnostic-only-task-token-123456',
    task: 'Use the already selected private profile.',
    env: {
      USERPROFILE: 'C:\\Users\\tester',
      PHOTO_CAD_AGH_HOME: selectedHome,
      AGNES_API_KEY: 'local-secret-sentinel',
    },
    status: async () => ({
      aghAvailable: true,
      modelConfigured: true,
      pluginInstalled: true,
      pluginTrusted: true,
      pluginEnabled: true,
      provider: 'agnes-ai',
      route: 'agnes-ai',
      model: 'agnes-3.0-flash',
    }),
    spawn: async (exe, args, opts) => {
      invocation = { exe, args, opts }
      return { stdout: JSON.stringify({ v: 'agnes-cli-result/v1', sessionId: 'session-v2', reason: 'completed', exitCode: 0, lastSeq: 3, text: 'ready' }), stderr: '', code: 0 }
    },
  })
  assert.equal(result.success, true)
  assert.equal(result.execution.recordDir, `${selectedHome}\\data`)
  assert.equal(invocation.opts.env.AGH_HOME, selectedHome)
  assert.equal(invocation.opts.env.PHOTO_CAD_AGH_HOME, selectedHome)
  assert.equal(invocation.opts.env.AGNES_API_KEY, undefined)
  assert.equal(JSON.stringify(invocation.args).includes('local-secret-sentinel'), false)
})

test('runner records bounded startup codes and redacted stack frames when the child cannot spawn', async () => {
  const sentinel = 'do-not-persist-this-secret-or-prompt'
  const failure = Object.assign(new Error(sentinel), {
    code: 'ENOENT',
    errno: -4058,
    syscall: 'spawn C:\\private-child-path\\node.exe',
    path: 'C:\\private-child-path\\node.exe',
    stdout: sentinel,
    stderr: `Error [ERR_MODULE_NOT_FOUND]: ${sentinel}\n    at file:///C:/private-child-path/trace-hook.mjs:11:3\n`,
  })
  const result = await runPrintTask({
    jobId: 'job_spawn_diag',
    accessToken: 'diagnostic-only-task-token-123456',
    task: 'Run the already authorized task.',
    env: { USERPROFILE: 'C:\\Users\\tester' },
    status: async () => ({
      aghAvailable: true,
      modelConfigured: true,
      pluginInstalled: true,
      pluginTrusted: true,
      pluginEnabled: true,
      provider: 'agnes-ai',
      route: 'agnes-ai',
      model: 'agnes-3.0-flash',
    }),
    spawn: async () => { throw failure },
  })

  assert.equal(result.success, false)
  assert.equal(result.reason, 'AGH_RUN_FAILED')
  assert.deepEqual(result.execution.launchDiagnostic, {
    errorName: 'Error',
    errorCode: 'ENOENT',
    errno: -4058,
    syscall: 'spawn',
    executable: 'node.exe',
    status: null,
    signal: null,
    killed: false,
    stderrCodes: ['ERR_MODULE_NOT_FOUND'],
    stackFrames: ['trace-hook.mjs:11:3'],
  })
  assert.equal(JSON.stringify(result).includes(sentinel), false)
  assert.equal(JSON.stringify(result).includes('private-child-path'), false)
})

for (const runtime of [
  { provider: 'command-code', route: 'command-code', model: 'deepseek/deepseek-v4.1-flash' },
  { provider: 'agnes-ai', route: 'agnes-ai', model: 'agnes-3.0-flash' },
]) {
test(`runner binds ${runtime.model} before the prompt even when a persisted session has another model`, async () => {
  let invocation
  const result = await runPrintTask({
    jobId: 'job_123',
    accessToken: 'task-token-that-is-not-a-provider-key',
    task: { purpose: 'Protect the raised logo detail.', dimensions: { width: 40, depth: 30 } },
    env: { USERPROFILE: 'C:\\Users\\tester', COMMAND_CODE_API_KEY: 'secret-value', AGNES_PROFILE: 'other' },
    status: async () => ({ aghAvailable: true, modelConfigured: true, pluginInstalled: true, pluginTrusted: true, pluginEnabled: true, profile: 'local-dev', ...runtime }),
    spawn: async (exe, args, opts) => {
      invocation = { exe, args, opts }
      return { stdout: JSON.stringify({ v: 'agnes-cli-result/v1', sessionId: 'session-123', reason: 'completed', exitCode: 0, lastSeq: 18, text: 'AGH tool chain complete.' }), stderr: '', code: 0 }
    },
  })
  assert.equal(result.execution.mode, 'agh')
  assert.equal(result.execution.toolTransport, 'native-plugin')
  assert.equal(result.execution.model, runtime.model)
  assert.equal(result.execution.sessionId, 'session-123')
  assert.equal(result.execution.lastSeq, 18)
  assert.equal(result.execution.recordDir, 'C:\\Users\\tester\\.agh-print-detail\\data')
  assert.equal(invocation.args.includes('--model'), true)
  assert.ok(invocation.args.includes(`primary=${runtime.route}/${runtime.model}`))
  assert.ok(invocation.args.includes('--standalone'))
  const prompt = invocation.args[2]
  assert.match(prompt, /detail_inspect/u)
  assert.match(prompt, /detail_build/u)
  assert.match(prompt, /detail_slice/u)
  assert.match(prompt, /detail_verify/u)
  assert.match(prompt, /detail_submit/u)
  assert.match(prompt, /native AGH plugin tools/u)
  assert.doesNotMatch(prompt, /print-tool-bridge|builtin shell tool/iu)
  assert.ok(prompt.indexOf('enhance:false') < prompt.indexOf('reliefHeight:0.2'))
  assert.match(prompt, /layerHeightMm/u)
  assert.match(prompt, /lowest-material verified candidate/u)
  assert.doesNotMatch(prompt, /retry with reliefHeight 0\.6 mm/u)
  assert.match(prompt, /"purpose":"Protect the raised logo detail\."/u)
  assert.equal(invocation.opts.env.AGH_HOME, 'C:\\Users\\tester\\.agh-print-detail')
  assert.equal(invocation.opts.env.AGNES_PROFILE, 'local-dev')
  assert.equal(invocation.opts.env.COMMAND_CODE_API_KEY, undefined)
  assert.equal(invocation.opts.env.PRINT_TASK_JOB_ID, 'job_123')
  assert.equal(invocation.opts.env.PRINT_TASK_JOB_ACCESS, 'task-token-that-is-not-a-provider-key')
  assert.ok(!invocation.args.includes('task-token-that-is-not-a-provider-key'))
  assert.ok(!invocation.args.includes('secret-value'))
})
}

test('shell bridge refuses missing task credentials and invalid candidate ids without making HTTP requests', async () => {
  const bridge = new URL('../tools/print-tool-bridge.mjs', import.meta.url)
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PRINT_TASK_/u.test(name)))
  const missing = await execFile(process.execPath, [fileURLToPath(bridge), 'inspect'], { env: clean })
  assert.deepEqual(JSON.parse(missing.stdout), { success: false, reason: 'BRIDGE_TASK_CREDENTIAL_MISSING' })
  const invalid = await execFile(process.execPath, [fileURLToPath(bridge), 'slice', '../invalid'], {
    env: { ...clean, PRINT_TASK_JOB_ID: 'job_test', PRINT_TASK_JOB_ACCESS: 'diagnostic-only-token-123456' },
  })
  assert.deepEqual(JSON.parse(invalid.stdout), { success: false, reason: 'BRIDGE_CANDIDATE_INVALID' })
})

test('bridge preserves verify evidence for pass and failure while omitting preview artifacts', () => {
  const passed = compactResult('verify', {
    success: true,
    candidateId: 'candidate_1',
    hasRaisedDetail: true,
    featureLayerCount: 2,
    featureExtrusionLengthMm: 8.5,
    highestExtrusionZ: 2.8,
    fidelity: 0.91,
    criteria: { closed: true, dimensions: true, roi: true },
    previewSvg: '<svg>large preview</svg>',
  })
  assert.equal(passed.success, true)
  assert.equal(passed.hasRaisedDetail, true)
  assert.equal(passed.featureLayerCount, 2)
  assert.equal(passed.featureExtrusionLengthMm, 8.5)
  assert.equal(passed.fidelity, 0.91)
  assert.equal(passed.previewSvg, undefined)

  const failed = compactResult('verify', {
    success: false,
    candidateId: 'candidate_2',
    reason: 'Fewer than two raised-detail layers.',
    hasRaisedDetail: false,
    featureLayerCount: 1,
    featureExtrusionLengthMm: 1.2,
    fidelity: 0.6,
    criteria: { closed: true, roi: false },
  })
  assert.equal(failed.success, false)
  assert.equal(failed.hasRaisedDetail, false)
  assert.equal(failed.featureLayerCount, 1)
  assert.equal(failed.reason, 'Fewer than two raised-detail layers.')
  assert.deepEqual(failed.criteria, { closed: true, roi: false })
})

test('plugin declares only the five fixed detail tools and strict object arguments', async () => {
  const plugin = await import('../print-agh-plugin/index.mjs')
  const tools = [plugin.detailInspectTool, plugin.detailBuildTool, plugin.detailSliceTool, plugin.detailVerifyTool, plugin.detailSubmitTool]
  const definitions = new Map()
  for (const tool of tools) {
    tool.apply({ extension: () => ({ registerTool: (definition) => definitions.set(definition.name, definition) }) })
    assert.equal([...definitions.values()].at(-1).parameters.additionalProperties, false)
    assert.equal([...definitions.values()].at(-1).parameters.type, 'object')
  }
  assert.deepEqual([...definitions.keys()], ['detail_inspect', 'detail_build', 'detail_slice', 'detail_verify', 'detail_submit'])
  const build = definitions.get('detail_build')
  assert.deepEqual(build.parameters.required, ['options'])
  assert.equal(build.parameters.properties.candidateId, undefined)
  assert.deepEqual(build.parameters.properties.options.required, ['enhance'])
  assert.equal(build.meta.isReadOnly, false)
  assert.equal(build.meta.isDestructive, false)
  assert.equal(build.meta.replay, 'never')
  assert.equal(definitions.get('detail_slice').meta.isReadOnly, false)
  assert.equal(definitions.get('detail_submit').meta.isDestructive, false)
  assert.equal(definitions.get('detail_submit').meta.replay, 'never')
  assert.equal(definitions.get('detail_inspect').meta.isReadOnly, true)
})

test('plugin enforces build to slice to verify to submit for one fixed job using loopback service calls', async () => {
  const { detailInspectTool, detailBuildTool, detailSliceTool, detailVerifyTool, detailSubmitTool } = await import('../print-agh-plugin/index.mjs')
  const previousJob = process.env.PRINT_TASK_JOB_ID
  const previousAccess = process.env.PRINT_TASK_JOB_ACCESS
  const previousService = process.env.PRINT_TASK_SERVICE_URL
  const previousFetch = globalThis.fetch
  process.env.PRINT_TASK_JOB_ID = 'job_plugin_1'
  process.env.PRINT_TASK_JOB_ACCESS = 'plugin-task-access-token-123456'
  process.env.PRINT_TASK_SERVICE_URL = 'http://127.0.0.1:4337'
  const calls = []
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ path, body: JSON.parse(init.body), access: new Headers(init.headers).get('x-print-task-access') })
    const result = path.endsWith('/build')
      ? { success: true, candidateId: 'candidate_1', metrics: { volumeMm3: 200 } }
      : { success: true, candidateId: 'candidate_1', checks: [{ name: 'test', status: 'pass' }] }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const tools = new Map()
    for (const tool of [detailInspectTool, detailBuildTool, detailSliceTool, detailVerifyTool, detailSubmitTool])
      tool.apply({ extension: () => ({ registerTool: (definition) => tools.set(definition.name, definition) }) })
    const call = (name, args = {}) => tools.get(name).execute(args)
    await call('detail_inspect')
    await call('detail_build', { options: { enhance: true, reliefHeight: 0.6, minFeatureWidth: 0.8 } })
    await assert.rejects(call('detail_submit', { candidateId: 'candidate_1' }), /detail_verify/)
    await call('detail_slice', { candidateId: 'candidate_1' })
    await call('detail_verify', { candidateId: 'candidate_1' })
    await call('detail_submit', { candidateId: 'candidate_1' })
    assert.deepEqual(calls.map((entry) => entry.path.split('/').at(-1)), ['inspect', 'build', 'slice', 'verify', 'submit'])
    assert.ok(calls.every((entry) => entry.body.jobId === 'job_plugin_1'))
    assert.ok(calls.every((entry) => entry.access === 'plugin-task-access-token-123456'))
  } finally {
    globalThis.fetch = previousFetch
    if (previousJob === undefined) delete process.env.PRINT_TASK_JOB_ID
    else process.env.PRINT_TASK_JOB_ID = previousJob
    if (previousAccess === undefined) delete process.env.PRINT_TASK_JOB_ACCESS
    else process.env.PRINT_TASK_JOB_ACCESS = previousAccess
    if (previousService === undefined) delete process.env.PRINT_TASK_SERVICE_URL
    else process.env.PRINT_TASK_SERVICE_URL = previousService
  }
})
