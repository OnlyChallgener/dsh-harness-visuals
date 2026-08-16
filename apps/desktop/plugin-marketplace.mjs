import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { checkNodeRuntime, dshBinPath, harnessEnvironment } from './runtime.mjs'

const execFileAsync = promisify(execFile)
const PLUGIN_COMMAND_TIMEOUT_MS = 5 * 60 * 1000
const PLUGIN_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024
const PLUGIN_SPEC_MAX_LENGTH = 512
const MARKETPLACE_METADATA_TIMEOUT_MS = 4_000
const MARKETPLACE_METADATA_CONCURRENCY = 4
const MANAGED_PNPM_VERSION = '11.7.0'
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu
const REGISTRY_SPEC_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[a-z0-9][a-z0-9._-]*)?$/iu
const GITHUB_SPEC_PATTERN = /^github:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:#[a-z0-9][a-z0-9._\/-]*)?$/iu
const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

let mutationTail = Promise.resolve()

/** Validate one package spec before it reaches the official `dsh plugin` forwarder. */
export function pluginSpec(value) {
  if (typeof value !== 'string') throw new TypeError('Plugin spec must be a string.')
  const spec = value.trim()
  if (spec.length === 0 || spec.length > PLUGIN_SPEC_MAX_LENGTH) {
    throw new Error('Plugin spec is empty or too long.')
  }
  if (!REGISTRY_SPEC_PATTERN.test(spec) && !GITHUB_SPEC_PATTERN.test(spec)) {
    throw new Error('Plugin spec must be an npm package/version or github:owner/repo reference.')
  }
  return spec
}

/** Validate the installed package name accepted by remove/inspect operations. */
export function pluginPackageName(value) {
  if (typeof value !== 'string') throw new TypeError('Plugin package name must be a string.')
  const name = value.trim()
  if (name.length === 0 || name.length > PLUGIN_SPEC_MAX_LENGTH || !PACKAGE_NAME_PATTERN.test(name)) {
    throw new Error('Plugin package name is invalid.')
  }
  return name
}

