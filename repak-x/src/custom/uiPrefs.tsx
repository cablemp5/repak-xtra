import { EXTENDED } from './edition'
// repakxtra: UI scale and show/hide switches for optional UI, saved in localStorage and applied
// instantly in every window. Show/hide prefs set a data-show-* attribute on <html>; theme.css hides
// the element when it is absent. UI scale uses the webview zoom, like Ctrl + in a browser.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { invoke } from '@tauri-apps/api/core'
import { ChevronDown, Download, EyeOff, PanelTop, Tags, Trash2, TriangleAlert, Volume2, ZoomIn } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { MotionGlobalConfig } from 'framer-motion'
import Checkbox from '../components/ui/Checkbox'
import { cue, setSoundOn, unlockSound } from './sounds'
import { savedItem } from './storageCarryOver'

// `on`: shown until switched off (the rest start hidden). Stored as '1' or '0' once changed.
// `group`: the Settings section it is drawn in (Header buttons, On each mod), or its own place elsewhere.
const PREFS: { key: string; label: string; on?: boolean; group?: 'header' | 'mod' | 'warn' }[] = [
  { key: 'vfx-updater', label: 'VFX Updater', on: true, group: 'header' },
  { key: 'encrypt', label: 'Encrypt', group: 'header' }, // hidden by default: Settings > Header buttons shows it
  ...(EXTENDED ? [{ key: 'sigeon', label: 'Sigeon', group: 'header' as const }] : []), // hidden by default: Settings > Interface shows it
  { key: 'asset-explorer', label: 'Asset Explorer', group: 'header' },
  { key: 'share', label: 'Share', group: 'header' },
  { key: 'tools', label: 'Tools', group: 'header' },
  { key: 'mod-size', label: 'File size', group: 'mod' },
  { key: 'priority', label: 'Load priority counter (P)', group: 'mod' },
  { key: 'nexus', label: 'Nexus tag on mods installed from Nexus Mods', on: true, group: 'mod' },
  { key: 'loadout-tag', label: 'In loadout tag, the loadouts a mod is in (I)', group: 'mod' },
  { key: 'encrypted', label: 'Encrypted tag on encrypted mods, and the Encrypted tab (E)', on: true, group: 'mod' },
  { key: 'broken', label: 'Broken and May crash warnings, and the Problems tab (B)', on: true, group: 'warn' },
  { key: 'conflicts', label: 'Conflict warnings, the badge, and the count on Check Conflicts (Shift+C)', on: true, group: 'warn' },
  { key: 'quick-organize', label: 'Show Quick Organize when dropping files on the window' }, // shown under Installing mods
  { key: 'new-strip', label: 'New this week on the Loadouts screen' }, // off by default (NewStripPref)
  { key: 'builtins', label: 'Built-in mods on the Loadouts screen and in the Library', on: true }, // shown by default (BuiltinsPref)
]

// 100% draws the app at the webview's 120% (what was the old 125% step, a little smaller); the rest scale from there.
// A new key: everyone starts at the new 100%, the old repakxtra.uiScale is no longer read.
const SCALES = [75, 90, 100, 110, 125]
const BASE_ZOOM = 1.2
const SCALE_KEY = 'repakxtra.uiScale2'
const HIDE_TAGS_KEY = 'repakxtra.hideTags' // tags show by default, so this one stores the hidden state
const SOUND_KEY = 'repakxtra.sound'   // on by default: '0' = off
// unset or 'system' = follow Windows (System), '1' = on, '0' = off. System is saved, not removed: storageCarryOver would
// copy an old-prefix '0' back over a missing key at the next start.
const MOTION_KEY = 'repakxtra.motion'
// unset = automatic (on for a PC with 4 CPU threads or fewer, or 4 GB of memory or less), '1' = on, '0' = off
const LITE_KEY = 'repakxtra.lite'
const MINIMAL_TOASTS_KEY = 'repakxtra.minimalToasts' // off by default: '1' = on (shown as Fewer pop-ups)
const DEFAULTS_KEY = 'repakxtra.defaults.v2'
const PLAIN_INSTALL_KEY = 'repakxtra.install.plain' // off by default: '1' = the install dialog starts without a loadout
const TAGS_OFF_KEY = 'repakxtra.tagsOff' // tag features hidden by default: '0' = shown

