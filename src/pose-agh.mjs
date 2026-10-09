import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { getPrintAghStatus, printAghInternals } from './print-agh.mjs'

const PROFILE = 'local-dev'
const MAX_TIMEOUT_MS = 600_000
const MAX_TOOL_CALLS = 12
const MAX_OUTPUT_BYTES = 128 * 1024
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function safePluginState(value) {
  try {
    const lock = JSON.parse(value)
    const item = lock?.profile === PROFILE ? lock.packages?.['@photo-cad/pose-tools'] : null
    return { pluginInstalled: Boolean(item), pluginTrusted: Boolean(item?.state?.trusted), pluginEnabled: item?.state?.enabled === true }
  } catch { return { pluginInstalled: false, pluginTrusted: false, pluginEnabled: false } }
}

export async function getPoseAghStatus(options = {}) {
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
    aghAvailable: cliAvailable, configured: modelConfigured, modelConfigured, profile: PROFILE,
    provider: modelConfigured ? base.provider : null, route: modelConfigured ? base.route : null, model: modelConfigured ? base.model : null,
    ...plugin, ready: Boolean(modelConfigured && plugin.pluginInstalled && plugin.pluginTrusted && plugin.pluginEnabled),
    ...(!modelConfigured ? { reason: !cliAvailable ? 'AGH_CLI_NOT_FOUND' : 'POSE_MODEL_NOT_CONFIGURED' } : {}),
  }
}

function validId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new TypeError('jobId must be a generated pose job identifier')
  return value
}
function validAccess(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512 || /\s/u.test(value)) throw new TypeError('accessToken must be a task-scoped service credential')
  return value
}
async function ensureDirectory(path) {
  try { await mkdir(path) } catch (error) { if (error?.code !== 'EEXIST') throw error }
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('POSE_WORKSPACE_INVALID')
}
async function createPoseWorkspace(jobId, root = PROJECT_ROOT) {
  validId(jobId)
  const projectRoot = resolve(root)
  const parent = join(projectRoot, 'data', 'pose-jobs', 'agh-workspaces')
  const workspace = join(parent, jobId)
  const rel = relative(projectRoot, workspace)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('POSE_WORKSPACE_INVALID')
  const rootStat = await lstat(projectRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('POSE_WORKSPACE_INVALID')
  for (const path of [join(projectRoot, 'data'), join(projectRoot, 'data', 'pose-jobs'), parent]) await ensureDirectory(path)
  try { await mkdir(workspace) } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('POSE_WORKSPACE_ALREADY_EXISTS')
    throw error
  }
  const stat = await lstat(workspace)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('POSE_WORKSPACE_INVALID')
  if ((await readdir(workspace)).length !== 0) throw new Error('POSE_WORKSPACE_NOT_EMPTY')
  return workspace
}

function makePrompt(task, jobId) {
  const safeTask = (typeof task === 'string' ? task : JSON.stringify(task ?? {})).slice(0, 6000)
  return [
    'You are the AGH pose-selection agent. Use only pose_inspect, pose_evaluate, pose_select, pose_verify, and pose_submit. No shell, HTTP, other plugins, scripts, or arbitrary commands.',
    `This session is bound to job ${jobId}. Use at most ${MAX_TOOL_CALLS} tool calls.`,
    'Call inspect first. Then evaluate every poseId in the authoritative poses list returned by inspect exactly once, continuing after an individual failed evaluation. Do not assume a fixed count or invent additional angles. Use only actual returned evidence. Read the service decision recommendation and rejection reasons. Select only a candidate that passes every hard constraint; prefer the service recommendation for lowest material, with time as the tie-break. If no candidate is feasible, do not submit.',
    'After selection call verify, and submit only if verification succeeds. Never fabricate values or claim a failed tool succeeded. The original model shape, dimensions, and shared auto-support profile are immutable. The returned ROI envelope length is an approximation; do not claim actual contact, load capacity, or physical success.',
    'Call pose_select with only {"poseId":"the recommended ID"}; omit the optional rationale. If you supply rationale it must be at most 120 characters (the tool has a hard 400-character limit). After successful pose_submit, immediately give a short final answer with the returned measurements; make no further tool calls.',
    '', 'User task:', safeTask || 'Choose a feasible orientation with the lowest material estimate and report measured evidence.',
  ].join('\n')
}

