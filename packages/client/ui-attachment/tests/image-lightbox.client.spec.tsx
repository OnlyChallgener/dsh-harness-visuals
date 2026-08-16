// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ImageLightbox } from '../src/ImageLightbox.tsx'
import type { DesktopImageBridge } from '../src/image-actions.ts'

afterEach(cleanup)

const labels = { dialog: '原图预览', close: '关闭原图预览', copy: '复制图片', copied: '已复制', download: '下载图片', ocr: 'Windows OCR 提取文字' }

describe('ImageLightbox', () => {
  it('focuses its close control, closes by button and Escape, and restores focus', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    const close = view.getByRole('button', { name: '关闭原图预览' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('tolerates a focus owner it cannot restore (no active element at mount)', () => {
    // jsdom always reports body as the fallback active element; stub the
    // element-less state a detached focus can leave.
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null })
    try {
      const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
      view.unmount()
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
    }
  })

  it('closes on a mask press but not on a press over the image', () => {
    const onClose = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={onClose} />)
    fireEvent.mouseDown(view.getByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
    const mask = document.querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.mouseDown(mask)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onCopy when the copy button is clicked', () => {
    const onCopy = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} onCopy={onCopy} />)
    fireEvent.click(view.getByRole('button', { name: '复制图片' }))
    expect(onCopy).toHaveBeenCalledTimes(1)
  })

  it('calls onDownload when the download button is clicked', () => {
    const onDownload = vi.fn()
    const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} onDownload={onDownload} />)
    fireEvent.click(view.getByRole('button', { name: '下载图片' }))
    expect(onDownload).toHaveBeenCalledTimes(1)
  })

  it('uses the native desktop bridge from the image context menu', async () => {
    const priorBridge: DesktopImageBridge | undefined = window.desktop
    const copyImage = vi.fn().mockResolvedValue(true)
    const saveImage = vi.fn().mockResolvedValue(true)
    window.desktop = { copyImage, saveImage, ocrImage: vi.fn().mockResolvedValue('文字') }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })),
    } as Response)
    try {
      const view = render(<ImageLightbox src="blob:original" alt="原图" labels={labels} onClose={vi.fn()} />)
      fireEvent.contextMenu(view.getByRole('img'), { clientX: 20, clientY: 30 })
      fireEvent.click(view.getByRole('menuitem', { name: '复制图片' }))
      await waitFor(() => { expect(copyImage).toHaveBeenCalledTimes(1) })
      fireEvent.contextMenu(view.getByRole('img'), { clientX: 20, clientY: 30 })
      fireEvent.click(view.getByRole('menuitem', { name: '下载图片' }))
      await waitFor(() => { expect(saveImage).toHaveBeenCalledTimes(1) })
    } finally {
      fetchMock.mockRestore()
      if (priorBridge === undefined) delete window.desktop
      else window.desktop = priorBridge
    }
  })
})
