// caleb fork: small pieces shared by Home (LoadoutsScreen.tsx), the loadout page and the New strip.
import { useState } from 'react'
import { ChevronLeft, ChevronRight, ImagePlus } from 'lucide-react'
import Switch from '../components/ui/Switch'
import type { LoadoutProps } from './Loadouts'
import { useMediaUrl } from './loadoutMedia'
import { type Loadout, type Mod, displayName, flipMods, modKey } from './loadoutStore'
import { ModName } from './modName'
import { revealOnLoad } from './motion'
import { hasPreview, previewSetKey, useCovers, usePreviewState, usePreviewUrl, usePreviewVersion } from './previews'

/** The home screen's badge color class for a mod type (caleb.css *-badge sets --badge-dot). */
export const typeClass = (category?: string | null) => `${(category || 'unknown').toLowerCase().replace(/\s+/g, '-')}-badge`

const TYPE_ORDER = ['Mesh', 'Texture', 'Material', 'Animation', 'VFX', 'UI', 'Text']
const rank = (c?: string | null) => { const i = TYPE_ORDER.indexOf(c ?? ''); return i < 0 ? TYPE_ORDER.length : i }

/** A loadout's generated previews: its combined character render first, then its other mods' in type order. */
function usePreviewSlides(p: LoadoutProps, l: Loadout) {
  usePreviewVersion()
  const set = previewSetKey(l.id)
  const covered = useCovers(set)
  const byKey = new Map(p.mods.map(m => [modKey(m.path), m]))
  const categoryOf = (k: string) => { const m = byKey.get(k); return (m && p.modDetails?.[m.path]?.category) || undefined }
  const keys = [...new Set(l.on.map(displayName))].filter(k => hasPreview(k) && !covered.includes(k))
    .sort((a, b) => rank(categoryOf(a)) - rank(categoryOf(b)))
  const slides = keys.map(k => ({ key: k, label: categoryOf(k) ?? 'Mod' }))
  if (hasPreview(set)) {
    const kinds = [...new Set(covered.map(categoryOf).filter((c): c is string => Boolean(c)))].sort((a, b) => rank(a) - rank(b))
    slides.unshift({ key: set, label: kinds.join(' + ') || 'Character' }) // e.g. "Mesh + Texture + Material"
  }
  return slides
}

/** The loadout's image: its own image or video, then its generated previews, paged with arrows. */
export function CardMedia({ p, l, className = '', title, onClick, emptyText = 'Click to add an image, or paste one' }: {
  p: LoadoutProps; l: Loadout; className?: string; title: string; onClick: () => void; emptyText?: string
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
  const state = usePreviewState(previewSetKey(l.id))
  return (
    <div className={`lo-media ${className}${paged ? ' is-paged' : ''}${state ? ` is-${state.kind}` : ''}`}>
      {/* transitions.dev: Skeleton loader. Shown over the card while its preview renders or waits; the new image
          blurs in when it lands (revealOnLoad) */}
      {state && (
        <span className="lo-skel" role="status">
          <span className="lo-skel-label">
            {state.kind === 'running' ? `Generating ${state.done} of ${state.total}` : state.at === 1 ? 'Queued, up next' : `Queued, ${state.at} in line`}
          </span>
        </span>
      )}
      <button type="button" className="lo-card-image" onClick={onClick} title={title}>
        {!src
          ? <span className="lo-card-placeholder"><ImagePlus size={22} /><span>{emptyText}</span></span>
          : !slide?.key && l.mediaType === 'video' && url
            ? <video src={url} autoPlay loop muted playsInline />
            : <img key={src} src={src} alt="" onLoad={revealOnLoad} />}
      </button>
      {slides.length > 1 && (
        <>
          <button type="button" className="lo-media-arrow is-prev" title="Previous preview" aria-label="Previous preview" onClick={() => { setPaged(true); setIndex(at - 1) }}>
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="lo-media-arrow is-next" title="Next preview" aria-label="Next preview" onClick={() => { setPaged(true); setIndex(at + 1) }}>
            <ChevronRight size={16} />
          </button>
          <span className="lo-media-label">{slide.label} · {at + 1}/{slides.length}</span>
        </>
      )}
    </div>
  )
}

/** Turns single mods on or off from Home, with the same game-running guard as loadouts. */
export async function toggleMod(p: LoadoutProps, mod: Mod) {
  if (p.blocked) {
    p.alert.warning('Game Running', 'Cannot toggle mods while game is running.')
    return
  }
  if ((await flipMods([mod])).length) p.alert.warning('Not switched', `${displayName(mod.path.split(/[/\\]/).pop() || mod.path)} could not be switched.`)
  await p.reload()
}

/** One mod row: optional on/off switch, type code, name (slug + tags + version), then any trailing actions. */
export function ModRow({ p, k, mod, onToggle, children }: {
  p: LoadoutProps; k: string; mod?: Mod; onToggle?: boolean; children?: React.ReactNode
}) {
  const category = mod && p.modDetails?.[mod.path]?.category
  return (
    <li className={`mod-row ${mod ? (mod.enabled ? 'is-on' : '') : 'is-missing'}`}
      title={mod ? `${category ?? 'Unknown type'} · ${mod.enabled ? 'on now' : 'off now'}` : 'Not installed anymore'}>
      {onToggle && (mod
        ? <Switch size="sm" color="primary" checked={Boolean(mod.enabled)} title={mod.enabled ? `Turn ${k} off` : `Turn ${k} on`}
            aria-label={mod.enabled ? `Turn ${k} off` : `Turn ${k} on`} onChange={() => toggleMod(p, mod)} />
        : <span className="mod-row-switch-gap" />)}
      <span className="mod-row-name"><ModName name={k} /></span>
      {!onToggle && mod?.enabled && <span className="mod-row-on" title="This mod is on now">on</span>}
      <span className={`mod-type-badge category-badge ${typeClass(category)}`}>{category ?? 'Unknown'}</span>
      {children}
    </li>
  )
}
