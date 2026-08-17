const { access, readdir, readFile } = require('node:fs/promises')
const { createRequire } = require('node:module')
const path = require('node:path')
const runtimeOverlays = require('../runtime-overlays.cjs')

async function directoryContainsMarker(root, marker) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const filePath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (await directoryContainsMarker(filePath, marker)) return true
      continue
    }
    if (!entry.isFile() || !/\.(?:js|css|json)$/iu.test(entry.name)) continue
    const content = await readFile(filePath, 'utf8')
    if (content.includes(marker)) return true
  }
  return false
}

module.exports = async function verifyPackagedRuntime(context) {
  const runtimeRoot = path.join(context.appOutDir, 'resources', 'runtime')
  const entry = path.join(
    runtimeRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  )

  try {
    await access(entry)
  } catch {
    throw new Error(`Packaged Harness runtime entry is missing: ${entry}`)
  }

  const pnpmEntry = path.join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  const pnpmLauncher = path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  try {
    await access(pnpmEntry)
    await access(pnpmLauncher)
  } catch {
    throw new Error(`Packaged plugin package-manager runtime is incomplete: ${pnpmEntry}`)
  }

  const runtimePackage = path.join(runtimeRoot, 'package.json')
  const runtimeRequire = createRequire(runtimePackage)
  const webAppPackage = runtimeRequire.resolve('@deepseek-ai/dsh-web-app/package.json')
  const webRequire = createRequire(webAppPackage)
  const frontendPackage = webRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')
  await access(path.join(path.dirname(frontendPackage), 'dist', 'index.html'))

  for (const overlay of runtimeOverlays) {
    const packageRoot = path.join(runtimeRoot, 'node_modules', ...overlay.name.split('/'))
    const libRoot = path.join(packageRoot, 'lib')
    await access(path.join(packageRoot, 'package.json'))
    await access(libRoot)
    for (const marker of overlay.markers) {
      if (!await directoryContainsMarker(libRoot, marker)) {
        throw new Error(`Packaged runtime lost ${overlay.name} feature marker: ${marker}`)
      }
    }
  }
}
