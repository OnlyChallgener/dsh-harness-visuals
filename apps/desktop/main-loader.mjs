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

await import('./plugin-installer-ipc.mjs')
await import('./main.mjs')
