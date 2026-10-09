import { execFile as execFileCallback } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { readFile as readFileCallback, access as accessCallback } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const PROFILE = 'local-dev'
const PROVIDERS = new Map([
  ['agnes-ai', {
    baseUrl: 'https://api.agnes-ai.cn/v1',
    models: new Set(['agnes-3.0-flash']),
  }],
  ['command-code', {
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    models: new Set(['deepseek/deepseek-v4.1-flash']),
  }],
])
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CLI = join(PROJECT_ROOT, 'data', 'agh-runtime', 'agnes.mjs')
const MAX_TIMEOUT_MS = 240_000
const MAX_OUTPUT_BYTES = 128 * 1024

const userHome = (env) => env.USERPROFILE || env.HOME || homedir()
function dedicatedHome(env) {
  const anchor = resolve(userHome(env))
  const defaultHome = resolve(anchor, '.agh-print-detail')
  const v2Home = resolve(anchor, '.agh-print-detail-v2')
  const requested = env.PHOTO_CAD_AGH_HOME
  if (requested === undefined) return defaultHome
  if (typeof requested !== 'string' || !requested.trim() || !isAbsolute(requested))
    throw new TypeError('PHOTO_CAD_AGH_HOME must select one of the approved absolute private homes')
  const selected = resolve(requested)
  const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!equalPath(selected, defaultHome) && !equalPath(selected, v2Home))
    throw new TypeError('PHOTO_CAD_AGH_HOME must select only .agh-print-detail or .agh-print-detail-v2 under the user home')
  return selected
}
const reconstructionHome = (env) => resolve(userHome(env), '.agh-print-detail-v2')
const cliPath = (env) => env.PHOTO_CAD_AGH_CLI || DEFAULT_CLI
const configPath = (env) => join(dedicatedHome(env), 'profiles', PROFILE, 'configuration.json')
const packageLockPath = (env) => join(dedicatedHome(env), 'profiles', PROFILE, 'agnes-lock.json')
const defaultFileExists = async (path) => accessCallback(path).then(() => true, () => false)

function validCredentialRef(value, providerId) {
  const prefix = `secret://${providerId}/`
  if (typeof value !== 'string' || !value.startsWith(prefix)) return false
  const suffix = value.slice(prefix.length)
  return suffix.length > 0 && !/[\s\x00-\x1f\x7f]/u.test(suffix)
}

function execFileWithClosedStdin(file, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = execFileCallback(file, args, options, (error, stdout, stderr) => {
      if (error) {
        if (error.stdout === undefined) error.stdout = stdout
        if (error.stderr === undefined) error.stderr = stderr
        rejectRun(error)
      } else resolveRun({ stdout, stderr, code: 0 })
    })
    // AGH's non-TTY -p reader waits for stdin EOF even when prompt text is already positional.
    child.stdin?.end()
  })
}

function readConfiguredModel(value) {
  try {
    const state = JSON.parse(value)
    if (state?.profile !== PROFILE) return null
    let selected
    let providerId
    if (Array.isArray(state.accounts)) {
      selected = state.accounts.find((account) => account.accountId === state.defaultAccountId && account.enabled === true)
      providerId = selected?.id ?? selected?.providerId
    } else if (state.configured === true && state.provider?.credentialConfigured === true) {
      // Host ConfigurationService.get() exposes providerId/credentialConfigured instead of the
      // persisted secret reference. Keep this public snapshot projection aligned with the disk form.
      selected = state.provider
      providerId = selected.id ?? selected.providerId
    }
    if (!selected || typeof providerId !== 'string') return null
    const provider = PROVIDERS.get(providerId)
    if (!provider || selected.baseUrl?.replace(/\/$/u, '') !== provider.baseUrl) return null
    const route = selected.route
    if (route !== providerId && !/^account-[A-Za-z0-9_-]{1,128}$/u.test(route ?? '')) return null
    const hasCredential = Object.hasOwn(selected, 'credentialRef')
      ? validCredentialRef(selected.credentialRef, providerId)
      : selected.credentialConfigured === true
    if (!hasCredential) return null
    const model = typeof selected.model === 'string' ? selected.model : ''
    if (!provider.models.has(model)) return null
    return { provider: providerId, route, model, baseUrl: provider.baseUrl }
  } catch {
    return null
  }
}

