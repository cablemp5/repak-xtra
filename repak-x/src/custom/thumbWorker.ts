// repakxtra: the card-sized copies of previews (previews.tsx loadThumb), made in a worker. Made in the page, the 84
// copies of a first open of Loadouts took 0.9 s of its thread in resizing and encoding (createImageBitmap from a
// bitmap, convertToBlob), in tasks of 50 to 170 ms that a scroll started right after the open ran into.
// This file is both the worker and, imported by the page, the same work done there when the worker cannot start.
import { type Frame, muxWebm } from './ko/webm'

/** A WebP copy of `blob`'s picture (an animated one: of its first frame) `width` px wide, with the CSS filter `boost`
 *  drawn into it ('' for none), or null when there is nothing to gain (a still within a quarter of the width, no boost). */
export async function smallCopy(blob: Blob, width: number, animated: boolean, boost = ''): Promise<Blob | null> {
  const bmp = await createImageBitmap(blob)
  try {
    if (!animated && !boost && bmp.width <= width * 1.25) return null
    const small = await createImageBitmap(bmp, { resizeWidth: Math.min(width, bmp.width), resizeQuality: 'high' })
    const canvas = new OffscreenCanvas(small.width, small.height)
    const ctx = canvas.getContext('2d')!
    if (boost) ctx.filter = boost
    ctx.drawImage(small, 0, 0)
    small.close()
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 })
  } finally { bmp.close() }
}

/** An animated WebP as a looping WebM `width` px wide (its transparency kept, `boost` drawn in), for a loadout card: a
 *  video's frames are decoded off the page and put on screen by the compositor, where each frame of an animated picture
 *  is drawn again into the page's tiles (five of them cost a hard scroll 20 frames a second, so they were held still).
 *  Frame times are the picture's own, so a 60 frames a second preview plays at 60. Null when this WebView cannot (no
 *  ImageDecoder or VP8 encoder) or the picture is not animated. Color and alpha as two VP8 streams, like ko/record.ts. */
export async function smallClip(blob: Blob, width: number, boost = ''): Promise<Blob | null> {
  if (typeof ImageDecoder === 'undefined' || typeof VideoEncoder === 'undefined') return null
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: 'image/webp' })
  const made: { color: EncodedVideoChunk[]; alpha: EncodedVideoChunk[] } = { color: [], alpha: [] }
  const encoders: VideoEncoder[] = []
  let failed: unknown = null
  try {
    await decoder.completed
    await decoder.tracks.ready // the frame count is known only once both have settled
    const count = decoder.tracks.selectedTrack?.frameCount ?? 0
    if (count < 2) return null
    let w = 0, h = 0, ctx: OffscreenCanvasRenderingContext2D | null = null, us = 0, lastKey = -1e9, luma = new Uint8Array(0)
    for (let i = 0; i < count && !failed; i++) {
      const { image } = await decoder.decode({ frameIndex: i })
      if (!ctx) {
        w = Math.min(width, image.displayWidth) & ~1 // even sizes for the encoder
        h = Math.round(image.displayHeight * w / image.displayWidth) & ~1
        const config: VideoEncoderConfig = { codec: 'vp8', width: w, height: h, alpha: 'discard' }
        if (!(await VideoEncoder.isConfigSupported(config).catch(() => null))?.supported) { image.close(); return null }
        for (const [into, bitrate] of [[made.color, 1_500_000], [made.alpha, 400_000]] as const) {
          const e = new VideoEncoder({ output: c => into.push(c), error: err => { failed = err } })
          e.configure({ ...config, bitrate })
          encoders.push(e)
        }
        ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!
        if (boost) ctx.filter = boost
        luma = new Uint8Array(w * h * 3 / 2).fill(128)
      }
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(image, 0, 0, w, h)
      const length = image.duration ?? 41_667
      image.close()
      // straight (not premultiplied) color, so edges keep their color when the alpha is put back
      const rgba = ctx.getImageData(0, 0, w, h).data
      // the alpha goes in as the luma plane itself (I420, gray chroma): as gray RGB the encoder squeezed it into
      // video range, and a clear pixel came back 6% black, a solid one 92% solid
      for (let p = 0, y = 0; p < rgba.length; p += 4) luma[y++] = rgba[p + 3]
      const key = us - lastKey >= 1e6 // both streams keyed on the same frames, one a second
      if (key) lastKey = us
      encoders.forEach((enc, n) => {
        if (enc.state !== 'configured') return // failed: its error ends the loop
        const frame = new VideoFrame(n ? luma : rgba, { format: n ? 'I420' : 'RGBX', codedWidth: w, codedHeight: h, timestamp: us })
        try { enc.encode(frame, { keyFrame: key }) } finally { frame.close() }
      })
      us += length
      while (!failed && encoders[0].encodeQueueSize + encoders[1].encodeQueueSize > 6) await new Promise(r => setTimeout(r, 1))
    }
    if (failed) return null
    await Promise.all(encoders.map(e => e.flush()))
    if (failed || made.color.length !== count || made.alpha.length !== count || made.color.some((c, i) => c.type !== made.alpha[i].type)) return null
    const bytes = (c: EncodedVideoChunk) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); return b }
    const frames: Frame[] = made.color.map((c, i) => ({ ms: Math.round(c.timestamp / 1000), key: c.type === 'key', color: bytes(c), alpha: bytes(made.alpha[i]) }))
    return new Blob([muxWebm(frames, w, h, Math.round(us / 1000))], { type: 'video/webm' })
  } finally {
    encoders.forEach(e => { if (e.state !== 'closed') e.close() })
    decoder.close()
  }
}

type Ask = { id: number; blob: Blob; width: number; animated: boolean; boost: string; clip?: boolean }
const run = (a: Ask) => (a.clip ? smallClip(a.blob, a.width, a.boost) : smallCopy(a.blob, a.width, a.animated, a.boost))
if (typeof document === 'undefined') { // in the worker
  self.onmessage = (e: MessageEvent<Ask>) => {
    run(e.data).then(copy => self.postMessage({ id: e.data.id, copy }), () => self.postMessage({ id: e.data.id, failed: true }))
  }
}

let worker: Worker | null | undefined
let asked = 0
const waiting = new Map<number, { ask: Ask; done: (copy: Blob | null) => void; fail: (e: unknown) => void }>()
function away(job: Omit<Ask, 'id'>): Promise<Blob | null> {
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
        for (const w of waiting.values()) run(w.ask).then(w.done, w.fail)
        waiting.clear()
      }
    } catch { worker = null }
  }
  const ask = { ...job, id: ++asked }
  if (!worker) return run(ask)
  return new Promise((done, fail) => { waiting.set(ask.id, { ask, done, fail }); worker!.postMessage(ask) })
}
/** smallCopy off the page's thread. A worker that cannot start or dies hands what it was asked back to the page. */
export const smallCopyAway = (blob: Blob, width: number, animated: boolean, boost = '') => away({ blob, width, animated, boost })
/** smallClip off the page's thread, the same way. */
export const smallClipAway = (blob: Blob, width: number, boost = '') => away({ blob, width, animated: true, boost, clip: true })
