import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { writeWindowsClipboardText } from '../clipboard.mjs'
import {
  classifyMarketplacePnpmFailure,
  managedPnpmShimContent,
  mergeAllowBuildsDocument,
  parseBlockedBuildPackages,
  parsePluginList,
  pluginPackageName,
  pluginSpec,
  readProfileDependencySnapshot,
  restoreProfileDependencySnapshot,
} from '../plugin-marketplace.mjs'
import {
  harnessEnvironment,
  isSupportedNodeVersion,
  nodeVersionFromOutput,
  selectHarnessPort,
  webUrlFromOutput,
} from '../runtime.mjs'

const desktopPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('reads the local URL from Harness startup output', () => {
  assert.equal(webUrlFromOutput('dsh web: http://127.0.0.1:41235\n'), 'http://127.0.0.1:41235')
})

test('announces the ready URL over the dedicated desktop IPC channel', async () => {
  const launcherPath = fileURLToPath(new URL('../runtime-launcher.cjs', import.meta.url))
  const fixturePath = fileURLToPath(new URL('./fixtures/ready-bin.cjs', import.meta.url))
  const child = fork(launcherPath, [fixturePath], { silent: true })
  const [message] = await once(child, 'message')
  assert.deepEqual(message, { type: 'ready', url: 'http://127.0.0.1:43125' })
  await once(child, 'exit')
})

test('does not accept a non-local startup URL', () => {
  assert.equal(webUrlFromOutput('dsh web: http://localhost:3080\n'), undefined)
})

test('prefers the first available stable Harness port and falls back to ephemeral', async () => {
  const checked = []
  const selected = await selectHarnessPort({
    candidates: [3080, 3081, 3082],
    probe: async port => {
      checked.push(port)
      return port === 3082
    },
  })
  assert.equal(selected, 3082)
  assert.deepEqual(checked, [3080, 3081, 3082])
  assert.equal(await selectHarnessPort({
    candidates: [3080, 3081],
    probe: async () => false,
  }), 0)
})

test('parses and validates the supported Node.js runtime range', () => {
  assert.deepEqual(nodeVersionFromOutput('v24.18.1\n'), { major: 24, minor: 18, patch: 1 })
  assert.equal(isSupportedNodeVersion({ major: 22, minor: 18, patch: 0 }), false)
  assert.equal(isSupportedNodeVersion({ major: 22, minor: 19, patch: 0 }), true)
  assert.equal(isSupportedNodeVersion({ major: 23, minor: 0, patch: 0 }), false)
  assert.equal(isSupportedNodeVersion({ major: 24, minor: 0, patch: 0 }), true)
  assert.equal(nodeVersionFromOutput('node unknown'), undefined)
})

test('passes Harness settings without leaking unrelated secrets', () => {
  const environment = harnessEnvironment({
    PATH: 'C:\\Windows',
    DEEPSEEK_API_KEY: 'key',
    DSH_TOOLS_MODE: 'code',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    GITHUB_TOKEN: 'secret',
  }, 'C:\\Harness')
  assert.deepEqual(environment, {
    PATH: 'C:\\Windows',
    DEEPSEEK_API_KEY: 'key',
    DSH_TOOLS_MODE: 'code',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    DSH_HOME: 'C:\\Harness',
    ELECTRON_RUN_AS_NODE: '1',
  })
})

test('validates marketplace package specs without exposing pnpm or shell syntax', () => {
  assert.equal(pluginSpec('@scope/plugin@1.2.3'), '@scope/plugin@1.2.3')
  assert.equal(pluginSpec('github:owner/plugin'), 'github:owner/plugin')
  assert.equal(pluginPackageName('@scope/plugin'), '@scope/plugin')
  assert.throws(() => pluginSpec('--global'), /npm package\/version or github:/)
  assert.throws(() => pluginSpec('plugin\nremove other'), /npm package\/version or github:/)
  assert.throws(() => pluginSpec('plugin&calc'), /npm package\/version or github:/)
  assert.throws(() => pluginSpec('file:..\\plugin'), /npm package\/version or github:/)
  assert.throws(() => pluginPackageName('plugin@1.2.3'), /package name is invalid/)
})

test('managed pnpm fallback is pinned and never installs globally', () => {
  const windows = managedPnpmShimContent('win32')
  const posix = managedPnpmShimContent('linux')
  assert.match(windows, /--package=pnpm@11\.7\.0/)
  assert.match(posix, /--package=pnpm@11\.7\.0/)
  assert.doesNotMatch(windows, /install\s+-g|--global|@latest/)
  assert.doesNotMatch(posix, /install\s+-g|--global|@latest/)
})

test('classifies pnpm safety failures without disabling the safety policy globally', () => {
  assert.deepEqual(classifyMarketplacePnpmFailure('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION'), { kind: 'release-age' })
  assert.deepEqual(classifyMarketplacePnpmFailure('ERR_PNPM_NO_MATURE_MATCHING_VERSION'), { kind: 'release-age' })
  assert.deepEqual(classifyMarketplacePnpmFailure('ERR_PNPM_META_FETCH_FAIL ETIMEDOUT'), { kind: 'transient-network' })
  assert.deepEqual(classifyMarketplacePnpmFailure('ordinary failure'), { kind: 'other' })
})

