import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ACTIONS = new Set(['inspect', 'build', 'slice', 'verify', 'submit'])
const SERVICE = 'http://127.0.0.1:4337'
const MAX_RESULT_BYTES = 24 * 1024

function failure(reason) {
  return { success: false, reason }
}

function parseArgs(argv) {
  const [action, ...args] = argv
  if (!ACTIONS.has(action ?? '')) return { error: 'BRIDGE_ACTION_INVALID' }
  if (action === 'inspect') return args.length === 0 ? { action } : { error: 'BRIDGE_ARGUMENTS_INVALID' }
  if (action === 'build') {
    if (args.length < 1 || args.length > 3 || !['true', 'false'].includes(args[0]))
      return { error: 'BRIDGE_ARGUMENTS_INVALID' }
    const options = { enhance: args[0] === 'true' }
    if (args[1] !== undefined) {
      const n = Number(args[1])
      if (!Number.isFinite(n) || n < 0.2 || n > 3) return { error: 'BRIDGE_RELIEF_INVALID' }
      options.reliefHeight = n
    }
    if (args[2] !== undefined) {
      const n = Number(args[2])
      if (!Number.isFinite(n) || n < 0.4 || n > 3) return { error: 'BRIDGE_FEATURE_WIDTH_INVALID' }
      options.minFeatureWidth = n
    }
    return { action, options }
  }
  const [candidateId] = args
  if (args.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/u.test(candidateId ?? ''))
    return { error: 'BRIDGE_CANDIDATE_INVALID' }
  return { action, candidateId }
}

export function compactResult(action, result, status = { ok: true, status: 200 }) {
  const out = {
    success: result?.success === true,
    action,
    ...(typeof result?.jobId === 'string' ? { jobId: result.jobId } : {}),
    ...(typeof result?.candidateId === 'string' ? { candidateId: result.candidateId } : {}),
    ...(typeof result?.reason === 'string' ? { reason: result.reason.slice(0, 500) } : {}),
    ...(Array.isArray(result?.nextActions) ? { nextActions: result.nextActions.slice(0, 8) } : {}),
  }
  if (action === 'inspect') {
    Object.assign(out, {
      inspection: result.inspection,
      constraints: result.constraints,
      dimensions: result.dimensions,
      profileId: result.profileId,
      baselineCandidateId: result.baselineCandidateId,
    })
  } else {
    if (result?.metrics) out.metrics = result.metrics
    if (result?.checks) out.checks = result.checks
    if (result?.options) out.options = result.options
    if (result?.execution) out.execution = result.execution
    if (result?.profile) out.profile = result.profile
    if (result?.verification) out.verification = result.verification
    if (result?.warnings) out.warnings = result.warnings
    if (result?.detail) out.detail = result.detail
    if (typeof result?.hasRaisedDetail === 'boolean') out.hasRaisedDetail = result.hasRaisedDetail
    if (Number.isFinite(result?.featureLayerCount)) out.featureLayerCount = result.featureLayerCount
    if (Number.isFinite(result?.featureExtrusionLengthMm)) out.featureExtrusionLengthMm = result.featureExtrusionLengthMm
    if (Number.isFinite(result?.highestExtrusionZ)) out.highestExtrusionZ = result.highestExtrusionZ
    if (Number.isFinite(result?.fidelity)) out.fidelity = result.fidelity
    if (result?.criteria && typeof result.criteria === 'object') out.criteria = result.criteria
    if (Array.isArray(result?.coverage)) out.coverage = result.coverage
    if (typeof result?.message === 'string') out.message = result.message.slice(0, 400)
  }
  if (!status.ok) out.httpStatus = status.status
  return out
}

async function main() {
  const call = parseArgs(process.argv.slice(2))
  if (call.error) return failure(call.error)
  const jobId = process.env.PRINT_TASK_JOB_ID
  const access = process.env.PRINT_TASK_JOB_ACCESS
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(jobId ?? '') || typeof access !== 'string' || access.length < 16 || access.length > 512 || /\s/u.test(access))
    return failure('BRIDGE_TASK_CREDENTIAL_MISSING')
  const body = {
    jobId,
    ...(call.candidateId ? { candidateId: call.candidateId } : {}),
    ...(call.options ? { options: call.options } : {}),
  }
  let response
  try {
    response = await fetch(new URL(`/api/print/tool/${call.action}`, SERVICE), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-print-task-access': access,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    })
  } catch (error) {
    return failure(error?.name === 'TimeoutError' ? 'BRIDGE_REQUEST_TIMEOUT' : 'BRIDGE_REQUEST_FAILED')
  }
  let result
  try {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_RESULT_BYTES) return failure('BRIDGE_RESPONSE_TOO_LARGE')
    result = JSON.parse(bytes.toString('utf8'))
  } catch {
    return failure('BRIDGE_RESPONSE_INVALID')
  }
  return compactResult(call.action, result, { ok: response.ok, status: response.status })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main().catch(() => failure('BRIDGE_INTERNAL_ERROR'))
  writeFileSync(1, `${JSON.stringify(result)}\n`)
}
