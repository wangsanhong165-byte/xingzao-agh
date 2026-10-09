import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { getPrintAghStatus, printAghInternals } from './print-agh.mjs'

const PROFILE = 'local-dev'
const PACKAGE_ID = '@photo-cad/feature-repair-tools'
const PRESET = 'feature-repair-tools'
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 128 * 1024
const MAX_TOOL_CALLS = 12
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function safePluginState(value) {
  try {
    const lock = JSON.parse(value)
    const item = lock?.profile === PROFILE ? lock.packages?.[PACKAGE_ID] : null
    return { pluginInstalled: Boolean(item), pluginTrusted: Boolean(item?.state?.trusted), pluginEnabled: item?.state?.enabled === true }
  } catch { return { pluginInstalled: false, pluginTrusted: false, pluginEnabled: false } }
}

export async function getRepairAghStatus(options = {}) {
  const sourceEnv = options.env ?? process.env
  const env = { ...sourceEnv, PHOTO_CAD_AGH_HOME: printAghInternals.reconstructionHome(sourceEnv) }
  const exists = options.fileExists ?? (async path => import('node:fs/promises').then(({ access }) => access(path).then(() => true, () => false)))
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
    aghAvailable: cliAvailable, configured: modelConfigured, modelConfigured, profile: PROFILE,
    provider: modelConfigured ? base.provider : null, route: modelConfigured ? base.route : null,
    model: modelConfigured ? base.model : null, ...plugin,
    ready: Boolean(modelConfigured && plugin.pluginInstalled && plugin.pluginTrusted && plugin.pluginEnabled),
    ...(!modelConfigured ? { reason: !cliAvailable ? 'AGH_CLI_NOT_FOUND' : 'REPAIR_MODEL_NOT_CONFIGURED' } : {}),
  }
}

function validJobId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new TypeError('jobId must be a generated repair job identifier')
  return value
}
function validAccessToken(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512 || /\s/u.test(value)) throw new TypeError('accessToken must be a task-scoped service credential')
  return value
}
async function ensureDirectory(path) {
  try { await mkdir(path) } catch (error) { if (error?.code !== 'EEXIST') throw error }
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('REPAIR_WORKSPACE_INVALID')
}
async function createRepairWorkspace(jobId, root = PROJECT_ROOT) {
  validJobId(jobId)
  const projectRoot = resolve(root)
  const parent = join(projectRoot, 'data', 'repair-jobs', 'agh-workspaces')
  const workspace = join(parent, jobId)
  const rel = relative(projectRoot, workspace)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('REPAIR_WORKSPACE_INVALID')
  const rootStat = await lstat(projectRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('REPAIR_WORKSPACE_INVALID')
  for (const path of [join(projectRoot, 'data'), join(projectRoot, 'data', 'repair-jobs'), parent]) await ensureDirectory(path)
  try { await mkdir(workspace) } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('REPAIR_WORKSPACE_ALREADY_EXISTS')
    throw error
  }
  const stat = await lstat(workspace)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('REPAIR_WORKSPACE_INVALID')
  if ((await readdir(workspace)).length !== 0) throw new Error('REPAIR_WORKSPACE_NOT_EMPTY')
  return workspace
}

function makePrompt(task, jobId) {
  const safeTask = (typeof task === 'string' ? task : JSON.stringify(task ?? {})).slice(0, 6000)
  return [
    'You are the AGH local feature-repair agent. Use only repair_inspect, repair_evaluate, repair_apply, repair_verify, and repair_submit. Do not use shell, direct HTTP, other plugins, scripts, or arbitrary commands.',
    `This session is bound to job ${jobId}. Use at most ${MAX_TOOL_CALLS} native tool calls. The service owns the immutable source and all candidate IDs.`,
    'Call repair_inspect, then repair_evaluate with candidateId "original". If it is feasible, verify that exact candidate and submit. If it is not feasible, choose only a radiusMm listed in repairOptionsMm from inspect, call repair_apply, then evaluate only the returned candidateId. After each infeasible result, you may apply the next listed radius, at most three repairs total. Stop if no allowed radius remains or all three repairs fail.',
    'Call repair_verify only for an evaluated candidate whose returned feasible value is true. Submit only after successful verification of that same candidate. Never invent candidate IDs, radii, geometry, checks, or results. Do not exceed the tool-call budget or modify the requested constraints. A failed original remains failed evidence even if a derived repair passes.',
    'At completion, report the candidate IDs actually evaluated, their returned feasibility, verification and submission outcome, and the measured limits. Do not claim physical print success or properties not returned by the service.',
    '', 'User task:', safeTask || 'Repair a failed critical feature only with a permitted local correction, then re-evaluate and submit only if all checks pass.',
  ].join('\n')
}