const storageKey = (key: string) => `repakxtra.show.${key}`
const listeners = new Set<() => void>()

const isOn = (key: string) => { if (key === 'sigeon' && !EXTENDED) return false; const v = savedItem(storageKey(key)); return v === null ? Boolean(PREFS.find(p => p.key === key)?.on) : v === '1' }
const getScale = () => { const s = Number(savedItem(SCALE_KEY)); return SCALES.includes(s) ? s : 100 }
const tagsHidden = () => savedItem(HIDE_TAGS_KEY) === '1'
const soundOn = () => savedItem(SOUND_KEY) !== '0'
/** Animations on: a saved '1' or '0' is the user's choice, anything else follows the OS reduce motion setting.
 *  index.html repeats this for the splash, before any module runs. */
export const resolveMotion = (saved: string | null, osReduce: boolean) => saved === '1' ? true : saved === '0' ? false : !osReduce
const reduceQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
const motionOn = () => resolveMotion(savedItem(MOTION_KEY), !!reduceQuery?.matches)
/** Lighter graphics on (blur and glass effects off, theme.css data-lite): a saved '1' or '0' is the user's choice,
 *  anything else turns it on for a weak PC. `memoryGb` is navigator.deviceMemory (in GB, WebView2 has it). */
export const resolveLite = (saved: string | null, threads: number, memoryGb?: number) =>
  saved === '1' ? true : saved === '0' ? false : threads <= 4 || (memoryGb !== undefined && memoryGb <= 4)
export const liteOn = () => resolveLite(savedItem(LITE_KEY), navigator.hardwareConcurrency || 8, (navigator as { deviceMemory?: number }).deviceMemory)
const minimalToasts = () => savedItem(MINIMAL_TOASTS_KEY) === '1'
/** Fewer pop-ups is on (Settings): a show/hide hotkey's toast stays away, its sound still plays. */
export const fewerPopups = minimalToasts
const tagsOff = () => savedItem(TAGS_OFF_KEY) !== '0'
const amoledOn = () => EXTENDED && savedItem(AMOLED_KEY) === '1'
/** Settings > Install mods without a loadout: the install dialog opens on Install without a loadout. */
export const installsPlain = () => savedItem(PLAIN_INSTALL_KEY) === '1'

/** Settings that changed their default reach installs made before the change, once: opening the details panel on a
 *  click and hold to delete both start off (App applies this to the loaded settings and saves it). */
export function newDefaultsOnce<T extends { autoOpenDetails?: boolean; holdToDelete?: boolean }>(settings: T): T {
  if (localStorage.getItem(DEFAULTS_KEY)) return settings
  localStorage.setItem(DEFAULTS_KEY, '1')
  const next = { ...settings, autoOpenDetails: false, holdToDelete: false }
  invoke('save_app_settings', { settings: next }).catch(e => console.warn('[uiPrefs] new defaults not saved', e))
  return next
}

/** Fewer pop-ups (stored as minimal toasts): an everyday confirmation (success or info with nothing to click, not a progress toast) is skipped.
 *  Errors, warnings, crash reports, update offers and deletions (they carry Undo) still show. */
export const quietToast = (t: { color?: string; action?: unknown; isLoading?: boolean }) =>
  minimalToasts() && (!t.color || t.color === 'success' || t.color === 'primary' || t.color === 'default') && !t.action && !t.isLoading

