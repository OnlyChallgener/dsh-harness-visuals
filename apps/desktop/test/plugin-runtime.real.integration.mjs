import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { executePluginMutation } from '../plugin-installer.mjs'

const desktopRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const runtimeRoot = join(desktopRoot, 'runtime')

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function optionsFor(dshHome) {
  return {
    nodePath: process.execPath,
    dshHome,
    runtimeRoot,
    workingDirectory: desktopRoot,
  }
}

test('real registry plugin installs, updates and removes through the Desktop runtime', { timeout: 10 * 60 * 1000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-real-'))
  const dshHome = join(root, 'home')
  const options = optionsFor(dshHome)
  const packageName = 'dshmarket'

  try {
    const installed = await executePluginMutation(options, {
      spec: `${packageName}@1.10.0`,
      mode: 'install',
    })
    assert.equal(installed.installedVersion, '1.10.0')

    const packageManifestPath = join(dshHome, 'profiles', 'web', 'node_modules', packageName, 'package.json')
    assert.equal((await readJson(packageManifestPath)).version, '1.10.0')

    let profile = await readJson(join(dshHome, 'profiles', 'web', 'package.json'))
    assert.ok(profile.dependencies?.[packageName])
    assert.ok(profile.dsh?.profile?.bundles?.includes(packageName))

    const updated = await executePluginMutation(options, {
      spec: `${packageName}@1.10.1`,
      mode: 'update',
    })
    assert.equal(updated.installedVersion, '1.10.1')
    assert.equal((await readJson(packageManifestPath)).version, '1.10.1')

    const removed = await executePluginMutation(options, {
      spec: packageName,
      mode: 'remove',
    })
    assert.equal(removed.removed, packageName)

    profile = await readJson(join(dshHome, 'profiles', 'web', 'package.json'))
    assert.equal(profile.dependencies?.[packageName], undefined)
    assert.equal(profile.dsh?.profile?.bundles?.includes(packageName), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
