import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runReconstructionTask, getReconstructionAghStatus, reconstructionAghInternals } from './reconstruction-agh.mjs'
import { reconstructionTools, reconstructionPluginInternals, presets } from '../reconstruction-agh-plugin/index.mjs'

const status = {
  aghAvailable: true, modelConfigured: true, profile: 'local-dev',
  provider: 'agnes-ai', route: 'account-private', model: 'agnes-3.0-flash',
  pluginInstalled: true, pluginTrusted: true, pluginEnabled: true,
}

test('status exposes only pinned model and package trust state', async () => {
  const value = await getReconstructionAghStatus({
    env: { USERPROFILE: 'C:\\Users\\test' },
    fileExists: async () => true,
    readFile: async () => JSON.stringify({
      profile: 'local-dev', packages: { '@photo-cad/reconstruction-tools': { state: { trusted: true, enabled: true } } },
      apiKey: 'must-not-escape',
    }),
    baseStatus: async () => ({ aghAvailable: true, modelConfigured: true, provider: 'agnes-ai', route: 'account-private', model: 'agnes-3.0-flash' }),
  })
  assert.deepEqual(value, {
    aghAvailable: true, configured: true, modelConfigured: true, profile: 'local-dev', provider: 'agnes-ai', route: 'account-private', model: 'agnes-3.0-flash',
    pluginInstalled: true, pluginTrusted: true, pluginEnabled: true, ready: true,
  })
  assert.doesNotMatch(JSON.stringify(value), /must-not-escape|apiKey/u)
})

test('status projects a verified CommandCode DeepSeek V4.1 Flash configuration', async () => {
  const value = await getReconstructionAghStatus({
    env: { USERPROFILE: 'C:\\Users\\test' }, fileExists: async () => true,
    readFile: async () => JSON.stringify({ profile: 'local-dev', packages: { '@photo-cad/reconstruction-tools': { state: { trusted: true, enabled: true } } } }),
    baseStatus: async () => ({ aghAvailable: true, modelConfigured: true, provider: 'command-code', route: 'account-cc', model: 'deepseek/deepseek-v4.1-flash' }),
  })
  assert.equal(value.ready, true)
  assert.equal(value.provider, 'command-code')
  assert.equal(value.route, 'account-cc')
  assert.equal(value.model, 'deepseek/deepseek-v4.1-flash')
})

