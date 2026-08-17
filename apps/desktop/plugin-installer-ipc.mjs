import { app, ipcMain } from 'electron'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { createPluginInstallerService } from './plugin-installer.mjs'
import { checkNodeRuntime } from './runtime.mjs'

const runtimeRoot = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(import.meta.dirname, 'runtime')
const nodePath = process.env.DSH_DESKTOP_NODE ?? (process.platform === 'win32' ? 'node.exe' : 'node')
const packageBin = join(runtimeRoot, 'bin')
const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
const inheritedPath = process.env[pathKey] ?? ''
const pathParts = inheritedPath.split(delimiter).filter(Boolean)
if (!pathParts.includes(packageBin)) process.env[pathKey] = [packageBin, ...pathParts].join(delimiter)
process.env.DSH_DESKTOP_NODE = nodePath

function installerOptions() {
  return {
    nodePath,
    dshHome: join(app.getPath('userData'), 'harness-data'),
    runtimeRoot,
    workingDirectory: app.getPath('documents'),
  }
}

async function packageRuntimeEnvironment() {
  const nodeVersion = await checkNodeRuntime(nodePath)
  await access(join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'))
  await access(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  return {
    nodeVersion,
    pnpmAvailable: true,
    profile: 'web',
    pnpmMode: 'packaged',
  }
}

const installer = createPluginInstallerService(installerOptions)

ipcMain.handle('desktop:plugin-marketplace-job-environment', () => packageRuntimeEnvironment())
ipcMain.handle('desktop:plugin-marketplace-job-start', (_event, request) => installer.start(request))
ipcMain.handle('desktop:plugin-marketplace-job-status', () => installer.status())
ipcMain.handle('desktop:plugin-marketplace-job-approve', (_event, id) => installer.approve(id))
ipcMain.handle('desktop:plugin-marketplace-job-cancel', (_event, id) => installer.cancel(id))

export async function shutdownPluginInstaller() {
  await installer.shutdown()
}

app.on('before-quit', () => {
  installer.cancelActive()
})