function cleanRepairEnvironment(env, jobId, accessToken) {
  const home = printAghInternals.reconstructionHome(env)
  const clean = printAghInternals.cleanEnvironment(env, jobId, 'http://127.0.0.1:4337', accessToken)
  clean.PHOTO_CAD_AGH_HOME = home
  clean.AGH_HOME = home
  return clean
}

export async function runRepairTask(options = {}) {
  const jobId = validJobId(options.jobId)
  const accessToken = validAccessToken(options.accessToken)
  const serviceUrl = options.serviceUrl ?? 'http://127.0.0.1:4337'
  let service
  try { service = new URL(serviceUrl) } catch { throw new TypeError('serviceUrl must be the local repair service at http://127.0.0.1:4337') }
  if (service.protocol !== 'http:' || service.hostname !== '127.0.0.1' || service.port !== '4337' || service.pathname !== '/' || service.search || service.hash || service.username || service.password)
    throw new TypeError('serviceUrl must be the local repair service at http://127.0.0.1:4337')
  const sourceEnv = options.env ?? process.env
  const env = { ...sourceEnv, PHOTO_CAD_AGH_HOME: printAghInternals.reconstructionHome(sourceEnv) }
  const status = await (options.status ?? getRepairAghStatus)({ env })
  if (!status.aghAvailable) throw new Error('AGH_CLI_NOT_FOUND: install the supported AGH build before running this task')
  if (!status.modelConfigured || typeof status.provider !== 'string' || !status.provider.trim()
    || typeof status.route !== 'string' || !status.route.trim() || typeof status.model !== 'string' || !status.model.trim())
    throw new Error('REPAIR_MODEL_NOT_CONFIGURED: configure a verified provider model in the isolated local-dev profile')
  if (!status.pluginInstalled || !status.pluginTrusted || !status.pluginEnabled)
    throw new Error('AGH_PLUGIN_NOT_READY: inspect, install, trust, and enable the reviewed feature-repair plugin')
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.min(Math.max(options.timeoutMs, 1_000), MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS
  const cwd = await createRepairWorkspace(jobId, options.workspaceRoot ?? PROJECT_ROOT)
  const args = [printAghInternals.cliPath(env), '-p', makePrompt(options.task, jobId), '--mode', 'json', '--standalone', '--profile', PROFILE,
    '--preset', PRESET, '--model', `primary=${status.route}/${status.model}`, '--cwd', cwd]
  const startedAt = new Date().toISOString()
  const invoke = options.spawn ?? printAghInternals.execFileWithClosedStdin
  try {
    const child = await invoke(process.execPath, args, {
      cwd: PROJECT_ROOT, env: cleanRepairEnvironment(env, jobId, accessToken), windowsHide: true,
      timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8',
    })
    const result = printAghInternals.parseCliResult(child?.stdout)
    const exitCode = result?.exitCode ?? (Number.isInteger(child?.code) ? child.code : 0)
    const success = result !== null && exitCode === 0 && result.reason === 'completed'
    return { success, ...(!result ? { reason: 'AGH_RESULT_MISSING' } : success ? {} : { reason: result.reason }),
      ...(result?.text ? { agentOutput: String(result.text).slice(0, 12_000) } : {}),
      execution: printAghInternals.executionMetadata(status, env, result, startedAt, exitCode) }
  } catch (error) {
    const timeout = error?.code === 'ETIMEDOUT' || error?.killed === true
    const result = printAghInternals.parseCliResult(error?.stdout)
    const exitCode = result?.exitCode ?? (Number.isInteger(error?.status) ? error.status : null)
    return { success: false, reason: result?.reason && result.reason !== 'completed' ? result.reason : timeout ? 'AGH_RUN_TIMEOUT' : 'AGH_RUN_FAILED',
      ...(result?.text ? { agentOutput: String(result.text).slice(0, 12_000) } : {}),
      execution: printAghInternals.executionMetadata(status, env, result, startedAt, exitCode, {
        errorName: typeof error?.name === 'string' ? error.name : null,
        errorCode: typeof error?.code === 'string' && /^(?:ERR_[A-Z0-9_]+|E[A-Z0-9_]+)$/u.test(error.code) ? error.code : null,
        executable: basename(process.execPath), killed: error?.killed === true,
      }) }
  }
}

export const repairAghInternals = Object.freeze({ MAX_TIMEOUT_MS, MAX_TOOL_CALLS, PACKAGE_ID, PRESET, safePluginState, createRepairWorkspace, makePrompt, cleanRepairEnvironment })