test('runner pins the dedicated v2 profile, exact model, bounded call count, and reconstruction workflow', async (t) => {
  let launched
  const jobId = `job_${randomUUID()}`
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspacePath = join(projectRoot, 'data', 'reconstruction', 'agh-workspaces', jobId)
  t.after(async () => {
    try { await rmdir(workspacePath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  })
  const result = await runReconstructionTask({
    jobId, accessToken: 'private-job-token-value', task: 'Create from three views',
    env: { USERPROFILE: 'C:\\Users\\test', PRINT_TASK_JOB_ACCESS: 'inherited-secret', API_KEY: 'must-not-leak' },
    status: async () => status,
    spawn: async (_file, args, options) => {
      launched = { args, options }
      return { stdout: JSON.stringify({ v: 'agnes-cli-result/v1', sessionId: 's1', reason: 'completed', exitCode: 0, lastSeq: 1, text: 'done' }) }
    },
  })
  assert.equal(result.success, true)
  assert.ok(launched.args.includes('--profile') && launched.args[launched.args.indexOf('--profile') + 1] === 'local-dev')
  assert.ok(launched.args.includes('--preset') && launched.args[launched.args.indexOf('--preset') + 1] === 'reconstruction-tools')
  const cwdArg = launched.args[launched.args.indexOf('--cwd') + 1]
  assert.equal(dirname(cwdArg), join(projectRoot, 'data', 'reconstruction', 'agh-workspaces'))
  assert.equal(basename(cwdArg), jobId)
  assert.equal(launched.options.cwd, projectRoot)
  assert.deepEqual(await readdir(cwdArg), [])
  assert.equal((await lstat(cwdArg)).isSymbolicLink(), false)
  assert.ok(launched.args.includes('--model') && launched.args[launched.args.indexOf('--model') + 1] === 'primary=account-private/agnes-3.0-flash')
  assert.ok(launched.args.some((arg) => /inspect.*generate.*validate.*actual slicer.*submit/su.test(arg)))
  assert.ok(launched.args.some((arg) => /12/iu.test(arg) && /two mesh_generate calls/iu.test(arg)))
  assert.ok(launched.args.some((arg) => /25 steps.*256.*8000.*12345/su.test(arg)), 'first candidate should use the actually tested reference recipe');
  assert.equal(launched.options.timeout, 600_000)
  assert.equal(launched.options.env.PRINT_TASK_JOB_ACCESS, 'private-job-token-value')
  assert.equal(launched.options.env.API_KEY, undefined)
  assert.doesNotMatch(launched.args.join(' '), /private-job-token-value|inherited-secret|must-not-leak/u)
})

test('runner binds verified CommandCode model and reports matching execution evidence', async (t) => {
  let launched
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspacePath = join(projectRoot, 'data', 'reconstruction', 'agh-workspaces', 'job_cc12345678')
  t.after(async () => { try { await rmdir(workspacePath) } catch (error) { if (error?.code !== 'ENOENT') throw error } })
  const commandCodeStatus = { ...status, provider: 'command-code', route: 'account-cc', model: 'deepseek/deepseek-v4.1-flash' }
  const result = await runReconstructionTask({
    jobId: 'job_cc12345678', accessToken: 'private-job-token-value', task: 'Reconstruct safely',
    env: { USERPROFILE: 'C:\\Users\\test' }, status: async () => commandCodeStatus,
    spawn: async (_file, args) => {
      launched = args
      return { stdout: JSON.stringify({ v: 'agnes-cli-result/v1', sessionId: 's1', reason: 'completed', exitCode: 0, lastSeq: 1, text: 'done' }) }
    },
  })
  assert.equal(result.success, true)
  assert.equal(launched[launched.indexOf('--model') + 1], 'primary=account-cc/deepseek/deepseek-v4.1-flash')
  assert.equal(result.execution.provider, 'command-code')
  assert.equal(result.execution.model, 'deepseek/deepseek-v4.1-flash')
})

test('runner rejects unconfigured or incomplete provider model status', async () => {
  for (const overrides of [
    { modelConfigured: false },
    { provider: '' },
    { route: '' },
    { model: '' },
  ]) {
    await assert.rejects(runReconstructionTask({
      jobId: 'job_12345678', accessToken: 'private-job-token-value', env: { USERPROFILE: 'C:\\Users\\test' },
      status: async () => ({ ...status, ...overrides }), spawn: async () => { throw new Error('must not launch') },
    }), /model|profile|not configured/iu)
  }
})

test('runner accepts only the reconstruction endpoint on loopback port 4337', async () => {
  await assert.rejects(runReconstructionTask({
    jobId: 'job_12345678', accessToken: 'private-job-token-value', serviceUrl: 'http://127.0.0.1:4338',
    env: { USERPROFILE: 'C:\\Users\\test' }, status: async () => status, spawn: async () => { throw new Error('must not launch') },
  }), /4337/u)
})

test('runner caps caller timeout at 600 seconds and preserves sanitized execution evidence', async (t) => {
  let timeout
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspacePath = join(projectRoot, 'data', 'reconstruction', 'agh-workspaces', 'job_timeout123')
  t.after(async () => {
    try { await rmdir(workspacePath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  })
  const result = await runReconstructionTask({
    jobId: 'job_timeout123', accessToken: 'private-job-token-value', timeoutMs: 9_000_000,
    env: { USERPROFILE: 'C:\\Users\\test' }, status: async () => status,
    spawn: async (_file, _args, options) => { timeout = options.timeout; return { stdout: '' } },
  })
  assert.equal(timeout, 600_000)
  assert.equal(result.success, false)
  assert.equal(result.reason, 'AGH_RESULT_MISSING')
  assert.equal(result.execution.model, 'agnes-3.0-flash')
})

test('job workspace creation is unique, empty, and rejects reused or non-directory targets', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'photo-cad-reconstruction-workspace-'))
  try {
    const first = await reconstructionAghInternals.createReconstructionWorkspace('job_first', temporaryRoot)
    const second = await reconstructionAghInternals.createReconstructionWorkspace('job_second', temporaryRoot)
    assert.notEqual(first, second)
    assert.deepEqual(await readdir(first), [])
    assert.deepEqual(await readdir(second), [])
    assert.equal((await lstat(first)).isSymbolicLink(), false)
    await assert.rejects(reconstructionAghInternals.createReconstructionWorkspace('job_first', temporaryRoot), /ALREADY_EXISTS/u)

    const parent = join(temporaryRoot, 'data', 'reconstruction', 'agh-workspaces')
    const fileTarget = join(parent, 'job_file')
    await writeFile(fileTarget, 'occupied')
    await assert.rejects(reconstructionAghInternals.createReconstructionWorkspace('job_file', temporaryRoot), /WORKSPACE_INVALID/u)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('plugin exports five tools and posts only to the fixed reconstruction tool endpoint', async () => {
  assert.deepEqual(reconstructionTools.map((item) => item.name), [
    'mesh_inspect', 'mesh_generate', 'mesh_validate', 'mesh_slice', 'mesh_submit',
  ])
  assert.equal(reconstructionAghInternals.TOOL_TIMEOUT_MS, 330_000)
  assert.equal(reconstructionPluginInternals.requestTimeoutMs({ timeoutMs: 120_000 }), 119_000)
  assert.equal(reconstructionPluginInternals.requestTimeoutMs({ timeoutMs: 330_000 }), 329_000)
  assert.equal(reconstructionPluginInternals.requestTimeoutMs({ timeoutMs: 600_000 }), 330_000)
  assert.equal(reconstructionPluginInternals.requestTimeoutMs(undefined), 119_000)
  assert.equal(presets['reconstruction-tools'].extends, 'standard')
  assert.equal(presets['reconstruction-tools'].tools.timeouts.mesh_generate, 330_000)
})

test('plugin binds one job, enforces 12 calls, permits at most two generation attempts, and isolates credentials', async () => {
  const previous = { ...process.env }
  const previousFetch = globalThis.fetch
  const posted = []
  let generated = 0
  let validationCalls = 0
  process.env.PRINT_TASK_JOB_ID = 'job_12345678'
  process.env.PRINT_TASK_SERVICE_URL = 'http://127.0.0.1:4337'
  process.env.PRINT_TASK_JOB_ACCESS = 'private-job-token-value'
  globalThis.fetch = async (url, init) => {
    posted.push({ url: String(url), init })
    const route = new URL(String(url)).pathname.split('/').at(-1)
    if (route === 'generate') generated += 1
    const response = route === 'generate'
      ? { success: true, candidateId: `candidate_1234567${generated}`, generation: { steps: 25 } }
      : route === 'validate'
        ? ++validationCalls === 1
          ? { success: false, code: 'IMAGE_VIEW_UNSUPPORTED' }
          : { success: true, valid: true, candidateId: 'candidate_12345671', geometryChecks: { passed: true } }
        : route === 'slice'
          ? { success: true, candidateId: 'candidate_12345671', slice: { mode: 'actual-slicer', execution: { mode: 'actual-slicer' } } }
          : { success: true, candidateId: 'candidate_12345671', submitted: true }
    return Response.json(response)
  }
  try {
    const calls = []
    const ctx = { extension: () => ({ registerTool: (tool) => calls.push(tool) }) }
    for (const item of reconstructionTools) item.apply(ctx)
    const byName = Object.fromEntries(calls.map((tool) => [tool.name, tool]))
    const toolContext = { timeoutMs: 330_000, signal: new AbortController().signal }
    await assert.rejects(byName.mesh_generate.execute({ options: { steps: 25, resolution: 256, numChunks: 8000, seed: 0 } }, toolContext), /inspect must be called/iu)
    await byName.mesh_inspect.execute({}, toolContext)
    await byName.mesh_generate.execute({ options: { steps: 25, resolution: 256, numChunks: 8000, seed: 1 } }, toolContext)
    await assert.rejects(byName.mesh_slice.execute({ candidateId: 'candidate_12345671' }, toolContext), /validated candidate/iu)
    const failedValidation = await byName.mesh_validate.execute({ candidateId: 'candidate_12345671' }, toolContext)
    const failureText = failedValidation.content[0].text
    assert.match(failureText, /IMAGE_VIEW_UNSUPPORTED/u)
    assert.match(failureText, /reason.*IMAGE_VIEW_UNSUPPORTED/u)
    await byName.mesh_validate.execute({ candidateId: 'candidate_12345671' }, toolContext)
    await byName.mesh_slice.execute({ candidateId: 'candidate_12345671' }, toolContext)
    await byName.mesh_submit.execute({ candidateId: 'candidate_12345671' }, toolContext)
    await byName.mesh_generate.execute({ options: { steps: 25, resolution: 256, numChunks: 8000, seed: 2 } }, toolContext)
    await assert.rejects(byName.mesh_generate.execute({ options: { steps: 25, resolution: 256, numChunks: 8000, seed: 3 } }, toolContext), /generated|candidate limit/iu)
    assert.equal(posted.length, 7)
    for (const item of posted) {
      assert.match(item.url, /^http:\/\/127\.0\.0\.1:4337\/api\/reconstruction\/tool\//u)
      assert.equal(item.init.headers['x-print-task-access'], 'private-job-token-value')
      assert.doesNotMatch(JSON.stringify(item.init.body), /private-job-token-value/u)
      assert.ok(item.init.signal instanceof AbortSignal)
    }
    assert.equal(byName.mesh_generate.parameters.properties.options.properties.steps.minimum, 5)
    assert.equal(byName.mesh_generate.parameters.properties.options.properties.steps.maximum, 50)
    assert.equal(byName.mesh_generate.parameters.properties.options.properties.numChunks.enum.join(','), '4000,8000,20000')
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
    globalThis.fetch = previousFetch
  }
})
