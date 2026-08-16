import { useCallback, useMemo, useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageActionLabels } from './ImageLightbox.tsx'
import { resolveImageActionLabels } from './image-actions.ts'

/** Context-menu actions available for a rendered image.
 * @param props.x - horizontal viewport coordinate.
 * @param props.y - vertical viewport coordinate.
 * @param props.labels - localized action labels.
 * @param props.canOcr - whether the native OCR action is available.
 * @param props.onCopy - image-copy operation.
 * @param props.onDownload - image-save operation.
 * @param props.onOcr - local OCR operation.
 * @param props.onClose - dismiss callback.
 * @returns the portaled image action menu.
 */
export function ImageContextMenu({ x, y, labels, canOcr, onCopy, onDownload, onOcr, onClose }: {
  x: number
  y: number
  labels: ImageActionLabels
  canOcr: boolean
  onCopy: () => Promise<void>
  onDownload: () => Promise<void>
  onOcr: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState<string | undefined>()
  const anchorRect = useMemo(() => new DOMRect(x, y, 0, 0), [x, y])
  const getAnchorRect = useCallback(() => anchorRect, [anchorRect])
  const text = resolveImageActionLabels(labels)

  const run = (name: string, action: () => Promise<void>): void => {
    if (busy !== undefined) return
    setBusy(name)
    void action().then(onClose, () => { setBusy(undefined) })
  }

  const items = [
    { id: 'copy', label: busy === 'copy' ? '…' : text.copy, disabled: busy !== undefined },
    { id: 'download', label: busy === 'download' ? '…' : text.download, disabled: busy !== undefined },
    ...(canOcr ? [{ id: 'ocr', label: busy === 'ocr' ? '…' : text.ocr, disabled: busy !== undefined }] : []),
  ]

  return (
    <Menu
      open
      anchor={null}
      items={items}
      compact
      portal
      getAnchorRect={getAnchorRect}
      onClose={onClose}
      onSelect={(id) => {
        if (id === 'copy') run(id, onCopy)
        else if (id === 'download') run(id, onDownload)
        else if (id === 'ocr') run(id, onOcr)
      }}
    />
  )
}
