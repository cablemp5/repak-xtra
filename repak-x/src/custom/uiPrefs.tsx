// caleb fork: UI scale and show/hide switches for optional UI, saved in localStorage and applied
// instantly in every window. Show/hide prefs set a data-show-* attribute on <html>; caleb.css hides
// the element when it is absent. UI scale uses the webview zoom, like Ctrl + in a browser.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { invoke } from '@tauri-apps/api/core'
import { ChevronDown, EyeOff, Tags, Trash2 } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
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

type TagMod = { path: string; custom_tags?: string[] }

/** Every tag removed from every mod and the tag list, with Undo (it puts each tag back on the mods that had it). */
async function deleteAllTags(tags: string[], mods: TagMod[], onChanged: () => Promise<unknown>, alert: ReturnType<typeof useAlert>) {
  const had = mods.filter(m => m.custom_tags?.length).map(m => ({ path: m.path, tags: [...m.custom_tags!] }))
  const failed: string[] = []
  for (const tag of tags) await invoke('delete_tag_from_all_mods', { tag }).catch(() => failed.push(tag))
  await onChanged()
  if (failed.length) {
    alert.warning('Some tags stayed', failed.join(', '))
    return
  }
  const id = alert.info(`Deleted ${tags.length} tag${tags.length === 1 ? '' : 's'}`, `Taken off ${had.length} mod${had.length === 1 ? '' : 's'}.`, {
    duration: 12000,
    action: {
      label: 'Undo', onClick: async () => {
        alert.dismissAlert(id)
        for (const tag of tags) await invoke('add_tag_to_catalog', { tag }).catch(() => undefined)
        for (const m of had) for (const tag of m.tags) await invoke('add_custom_tag', { modPath: m.path, tag }).catch(() => undefined)
        await onChanged()
      },
    },
  })
}

/** Tags shown or hidden on mods, said in words (T toggles too); the arrow holds Delete all tags. */
export function TagsToggle({ tags, mods, onChanged, alert }: {
  tags: string[]; mods: TagMod[]; onChanged: () => Promise<unknown>; alert: ReturnType<typeof useAlert>
}) {
  const hidden = useSyncExternalStore(subscribe, tagsHidden)
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) { setMenu(false); setConfirm(false) } }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); setConfirm(false) } }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc, true) }
  }, [menu])
  const tagged = mods.filter(m => m.custom_tags?.length).length
  // the tag list plus any tag a mod carries that the list lacks
  const every = [...new Set([...tags, ...mods.flatMap(m => m.custom_tags ?? [])])]
  return (
    <div className={`tags-toggle-wrap ${hidden ? 'is-hidden' : 'is-shown'}`} ref={wrap}>
      <button type="button" className="tags-toggle" aria-pressed={!hidden} onClick={toggleTags}
        title={hidden ? 'Tags are hidden on mods. Click (or T) to show them' : 'Tags are shown on mods. Click (or T) to hide them'}>
        {hidden ? <EyeOff size={15} /> : <Tags size={15} />}
        <span>{hidden ? 'Tags hidden' : 'Tags shown'}</span>
      </button>
      <button type="button" className="tags-toggle-more" aria-label="More tag actions" aria-haspopup="menu" aria-expanded={menu}
        onClick={() => { setMenu(v => !v); setConfirm(false) }}>
        <ChevronDown size={14} />
      </button>
      {menu && (
        <div className="sigeon-menu tags-menu" role="menu">
          {!confirm ? (
            <button type="button" role="menuitem" className="sigeon-item" disabled={every.length === 0} onClick={() => setConfirm(true)}>
              <span><Trash2 size={14} /> Delete all tags</span><small>{every.length}</small>
            </button>
          ) : (
            <div className="tags-confirm">
              <p>Delete all {every.length} tags and take them off {tagged} mod{tagged === 1 ? '' : 's'}? Undo stays up for a few seconds.</p>
              <div>
                <button type="button" className="lo-text-btn" onClick={() => setConfirm(false)}>Cancel</button>
                <button type="button" className="lo-text-btn tags-confirm-go"
                  onClick={() => { setMenu(false); setConfirm(false); deleteAllTags(every, mods, onChanged, alert) }}>Delete all</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
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
