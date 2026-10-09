const Kind = Symbol.for('TypeBox.Kind')
const ATTEMPTS = Object.freeze(['t01', 't02'])
const PROFILES = Object.freeze(['standard', 'compact'])
const object = (properties = {}, required = []) => ({ [Kind]: 'Object', type: 'object', properties, required, additionalProperties: false })
const attempt = { [Kind]: 'String', type: 'string', enum: [...ATTEMPTS] }
const profile = { [Kind]: 'String', type: 'string', enum: [...PROFILES] }
const empty = object()
const generateArgs = object({ profile }, ['profile'])
const attemptArgs = object({ attemptId: attempt }, ['attemptId'])

let boundJob = null
let calls = 0
let inspected = false
let standardResult = null
let compactUsed = false
const generated = new Map()
let verifiedAttempt = null
let verifiedAssetSha256 = null
let submitAttempted = false
const MAX_CALLS = 8
const SERVICE_TIMEOUT_MS = 90_000
const DEFAULT_NATIVE_TIMEOUT_MS = 120_000
const GENERATE_TIMEOUT_MS = 750_000
const DEADLINE_MARGIN_MS = 1_000
const SERVICE_URL = 'http://127.0.0.1:4337'

function requestTimeoutMs(operation, context) {
  const defaultTimeout = operation === 'generate' ? GENERATE_TIMEOUT_MS : DEFAULT_NATIVE_TIMEOUT_MS
  const hasNativeTimeout = Number.isSafeInteger(context?.timeoutMs) && context.timeoutMs > 0
  const native = hasNativeTimeout ? context.timeoutMs : defaultTimeout
  const budget = operation === 'generate' ? GENERATE_TIMEOUT_MS : SERVICE_TIMEOUT_MS
  return Math.max(1, Math.min(budget, native - (hasNativeTimeout ? DEADLINE_MARGIN_MS : 0)))
}
function requestSignal(operation, context) {
  const deadline = AbortSignal.timeout(requestTimeoutMs(operation, context))
  return context?.signal instanceof AbortSignal ? AbortSignal.any([context.signal, deadline]) : deadline
}
function taskCredentials() {
  const jobId = process.env.PHOTO_CAD_TASK_ID
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(jobId ?? '')) throw new Error('PHOTO_CAD_TASK_ID is missing or invalid')
  const access = process.env.PHOTO_CAD_ACCESS_TOKEN
  if (typeof access !== 'string' || access.length < 16 || access.length > 512 || /\s/u.test(access)) throw new Error('PHOTO_CAD_ACCESS_TOKEN is missing or invalid')
  if (boundJob !== null && boundJob !== jobId) throw new Error('this texture AGH session is bound to a different job')
  const configured = process.env.PHOTO_CAD_SERVICE_URL
  let service
  try { service = new URL(configured) } catch { throw new Error('PHOTO_CAD_SERVICE_URL must be http://127.0.0.1:4337') }
  if (service.protocol !== 'http:' || service.hostname !== '127.0.0.1' || service.port !== '4337'
    || service.pathname !== '/' || service.search || service.hash || service.username || service.password || service.origin !== SERVICE_URL)
    throw new Error('PHOTO_CAD_SERVICE_URL must be http://127.0.0.1:4337')
  boundJob = jobId
  return { jobId, access }
}

function toolError(result, response) {
  const code = typeof result?.code === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(result.code) ? result.code : undefined
  const reason = typeof result?.reason === 'string' ? result.reason.slice(0, 600) : code ?? `HTTP ${response.status}`
  const structured = { ...(result && typeof result === 'object' ? result : {}), success: false, ...(code ? { code } : {}), reason }
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structured }
}

