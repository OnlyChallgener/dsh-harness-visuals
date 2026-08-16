import { spawn } from 'node:child_process'
import { join } from 'node:path'

const CLIP_TIMEOUT_MS = 5_000

/** Writes text through the Windows clipboard utility without exposing the text in argv.
 * @param {string} text - exact Unicode text written to standard input.
 * @param {{ spawnProcess?: typeof spawn, systemRoot?: string }} [options] - test seams for process creation and the Windows root.
 * @returns {Promise<boolean>} true only after clip.exe exits successfully.
 */
export function writeWindowsClipboardText(text, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawnProcess(join(systemRoot, 'System32', 'clip.exe'), [], {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: CLIP_TIMEOUT_MS,
      })
    } catch {
      finish(false)
      return
    }
    child.once('error', () => { finish(false) })
    child.once('close', (code, signal) => { finish(code === 0 && signal === null) })
    child.stdin.on('error', () => {
      // Process close owns the final result and distinguishes a clean exit.
    })
    child.stdin.end(Buffer.from(text, 'utf16le'))
  })
}
