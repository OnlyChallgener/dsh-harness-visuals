import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { app } from 'electron'

// Test/dev-only isolation hook: when set explicitly, the Desktop uses a
// separate Electron userData tree, so marketplace smoke tests cannot touch
// the user's real Harness profile or installed plugins.
const userDataOverride = process.env.DSH_DESKTOP_USER_DATA_OVERRIDE?.trim()
if (userDataOverride) {
  const isolatedUserData = resolve(userDataOverride)
  mkdirSync(isolatedUserData, { recursive: true })
  app.setPath('userData', isolatedUserData)
}

// A malformed optional machine-wide patch must not brick the whole Desktop.
// Validate it through DSH's own parser and preserve the invalid file before
// the Harness process is launched; valid user patches are never touched.
const { quarantineInvalidHomePatch } = await import('./startup-profile-guard.mjs')
await quarantineInvalidHomePatch()

await import('./plugin-installer-ipc.mjs')
await import('./main.mjs')
