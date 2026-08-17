import { access, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'

function recoverablePatchError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /failed to parse patches|must be a top-level YAML array of loader patch entries|patches entry \d+ .* must be a mapping/iu.test(message)
}

function backupSuffix() {
  return new Date().toISOString().replace(/[:.]/gu, '-').replace('T', '_').replace('Z', '')
}

/**
 * Desktop recovery boundary for the optional machine-wide user patch.
 *
 * Upstream DSH intentionally fails loud when a present $DSH_HOME/cordis.patch.yml
 * is malformed. In Desktop that otherwise bricks every profile and every
 * installed plugin. Validate with DSH's own parser, preserve the malformed
 * file verbatim beside the original, and let DSH boot without that unusable
 * layer. Valid patches are never touched.
 */
export async function quarantineInvalidHomePatch() {
  const runtimeRoot = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(import.meta.dirname, 'runtime')
  const dshHome = join(app.getPath('userData'), 'harness-data')
  const patchPath = join(dshHome, 'cordis.patch.yml')
  try {
    await access(patchPath)
  } catch {
    return undefined
  }

  try {
    const runtimeRequire = createRequire(join(runtimeRoot, 'package.json'))
    const appBootEntry = runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')
    const appBoot = await import(pathToFileURL(appBootEntry).href)
    appBoot.loadOptionalPatches('dsh', patchPath)
    return undefined
  } catch (error) {
    if (!recoverablePatchError(error)) throw error
    const backupPath = `${patchPath}.invalid-${backupSuffix()}.bak`
    await rename(patchPath, backupPath)
    console.warn(`[desktop-startup] quarantined invalid home patch: ${patchPath} -> ${backupPath}`)
    return backupPath
  }
}
