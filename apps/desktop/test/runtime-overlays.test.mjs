import assert from 'node:assert/strict'
import test from 'node:test'
import runtimeOverlays from '../runtime-overlays.cjs'

const expectedPackages = [
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-host-apiproxy',
  '@deepseek-ai/dsh-tool-cordis',
]

test('runtime overlay manifest covers every package customized by this fork', () => {
  const actual = runtimeOverlays.map(entry => entry.name).sort()
  assert.deepEqual(actual, expectedPackages)
  assert.equal(new Set(actual).size, actual.length)
})

test('visible Desktop features have final-package marker guards', () => {
  const byName = new Map(runtimeOverlays.map(entry => [entry.name, entry]))
  assert.ok(byName.get('@deepseek-ai/dsh-client-ui-theme')?.markers.includes('appearance.wallpaper'))
  assert.ok(byName.get('@deepseek-ai/dsh-client-ui-theme')?.markers.includes('data-dsh-local-wallpaper'))
  assert.ok(byName.get('@deepseek-ai/dsh-client-ui-layout')?.markers.includes('--dsh-wallpaper-image'))
  assert.ok(byName.get('@deepseek-ai/dsh-client-ui-layout')?.markers.includes('data-dsh-local-wallpaper'))
  assert.ok(byName.get('@deepseek-ai/dsh-client-ui-settings-plugin-inventory')?.markers.includes('marketplaceTitle'))
  assert.ok(byName.get('@deepseek-ai/dsh-client-ui-agent-preset')?.markers.includes('change applies from the next turn'))
})
