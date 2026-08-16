// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearWallpaper,
  getWallpaperSnapshot,
  setWallpaper,
} from '../src/client/wallpaper.ts'

const createObjectURL = vi.fn(() => 'blob:dsh-local-wallpaper-test')
const revokeObjectURL = vi.fn()

beforeEach(async () => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  await clearWallpaper()
})

afterEach(async () => {
  await clearWallpaper()
  document.documentElement.style.removeProperty('--dsh-wallpaper-image')
  document.documentElement.removeAttribute('data-dsh-local-wallpaper')
})

describe('local wallpaper presentation', () => {
  it('sets and clears only its own DOM presentation state', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')

    await setWallpaper(new File([new Uint8Array([1, 2, 3])], 'wallpaper.png', { type: 'image/png' }))

    expect(getWallpaperSnapshot().name).toBe('wallpaper.png')
    expect(document.documentElement.getAttribute('data-dsh-local-wallpaper')).toBe('true')
    expect(document.documentElement.style.getPropertyValue('--dsh-wallpaper-image')).toContain('blob:dsh-local-wallpaper-test')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()

    await clearWallpaper()

    expect(getWallpaperSnapshot().name).toBeUndefined()
    expect(document.documentElement.hasAttribute('data-dsh-local-wallpaper')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--dsh-wallpaper-image')).toBe('')
    expect(revokeObjectURL).toHaveBeenCalled()

    getItem.mockRestore()
    setItem.mockRestore()
    removeItem.mockRestore()
  })
})
