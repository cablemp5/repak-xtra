// repakxtra: a KO prompt played once into a WebM with a transparent background: a loadout card's video (KoEditor.tsx)
// and a KO prompt mod's Library preview (koPreview.ts). Video, not an animated image: a video can be started on the
// shared beat (KO_BEAT), so every KO prompt on screen plays the same frame at the same time.
import { type Scene, drawClear, duration, frameFor } from './render'

/** The prompt playing once at full speed, then a beat of rest. Drawn frame by frame in real time into a canvas the
 *  recorder watches. Null when this WebView cannot record one. */
export async function recordClip(scene: Scene, size: { w: number; h: number }, kills: number, colors: Map<string, string>): Promise<Blob | null> {
  if (typeof MediaRecorder === 'undefined') return null
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t))
  if (!type) return null
  const c = document.createElement('canvas'); c.width = size.w; c.height = size.h // even sizes for the encoder
  c.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none' // a stream is only drawn from a canvas in the page
  document.body.appendChild(c)
  // with alpha: the video keeps it, so the card shows its own background behind the prompt
  const ctx = c.getContext('2d')!
  const frame = frameFor(scene.core, size), length = duration(scene) + 0.5
  const paint = (t: number) => drawClear(ctx, scene, t, size, { kills, colors, frame })
  const stream = c.captureStream(30)
  try {
    paint(0)
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4_000_000 })
    const parts: Blob[] = []
    rec.ondataavailable = e => { if (e.data.size) parts.push(e.data) }
    const stopped = new Promise<void>(res => { rec.onstop = () => res() })
    rec.start()
    // a timer, not animation frames: those stop while the window is hidden or minimized, and the recording would never end
    await new Promise<void>(res => {
      const start = performance.now()
      const id = setInterval(() => {
        const t = (performance.now() - start) / 1000
        paint(Math.min(t, length))
        if (t >= length) { clearInterval(id); res() }
      }, 1000 / 30)
    })
    rec.stop()
    await stopped
    const blob = new Blob(parts, { type: 'video/webm' })
    return blob.size > 1000 ? blob : null
  } finally {
    stream.getTracks().forEach(t => t.stop())
    c.remove()
  }
}
