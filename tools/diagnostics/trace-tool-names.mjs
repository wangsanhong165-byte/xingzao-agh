import { appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

const traceFile = process.env.PHOTO_CAD_TOOL_TRACE_FILE
if (process.env.PHOTO_CAD_TRACE_TOOL_NAMES === '1' && traceFile) {
  const root = resolve(process.env.PHOTO_CAD_TRACE_ROOT || process.cwd())
  const target = resolve(traceFile)
  if (!target.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`))
    throw new Error('tool-name trace path must stay below its configured local root')
  mkdirSync(dirname(target), { recursive: true })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    try {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input)
      if (url === 'https://api.commandcode.ai/provider/v1/responses' || url === 'https://api.agnes-ai.cn/v1/chat/completions') {
        const body = input instanceof Request
          ? await input.clone().json()
          : typeof init?.body === 'string' ? JSON.parse(init.body) : null
        if (body?.model === 'deepseek/deepseek-v4.1-flash' || body?.model === 'agnes-3.0-flash') {
          const names = Array.isArray(body.tools)
            ? body.tools.map((tool) => tool?.name ?? tool?.function?.name).filter((name) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
            : []
          appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), model: body.model, toolNames: names })}\n`, 'utf8')
        }
      }
    } catch {}
    return originalFetch.call(globalThis, input, init)
  }
}
