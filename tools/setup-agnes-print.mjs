import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { printAghInternals } from '../src/print-agh.mjs'

const PROFILE = 'local-dev'
const PROVIDER = 'agnes-ai'
const BASE_URL = 'https://api.agnes-ai.cn/v1'
const MODEL = 'agnes-3.0-flash'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(process.env.PHOTO_CAD_AGH_SOURCE || join(projectRoot, 'data', 'agh-source'))
const home = printAghInternals.dedicatedHome(process.env)

const apiKey = process.env.AGNES_API_KEY
if (typeof apiKey !== 'string' || apiKey.trim().length < 8) {
  console.error('AGNES_API_KEY is not configured; run with node --env-file=<photo-cad .env path> tools/setup-agnes-print.mjs.')
  process.exitCode = 2
} else {
  try {
    // Load AGH's pinned TypeScript source tree with its workspace-owned runtime loader.
    await import(pathToFileURL(join(sourceRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href)
    const configurationPath = pathToFileURL(join(sourceRoot, 'packages', 'host', 'src', 'configuration.ts')).href
    const { createConfigurationService } = await import(configurationPath)
    const config = createConfigurationService({ home, profile: PROFILE })

    const provider = (await config.providers()).providers.find((item) => item.id === PROVIDER)
    if (!provider || provider.baseUrl !== BASE_URL) throw new Error('CONFIG_AGNES_PROVIDER_UNAVAILABLE')

    const before = await config.get()
    const verified = await config.test({ providerId: PROVIDER, baseUrl: BASE_URL, apiKey })
    if (!verified.verified || !verified.models.some((item) => item.id === MODEL))
      throw new Error('CONFIG_AGNES_MODEL_UNAVAILABLE')

    const saved = await config.save({
      providerId: PROVIDER,
      baseUrl: BASE_URL,
      apiKey,
      model: MODEL,
      expectedRevision: before.revision,
      makeDefault: true,
    })

    const selected = saved.accounts.find((account) => account.accountId === saved.defaultAccountId && account.enabled)
    if (
      !saved.configured ||
      selected?.providerId !== PROVIDER ||
      selected.route !== PROVIDER ||
      selected.baseUrl !== BASE_URL ||
      selected.model !== MODEL ||
      selected.credentialConfigured !== true
    )
      throw new Error('CONFIG_AGNES_SAVE_NOT_SELECTED')

    const previousCommandCodeIds = before.accounts
      .filter((account) => account.providerId === 'command-code')
      .map((account) => account.accountId)
    const savedCommandCodeIds = new Set(
      saved.accounts.filter((account) => account.providerId === 'command-code').map((account) => account.accountId),
    )
    const commandCodePreserved = previousCommandCodeIds.every((accountId) => savedCommandCodeIds.has(accountId))
    if (!commandCodePreserved) throw new Error('CONFIG_EXISTING_ACCOUNT_NOT_PRESERVED')

    console.log(JSON.stringify({
      configured: saved.configured,
      profile: PROFILE,
      provider: PROVIDER,
      route: selected.route,
      model: selected.model,
      baseUrl: selected.baseUrl,
      commandCodePreserved,
    }))
  } catch (error) {
    const code = typeof error?.message === 'string' && /^CONFIG_[A-Z_]+$/u.test(error.message)
      ? error.message
      : typeof error?.code === 'string' && /^CONFIG_[A-Z_]+$/u.test(error.code)
        ? error.code
        : 'CONFIG_AGNES_SETUP_FAILED'
    console.error(`Agnes Configuration Service setup failed (${code}); credential value was not printed.`)
    process.exitCode = 1
  }
}
