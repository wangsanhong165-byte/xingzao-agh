const Kind = Symbol.for('TypeBox.Kind')
const CANDIDATES = Object.freeze(['original', 'r01', 'r02', 'r03'])
const object = (properties = {}, required = []) => ({ [Kind]: 'Object', type: 'object', properties, required, additionalProperties: false })
const candidateId = { [Kind]: 'String', type: 'string', enum: [...CANDIDATES] }
const empty = object()
const evaluateArgs = object({ candidateId }, ['candidateId'])
const applyArgs = object({ radiusMm: { [Kind]: 'Number', type: 'number', minimum: 0.01, maximum: 5 } }, ['radiusMm'])
const verifyArgs = evaluateArgs

let boundJob = null
let calls = 0
let inspected = false
let options = []
let applied = 0
let hasFailedEvaluation = false
const evaluated = new Map()
const issued = new Set()
let verifiedCandidate = null
let submitted = false
let submitAttempted = false
const MAX_CALLS = 12
const SERVICE_TIMEOUT_MS = 90_000
const DEFAULT_NATIVE_TIMEOUT_MS = 120_000
const DEADLINE_MARGIN_MS = 1_000

function requestTimeoutMs(context) {
  const native = Number.isSafeInteger(context?.timeoutMs) && context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_NATIVE_TIMEOUT_MS
  return Math.max(1, Math.min(SERVICE_TIMEOUT_MS, native - DEADLINE_MARGIN_MS))
}
function requestSignal(context) {
  const deadline = AbortSignal.timeout(requestTimeoutMs(context))
  return context?.signal instanceof AbortSignal ? AbortSignal.any([context.signal, deadline]) : deadline
}
function validJobCredentials() {
  const jobId = process.env.PRINT_TASK_JOB_ID
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(jobId ?? '')) throw new Error('PRINT_TASK_JOB_ID is missing or invalid')
  const access = process.env.PRINT_TASK_JOB_ACCESS
  if (typeof access !== 'string' || access.length < 16 || access.length > 512 || /\s/u.test(access)) throw new Error('PRINT_TASK_JOB_ACCESS is missing or invalid')
  if (boundJob !== null && boundJob !== jobId) throw new Error('this repair AGH session is bound to a different job')
  boundJob = jobId
  return { jobId, access }
}

async function invoke(operation, args, context) {
  const { jobId, access } = validJobCredentials()
  if (calls >= MAX_CALLS) throw new Error('repair tool-call budget exhausted')
  if (operation !== 'inspect' && !inspected) throw new Error('repair_inspect must be called first')
  if (submitted || submitAttempted) throw new Error('repair session has already attempted submission')
  if (operation === 'evaluate') {
    if (!CANDIDATES.includes(args.candidateId)) throw new Error('candidateId must be original or r01-r03')
    if (args.candidateId !== 'original' && !issued.has(args.candidateId)) throw new Error('repair candidate must be issued by repair_apply')
    if (evaluated.has(args.candidateId)) throw new Error('candidate has already been evaluated in this session')
  } else if (operation === 'apply') {
    if (!Number.isFinite(args.radiusMm) || args.radiusMm < 0.01 || args.radiusMm > 5) throw new Error('radiusMm must be between 0.01 and 5')
    if (!options.includes(args.radiusMm)) throw new Error('radiusMm must be an allowed radius from repair_inspect')
    if (!hasFailedEvaluation) throw new Error('repair_apply requires a failed candidate evaluation')
    if (applied >= 3) throw new Error('maximum of three repair candidates reached')
  } else if (operation === 'verify') {
    if (!CANDIDATES.includes(args.candidateId) || evaluated.get(args.candidateId) !== true) throw new Error('repair_verify requires an evaluated feasible candidate')
  } else if (operation === 'submit' && !verifiedCandidate) {
    throw new Error('repair_submit requires successful repair_verify')
  }

  calls += 1
  if (operation === 'submit') submitAttempted = true
  const response = await fetch(`http://127.0.0.1:4337/api/repair/tool/${operation}`, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Print-Task-Access': access },
    body: JSON.stringify({ ...args, jobId }), signal: requestSignal(context),
  })
  let result
  try { result = await response.json() } catch { throw new Error(`repair service returned invalid JSON (${response.status})`) }
  if (!response.ok || result?.success !== true) {
    const code = typeof result?.code === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(result.code) ? result.code : undefined
    const reason = typeof result?.reason === 'string' ? result.reason.slice(0, 600) : code ?? `HTTP ${response.status}`
    return { content: [{ type: 'text', text: JSON.stringify({ ...result, success: false, ...(code ? { code } : {}), reason }) }], structured: { ...result, success: false, ...(code ? { code } : {}), reason } }
  }

  if (operation === 'inspect') {
    if (!Array.isArray(result.repairOptionsMm) || result.repairOptionsMm.length > 3 || result.repairOptionsMm.some(v => !Number.isFinite(v) || v < 0.01 || v > 5) || new Set(result.repairOptionsMm).size !== result.repairOptionsMm.length)
      throw new Error('repair_inspect returned invalid repairOptionsMm')
    options = [...result.repairOptionsMm]
    inspected = true
  } else if (operation === 'evaluate') {
    if (result.candidateId !== args.candidateId || typeof result.feasible !== 'boolean') throw new Error('repair_evaluate returned an invalid candidateId or feasible result')
    evaluated.set(args.candidateId, result.feasible)
    if (!result.feasible) hasFailedEvaluation = true
  } else if (operation === 'apply') {
    const expectedId = `r${String(applied + 1).padStart(2, '0')}`
    if (result.candidateId !== expectedId) throw new Error(`repair_apply must return the next candidateId (${expectedId})`)
    applied += 1
    issued.add(result.candidateId)
    verifiedCandidate = null
  } else if (operation === 'verify') {
    if (result.candidateId !== args.candidateId) throw new Error('repair_verify returned a different candidateId')
    verifiedCandidate = args.candidateId
  } else if (operation === 'submit') {
    if (result.candidateId !== verifiedCandidate) throw new Error('repair_submit returned a different candidateId')
    submitted = true
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structured: result }
}

const descriptions = {
  repair_inspect: 'Inspect the source candidate, hard feature failures, and the service-provided finite repair radius options. Call first.',
  repair_evaluate: 'Evaluate the original candidate or a candidate returned by repair_apply against the required critical features.',
  repair_apply: 'Apply one bounded local repair using an exact radiusMm returned by repair_inspect after the latest candidate fails evaluation.',
  repair_verify: 'Recheck one evaluated feasible candidate against the source, critical features, and delivery requirements.',
  repair_submit: 'Submit the verified repair candidate for delivery.',
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

export const repairInspectTool = makeTool('repair_inspect', 'inspect', empty)
export const repairEvaluateTool = makeTool('repair_evaluate', 'evaluate', evaluateArgs)
export const repairApplyTool = makeTool('repair_apply', 'apply', applyArgs)
export const repairVerifyTool = makeTool('repair_verify', 'verify', verifyArgs)
export const repairSubmitTool = makeTool('repair_submit', 'submit', empty)
export const repairTools = Object.freeze([repairInspectTool, repairEvaluateTool, repairApplyTool, repairVerifyTool, repairSubmitTool])
export const presets = Object.freeze({ 'feature-repair-tools': Object.freeze({ name: 'feature-repair-tools', extends: 'standard' }) })
export const repairAghInternals = Object.freeze({ MAX_CALLS, SERVICE_TIMEOUT_MS, requestTimeoutMs, CANDIDATES })
