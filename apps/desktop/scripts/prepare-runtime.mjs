import { cp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(desktopRoot, '..', '..')
const runtimeRoot = resolve(desktopRoot, 'runtime')
const frontendDist = resolve(repositoryRoot, 'apps', 'web', 'dist')
const runtimeRequire = createRequire(resolve(runtimeRoot, 'package.json'))
const webAppPackage = runtimeRequire.resolve('@deepseek-ai/dsh-web-app/package.json')
const webRequire = createRequire(webAppPackage)
const frontendPackage = webRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')
const packagedFrontendDist = resolve(dirname(frontendPackage), 'dist')

const localRuntimePackages = [
  {
    name: '@deepseek-ai/dsh-host-apiproxy',
    source: resolve(repositoryRoot, 'packages', 'host', 'apiproxy', 'lib'),
  },
]

function runtimePath(...parts) {
  const path = resolve(runtimeRoot, ...parts)
  const tail = relative(runtimeRoot, path)
  if (tail === '..' || tail.startsWith(`..${sep}`) || tail.length === 0) {
    throw new Error(`Refusing to write outside the desktop runtime: ${path}`)
  }
  return path
}

if (!packagedFrontendDist.startsWith(`${runtimeRoot}\\`)) {
  throw new Error('Refusing to replace a frontend outside the desktop runtime.')
}
await rm(packagedFrontendDist, { recursive: true, force: true })
await cp(frontendDist, packagedFrontendDist, { recursive: true })

for (const entry of localRuntimePackages) {
  const target = runtimePath('node_modules', ...entry.name.split('/'), 'lib')
  await rm(target, { recursive: true, force: true })
  await cp(entry.source, target, { recursive: true })
}
