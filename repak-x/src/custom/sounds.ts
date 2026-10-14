// caleb fork: UI sounds with cuelume (synthesized live, no audio files), bubble theme. One click listener maps the
// control under the pointer to a cue, so upstream components need no changes; alerts add success, error, warning
// and loading. Settings > Interface > Sound effects turns it off (uiPrefs.tsx calls setSoundOn).
import { play, setEnabled, setTheme, setVolume, unlock, type PlayOptions, type SoundName } from 'cuelume'

setTheme('bubble')
setVolume(0.7)

export const setSoundOn = (on: boolean) => setEnabled(on)
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
  if (el.closest('.view-tabs')) return ['navigate', { direction: el.textContent === 'Home' ? 'back' : 'forward' }]
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
}