function readPluginState(value) {
  try {
    const lock = JSON.parse(value)
    const item = lock?.profile === PROFILE ? lock.packages?.['@photo-cad/print-detail-tools'] : null
    return {
      pluginInstalled: Boolean(item),
      pluginTrusted: Boolean(item?.state?.trusted),
      pluginEnabled: item?.state?.enabled === true,
    }
  } catch {
    return { pluginInstalled: false, pluginTrusted: false, pluginEnabled: false }
  }
}

export async function getPrintAghStatus(options = {}) {
  const env = options.env ?? process.env
  const exists = options.fileExists ?? defaultFileExists
  const readFile = options.readFile ?? readFileCallback
  const [aghAvailable, configText, packageLock] = await Promise.all([
    exists(cliPath(env)),
    readFile(configPath(env), 'utf8').catch(() => null),
    readFile(packageLockPath(env), 'utf8').catch(() => null),
  ])
  const configured = configText === null ? null : readConfiguredModel(configText)
  const plugin = packageLock === null ? readPluginState('') : readPluginState(packageLock)
  const modelConfigured = Boolean(aghAvailable && configured)
  return {
    aghAvailable,
    modelConfigured,
    profile: PROFILE,
    provider: configured?.provider ?? null,
    route: configured?.route ?? null,
    model: configured?.model ?? null,
    baseUrl: configured?.baseUrl ?? null,
    ...plugin,
    ready: Boolean(aghAvailable && configured && plugin.pluginInstalled && plugin.pluginTrusted && plugin.pluginEnabled),
    limits: { maxRuntimeMs: MAX_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES, maxToolCalls: 12 },
    ...(modelConfigured ? {} : { reason: !aghAvailable ? 'AGH_CLI_NOT_FOUND' : 'ISOLATED_PROFILE_MODEL_NOT_CONFIGURED' }),
  }
}

function checkedJobId(jobId) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(jobId))
    throw new TypeError('jobId must be a generated print job identifier')
  return jobId
}

function checkedAccessToken(accessToken) {
  if (typeof accessToken !== 'string' || accessToken.length < 16 || accessToken.length > 512 || /\s/u.test(accessToken))
    throw new TypeError('accessToken must be a task-scoped service credential')
  return accessToken
}

function cleanEnvironment(env, jobId, serviceUrl, accessToken) {
  const childEnv = { ...env }
  for (const name of Object.keys(childEnv)) {
    if (/(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD)/iu.test(name)) delete childEnv[name]
  }
  childEnv.AGH_HOME = dedicatedHome(env)
  childEnv.PHOTO_CAD_AGH_HOME = dedicatedHome(env)
  childEnv.AGNES_PROFILE = PROFILE
  childEnv.PRINT_TASK_JOB_ID = jobId
  childEnv.PRINT_TASK_SERVICE_URL = serviceUrl
  childEnv.PRINT_TASK_JOB_ACCESS = accessToken
  if (process.platform === 'win32') {
    const pathKey = Object.keys(childEnv).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    const windowsRoot = env.SystemRoot || env.windir || 'C:\\Windows'
    const requiredPaths = [
      join(windowsRoot, 'System32'),
      join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      join(windowsRoot, 'System32', 'Wbem'),
    ]
    const current = childEnv[pathKey] ?? ''
    childEnv[pathKey] = [...new Set([...requiredPaths, ...current.split(';').filter(Boolean)])].join(';')
  }
  return childEnv
}

