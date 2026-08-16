/**
 * Local wallpaper persistence and presentation. Wallpaper bytes are device-
 * local appearance state, not Host settings and not session attachments, so
 * they live in IndexedDB and are projected through one inherited CSS variable.
 * The module is imported by AppearanceRow (which ui-theme loads eagerly), so
 * restore is asynchronous and never blocks client boot.
 */

const DATABASE_NAME = 'dsh-ui-theme'
const DATABASE_VERSION = 1
const STORE_NAME = 'appearance'
const WALLPAPER_KEY = 'wallpaper'
const WALLPAPER_PROPERTY = '--dsh-wallpaper-image'
const MAX_WALLPAPER_BYTES = 20 * 1024 * 1024
const SUPPORTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])

interface WallpaperRecord {
  blob: Blob
  name: string
  mediaType: string
}

export interface WallpaperSnapshot {
  loaded: boolean
  busy: boolean
  name?: string
  error?: string
}

let activeUrl: string | undefined
let snapshot: WallpaperSnapshot = Object.freeze({ loaded: false, busy: false })
const listeners = new Set<() => void>()
let database: Promise<IDBDatabase | undefined> | undefined

function publish(next: WallpaperSnapshot): void {
  snapshot = Object.freeze(next)
  for (const listener of listeners) listener()
}

/** Current local wallpaper state for useSyncExternalStore. */
export function getWallpaperSnapshot(): WallpaperSnapshot {
  return snapshot
}

/** Subscribe to local wallpaper changes. */
export function subscribeWallpaper(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (database !== undefined) return database
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined)
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('Wallpaper database could not be opened.')) }
  })
  return database
}

async function readRecord(): Promise<WallpaperRecord | undefined> {
  const db = await openDatabase()
  if (db === undefined) return undefined
  return await new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(WALLPAPER_KEY)
    request.onsuccess = () => { resolve(request.result as WallpaperRecord | undefined) }
    request.onerror = () => { reject(request.error ?? new Error('Wallpaper could not be read.')) }
  })
}

async function writeRecord(record: WallpaperRecord | undefined): Promise<void> {
  const db = await openDatabase()
  if (db === undefined) return
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    if (record === undefined) store.delete(WALLPAPER_KEY)
    else store.put(record, WALLPAPER_KEY)
    transaction.oncomplete = () => { resolve() }
    transaction.onerror = () => { reject(transaction.error ?? new Error('Wallpaper could not be saved.')) }
    transaction.onabort = () => { reject(transaction.error ?? new Error('Wallpaper save was aborted.')) }
  })
}

function validateRecord(record: WallpaperRecord): void {
  if (!(record.blob instanceof Blob) || record.blob.size === 0 || record.blob.size > MAX_WALLPAPER_BYTES) {
    throw new Error('Wallpaper must be a non-empty image up to 20 MB.')
  }
  if (!SUPPORTED_MEDIA_TYPES.has(record.mediaType)) {
    throw new Error('Wallpaper must be JPEG, PNG, WebP, or AVIF.')
  }
}

function clearPresentation(): void {
  if (activeUrl !== undefined && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(activeUrl)
  activeUrl = undefined
  if (typeof document !== 'undefined') document.documentElement.style.removeProperty(WALLPAPER_PROPERTY)
}

function present(record: WallpaperRecord): void {
  validateRecord(record)
  clearPresentation()
  if (typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') return
  activeUrl = URL.createObjectURL(record.blob)
  document.documentElement.style.setProperty(WALLPAPER_PROPERTY, `url("${activeUrl}")`)
}

async function restoreWallpaper(): Promise<void> {
  try {
    const record = await readRecord()
    if (record === undefined) {
      publish({ loaded: true, busy: false })
      return
    }
    present(record)
    publish({ loaded: true, busy: false, name: record.name })
  } catch {
    clearPresentation()
    publish({ loaded: true, busy: false, error: 'Saved wallpaper could not be restored.' })
  }
}

/** Validate and persist one local raster wallpaper, then switch atomically. */
export async function setWallpaper(file: File): Promise<void> {
  const record: WallpaperRecord = { blob: file, name: file.name || 'wallpaper', mediaType: file.type }
  try {
    validateRecord(record)
  } catch (error) {
    publish({ ...snapshot, busy: false, error: error instanceof Error ? error.message : String(error) })
    return
  }
  publish({ ...snapshot, busy: true, error: undefined })
  try {
    await writeRecord(record)
    present(record)
    publish({ loaded: true, busy: false, name: record.name })
  } catch (error) {
    publish({ ...snapshot, busy: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/** Remove the stored wallpaper only after its durable delete succeeds. */
export async function clearWallpaper(): Promise<void> {
  publish({ ...snapshot, busy: true, error: undefined })
  try {
    await writeRecord(undefined)
    clearPresentation()
    publish({ loaded: true, busy: false })
  } catch (error) {
    publish({ ...snapshot, busy: false, error: error instanceof Error ? error.message : String(error) })
  }
}

// Wallpaper restoration is deliberately detached from Host/theme startup. It
// reads one local IndexedDB row and publishes later without delaying first UI.
void restoreWallpaper()
