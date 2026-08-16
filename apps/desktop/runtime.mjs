import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+/u
const NODE_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)/u
const execFileAsync = promisify(execFile)
const DEFAULT_LAUNCHER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'runtime-launcher.cjs')
const WINDOWS_OCR_TIMEOUT_MS = 30_000
const DEFAULT_HARNESS_PORTS = Array.from({ length: 10 }, (_value, index) => 3080 + index)
const SYSTEM_ENV_KEYS = new Set([
  'ALL_PROXY',
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
])

/**
 * Finds the published CLI entry bundled with this desktop application.
 * @returns {string} Absolute path to dsh's executable module.
 */
export function dshBinPath(runtimeRoot) {
  const deployedBin = join(runtimeRoot, 'lib', 'bin.js')
  if (existsSync(deployedBin)) return deployedBin
  const require = createRequire(`${runtimeRoot}/package.json`)
  return require.resolve('@deepseek-ai/dsh/lib/bin.js')
}

/**
 * Extracts the local web URL from a dsh startup log chunk.
 * @param {string} output - Text emitted by the dsh process.
 * @returns {string | undefined} The local URL when this chunk announces it.
 */
export function webUrlFromOutput(output) {
  return output.match(URL_PATTERN)?.[0]
}

/**
 * Parses a Node.js version string emitted by `node --version`.
 * @param {string} output - Version output.
 * @returns {{ major: number, minor: number, patch: number } | undefined} The parsed version.
 */
export function nodeVersionFromOutput(output) {
  const match = output.trim().match(NODE_VERSION_PATTERN)
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Returns whether a Node.js version satisfies the desktop runtime contract.
 * @param {{ major: number, minor: number, patch: number }} version - Parsed version.
 * @returns {boolean} Whether the version is supported.
 */
export function isSupportedNodeVersion(version) {
  return version.major > 24
    || version.major === 24
    || (version.major === 22 && version.minor >= 19)
}

/**
 * Checks the selected Node.js executable before starting the embedded runtime.
 * @param {string} nodePath - Node.js executable path.
 * @returns {Promise<string>} The validated version string.
 */
export async function checkNodeRuntime(nodePath) {
  let stdout
  try {
    ({ stdout } = await execFileAsync(nodePath, ['--version'], {
      timeout: 5_000,
      windowsHide: true,
    }))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`无法运行 Node.js（${nodePath}）：${detail}`)
  }
  const version = nodeVersionFromOutput(stdout)
  if (version === undefined || !isSupportedNodeVersion(version)) {
    throw new Error(`Node.js 版本不受支持：${stdout.trim() || '未知'}。需要 22.19+ 或 24+。`)
  }
  return stdout.trim()
}

/**
 * Probes whether the desktop can bind one loopback port without exposing it.
 * @param {number} port - Candidate TCP port.
 * @returns {Promise<boolean>} Whether the bind succeeded.
 */
async function canBindHarnessPort(port) {
  return await new Promise(resolve => {
    const server = createServer()
    server.unref()
    server.once('error', () => { resolve(false) })
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => { resolve(true) })
    })
  })
}

/**
 * Chooses a stable local Harness port when possible, falling back to an
 * OS-assigned ephemeral port only after the preferred range is occupied.
 * The injected probe keeps the policy deterministic in tests.
 * @param {{ candidates?: readonly number[], probe?: (port: number) => Promise<boolean> }} [options] - Selection policy overrides.
 * @returns {Promise<number>} A preferred port, or 0 for OS assignment.
 */
export async function selectHarnessPort(options = {}) {
  const candidates = options.candidates ?? DEFAULT_HARNESS_PORTS
  const probe = options.probe ?? canBindHarnessPort
  for (const port of candidates) {
    if (await probe(port)) return port
  }
  return 0
}

/**
 * Builds the minimum inherited environment needed by Harness on the desktop.
 * @param {NodeJS.ProcessEnv} source - The desktop process environment.
 * @param {string} dshHome - Harness's private data directory.
 * @returns {NodeJS.ProcessEnv} The child environment.
 */
export function harnessEnvironment(source, dshHome) {
  const entries = Object.entries(source).filter(([key]) =>
    SYSTEM_ENV_KEYS.has(key.toUpperCase()) || key.startsWith('DSH_') || key.startsWith('DEEPSEEK_'))
  return {
    ...Object.fromEntries(entries),
    DSH_HOME: dshHome,
    ELECTRON_RUN_AS_NODE: '1',
  }
}

