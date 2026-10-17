// repakxtra: small pieces shared by Home (LoadoutsScreen.tsx), the loadout page and the New strip.
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ImagePlus, Pencil, X } from 'lucide-react'
import Switch from '../components/ui/Switch'
import type { LoadoutProps } from './Loadouts'
import { useMediaUrl } from './loadoutMedia'
import { type Loadout, type Mod, displayName, flipMods, modKey } from './loadoutStore'
import { ModName } from './modName'
import { MatrixLoader, revealOnLoad } from './motion'
import { formKeys, hasPreview, noPreviewPossible, previewSetKey, useCovers, usePreviewState, usePreviewUrl, usePreviewVersion } from './previews'
import { playEmoteSound, stopEmoteSound, useEmoteSound, webpSeconds } from './emoteSound'

/** The home screen's badge color class for a mod type (theme.css *-badge sets --badge-dot). */
export const typeClass = (category?: string | null) => `${(category || 'unknown').toLowerCase().replace(/\s+/g, '-')}-badge`

const TYPE_ORDER = ['Mesh', 'Texture', 'Material', 'Animation', 'VFX', 'UI', 'Text', 'Audio']   // Audio: the generator's list of changed sounds
const SHARED = ['Material', 'VFX'] // types whose previews go on one slide together
const rank = (c?: string | null) => { const i = TYPE_ORDER.indexOf(c ?? ''); return i < 0 ? TYPE_ORDER.length : i }

/** A loadout's generated previews: its combined character render first, then its other mods' in type order, its
 *  Material previews together on one slide and its VFX swatches on another. The combined render hides only the mods it
 *  shows that the loadout still holds. It reads "Older render" when it was made for other installed mods than the
 *  loadout has now (or before that was recorded). */
type Slide = { key: string; label: string; older?: boolean; keys?: string[] }
function usePreviewSlides(p: LoadoutProps, l: Loadout) {
  usePreviewVersion()
  const set = previewSetKey(l.id)
  const info = useCovers(set)
  const byKey = new Map(p.mods.map(m => [modKey(m.path), m]))
  const categoryOf = (k: string) => { const m = byKey.get(k); return (m && p.modDetails?.[m.path]?.category) || undefined }
  const mine = [...new Set(l.on.map(displayName))]
  const covered = (info?.covers ?? []).filter(k => mine.includes(k))
  const keys = mine.filter(k => hasPreview(k) && !covered.includes(k))
    .sort((a, b) => rank(categoryOf(a)) - rank(categoryOf(b)))
  // Material and VFX previews each share one slide, however many mods of that type the loadout has
  const together = (k: string) => { const c = categoryOf(k); return c && SHARED.includes(c) ? keys.filter(x => categoryOf(x) === c) : [k] }
  const slides: Slide[] = keys.flatMap(k => {
    const g = together(k)
    if (g.length < 2) return [{ key: k, label: categoryOf(k) ?? 'Mod' }]
    return k === g[0] ? [{ key: k, keys: g, label: `${g.length} ${categoryOf(k)}` }] : []
  })
  if (hasPreview(set)) {
    const installed = new Set(mine.filter(k => byKey.has(k)))
    const older = info !== undefined && !(info.members && info.members.length === installed.size && info.members.every(k => installed.has(k)))
    const kinds = [...new Set(covered.map(categoryOf).filter((c): c is string => Boolean(c)))].sort((a, b) => rank(a) - rank(b))
    slides.unshift({ key: set, label: older ? 'Older render' : kinds.join(' + ') || 'Character', older }) // e.g. "Mesh + Texture + Material"
  }
  // A hero with forms (Magik and Darkchylde, Hulk's three): each other form's image follows its first; a shared slide
  // (several Material mods) gets one more shared slide with their other forms
  return slides.flatMap((s): Slide[] => {
    if (!s.keys) return [s, ...formKeys(s.key).map((k, i) => ({ key: k, label: `${s.label} · form ${i + 2}`, older: s.older }))]
    const more = s.keys.flatMap(formKeys)
    return more.length ? [s, { key: more[0], keys: more, label: `${s.label} · other forms` }] : [s]
  })
}

/** The loadout's image: its own image or video, then its generated previews, paged with arrows. Hovering shows the
 *  arrows and what the slide is ("Mesh + Texture"). With onRemoveImage, its own image shows an X that removes it. */
