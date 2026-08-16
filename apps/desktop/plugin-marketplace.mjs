import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { checkNodeRuntime, dshBinPath, harnessEnvironment } from './runtime.mjs'

const execFileAsync = promisify(execFile)
const PLUGIN_COMMAND_TIMEOUT_MS = 5 * 60 * 1000
const PLUGIN_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024
const PLUGIN_SPEC_MAX_LENGTH = 512
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu
const REGISTRY_SPEC_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[a-z0-9][a-z0-9._-]*)?$/iu
const GITHUB_SPEC_PATTERN = /^github:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:#[a-z0-9][a-z0-9._\/-]*)?$/iu

let mutationTail = Promise.resolve()

/**
 * Validates one package spec before it reaches the official `dsh plugin`
 * forwarder. Marketplace installs intentionally start with registry packages
 * (optionally pinned to an exact version/tag) and GitHub shorthand. Arbitrary
 * shell/path/tarball specs stay outside this UI boundary because the official
 * Windows plugin forwarder must invoke pnpm through its command shim.
 * @param {unknown} value - Candidate package spec.
 * @returns {string} The trimmed safe spec.
 */
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

/**
 * Validates the installed package name accepted by remove/inspect operations.
 * Version and source suffixes are intentionally rejected here: removal acts on
 * the dependency key recorded by pnpm, not on an install spec.
 * @param {unknown} value - Candidate package name.
 * @returns {string} The safe package name.
 */
export function pluginPackageName(value) {
  if (typeof value !== 'string') throw new TypeError('Plugin package name must be a string.')
  const name = value.trim()
  if (name.length === 0 || name.length > PLUGIN_SPEC_MAX_LENGTH || !PACKAGE_NAME_PATTERN.test(name)) {
    throw new Error('Plugin package name is invalid.')
  }
  return name
}

/**
 * Parses `pnpm list --depth 0 --json` into the stable subset the future
 * marketplace UI needs. Unknown pnpm fields stay private to this backend.
 * @param {string} output - pnpm JSON output.
 * @returns {{ name: string, version: string, path?: string }[]} Installed dependencies.
 */
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
      return [{ name, version, ...(path === undefined ? {} : { path }) }]
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Run one official profile-plugin command without a shell or string interpolation. */
async function runPluginCommand({ nodePath, dshHome, runtimeRoot, workingDirectory, args }) {
  const binPath = dshBinPath(runtimeRoot)
  try {
    return await execFileAsync(nodePath, [binPath, 'plugin', '--profile', 'web', ...args], {
      cwd: workingDirectory ?? dirname(binPath),
      env: harnessEnvironment(process.env, dshHome),
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

/**
 * Detects only prerequisites; it does not initialize a profile, touch the
 * network, or enumerate the npm registry, so opening the application never
 * pays marketplace cost.
 * @returns {Promise<{ nodeVersion: string, pnpmAvailable: boolean, profile: 'web' }>} Environment summary.
 */
export async function inspectPluginEnvironment({ nodePath }) {
  const nodeVersion = await checkNodeRuntime(nodePath)
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  let pnpmAvailable = false
  try {
    await execFileAsync(locator, ['pnpm'], { timeout: 3_000, windowsHide: true })
    pnpmAvailable = true
  } catch {
    pnpmAvailable = false
  }
  return { nodeVersion, pnpmAvailable, profile: 'web' }
}

/** List installed Web-profile dependencies through the official plugin path. */
export async function listInstalledPlugins(options) {
  const { stdout } = await runPluginCommand({ ...options, args: ['list', '--depth', '0', '--json'] })
  return parsePluginList(stdout)
}

/** Serialize package mutations so two install/remove jobs cannot race one profile manifest. */
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
