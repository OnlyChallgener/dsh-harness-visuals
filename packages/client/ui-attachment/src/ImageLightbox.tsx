import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconCheckOutline16, IconCloseOutline16, IconCopyOutline16, IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { ImageContextMenu } from './ImageContextMenu.tsx'
import { copyImage, copyOcrText, downloadImage, hasNativeOcr, resolveImageActionLabels, runNativeOcr } from './image-actions.ts'
import css from './ImageLightbox.module.css'

/** Shared labels for image copy, save, and OCR actions. */
export interface ImageActionLabels {
  /** Accessible label of the copy-image action. */
  copy: string
  /** Accessible label of the save-image action. */
  download: string
  /** Label of the Windows OCR action. */
  ocr: string
}

/** Lightbox strings the owner resolves from its own locale namespace. */
export interface ImageLightboxLabels extends ImageActionLabels {
  /** Accessible name of the preview dialog. */
  dialog: string
  /** Accessible label of the close control. */
  close: string
  /** Transient label shown briefly after a successful copy. */
  copied: string
}

/**
 * Document-level original-image preview opened by clicking a thumbnail.
 * Closes on Escape, backdrop press, or the close control, and restores focus
 * to the opener on unmount. Rendered through a body portal: an opener inside
 * a transformed or filtered ancestor would otherwise trap the fixed backdrop
 * in that ancestor's box instead of covering the viewport.
 *
 * @param props.src - the original image URL.
 * @param props.alt - the image's alt text.
 * @param props.labels - dialog and image-action strings.
 * @param props.onClose - dismiss callback owned by the opener.
 * @returns the modal preview dialog.
 */
export function ImageLightbox({ src, alt, labels, onClose, onCopy, onDownload, onOcr }: {
  src: string
  alt: string
  labels: ImageLightboxLabels
  onClose: () => void
  /** Override the default image clipboard behavior. */
  onCopy?: () => void | Promise<void>
  /** Override the default image save behavior. */
  onDownload?: () => void | Promise<void>
  /** Override the default Windows OCR behavior. */
  onOcr?: () => void | Promise<void>
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const copyTimerRef = useRef<number | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | undefined>()
  const actionText = resolveImageActionLabels(labels)

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
      restoreRef.current?.focus()
    }
  }, [onClose])

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy()
    else if (!await copyImage(src)) throw new Error('Image clipboard write was refused.')
    setCopied(true)
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => { setCopied(false) }, 1500)
  }, [onCopy, src])

  const handleDownload = useCallback(async () => {
    if (onDownload) await onDownload()
    else if (!await downloadImage(src, alt)) throw new Error('Image save was cancelled.')
  }, [onDownload, src, alt])

  const handleOcr = useCallback(async () => {
    if (onOcr) {
      await onOcr()
      return
    }
    const text = await runNativeOcr(src)
    if (text === undefined || !(await copyOcrText(text))) throw new Error('Windows OCR is unavailable.')
  }, [onOcr, src])

  const openMenu = useCallback((event: MouseEvent) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }, [])

  return createPortal(
    <div
      className={css.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={labels.dialog}
    >
      <div className={css.mask} aria-hidden="true" onMouseDown={onClose} />
      <img className={css.image} src={src} alt={alt} onContextMenu={openMenu} />
      <div className={css.toolbar}>
        <button type="button" className={css.action} aria-label={actionText.copy} onClick={() => { void handleCopy().catch(() => undefined) }}>
          {copied
            ? <IconCheckOutline16 size={16} />
            : <IconCopyOutline16 size={16} />}
          <span className={css.actionLabel}>{copied ? actionText.copied : actionText.copy}</span>
        </button>
        <button type="button" className={css.action} aria-label={actionText.download} onClick={() => { void handleDownload().catch(() => undefined) }}>
          <IconDownloadOutline16 size={16} />
          <span className={css.actionLabel}>{actionText.download}</span>
        </button>
      </div>
      <button ref={closeRef} type="button" className={css.close} aria-label={labels.close} onClick={onClose}>
        <IconCloseOutline16 size={16} />
      </button>
      {menu !== undefined ? (
        <ImageContextMenu
          {...menu}
          labels={actionText}
          canOcr={onOcr !== undefined || hasNativeOcr()}
          onCopy={handleCopy}
          onDownload={handleDownload}
          onOcr={handleOcr}
          onClose={() => { setMenu(undefined) }}
        />
      ) : null}
    </div>,
    document.body,
  )
}
