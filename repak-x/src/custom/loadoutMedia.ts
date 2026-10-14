// caleb fork: loadout card media (image, GIF or video) stored in IndexedDB, which takes files far
// larger than localStorage can. One blob per loadout id.
import { useEffect, useState } from 'react'

const MAX_BYTES = 300 * 1024 * 1024
let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('caleb-loadout-media', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('media')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

/** A write settles when its transaction does: committed, or rejected on error or abort. */
async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const tx = (await db()).transaction('media', mode)
  return new Promise((resolve, reject) => {
    const req = op(tx.objectStore('media'))
    if (mode === 'readonly') {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      return
    }
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error ?? req.error)
    tx.onabort = () => reject(tx.error ?? req.error)
  })
}

export const getMedia = (id: string) => run<Blob | undefined>('readonly', s => s.get(id))
export const putMedia = (id: string, blob: Blob) => run('readwrite', s => s.put(blob, id))
export const deleteMedia = (id: string) => run('readwrite', s => s.delete(id)).catch(() => undefined)

/** Deletes every stored file whose id is not in `keep`, in one transaction. `keep` is read when the keys arrive, so ids
 *  added to it meanwhile still count. Resolves on commit; any error aborts the whole sweep. */
export async function sweepOrphanMedia(keep: Set<string>): Promise<void> {
  const tx = (await db()).transaction('media', 'readwrite')
  const store = tx.objectStore('media')
  return new Promise((resolve, reject) => {
    const req = store.getAllKeys()
    req.onsuccess = () => { for (const k of req.result) if (!keep.has(String(k))) store.delete(k) }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? req.error)
    tx.onabort = () => reject(tx.error ?? req.error)
  })
}

/** Images are downscaled to 1280 px wide; GIFs and videos are kept as-is so they still animate. */
export async function prepareMedia(file: File): Promise<{ blob: Blob; type: 'image' | 'video' }> {
  if (file.size > MAX_BYTES) throw new Error(`File is ${Math.round(file.size / 1048576)} MB; the limit is 300 MB.`)
  if (file.type.startsWith('video/')) return { blob: file, type: 'video' }
  if (!file.type.startsWith('image/')) throw new Error('Pick an image, GIF or video file.')
  if (file.type === 'image/gif') return { blob: file, type: 'image' }
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1280 / bitmap.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/webp', 0.9))
  return { blob: blob ?? file, type: 'image' }
}

/** Object URL for a loadout's stored media; reloads when rev changes. */
export function useMediaUrl(id: string, rev?: number): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!rev) { setUrl(undefined); return }
    let live = true
    let made: string | undefined
    getMedia(id).then(blob => {
      if (!live || !blob) return
      made = URL.createObjectURL(blob)
      setUrl(made)
    })
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [id, rev])
  return url
}
