// repakxtra: the install dialog (in place of components/InstallModPanel.tsx, same props and the same install settings
// handed to App). Loadout first: what is being made is a loadout, so the dialog is that loadout, laid out like its page.
// Its picture, its name (the dialog's title, ready to type), its collection and its preview on top. Below, the dropped
// mods as its contents, each opening to its file name, folder and the four install switches. The loadout can also be
// one that exists (the mods join it: the default when installing from its page). Installing without a loadout is a
// quiet link in the footer, not a checkbox to find.
import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Camera, ChevronDown, ImagePlus, Pencil, Type, WandSparkles, X } from 'lucide-react'
import Switch from '../components/ui/Switch'
import Checkbox from '../components/ui/Checkbox'
import CustomDropdown from '../components/CustomDropdown'
import bundledHeroes from '../data/character_data.json'
import { type CharacterDataEntry, FALLBACK_HERO_ID, resolveHeroImage, useHeroImages } from '../utils/heroImages'
import { commitInstallLoadout, setInstallDraft, startingLoadouts } from './installLoadout'
import { optionsOn } from './InstallAdvanced'
import { OTHER, OTHER_LABEL, addGroup, useGroups, useLoadouts } from './loadoutStore'
import { useMediaUrl } from './loadoutMedia'
import { silhouetteOf } from './silhouettes'
import { installsPlain } from './uiPrefs'
import { PreviewsUnavailable, usePreviewsAvailable } from './previews'
import { useDialogFocus } from './dialogFocus'
// Not for this dialog: the dropdown, switch tile and button styles other dialogs share (they loaded with InstallModPanel)
import '../components/InstallModPanel.css'
import './install.css'
// Each hero's default skin as a shape (rendered once by the preview kit's renderer, Claude Assisted Mods
// Misc/previews/cover_test/heroes.py), shown on the cover until the loadout's own preview exists

type Folder = { id: string; name: string; is_root?: boolean }
type ModInput = {
  path: string; mod_name?: string; mod_type?: string; is_dir?: boolean
  contains_uassets?: boolean; contains_raw_assets?: boolean; auto_to_repak?: boolean; auto_force_legacy?: boolean
  [key: string]: unknown
}
type ModSetting = {
  enabled: boolean; obfuscate: boolean; toRepak: boolean; forceLegacy: boolean; hybrid: boolean; compression: string
  customName: string; selectedTags: string[]; loadouts?: string[]; installSubfolder: string | null; path: string
}
type Props = {
  mods: ModInput[]
  allTags: string[]
  folders?: Folder[]
  currentFolderId?: string
  onCreateTag?: (tag: string) => void
  onDeleteTag?: (tag: string) => void
  onCreateFolder?: (name: string) => Promise<string | null>
  onInstall: (modsWithSettings: any[]) => void // eslint-disable-line @typescript-eslint/no-explicit-any
  onCancel: () => void
  onNewTag: (callback: (tag: string) => void) => void
  onNewFolder: (callback: (name: string) => void) => void
  onMergeHybrid?: (path1: string, path2: string) => void
  characterData?: CharacterDataEntry[]
}

/** The dropdown's value for the mods folder itself (an empty value reads as nothing picked). */
const ROOT = '__root'
/** The loadout picker's values for a new loadout and for none (the rest are loadout ids). */
const NEW = '__new'
const NONE = '__none'

/** A folder drop is never repaked (InstallModPanel's rule). */
const repakLocked = (mod: ModInput) => Boolean(mod.is_dir)

/** The starting switches for each dropped mod, the same as InstallModPanel's. */
const initialSetting = (mod: ModInput, currentFolderId?: string): ModSetting => {
  const canPatch = mod.contains_uassets !== false
  const hybrid = Boolean(mod.contains_uassets && mod.contains_raw_assets)
  const toRepak = hybrid ? true : !canPatch ? false : repakLocked(mod) ? false : Boolean(mod.auto_to_repak)
  const forceLegacy = hybrid ? false : mod.contains_uassets === false ? true : Boolean(mod.auto_force_legacy)
  return {
    enabled: true, obfuscate: false, toRepak, forceLegacy, hybrid, compression: 'Oodle', customName: '', selectedTags: [],
    installSubfolder: currentFolderId && currentFolderId !== 'all' ? currentFolderId : null, path: mod.path,
  }
}

