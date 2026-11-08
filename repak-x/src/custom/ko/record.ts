// repakxtra: a KO prompt played once into a WebM with a transparent background: a loadout card's video (KoEditor.tsx)
// and a KO prompt mod's Library preview (koPreview.ts). Video, not an animated image: a video can be started on the
// shared beat (KO_BEAT), so every KO prompt on screen plays the same frame at the same time.
import { type Scene, drawClear, duration, frameFor } from './render'
import { type Frame, muxWebm } from './webm'

const FPS = 60

/** The clip rendered offline, frame i at i / FPS seconds, so a busy or hidden window never drops a frame (the realtime
 *  recorder below made 15 to 35 fps files with gaps up to 411 ms). Color and alpha go through two VP8 encoders (WebCodecs
 *  here cannot keep alpha) and webm.ts puts them in one file. Null when this WebView has no VP8 encoder. */
async function encodeClip(ctx: CanvasRenderingContext2D, size: { w: number; h: number }, length: number, paint: (t: number) => void): Promise<Blob | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null
  const config: VideoEncoderConfig = { codec: 'vp8', width: size.w, height: size.h, framerate: FPS, bitrate: 4_000_000, alpha: 'discard' }
  if (!(await VideoEncoder.isConfigSupported(config).catch(() => null))?.supported) return null
  const made: { color: EncodedVideoChunk[]; alpha: EncodedVideoChunk[] } = { color: [], alpha: [] }
  let failed: unknown = null
  const encoder = (into: EncodedVideoChunk[], bitrate: number) => {
    const e = new VideoEncoder({ output: c => into.push(c), error: err => { failed = err } })
    e.configure({ ...config, bitrate })
    return e
  }
  const encoders: VideoEncoder[] = []
  try {
    const color = encoder(made.color, 4_000_000)
    encoders.push(color)
    const alpha = encoder(made.alpha, 1_000_000)
    encoders.push(alpha)
    const count = Math.ceil(length * FPS) + 1
    for (let i = 0; i < count && !failed; i++) {
      paint(Math.min(i / FPS, length))
      // straight (not premultiplied) color, so edges keep their color when the alpha is put back
      const rgba = ctx.getImageData(0, 0, size.w, size.h).data
      const gray = new Uint8ClampedArray(rgba.length)
      for (let p = 0; p < rgba.length; p += 4) gray[p] = gray[p + 1] = gray[p + 2] = rgba[p + 3]
      const timestamp = Math.round(i * 1e6 / FPS), key = i % FPS === 0 // both streams keyed on the same frames
      for (const [enc, data] of [[color, rgba], [alpha, gray]] as const) {
        if (enc.state !== 'configured') continue // failed: its error ends the loop
        const frame = new VideoFrame(data, { format: 'RGBX', codedWidth: size.w, codedHeight: size.h, timestamp })
        try { enc.encode(frame, { keyFrame: key }) } finally { frame.close() }
      }
      // backpressure, and a breath for the page: wait for the encoders, not the display clock
      while (!failed && color.encodeQueueSize + alpha.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 1))
      if (i % 10 === 9) await new Promise(r => setTimeout(r, 0))
    }
    await Promise.all([color.flush(), alpha.flush()])
  } finally {
    encoders.forEach(e => { if (e.state !== 'closed') e.close() })
  }
  if (failed) throw failed
  // a keyframe in one stream only would leave alpha referencing the cluster before: the realtime recorder then
  if (!made.color.length || made.color.length !== made.alpha.length || made.color.some((c, i) => c.type !== made.alpha[i].type)) return null
  const bytes = (c: EncodedVideoChunk) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); return b }
  const frames: Frame[] = made.color.map((c, i) => ({ ms: Math.round(c.timestamp / 1000), key: c.type === 'key', color: bytes(c), alpha: bytes(made.alpha[i]) }))
  return new Blob([muxWebm(frames, size.w, size.h, Math.round(length * 1000))], { type: 'video/webm' })
}

/** The prompt playing once at full speed, then a beat of rest: encoded frame by frame (encodeClip), else drawn in real
 *  time into a canvas the recorder watches. Null when this WebView can do neither. */
export async function recordClip(scene: Scene, size: { w: number; h: number }, kills: number, colors: Map<string, string>): Promise<Blob | null> {
  const c = document.createElement('canvas'); c.width = size.w; c.height = size.h // even sizes for the encoder
  c.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none' // a stream is only drawn from a canvas in the page
  document.body.appendChild(c)
  // with alpha: the video keeps it, so the card shows its own background behind the prompt
  const ctx = c.getContext('2d')!
  const frame = frameFor(scene.core, size), length = duration(scene) + 0.5
  const paint = (t: number) => drawClear(ctx, scene, t, size, { kills, colors, frame })
  try {
    const clip = await encodeClip(ctx, size, length, paint)
    if (clip) { c.remove(); return clip }
  } catch (e) { console.warn('KO clip: the frame-by-frame encoder failed, recording in real time instead:', e) }
  const type = typeof MediaRecorder === 'undefined' ? undefined : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t))
  if (!type) { c.remove(); return null }
  const stream = c.captureStream(60)
  let raf = 0, timer = 0
  try {
    paint(0)
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4_000_000 })
    const parts: Blob[] = []
    rec.ondataavailable = e => { if (e.data.size) parts.push(e.data) }
    await new Promise<void>((resolve, reject) => {
      rec.onstop = () => resolve()
      rec.onerror = () => reject(new Error('The KO preview could not be recorded.'))
      rec.start()
      const start = performance.now()
      // Paint on the display clock. A background timer still finishes a minimized window's recording.
      const tick = () => {
        cancelAnimationFrame(raf); clearTimeout(timer)
        if (rec.state !== 'recording') return
        const t = (performance.now() - start) / 1000
        try { paint(Math.min(t, length)) } catch (e) { rec.stop(); reject(e); return }
        if (t >= length) { rec.stop(); return }
        raf = requestAnimationFrame(tick)
        timer = window.setTimeout(tick, 100)
      }
      raf = requestAnimationFrame(tick)
      timer = window.setTimeout(tick, 100)
    })
    const blob = new Blob(parts, { type: 'video/webm' })
    return blob.size > 1000 ? blob : null
  } finally {
    cancelAnimationFrame(raf); clearTimeout(timer)
    stream.getTracks().forEach(t => t.stop())
    c.remove()
  }
}
