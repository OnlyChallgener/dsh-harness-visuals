import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createConfigCheckedPluginExecutor,
  verifyProfileConfig,
} from '../plugin-config-check.mjs'

test('runs the official dump-config command for the Web profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-config-check-'))
  const runtimeRoot = join(root, 'runtime')
  await mkdir(join(runtimeRoot, 'lib'), { recursive: true })
  await writeFile(join(runtimeRoot, 'lib', 'bin.js'), '', 'utf8')

  try {
    let invocation
    await verifyProfileConfig({
      nodePath: 'node-test',
      dshHome: join(root, 'home'),
      runtimeRoot,
      workingDirectory: root,
    }, {
      exec: async (command, args, options) => {
        invocation = { command, args, options }
        return { stdout: '', stderr: '' }
      },
    })

    assert.equal(invocation.command, 'node-test')
    assert.deepEqual(invocation.args, [join(runtimeRoot, 'lib', 'bin.js'), '--profile', 'web', '--dump-config'])
    assert.equal(invocation.options.env.DSH_HOME, join(root, 'home'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('checks config only after a successful package mutation', async () => {
  let verified = 0
  const execute = createConfigCheckedPluginExecutor({
    mutate: async () => ({ installed: 'demo@1.0.0', restartRequired: true }),
    verify: async () => { verified += 1 },
  })

  const result = await execute({}, { spec: 'demo@1.0.0', mode: 'install' }, {})
  assert.equal(verified, 1)
  assert.equal(result.configVerified, true)
})

test('does not run dump-config while build approval is pending', async () => {
  let verified = 0
  const execute = createConfigCheckedPluginExecutor({
    mutate: async () => ({
      restartRequired: false,
      approvalRequired: { kind: 'build-scripts', packages: ['native-addon'] },
    }),
    verify: async () => { verified += 1 },
  })

  const result = await execute({}, { spec: 'demo@1.0.0', mode: 'install' }, {})
  assert.equal(verified, 0)
  assert.equal(result.restartRequired, false)
})