/** "Character - Category [Extra, More]" split apart, as InstallModPanel reads it. */
function parseModType(modType?: string) {
  if (!modType) return { character: null as string | null, category: 'Unknown', additional: [] as string[] }
  const additional = modType.match(/\[(.*?)\]/)?.[1].split(',').map(s => s.trim()) ?? []
  const base = modType.replace(/\[.*?\]/, '').trim()
  const parts = base.split(' - ')
  return parts.length >= 2
    ? { character: parts.slice(0, -1).join(' - '), category: parts[parts.length - 1], additional }
    : { character: null, category: base, additional }
}

/** The name a mod reads as: its file name without the extension and the load priority suffix. */
export const plainName = (name = '') => name.replace(/\.(pak|off|zip|rar|7z)$/i, '').replace(/\.pak$/i, '').replace(/_\d+_P$/i, '')

/** Pure: a name field's value once Enter commits it: trimmed, and empty means the suggested name (null). */
export const committedName = (v: string) => v.trim() || null
/** Enter in a name field commits the name and stays there: it never installs (only the Install button does). An IME
 *  finishing a word with Enter is left alone. */
const enterCommits = (commit: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
  e.preventDefault()
  e.stopPropagation()
  commit()
}

const badge = (s: string) => `${s.toLowerCase().replace(/\s+/g, '-')}-badge`

/** A name for the new loadout: the one mod's name, the hero every mod shares, or New loadout. Pure. */
export function suggestName(mods: { name: string; character: string | null }[]) {
  if (mods.length === 1) return mods[0].name || 'New loadout'
  const heroes = new Set(mods.map(m => m.character?.split(' - ')[0] ?? null))
  const [hero] = heroes
  return heroes.size === 1 && hero && !hero.startsWith('Multiple') ? hero : 'New loadout'
}

/** New loadout or Add to one, said in words above the name with a small chevron (a quiet menu, not a boxed dropdown).
 *  The menu is drawn like the Collection dropdown: the loadouts to add to (long names cut short, the picked one a soft
 *  fill), then a line and + New loadout at the foot. Esc closes the menu, not the dialog. */
