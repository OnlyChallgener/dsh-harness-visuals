import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  exactRegistryPluginVersion,
  pluginSpec,
  readInstalledPluginVersion,
  verifyExactPluginInstall,
} from '../plugin-marketplace.mjs'

test('recognizes exact registry versions used by marketplace updates', () => {
  assert.deepEqual(exactRegistryPluginVersion('plugin@1.2.3'), {
    name: 'plugin',
    version: '1.2.3',
  })
  assert.deepEqual(exactRegistryPluginVersion('@scope/plugin@2.0.0-beta.1+build.7'), {
    name: '@scope/plugin',
    version: '2.0.0-beta.1+build.7',
  })
  assert.equal(pluginSpec('plugin@1.2.3+build.7'), 'plugin@1.2.3+build.7')
  assert.equal(exactRegistryPluginVersion('plugin@latest'), undefined)
  assert.equal(exactRegistryPluginVersion('github:owner/plugin#main'), undefined)
})

test('verifies the exact plugin version that actually landed on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-version-'))
  const packageRoot = join(root, 'profiles', 'web', 'node_modules', '@scope', 'plugin')
  await mkdir(packageRoot, { recursive: true })
  try {
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@scope/plugin',
      version: '2.3.4',
    }, null, 2))

    assert.equal(await readInstalledPluginVersion(root, '@scope/plugin'), '2.3.4')
    assert.deepEqual(await verifyExactPluginInstall(root, '@scope/plugin@2.3.4'), {
      name: '@scope/plugin',
      version: '2.3.4',
      installedVersion: '2.3.4',
    })
    await assert.rejects(
      verifyExactPluginInstall(root, '@scope/plugin@2.3.5'),
      /expected 2\.3\.5, found 2\.3\.4/,
    )
    await assert.rejects(
      verifyExactPluginInstall(root, 'missing-plugin@1.0.0'),
      /installed package is missing after pnpm completed/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
