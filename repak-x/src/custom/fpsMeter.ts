// repakxtra: F3 shows a frame rate counter in the corner: frames in the last second and the slowest frame in it (a long
// frame is a hitch you feel even at 60 fps). Plain DOM on its own animation frame loop, so it never re-renders React.
const KEY = 'repakxtra.fps'
let el: HTMLDivElement | null = null
let raf = 0

function start() {
  el = document.createElement('div')
  el.className = 'xtra-fps'
  el.setAttribute('aria-hidden', 'true')
  document.body.append(el)
  let last = performance.now(), from = last, frames = 0, worst = 0
  const tick = (now: number) => {
    worst = Math.max(worst, now - last)
    last = now
    frames++
    if (now - from >= 1000) {
      el!.textContent = `${Math.round((frames * 1000) / (now - from))} fps  ${Math.round(worst)} ms`
      el!.classList.toggle('is-slow', worst > 50)
      from = now; frames = 0; worst = 0
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}

function stop() { cancelAnimationFrame(raf); el?.remove(); el = null }

window.addEventListener('keydown', e => {
  if (e.key !== 'F3' || e.ctrlKey || e.altKey || e.shiftKey) return
  e.preventDefault()
  if (el) { stop(); localStorage.removeItem(KEY) } else { start(); localStorage.setItem(KEY, '1') }
})
if (localStorage.getItem(KEY) === '1') start()
