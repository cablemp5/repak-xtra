// repakxtra: loadout card media (image, GIF or video) stored in IndexedDB, which takes files far
// larger than localStorage can. One blob per loadout id.
import { useEffect, useState } from 'react'

const MAX_BYTES = 300 * 1024 * 1024
const DB = 'repakxtra-loadout-media'
const CARRIED = 'repakxtra.mediaCarriedOver'
let dbPromise: Promise<IDBDatabase> | null = null

const opened = (req: IDBOpenDBRequest) => new Promise<IDBDatabase>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

function db(): Promise<IDBDatabase> {
  dbPromise ??= (() => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('media')
    return opened(req).then(d => carryOverMedia(d).then(() => d, e => { console.warn('Loadout media not carried over:', e); return d }))
  })()
  return dbPromise
}

/** Media stored by repakxtra 0.2 and older lives in a database under an older prefix ("<prefix>-loadout-media"): copied
 *  in one transaction (files already here win), then marked done. The old database stays for older builds. */
async function carryOverMedia(to: IDBDatabase) {
  if (localStorage.getItem(CARRIED)) return
  const old = (await indexedDB.databases()).find(d => d.name && d.name !== DB && /^[a-z]+-loadout-media$/.test(d.name))
  if (old?.name) {
    const from = await opened(indexedDB.open(old.name))
    try {
      if (from.objectStoreNames.contains('media')) {
        const read = from.transaction('media', 'readonly').objectStore('media')
        const ask = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
        const [keys, blobs] = await Promise.all([ask(read.getAllKeys()), ask(read.getAll())])
        const tx = to.transaction('media', 'readwrite')
        const store = tx.objectStore('media')
        keys.forEach((k, i) => {
          const req = store.add(blobs[i], k) // add: never over a file stored here
          // Only "already here" is skipped; any other error aborts the copy and it runs again next start
          req.onerror = e => { if (req.error?.name === 'ConstraintError') { e.preventDefault(); e.stopPropagation() } }
        })
        await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error) })
      }
    } finally {
      from.close()
    }
  }
  localStorage.setItem(CARRIED, '1')
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
/** Stores a loadout's file; its cached image is dropped once the write commits (a failed write keeps it). */
export const putMedia = (id: string, blob: Blob) => run('readwrite', s => s.put(blob, id)).then(r => { dropMedia(id); return r })
export const deleteMedia = (id: string) => run('readwrite', s => s.delete(id)).then(() => dropMedia(id)).catch(() => undefined)

// Images are cached by loadout and revision (mediaRev), shared by every card and page that shows them, so a remount
// shows them at once; videos are read per use and their URL lives as long as the component (they can be huge).
type MediaRead = { url: string } | { video: Blob } | undefined
const mediaUrls = new Map<string, { rev: number; url: string }>()
const mediaLoads = new Map<string, { rev: number; p: Promise<MediaRead> }>()
const dropMedia = (id: string) => {
  const c = mediaUrls.get(id)
  if (c) URL.revokeObjectURL(c.url)
  mediaUrls.delete(id)
  mediaLoads.delete(id)
}
/** One read per loadout and revision; a read that finishes after its file was replaced or removed is thrown away. */
function loadMedia(id: string, rev: number): Promise<MediaRead> {
  const c = mediaUrls.get(id)
  if (c?.rev === rev) return Promise.resolve({ url: c.url })
  const f = mediaLoads.get(id)
  if (f?.rev === rev) return f.p
  const p: Promise<MediaRead> = getMedia(id).then(blob => {
    if (mediaLoads.get(id)?.p !== p) return undefined
    mediaLoads.delete(id) // a finished video read is not kept
    if (!blob) return undefined
    if (blob.type.startsWith('video/')) return { video: blob }
    const url = URL.createObjectURL(blob)
    mediaUrls.set(id, { rev, url })
    return { url }
  }, () => {
    if (mediaLoads.get(id)?.p === p) mediaLoads.delete(id)
    return undefined
  })
  mediaLoads.set(id, { rev, p })
  return p
}
/** The cached image URL of a loadout's media at this revision, if it has been read. */
export const cachedMediaUrl = (id: string, rev?: number) => {
  const c = mediaUrls.get(id)
  return rev && c?.rev === rev ? c.url : undefined
}

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
export async function prepareMedia(file: Blob): Promise<{ blob: Blob; type: 'image' | 'video' }> {
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

/** Object URL for a loadout's stored media; reloads when rev changes. Image URLs are shared (never revoked here);
 *  a video's is this component's own. */
export function useMediaUrl(id: string, rev?: number): string | undefined {
  const cached = cachedMediaUrl(id, rev)
  const [shown, setShown] = useState<{ id: string; rev?: number; url?: string }>({ id, rev, url: cached })
  useEffect(() => {
    if (!rev) { setShown({ id, rev, url: undefined }); return }
    let live = true
    let video: string | undefined
    loadMedia(id, rev).then(read => {
      if (!live || !read) return
      if ('video' in read) video = URL.createObjectURL(read.video)
      setShown({ id, rev, url: 'video' in read ? video : read.url })
    })
    return () => { live = false; if (video) URL.revokeObjectURL(video) }
  }, [id, rev])
  return cached ?? (shown.id === id && shown.rev === rev ? shown.url : undefined)
}
