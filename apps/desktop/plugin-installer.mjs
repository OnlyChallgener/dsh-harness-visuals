import { spawn } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import {
  comparePluginVersions,
  exactRegistryPluginVersion,
  parseBlockedBuildPackages,
  pluginPackageName,
  pluginSpec,
  readInstalledPluginVersion,
} from './plugin-marketplace.mjs'
import { dshBinPath, harnessEnvironment } from './runtime.mjs'

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024
const PROGRESS_LINE_LIMIT = 260
const ACTIVE_STATES = new Set(['running', 'approval-required'])

function webProfileDir(dshHome) {
  return join(dshHome, 'profiles', 'web')
}

function webProfileManifestPath(dshHome) {
  return join(webProfileDir(dshHome), 'package.json')
}

function webProfileWorkspacePath(dshHome) {
  return join(webProfileDir(dshHome), 'pnpm-workspace.yaml')
}

function packagedPnpmEntry(runtimeRoot) {
  return join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
}

function packagedPnpmBin(runtimeRoot) {
  return join(runtimeRoot, 'bin')
}

function packagedPnpmLauncher(runtimeRoot) {
  return join(packagedPnpmBin(runtimeRoot), process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
}

async function officialPluginEnvironment(options) {
  const pnpmEntry = packagedPnpmEntry(options.runtimeRoot)
  const pnpmLauncher = packagedPnpmLauncher(options.runtimeRoot)
  try {
    await access(pnpmEntry)
    await access(pnpmLauncher)
  } catch {
    throw new Error('The Desktop packaged pnpm runtime is missing. Rebuild or reinstall DeepSeek Harness Desktop.')
  }

  const base = harnessEnvironment(process.env, options.dshHome)
  let inheritedPath = ''
  for (const key of Object.keys(base)) {
    if (key.toUpperCase() !== 'PATH') continue
    inheritedPath = base[key] ?? ''
    delete base[key]
  }
  return {
    ...base,
    PATH: inheritedPath.length === 0
      ? packagedPnpmBin(options.runtimeRoot)
      : `${packagedPnpmBin(options.runtimeRoot)}${delimiter}${inheritedPath}`,
    DSH_DESKTOP_NODE: options.nodePath,
    CI: 'true',
  }
}

function quoteYamlKey(key) {
  if (/^[-?:,[\]{}#&*!|>'"%@`]/u.test(key) || /:(\s|$)/u.test(key)) {
    return `'${key.replace(/'/gu, "''")}'`
  }
  return key
}

/**
 * Repair pnpm placeholders/duplicates and optionally approve exact build
 * packages. Only the allowBuilds mapping is rewritten; every other workspace
 * setting is preserved verbatim.
 */
export function rewriteAllowBuildsDocument(source, approvedPackages = []) {
  const yaml = typeof source === 'string' ? source : ''
  const approved = new Set(approvedPackages.map(pluginPackageName))
  const eol = yaml.includes('\r\n') ? '\r\n' : '\n'
  const blockRe = /allowBuilds:\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/u
  const match = blockRe.exec(yaml)
  const values = new Map()

  if (match !== null) {
    for (const line of match[1].split(/\r?\n/u)) {
      const entry = /^[ \t]+(.+?)\s*:\s*(true|false)\s*(?:#.*)?$/iu.exec(line)
      if (entry === null) continue
      let key = entry[1].trim()
      if (key.length >= 2 && ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"')))) {
        key = key.slice(1, -1).replace(/''/gu, "'")
      }
      try {
        values.set(pluginPackageName(key), entry[2].toLowerCase())
      } catch {
        // Ignore malformed placeholder rows left by older pnpm/Desktop runs.
      }
    }
  }

  for (const name of approved) values.set(name, 'true')
  const block = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `  ${quoteYamlKey(name)}: ${value}`)
    .join(eol)
  const replacement = `allowBuilds:${eol}${block}${block.length === 0 ? '' : eol}`

  if (match !== null) return yaml.replace(blockRe, replacement)
  if (approved.size === 0) return yaml
  const prefix = yaml.length === 0 || /\r?\n$/u.test(yaml) ? yaml : `${yaml}${eol}`
  return `${prefix}${replacement}`
}

async function updateAllowBuilds(dshHome, approvedPackages = []) {
  if (approvedPackages.length === 0) return
  const file = webProfileWorkspacePath(dshHome)
  let before = ''
  try { before = await readFile(file, 'utf8') } catch { /* created below */ }
  const after = rewriteAllowBuildsDocument(before, approvedPackages)
  if (after !== before) await writeFile(file, after, 'utf8')
}

async function readProfileState(dshHome) {
  try {
    const manifest = JSON.parse(await readFile(webProfileManifestPath(dshHome), 'utf8'))
    const dependencies = manifest?.dependencies !== null && typeof manifest?.dependencies === 'object' && !Array.isArray(manifest.dependencies)
      ? Object.fromEntries(Object.entries(manifest.dependencies).filter(([, value]) => typeof value === 'string'))
      : {}
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
      ? manifest.dsh.profile.bundles.filter(value => typeof value === 'string')
      : []
    return { dependencies, bundles }
  } catch {
    return { dependencies: {}, bundles: [] }
  }
}

function registryPackageName(spec) {
  if (spec.startsWith('github:')) return undefined
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    const versionAt = spec.indexOf('@', slash + 1)
    return versionAt < 0 ? spec : spec.slice(0, versionAt)
  }
  const versionAt = spec.lastIndexOf('@')
  return versionAt > 0 ? spec.slice(0, versionAt) : spec
}

async function readInstalledManifest(dshHome, name) {
  const file = join(webProfileDir(dshHome), 'node_modules', ...name.split('/'), 'package.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  return { directory: dirname(file), manifest }
}

function rootExportCandidates(manifest) {
  const candidates = []
  if (typeof manifest.main === 'string') candidates.push(manifest.main)
  const root = typeof manifest.exports === 'string'
    ? manifest.exports
    : manifest.exports !== null && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)
      ? manifest.exports['.']
      : undefined
  if (typeof root === 'string') candidates.push(root)
  else if (root !== null && typeof root === 'object' && !Array.isArray(root)) {
    for (const value of Object.values(root)) if (typeof value === 'string') candidates.push(value)
  }
  return candidates
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Validate that a successful official DSH mutation left a usable package. */
export async function validateInstalledPlugin(dshHome, name) {
  const safeName = pluginPackageName(name)
  let installed
  try {
    installed = await readInstalledManifest(dshHome, safeName)
  } catch {
    throw new Error(`Installed plugin ${safeName} is missing its package.json.`)
  }
  const manifest = installed.manifest
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.dsh === undefined) {
    throw new Error(`Installed package ${safeName} does not declare a DSH plugin surface.`)
  }

  const entryCandidates = rootExportCandidates(manifest)
  if (entryCandidates.length > 0) {
    const present = await Promise.all(entryCandidates.map(candidate => pathExists(join(installed.directory, candidate))))
    if (!present.some(Boolean)) {
      throw new Error(`Installed plugin ${safeName} is missing its declared runtime entry. Its build did not complete.`)
    }
  }

  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch === 'string' && patch.length > 0) {
    if (!await pathExists(join(installed.directory, patch))) {
      throw new Error(`Installed plugin ${safeName} is missing its declared DSH bundle patch.`)
    }
    const profile = await readProfileState(dshHome)
    if (!profile.bundles.includes(safeName)) {
      throw new Error(`Installed plugin ${safeName} was not registered in dsh.profile.bundles by dsh plugin.`)
    }
    return { name: safeName, kind: 'bundle' }
  }

  return { name: safeName, kind: manifest.dsh?.client !== undefined ? 'client' : 'plugin' }
}

