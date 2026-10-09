import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { getPrintAghStatus, printAghInternals } from './print-agh.mjs'

const PROFILE = 'local-dev'
const PACKAGE_ID = '@photo-cad/texture-tools'
const PRESET = 'texture-tools'
const MAX_TIMEOUT_MS = 1_200_000
const TOOL_TIMEOUT_MS = 750_000
const MAX_OUTPUT_BYTES = 128 * 1024
const MAX_TOOL_CALLS = 8
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVICE_URL = 'http://127.0.0.1:4337'

function safePluginState(value) {
  try {
    const lock = JSON.parse(value)
    const item = lock?.profile === PROFILE ? lock.packages?.[PACKAGE_ID] : null
    return { pluginInstalled: Boolean(item), pluginTrusted: Boolean(item?.state?.trusted), pluginEnabled: item?.state?.enabled === true }
  } catch { return { pluginInstalled: false, pluginTrusted: false, pluginEnabled: false } }
}

export async function getTextureAghStatus(options = {}) {
  const sourceEnv = options.env ?? process.env
  const env = { ...sourceEnv, PHOTO_CAD_AGH_HOME: printAghInternals.reconstructionHome(sourceEnv), PHOTO_CAD_AGH_CLI: join(PROJECT_ROOT,'data','texture-agh-runtime','agnes.mjs') }
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
    ...(!modelConfigured ? { reason: !cliAvailable ? 'AGH_CLI_NOT_FOUND' : 'TEXTURE_MODEL_NOT_CONFIGURED' } : {}),
  }
}

function validJobId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new TypeError('jobId must be a generated texture job identifier')
  return value
}
function validAccessToken(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512 || /\s/u.test(value)) throw new TypeError('accessToken must be a task-scoped service credential')
  return value
}
function validateServiceUrl(value) {
  let service
  try { service = new URL(value) } catch { throw new TypeError('serviceUrl must be the local texture service at http://127.0.0.1:4337') }
  if (service.protocol !== 'http:' || service.hostname !== '127.0.0.1' || service.port !== '4337'
    || service.pathname !== '/' || service.search || service.hash || service.username || service.password)
    throw new TypeError('serviceUrl must be the local texture service at http://127.0.0.1:4337')
  return service.origin
}

async function ensureDirectory(path) {
  try { await mkdir(path) } catch (error) { if (error?.code !== 'EEXIST') throw error }
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('TEXTURE_WORKSPACE_INVALID')
}