test('extracts only exact packages whose build scripts pnpm blocked', () => {
  const output = `ERR_PNPM_IGNORED_BUILDS\nIgnored build scripts: cloudflared@0.7.3, cpu-features@0.0.10, @scope/native-addon@2.4.1, ssh2@1.17.0.\nRun "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.`
  assert.deepEqual(parseBlockedBuildPackages(output), [
    '@scope/native-addon',
    'cloudflared',
    'cpu-features',
    'ssh2',
  ])
  assert.deepEqual(parseBlockedBuildPackages('git-hosted package "@scope/plugin@2.8.0" needs to execute build scripts'), ['@scope/plugin'])
})

test('merges approved build packages into the profile allowBuilds block without widening other entries', () => {
  const before = `packages:\n  - .\nallowBuilds:\n  esbuild: true\n  risky-addon: false\nminimumReleaseAge: 1440\n`
  const after = mergeAllowBuildsDocument(before, ['risky-addon', 'ssh2'])
  assert.match(after, /allowBuilds:\n  esbuild: true\n  risky-addon: true\n  ssh2: true\nminimumReleaseAge:/)
  assert.match(after, /minimumReleaseAge: 1440/)
  assert.doesNotMatch(after, /approve-builds|minimumReleaseAge:\s*0/)
})

test('rolls back only failed marketplace dependency edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-rollback-'))
  const profileDir = join(root, 'profiles', 'web')
  const manifestFile = join(profileDir, 'package.json')
  await mkdir(profileDir, { recursive: true })
  try {
    await writeFile(manifestFile, JSON.stringify({
      name: 'web-profile',
      dependencies: { existing: '1.0.0' },
      dsh: { profile: { bundles: ['existing'] } },
      custom: { keep: true },
    }, null, 2))
    const before = await readProfileDependencySnapshot(root)
    assert.deepEqual(before, { existing: '1.0.0' })

    await writeFile(manifestFile, JSON.stringify({
      name: 'web-profile',
      dependencies: { existing: '2.0.0', ghost: '9.9.9' },
      dsh: { profile: { bundles: ['existing'] } },
      custom: { keep: true },
    }, null, 2))
    assert.deepEqual(await restoreProfileDependencySnapshot(root, before), ['existing', 'ghost'])

    const restored = JSON.parse(await readFile(manifestFile, 'utf8'))
    assert.deepEqual(restored.dependencies, { existing: '1.0.0' })
    assert.deepEqual(restored.dsh.profile.bundles, ['existing'])
    assert.deepEqual(restored.custom, { keep: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('normalizes pnpm plugin-list output to stable marketplace rows', () => {
  assert.deepEqual(parsePluginList(JSON.stringify([{
    dependencies: {
      'z-plugin': { version: '2.0.0', path: 'C:/profile/node_modules/z-plugin' },
      '@scope/a-plugin': { version: '1.0.0' },
    },
  }])), [
    { name: '@scope/a-plugin', version: '1.0.0' },
    { name: 'z-plugin', version: '2.0.0', path: 'C:/profile/node_modules/z-plugin' },
  ])
})

test('packages the embedded runtime dependencies and verifies their entry point', () => {
  const runtimeRoot = desktopPackage.build.extraResources.find(resource => resource.from === 'runtime')
  const runtimeModules = desktopPackage.build.extraResources.find(resource => resource.from === 'runtime/node_modules')

  assert.equal(runtimeRoot?.to, 'runtime')
  assert.deepEqual(runtimeRoot?.filter, ['package.json', 'package-lock.json'])
  assert.equal(runtimeModules?.to, 'runtime/node_modules')
  assert.ok(runtimeModules?.filter.includes('**/*'))
  assert.equal(desktopPackage.build.afterPack, 'scripts/verify-packaged-runtime.cjs')
  assert.equal(desktopPackage.build.compression, 'normal')
  assert.equal(desktopPackage.build.nsis.useZip, true)
  assert.equal(desktopPackage.build.nsis.differentialPackage, false)
})

test('writes clipboard text through clip.exe standard input', async () => {
  let executable
  let spawnOptions
  let written = Buffer.alloc(0)
  const child = new EventEmitter()
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      written = Buffer.concat([written, chunk])
      callback()
    },
    final(callback) {
      queueMicrotask(() => { child.emit('close', 0, null) })
      callback()
    },
  })
  const spawnProcess = (file, _args, options) => {
    executable = file
    spawnOptions = options
    return child
  }

  assert.equal(await writeWindowsClipboardText('复制文字', {
    spawnProcess,
    systemRoot: 'C:\\Windows',
  }), true)
  assert.equal(executable, 'C:\\Windows\\System32\\clip.exe')
  assert.deepEqual(spawnOptions, {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 5_000,
  })
  assert.equal(written.toString('utf16le'), '复制文字')
})

test('reports a failed clipboard utility exit', async () => {
  const child = new EventEmitter()
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
    final(callback) {
      queueMicrotask(() => { child.emit('close', 1, null) })
      callback()
    },
  })
  const spawnProcess = () => child

  assert.equal(await writeWindowsClipboardText('payload', { spawnProcess }), false)
})
