// repakxtra: while the window is in the background (the game or another app has focus, or it is minimized), looping
// videos and endless decorative CSS loops (DECOR: the hero art drift, border beams, the welcome demos) pause, so the
// app stops drawing frames nobody sees. Spinners, shimmers, skeletons, and progress bars keep playing, they show work is
// still going. A one-time animation always finishes, so nothing waiting on its end stalls. KO prompt videos
// (previews.tsx BeatVideo) pause on their own, to rejoin their shared beat. Animated WebP previews (dances, animated
// materials, a loadout's own GIF) cannot pause, so each shows a still of its current frame until focus returns: ten of them on Home cost
// about 85% of a CPU core to keep playing, 3% as stills (.agent/perf/tree-cpu.ps1, 2026-11-04).
const videos = new Set<HTMLVideoElement>()
const loops = new Set<Animation>()
/** Object URLs of animated previews (previews.tsx, loadoutBits.tsx add theirs) */
export const animatedUrls = new Set<string>()
const stills = new Map<HTMLImageElement, { src: string; still: string }>()

// Any other blob: picture (a loadout's own GIF or WebP, a hovered emote's restarted copy) is checked by its file header
// once: an animated WebP, an APNG, or a GIF (a still GIF frozen is the same picture)
const sniffed = new Map<string, Promise<boolean>>()
export const animatedBytes = (h: Uint8Array) => {
  const text = String.fromCharCode(...h)
  return text.startsWith('GIF8') || (text.slice(8, 16) === 'WEBPVP8X' && (h[20] & 0x02) !== 0) || (h[0] === 0x89 && text.slice(1, 4) === 'PNG' && text.includes('acTL'))
}
const isAnimated = (src: string) => {
  if (animatedUrls.has(src)) return Promise.resolve(true)
  if (!src.startsWith('blob:')) return Promise.resolve(false) // a remote picture would taint the canvas
  let p = sniffed.get(src)
  if (!p) {
    // only the head: a blob: URL honors Range, so a big preview is not copied whole at the moment focus leaves
    p = fetch(src, { headers: { Range: 'bytes=0-4095' } }).then(r => r.arrayBuffer()).then(b => animatedBytes(new Uint8Array(b.slice(0, 4096))), () => false)
    sniffed.set(src, p)
  }
  return p
}

async function freeze(img: HTMLImageElement) {
  const src = img.src
  if (stills.get(img)?.still === src) return // its own still loading (the load listener): nothing to read
  // a file picture (asset protocol) drawn without crossorigin would taint the canvas: it keeps playing instead
  if (!img.complete || !img.naturalWidth || (!src.startsWith('blob:') && !img.crossOrigin) || !(await isAnimated(src)) || !isIdle() || img.src !== src) return
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  c.getContext('2d')?.drawImage(img, 0, 0) // the frame showing now
  c.toBlob(b => {
    if (!b || !isIdle() || img.src !== src) return // focus came back first, or the preview changed
    const still = URL.createObjectURL(b)
    stills.set(img, { src, still })
    img.src = still
  })
}

function thaw() {
  // Only where the still is still showing: a preview that changed meanwhile keeps its new picture
  stills.forEach(({ src, still }, img) => { if (img.src === still) img.src = src; URL.revokeObjectURL(still); sniffed.delete(still) })
  stills.clear()
}

export const isIdle = () => document.hidden || !document.hasFocus()

// While a grid of cards scrolls hard, its animated covers show a still: five of them in view, each decoding a full-size
// frame 24 times a second, took a hard scroll of the Loadouts grid from 140 frames a second to 120 (hidden: 140).
// shortcut: a loadout's own animated cover (a GIF or WebP he picked) has no still and keeps playing, give those one
// here if a grid of them shows the drop
/** Card-sized first frames of animated previews, by the animated picture's URL (previews.tsx makes them). */
export const coverStills = new Map<string, string>()
const held = new Map<HTMLImageElement, string>() // a cover showing its still, and the animated URL it goes back to
/** The animated covers under `root` show their stills from now (called again as a scroll goes on, for new cards). */
export function holdCovers(root: HTMLElement) {
  for (const img of root.querySelectorAll<HTMLImageElement>('.lo-card-image img')) {
    const still = coverStills.get(img.src)
    if (still) { held.set(img, img.src); img.src = still }
  }
}
/** The held covers play again, where their still is what still shows (a preview that changed keeps its new picture). */
export function releaseCovers() {
  held.forEach((src, img) => { if (img.isConnected && img.src === coverStills.get(src)) img.src = src })
  held.clear()
}

// Decorative loops only (keyframe names), so a spinner, shimmer, or progress bar never freezes mid-task
const DECOR = /^(rainbow-scroll|heartbeat|dropzone-|border-beam-|aurora-text-flow|shine-border-spin|wm-flow|mod-card-|wi-)/

function update() {
  if (isIdle()) {
    document.querySelectorAll('video').forEach(v => { if (v.loop && !v.paused) { v.pause(); videos.add(v) } })
    document.querySelectorAll('img').forEach(img => void freeze(img))
    document.getAnimations().forEach(a => {
      // Not one under the pointer: pause() and play() pin a CSS animation's state, and the hero art drift runs on hover only
      const target = a.effect instanceof KeyframeEffect ? a.effect.target : null
      if (a instanceof CSSAnimation && DECOR.test(a.animationName) && a.playState === 'running'
        && a.effect?.getComputedTiming().iterations === Infinity && !target?.matches(':hover')) { a.pause(); loops.add(a) }
    })
  } else {
    videos.forEach(v => { if (v.isConnected) v.play().catch(() => undefined) })
    loops.forEach(a => { if (a.playState === 'paused') a.play() })
    thaw()
    videos.clear()
    loops.clear()
  }
}

window.addEventListener('blur', update)
window.addEventListener('focus', update)
document.addEventListener('visibilitychange', update)
// A preview that loads, changes, or mounts after focus left (a copy started in the background, a card still decoding)
// missed that moment: it is caught as it lands. load and play do not bubble, so they are caught on the way down
document.addEventListener('load', e => { if (isIdle() && e.target instanceof HTMLImageElement) void freeze(e.target) }, true)
document.addEventListener('play', e => {
  const v = e.target
  if (isIdle() && v instanceof HTMLVideoElement && v.loop) { v.pause(); videos.add(v) }
}, true)

if (import.meta.env.DEV) {
  const b = (s: string, at20 = 0) => { const a = new Uint8Array(32); [...s].forEach((c, i) => { a[i] = c.charCodeAt(0) }); a[20] = at20; return a }
  const png = (chunk: string) => { const a = b(`_PNG____${chunk}`); a[0] = 0x89; return a }
  console.assert(animatedBytes(b('GIF89a')) && animatedBytes(b('RIFF____WEBPVP8X', 0x02)) && !animatedBytes(b('RIFF____WEBPVP8X', 0x10))
    && !animatedBytes(b('RIFF____WEBPVP8 ')) && animatedBytes(png('acTL')) && !animatedBytes(png('IHDR')), 'animated picture sniffing')
}
