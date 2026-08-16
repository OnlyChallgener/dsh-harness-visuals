const { access } = require('node:fs/promises')
const { createRequire } = require('node:module')
const path = require('node:path')

module.exports = async function verifyPackagedRuntime(context) {
  const entry = path.join(
    context.appOutDir,
    'resources',
    'runtime',
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

  const runtimePackage = path.join(context.appOutDir, 'resources', 'runtime', 'package.json')
  const runtimeRequire = createRequire(runtimePackage)
  const webAppPackage = runtimeRequire.resolve('@deepseek-ai/dsh-web-app/package.json')
  const webRequire = createRequire(webAppPackage)
  const frontendPackage = webRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')
  await access(path.join(path.dirname(frontendPackage), 'dist', 'index.html'))
}
