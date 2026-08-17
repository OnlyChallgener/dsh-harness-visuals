const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  openBrowser: () => ipcRenderer.invoke('desktop:open-browser'),
  openDataDirectory: () => ipcRenderer.invoke('desktop:open-data-directory'),
  copyImage: (data, mediaType) => ipcRenderer.invoke('desktop:copy-image', { data, mediaType }),
  copyText: text => ipcRenderer.invoke('desktop:copy-text', text),
  saveImage: (data, mediaType, fileName) => ipcRenderer.invoke('desktop:save-image', { data, mediaType, fileName }),
  ocrImage: (data, mediaType) => ipcRenderer.invoke('desktop:ocr-image', { data, mediaType }),
  pluginMarketplaceEnvironment: () => ipcRenderer.invoke('desktop:plugin-marketplace-job-environment'),
  pluginMarketplaceList: () => ipcRenderer.invoke('desktop:plugin-marketplace-list'),
  pluginMarketplaceJobStart: request => ipcRenderer.invoke('desktop:plugin-marketplace-job-start', request),
  pluginMarketplaceJobStatus: () => ipcRenderer.invoke('desktop:plugin-marketplace-job-status'),
  pluginMarketplaceJobApprove: id => ipcRenderer.invoke('desktop:plugin-marketplace-job-approve', id),
  pluginMarketplaceJobCancel: id => ipcRenderer.invoke('desktop:plugin-marketplace-job-cancel', id),
  restart: () => ipcRenderer.invoke('desktop:restart'),
  startupError: () => ipcRenderer.invoke('desktop:show-startup-error'),
  startupLog: () => ipcRenderer.invoke('desktop:startup-log'),
})

// Keep the native window controls while giving the frameless shell a small,
// stable drag affordance. The title-bar inset is measured from the standard
// Window Controls Overlay API when available, with a conservative fallback
// for Electron builds that do not expose it.
window.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('desktop-drag-region') !== null) return
  const fallbackInset = 180
  const controlsInset = document.createElement('style')
  controlsInset.id = 'desktop-window-controls-inset'
  controlsInset.textContent = `
    :root { --desktop-window-controls-inset: ${fallbackInset}px; }
    header:has(button[class*="sessionLogButton"]) {
      padding-right: calc(28px + var(--desktop-window-controls-inset));
    }
  `
  document.documentElement.append(controlsInset)
  const region = document.createElement('div')
  region.id = 'desktop-drag-region'
  region.setAttribute('aria-hidden', 'true')
  region.style.position = 'fixed'
  region.style.left = '0'
  region.style.right = `${fallbackInset}px`
  region.style.top = '0'
  region.style.height = '10px'
  region.style.zIndex = '2147483647'
  region.style.userSelect = 'none'
  region.style.webkitAppRegion = 'drag'
  region.style.setProperty('app-region', 'drag')
  document.documentElement.append(region)

  const updateControlsInset = () => {
    let inset = fallbackInset
    const overlay = globalThis.navigator?.windowControlsOverlay
    const rect = overlay?.getTitlebarAreaRect?.()
    if (rect !== undefined) {
      const measuredInset = window.innerWidth - (rect.x + rect.width)
      if (Number.isFinite(measuredInset) && measuredInset >= 64) {
        inset = Math.ceil(measuredInset)
      }
    }
    document.documentElement.style.setProperty('--desktop-window-controls-inset', `${inset}px`)
    region.style.right = `${inset}px`
  }

  updateControlsInset()
  window.addEventListener('resize', updateControlsInset)
  globalThis.navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', updateControlsInset)
})
