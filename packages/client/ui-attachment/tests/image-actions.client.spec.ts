// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyImage } from '../src/image-actions.ts'
import type { DesktopImageBridge } from '../src/image-actions.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete window.desktop
})

function imageResponse(): Response {
  return {
    ok: true,
    status: 200,
    blob: () => Promise.resolve(new Blob([Uint8Array.of(137, 80, 78, 71)], { type: 'image/png' })),
  } as Response
}

describe('copyImage', () => {
  it('passes image bytes to the desktop bridge instead of text', async () => {
    const copy = vi.fn().mockResolvedValue(true)
    const bridge: DesktopImageBridge = {
      copyImage: copy,
      saveImage: vi.fn().mockResolvedValue(true),
    }
    window.desktop = bridge
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(imageResponse())

    await expect(copyImage('blob:history')).resolves.toBe(true)
    expect(copy).toHaveBeenCalledTimes(1)
    expect(copy).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'image/png')
    expect([...new Uint8Array(copy.mock.calls[0]![0] as ArrayBuffer)]).toEqual([137, 80, 78, 71])
  })

  it('does not claim success when the native bridge rejects the write', async () => {
    window.desktop = {
      copyImage: vi.fn().mockResolvedValue(false),
      saveImage: vi.fn().mockResolvedValue(true),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(imageResponse())

    await expect(copyImage('blob:history')).resolves.toBe(false)
  })
})
