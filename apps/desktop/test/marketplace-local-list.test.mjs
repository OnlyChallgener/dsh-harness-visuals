import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  listInstalledPlugins,
  readLocalInstalledPlugins,
} from '../plugin-marketplace.mjs'

test('lists installed plugins from local profile files even when pnpm workspace is broken and registry is offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-local-list-'))
  const profileDir = join(root, 'profiles', 'web')
  const pluginDir = join(profileDir, 'node_modules', '@scope', 'offline-plugin')
  await mkdir(pluginDir, { recursive: true })
  try {
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'web-profile',
      dependencies: {
        '@deepseek-ai/dsh-base': '0.1.0-rc.7',
        '@scope/offline-plugin': '^1.2.3',
        'ghost-plugin': '9.9.9',
      },
    }, null, 2), 'utf8')
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), [
      'allowBuilds:',
      '  ssh2: set this to true or false',
      '  ssh2: true',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
      name: '@scope/offline-plugin',
      version: '1.2.3',
      description: 'Available from disk without the registry',
      repository: 'https://github.com/example/offline-plugin',
      license: 'MIT',
    }, null, 2), 'utf8')

    const local = await readLocalInstalledPlugins(root)
    assert.deepEqual(local.map(plugin => ({
      name: plugin.name,
      version: plugin.version,
      sourceSpec: plugin.sourceSpec,
    })), [{
      name: '@scope/offline-plugin',
      version: '1.2.3',
      sourceSpec: '^1.2.3',
    }])

    let fetches = 0
    const listed = await listInstalledPlugins({ dshHome: root }, {
      fetchImpl: async () => {
        fetches += 1
        throw new Error('offline')
      },
    })

    assert.equal(fetches, 1)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].name, '@scope/offline-plugin')
    assert.equal(listed[0].version, '1.2.3')
    assert.equal(listed[0].description, 'Available from disk without the registry')
    assert.equal(listed[0].repository, 'https://github.com/example/offline-plugin')
    assert.equal(listed[0].updateAvailable, false)
    assert.equal(listed[0].updateStatus, 'unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