function TargetPicker({ options, value, onChange }: { options: { value: string; label: string; name?: string }[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    wrap.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); wrap.current?.querySelector<HTMLButtonElement>('.ip-target-btn')?.focus(); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const all = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
      const at = all.indexOf(document.activeElement as HTMLButtonElement)
      all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
    }
    document.addEventListener('mousedown', outside)
    window.addEventListener('keydown', keys, true)
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('keydown', keys, true) }
  }, [open])
  const current = options.find(o => o.value === value)?.label ?? options[0]?.label
  return (
    <div className="ip-target" ref={wrap}>
      <button type="button" className="ip-target-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}
        title="Make a new loadout, or add these mods to one you have">
        {current}<ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="sigeon-menu ip-target-menu" role="menu" aria-label="Which loadout">
          {[...options.slice(1), options[0]].map((o, i, all) => (
            <div key={o.value} className="ip-target-group">
              {i === all.length - 1 && all.length > 1 && <div className="ip-target-sep" role="separator" />}
              <button type="button" role="menuitemradio" aria-checked={o.value === value} className={`sigeon-item${o === options[0] ? ' is-new' : ''}`}
                title={o.name ?? o.label} onClick={() => { onChange(o.value); setOpen(false) }}>
                <span className="ip-target-name">{o === options[0] ? `+ ${o.label}` : o.name ?? o.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** An existing loadout's own picture, for the cover when the mods join it. */
function Cover({ id, rev, image }: { id: string; rev?: number; image?: string }) {
  const url = useMediaUrl(id, rev) ?? image
  return url ? <img src={url} alt="" /> : null
}

export default function InstallPanel({ mods, folders = [], currentFolderId, onCreateFolder, onInstall, onCancel, onNewFolder, onMergeHybrid, characterData }: Props) {
  useHeroImages()
  const heroes = characterData?.length ? characterData : (bundledHeroes as CharacterDataEntry[])
  const loadouts = useLoadouts()
  const groups = useGroups()
  const canGenerate = usePreviewsAvailable()
  const [settings, setSettings] = useState<ModSetting[]>(() => mods.map(m => initialSetting(m, currentFolderId)))
  // Installing from a loadout's page: that loadout. Otherwise a new one, or none with Settings' classic installer
  const [target, setTarget] = useState(() => startingLoadouts()[0] ?? (installsPlain() ? NONE : NEW))
  const [name, setName] = useState<string | null>(null) // null: untouched, the suggested name shows (and follows the mods)
  const titleRef = useRef<HTMLInputElement>(null)
  const [label, setLabel] = useState(OTHER)
  const [naming, setNaming] = useState(false) // the collection picker's + New collection: a name field in its place
  const [preview, setPreview] = useState(true)
  const [open, setOpen] = useState<Set<string>>(new Set()) // mod rows showing their details, by path
  // A second drop while open adds to the list: rows already here keep what was typed or switched
  useEffect(() => {
    setSettings(prev => mods.map(m => prev.find(s => s.path === m.path) ?? initialSetting(m, currentFolderId)))
  }, [mods]) // eslint-disable-line react-hooks/exhaustive-deps
  const update = (i: number, patch: Partial<ModSetting>) => {
    if ('toRepak' in patch && repakLocked(mods[i])) delete patch.toRepak
    setSettings(prev => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  }
  const toggleOpen = (path: string) => setOpen(prev => { const next = new Set(prev); if (!next.delete(path)) next.add(path); return next })

  const rootFolder = folders.find(f => f.is_root)
  const subfolders = useMemo(() => folders.filter(f => !f.is_root).sort((a, b) => a.id.localeCompare(b.id)), [folders])
  const folderOptions = [
    { value: ROOT, label: rootFolder?.name ?? '~mods' },
    ...subfolders.map(f => ({ value: f.id, label: f.id.split(/[/\\]/).join(' / ') })),
  ]
  const folderOf = (s: ModSetting) => (!s.installSubfolder || s.installSubfolder === rootFolder?.id ? ROOT : s.installSubfolder)
  const newFolderFor = (i: number) => onNewFolder(async folder => {
    if (!folder?.trim() || !onCreateFolder) return
    const id = await onCreateFolder(folder.trim()).catch(() => null)
    if (id) update(i, { installSubfolder: id })
  })

  const parsed = mods.map(m => parseModType(m.mod_type))
  const picked = mods.map((_, i) => i).filter(i => settings[i]?.enabled !== false)
  const count = picked.length
  // The cover's hero: the one the picked mods share, else the first picked mod's (a mod of no hero: no shape)
  const coverShape = silhouetteOf(picked.map(i => parsed[i].character?.split(' - ')[0]).find(h => h && !h.startsWith('Multiple')))
  const suggestion = suggestName(picked.map(i => ({ name: settings[i]?.customName || plainName(mods[i].mod_name), character: parsed[i].character })))
  const existing = target === NEW || target === NONE ? undefined : loadouts.find(l => l.id === target)
  const into = target === NONE ? NONE : existing?.id ?? NEW // a loadout deleted while the dialog was open: back to a new one
  const loadoutName = existing?.name ?? (name?.trim() || suggestion)
  const where = [...new Set(picked.map(i => folderOf(settings[i])))]
  const whereText = where.length === 1 ? folderOptions.find(o => o.value === where[0])?.label ?? where[0] : `${where.length} folders`
  const willPreview = preview && canGenerate

  // What Install does with the loadout, handed to App's install flow (commitInstallLoadout) when Install is pressed
  useEffect(() => {
    setInstallDraft(count === 0 || into === NONE ? null : into === NEW ? { name: loadoutName, label, preview: willPreview } : { into, preview: willPreview })
  }, [count, into, loadoutName, label, willPreview])
  useEffect(() => () => setInstallDraft(null), [])

  const install = () => {
    if (count === 0) return
    const asLoadout = into !== NONE
    const out = mods
      .map((mod, i) => {
        const s = settings[i]
        const sub = s?.installSubfolder
        // The root folder's id is its on-disk name (~mods): the backend wants an empty subfolder for it
        return {
          ...mod, ...s, toRepak: repakLocked(mod) ? false : Boolean(s?.toRepak), forceLegacy: Boolean(s?.forceLegacy),
          installSubfolder: !sub || sub === rootFolder?.id ? '' : sub,
          loadouts: asLoadout && into !== NEW ? [into] : [], // joining a loadout that exists: every mod joins it
        }
      })
      .filter(m => m.enabled !== false)
    commitInstallLoadout()
    onInstall(out)
  }

  // Esc: App closes the dialog. Enter is each control's own: the Install button installs, a name field commits its name
  const focus = useDialogFocus() // focus inside, Tab stays inside, back to the opener on close

  const targetOptions = [{ value: NEW, label: 'New loadout' }, ...loadouts.map(l => ({ value: l.id, label: `Add to ${l.name}`, name: l.name }))]
  const hybridPair = mods.length > 1 && mods.some(m => m.contains_uassets !== false) && mods.some(m => m.contains_raw_assets && m.contains_uassets === false)

  return (
    <div className="modal-overlay ip-overlay">
      <motion.div ref={focus.ref} onKeyDown={focus.onKeyDown} tabIndex={-1} className="modal-content ip-modal" role="dialog" aria-modal="true" aria-labelledby="ip-heading"
        initial={{ opacity: 0, y: 8, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
        <h2 id="ip-heading" className="xtra-sr-only">Install mods</h2>{/* the dialog's name: the visible title is a field to type in */}
        <button type="button" className="modal-close ip-close" onClick={onCancel} aria-label="Close">×</button>

        {into === NONE ? (
          // No loadout: a plain install into the Library, one click back to saving it as a loadout
          <header className="ip-plain-head">
            <h2 className="ip-title is-static">Install {count === 1 ? 'a mod' : `${count} mods`}</h2>
            <p className="ip-meta">Into the Library only. No loadout is made or changed.</p>
            <button type="button" className="lo-text-btn ip-back" onClick={() => setTarget(NEW)}>Save as a loadout instead</button>
          </header>
        ) : (
          // The loadout, the way its page shows it: picture, name, collection, preview
          <header className="ip-hero">
            <div className={`ip-cover${willPreview ? ' is-preview' : ''}`}>
              {existing && (existing.mediaRev || existing.image)
                ? <Cover id={existing.id} rev={existing.mediaRev} image={existing.image} />
                : <>
                    {willPreview && coverShape && <span className="ip-cover-shape" style={{ maskImage: `url(${coverShape})`, WebkitMaskImage: `url(${coverShape})` }} />}
                    {willPreview
                      // the hero's shape with a quiet note in its middle: its icon over two short lines
                      ? <span className="ip-cover-after"><WandSparkles size={14} aria-hidden="true" /><span>Renders</span><span>after install</span></span>
                      // no render: the other ways to give it a cover, which its page has
                      : <span className="ip-cover-note">
                          <span className="ip-cover-ways" aria-hidden="true"><Camera size={15} /><ImagePlus size={15} /><Type size={15} /></span>
                          <span>Capture, image or text on its page</span>
                        </span>}
                  </>}
            </div>
            <div className="ip-info">
              <TargetPicker options={targetOptions} value={into} onChange={setTarget} />
              {into === NEW
                ? <span className="ip-title-wrap">
                    <input ref={titleRef} className="ip-title" value={name ?? suggestion} aria-label="Loadout name" spellCheck={false}
                      onChange={e => setName(e.target.value)} onKeyDown={enterCommits(() => setName(n => (n === null ? null : committedName(n))))} />
                    <button type="button" className="lo-icon ip-pen" title="Rename the loadout" aria-label="Rename the loadout"
                      onClick={() => { titleRef.current?.focus(); titleRef.current?.select() }}>
                      <Pencil size={15} />
                    </button>
                  </span>
                : <h2 className="ip-title is-static">{loadoutName}</h2>}
              <p className="ip-meta">{count === 0 ? 'No mods picked' : <>
                {count} {count === 1 ? 'mod' : 'mods'} installing into {where.length === 1 ? <>your <code className="ip-folder">{whereText}</code> folder</> : whereText}
              </>}</p>
              <div className="ip-settings">
                {/* a div, not a label: a label passes a click on a menu item back to the trigger, which opened the list again */}
                {into === NEW && (
                  <div className="ip-setting">
                    <span>Collection</span>
                    {naming
                      ? <input className="ip-coll-name" autoFocus placeholder="New collection" aria-label="New collection name" spellCheck={false}
                          onBlur={e => { if (e.target.value.trim()) setLabel(addGroup(e.target.value)); setNaming(false) }}
                          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = ''; e.currentTarget.blur() } }} />
                      : <CustomDropdown options={[...groups.map(g => ({ value: g, label: g })), { value: OTHER, label: OTHER_LABEL }]}
                          value={groups.includes(label) ? label : OTHER} onChange={(v: string) => setLabel(v)}
                          onAddNew={() => setNaming(true)} addNewLabel="+ New collection" />}
                  </div>
                )}
                {canGenerate
                  ? <Checkbox checked={preview} onChange={(v: boolean) => setPreview(v)} size="sm" color="primary" className="ip-check">
                      <span>{into === NEW ? 'Generate preview' : 'Render preview again'}</span>
                    </Checkbox>
                  : <PreviewsUnavailable className="lo-text-btn ip-setup" label="Preview" />}
              </div>
            </div>
          </header>
        )}

        <div className="ip-body">
          {hybridPair && (
            <div className="ip-note">
              <div>
                <strong>These go together as one Hybrid mod</strong>
                <span>You dropped cooked assets and raw assets. Merging packs both into one IoStore mod.</span>
              </div>
              <button type="button" className="lo-text-btn" onClick={() => {
                const cooked = mods.find(m => m.contains_uassets !== false)
                const raw = mods.find(m => m.contains_raw_assets && m.contains_uassets === false)
                if (cooked && raw) onMergeHybrid?.(cooked.path, raw.path)
              }}>Merge as Hybrid</button>
            </div>
          )}

          <h3 className="lo-group-head ip-section">{into === NEW ? 'In this loadout' : into === NONE ? 'Mods' : `Joining ${loadoutName}`}<span className="lo-group-count">{count}</span></h3>
          {mods.length === 0 ? <p className="ip-empty">No mods were found in what you dropped.</p> : (
            <ul className="ip-rows">
              {mods.map((mod, i) => {
                const s = settings[i] ?? initialSetting(mod, currentFolderId)
                const { character, category, additional } = parsed[i]
                const portrait = resolveHeroImage(character, heroes, undefined, FALLBACK_HERO_ID) // no hero: the Library's own placeholder
                const off = s.enabled === false
                const isOpen = open.has(mod.path) && !off
                const on = optionsOn(mod, s)
                const shown = s.customName || plainName(mod.mod_name)
                const noCooked = mod.contains_uassets === false || mod.contains_raw_assets === false
                return (
                  <li key={mod.path || i} className={`ip-row${off ? ' is-off' : ''}${isOpen ? ' is-open' : ''}`}>
                    {/* Like a Library row: round hero icon and name, then on the right Leave out, its type and Advanced */}
                    <div className="ip-row-main">
                      <button type="button" className="ip-row-open" aria-expanded={isOpen} disabled={off} onClick={() => toggleOpen(mod.path)}
                        title={isOpen ? 'Hide its details' : 'File name, folder and install options'}>
                        {portrait ? <img className="ip-row-hero" src={portrait} alt="" title={character ?? undefined} /> : <span className="ip-row-hero" />}
                        <span className="ip-row-name">{shown}</span>
                        {on.length > 0 && !isOpen && <span className="ip-row-on">{on.join(' · ')}</span>}
                      </button>
                      {mods.length > 1 && (off
                        ? <button type="button" className="lo-text-btn ip-add-back" onClick={() => update(i, { enabled: true })}>Add back</button>
                        : <button type="button" className="lo-icon ip-leave" title="Leave this mod out" aria-label={`Leave ${shown} out`}
                            onClick={() => update(i, { enabled: false })}><X size={14} /></button>)}
                      <span className="ip-badges">
                        <span className={`category-badge ${badge(category)}`}>{category}</span>
                        {additional.map(t => <span key={t} className={`additional-badge ${badge(t)}`}>{t}</span>)}
                        {mod.contains_uassets === false && <span className="no-uassets-badge" title="No UAsset files: audio, config or other raw files">Raw Assets</span>}
                      </span>
                      <button type="button" className="ip-row-advanced" aria-expanded={isOpen} disabled={off} onClick={() => toggleOpen(mod.path)}
                        title={isOpen ? 'Hide its file name, folder and install options' : 'File name, folder and install options'}>
                        Advanced<ChevronDown size={14} className="ip-row-caret" aria-hidden="true" />
                      </button>
                    </div>
                    <div className="t-acc-panel" data-open={isOpen} ref={el => el?.toggleAttribute('inert', !isOpen)}>
                      <div className="t-acc-panel-inner">
                        <div className="ip-details">
                          <div className="ip-detail-row">
                            <label className="ip-name-wrap">
                              <input className="ip-name" value={s.customName} placeholder="Enter a mod name" title={`Leave empty to keep ${plainName(mod.mod_name)}`} aria-label="Mod name" spellCheck={false}
                                onChange={e => update(i, { customName: e.target.value })} onKeyDown={enterCommits(() => update(i, { customName: committedName(s.customName) ?? '' }))} />
                              <span className="ip-suffix" title="Every installed mod ends in its load priority">_9999999_P</span>
                            </label>
                            {folders.length > 0 && (
                              <div className="ip-field">
                                <span className="ip-label">Folder</span>
                                <CustomDropdown options={folderOptions} value={folderOf(s)}
                                  onChange={(v: string) => update(i, { installSubfolder: v === ROOT ? null : v })} onAddNew={() => newFolderFor(i)} addNewLabel="+ New folder…" />
                              </div>
                            )}
                          </div>
                          <div className="ip-switches">
                            <Switch size="sm" color="primary" checked={s.obfuscate} onChange={(v: boolean) => update(i, { obfuscate: v })}
                              className={`install-toggle obfuscate-toggle${s.obfuscate ? ' active' : ''}`} title="Encrypts the IoStore with the game's AES key to block FModel extraction">
                              <div className="install-toggle__text">
                                <span className="install-toggle__label">Obfuscation</span>
                                <span className="install-toggle__hint">{s.obfuscate ? 'IoStore will be AES encrypted' : 'Encrypt to block FModel extraction'}</span>
                              </div>
                            </Switch>
                            <Switch size="sm" color="success" checked={s.hybrid} isDisabled={noCooked}
                              onChange={(v: boolean) => { if (!noCooked) update(i, v ? { hybrid: true, toRepak: true, forceLegacy: false } : { hybrid: false }) }}
                              className={`install-toggle hybrid-toggle${noCooked ? ' locked' : s.hybrid ? ' active' : ''}`}
                              title="Build a Hybrid IoStore bundle holding both raw assets and cooked UAssets">
                              <div className="install-toggle__text">
                                <span className="install-toggle__label">Hybrid IoStore</span>
                                <span className="install-toggle__hint">{noCooked ? 'Needs raw and cooked assets' : s.hybrid ? 'Hybrid bundle on' : 'Merge raw and cooked assets'}</span>
                              </div>
                            </Switch>
                            <Switch size="sm" color="warning" checked={mod.contains_uassets === false ? true : s.hybrid ? false : s.forceLegacy}
                              isDisabled={mod.contains_uassets === false || s.hybrid || Boolean(mod.contains_uassets && mod.contains_raw_assets)}
                              onChange={(v: boolean) => { if (mod.contains_uassets !== false) update(i, { forceLegacy: v }) }}
                              className={`install-toggle legacy-toggle${mod.contains_uassets === false ? ' active locked' : s.hybrid || (mod.contains_uassets && mod.contains_raw_assets) ? ' locked' : s.forceLegacy ? ' active' : ''}`}
                              title="For audio and config mods (mods without UAssets)">
                              <div className="install-toggle__text">
                                <span className="install-toggle__label">Legacy PAK format</span>
                                <span className="install-toggle__hint">{mod.contains_uassets === false ? 'Forced for mods without UAssets' : mod.contains_uassets && mod.contains_raw_assets ? 'Not for Hybrid mods' : s.forceLegacy ? 'Skipping IoStore conversion' : 'For audio and config mods'}</span>
                              </div>
                            </Switch>
                            {mod.contains_uassets !== false && (
                              <Switch size="sm" color="secondary" checked={s.hybrid ? true : s.toRepak} onChange={(v: boolean) => update(i, { toRepak: v })}
                                isDisabled={repakLocked(mod) || s.hybrid}
                                className={`install-toggle repak-toggle${repakLocked(mod) || s.hybrid ? ' locked' : ''}${s.toRepak ? ' active' : ''}`}
                                title={repakLocked(mod) ? 'Folder drops cannot be repaked' : 'Repaks the pak into IoStore format'}>
                                <div className="install-toggle__text">
                                  <span className="install-toggle__label">Send to Repak</span>
                                  <span className="install-toggle__hint">{repakLocked(mod) ? 'Not for folder drops' : 'Repak into IoStore format'}</span>
                                </div>
                              </Switch>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="modal-footer ip-foot">
          {into !== NONE
            ? <button type="button" className="lo-text-btn ip-plain" onClick={() => setTarget(NONE)}
                title="Install into the Library only, with no loadout made or changed">Install without a loadout</button>
            : <span className="ip-plain-spacer" />}
          <button type="button" className="lo-text-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn-primary ip-install" onClick={install} disabled={count === 0}>
            {into === NEW ? 'Install and save loadout' : into === NONE ? `Install ${count} ${count === 1 ? 'mod' : 'mods'}` : `Install into ${loadoutName}`}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

if (import.meta.env.DEV) {
  console.assert(plainName('Alpha_Skin_9999999_P.pak') === 'Alpha_Skin', 'plain name drops the suffix and extension')
  console.assert(suggestName([{ name: 'A', character: null }]) === 'A', 'one mod: its name')
  console.assert(suggestName([{ name: 'A', character: 'Black Panther - Galactic' }, { name: 'B', character: 'Black Panther' }]) === 'Black Panther', 'shared hero')
  console.assert(suggestName([{ name: 'A', character: 'Hulk' }, { name: 'B', character: 'Black Panther' }]) === 'New loadout', 'mixed heroes')
  console.assert(committedName('  Mine ') === 'Mine' && committedName('   ') === null, 'Enter commits a trimmed name, empty goes back to the suggestion')
}