function makePrompt(task, jobId, maxToolCalls) {
  const taskData = typeof task === 'object' && task !== null ? task : {}
  const constraints = taskData.constraints ?? {}
  const maxRelief = Number.isFinite(constraints.maxReliefHeight) ? constraints.maxReliefHeight : 1.2
  const requestedRelief = Number.isFinite(constraints.reliefHeight) ? constraints.reliefHeight : 0.6
  const initialRelief = Math.min(0.2, maxRelief)
  const mm = (value) => String(Number(value.toFixed(3)))
  const safeTask = (typeof task === 'string' ? task : JSON.stringify(task ?? {})).trim().slice(0, 6000)
  return [
    'You are the AGH agent for a print-detail preservation job. Use the five native AGH plugin tools detail_inspect, detail_build, detail_slice, detail_verify, and detail_submit. Do not use shell, another plugin, MCP search, direct HTTP, another script, or an arbitrary command.',
    `This session is bound to job ${jobId}. Use at most ${maxToolCalls} native plugin tool calls. Every tool call is server-logged against this job. Stop rather than fabricate progress if input or constraints cannot be satisfied.`,
    `For valid input: (1) call detail_inspect; (2) call detail_build with {options:{enhance:false}} for the unraised baseline; (3) call detail_slice with the returned baseline candidateId; (4) call detail_verify to record the baseline control; (5) begin a low-material candidate with {options:{enhance:true,reliefHeight:${mm(initialRelief)}}}; (6) slice and verify that exact candidate. Read the real returned verificationPolicy and slicer profile.layerHeightMm. If the failure is insufficient layers, choose the next bounded height from those measurements rather than jumping to a preset height. A height change cannot fix XY coverage, closed holes, or unverified role/width; report those constraints or choose an appropriate permitted geometry change. The user's starting height is ${mm(requestedRelief)} mm and maximum allowed height is ${mm(maxRelief)} mm.`,
    'Compare actual slice metrics and select the lowest-material verified candidate among the tested candidates. Every tested candidate must be built, sliced and verified before comparison or submission. Keep all hard dimensions and protection bounds. This is limited candidate search, not a global optimum or a physical print guarantee.',
    'Build returns a server-generated candidateId; use it exactly for slice, verify, and submit. Never invent or reconstruct geometry, dimensions, masks, checks, slicing results, or candidate ids. Retry only with an evidence-based allowed modification and remaining call budget. If no feasible candidate is verified, do not submit.',
    'The job service owns image pixels, measurements, dimensions, ROI and fixed slicer profile. Treat inspect and later tool responses as authoritative. Do not modify hard dimensions or protected ROI. Only submit after closed-mesh, dimensions, protected-ROI fidelity, actual slicer and raised-path checks all pass.',
    'At completion, state the native tool actions actually called, selected candidateId, returned verification evidence, submission outcome, and any remaining limits. If no candidate can be submitted, say so plainly.',
    '',
    'User task:',
    safeTask || 'Preserve the confirmed protected image detail as raised geometry and validate it for the fixed print profile.',
  ].join('\n')
}

function parseCliResult(stdout) {
  for (const line of String(stdout ?? '').trim().split(/\r?\n/u).reverse()) {
    try {
      const result = JSON.parse(line)
      if (
        result?.v === 'agnes-cli-result/v1' &&
        typeof result.sessionId === 'string' &&
        typeof result.reason === 'string' &&
        Number.isSafeInteger(result.exitCode) &&
        Number.isSafeInteger(result.lastSeq)
      ) return result
    } catch {}
  }
  return null
}

function safeChildLaunchDiagnostic(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.slice(0, 64 * 1024) : ''
  const stderrCodes = [...new Set(stderr.match(/\b(?:ERR_[A-Z0-9_]+|E[A-Z0-9_]+)\b/gu) ?? [])].slice(0, 8)
  const stackFrames = []
  for (const line of stderr.split(/\r?\n/u)) {
    const match = line.match(/(?:file:\/\/\/)?(?:[A-Za-z]:[\\/]|\/)(?:[^/\\\s()]+[\\/])*([^/\\:\s()]+):(\d+):(\d+)\)?$/u)
    if (!match) continue
    const file = match[1]
    if (/^[A-Za-z0-9._-]{1,120}\.(?:mjs|cjs|js|mts|cts|ts|json)$/iu.test(file))
      stackFrames.push(`${file}:${match[2]}:${match[3]}`)
    if (stackFrames.length === 8) break
  }
  const rawSyscall = typeof error?.syscall === 'string' ? error.syscall : ''
  const syscall = rawSyscall.startsWith('spawn') ? 'spawn'
    : ['read', 'write', 'open', 'stat', 'connect', 'pipe', 'uv_cwd'].includes(rawSyscall) ? rawSyscall
      : null
  const rawCode = typeof error?.code === 'string' && /^(?:ERR_[A-Z0-9_]+|E[A-Z0-9_]+)$/u.test(error.code)
    ? error.code
    : null
  const signals = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGABRT'])
  return {
    errorName: typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : null,
    errorCode: rawCode,
    errno: Number.isSafeInteger(error?.errno) ? error.errno : null,
    syscall,
    executable: basename(process.execPath),
    status: Number.isSafeInteger(error?.status) ? error.status : null,
    signal: signals.has(error?.signal) ? error.signal : null,
    killed: error?.killed === true,
    stderrCodes,
    stackFrames,
  }
}

