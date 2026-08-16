import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  shell,
} from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeWindowsClipboardText } from './clipboard.mjs'
import {
  checkNodeRuntime,
  runWindowsOcr,
  selectHarnessPort,
  startHarness,
  stopProcessTree,
  webUrlFromOutput,
} from './runtime.mjs'

const STARTUP_TIMEOUT_MS = 90_000
const WINDOW_STATE_FILE = 'window-state.json'
const DEFAULT_WINDOW_BOUNDS = { width: 1440, height: 920 }
const TITLE_BAR_HEIGHT = 32

let mainWindow
let tray
let harness
let webUrl
let startupError
let startupLog = ''
let startupTimer
let startupStartedAt
let quitReady = false
let startupTask
let restartTask
let saveWindowStateTimer
const expectedStops = new WeakSet()
const MAX_DESKTOP_IMAGE_BYTES = 100 * 1024 * 1024

/** Returns the path where the desktop shell stores its window state. */
function windowStatePath() {
  return join(app.getPath('userData'), WINDOW_STATE_FILE)
}

/** Creates the official whale icon used by the shell and tray. */
function createAppIcon() {
  for (const fileName of ['icon.png', 'icon.svg']) {
    try {
      const icon = nativeImage.createFromPath(join(import.meta.dirname, 'build', fileName))
      if (!icon.isEmpty()) return icon
    } catch {
      // The packaged build always contains the resource; try the next format.
    }
  }
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;charset=utf-8,'
      + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M23 5c-2 1-3 2-5 2-2-3-5-4-8-3-3 1-5 4-5 7 0 2 1 4 3 5-2 1-4 1-6 0 2 3 5 5 9 5 6 0 10-4 10-10 0-2 1-4 2-6z" fill="#4D6BFE"/></svg>'),
  )
}

/** Returns the title bar overlay palette for the current system theme. */
function titleBarOverlayOptions() {
  return {
    color: '#00000000',
    symbolColor: nativeTheme.shouldUseDarkColors ? '#F7F7F8' : '#111318',
    height: TITLE_BAR_HEIGHT,
  }
}

/** Records one bounded startup timing line without changing the launch path. */
function markStartup(stage) {
  if (startupStartedAt === undefined) return
  const elapsed = Math.max(0, Math.round(performance.now() - startupStartedAt))
  const line = `[desktop-startup] ${stage} +${elapsed}ms`
  startupLog = `${startupLog}${line}\n`.slice(-4_096)
  console.info(line)
}

/** Redacts common credential-shaped values before exposing startup diagnostics. */
function redactedStartupLog() {
  return startupLog.replace(
    /(api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu,
    '$1=[redacted]',
  )
}

/** Returns whether a normal window rectangle remains visible on a monitor. */
function isWindowStateVisible(state) {
  return screen.getAllDisplays().some(({ workArea }) => {
    const right = Math.min(workArea.x + workArea.width, state.x + state.width)
    const bottom = Math.min(workArea.y + workArea.height, state.y + state.height)
    const left = Math.max(workArea.x, state.x)
    const top = Math.max(workArea.y, state.y)
    return right - left >= 64 && bottom - top >= 64
  })
}

/** Reads and validates the last normal window rectangle. */
function readWindowState() {
  const fallback = { ...DEFAULT_WINDOW_BOUNDS, maximized: false }
  try {
    const parsed = JSON.parse(readFileSync(windowStatePath(), 'utf8'))
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)
      || !Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)
      || parsed.width < 1024 || parsed.height < 680) return fallback
    const state = {
      x: Math.round(parsed.x),
      y: Math.round(parsed.y),
      width: Math.round(parsed.width),
      height: Math.round(parsed.height),
      maximized: parsed.maximized === true,
    }
    return isWindowStateVisible(state) ? state : fallback
  } catch {
    return fallback
  }
}

