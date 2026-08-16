import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'

/** Desktop bridge used for native image clipboard, save, and Windows OCR actions. */
export interface DesktopImageBridge {
  copyImage: (data: ArrayBuffer, mediaType: string) => Promise<boolean>
  copyText?: (text: string) => Promise<boolean>
  saveImage: (data: ArrayBuffer, mediaType: string, fileName: string) => Promise<boolean>
  ocrImage?: (data: ArrayBuffer, mediaType: string) => Promise<string>
}

declare global {
  interface Window {
    desktop?: DesktopImageBridge
  }
}

interface ImagePayload {
  data: ArrayBuffer
  mediaType: string
}

/** Image-action text after filling fields absent from an older UI plugin. */
export interface ResolvedImageActionLabels {
  copy: string
  copied: string
  download: string
  ocr: string
}

/** Resolves image-action labels across independently updated static and plugin UI bundles.
 * @param labels - action fields supplied by the active conversation UI plugin.
 * @returns complete action labels in the document language.
 */
export function resolveImageActionLabels(labels: Partial<ResolvedImageActionLabels>): ResolvedImageActionLabels {
  const language = typeof document === 'undefined'
    ? ''
    : document.documentElement.lang || (typeof navigator === 'undefined' ? '' : navigator.language)
  const fallback = /^zh(?:-|$)/iu.test(language)
    ? { copy: '复制图片', copied: '已复制', download: '下载图片', ocr: 'Windows OCR 提取文字' }
    : { copy: 'Copy image', copied: 'Copied', download: 'Download image', ocr: 'Extract text with Windows OCR' }
  const value = (candidate: string | undefined, defaultValue: string): string =>
    typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : defaultValue
  return {
    copy: value(labels.copy, fallback.copy),
    copied: value(labels.copied, fallback.copied),
    download: value(labels.download, fallback.download),
    ocr: value(labels.ocr, fallback.ocr),
  }
}

/** Returns the optional native desktop bridge without requiring Electron in Web UI builds. */
function desktopBridge(): DesktopImageBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.desktop
}

/** Reads one session-authorized image URL into bytes for a host action. */
async function readImage(src: string): Promise<ImagePayload> {
  const response = await fetch(src)
  if (!response.ok) throw new Error(`Image request failed (HTTP ${response.status}).`)
  const blob = await response.blob()
  return { data: await blob.arrayBuffer(), mediaType: blob.type || 'image/png' }
}

/** Converts a non-PNG image into the PNG format accepted by browser image clipboards. */
async function asPng(blob: Blob, src: string): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  return new Promise<Blob>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (context === null) {
        reject(new Error('Canvas image conversion is unavailable.'))
        return
      }
      context.drawImage(image, 0, 0)
      canvas.toBlob((converted) => {
        if (converted === null) reject(new Error('Image conversion failed.'))
        else resolve(converted)
      }, 'image/png')
    }
    image.onerror = () => { reject(new Error(`Image could not be decoded: ${src}`)) }
    image.src = src
  })
}

/** Copies an image through the native desktop clipboard or the browser image clipboard.
 * @param src - session-authorized image URL.
 * @returns true when the host accepts the image clipboard write.
 */
export async function copyImage(src: string): Promise<boolean> {
  const payload = await readImage(src)
  // Electron's nativeImage decoder is not consistent across the formats the
  // browser can display. Normalize once so the native and browser clipboard
  // paths both receive a real PNG payload.
  const png = await asPng(new Blob([payload.data], { type: payload.mediaType }), src)
  const data = await png.arrayBuffer()
  const bridge = desktopBridge()
  if (bridge !== undefined) {
    try {
      if (await bridge.copyImage(data, 'image/png')) return true
    } catch {
      // A stale or unavailable native bridge can still fall through to the
      // browser clipboard path when the current page permits it.
    }
  }
  /* oxlint-disable-next-line typescript/no-unnecessary-condition */
  if (navigator.clipboard?.write === undefined || typeof ClipboardItem === 'undefined') return false
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  return true
}

/** Saves an image through the native save dialog or the browser download mechanism.
 * @param src - session-authorized image URL.
 * @param fileName - suggested file name.
 * @returns true when the host accepts or completes the save action.
 */
export async function downloadImage(src: string, fileName: string): Promise<boolean> {
  const payload = await readImage(src)
  const bridge = desktopBridge()
  if (bridge !== undefined) return bridge.saveImage(payload.data, payload.mediaType, fileName)
  const url = URL.createObjectURL(new Blob([payload.data], { type: payload.mediaType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName || 'image.png'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 0)
  return true
}

/** Runs the desktop's Windows OCR bridge for an image, when the native host provides it.
 * @param src - session-authorized image URL.
 * @returns recognized text, or undefined when the current host has no OCR bridge.
 */
export async function runNativeOcr(src: string): Promise<string | undefined> {
  const bridge = desktopBridge()
  if (bridge?.ocrImage === undefined) return undefined
  const payload = await readImage(src)
  return bridge.ocrImage(payload.data, payload.mediaType)
}

/** Copies OCR text to the host clipboard using the shared text-clipboard fallback.
 * @param text - recognized text.
 * @returns true when the host accepts the text clipboard write.
 */
export async function copyOcrText(text: string): Promise<boolean> {
  const value = text.trim()
  if (value.length === 0) return false
  return writeClipboard(value)
}

/** Whether Windows OCR is available through the current host.
 * @returns true when the native OCR bridge is exposed.
 */
export function hasNativeOcr(): boolean {
  return desktopBridge()?.ocrImage !== undefined
}