function executionMetadata(status, env, result, startedAt, exitCode, launchDiagnostic) {
  return {
    mode: 'agh',
    toolTransport: 'native-plugin',
    profile: PROFILE,
    provider: status.provider,
    route: status.route,
    model: status.model,
    modelBinding: 'explicit-session-model-before-prompt',
    ...(result?.sessionId ? { sessionId: result.sessionId } : {}),
    ...(Number.isSafeInteger(result?.lastSeq) ? { lastSeq: result.lastSeq } : {}),
    ...(result?.reason ? { turnReason: result.reason } : {}),
    recordDir: join(dedicatedHome(env), 'data'),
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode,
    ...(launchDiagnostic ? { launchDiagnostic } : {}),
  }
}

export async function runPrintTask(options) {
  const jobId = checkedJobId(options?.jobId)
  const accessToken = checkedAccessToken(options?.accessToken)
  const env = options.env ?? process.env
  const status = await (options.status ?? getPrintAghStatus)({ env })
  if (!status.aghAvailable) throw new Error('AGH_CLI_NOT_FOUND: install the supported AGH build before running the task')
  if (!status.modelConfigured) throw new Error(`${status.reason ?? 'AGH_MODEL_NOT_CONFIGURED'}: configure an approved Agnes AI or Command Code model in the isolated local-dev profile`)
  if (!status.pluginInstalled || !status.pluginTrusted || !status.pluginEnabled)
    throw new Error('AGH_PLUGIN_NOT_READY: inspect, install, trust, and enable the reviewed print-detail plugin')
  const serviceUrl = options.serviceUrl ?? 'http://127.0.0.1:4337'
  const endpoint = new URL(serviceUrl)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== '4337' || endpoint.pathname !== '/')
    throw new TypeError('serviceUrl must be the loopback print service at port 4337')
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.min(Math.max(options.timeoutMs, 1_000), MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS
  const cwd = resolve(options.cwd ?? process.cwd())
  const prompt = makePrompt(options.task, jobId, 12)
  const args = [
    cliPath(env), '-p', prompt, '--mode', 'json', '--standalone', '--profile', PROFILE,
    '--model', `primary=${status.route}/${status.model}`,
    '--cwd', cwd,
  ]
  const startedAt = new Date().toISOString()
  const invoke = options.spawn ?? execFileWithClosedStdin
  let result
  try {
    result = await invoke(process.execPath, args, {
      cwd,
      env: cleanEnvironment(env, jobId, endpoint.origin, accessToken),
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    })
  } catch (error) {
    const timeout = error?.code === 'ETIMEDOUT' || error?.killed === true
    const code = timeout ? 'AGH_RUN_TIMEOUT' : 'AGH_RUN_FAILED'
    const result = parseCliResult(error?.stdout)
    const exitCode = result?.exitCode ?? (Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.code) ? error.code : null)
    return {
      success: false,
      reason: result?.reason && result.reason !== 'completed' ? result.reason : code,
      ...(result?.text ? { agentOutput: String(result.text).slice(0, 12_000) } : {}),
      execution: executionMetadata(status, env, result, startedAt, exitCode, safeChildLaunchDiagnostic(error)),
    }
  }
  const cliResult = parseCliResult(result?.stdout)
  const agentOutput = String(cliResult?.text ?? '').slice(0, 12_000)
  const exitCode = cliResult?.exitCode ?? (Number.isInteger(result?.code) ? result.code : 0)
  const success = cliResult !== null && exitCode === 0 && cliResult.reason === 'completed'
  return {
    success,
    ...(!cliResult ? { reason: 'AGH_RESULT_MISSING' } : success ? {} : { reason: cliResult.reason }),
    ...(agentOutput ? { agentOutput } : {}),
    execution: executionMetadata(status, env, cliResult, startedAt, exitCode),
  }
}

export const printAghInternals = Object.freeze({
  dedicatedHome,
  reconstructionHome,
  cliPath,
  configPath,
  packageLockPath,
  execFileWithClosedStdin,
  cleanEnvironment,
  parseCliResult,
  executionMetadata,
  maxTimeoutMs: MAX_TIMEOUT_MS,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  readConfiguredModel,
  providerCatalogue: Object.fromEntries([...PROVIDERS].map(([id, value]) => [id, { baseUrl: value.baseUrl, models: [...value.models] }])),
})