async function invoke(operation, args, context) {
  const { jobId, access } = taskCredentials()
  if (calls >= MAX_CALLS) throw new Error('texture tool-call budget exhausted')
  if (operation !== 'inspect' && !inspected) throw new Error('texture_inspect must be called first')
  if (submitAttempted) throw new Error('texture session has already attempted submission')
  let attemptId
  let selectedProfile
  if (operation === 'inspect' && inspected) throw new Error('texture_inspect has already been called in this session')
  if (operation === 'generate') {
    if (!PROFILES.includes(args?.profile)) throw new Error('texture_generate profile must be standard or compact')
    if (args.profile === 'standard') {
      if (standardResult !== null) throw new Error('standard texture attempt has already been used')
      attemptId = 't01'
    } else {
      if (compactUsed) throw new Error('compact texture attempt has already been used')
      if (standardResult !== 'resource-failure') throw new Error('compact generation requires a real standard TEXTURE_RESOURCE_FAILURE')
      compactUsed = true
      attemptId = 't02'
    }
    selectedProfile = args.profile
  } else if (operation === 'verify' || operation === 'submit') {
    if (!ATTEMPTS.includes(args?.attemptId)) throw new Error('attemptId must be t01 or t02')
    attemptId = args.attemptId
    if (operation === 'verify' && generated.get(attemptId)?.success !== true) throw new Error('texture_verify requires a successful texture_generate attempt')
    if (operation === 'submit' && verifiedAttempt !== attemptId) throw new Error('texture_submit requires successful texture_verify for this attempt')
  }

  calls += 1
  if (operation === 'submit') submitAttempted = true
  const response = await fetch(`${SERVICE_URL}/api/texture/tool/${operation}`, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-print-task-access': access },
    body: JSON.stringify({ jobId, ...(attemptId ? { attemptId } : {}), ...(selectedProfile ? { profile: selectedProfile } : {}) }),
    signal: requestSignal(operation, context),
  })
  let result
  try { result = await response.json() } catch { throw new Error(`texture service returned invalid JSON (${response.status})`) }
  if (!response.ok || result?.success !== true) {
    if (operation === 'generate' && selectedProfile === 'standard') standardResult = result?.code === 'TEXTURE_RESOURCE_FAILURE' ? 'resource-failure' : 'failed'
    return toolError(result, response)
  }

  if (operation === 'inspect') inspected = true
  else if (operation === 'generate') {
    if (result.attemptId !== attemptId || result.profile !== selectedProfile) throw new Error('texture_generate returned a different attemptId or profile')
    standardResult = selectedProfile === 'standard' ? 'success' : standardResult
    generated.set(attemptId, { success: true, profile: selectedProfile })
  } else if (operation === 'verify') {
    if (result.attemptId !== attemptId || !/^[a-f0-9]{64}$/iu.test(result.assetSha256 ?? ''))
      throw new Error('texture_verify returned an invalid attemptId or assetSha256')
    verifiedAttempt = attemptId
    verifiedAssetSha256 = result.assetSha256.toLowerCase()
  } else if (operation === 'submit') {
    if (result.attemptId !== attemptId || !/^[a-f0-9]{64}$/iu.test(result.assetSha256 ?? '')
      || result.assetSha256.toLowerCase() !== verifiedAssetSha256 || result.submitted !== true || result.verified !== true)
      throw new Error('texture_submit did not confirm the verified attempt and asset SHA')
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structured: result }
}

const descriptions = {
  texture_inspect: 'Inspect the immutable reconstruction candidate and flat-illustration reference bound to this texture job. Call first.',
  texture_generate: 'Generate a texture using the fixed standard or eligible compact profile. Compact is allowed only after an actual standard TEXTURE_RESOURCE_FAILURE.',
  texture_verify: 'Independently verify a generated attempt against its source geometry, reference, UVs, embedded image, and SHA evidence.',
  texture_submit: 'Submit only the exact verified attempt. Confirm the returned attempt ID, asset SHA, submitted flag, and verified flag.',
}
function makeTool(name, operation, parameters) {
  return { name, operation, parameters, inject: ['extension'], apply(ctx) {
    ctx.extension().registerTool({ name, description: descriptions[name], parameters,
      meta: { isReadOnly: operation === 'inspect', isDestructive: false, isConcurrencySafe: false, isOpenWorld: false,
        replay: operation === 'inspect' ? 'safe' : 'never', costHint: undefined, deferLoading: false, requiresApproval: 'never' },
      async execute(args, context) { return invoke(operation, args, context) },
    })
  } }
}

export const textureInspectTool = makeTool('texture_inspect', 'inspect', empty)
export const textureGenerateTool = makeTool('texture_generate', 'generate', generateArgs)
export const textureVerifyTool = makeTool('texture_verify', 'verify', attemptArgs)
export const textureSubmitTool = makeTool('texture_submit', 'submit', attemptArgs)
export const textureTools = Object.freeze([textureInspectTool, textureGenerateTool, textureVerifyTool, textureSubmitTool])
export const presets = Object.freeze({ 'texture-tools': Object.freeze({
  name: 'texture-tools',
  extends: 'standard',
  tools: Object.freeze({ timeouts: Object.freeze({ texture_generate: GENERATE_TIMEOUT_MS }) }),
}) })
export const textureAghPluginInternals = Object.freeze({ MAX_CALLS, SERVICE_TIMEOUT_MS, GENERATE_TIMEOUT_MS, SERVICE_URL, requestTimeoutMs, ATTEMPTS, PROFILES })
