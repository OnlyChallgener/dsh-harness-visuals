import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  normalizeAllowBuildsDocument,
  repairProfileAllowBuilds,
} from '../plugin-marketplace.mjs'

test('replaces pnpm 11 allowBuilds placeholders instead of duplicating keys', () => {
  const source = [
    'packages: []',
    'allowBuilds:',
    '  cloudflared: set this to true or false',
    '  cpu-features: set this to true or false',
    '  ssh2: set this to true or false',
    '',
  ].join('\n')

  const next = normalizeAllowBuildsDocument(source, ['cloudflared', 'cpu-features', 'ssh2'])

  for (const name of ['cloudflared', 'cpu-features', 'ssh2']) {
    assert.equal((next.match(new RegExp(`^\\s+${name}:`, 'gmu')) ?? []).length, 1)
    assert.match(next, new RegExp(`^\\s+${name}: true$`, 'mu'))
  }
  assert.doesNotMatch(next, /set this to true or false/u)
})

test('repairs duplicate allowBuilds keys before pnpm reads the profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-workspace-repair-'))
  const profileDir = join(root, 'profiles', 'web')
  const workspaceFile = join(profileDir, 'pnpm-workspace.yaml')
  await mkdir(profileDir, { recursive: true })
  try {
    await writeFile(workspaceFile, [
      'packages: []',
      'minimumReleaseAge: 1440',
      'allowBuilds:',
      '  cloudflared: set this to true or false',
      '  cloudflared: true',
      '  ssh2: false',
      '  ssh2: true',
      'trustPolicy: no-downgrade',
      '',
    ].join('\n'), 'utf8')

    assert.equal(await repairProfileAllowBuilds(root), true)
    const repaired = await readFile(workspaceFile, 'utf8')
    assert.equal((repaired.match(/^\s+cloudflared:/gmu) ?? []).length, 1)
    assert.match(repaired, /^\s+cloudflared: true$/mu)
    assert.equal((repaired.match(/^\s+ssh2:/gmu) ?? []).length, 1)
    assert.match(repaired, /^\s+ssh2: false$/mu)
    assert.match(repaired, /^minimumReleaseAge: 1440$/mu)
    assert.match(repaired, /^trustPolicy: no-downgrade$/mu)
    assert.equal(await repairProfileAllowBuilds(root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