/** Returns the media-type extension used for a temporary Windows OCR image. */
function imageExtension(mediaType) {
  switch (mediaType) {
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return '.png'
  }
}

/** Keeps credentials and unrelated application variables out of the OCR process. */
function windowsOcrEnvironment() {
  const keys = [
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PSMODULEPATH',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'WINDIR',
  ]
  return Object.fromEntries(keys.flatMap(key => {
    const value = process.env[key]
    return value === undefined ? [] : [[key, value]]
  }))
}

/**
 * Runs the Windows 10/11 built-in OCR engine against one image.
 * @param {{ data: ArrayBuffer, mediaType: string, scriptPath: string, tempDirectory: string }} options - Image bytes and packaged OCR script paths.
 * @returns {Promise<string>} Recognized text, or an empty string when no text is visible.
 */
export async function runWindowsOcr({ data, mediaType, scriptPath, tempDirectory }) {
  if (process.platform !== 'win32') throw new Error('Windows OCR is available only on Windows 10/11.')
  const directory = await mkdtemp(join(tempDirectory, 'dsh-ocr-'))
  const imagePath = join(directory, `image${imageExtension(mediaType)}`)
  try {
    await writeFile(imagePath, Buffer.from(data), { flag: 'wx', mode: 0o600 })
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      imagePath,
    ], {
      cwd: directory,
      env: windowsOcrEnvironment(),
      maxBuffer: 2 * 1024 * 1024,
      timeout: WINDOWS_OCR_TIMEOUT_MS,
      windowsHide: true,
    })
    return stdout.trim()
  } finally {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch {
      // OCR temp cleanup is best effort after the PowerShell process settles.
    }
  }
}

/**
 * Starts a local Harness server using the selected Node.js runtime.
 * @param {{ nodePath: string, dshHome: string, runtimeRoot: string, launcherPath?: string, workingDirectory?: string, port?: number, onOutput: (output: string) => void, onReady: (url: string) => void, onExit: (code: number | null, signal: NodeJS.Signals | null) => void, onError: (error: Error) => void }} options - Runtime settings and process callbacks.
 * @returns {import('node:child_process').ChildProcessWithoutNullStreams} The running dsh process.
 */
export function startHarness({ nodePath, dshHome, runtimeRoot, launcherPath = DEFAULT_LAUNCHER_PATH, workingDirectory, port = 0, onOutput, onReady, onExit, onError }) {
  const binPath = dshBinPath(runtimeRoot)
  const child = spawn(nodePath, [launcherPath, binPath, 'web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: workingDirectory ?? dirname(binPath),
    env: harnessEnvironment(process.env, dshHome),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  const forward = chunk => onOutput(chunk.toString())
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)
  child.on('message', (message) => {
    if (message?.type !== 'ready' || typeof message.url !== 'string') return
    const url = webUrlFromOutput(message.url)
    if (url === message.url) onReady(url)
  })
  child.once('error', onError)
  child.once('exit', onExit)
  return child
}

/**
 * Terminates a managed Harness process and its descendants, then waits for exit.
 * @param {import('node:child_process').ChildProcess} child - The managed process.
 * @returns {Promise<void>} A promise settled after the process exits or the bounded shutdown wait expires.
 */
export async function stopProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const exited = (child.exitCode !== null || child.signalCode !== null)
    ? Promise.resolve()
    : once(child, 'exit').then(() => undefined, () => undefined)
  let gracefulRequestSent = false
  if (typeof child.send === 'function' && child.connected) {
    try {
      child.send({ type: 'shutdown' })
      gracefulRequestSent = true
    } catch {
      gracefulRequestSent = false
    }
  }
  if (!gracefulRequestSent && process.platform !== 'win32') {
    try {
      child.kill('SIGTERM')
    } catch {
      // Ignore signal errors if process already exited.
    }
  }
  await Promise.race([exited, delay(5_000)])
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        killer.on('error', () => {})
        await once(killer, 'exit').catch(() => undefined)
      } catch {
        // Ignore taskkill errors if process already exited or taskkill unavailable.
      }
    } else {
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore kill errors if process already exited.
      }
    }
  }
  await Promise.race([exited, delay(1_000)])
}
