import { access, chmod, cp, readdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import runtimeOverlays from '../runtime-overlays.cjs'

const desktopRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(desktopRoot, '..', '..')
const runtimeRoot = resolve(desktopRoot, 'runtime')
const frontendDist = resolve(repositoryRoot, 'apps', 'web', 'dist')
const runtimeRequire = createRequire(resolve(runtimeRoot, 'package.json'))
const webAppPackage = runtimeRequire.resolve('@deepseek-ai/dsh-web-app/package.json')
const webRequire = createRequire(webAppPackage)
const frontendPackage = webRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')
const packagedFrontendDist = resolve(dirname(frontendPackage), 'dist')

function runtimePath(...parts) {
  const path = resolve(runtimeRoot, ...parts)
  const tail = relative(runtimeRoot, path)
  if (tail === '..' || tail.startsWith(`..${sep}`) || tail.length === 0) {
    throw new Error(`Refusing to write outside the desktop runtime: ${path}`)
  }
  return path
}

async function directoryContainsMarker(root, marker) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) {
      if (await directoryContainsMarker(path, marker)) return true
      continue
    }
    if (!entry.isFile() || !/\.(?:js|css|json)$/iu.test(entry.name)) continue
    const content = await readFile(path, 'utf8')
    if (content.includes(marker)) return true
  }
  return false
}

async function assertMarkers(root, overlay, phase) {
  for (const marker of overlay.markers) {
    if (!await directoryContainsMarker(root, marker)) {
      throw new Error(`${phase} ${overlay.name} is missing required Desktop feature marker: ${marker}`)
    }
  }
}

if (!packagedFrontendDist.startsWith(`${runtimeRoot}\\`) && !packagedFrontendDist.startsWith(`${runtimeRoot}/`)) {
  throw new Error('Refusing to replace a frontend outside the desktop runtime.')
}
await rm(packagedFrontendDist, { recursive: true, force: true })
await cp(frontendDist, packagedFrontendDist, { recursive: true })

for (const overlay of runtimeOverlays) {
  const source = resolve(repositoryRoot, ...overlay.repoPath.split('/'), 'lib')
  const packageRoot = runtimePath('node_modules', ...overlay.name.split('/'))
  const target = resolve(packageRoot, 'lib')

  // A missing published package means the pinned runtime and this fork have
  // drifted too far for a safe overlay. Fail the build instead of silently
  // producing an installer that drops one of the fork's features.
  await access(resolve(packageRoot, 'package.json'))
  await access(source)
  await assertMarkers(source, overlay, 'Local build')

  await rm(target, { recursive: true, force: true })
  await cp(source, target, { recursive: true })
  await assertMarkers(target, overlay, 'Prepared runtime')
}

// Plugin management must use the same package-manager version on every user
// machine. `npm install --prefix runtime` installs this pinned pnpm package;
// the Desktop exposes it through runtime/bin instead of depending on a global
// pnpm/npm/corepack installation.
await access(runtimePath('node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
await access(runtimePath('bin', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'))
if (process.platform !== 'win32') await chmod(runtimePath('bin', 'pnpm'), 0o755)