function changedDependencyNames(before, after) {
  const names = new Set()
  for (const [name, spec] of Object.entries(after.dependencies)) if (before.dependencies[name] !== spec) names.add(name)
  for (const name of Object.keys(before.dependencies)) if (after.dependencies[name] === undefined) names.add(name)
  return [...names]
}

function boundedOutput(value) {
  if (typeof value !== 'string') return ''
  return value.length > OUTPUT_LIMIT_BYTES ? value.slice(-OUTPUT_LIMIT_BYTES) : value
}

function errorDetail(error) {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.length > 12_000 ? raw.slice(-12_000) : raw
}

function abortError(message = 'Plugin operation cancelled.') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function killProcessTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => {})
      killer.unref?.()
    } catch {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
    }
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch {
    try { child.kill('SIGTERM') } catch { /* already exited */ }
  }
}

function createLineFeeder(onProgress) {
  let buffer = ''
  return chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length === 0) continue
      onProgress?.({ stage: 'installing', message: line.slice(-PROGRESS_LINE_LIMIT) })
    }
  }
}

/**
 * Run the official `dsh plugin --profile web ...` command. Desktop only owns
 * process lifetime and the pinned pnpm runtime; profile mutation/reconcile is
 * intentionally left to upstream DSH.
 */
