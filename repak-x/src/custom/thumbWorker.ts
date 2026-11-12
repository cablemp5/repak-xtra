// repakxtra: the card-sized copies of previews (previews.tsx loadThumb), made in a worker. Made in the page, the 84
// copies of a first open of Loadouts took 0.9 s of its thread in resizing and encoding (createImageBitmap from a
// bitmap, convertToBlob), in tasks of 50 to 170 ms that a scroll started right after the open ran into.
// This file is both the worker and, imported by the page, the same work done there when the worker cannot start.

/** A WebP copy of `blob`'s picture (an animated one: of its first frame) `width` px wide, or null when the picture is
 *  already that small (a still within a quarter of it). */
export async function smallCopy(blob: Blob, width: number, animated: boolean): Promise<Blob | null> {
  const bmp = await createImageBitmap(blob)
  try {
    if (!animated && bmp.width <= width * 1.25) return null
    const small = await createImageBitmap(bmp, { resizeWidth: Math.min(width, bmp.width), resizeQuality: 'high' })
    const canvas = new OffscreenCanvas(small.width, small.height)
    canvas.getContext('2d')!.drawImage(small, 0, 0)
    small.close()
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 })
  } finally { bmp.close() }
}

type Ask = { id: number; blob: Blob; width: number; animated: boolean }
if (typeof document === 'undefined') { // in the worker
  self.onmessage = (e: MessageEvent<Ask>) => {
    const { id, blob, width, animated } = e.data
    smallCopy(blob, width, animated).then(copy => self.postMessage({ id, copy }), () => self.postMessage({ id, failed: true }))
  }
}

let worker: Worker | null | undefined
let asked = 0
const waiting = new Map<number, { ask: Ask; done: (copy: Blob | null) => void; fail: (e: unknown) => void }>()
/** smallCopy off the page's thread. A worker that cannot start or dies hands what it was asked back to the page. */
export function smallCopyAway(blob: Blob, width: number, animated: boolean): Promise<Blob | null> {
  if (worker === undefined) {
    try {
      worker = new Worker(new URL('./thumbWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (e: MessageEvent<{ id: number; copy?: Blob | null; failed?: boolean }>) => {
        const w = waiting.get(e.data.id)
        if (!w) return
        waiting.delete(e.data.id)
        if (e.data.failed) w.fail(new Error('no copy'))
        else w.done(e.data.copy ?? null)
      }
      worker.onerror = () => {
        worker = null
        for (const w of waiting.values()) smallCopy(w.ask.blob, w.ask.width, w.ask.animated).then(w.done, w.fail)
        waiting.clear()
      }
    } catch { worker = null }
  }
  if (!worker) return smallCopy(blob, width, animated)
  const ask = { id: ++asked, blob, width, animated }
  return new Promise((done, fail) => { waiting.set(ask.id, { ask, done, fail }); worker!.postMessage(ask) })
}
