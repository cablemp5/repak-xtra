// repakxtra: while the window is in the background (the game or another app has focus, or it is minimized), looping
// videos and endless decorative CSS loops (DECOR: the hero art drift, border beams, the welcome demos) pause, so the
// app stops drawing frames nobody sees. Spinners, shimmers, skeletons, and progress bars keep playing, they show work is
// still going. A one-time animation always finishes, so nothing waiting on its end stalls. KO prompt videos
// (previews.tsx BeatVideo) pause on their own, to rejoin their shared beat. Animated WebP previews (dances, animated
// materials) cannot pause, so each shows a still of its current frame until focus returns: ten of them on Home cost
// about 85% of a CPU core to keep playing, 3% as stills (.agent/perf/tree-cpu.ps1, 2026-11-04).
const videos = new Set<HTMLVideoElement>()
const loops = new Set<Animation>()
/** Object URLs of animated previews (previews.tsx, loadoutBits.tsx add theirs) */
export const animatedUrls = new Set<string>()
const stills = new Map<HTMLImageElement, { src: string; still: string }>()

function freeze(img: HTMLImageElement) {
  const src = img.src
  if (!animatedUrls.has(src) || !img.complete || !img.naturalWidth) return
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
  stills.forEach(({ src, still }, img) => { if (img.src === still) img.src = src; URL.revokeObjectURL(still) })
  stills.clear()
}

export const isIdle = () => document.hidden || !document.hasFocus()

// Decorative loops only (keyframe names), so a spinner, shimmer, or progress bar never freezes mid-task
const DECOR = /^(rainbow-scroll|heartbeat|dropzone-|border-beam-|aurora-text-flow|shine-border-spin|wm-flow|mod-card-|wi-)/

function update() {
  if (isIdle()) {
    document.querySelectorAll('video').forEach(v => { if (v.loop && !v.paused) { v.pause(); videos.add(v) } })
    document.querySelectorAll('img').forEach(freeze)
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
document.addEventListener('load', e => { if (isIdle() && e.target instanceof HTMLImageElement) freeze(e.target) }, true)
document.addEventListener('play', e => {
  const v = e.target
  if (isIdle() && v instanceof HTMLVideoElement && v.loop) { v.pause(); videos.add(v) }
}, true)
