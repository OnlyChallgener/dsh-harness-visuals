import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('desktop can isolate marketplace smoke tests from the real user profile', async () => {
  const loader = await readFile(new URL('../main-loader.mjs', import.meta.url), 'utf8')
  assert.match(loader, /DSH_DESKTOP_USER_DATA_OVERRIDE/)
  assert.match(loader, /app\.setPath\('userData'/)
  assert.match(loader, /await import\('\.\/plugin-installer-ipc\.mjs'\)/)
  assert.match(loader, /await import\('\.\/main\.mjs'\)/)
})

test('renderer exposes no legacy direct marketplace mutation bridge', async () => {
  const preload = await readFile(new URL('../preload.cjs', import.meta.url), 'utf8')
  assert.doesNotMatch(preload, /pluginMarketplaceInstall:/)
  assert.doesNotMatch(preload, /pluginMarketplaceRemove:/)
  assert.match(preload, /pluginMarketplaceJobStart:/)
  assert.match(preload, /pluginMarketplaceJobStatus:/)
})