function cleanPoseEnvironment(env, jobId, accessToken) {
  const result = printAghInternals.cleanEnvironment(env, jobId, 'http://127.0.0.1:4337', accessToken)
  result.PHOTO_CAD_AGH_HOME = printAghInternals.reconstructionHome(env)
  result.AGH_HOME = printAghInternals.reconstructionHome(env)
  return result
}

export async function runPoseTask(options = {}) {
  const jobId = validId(options.jobId)
  const accessToken = validAccess(options.accessToken)
  const serviceUrl = options.serviceUrl ?? 'http://127.0.0.1:4337/'
  let service
  try { service = new URL(serviceUrl) } catch { throw new TypeError('serviceUrl must be the local pose service at http://127.0.0.1:4337/') }
  if (service.protocol !== 'http:' || service.hostname !== '127.0.0.1' || service.port !== '4337' || service.pathname !== '/' || service.search || service.hash || service.username || service.password)
    throw new TypeError('serviceUrl must be the local pose service at http://127.0.0.1:4337/')
  const sourceEnv = options.env ?? process.env
  const env = { ...sourceEnv, PHOTO_CAD_AGH_HOME: printAghInternals.reconstructionHome(sourceEnv) }
  const status = await (options.status ?? getPoseAghStatus)({ env })
  if (!status.aghAvailable) throw new Error('AGH_CLI_NOT_FOUND: install the supported AGH build before running this task')
  if (!status.modelConfigured || typeof status.provider !== 'string' || !status.provider.trim()
    || typeof status.route !== 'string' || !status.route.trim()
    || typeof status.model !== 'string' || !status.model.trim())
    throw new Error('POSE_MODEL_NOT_CONFIGURED: configure a supported provider model in the isolated local-dev profile')
  if (!status.pluginInstalled || !status.pluginTrusted || !status.pluginEnabled) throw new Error('AGH_PLUGIN_NOT_READY: inspect, install, trust, and enable the reviewed pose plugin')
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.min(Math.max(options.timeoutMs, 1_000), MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS
  const sessionCwd = await createPoseWorkspace(jobId, options.workspaceRoot ?? PROJECT_ROOT)
  const args = [printAghInternals.cliPath(env), '-p', makePrompt(options.task, jobId), '--mode', 'json', '--standalone', '--profile', PROFILE, '--preset', 'pose-tools', '--model', `primary=${status.route}/${status.model}`, '--cwd', sessionCwd]
  const startedAt = new Date().toISOString()
  try {
    const child = await (options.spawn ?? printAghInternals.execFileWithClosedStdin)(process.execPath, args, {
      cwd: PROJECT_ROOT, env: cleanPoseEnvironment(env, jobId, accessToken), windowsHide: true,
      timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8',
    })
    const result = printAghInternals.parseCliResult(child?.stdout)
    const exitCode = result?.exitCode ?? (Number.isInteger(child?.code) ? child.code : 0)
    const success = result !== null && exitCode === 0 && result.reason === 'completed'
    return { success, ...(!result ? { reason: 'AGH_RESULT_MISSING' } : success ? {} : { reason: result.reason }), ...(result?.text ? { agentOutput: String(result.text).slice(0, 12_000) } : {}), execution: printAghInternals.executionMetadata(status, env, result, startedAt, exitCode) }
  } catch (error) {
    const timedOut = error?.code === 'ETIMEDOUT' || error?.killed === true
    const result = printAghInternals.parseCliResult(error?.stdout)
    const exitCode = result?.exitCode ?? (Number.isInteger(error?.status) ? error.status : null)
    return { success: false, reason: result?.reason && result.reason !== 'completed' ? result.reason : timedOut ? 'AGH_RUN_TIMEOUT' : 'AGH_RUN_FAILED', ...(result?.text ? { agentOutput: String(result.text).slice(0, 12_000) } : {}), execution: printAghInternals.executionMetadata(status, env, result, startedAt, exitCode, { errorName: typeof error?.name === 'string' ? error.name : null, errorCode: typeof error?.code === 'string' && /^(?:ERR_[A-Z0-9_]+|E[A-Z0-9_]+)$/u.test(error.code) ? error.code : null, executable: basename(process.execPath), killed: error?.killed === true }) }
  }
}

export const poseAghInternals = Object.freeze({ MAX_TIMEOUT_MS, MAX_TOOL_CALLS, safePluginState, createPoseWorkspace, makePrompt, cleanPoseEnvironment })
