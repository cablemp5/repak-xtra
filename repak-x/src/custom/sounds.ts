// repakxtra: UI sounds with cuelume (synthesized live, no audio files), mech theme. One click listener maps the
// control under the pointer to a cue and one key listener plays typing in text fields, so upstream components need no
// changes; alerts add success, error, warning and loading. Settings > Interface > Sound effects turns it off (uiPrefs.tsx calls setSoundOn).
import { play, setEnabled, setTheme, setVolume, unlock, type PlayOptions, type SoundName } from 'cuelume'

setTheme('mech') // the mech preset for every sound
setVolume(0.7)

let soundOn = true
export const setSoundOn = (on: boolean) => { soundOn = on; setEnabled(on) }
export const unlockSound = () => { unlock().catch(() => undefined) }

type Cue = [SoundName, PlayOptions?]

/** Which cue a click on this element plays, or null for silence (plain rows, text, disabled controls). */
export function cueFor(target: Element): Cue | null {
  const el = target.closest('button, a[href], [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="option"], .custom-dropdown-item, input[type="checkbox"]')
  if (!el || el.matches(':disabled, [aria-disabled="true"]')) return null
  const on = el.getAttribute('aria-checked') === 'true' || (el as HTMLInputElement).checked === true
  if (el.matches('[role="switch"], [role="checkbox"], input[type="checkbox"]')) return ['toggle', { direction: on ? 'back' : 'forward' }]
  if (el.closest('.lo-media-arrow')) return ['navigate', { direction: el.classList.contains('is-prev') ? 'back' : 'forward', emphasis: 'subtle' }]
  if (el.closest('.lp-back')) return ['navigate', { direction: 'back' }]
  if (el.closest('.view-tabs')) return ['navigate', { direction: el.textContent === 'Loadouts' ? 'back' : 'forward' }]
  if (el.matches('.custom-dropdown-trigger')) return el.classList.contains('open') ? ['close', { emphasis: 'subtle' }] : ['open']
  if (el.matches('[role="tab"], [role="option"], .custom-dropdown-item') || el.closest('.mod-state-filter')) return ['select']
  const label = `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`.trim()
  if (/^(delete|remove)\b/i.test(label)) return ['close', { emphasis: 'strong' }]
  if (/^(close|cancel|dismiss)\b/i.test(label) || el.matches('.modal-close, .close-btn')) return ['close']
  return ['tap', { emphasis: 'subtle' }]
}

let last = 0
document.addEventListener('click', e => {
  const cue = e.target instanceof Element ? cueFor(e.target) : null
  if (!cue || e.timeStamp - last < 40) return // a label's click and the control's own click are one gesture
  last = e.timeStamp
  play(...cue)
}, true)

/** The typing cue's key role, or null for keys that do not edit text (arrows, shortcuts, held-down repeats). */
export function typingKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat'>): 'printable' | 'space' | 'delete' | 'enter' | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return null
  if (e.key === ' ') return 'space'
  if (e.key === 'Backspace' || e.key === 'Delete') return 'delete'
  if (e.key === 'Enter') return 'enter'
  return e.key.length === 1 ? 'printable' : null
}

const isTextField = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLTextAreaElement ||
  (t instanceof HTMLInputElement && /^(text|search|email|url|password|number|tel|)$/.test(t.type)))
document.addEventListener('keydown', e => {
  const key = isTextField(e.target) && !(e.target as HTMLInputElement).readOnly ? typingKey(e) : null
  if (key) play('type', { key })
}, true)

/** A camera shutter (two short filtered noise clicks) for a picture taken in game with Ctrl+Shift+X. primeShutter runs
 *  on the click that opens the capture dialog, so the audio is allowed to start while repakxtra is in the background. */
let shutterCtx: AudioContext | null = null
export const primeShutter = () => { shutterCtx ??= new AudioContext(); shutterCtx.resume().catch(() => undefined) }
export function playShutter() {
  if (!soundOn) return
  primeShutter()
  const ctx = shutterCtx!
  const len = Math.floor(ctx.sampleRate * 0.08)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3
  for (const [at, level] of [[0, 0.45], [0.075, 0.3]]) { // the shutter opening, then closing
    const src = ctx.createBufferSource()
    src.buffer = buf
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = 2600
    band.Q.value = 0.9
    const gain = ctx.createGain()
    gain.gain.value = level
    src.connect(band).connect(gain).connect(ctx.destination)
    src.start(ctx.currentTime + at)
  }
}

/** Alert sounds (AlertHandler): what happened, on top of the click that caused it. */
export function alertSound(color?: string, isLoading?: boolean) {
  if (isLoading) play('loading')
  else if (color === 'success') play('success', { emphasis: 'subtle' })
  else if (color === 'danger') play('error')
  else if (color === 'warning') play('warning')
}

if (import.meta.env.DEV) {
  const b = document.createElement('button')
  b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', 'true')
  console.assert(cueFor(b)?.[0] === 'toggle' && cueFor(b)?.[1]?.direction === 'back', 'switch turning off plays toggle backwards')
  const d = document.createElement('button'); d.title = 'Delete Flames'
  console.assert(cueFor(d)?.[1]?.emphasis === 'strong', 'delete plays a strong close')
  const s = document.createElement('span')
  console.assert(cueFor(s) === null, 'plain text is silent')
  const k = (key: string, more = {}) => typingKey({ key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...more })
  console.assert(k('a') === 'printable' && k(' ') === 'space' && k('Backspace') === 'delete' && k('Enter') === 'enter', 'typing roles')
  console.assert(k('ArrowLeft') === null && k('a', { ctrlKey: true }) === null && k('a', { repeat: true }) === null, 'non-typing keys are silent')
}
