// repakxtra: UI sounds with cuelume (synthesized live, no audio files), in the pack picked in Settings (mech by default). One click listener maps the
// control under the pointer to a cue and one key listener plays typing in text fields, so upstream components need no
// changes; alerts add success, error, warning and loading. Settings > Interface > Sound effects turns it off (uiPrefs.tsx calls setSoundOn).
import { play as playNow, setEnabled, setTheme, setVolume, themes, unlock, type PlayOptions, type SoundName, type ThemeName } from 'cuelume'

/** cuelume's four packs (default, mech, bubble, press), picked in Settings > Sound effects (uiPrefs.tsx) */
export const SOUND_PACKS = themes
export const soundPackOf = (saved: string | null): ThemeName => themes.includes(saved as ThemeName) ? saved as ThemeName : 'mech'
export const setSoundPack = (saved: string | null) => setTheme(soundPackOf(saved))
setSoundPack(null)
setVolume(0.7)

/** Cues that land together (several toasts at once, background tasks finishing in one tick) used to stack into one
 *  loud pop through cuelume's boosted output. Within this gap a cue plays only when it differs from the ones already
 *  playing and at most two sound (a click and the toast it causes still both play). A cue while the window is hidden is
 *  dropped, so none queue up and burst out together when it comes back. */
const STACK_MS = 60
let recent: { at: number; name: SoundName }[] = [] // the cues admitted in the last STACK_MS, each expiring on its own
// Typing plays every key, but two keys landing a few ms apart (rolled keys) stacked into one loud pop: one per TYPE_MS
const TYPE_MS = 35
let lastType = -Infinity
function admits(name: SoundName, now: number, hidden: boolean) {
  if (hidden) return false
  if (name === 'type') { if (now - lastType < TYPE_MS) return false; lastType = now; return true }
  recent = recent.filter(c => now - c.at < STACK_MS)
  if (recent.length >= 2 || recent.some(c => c.name === name)) return false
  recent.push({ at: now, name })
  return true
}
function play(name: SoundName, options?: PlayOptions) {
  if (admits(name, performance.now(), document.visibilityState === 'hidden')) playNow(name, options)
}

let soundOn = true
export const setSoundOn = (on: boolean) => { soundOn = on; setEnabled(on) }
/** Sound effects on (Settings): emote sounds over animation previews follow it too (emoteSound.ts). */
export const isSoundOn = () => soundOn
export const unlockSound = () => { unlock().catch(() => undefined) }
/** A cue for something that is not a click (dragging a card, cardDrag.ts); silent with Sound effects off. */
export const cue = (name: SoundName, options?: PlayOptions) => play(name, options)
/** A cue in a pack that is not the picked one (the first-launch sound tiles, FirstRun.tsx): heard even with sound off,
 *  and the picked pack stays as it is. */
export const tryCue = (name: SoundName, theme: ThemeName) => {
  if (!soundOn) { setEnabled(true); setTimeout(() => setEnabled(soundOn), 800) } // a short cue, then off again
  play(name, { theme })
}
export type { SoundName, ThemeName }

type Cue = [SoundName, PlayOptions?]

/** Which cue a click on this element plays, or null for silence (plain rows, text, disabled controls). */
export function cueFor(target: Element): Cue | null {
  const el = target.closest('button, a[href], [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="option"], .custom-dropdown-item, input[type="checkbox"]')
  if (!el || el.matches(':disabled, [aria-disabled="true"]')) return null
  if (el.closest('.sound-pack')) return null // the pack picker plays its own cue, in the pack just picked
  const on = el.getAttribute('aria-checked') === 'true' || (el as HTMLInputElement).checked === true
  if (el.matches('[role="switch"], [role="checkbox"], input[type="checkbox"]')) return ['toggle', { direction: on ? 'back' : 'forward' }]
  if (el.closest('.lo-media-arrow')) return ['navigate', { direction: el.classList.contains('is-prev') ? 'back' : 'forward', emphasis: 'subtle' }]
  if (el.closest('.lp-back')) return ['navigate', { direction: 'back' }]
  if (el.closest('.view-tabs')) return ['select'] // Loadouts and Library sound like All, On, and Off
  if (el.matches('.bi-role')) return ['toggle', { direction: el.getAttribute('aria-pressed') === 'true' ? 'back' : 'forward' }] // a role kept or let go
  if (el.matches('.loadout-badge, .vf-loadouts')) return ['navigate', { direction: 'forward' }] // the In loadout tag opens that loadout
  if (el.matches('.sl-count')) return el.getAttribute('aria-expanded') === 'true' ? ['close', { emphasis: 'subtle' }] : ['open'] // Smart loadouts: a group's mods
  if (el.matches('.bi-pick')) return el.getAttribute('aria-expanded') === 'true' ? ['close', { emphasis: 'subtle' }] : ['open'] // Built-in hero picker
  if (el.matches('.custom-dropdown-trigger')) return el.classList.contains('open') ? ['close', { emphasis: 'subtle' }] : ['open']
  // any other menu button (Install's arrow, All/On/Off, the view menu, More): open and close like the dropdowns
  if (el.matches('[aria-haspopup]')) return el.getAttribute('aria-expanded') === 'true' ? ['close', { emphasis: 'subtle' }] : ['open']
  if (el.matches('[role="tab"], [role="option"], [role="menuitemradio"], .custom-dropdown-item') || el.closest('.mod-state-filter')) return ['select']
  if (el.matches('.bulk-delete')) return ['close', { emphasis: 'strong' }] // its title says "Click to delete", not "Delete"
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
  const r = document.createElement('button'); r.className = 'bi-role'; r.setAttribute('aria-pressed', 'false')
  console.assert(cueFor(r)?.[0] === 'toggle' && cueFor(r)?.[1]?.direction === 'forward', 'a role button keeping its heroes toggles forward')
  const s = document.createElement('span')
  console.assert(cueFor(s) === null, 'plain text is silent')
  recent = []
  console.assert(admits('tap', 1000, false) && admits('success', 1010, false) && !admits('error', 1020, false) && !admits('tap', 1030, true),
    'two different cues together, not a third, none while hidden')
  console.assert(!admits('success', 1040, false) && admits('success', 1100, false) && admits('type', 1101, false) && !admits('type', 1110, false) && admits('type', 1200, false), 'no repeat within the gap, typing one per TYPE_MS')
  recent = []
  console.assert(admits('tap', 0, false) && admits('open', 59, false) && admits('close', 60, false) && !admits('select', 61, false),
    'a sliding window: never three cues within the gap, even across its edge')
  recent = []
  console.assert(soundPackOf('bubble') === 'bubble' && soundPackOf(null) === 'mech' && soundPackOf('nope') === 'mech', 'unknown packs fall back to mech')
  const k = (key: string, more = {}) => typingKey({ key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...more })
  console.assert(k('a') === 'printable' && k(' ') === 'space' && k('Backspace') === 'delete' && k('Enter') === 'enter', 'typing roles')
  console.assert(k('ArrowLeft') === null && k('a', { ctrlKey: true }) === null && k('a', { repeat: true }) === null, 'non-typing keys are silent')
}
