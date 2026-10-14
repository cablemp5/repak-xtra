// caleb fork: UI scale and show/hide switches for optional UI, saved in localStorage and applied
// instantly in every window. Show/hide prefs set a data-show-* attribute on <html>; caleb.css hides
// the element when it is absent. UI scale uses the webview zoom, like Ctrl + in a browser.
import { useSyncExternalStore } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { Tags } from 'lucide-react'
import { MotionGlobalConfig } from 'framer-motion'
import Checkbox from '../components/ui/Checkbox'
import { setSoundOn, unlockSound } from './sounds'

const PREFS = [
  { key: 'priority', label: 'Show load priority counter on mods' },
  { key: 'asset-explorer', label: 'Show Asset Explorer button' },
  { key: 'share', label: 'Show Share button' },
  { key: 'tools', label: 'Show Tools button' },
] as const

const SCALES = [0.9, 1, 1.1, 1.25, 1.4, 1.5]
const SCALE_KEY = 'caleb.uiScale'
const HIDE_TAGS_KEY = 'caleb.hideTags' // tags show by default, so this one stores the hidden state
const SOUND_KEY = 'caleb.sound'   // on by default: '0' = off
const MOTION_KEY = 'caleb.motion' // on by default: '0' = off

const storageKey = (key: string) => `caleb.show.${key}`
const listeners = new Set<() => void>()

const isOn = (key: string) => localStorage.getItem(storageKey(key)) === '1'
const getScale = () => Number(localStorage.getItem(SCALE_KEY)) || 1
const tagsHidden = () => localStorage.getItem(HIDE_TAGS_KEY) === '1'
const soundOn = () => localStorage.getItem(SOUND_KEY) !== '0'
const motionOn = () => localStorage.getItem(MOTION_KEY) !== '0'

const apply = () => {
  PREFS.forEach(({ key }) => document.documentElement.toggleAttribute(`data-show-${key}`, isOn(key)))
  document.documentElement.toggleAttribute('data-hide-tags', tagsHidden())
  // Motion off: caleb.css zeroes every CSS transition and animation, framer-motion jumps to the end state
  document.documentElement.setAttribute('data-motion', motionOn() ? 'on' : 'off')
  MotionGlobalConfig.skipAnimations = !motionOn()
  setSoundOn(soundOn())
  getCurrentWebview().setZoom(getScale()).catch(e => console.warn('[uiPrefs] zoom failed', e))
}
apply()
// Ctrl + / Ctrl - step through the scales, Ctrl 0 resets to 100%
window.addEventListener('keydown', e => {
  if (!e.ctrlKey || e.altKey) return
  const i = SCALES.indexOf(getScale())
  const step = e.key === '=' || e.key === '+' ? 1 : e.key === '-' || e.key === '_' ? -1 : e.key === '0' ? 0 : null
  if (step === null) return
  e.preventDefault()
  const next = step === 0 ? 1 : SCALES[Math.max(0, Math.min(SCALES.length - 1, (i < 0 ? SCALES.indexOf(1) : i) + step))]
  update(SCALE_KEY, String(next))
})
// Other windows (Asset Explorer, VFX Updater) pick up changes made in Settings
window.addEventListener('storage', e => { if (e.key?.startsWith('caleb.')) { apply(); listeners.forEach(l => l()) } })

const update = (key: string, value: string) => {
  localStorage.setItem(key, value)
  apply()
  listeners.forEach(l => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Show or hide the custom tag chips on mods (T, or the button next to the tag filter). */
export const toggleTags = () => update(HIDE_TAGS_KEY, tagsHidden() ? '0' : '1')

export function TagsToggle() {
  const hidden = useSyncExternalStore(subscribe, tagsHidden)
  return (
    <button type="button" className="btn-icon tags-toggle" aria-pressed={!hidden} onClick={toggleTags}
      title={hidden ? 'Show tags on mods (T)' : 'Hide tags on mods (T)'}>
      <Tags size={18} />
    </button>
  )
}

export default function CalebUiSettings() {
  const snapshot = useSyncExternalStore(subscribe, () => PREFS.map(p => (isOn(p.key) ? 1 : 0)).join('') + '|' + getScale() + '|' + soundOn() + motionOn())
  const scale = getScale()
  return (
    <>
      <div className="setting-section">
        <h3>UI scale</h3>
        <p className="setting-subtext">UI scale, sound and motion, and optional controls apply right away; Save and Cancel cover the rest.</p>
        <div className="setting-group">
          <div className="mod-state-filter ui-scale" role="group" aria-label="UI scale">
            {SCALES.map(s => (
              <button key={s} type="button" aria-pressed={scale === s} onClick={() => update(SCALE_KEY, String(s))}>
                {Math.round(s * 100)}%
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="setting-section">
        <h3>Sound and motion</h3>
        <div className="setting-group">
          <div className="setting-item">
            <Checkbox checked={soundOn()} onChange={(checked: boolean) => { update(SOUND_KEY, checked ? '1' : '0'); if (checked) unlockSound() }}>
              <span>Sound effects</span>
            </Checkbox>
            <p className="setting-subtext">Mechanical click sounds on clicks, typing, switches, menus, page changes and alerts.</p>
          </div>
          <div className="setting-item">
            <Checkbox checked={motionOn()} onChange={(checked: boolean) => update(MOTION_KEY, checked ? '1' : '0')}>
              <span>Animations</span>
            </Checkbox>
            <p className="setting-subtext">Page slides, menus, switches and toasts. Off stops every animation in the app, including the extra animations below.</p>
          </div>
        </div>
      </div>
      <div className="setting-section">
        <h3>Optional controls</h3>
        <div className="setting-group">
          {PREFS.map(({ key, label }, i) => (
            <div className="setting-item" key={key}>
              <Checkbox checked={snapshot[i] === '1'} onChange={(checked: boolean) => update(storageKey(key), checked ? '1' : '0')}>
                <span>{label}</span>
              </Checkbox>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