export function CardMedia({ p, l, className = '', title, onClick, onRemoveImage, emptyText = 'Click to add an image, or paste one' }: {
  p: LoadoutProps; l: Loadout; className?: string; title: string; onClick: () => void; onRemoveImage?: () => void; emptyText?: string
}) {
  const url = useMediaUrl(l.id, l.mediaRev)
  const own = url ?? l.image
  const slides = [...(own ? [{ key: '', label: 'Your image' }] : []), ...usePreviewSlides(p, l)]
  const [index, setIndex] = useState(0)
  const [paged, setPaged] = useState(false) // only paging animates the image, not the first paint
  const at = slides.length ? ((index % slides.length) + slides.length) % slides.length : 0
  const slide = slides[at]
  const generated = usePreviewUrl(slide?.key || undefined)
  const src = slide?.key ? generated : own
  const [warm] = useState(src) // already cached when the card mounted: shown at once, without the blur-in
  const state = usePreviewState(previewSetKey(l.id))
  const impossible = !src && !state && noPreviewPossible(l)
  // An animation slide whose emote has a sound in this loadout: while hovered, the clip restarts (a fresh copy of its
  // image) and the sound plays once the restarted clip is on screen (custom/emoteSound.ts). The restart belongs to the
  // slide it was made for: paging ends it and its sound, and paging onto such a slide while hovered starts its own
  const slideKey = slide?.keys ? undefined : slide?.key || undefined
  const sound = useEmoteSound(slideKey, [...new Set(l.on.map(displayName))])
  const [restart, setRestart] = useState<{ key: string; url: string; seconds: number } | null>(null)
  const hovering = useRef(false)
  const shownKey = useRef(slideKey)
  shownKey.current = slideKey
  const dropRestart = () => {
    stopEmoteSound()
    // revoked later: a card picked up to drag carries a copy of this image for a while
    setRestart(r => { if (r) setTimeout(() => URL.revokeObjectURL(r.url), 30000); return null })
  }
  const startRestart = () => {
    if (!hovering.current || !sound || !src || !slideKey || document.documentElement.classList.contains('is-dragging-card')) return
    const key = slideKey
    fetch(src).then(r => r.arrayBuffer()).then(buf => {
      if (!hovering.current || shownKey.current !== key) return // paged on, or left, while it loaded
      setRestart({ key, url: URL.createObjectURL(new Blob([buf], { type: 'image/webp' })), seconds: webpSeconds(buf) })
    }).catch(() => undefined)
  }
  useEffect(() => { dropRestart(); startRestart() }, [slideKey, src, sound?.key, sound?.emote]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (hovering.current) stopEmoteSound() }, []) // this card's sound ends with it, no other card's
  const live = restart && restart.key === slideKey ? restart : null
  const enter = () => { hovering.current = true; startRestart() }
  const leave = () => { hovering.current = false; dropRestart() }
  return (
    <div className={`lo-media ${className}${paged ? ' is-paged' : ''}${state ? ` is-${state.kind}` : ''}`} onMouseEnter={enter} onMouseLeave={leave}>
      {/* transitions.dev: Skeleton loader. Shown over the card while its preview renders or waits; the new image
          blurs in when it lands (revealOnLoad) */}
      {state && (
        <span className="lo-skel" role="status">
          <span className="lo-skel-label">
            {state.kind === 'running'
              ? <><MatrixLoader size={12} />Generating previews</>
              : state.at === 1 ? 'Queued, up next' : `Queued, ${state.at} in line`}
          </span>
        </span>
      )}
      <button type="button" className="lo-card-image" onClick={onClick} title={title}>
        {!src
          ? impossible
            ? <span className="lo-card-placeholder"><span>No preview possible</span><small>Click to add an image</small></span>
            : <span className="lo-card-placeholder"><ImagePlus size={22} /><span>{emptyText}</span></span>
          : slide?.keys
            ? <span className="lo-media-multi">{slide.keys.map(k => <SlideImage key={k} k={k} />)}</span>
          : !slide?.key && l.mediaType === 'video' && url
            ? <video src={url} autoPlay loop muted playsInline />
            : <img key={src} src={live?.url ?? src} alt="" className={src === warm ? 'is-loaded' : undefined}
                onLoad={e => { revealOnLoad(e); if (sound && live && hovering.current && e.currentTarget.src === live.url) playEmoteSound(sound, live.seconds) }} />}
      </button>
      {slides.length > 1 && (
        <>
          <button type="button" className="lo-media-arrow is-prev" title="Previous preview" aria-label="Previous preview" onClick={() => { setPaged(true); setIndex(at - 1) }}>
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="lo-media-arrow is-next" title="Next preview" aria-label="Next preview" onClick={() => { setPaged(true); setIndex(at + 1) }}>
            <ChevronRight size={16} />
          </button>
          <span className="lo-media-label">{slide.label}</span>
        </>
      )}
      {slides.length === 1 && slide.older && <span className="lo-media-label">{slide.label}</span>}
      {onRemoveImage && own && slide && !slide.key && (
        <button type="button" className="lo-media-remove" title="Remove this image" aria-label="Remove this image" onClick={onRemoveImage}>
          <X size={14} />
        </button>
      )}
    </div>
  )
}

