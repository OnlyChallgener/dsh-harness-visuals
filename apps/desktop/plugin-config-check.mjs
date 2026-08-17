import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { executePluginMutation } from './plugin-installer.mjs'
import { dshBinPath, harnessEnvironment } from './runtime.mjs'

const execFileAsync = promisify(execFile)
const CONFIG_CHECK_TIMEOUT_MS = 30_000
const CONFIG_CHECK_OUTPUT_BYTES = 4 * 1024 * 1024

function commandFailureDetail(error) {
  const outputs = [error?.stderr, error?.stdout]
    .filter(value => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim())
  const detail = [...new Set(outputs)].join('\n') || (error instanceof Error ? error.message : String(error))
  return detail.length > 12_000 ? detail.slice(-12_000) : detail
}

/** Validate the Web profile with the official DSH config composer, without starting Harness. */
export async function verifyProfileConfig(options, { signal, exec = execFileAsync } = {}) {
  const binPath = dshBinPath(options.runtimeRoot)
  try {
    await exec(options.nodePath, [binPath, '--profile', 'web', '--dump-config'], {
      cwd: options.workingDirectory ?? dirname(binPath),
      env: harnessEnvironment(process.env, options.dshHome),
      maxBuffer: CONFIG_CHECK_OUTPUT_BYTES,
      timeout: CONFIG_CHECK_TIMEOUT_MS,
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new Error(`Plugin package operation completed, but dsh --profile web --dump-config failed:\n${commandFailureDetail(error)}`)
  }
}

/** Keep Desktop as a thin wrapper around the official plugin command plus official config validation. */
export function createConfigCheckedPluginExecutor({
  mutate = executePluginMutation,
  verify = verifyProfileConfig,
} = {}) {
  return async function executeConfigCheckedPluginMutation(options, request, context = {}) {
    const result = await mutate(options, request, context)
    if (result?.approvalRequired !== undefined || result?.restartRequired !== true) return result

    context.onProgress?.({
      stage: 'verifying-config',
      message: 'Validating the Web profile with dsh --profile web --dump-config.',
    })
    await verify(options, { signal: context.signal })
    return { ...result, configVerified: true }
  }
}

export const executeConfigCheckedPluginMutation = createConfigCheckedPluginExecutor()
