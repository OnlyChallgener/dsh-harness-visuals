import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { createPluginInstallerService } from './plugin-installer.mjs'

function installerOptions() {
  return {
    nodePath: process.env.DSH_DESKTOP_NODE ?? (process.platform === 'win32' ? 'node.exe' : 'node'),
    dshHome: join(app.getPath('userData'), 'harness-data'),
    runtimeRoot: app.isPackaged ? join(process.resourcesPath, 'runtime') : join(import.meta.dirname, 'runtime'),
    workingDirectory: app.getPath('documents'),
  }
}

const installer = createPluginInstallerService(installerOptions)

ipcMain.handle('desktop:plugin-marketplace-job-start', (_event, request) => installer.start(request))
ipcMain.handle('desktop:plugin-marketplace-job-status', () => installer.status())
ipcMain.handle('desktop:plugin-marketplace-job-approve', (_event, id) => installer.approve(id))
ipcMain.handle('desktop:plugin-marketplace-job-cancel', (_event, id) => installer.cancel(id))

app.on('before-quit', () => {
  installer.cancelActive()
})