/** One preview of a slide that shows several (a loadout's VFX swatches). */
function SlideImage({ k }: { k: string }) {
  const src = usePreviewUrl(k)
  const [warm] = useState(src)
  return src ? <img src={src} alt="" className={src === warm ? 'is-loaded' : undefined} onLoad={revealOnLoad} /> : <span />
}

/** How many of a loadout's installed mods are on: green all, yellow some, red none. */
export function OnDot({ on, of }: { on: number; of: number }) {
  const state = on === 0 ? '' : on < of ? ' is-some' : ' is-on'
  return <span className={`lo-on-dot${state}`} title={on === 0 ? 'None of its mods are on' : on < of ? `${on} of its ${of} mods are on` : 'All of its mods are on'} />
}

/** Turns single mods on or off from Home, with the same game-running guard as loadouts. */
export async function toggleMod(p: LoadoutProps, mod: Mod) {
  if (p.blocked) {
    p.alert.warning('Game Running', 'Cannot toggle mods while game is running.')
    return
  }
  const failed = await flipMods([mod])
  if (failed.length) p.alert.warning('Not switched', failed.reason ?? `${displayName(mod.path.split(/[/\\]/).pop() || mod.path)} could not be switched.`)
  await p.reload()
}

/** One mod row: name, type, then the optional on/off switch (on the right, like the Library) and any trailing actions.
 *  With onRename, the pencil (or a double-click on the name) renames the mod's files. */
export function ModRow({ p, k, mod, onToggle, onRename, children }: {
  p: LoadoutProps; k: string; mod?: Mod; onToggle?: boolean; onRename?: (mod: Mod, name: string) => void; children?: React.ReactNode
}) {
  const category = mod && p.modDetails?.[mod.path]?.category
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false) // Esc: the blur that follows must not rename
  const canRename = Boolean(mod && onRename)
  const begin = () => { cancelled.current = false; setDraft(k) }
  const finish = () => { if (!cancelled.current && draft !== null && mod && onRename) onRename(mod, draft); setDraft(null) }
  return (
    <li className={`mod-row ${mod ? (mod.enabled ? 'is-on' : '') : 'is-missing'}`}
      title={draft !== null || mod ? undefined : 'Not installed anymore'}>{/* an installed row's badge and switch already say its type and state */}
      {draft !== null
        ? <input className="mod-row-rename" autoFocus value={draft} aria-label={`New name for ${k}`} onFocus={e => e.target.select()}
            onChange={e => setDraft(e.target.value)} onBlur={finish}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() } }} />
        : <span className="mod-row-main">
            <span className="mod-row-name" onDoubleClick={canRename ? begin : undefined}><ModName name={k} /></span>
            {canRename && (
              <button type="button" className="lo-icon row-rename" title={`Rename ${k} (renames its files)`} aria-label={`Rename ${k}`} onClick={begin}>
                <Pencil size={13} />
              </button>
            )}
          </span>}
      {!onToggle && mod?.enabled && <span className="mod-type-badge category-badge on-badge" title="This mod is on now">On</span>}
      <span className={`mod-type-badge category-badge ${typeClass(category)}`}>{category ?? 'Unknown'}</span>
      {onToggle && (mod
        ? <Switch size="sm" color="primary" checked={Boolean(mod.enabled)} title={mod.enabled ? `Turn ${k} off` : `Turn ${k} on`}
            aria-label={mod.enabled ? `Turn ${k} off` : `Turn ${k} on`} onChange={() => toggleMod(p, mod)} />
        : <span className="mod-type-badge category-badge deleted-badge" title="This mod was deleted: it is no longer installed">Deleted</span>)}
      {children}
    </li>
  )
}
