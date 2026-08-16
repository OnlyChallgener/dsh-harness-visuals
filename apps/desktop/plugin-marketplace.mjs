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
const BUILD_APPROVAL_TTL_MS = 10 * 60 * 1000
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu
const REGISTRY_SPEC_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[a-z0-9][a-z0-9._+-]*)?$/iu
const GITHUB_SPEC_PATTERN = /^github:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:#[a-z0-9][a-z0-9._\/-]*)?$/iu
const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

let mutationTail = Promise.resolve()
const pendingBuildApprovals = new Map()

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

/** Extract an exact npm semantic-version target. Tags and GitHub sources are intentionally not exact. */
export function exactRegistryPluginVersion(value) {
  const spec = pluginSpec(value)
  if (GITHUB_SPEC_PATTERN.test(spec)) return undefined
  const separator = spec.lastIndexOf('@')
  if (separator <= 0) return undefined
  const name = spec.slice(0, separator)
  const version = spec.slice(separator + 1)
  if (!PACKAGE_NAME_PATTERN.test(name) || !SEMVER_PATTERN.test(version)) return undefined
  return { name, version }
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

/** Build the fallback shim text without user-controlled interpolation. */
export function managedPnpmShimContent(platform = process.platform) {
  if (platform === 'win32') {
    return `@echo off\r\nnpm.cmd exec --yes --package=pnpm@${MANAGED_PNPM_VERSION} -- pnpm %*\r\n`
  }
  return `#!/bin/sh\nexec npm exec --yes --package=pnpm@${MANAGED_PNPM_VERSION} -- pnpm "$@"\n`
}

/** Prefer system pnpm, otherwise create a Desktop-only pinned npm-exec shim. */
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

function webProfileManifestPath(dshHome) {
  if (typeof dshHome !== 'string' || dshHome.length === 0) return undefined
  return join(dshHome, 'profiles', 'web', 'package.json')
}

function webProfileWorkspacePath(dshHome) {
  if (typeof dshHome !== 'string' || dshHome.length === 0) return undefined
  return join(dshHome, 'profiles', 'web', 'pnpm-workspace.yaml')
}

function webProfilePackageManifestPath(dshHome, name) {
  if (typeof dshHome !== 'string' || dshHome.length === 0) return undefined
  const safeName = pluginPackageName(name)
  return join(dshHome, 'profiles', 'web', 'node_modules', ...safeName.split('/'), 'package.json')
}

/** Read the package version that actually landed in the Web profile node_modules tree. */
export async function readInstalledPluginVersion(dshHome, name) {
  const file = webProfilePackageManifestPath(dshHome, name)
  if (file === undefined) return undefined
  try {
    const manifest = JSON.parse(await readFile(file, 'utf8'))
    return typeof manifest?.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** Verify exact npm installs/updates against the package that is really on disk. */
export async function verifyExactPluginInstall(dshHome, value) {
  const expected = exactRegistryPluginVersion(value)
  if (expected === undefined) return undefined
  const installedVersion = await readInstalledPluginVersion(dshHome, expected.name)
  if (installedVersion === undefined) {
    throw new Error(`Plugin operation did not apply ${expected.name}@${expected.version}: installed package is missing after pnpm completed.`)
  }
  if (comparePluginVersions(installedVersion, expected.version) !== 0) {
    throw new Error(`Plugin operation did not apply requested version for ${expected.name}: expected ${expected.version}, found ${installedVersion}.`)
  }
  return { ...expected, installedVersion }
}

/** Snapshot only the profile dependency map before pnpm gets a chance to mutate it. */
export async function readProfileDependencySnapshot(dshHome) {
  const file = webProfileManifestPath(dshHome)
  if (file === undefined) return undefined
  try {
    const manifest = JSON.parse(await readFile(file, 'utf8'))
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined
    const dependencies = manifest.dependencies
    if (dependencies === undefined) return {}
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return undefined
    return Object.fromEntries(Object.entries(dependencies).filter(([, spec]) => typeof spec === 'string'))
  } catch {
    return undefined
  }
}

/** Restore only dependencies after a failed pnpm mutation. */
export async function restoreProfileDependencySnapshot(dshHome, snapshot) {
  if (snapshot === undefined) return []
  const file = webProfileManifestPath(dshHome)
  if (file === undefined) return []
  let manifest
  try {
    manifest = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return []
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return []
  const rawCurrent = manifest.dependencies
  const current = rawCurrent !== null && typeof rawCurrent === 'object' && !Array.isArray(rawCurrent)
    ? rawCurrent
    : {}
  const touched = new Set()
  for (const [name, spec] of Object.entries(current)) {
    if (typeof spec !== 'string' || snapshot[name] !== spec) touched.add(name)
  }
  for (const [name, spec] of Object.entries(snapshot)) {
    if (current[name] !== spec) touched.add(name)
  }
  if (touched.size === 0) return []
  manifest.dependencies = { ...snapshot }
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return [...touched].sort()
}

function packageNameWithoutVersion(value) {
  const trimmed = value.trim().replace(/[.,;]+$/u, '')
  const separator = trimmed.lastIndexOf('@')
  const candidate = separator > 0 ? trimmed.slice(0, separator) : trimmed
  return PACKAGE_NAME_PATTERN.test(candidate) ? candidate : undefined
}

/** Extract packages pnpm refused to run build/prepare scripts for. */
export function parseBlockedBuildPackages(output) {
  if (typeof output !== 'string' || output.length === 0) return []
  const found = new Set()
  const ignoredIndex = output.search(/Ignored build scripts:/iu)
  if (ignoredIndex >= 0) {
    const tail = output.slice(ignoredIndex).replace(/^.*?Ignored build scripts:\s*/isu, '')
    const segment = tail.split(/(?:Run|Use)\s+["'`]?pnpm\s+(?:approve-builds|ignored-builds)/iu, 1)[0]
    for (const part of segment.split(/[\n,]/u)) {
      const name = packageNameWithoutVersion(part)
      if (name !== undefined) found.add(name)
    }
  }
  for (const match of output.matchAll(/git-hosted package\s+"([^"]+)"\s+needs to execute build scripts/giu)) {
    const name = packageNameWithoutVersion(match[1])
    if (name !== undefined) found.add(name)
  }
  return [...found].sort()
}

/** Classify only failures for which the Desktop has a bounded safe recovery. */
export function classifyMarketplacePnpmFailure(output) {
  const blockedBuilds = parseBlockedBuildPackages(output)
  if (/ERR_PNPM_IGNORED_BUILDS|ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/iu.test(output) || blockedBuilds.length > 0) {
    return { kind: 'build-approval', packages: blockedBuilds }
  }
  if (/ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION|ERR_PNPM_NO_MATURE_MATCHING_VERSION/iu.test(output)) {
    return { kind: 'release-age' }
  }
  if (/ERR_PNPM_FETCH_5\d\d|ERR_PNPM_META_FETCH_FAIL|FetchError|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|network timeout/iu.test(output)) {
    return { kind: 'transient-network' }
  }
  return { kind: 'other' }
}

function simpleAllowBuildEntry(line) {
  const match = /^([ \t]+)([^:#][^:]*):[ \t]*(.*)$/u.exec(line)
  if (match === null) return undefined
  const name = match[2].trim()
  if (!PACKAGE_NAME_PATTERN.test(name)) return undefined
  return { indent: match[1], name, value: match[3].trim() }
}

function preferredAllowBuildValue(values) {
  const normalized = values.map(value => value.replace(/\s+#.*$/u, '').trim().toLowerCase())
  if (normalized.includes('false')) return 'false'
  if (normalized.includes('true')) return 'true'
  return values[0] ?? 'set this to true or false'
}

/**
 * Normalize pnpm's allowBuilds block without parsing the rest of the workspace
 * document. pnpm 11 can append `set this to true or false` placeholders on a
 * failed install; older Desktop builds then appended a second key, producing
 * invalid YAML. Exact duplicate package keys are collapsed conservatively:
 * an explicit false wins unless this call carries a fresh user approval.
 */
export function normalizeAllowBuildsDocument(source, approvedPackages = []) {
  const yaml = typeof source === 'string' ? source : ''
  const approved = new Set(approvedPackages.map(pluginPackageName))
  const eol = yaml.includes('\r\n') ? '\r\n' : '\n'
  const lines = yaml.split(/\r?\n/u)
  const headerIndex = lines.findIndex(line => /^allowBuilds:\s*(?:#.*)?$/u.test(line))

  if (headerIndex < 0) {
    if (approved.size === 0) return yaml
    const prefix = yaml.length === 0 || yaml.endsWith('\n') ? yaml : `${yaml}${eol}`
    return `${prefix}allowBuilds:${eol}${[...approved].sort().map(name => `  ${name}: true`).join(eol)}${eol}`
  }

  let blockEnd = headerIndex + 1
  while (blockEnd < lines.length) {
    const line = lines[blockEnd]
    if (line.trim().length === 0 || /^[ \t]/u.test(line)) {
      blockEnd += 1
      continue
    }
    break
  }

  const block = lines.slice(headerIndex + 1, blockEnd)
  const valuesByName = new Map()
  for (const line of block) {
    const entry = simpleAllowBuildEntry(line)
    if (entry === undefined) continue
    const values = valuesByName.get(entry.name) ?? []
    values.push(entry.value)
    valuesByName.set(entry.name, values)
  }

  const emitted = new Set()
  const nextBlock = []
  for (const line of block) {
    const entry = simpleAllowBuildEntry(line)
    if (entry === undefined) {
      nextBlock.push(line)
      continue
    }
    if (emitted.has(entry.name)) continue
    emitted.add(entry.name)
    const value = approved.has(entry.name)
      ? 'true'
      : preferredAllowBuildValue(valuesByName.get(entry.name) ?? [entry.value])
    nextBlock.push(`${entry.indent}${entry.name}: ${value}`)
  }
  for (const name of [...approved].sort()) {
    if (!emitted.has(name)) nextBlock.push(`  ${name}: true`)
  }

  return [...lines.slice(0, headerIndex + 1), ...nextBlock, ...lines.slice(blockEnd)].join(eol)
}

/** Preserve the old helper name used by tests and callers. */
export function mergeAllowBuildsDocument(source, packages) {
  return normalizeAllowBuildsDocument(source, packages)
}

/** Repair only duplicate simple package keys left by an earlier Desktop build. */
export async function repairProfileAllowBuilds(dshHome) {
  const file = webProfileWorkspacePath(dshHome)
  if (file === undefined) return false
  let before
  try {
    before = await readFile(file, 'utf8')
  } catch {
    return false
  }
  const after = normalizeAllowBuildsDocument(before)
  if (after === before) return false
  await writeFile(file, after, 'utf8')
  return true
}

async function allowProfileBuilds(dshHome, packages) {
  const file = webProfileWorkspacePath(dshHome)
  if (file === undefined) throw new Error('Cannot locate the Web profile pnpm-workspace.yaml for build approval.')
  let before = ''
  try { before = await readFile(file, 'utf8') } catch { /* create the file below */ }
  const after = normalizeAllowBuildsDocument(before, packages)
  if (after !== before) await writeFile(file, after, 'utf8')
}

function commandFailureDetail(error) {
  const outputs = [error?.stderr, error?.stdout]
    .filter(value => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim())
  const unique = [...new Set(outputs)]
  const detail = unique.join('\n') || (error instanceof Error ? error.message : String(error))
  return detail.length > 8_000 ? detail.slice(-8_000) : detail
}

/** Run one official profile-plugin command without a shell or string interpolation. */
async function runPluginCommand({ nodePath, dshHome, runtimeRoot, workingDirectory, args }) {
  const binPath = dshBinPath(runtimeRoot)
  const packageManager = await ensurePluginPackageManager({ dshHome })
  if (!packageManager.available) {
    throw new Error('Plugin operation failed: pnpm is unavailable and npm cannot provide the managed pnpm fallback.')
  }
  try {
    // Repair the exact duplicate-key shape created by pnpm 11 + the previous
    // Desktop approval implementation before any `dsh plugin` command parses
    // the profile. Valid workspace settings and unrelated keys are untouched.
    await repairProfileAllowBuilds(dshHome)
    return await execFileAsync(nodePath, [binPath, 'plugin', '--profile', 'web', ...args], {
      cwd: workingDirectory ?? dirname(binPath),
      env: marketplaceEnvironment(harnessEnvironment(process.env, dshHome), packageManager),
      maxBuffer: PLUGIN_OUTPUT_LIMIT_BYTES,
      timeout: PLUGIN_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (error) {
    throw new Error(`Plugin operation failed: ${commandFailureDetail(error)}`)
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

function mutationRequest(value) {
  if (typeof value === 'string') return { spec: pluginSpec(value), mode: 'install', approveBuilds: false }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin operation request.')
  const spec = pluginSpec(value.spec)
  const mode = value.mode === 'update' ? 'update' : value.mode === undefined || value.mode === 'install' ? 'install' : undefined
  if (mode === undefined || (value.approveBuilds !== undefined && typeof value.approveBuilds !== 'boolean')) {
    throw new Error('Invalid plugin operation request.')
  }
  return { spec, mode, approveBuilds: value.approveBuilds === true }
}

function approvalKey(mode, spec) {
  return `${mode}:${spec}`
}

function pendingApproval(key) {
  const value = pendingBuildApprovals.get(key)
  if (value === undefined) return undefined
  if (Date.now() - value.createdAt > BUILD_APPROVAL_TTL_MS) {
    pendingBuildApprovals.delete(key)
    return undefined
  }
  return value
}

async function runPluginCommandWithRecovery(options, args, { releaseAgeBypass = false } = {}) {
  try {
    return await runPluginCommand({ ...options, args })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const failure = classifyMarketplacePnpmFailure(detail)
    if (failure.kind === 'release-age' && releaseAgeBypass && (args[0] === 'add' || args[0] === 'remove')) {
      return runPluginCommand({ ...options, args: [args[0], '--config.minimumReleaseAge=0', ...args.slice(1)] })
    }
    if (failure.kind === 'transient-network' && (args[0] === 'add' || args[0] === 'remove')) {
      return runPluginCommand({ ...options, args })
    }
    throw error
  }
}

async function runProfileMutation(options, args, {
  verify,
  releaseAgeBypass = false,
  approval,
} = {}) {
  const before = await readProfileDependencySnapshot(options.dshHome)
  try {
    if (approval?.approveBuilds === true) {
      const pending = pendingApproval(approval.key)
      if (pending === undefined || pending.packages.length === 0) {
        throw new Error('Build-script approval expired or does not match a pending plugin operation. Start the operation again.')
      }
      await allowProfileBuilds(options.dshHome, pending.packages)
    }
    const result = await runPluginCommandWithRecovery(options, args, { releaseAgeBypass })
    if (typeof verify === 'function') await verify()
    if (approval?.key !== undefined) pendingBuildApprovals.delete(approval.key)
    return result
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const failure = classifyMarketplacePnpmFailure(detail)
    let approvalRequired
    if (failure.kind === 'build-approval' && failure.packages.length > 0 && approval?.key !== undefined) {
      if (approval.approveBuilds !== true) {
        pendingBuildApprovals.set(approval.key, { packages: failure.packages, createdAt: Date.now() })
        approvalRequired = failure.packages
      } else {
        pendingBuildApprovals.delete(approval.key)
      }
    }

    let rolledBack = []
    try {
      rolledBack = await restoreProfileDependencySnapshot(options.dshHome, before)
    } catch {
      rolledBack = []
    }
    if (approvalRequired !== undefined) {
      return { approvalRequired, rolledBack }
    }
    if (rolledBack.length === 0) throw error
    throw new Error(`${detail}\nDesktop rolled back the failed Web profile dependency change: ${rolledBack.join(', ')}`)
  }
}

/** Install/update one package spec into the Web profile. Build-script approval is an explicit two-step handshake. */
export function installPlugin(options, value) {
  const request = mutationRequest(value)
  if (request.mode === 'update' && exactRegistryPluginVersion(request.spec) === undefined) {
    throw new Error('Marketplace updates require an exact npm package version.')
  }
  const key = approvalKey(request.mode, request.spec)
  return serializeMutation(async () => {
    let verification
    const mutation = await runProfileMutation(options, ['add', request.spec], {
      releaseAgeBypass: request.mode === 'update',
      approval: { key, approveBuilds: request.approveBuilds },
      verify: async () => {
        verification = await verifyExactPluginInstall(options.dshHome, request.spec)
      },
    })
    if (mutation?.approvalRequired !== undefined) {
      return {
        restartRequired: false,
        approvalRequired: {
          kind: 'build-scripts',
          packages: mutation.approvalRequired,
        },
      }
    }
    return {
      installed: request.spec,
      ...(verification === undefined ? {} : { installedVersion: verification.installedVersion }),
      restartRequired: true,
    }
  })
}

/** Remove one installed dependency from the Web profile. Release-age recovery is scoped to this user action only. */
export function removePlugin(options, value) {
  const name = pluginPackageName(value)
  return serializeMutation(async () => {
    await runProfileMutation(options, ['remove', name], { releaseAgeBypass: true })
    return { removed: name, restartRequired: true }
  })
}