const apply = () => {
  document.documentElement.toggleAttribute('data-amoled', amoledOn())
  PREFS.forEach(({ key }) => document.documentElement.toggleAttribute(`data-show-${key}`, isOn(key)))
  document.documentElement.toggleAttribute('data-hide-tags', tagsHidden())
  document.documentElement.toggleAttribute('data-tags-off', tagsOff()) // theme.css hides the tags on mods
  // Motion off: theme.css zeroes every CSS transition and animation, framer-motion jumps to the end state
  document.documentElement.setAttribute('data-motion', motionOn() ? 'on' : 'off')
  document.documentElement.toggleAttribute('data-lite', liteOn()) // theme.css drops blur and glass
  MotionGlobalConfig.skipAnimations = !motionOn()
  setSoundOn(soundOn())
  getCurrentWebview().setZoom(getScale() / 100 * BASE_ZOOM).catch(e => console.warn('[uiPrefs] zoom failed', e))
}
apply()
// Ctrl + / Ctrl - step through the scales, Ctrl 0 resets to 100%
window.addEventListener('keydown', e => {
  if (!e.ctrlKey || e.altKey) return
  const i = SCALES.indexOf(getScale())
  const step = e.key === '=' || e.key === '+' ? 1 : e.key === '-' || e.key === '_' ? -1 : e.key === '0' ? 0 : null
  if (step === null) return
  e.preventDefault()
  const next = step === 0 ? 100 : SCALES[Math.max(0, Math.min(SCALES.length - 1, (i < 0 ? SCALES.indexOf(100) : i) + step))]
  update(SCALE_KEY, String(next))
})
// Other windows (Asset Explorer, VFX Updater) pick up changes made in Settings
window.addEventListener('storage', e => { if (e.key?.startsWith('repakxtra.')) { apply(); listeners.forEach(l => l()) } })
// Animations not chosen yet: every window follows a Windows change while it runs (this module lives as long as the window)
reduceQuery?.addEventListener('change', () => { apply(); listeners.forEach(l => l()) })

