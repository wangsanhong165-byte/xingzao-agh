import { basename, resolve } from 'node:path'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { getPrintAghStatus, printAghInternals } from './print-agh.mjs'

const PROFILE = 'local-dev'
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 128 * 1024
const MAX_TOOL_CALLS = 12
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function safePluginState(value) {
  try {
    const lock = JSON.parse(value)
    const item = lock?.profile === PROFILE ? lock.packages?.['@photo-cad/reconstruction-tools'] : null
    return { pluginInstalled: Boolean(item), pluginTrusted: Boolean(item?.state?.trusted), pluginEnabled: item?.state?.enabled === true }
  } catch {
    return { pluginInstalled: false, pluginTrusted: false, pluginEnabled: false }
  }
}

export async function getReconstructionAghStatus(options = {}) {
  const sourceEnv = options.env ?? process.env
  const env = { ...sourceEnv, PHOTO_CAD_AGH_HOME: printAghInternals.reconstructionHome(sourceEnv) }
  const exists = options.fileExists ?? (async (path) => import('node:fs/promises').then(({ access }) => access(path).then(() => true, () => false)))
  const readFile = options.readFile ?? ((...args) => import('node:fs/promises').then(({ readFile: read }) => read(...args)))
  const [base, cliAvailable] = await Promise.all([
    (options.baseStatus ?? getPrintAghStatus)({ env, fileExists: exists, readFile }),
    exists(printAghInternals.cliPath(env)),
  ])
  const lockText = await readFile(printAghInternals.packageLockPath(env), 'utf8').catch(() => null)
  const plugin = safePluginState(lockText ?? '')
  const modelConfigured = Boolean(cliAvailable && base.modelConfigured
    && typeof base.provider === 'string' && base.provider.trim()
    && typeof base.route === 'string' && base.route.trim()
    && typeof base.model === 'string' && base.model.trim())
  return {
    aghAvailable: cliAvailable,
    configured: modelConfigured,
    modelConfigured,
    profile: PROFILE,
    provider: modelConfigured ? base.provider : null,
    route: modelConfigured ? base.route : null,
    model: modelConfigured ? base.model : null,
    ...plugin,
    ready: Boolean(modelConfigured && plugin.pluginInstalled && plugin.pluginTrusted && plugin.pluginEnabled),
    ...(!modelConfigured ? { reason: !cliAvailable ? 'AGH_CLI_NOT_FOUND' : 'RECONSTRUCTION_MODEL_NOT_CONFIGURED' } : {}),
  }
}

function validJobId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new TypeError('jobId must be a generated reconstruction job identifier')
  return value
}