async function createTextureWorkspace(jobId, root = PROJECT_ROOT) {
  validJobId(jobId)
  const projectRoot = resolve(root)
  const parent = join(projectRoot, 'data', 'texture', 'agh-workspaces')
  const workspace = join(parent, jobId)
  const rel = relative(projectRoot, workspace)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('TEXTURE_WORKSPACE_INVALID')
  const rootStat = await lstat(projectRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('TEXTURE_WORKSPACE_INVALID')
  for (const path of [join(projectRoot, 'data'), join(projectRoot, 'data', 'texture'), parent]) await ensureDirectory(path)
  let created = false
  try { await mkdir(workspace); created = true } catch (error) { if (error?.code !== 'EEXIST') throw error }
  const stat = await lstat(workspace)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('TEXTURE_WORKSPACE_INVALID')
  if (!created) throw new Error('TEXTURE_WORKSPACE_ALREADY_EXISTS')
  if ((await readdir(workspace)).length !== 0) throw new Error('TEXTURE_WORKSPACE_NOT_EMPTY')
  return workspace
}

function makePrompt(task, jobId) {
  const safeTask = (typeof task === 'string' ? task : JSON.stringify(task ?? {})).slice(0, 6000)
  return [
    'You are the AGH local texture agent. Use only texture_inspect, texture_generate, texture_verify, and texture_submit. Do not use shell, direct HTTP, other plugins, scripts, or arbitrary commands.',
    `This session is bound to texture job ${jobId}. Use at most ${MAX_TOOL_CALLS} native tool calls. The service owns the immutable parent candidate, reference image, and attempt IDs.`,
    'Call texture_inspect first. Then call texture_generate with profile standard exactly once. Use profile compact at most once and only if the standard attempt returns the actual error code TEXTURE_RESOURCE_FAILURE. Never retry for other errors, invent resource failures, enter paths, or alter source/reference IDs.',
    'Call texture_verify only for an attempt returned as successful by texture_generate. Submit only that exact attempt after successful texture_verify. Stop if a required stage fails or the tool budget is exhausted. A verified submission must report the service returned completion state.',
    'At completion, report the tool actions, profile(s), attempt IDs, returned verification evidence, and submission state. Do not claim visual quality or printability beyond returned evidence.',
    '', 'User task:', safeTask || 'Generate, verify, and submit a texture for the immutable flat-illustration reference and committed reconstruction candidate.',
  ].join('\n')
}

function cleanTextureEnvironment(env, jobId, accessToken) {
  const clean = { ...env }
  for (const name of Object.keys(clean)) {
    if (/(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD)/iu.test(name) || /^PRINT_TASK_/iu.test(name)
      || ['PHOTO_CAD_TASK_ID', 'PHOTO_CAD_SERVICE_URL'].includes(name)) delete clean[name]
  }
  const home = printAghInternals.reconstructionHome(env)
  clean.PHOTO_CAD_AGH_HOME = home
  clean.AGH_HOME = home
  clean.AGNES_PROFILE = PROFILE
  clean.PHOTO_CAD_TASK_ID = jobId
  clean.PHOTO_CAD_SERVICE_URL = SERVICE_URL
  clean.PHOTO_CAD_ACCESS_TOKEN = accessToken
  if (process.platform === 'win32') {
    const pathKey = Object.keys(clean).find(key => key.toLowerCase() === 'path') ?? 'PATH'
    const windowsRoot = env.SystemRoot || env.windir || 'C:\\Windows'
    const requiredPaths = [join(windowsRoot, 'System32'), join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0'), join(windowsRoot, 'System32', 'Wbem')]
    clean[pathKey] = [...new Set([...requiredPaths, ...(clean[pathKey] ?? '').split(';').filter(Boolean)])].join(';')
  }
  return clean
}

export async function runTextureTask(options = {}) {
  const jobId = validJobId(options.jobId)
  const accessToken = validAccessToken(options.accessToken)
  const serviceUrl = validateServiceUrl(options.serviceUrl ?? SERVICE_URL)
  const sourceEnv = options.env ?? process.env
  const env = { ...sourceEnv, PHOTO_CAD_AGH_HOME: printAghInternals.reconstructionHome(sourceEnv), PHOTO_CAD_AGH_CLI: join(PROJECT_ROOT,'data','texture-agh-runtime','agnes.mjs') }
  const status = await (options.status ?? getTextureAghStatus)({ env })
  if (!status.aghAvailable) throw new Error('AGH_CLI_NOT_FOUND: install the supported AGH build before running this task')
  if (!status.modelConfigured || typeof status.provider !== 'string' || !status.provider.trim()
    || typeof status.route !== 'string' || !status.route.trim() || typeof status.model !== 'string' || !status.model.trim())
    throw new Error('TEXTURE_MODEL_NOT_CONFIGURED: configure a provider model in the isolated local-dev profile')
  if (!status.pluginInstalled || !status.pluginTrusted || !status.pluginEnabled)
    throw new Error('AGH_PLUGIN_NOT_READY: inspect, install, trust, and enable the reviewed texture plugin')
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.min(Math.max(options.timeoutMs, 1_000), MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS
  const cwd = await createTextureWorkspace(jobId, options.workspaceRoot ?? PROJECT_ROOT)
  const args = [printAghInternals.cliPath(env), '-p', makePrompt(options.task, jobId), '--mode', 'json', '--standalone', '--profile', PROFILE,
    '--preset', PRESET, '--model', `primary=${status.route}/${status.model}`, '--cwd', cwd]
  const startedAt = new Date().toISOString()
  const invoke = options.spawn ?? printAghInternals.execFileWithClosedStdin
  try {
    const child = await invoke(process.execPath, args, {
      cwd: PROJECT_ROOT, env: cleanTextureEnvironment(env, jobId, accessToken), windowsHide: true,
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

export const textureAghInternals = Object.freeze({ MAX_TIMEOUT_MS, TOOL_TIMEOUT_MS, MAX_TOOL_CALLS, PACKAGE_ID, PRESET, SERVICE_URL,
  safePluginState, createTextureWorkspace, makePrompt, cleanTextureEnvironment, validateServiceUrl })
