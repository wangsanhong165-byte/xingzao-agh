import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { printAghInternals } from '../src/print-agh.mjs'

const PROFILE = 'local-dev'
const PROVIDER = 'command-code'
const BASE_URL = 'https://api.commandcode.ai/provider/v1'
const MODEL_ID = 'deepseek/deepseek-v4.1-flash'
const apiKey = process.env.COMMAND_CODE_API_KEY
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(process.env.PHOTO_CAD_AGH_SOURCE || joinPath(projectRoot, 'data', 'agh-source'))
const home = printAghInternals.dedicatedHome(process.env)

if (typeof apiKey !== 'string' || apiKey.trim().length < 8) {
  console.error('Command Code credential is not configured in the process environment.')
  process.exitCode = 2
} else {
  try {
    const { createConfigurationService } = await import(
      pathToFileURL(resolve(sourceRoot, 'packages', 'host', 'src', 'configuration.ts')).href
    )
    const config = createConfigurationService({ home, profile: PROFILE })
    const verification = await config.test({ providerId: PROVIDER, baseUrl: BASE_URL, apiKey })
    if (!verification.verified || !verification.models.some((model) => model.id === MODEL_ID)) {
      console.error('The verified model catalogue does not contain the required Command Code model.')
      process.exitCode = 3
    } else {
      const snapshot = await config.get()
      const saved = await config.save({
        providerId: PROVIDER,
        baseUrl: BASE_URL,
        apiKey,
        model: MODEL_ID,
        expectedRevision: snapshot.revision,
      })
      console.log(JSON.stringify({
        configured: saved.configured,
        profile: PROFILE,
        provider: PROVIDER,
        route: saved.provider?.route ?? null,
        model: MODEL_ID,
        baseUrl: BASE_URL,
        revision: saved.revision,
      }))
    }
  } catch {
    console.error('AGH Config API setup failed; inspect status without printing credentials or raw config.')
    process.exitCode = 1
  }
}

function joinPath(...parts) {
  return resolve(...parts)
}