async function ensureRealDirectory(path) {
  try {
    await mkdir(path)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('RECONSTRUCTION_WORKSPACE_INVALID')
}

async function createReconstructionWorkspace(jobId, root = PROJECT_ROOT) {
  validJobId(jobId)
  const projectRoot = resolve(root)
  const workspaceParent = join(projectRoot, 'data', 'reconstruction', 'agh-workspaces')
  const workspace = join(workspaceParent, jobId)
  const relativePath = relative(projectRoot, workspace)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
    throw new Error('RECONSTRUCTION_WORKSPACE_INVALID')
  const rootStat = await lstat(projectRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('RECONSTRUCTION_WORKSPACE_INVALID')
  for (const directory of [
    join(projectRoot, 'data'),
    join(projectRoot, 'data', 'reconstruction'),
    workspaceParent,
  ]) await ensureRealDirectory(directory)
  let created = false
  try {
    await mkdir(workspace)
    created = true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const stat = await lstat(workspace)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('RECONSTRUCTION_WORKSPACE_INVALID')
  if (!created) throw new Error('RECONSTRUCTION_WORKSPACE_ALREADY_EXISTS')
  if ((await readdir(workspace)).length !== 0) throw new Error('RECONSTRUCTION_WORKSPACE_NOT_EMPTY')
  return workspace
}

function validAccessToken(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512 || /\s/u.test(value)) throw new TypeError('accessToken must be a task-scoped service credential')
  return value
}

function makePrompt(task, jobId) {
  const text = typeof task === 'string' ? task : JSON.stringify(task ?? {})
  return [
    'You are the AGH agent for a three-view mesh reconstruction job. Use only the native tools mesh_inspect, mesh_generate, mesh_validate, mesh_slice, and mesh_submit.',
    `This session is bound to job ${jobId}. Use at most ${MAX_TOOL_CALLS} native tool calls and no more than two mesh_generate calls. Do not use shell, direct HTTP, other plugins, scripts, or arbitrary commands.`,
    'Follow this order: inspect the job; generate a candidate using bounded options; validate that candidate; run the actual slicer on that candidate; submit only after all returned checks pass. If validation or slicing fails, make at most one evidence-based bounded generation retry, then validate and actually slice the retry before any submission. Never invent candidate ids or results.',
    'The first candidate should use the tested reference recipe: 25 steps, resolution 256, numChunks 8000, seed 12345. Use the same referenceGenerationSettings returned by inspect. Do not minimize sampling merely to shorten runtime or reduce the generated volume. Change these settings only in response to a concrete resource failure; a reduced-sampling result is a preview, not evidence of material optimization or preserved appearance.',
    'The user selected the target longest edge. Keep it unchanged. Treat tool responses as authoritative and stop if a required stage fails or the call budget is exhausted.',
    'Report which native tool actions actually ran, the chosen candidate id and returned evidence, submission outcome, and limits. The mesh and slice are a baseline; do not claim physical printability, reconstruction accuracy, or optimality.',
    '', 'User task:', text.slice(0, 6000),
  ].join('\n')
}

export async function runReconstructionTask(options = {}) {
  const jobId = validJobId(options.jobId)
  const accessToken = validAccessToken(options.accessToken)
  const sourceEnv = options.env ?? process.env
  const env = { ...sourceEnv, PHOTO_CAD_AGH_HOME: printAghInternals.reconstructionHome(sourceEnv) }
  const status = await (options.status ?? getReconstructionAghStatus)({ env })
  if (!status.aghAvailable) throw new Error('AGH_CLI_NOT_FOUND: install the supported AGH build before running this task')
  if (!status.modelConfigured || typeof status.provider !== 'string' || !status.provider.trim()
    || typeof status.route !== 'string' || !status.route.trim()
    || typeof status.model !== 'string' || !status.model.trim())
    throw new Error('RECONSTRUCTION_MODEL_NOT_CONFIGURED: configure a supported provider model in the isolated local-dev profile')
  if (!status.pluginInstalled || !status.pluginTrusted || !status.pluginEnabled)
    throw new Error('AGH_PLUGIN_NOT_READY: inspect, install, trust, and enable the reviewed reconstruction plugin')
  const serviceUrl = options.serviceUrl ?? 'http://127.0.0.1:4337'
  const endpoint = new URL(serviceUrl)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== '4337' || endpoint.pathname !== '/')
    throw new TypeError('serviceUrl must be the loopback reconstruction service at port 4337')
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.min(Math.max(options.timeoutMs, 1_000), MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS
  const launchCwd = PROJECT_ROOT
  const sessionCwd = await createReconstructionWorkspace(jobId)
  const prompt = makePrompt(options.task, jobId)
  const args = [printAghInternals.cliPath(env), '-p', prompt, '--mode', 'json', '--standalone', '--profile', PROFILE, '--preset', 'reconstruction-tools',
    '--model', `primary=${status.route}/${status.model}`, '--cwd', sessionCwd]
  const startedAt = new Date().toISOString()
  const invoke = options.spawn ?? printAghInternals.execFileWithClosedStdin
  try {
    const child = await invoke(process.execPath, args, {
      cwd: launchCwd, env: printAghInternals.cleanEnvironment(env, jobId, endpoint.origin, accessToken), windowsHide: true,
      timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8',
    })
    const result = printAghInternals.parseCliResult(child?.stdout)
    const exitCode = result?.exitCode ?? (Number.isInteger(child?.code) ? child.code : 0)
    const success = result !== null && exitCode === 0 && result.reason === 'completed'
    return {
      success,
      ...(!result ? { reason: 'AGH_RESULT_MISSING' } : success ? {} : { reason: result.reason }),
      ...(result?.text ? { agentOutput: String(result.text).slice(0, 12_000) } : {}),
      execution: printAghInternals.executionMetadata(status, env, result, startedAt, exitCode),
    }
  } catch (error) {
    const timedOut = error?.code === 'ETIMEDOUT' || error?.killed === true
    const result = printAghInternals.parseCliResult(error?.stdout)
    const exitCode = result?.exitCode ?? (Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.code) ? error.code : null)
    return {
      success: false,
      reason: result?.reason && result.reason !== 'completed' ? result.reason : timedOut ? 'AGH_RUN_TIMEOUT' : 'AGH_RUN_FAILED',
      ...(result?.text ? { agentOutput: String(result.text).slice(0, 12_000) } : {}),
      execution: printAghInternals.executionMetadata(status, env, result, startedAt, exitCode, {
        errorName: typeof error?.name === 'string' ? error.name : null,
        errorCode: typeof error?.code === 'string' && /^(?:ERR_[A-Z0-9_]+|E[A-Z0-9_]+)$/u.test(error.code) ? error.code : null,
        executable: basename(process.execPath), killed: error?.killed === true,
      }),
    }
  }
}

export const reconstructionAghInternals = Object.freeze({ TOOL_TIMEOUT_MS: 330_000, MAX_TIMEOUT_MS, MAX_TOOL_CALLS, safePluginState, createReconstructionWorkspace })