const update = (key: string, value: string) => {
  localStorage.setItem(key, value)
  apply()
  listeners.forEach(l => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Whether a show/hide pref is on, re-rendering when it changes (e.g. 'mod-size'). */
export const useUiPref = (key: string) => useSyncExternalStore(subscribe, () => isOn(key))
/** Broken mod warnings are on (Settings > On each mod): read where a hook cannot be (runChanges' toasts). */
export const brokenShown = () => isOn('broken')

/** Flips a show/hide pref (the Library's P, I, B and Shift+C) and says so: App shows the toast, whose Undo flips it
 *  back (setPref). */
export const PREF_TOGGLED = 'repakxtra-pref-toggled'
export type PrefToggled = { key: string; name: string; on: boolean }
export function togglePref(key: string, name: string) {
  const on = !isOn(key)
  update(storageKey(key), on ? '1' : '0')
  cue('toggle', { direction: on ? 'forward' : 'back' }) // a switch flipped: the same sound as clicking it in Settings
  window.dispatchEvent(new CustomEvent<PrefToggled>(PREF_TOGGLED, { detail: { key, name, on } }))
}

/** Sets a show/hide pref to a given state, quietly (a toggle toast's Undo puts back the state from before its press). */
export const setPref = (key: string, on: boolean) => update(storageKey(key), on ? '1' : '0')

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
/** Tags off (Settings > On each mod > Tags, off by default): no tags on mods, no tag filter, Tags button or Assign Tag. */
export const useTagsOff = () => useSyncExternalStore(subscribe, tagsOff)

export function TagsToggle(props: Parameters<typeof TagsToggleButton>[0]) {
  return useTagsOff() ? null : <TagsToggleButton {...props} />
}

function TagsToggleButton({ tags, mods, onChanged, alert }: {
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

/** One show/hide pref as a checkbox (applies right away, in every window). */
function PrefBox({ k, label }: { k: string; label: string }) {
  const on = useSyncExternalStore(subscribe, () => isOn(k))
  return (
    <div className="setting-item">
      <Checkbox checked={on} onChange={(checked: boolean) => update(storageKey(k), checked ? '1' : '0')}><span>{label}</span></Checkbox>
    </div>
  )
}
const useAll = () => useSyncExternalStore(subscribe, () => PREFS.map(p => (isOn(p.key) ? 1 : 0)).join('') + '|' + getScale() + '|' + soundOn() + motionOn() + liteOn() +minimalToasts() + installsPlain() + tagsOff() + amoledOn())

export function AmoledSection({ onEnable }: { onEnable: () => void }) {
  useAll()
  if (!EXTENDED) return null
  return (
    <div className="setting-section">
      <h3>Appearance</h3>
      <div className="setting-group">
        <div className="setting-item">
          <Checkbox checked={amoledOn()} onChange={(checked: boolean) => {
            if (checked) onEnable()
            update(AMOLED_KEY, checked ? '1' : '0')
          }}><span>AMOLED black theme</span></Checkbox>
          <p className="setting-subtext">Pure-black backgrounds with subtle borders to keep panels and controls clear.</p>
        </div>
      </div>
    </div>
  )
}

/** Settings > Interface, top: UI scale. */
export function UiScaleSection() {
  useAll()
  const scale = getScale()
  return (
    <div className="setting-section">
      <h3 className="setting-icon-label"><ZoomIn size={18} aria-hidden="true" />UI scale</h3>
      <div className="setting-group">
        <div className="mod-state-filter ui-scale" role="group" aria-label="UI scale">
          {SCALES.map(s => (
            <button key={s} type="button" aria-pressed={scale === s} onClick={() => update(SCALE_KEY, String(s))}>{s}%</button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Sound, motion and pop-ups. `extra` is the card animations setting (App state), drawn under Animations. */
export function MotionSection({ extra }: { extra?: React.ReactNode }) {
  useAll()
  return (
    <div className="setting-section">
      <h3 className="setting-icon-label"><Volume2 size={18} aria-hidden="true" />Sound, motion, and pop-ups</h3>
      <div className="setting-group">
        <div className="setting-item">
          <Checkbox checked={soundOn()} onChange={(checked: boolean) => { update(SOUND_KEY, checked ? '1' : '0'); if (checked) unlockSound() }}>
            <span>Sound effects</span>
          </Checkbox>
          <p className="setting-subtext">Click sounds on buttons, typing, switches, and alerts, and an emote's sound when you hover its preview.</p>
        </div>
        <div className="setting-item">
          <Checkbox checked={motionOn()} onChange={(checked: boolean) => update(MOTION_KEY, checked ? '1' : '0')}>
            <span>Animations</span>
          </Checkbox>
          <p className="setting-subtext">Page slides, menus, switches, and pop-ups. Unchecked stops every animation in the app. Until you change it, it follows the Windows animation effects setting.</p>
          {extra && <div className={`setting-sub${motionOn() ? '' : ' is-off'}`}>{extra}</div>}
        </div>
        <div className="setting-item">
          <Checkbox checked={liteOn()} onChange={(checked: boolean) => update(LITE_KEY, checked ? '1' : '0')}>
            <span>Lighter graphics</span>
          </Checkbox>
          <p className="setting-subtext">Skips blur and glass effects, the heaviest part to draw on a slower PC. Until you change it, it turns on by itself on a PC with 4 CPU threads or fewer, or 4 GB of memory or less.</p>
        </div>
        <div className="setting-item">
          <Checkbox checked={minimalToasts()} onChange={(checked: boolean) => update(MINIMAL_TOASTS_KEY, checked ? '1' : '0')}>
            <span>Fewer pop-ups</span>
          </Checkbox>
          <p className="setting-subtext">Skips the small messages after everyday actions like switching loadouts or installing mods. Errors, warnings, updates, and deletions you can undo still show.</p>
        </div>
      </div>
    </div>
  )
}

/** Installing mods. */
export function InstallingSection() {
  useAll()
  return (
    <div className="setting-section">
      <h3 className="setting-icon-label"><Download size={18} aria-hidden="true" />Installing mods</h3>
      <div className="setting-group">
        <div className="setting-item">
          <Checkbox checked={installsPlain()} onChange={(checked: boolean) => update(PLAIN_INSTALL_KEY, checked ? '1' : '0')}>
            <span>Install mods without a loadout by default (classic Repak X installer)</span>
          </Checkbox>
          <p className="setting-subtext">The install window starts on Install without a loadout. Save as a loadout stays one click away in it.</p>
        </div>
        <div className="setting-item">
          <Checkbox checked={isOn('quick-organize')} onChange={(checked: boolean) => update(storageKey('quick-organize'), checked ? '1' : '0')}>
            <span>Show Quick Organize when dropping files on the window</span>
          </Checkbox>
          <p className="setting-subtext">A second panel beside Install while you drag files in, for dropping them straight into a folder.</p>
        </div>
      </div>
    </div>
  )
}

/** Header buttons: the optional buttons at the top of the window. */
export function HeaderButtonsSection() {
  useAll()
  return (
    <div className="setting-section">
      <h3 className="setting-icon-label"><PanelTop size={18} aria-hidden="true" />Header buttons</h3>
      <div className="setting-group">
        <p className="setting-hint">Which of the optional buttons show at the top of the window.</p>
        {PREFS.filter(p => p.group === 'header').map(p => <PrefBox key={p.key} k={p.key} label={p.label} />)}
      </div>
    </div>
  )
}

/** The show/hide prefs drawn in On each mod (the App-state ones come first, passed in by SettingsPanel), and tags. */
export function ModPrefs() {
  useAll()
  return (
    <>
      {PREFS.filter(p => p.group === 'mod').map(p => <PrefBox key={p.key} k={p.key} label={p.label} />)}
      <div className="setting-item">
        <Checkbox checked={!tagsOff()} onChange={(checked: boolean) => update(TAGS_OFF_KEY, checked ? '0' : '1')}>
          <span>Tags</span>
        </Checkbox>
        <p className="setting-subtext">Tags on mods, the tag filter, the tags button, and Assign Tag. Off keeps your tags, just out of sight.</p>
      </div>
    </>
  )
}

/** Settings > Library: Hide New this week, checked (hidden) until switched off. */
export function NewStripPref() {
  const shown = useUiPref('new-strip')
  return (
    <div className="setting-item">
      <Checkbox checked={shown} onChange={(checked: boolean) => update(storageKey('new-strip'), checked ? '1' : '0')}>
        <span>Show New this week on the Loadouts screen</span>
      </Checkbox>
      <p className="setting-subtext">The strip of mods added in the last 7 days that no loadout turns on.</p>
    </div>
  )
}

/** Settings > Library: Hide built-in mods, unchecked (shown) until switched on. */
export function BuiltinsPref() {
  const shown = useUiPref('builtins')
  return (
    <div className="setting-item">
      <Checkbox checked={!shown} onChange={(checked: boolean) => update(storageKey('builtins'), checked ? '0' : '1')}>
        <span>Hide built-in mods</span>
      </Checkbox>
      <p className="setting-subtext">{EXTENDED ? 'Force default skin, CustomQuake, and Skip startup logos' : 'Skip startup logos'}, on the Loadouts screen and in the Library. Uncheck to turn them on.</p>
    </div>
  )
}

/** Warnings: the show/hide prefs that flag a mod (Broken, May crash, conflicts), their own section under On each mod. */
export function WarningPrefs() {
  useAll()
  return (
    <div className="setting-section">
      <h3 className="setting-icon-label"><TriangleAlert size={18} aria-hidden="true" />Warnings</h3>
      <div className="setting-group">
        {PREFS.filter(p => p.group === 'warn').map(p => <PrefBox key={p.key} k={p.key} label={p.label} />)}
      </div>
    </div>
  )
}

/** Every Interface setting kept in this file back to how it starts (App's own ones are reset by SettingsPanel). */
export function resetUiPrefs() {
  if (EXTENDED) localStorage.removeItem(AMOLED_KEY)
  for (const p of PREFS) localStorage.removeItem(storageKey(p.key))
  for (const k of [SCALE_KEY, SOUND_KEY, MOTION_KEY, LITE_KEY, MINIMAL_TOASTS_KEY, PLAIN_INSTALL_KEY, TAGS_OFF_KEY, HIDE_TAGS_KEY]) localStorage.removeItem(k)
  apply()
  listeners.forEach(l => l())
}

if (import.meta.env.DEV) {
  console.assert(resolveMotion(null, false) === true && resolveMotion(null, true) === false, 'unset Animations follows the OS reduce motion setting')
  console.assert(resolveMotion('1', true) === true && resolveMotion('0', false) === false, 'a saved 1 or 0 overrides the OS')
  console.assert(resolveMotion('junk', true) === false, 'an unknown saved value counts as System')
  console.assert(resolveLite(null, 4) && resolveLite(null, 16, 4) && !resolveLite(null, 8, 8) && !resolveLite(null, 16), 'unset Lighter graphics follows the PC')
  console.assert(resolveLite('0', 2, 2) === false && resolveLite('1', 32, 8) === true, 'a saved 1 or 0 overrides the PC')
}
