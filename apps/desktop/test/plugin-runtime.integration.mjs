import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  runOfficialPluginCommand,
  validateInstalledPlugin,
} from '../plugin-installer.mjs'

const runtimeRoot = fileURLToPath(new URL('../runtime/', import.meta.url))
const pluginName = 'dsh-marketplace-runtime-fixture'

async function writeFixture(root, version) {
  const directory = join(root, `fixture-${version}`)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name: pluginName,
    version,
    type: 'module',
    main: './plugin.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`, 'utf8')
  await writeFile(join(directory, 'plugin.mjs'), [
    "export const name = 'marketplace-runtime-fixture'",
    'export function apply() {}',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(directory, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: marketplace-runtime-fixture',
    '      name: ./plugin.mjs',
    '',
  ].join('\n'), 'utf8')
  return directory
}

async function profileManifest(dshHome) {
  return JSON.parse(await readFile(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'))
}

async function installedVersion(dshHome) {
  const manifest = JSON.parse(await readFile(
    join(dshHome, 'profiles', 'web', 'node_modules', pluginName, 'package.json'),
    'utf8',
  ))
  return manifest.version
}

test('packaged Desktop runtime installs, updates and removes through official dsh plugin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-plugin-runtime-'))
  const dshHome = join(root, 'home')
  const profileDir = join(dshHome, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web-integration',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2)}\n`, 'utf8')
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')

  const v1 = await writeFixture(root, '1.0.0')
  const v2 = await writeFixture(root, '1.1.0')
  const options = {
    nodePath: process.execPath,
    dshHome,
    runtimeRoot,
    workingDirectory: root,
  }

  try {
    await runOfficialPluginCommand(options, ['add', v1])
    assert.equal(await installedVersion(dshHome), '1.0.0')
    assert.deepEqual(await validateInstalledPlugin(dshHome, pluginName), {
      name: pluginName,
      kind: 'bundle',
    })
    let manifest = await profileManifest(dshHome)
    assert.equal(typeof manifest.dependencies?.[pluginName], 'string')
    assert.ok(manifest.dsh?.profile?.bundles?.includes(pluginName))

    await runOfficialPluginCommand(options, ['add', v2])
    assert.equal(await installedVersion(dshHome), '1.1.0')
    manifest = await profileManifest(dshHome)
    assert.ok(manifest.dsh?.profile?.bundles?.includes(pluginName))

    await runOfficialPluginCommand(options, ['remove', pluginName])
    manifest = await profileManifest(dshHome)
    assert.equal(manifest.dependencies?.[pluginName], undefined)
    assert.equal(manifest.dsh?.profile?.bundles?.includes(pluginName), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