/** Persists the normal bounds atomically so a crash cannot leave a partial JSON file. */
function saveWindowState() {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  const bounds = mainWindow.getNormalBounds()
  const state = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: mainWindow.isMaximized(),
  }
  try {
    const path = windowStatePath()
    const temporaryPath = `${path}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(state), 'utf8')
    renameSync(temporaryPath, path)
  } catch {
    // Window state is a convenience; failure must never block shutdown.
  }
}

/** Coalesces bounds writes while the user is dragging or resizing the window. */
function scheduleWindowStateSave() {
  clearTimeout(saveWindowStateTimer)
  saveWindowStateTimer = setTimeout(() => {
    saveWindowStateTimer = undefined
    saveWindowState()
  }, 250)
}

/** Opens or restores the main application window. */
function showMainWindow() {
  if (mainWindow === undefined) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Stops the managed web server and waits for its bounded shutdown attempt. */
async function stopHarness() {
  const running = harness
  harness = undefined
  webUrl = undefined
  clearTimeout(startupTimer)
  if (running === undefined) return
  expectedStops.add(running)
  await stopProcessTree(running)
}

/** Shows a startup error after the local process has stopped. */
function showStartupError(message) {
  startupError = message
  void mainWindow?.loadFile('error.html')
}

/** Starts the web server and loads it when it announces its local URL. */
async function bootHarnessImpl() {
  startupError = undefined
  startupLog = ''
  startupStartedAt = performance.now()
  markStartup('boot')
  const nodePath = process.env.DSH_DESKTOP_NODE ?? (process.platform === 'win32' ? 'node.exe' : 'node')
  let nodeVersion
  try {
    nodeVersion = await checkNodeRuntime(nodePath)
    markStartup(`node-ready ${nodeVersion}`)
  } catch (error) {
    showStartupError(error instanceof Error ? error.message : String(error))
    return
  }
  const port = await selectHarnessPort()
  markStartup(`port-selected ${port === 0 ? 'ephemeral' : String(port)}`)
  let started
  const acceptReadyUrl = (announcedUrl) => {
    if (webUrl !== undefined || announcedUrl === undefined) return
    clearTimeout(startupTimer)
    webUrl = announcedUrl
    markStartup(`host-ready ${announcedUrl}`)
    const loadTask = mainWindow?.loadURL(webUrl)
    if (loadTask !== undefined) {
      void loadTask.then(() => { markStartup('web-ui-ready') }, () => { markStartup('web-ui-load-failed') })
    }
  }
  try {
    started = startHarness({
      nodePath,
      dshHome: join(app.getPath('userData'), 'harness-data'),
      runtimeRoot: app.isPackaged ? join(process.resourcesPath, 'runtime') : join(import.meta.dirname, 'runtime'),
      launcherPath: app.isPackaged
        ? join(process.resourcesPath, 'runtime-launcher.cjs')
        : join(import.meta.dirname, 'runtime-launcher.cjs'),
      workingDirectory: app.getPath('documents'),
      port,
      onOutput(output) {
        startupLog = `${startupLog}${output}`.slice(-4_096)
        acceptReadyUrl(webUrlFromOutput(startupLog))
      },
      onReady: acceptReadyUrl,
      onExit(code, signal) {
        clearTimeout(startupTimer)
        if (expectedStops.has(started) || app.isQuitting || code === 0 || signal === 'SIGTERM') return
        if (harness === started) {
          harness = undefined
          webUrl = undefined
        }
        showStartupError(`Harness exited unexpectedly (code: ${code ?? 'none'}).`)
      },
      onError(error) {
        clearTimeout(startupTimer)
        if (harness === started) {
          harness = undefined
          webUrl = undefined
        }
        showStartupError(`Node.js could not start Harness: ${error.message}`)
      },
    })
    markStartup('process-spawned')
  } catch (error) {
    showStartupError(`Harness runtime could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  harness = started
  startupTimer = setTimeout(() => {
    if (webUrl !== undefined || harness !== started) return
    expectedStops.add(started)
    void stopProcessTree(started)
    showStartupError('Harness did not become ready within 90 seconds.')
  }, STARTUP_TIMEOUT_MS)
}

/** Serializes startup attempts so two restarts cannot own the same port. */
function bootHarness() {
  if (startupTask !== undefined) return startupTask
  startupTask = bootHarnessImpl().finally(() => {
    startupTask = undefined
  })
  return startupTask
}

