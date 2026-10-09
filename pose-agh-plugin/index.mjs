const Kind = Symbol.for('TypeBox.Kind')
const POSES = Object.freeze(['upright', 'tilt-x-plus', 'tilt-x-minus', 'tilt-y-plus', 'face-up'])
const object = (properties = {}, required = []) => ({ [Kind]: 'Object', type: 'object', properties, required, additionalProperties: false })
const poseId = { [Kind]: 'String', type: 'string', enum: [...POSES] }
const empty = object()
const poseArgs = object({ poseId }, ['poseId'])
const selectArgs = object({ poseId, rationale: { [Kind]: 'String', type: 'string', maxLength: 400 } }, ['poseId'])

let boundJob = null
let calls = 0
let inspected = false
const attemptedEvaluations = new Set()
const successfulEvaluations = new Set()
let selected = null
let verified = false
const MAX_CALLS = 12
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_HTTP_TIMEOUT_MS = 120_000
const DEADLINE_MARGIN_MS = 1_000

function timeoutMs(context) {
  const native = Number.isSafeInteger(context?.timeoutMs) && context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_TIMEOUT_MS
  return Math.max(1, Math.min(MAX_HTTP_TIMEOUT_MS, native - DEADLINE_MARGIN_MS))
}

function requestSignal(context) {
  const deadline = AbortSignal.timeout(timeoutMs(context))
  return context?.signal instanceof AbortSignal ? AbortSignal.any([context.signal, deadline]) : deadline
}

async function invoke(path, args, context) {
  const jobId = process.env.PRINT_TASK_JOB_ID
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(jobId ?? '')) throw new Error('PRINT_TASK_JOB_ID is missing or invalid')
  const access = process.env.PRINT_TASK_JOB_ACCESS
  if (typeof access !== 'string' || access.length < 16 || access.length > 512 || /\s/u.test(access)) throw new Error('PRINT_TASK_JOB_ACCESS is missing or invalid')
  if (boundJob !== null && boundJob !== jobId) throw new Error('this pose AGH session is bound to a different job')
  boundJob = jobId
  if (calls >= MAX_CALLS) throw new Error('pose tool-call budget exhausted')
  if (path !== 'inspect' && !inspected) throw new Error('pose_inspect must be called first')
  if (path === 'evaluate') {
    if (attemptedEvaluations.has(args.poseId)) throw new Error('this pose has already been evaluated in this session')
    attemptedEvaluations.add(args.poseId)
  }
  if (path === 'select' && !successfulEvaluations.has(args.poseId)) throw new Error('pose_select requires a successful evaluation of the selected pose')
  if ((path === 'verify' || path === 'submit') && !selected) throw new Error(`${path === 'verify' ? 'pose_verify' : 'pose_submit'} requires a successful pose_select`)
  if (path === 'submit' && !verified) throw new Error('pose_submit requires successful pose_verify')
  calls += 1
  const response = await fetch(`http://127.0.0.1:4337/api/poses/tool/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Print-Task-Access': access },
    body: JSON.stringify({ ...args, jobId }),
    signal: requestSignal(context),
  })
  let result
  try { result = await response.json() } catch { throw new Error(`pose service returned invalid JSON (${response.status})`) }
  if (!response.ok || result?.success !== true) {
    const code = typeof result?.code === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(result.code) ? result.code : undefined
    const reason = typeof result?.reason === 'string' ? result.reason.slice(0, 600) : code ?? `HTTP ${response.status}`
    return { content: [{ type: 'text', text: JSON.stringify({ ...result, success: false, ...(code ? { code } : {}), reason }) }], structured: { ...result, success: false, ...(code ? { code } : {}), reason } }
  }
  if (path === 'inspect') inspected = true
  else if (path === 'evaluate') successfulEvaluations.add(args.poseId)
  else if (path === 'select') {
    if (result.selectedPoseId !== args.poseId) throw new Error('pose_select service response selectedPoseId did not match the requested pose')
    selected = args.poseId
  } else if (path === 'verify') verified = true
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structured: result }
}

const descriptions = {
  pose_inspect: 'Inspect the immutable source shape, dimensions, shared auto-support profile, constraints, and available pose candidates. Call first.',
  pose_evaluate: 'Evaluate one pose from the authoritative task list returned by inspect using service evidence. Each pose can be evaluated once; continue after an individual failure.',
  pose_select: 'Select an evaluated feasible pose using the service decision and rationale. The service enforces completion of every declared evaluation and hard constraints.',
  pose_verify: 'Verify the selected pose against the authoritative job constraints and reported measurements.',
  pose_submit: 'Submit the selected pose only after successful verification.',
}
function makeTool(name, path, parameters) {
  return {
    name, path, parameters, inject: ['extension'],
    apply(ctx) {
      ctx.extension().registerTool({
        name, description: descriptions[name], parameters,
        meta: { isReadOnly: path === 'inspect', isDestructive: false, isConcurrencySafe: false, isOpenWorld: false,
          replay: path === 'inspect' ? 'safe' : 'never', costHint: undefined, deferLoading: false, requiresApproval: 'never' },
        async execute(args, context) { return invoke(path, args, context) },
      })
    },
  }
}

export const poseInspectTool = makeTool('pose_inspect', 'inspect', empty)
export const poseEvaluateTool = makeTool('pose_evaluate', 'evaluate', poseArgs)
export const poseSelectTool = makeTool('pose_select', 'select', selectArgs)
export const poseVerifyTool = makeTool('pose_verify', 'verify', empty)
export const poseSubmitTool = makeTool('pose_submit', 'submit', empty)
export const poseTools = Object.freeze([poseInspectTool, poseEvaluateTool, poseSelectTool, poseVerifyTool, poseSubmitTool])
export const presets = Object.freeze({ 'pose-tools': Object.freeze({ name: 'pose-tools', extends: 'standard' }) })
export const poseAghInternals = Object.freeze({ requestTimeoutMs: timeoutMs, MAX_CALLS, POSES })
