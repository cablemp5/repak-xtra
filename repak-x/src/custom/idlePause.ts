// repakxtra: while the window is in the background (the game or another app has focus, or it is minimized), looping
// videos and endless CSS loops (shimmers, pulses, the hero art drift) pause, so the app stops drawing frames nobody
// sees. Only endless ones: a one-time animation still finishes, so nothing waiting on its end stalls. KO prompt videos
// (previews.tsx BeatVideo) pause on their own, to rejoin their shared beat.
const videos = new Set<HTMLVideoElement>()
const loops = new Set<Animation>()

export const isIdle = () => document.hidden || !document.hasFocus()

function update() {
  if (isIdle()) {
    document.querySelectorAll('video').forEach(v => { if (v.loop && !v.paused) { v.pause(); videos.add(v) } })
    document.getAnimations().forEach(a => {
      // Not one under the pointer: pause() and play() pin a CSS animation's state, and the hero art drift runs on hover only
      const target = a.effect instanceof KeyframeEffect ? a.effect.target : null
      if (a.playState === 'running' && a.effect?.getComputedTiming().iterations === Infinity && !target?.matches(':hover')) { a.pause(); loops.add(a) }
    })
  } else {
    videos.forEach(v => { if (v.isConnected) v.play().catch(() => undefined) })
    loops.forEach(a => { if (a.playState === 'paused') a.play() })
    videos.clear()
    loops.clear()
  }
}

window.addEventListener('blur', update)
window.addEventListener('focus', update)
document.addEventListener('visibilitychange', update)