/** Restarts the local Harness runtime and returns the window to its loading state. */
function restartHarness() {
  if (restartTask !== undefined) return restartTask
  restartTask = (async () => {
    await stopHarness()
    void mainWindow?.loadFile('loading.html')
    await bootHarness()
  })().finally(() => {
    restartTask = undefined
  })
  return restartTask
}

/** Opens external HTTP links outside the isolated Harness window. */
function openExternalLink(url) {
  if (/^https?:\/\//u.test(url)) void shell.openExternal(url)
}

/** Opens the private Harness data directory without exposing filesystem access to the renderer. */
function openDataDirectory() {
  void shell.openPath(join(app.getPath('userData'), 'harness-data'))
}

/** Accepts only bounded binary image payloads crossing the isolated renderer bridge. */
function imagePayload(value) {
  if (value === null || typeof value !== 'object') throw new Error('Invalid image payload.')
  const input = value.data
  const data = input instanceof ArrayBuffer
    ? Buffer.from(input)
    : ArrayBuffer.isView(input)
      ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      : Buffer.from(input ?? [])
  if (data.length === 0 || data.length > MAX_DESKTOP_IMAGE_BYTES) throw new Error('Image payload is empty or too large.')
  const mediaType = typeof value.mediaType === 'string' && value.mediaType.startsWith('image/')
    ? value.mediaType
    : 'image/png'
  return { data, mediaType }
}

/** Keeps a user-provided image name safe as the initial Save dialog filename. */
function safeImageFileName(value, mediaType) {
  const extension = mediaType === 'image/jpeg'
    ? '.jpg'
    : mediaType === 'image/webp'
      ? '.webp'
      : mediaType === 'image/gif'
        ? '.gif'
        : '.png'
  const fallback = `image${extension}`
  if (typeof value !== 'string') return fallback
  const name = value.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_').trim()
  if (name.length === 0) return fallback
  return /\.[a-z0-9]{2,5}$/iu.test(name) ? name : `${name}${extension}`
}

/** Returns the native save-dialog filter for an image media type. */
function imageFilter(mediaType) {
  if (mediaType === 'image/jpeg') return { name: 'JPEG image', extensions: ['jpg', 'jpeg'] }
  if (mediaType === 'image/webp') return { name: 'WebP image', extensions: ['webp'] }
  if (mediaType === 'image/gif') return { name: 'GIF image', extensions: ['gif'] }
  return { name: 'PNG image', extensions: ['png'] }
}

/** Returns whether the native clipboard currently carries an image. */
function clipboardHasImage() {
  try {
    return !clipboard.readImage().isEmpty()
  } catch {
    return false
  }
}

/** Creates the single browser window that hosts the Harness UI. */
function createWindow() {
  const savedState = readWindowState()
  const { maximized, ...normalBounds } = savedState
  const icon = createAppIcon()
  mainWindow = new BrowserWindow({
    ...normalBounds,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#F7F7F8',
    icon,
    ...(process.platform === 'win32'
      ? { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlayOptions() }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, 'preload.cjs'),
    },
  })
  let windowRevealed = false
  const revealWindow = () => {
    if (windowRevealed) return
    windowRevealed = true
    if (maximized) mainWindow.maximize()
    showMainWindow()
  }
  mainWindow.once('ready-to-show', revealWindow)
  mainWindow.webContents.once('did-finish-load', revealWindow)
  setTimeout(revealWindow, 1_500)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const flags = params.editFlags
    const canPaste = flags.canPaste || clipboardHasImage()
    const template = params.isEditable
      ? [
          { role: 'cut', enabled: flags.canCut },
          { role: 'copy', enabled: flags.canCopy },
          {
            label: '粘贴',
            enabled: canPaste,
            click: () => mainWindow?.webContents.paste(),
          },
          { type: 'separator' },
          { role: 'selectAll', enabled: flags.canSelectAll },
        ]
      : params.selectionText.length > 0
        ? [{ role: 'copy', enabled: flags.canCopy }]
        : []
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: mainWindow })
  })
  const localPages = new Set([
    pathToFileURL(join(import.meta.dirname, 'loading.html')).href.toLowerCase(),
    pathToFileURL(join(import.meta.dirname, 'error.html')).href.toLowerCase(),
  ])
  const keepLocalNavigation = (event, url) => {
    try {
      const parsed = new URL(url)
      if (webUrl !== undefined && parsed.origin === new URL(webUrl).origin) return
      if (parsed.protocol === 'file:' && localPages.has(parsed.href.toLowerCase())) return
    } catch {
      // Invalid URL format
    }
    event.preventDefault()
    openExternalLink(url)
  }
  mainWindow.webContents.on('will-navigate', keepLocalNavigation)
  mainWindow.webContents.on('will-redirect', keepLocalNavigation)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    showStartupError(`The desktop renderer stopped (${details.reason}).`)
  })
  mainWindow.on('close', event => {
    saveWindowState()
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('resize', scheduleWindowStateSave)
  mainWindow.on('move', scheduleWindowStateSave)
  mainWindow.on('maximize', scheduleWindowStateSave)
  mainWindow.on('unmaximize', scheduleWindowStateSave)
  mainWindow.on('closed', () => {
    clearTimeout(saveWindowStateTimer)
    saveWindowStateTimer = undefined
    mainWindow = undefined
  })
  void mainWindow.loadFile('loading.html')
}

/** Creates the tray menu used when the main window is hidden. */
function createTray() {
  const trayIcon = createAppIcon().resize({ width: 20, height: 20 })
  tray = new Tray(trayIcon)
  tray.setToolTip('DeepSeek Harness')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: showMainWindow },
    { label: '重启 Harness', click: () => void restartHarness() },
    { label: '打开数据目录', click: openDataDirectory },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
  tray.on('double-click', showMainWindow)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', showMainWindow)

if (hasSingleInstanceLock) app.whenReady().then(() => {
  app.setAppUserModelId('ai.deepseek.harness.desktop')
  createWindow()
  createTray()
  void bootHarness()
  nativeTheme.on('updated', () => {
    if (process.platform === 'win32' && mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.setTitleBarOverlay(titleBarOverlayOptions())
    }
  })
  ipcMain.handle('desktop:open-browser', async () => {
    if (webUrl === undefined) return false
    try {
      await shell.openExternal(webUrl)
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('desktop:restart', () => restartHarness())
  ipcMain.handle('desktop:show-startup-error', () => startupError)
  ipcMain.handle('desktop:startup-log', () => redactedStartupLog())
  ipcMain.handle('desktop:open-data-directory', () => {
    openDataDirectory()
    return true
  })
  ipcMain.handle('desktop:copy-image', (_event, value) => {
    const { data } = imagePayload(value)
    const image = nativeImage.createFromBuffer(data)
    if (image.isEmpty()) return false
    clipboard.clear()
    clipboard.write({ image })
    return !clipboard.readImage().isEmpty()
  })
  ipcMain.handle('desktop:copy-text', async (_event, value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2 * 1024 * 1024) throw new Error('Invalid clipboard text.')
    if (process.platform === 'win32' && await writeWindowsClipboardText(value)) return true
    clipboard.clear()
    clipboard.write({ text: value })
    return clipboard.readText() === value
  })
  ipcMain.handle('desktop:save-image', async (_event, value) => {
    const { data, mediaType } = imagePayload(value)
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: join(app.getPath('downloads'), safeImageFileName(value.fileName, mediaType)),
      filters: [imageFilter(mediaType)],
    })
    if (result.canceled || result.filePath === undefined) return false
    await writeFile(result.filePath, data)
    return true
  })
  ipcMain.handle('desktop:ocr-image', async (_event, value) => {
    const { data, mediaType } = imagePayload(value)
    const scriptPath = app.isPackaged
      ? join(process.resourcesPath, 'windows-ocr.ps1')
      : join(import.meta.dirname, 'windows-ocr.ps1')
    return runWindowsOcr({
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      mediaType,
      scriptPath,
      tempDirectory: app.getPath('temp'),
    })
  })
  app.on('activate', showMainWindow)
})

app.on('before-quit', event => {
  if (quitReady) return
  event.preventDefault()
  app.isQuitting = true
  void stopHarness().finally(() => {
    quitReady = true
    app.quit()
  })
})

app.on('window-all-closed', () => {})

process.on('uncaughtException', error => {
  void dialog.showErrorBox('DeepSeek Harness', error.stack ?? error.message)
})