export async function runOfficialPluginCommand(options, args, { signal, onProgress } = {}) {
  const binPath = dshBinPath(options.runtimeRoot)
  const env = await officialPluginEnvironment(options)
  if (signal?.aborted) throw abortError()

  return await new Promise((resolve, reject) => {
    const child = spawn(options.nodePath, [binPath, 'plugin', '--profile', 'web', ...args], {
      cwd: options.workingDirectory ?? dirname(binPath),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const feed = createLineFeeder(onProgress)
    const append = (channel, chunk) => {
      const text = chunk.toString()
      if (channel === 'stdout') stdout = boundedOutput(stdout + text)
      else stderr = boundedOutput(stderr + text)
      feed(text)
    }
    child.stdout.on('data', chunk => append('stdout', chunk))
    child.stderr.on('data', chunk => append('stderr', chunk))

    const finish = callback => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      callback()
    }
    const onAbort = () => { killProcessTree(child) }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      onProgress?.({ stage: 'timeout', message: 'Plugin installation exceeded 15 minutes; stopping the package process.' })
      killProcessTree(child)
    }, INSTALL_TIMEOUT_MS)
    timer.unref?.()

    child.once('error', error => {
      finish(() => reject(new Error(`Plugin process could not start: ${error.message}`)))
    })
    child.once('close', (code, childSignal) => {
      finish(() => {
        if (signal?.aborted) return reject(abortError())
        const detail = `${stderr}\n${stdout}`.trim()
        if (timedOut) return reject(new Error(`Plugin operation timed out after 15 minutes.\n${detail}`.trim()))
        if (code !== 0 || childSignal !== null) {
          return reject(new Error(`Plugin operation failed (exit ${code ?? 'none'}${childSignal === null ? '' : `, ${childSignal}`}).\n${detail}`.trim()))
        }
        resolve({ stdout, stderr })
      })
    })
  })
}

async function verifySuccessfulMutation(options, request, before) {
  const after = await readProfileState(options.dshHome)
  const expected = exactRegistryPluginVersion(request.spec)
  let candidates = changedDependencyNames(before, after).filter(name => after.dependencies[name] !== undefined)
  const registryName = registryPackageName(request.spec)

  if (expected !== undefined) {
    const installedVersion = await readInstalledPluginVersion(options.dshHome, expected.name)
    if (installedVersion === undefined || comparePluginVersions(installedVersion, expected.version) !== 0) {
      throw new Error(`Requested ${expected.name}@${expected.version}, but the installed version is ${installedVersion ?? 'missing'}.`)
    }
    if (after.dependencies[expected.name] === undefined) {
      throw new Error(`Requested ${expected.name}@${expected.version}, but it is not a direct Web profile dependency.`)
    }
    candidates = [expected.name]
  } else if (registryName !== undefined && after.dependencies[registryName] !== undefined) {
    candidates = [registryName]
  }

  if (candidates.length === 0) {
    throw new Error('dsh plugin exited successfully but no installed plugin dependency could be verified.')
  }
  const surfaces = []
  for (const name of candidates) surfaces.push(await validateInstalledPlugin(options.dshHome, name))
  return {
    names: candidates,
    surfaces,
    ...(expected === undefined ? {} : { installedVersion: expected.version }),
  }
}

/** Execute one real install/update transaction through upstream DSH. */
export async function executePluginMutation(options, request, {
  approvedPackages = [],
  signal,
  onProgress,
} = {}) {
  const spec = pluginSpec(request.spec)
  const mode = request.mode === 'update' ? 'update' : 'install'
  if (mode === 'update' && exactRegistryPluginVersion(spec) === undefined) {
    throw new Error('Marketplace updates require an exact npm package version.')
  }

  const before = await readProfileState(options.dshHome)
  if (approvedPackages.length > 0) await updateAllowBuilds(options.dshHome, approvedPackages)
  onProgress?.({ stage: 'starting', message: mode === 'update' ? `Updating ${spec}` : `Installing ${spec}` })

  try {
    await runOfficialPluginCommand(options, ['add', spec], { signal, onProgress })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    const detail = errorDetail(error)
    const blocked = parseBlockedBuildPackages(detail)
    if (blocked.length > 0 && approvedPackages.length === 0) {
      return {
        restartRequired: false,
        approvalRequired: { kind: 'build-scripts', packages: blocked },
      }
    }
    throw new Error(detail)
  }

  onProgress?.({ stage: 'verifying', message: 'Verifying the installed DSH package and profile registration.' })
  const verified = await verifySuccessfulMutation(options, { spec, mode }, before)
  return {
    installed: spec,
    installedNames: verified.names,
    surfaces: verified.surfaces,
    ...(verified.installedVersion === undefined ? {} : { installedVersion: verified.installedVersion }),
    restartRequired: true,
  }
}

function normalizeJobRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin job request.')
  const spec = pluginSpec(value.spec)
  const mode = value.mode === 'update' ? 'update' : value.mode === 'install' ? 'install' : undefined
  if (mode === undefined) throw new Error('Invalid plugin job mode.')
  if (mode === 'update' && exactRegistryPluginVersion(spec) === undefined) {
    throw new Error('Marketplace updates require an exact npm package version.')
  }
  return { spec, mode }
}

function publicJob(job) {
  if (job === undefined) return undefined
  return {
    id: job.id,
    spec: job.spec,
    mode: job.mode,
    state: job.state,
    stage: job.stage,
    message: job.message,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
    ...(job.approvalRequired === undefined ? {} : { approvalRequired: job.approvalRequired }),
    ...(job.result === undefined ? {} : { result: job.result }),
    ...(job.error === undefined ? {} : { error: job.error }),
  }
}

/**
 * Host-owned installer job. Renderer/settings lifetime never owns the child
 * process; closing Settings only stops polling the snapshot.
 */
export function createPluginInstallerService(optionsFactory, { executor = executePluginMutation } = {}) {
  let current
  let sequence = 0

  const launch = (job, approvedPackages = []) => {
    const controller = new AbortController()
    job.controller = controller
    job.state = 'running'
    job.stage = approvedPackages.length > 0 ? 'approved' : 'starting'
    job.message = approvedPackages.length > 0 ? 'Build scripts approved; retrying installation.' : `Starting ${job.mode}.`
    job.updatedAt = Date.now()
    job.approvalRequired = undefined
    const options = optionsFactory()
    job.promise = Promise.resolve(executor(options, { spec: job.spec, mode: job.mode }, {
      approvedPackages,
      signal: controller.signal,
      onProgress(progress) {
        if (current !== job || job.state !== 'running') return
        if (typeof progress?.stage === 'string') job.stage = progress.stage
        if (typeof progress?.message === 'string' && progress.message.length > 0) job.message = progress.message.slice(-PROGRESS_LINE_LIMIT)
        job.updatedAt = Date.now()
      },
    })).then(result => {
      if (current !== job) return
      if (result?.approvalRequired !== undefined) {
        job.state = 'approval-required'
        job.stage = 'approval-required'
        job.message = 'This plugin needs permission to run dependency build scripts.'
        job.approvalRequired = result.approvalRequired
        job.updatedAt = Date.now()
        return
      }
      job.state = 'succeeded'
      job.stage = 'complete'
      job.message = 'Plugin package operation completed and was verified.'
      job.result = result
      job.completedAt = Date.now()
      job.updatedAt = job.completedAt
    }, error => {
      if (current !== job) return
      const cancelled = controller.signal.aborted || error?.name === 'AbortError'
      job.state = cancelled ? 'cancelled' : 'failed'
      job.stage = cancelled ? 'cancelled' : 'failed'
      job.message = cancelled ? 'Plugin operation cancelled.' : 'Plugin operation failed.'
      job.error = cancelled ? undefined : errorDetail(error)
      job.completedAt = Date.now()
      job.updatedAt = job.completedAt
    })
  }

  return {
    start(value) {
      const request = normalizeJobRequest(value)
      if (current !== undefined && ACTIVE_STATES.has(current.state)) {
        if (current.spec === request.spec && current.mode === request.mode) return publicJob(current)
        throw new Error(`Another plugin operation is already active: ${current.spec}`)
      }
      const now = Date.now()
      current = {
        id: `plugin-${now}-${++sequence}`,
        spec: request.spec,
        mode: request.mode,
        state: 'running',
        stage: 'starting',
        message: '',
        startedAt: now,
        updatedAt: now,
      }
      launch(current)
      return publicJob(current)
    },
    status() {
      return publicJob(current)
    },
    approve(id) {
      if (current === undefined || current.id !== id || current.state !== 'approval-required') {
        throw new Error('No matching plugin build approval is pending.')
      }
      const packages = current.approvalRequired?.packages ?? []
      if (packages.length === 0) throw new Error('The pending plugin job has no build packages to approve.')
      launch(current, packages)
      return publicJob(current)
    },
    cancel(id) {
      if (current === undefined || current.id !== id) return publicJob(current)
      if (current.state === 'running') current.controller?.abort()
      else if (current.state === 'approval-required') {
        current.state = 'cancelled'
        current.stage = 'cancelled'
        current.message = 'Plugin operation cancelled.'
        current.completedAt = Date.now()
        current.updatedAt = current.completedAt
      }
      return publicJob(current)
    },
    cancelActive() {
      if (current !== undefined && ACTIVE_STATES.has(current.state)) this.cancel(current.id)
    },
  }
}