/** Parse `pnpm list --depth 0 --json` into a bounded internal dependency record. */
export function parsePluginList(output) {
  const parsed = JSON.parse(output)
  const root = Array.isArray(parsed) ? parsed[0] : parsed
  if (root === null || typeof root !== 'object') return []
  const dependencies = root.dependencies
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return []
  return Object.entries(dependencies)
    .flatMap(([name, value]) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
      const record = value
      const version = typeof record.version === 'string' ? record.version : ''
      const path = typeof record.path === 'string' ? record.path : undefined
      const sourceSpec = typeof record.from === 'string'
        ? record.from
        : typeof record.resolved === 'string'
          ? record.resolved
          : undefined
      return [{
        name,
        version,
        ...(path === undefined ? {} : { path }),
        ...(sourceSpec === undefined ? {} : { sourceSpec }),
      }]
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Classify the dependency route without confusing a package's GitHub repository with its install source. */
export function pluginSourceKind(sourceSpec) {
  if (typeof sourceSpec !== 'string' || sourceSpec.length === 0) return 'npm'
  const source = sourceSpec.trim()
  if (/^https?:\/\/registry\.npmjs\.org\//iu.test(source)) return 'npm'
  if (/^(?:github:|git\+https?:\/\/github\.com\/|https?:\/\/github\.com\/)/iu.test(source)
    || /^(?!@)[a-z0-9_.-]+\/[a-z0-9_.-]+(?:#.*)?$/iu.test(source)) return 'github'
  if (/^(?:file:|link:|workspace:|https?:\/\/|git\+|git:|ssh:)/iu.test(source)
    || /^[a-z]:[\\/]/iu.test(source)
    || source.startsWith('/') || source.startsWith('.')) return 'unknown'
  return 'npm'
}

/** Compare ordinary semantic versions. Undefined means at least one side is not safely comparable. */
export function comparePluginVersions(left, right) {
  const parse = value => {
    if (typeof value !== 'string') return undefined
    const match = SEMVER_PATTERN.exec(value.trim())
    if (match === null) return undefined
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4]?.split('.'),
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (a === undefined || b === undefined) return undefined
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (a.pre === undefined && b.pre === undefined) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < length; index += 1) {
    const av = a.pre[index]
    const bv = b.pre[index]
    if (av === undefined) return -1
    if (bv === undefined) return 1
    if (av === bv) continue
    const an = /^\d+$/u.test(av) ? Number(av) : undefined
    const bn = /^\d+$/u.test(bv) ? Number(bv) : undefined
    if (an !== undefined && bn !== undefined) return an > bn ? 1 : -1
    if (an !== undefined) return -1
    if (bn !== undefined) return 1
    return av > bv ? 1 : -1
  }
  return 0
}

function httpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//iu.test(value) ? value : undefined
}

/** Normalize common npm repository shapes into an ordinary HTTPS URL. */
function repositoryUrl(value) {
  const raw = typeof value === 'string'
    ? value
    : value !== null && typeof value === 'object' && typeof value.url === 'string'
      ? value.url
      : undefined
  if (raw === undefined) return undefined
  const normalized = raw
    .replace(/^git\+https:/iu, 'https:')
    .replace(/^git:\/\/github\.com\//iu, 'https://github.com/')
    .replace(/^git@github\.com:/iu, 'https://github.com/')
    .replace(/\.git$/iu, '')
  return /^https?:\/\//iu.test(normalized) ? normalized : undefined
}

/** Read only public package metadata from the installed package root. */
async function readInstalledManifest(path) {
  if (typeof path !== 'string' || path.length === 0) return {}
  try {
    const parsed = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return {
      description: typeof parsed.description === 'string' ? parsed.description.slice(0, 800) : undefined,
      homepage: httpUrl(parsed.homepage),
      repository: repositoryUrl(parsed.repository),
      license: typeof parsed.license === 'string' ? parsed.license.slice(0, 80) : undefined,
    }
  } catch {
    return {}
  }
}

/** Fetch one small public metadata document with a strict timeout and no credentials. */
async function fetchMarketplaceJson(url, fetchImpl) {
  if (typeof fetchImpl !== 'function') return undefined
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MARKETPLACE_METADATA_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const value = await response.json()
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/** Query only the npm public package document needed for details and latest-version checks. */
async function npmLatestMetadata(name, fetchImpl) {
  const safeName = pluginPackageName(name)
  return fetchMarketplaceJson(`https://registry.npmjs.org/${encodeURIComponent(safeName)}/latest`, fetchImpl)
}

/** Merge installed metadata with bounded public registry evidence. */
async function enrichInstalledPlugin(plugin, fetchImpl) {
  const local = await readInstalledManifest(plugin.path)
  const source = pluginSourceKind(plugin.sourceSpec)
  let registry
  if (source === 'npm') registry = await npmLatestMetadata(plugin.name, fetchImpl)

  const latestVersion = typeof registry?.version === 'string' ? registry.version : undefined
  const comparison = latestVersion === undefined ? undefined : comparePluginVersions(latestVersion, plugin.version)
  const updateAvailable = comparison !== undefined && comparison > 0
  const updateStatus = source !== 'npm'
    ? 'unsupported'
    : registry === undefined
      ? 'unavailable'
      : comparison === undefined
        ? latestVersion === plugin.version ? 'current' : 'unsupported'
        : updateAvailable ? 'available' : 'current'
  const repository = local.repository ?? repositoryUrl(registry?.repository)
  const homepage = local.homepage ?? httpUrl(registry?.homepage)
  const provenance = plugin.name.startsWith('@deepseek-ai/')
    ? 'deepseek-scope'
    : registry !== undefined
      ? 'registry'
      : repository !== undefined
        ? 'declared'
        : 'unknown'

  return {
    name: plugin.name,
    version: plugin.version,
    source,
    provenance,
    updateAvailable,
    updateStatus,
    ...(typeof (local.description ?? registry?.description) === 'string'
      ? { description: (local.description ?? registry.description).slice(0, 800) }
      : {}),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repository === undefined ? {} : { repository }),
    ...(typeof (local.license ?? registry?.license) === 'string'
      ? { license: String(local.license ?? registry.license).slice(0, 80) }
      : {}),
    ...(latestVersion === undefined ? {} : { latestVersion }),
    ...(updateAvailable && latestVersion !== undefined ? { updateSpec: `${plugin.name}@${latestVersion}` } : {}),
  }
}

/** Run a small async mapper with a fixed concurrency ceiling. */
async function mapWithConcurrency(values, limit, mapper) {
  const result = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      result[index] = await mapper(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()))
  return result
}

async function commandAvailable(command) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    await execFileAsync(locator, [command], { timeout: 3_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * Build the fallback shim text without user-controlled interpolation. The
 * version matches the repository's pinned package manager and is never
 * installed globally.
 */
export function managedPnpmShimContent(platform = process.platform) {
  if (platform === 'win32') {
    return `@echo off\r\nnpm.cmd exec --yes --package=pnpm@${MANAGED_PNPM_VERSION} -- pnpm %*\r\n`
  }
  return `#!/bin/sh\nexec npm exec --yes --package=pnpm@${MANAGED_PNPM_VERSION} -- pnpm "$@"\n`
}

/**
 * Prefer the user's pnpm. If Node.js provides npm but pnpm is absent, create a
 * private Desktop-only pnpm shim under DSH_HOME. npm downloads the pinned pnpm
 * into its normal cache on demand; system Node/npm and global packages are not
 * modified. This runs only after the Marketplace is opened.
 */
async function ensurePluginPackageManager({ dshHome }) {
  if (await commandAvailable('pnpm')) return { available: true, mode: 'system' }
  if (!await commandAvailable('npm')) return { available: false, mode: 'missing' }
  if (typeof dshHome !== 'string' || dshHome.length === 0) return { available: false, mode: 'missing' }

  const binDir = join(dshHome, 'desktop-tools', 'bin')
  const shimPath = join(binDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  await mkdir(binDir, { recursive: true })
  await writeFile(shimPath, managedPnpmShimContent(), { encoding: 'utf8', mode: 0o755 })
  if (process.platform !== 'win32') await chmod(shimPath, 0o755)
  return { available: true, mode: 'managed', pathPrefix: binDir }
}

function marketplaceEnvironment(baseEnvironment, packageManager) {
  if (packageManager.pathPrefix === undefined) return baseEnvironment
  return {
    ...baseEnvironment,
    PATH: `${packageManager.pathPrefix}${delimiter}${baseEnvironment.PATH ?? ''}`,
  }
}

/** Run one official profile-plugin command without a shell or string interpolation. */
async function runPluginCommand({ nodePath, dshHome, runtimeRoot, workingDirectory, args }) {
  const binPath = dshBinPath(runtimeRoot)
  const packageManager = await ensurePluginPackageManager({ dshHome })
  if (!packageManager.available) {
    throw new Error('Plugin operation failed: pnpm is unavailable and npm cannot provide the managed pnpm fallback.')
  }
  try {
    return await execFileAsync(nodePath, [binPath, 'plugin', '--profile', 'web', ...args], {
      cwd: workingDirectory ?? dirname(binPath),
      env: marketplaceEnvironment(harnessEnvironment(process.env, dshHome), packageManager),
      maxBuffer: PLUGIN_OUTPUT_LIMIT_BYTES,
      timeout: PLUGIN_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : ''
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const detail = stderr || stdout || (error instanceof Error ? error.message : String(error))
    throw new Error(`Plugin operation failed: ${detail}`)
  }
}

/** Detect prerequisites without requiring a separately installed global pnpm. */
export async function inspectPluginEnvironment({ nodePath, dshHome }) {
  const nodeVersion = await checkNodeRuntime(nodePath)
  const packageManager = await ensurePluginPackageManager({ dshHome })
  return {
    nodeVersion,
    pnpmAvailable: packageManager.available,
    profile: 'web',
    pnpmMode: packageManager.mode,
  }
}

/** List installed dependencies, local details, source evidence, and bounded update status. */
export async function listInstalledPlugins(options, { fetchImpl = globalThis.fetch } = {}) {
  const { stdout } = await runPluginCommand({ ...options, args: ['list', '--depth', '0', '--json'] })
  const plugins = parsePluginList(stdout)
  return mapWithConcurrency(plugins, MARKETPLACE_METADATA_CONCURRENCY, plugin => enrichInstalledPlugin(plugin, fetchImpl))
}

/** Serialize package mutations so two install/remove/update jobs cannot race one profile manifest. */
function serializeMutation(operation) {
  const run = mutationTail.then(operation, operation)
  mutationTail = run.then(() => undefined, () => undefined)
  return run
}

/** Install one package spec into the Web profile. A restart is intentionally left to the caller. */
export function installPlugin(options, value) {
  const spec = pluginSpec(value)
  return serializeMutation(async () => {
    await runPluginCommand({ ...options, args: ['add', spec] })
    return { installed: spec, restartRequired: true }
  })
}

/** Remove one installed dependency from the Web profile. */
export function removePlugin(options, value) {
  const name = pluginPackageName(value)
  return serializeMutation(async () => {
    await runPluginCommand({ ...options, args: ['remove', name] })
    return { removed: name, restartRequired: true }
  })
}
