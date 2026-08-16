import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import {
  createPluginInstallerService,
  rewriteAllowBuildsDocument,
} from '../plugin-installer.mjs'

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await delay(5)
  }
  throw new Error('timed out waiting for installer state')
}

test('desktop boots through the installer-aware main loader', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.main, 'main-loader.mjs')
  assert.ok(pkg.build.files.includes('*.mjs'))
})

test('repairs pnpm allowBuilds placeholders and quotes scoped package keys', () => {
  const before = [
    'packages:',
    '  - .',
    'allowBuilds:',
    '  ssh2: set this to true or false',
    '  ssh2: true',
    "  '@scope/native-addon': false",
    'minimumReleaseAge: 1440',
    '',
  ].join('\n')
  const after = rewriteAllowBuildsDocument(before, ['@scope/native-addon', 'cpu-features'])
  assert.match(after, /allowBuilds:\n  '@scope\/native-addon': true\n  cpu-features: true\n  ssh2: true\nminimumReleaseAge: 1440/)
  assert.doesNotMatch(after, /set this to true or false/)
  assert.equal((after.match(/ssh2:/g) ?? []).length, 1)
})

test('host-owned plugin job survives callers and resumes the same approval job', async () => {
  let calls = 0
  let approved = []
  const service = createPluginInstallerService(() => ({ test: true }), {
    executor: async (_options, request, context) => {
      calls += 1
      context.onProgress?.({ stage: 'installing', message: `working ${request.spec}` })
      if (calls === 1) {
        return {
          restartRequired: false,
          approvalRequired: { kind: 'build-scripts', packages: ['ssh2'] },
        }
      }
      approved = [...context.approvedPackages]
      return { restartRequired: true, installed: request.spec, installedNames: ['fixture-plugin'] }
    },
  })

  const started = service.start({ spec: 'fixture-plugin', mode: 'install' })
  assert.equal(service.start({ spec: 'fixture-plugin', mode: 'install' }).id, started.id)
  await waitFor(() => service.status()?.state === 'approval-required')
  assert.deepEqual(service.status()?.approvalRequired?.packages, ['ssh2'])

  service.approve(started.id)
  await waitFor(() => service.status()?.state === 'succeeded')
  assert.deepEqual(approved, ['ssh2'])
  assert.equal(service.status()?.result?.restartRequired, true)
})

test('cancels the Host job through its AbortSignal instead of tying it to a Settings component', async () => {
  const service = createPluginInstallerService(() => ({}), {
    executor: async (_options, _request, context) => await new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }),
  })
  const job = service.start({ spec: 'fixture-plugin', mode: 'install' })
  assert.equal(service.status()?.state, 'running')
  service.cancel(job.id)
  await waitFor(() => service.status()?.state === 'cancelled')
})
