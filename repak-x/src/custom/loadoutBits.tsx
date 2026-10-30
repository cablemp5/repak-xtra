// repakxtra: small pieces shared by Home (LoadoutsScreen.tsx), the loadout page and the New strip.
import { useEffect, useRef, useState } from 'react'
import { Ban, Camera, ChevronLeft, ChevronRight, Image as ImageIcon, ImagePlus, Lock, Pencil, Type, Volume2, VolumeX, WandSparkles, X } from 'lucide-react'
import Switch from '../components/ui/Switch'
import type { LoadoutProps } from './Loadouts'
import { useMediaUrl } from './loadoutMedia'
import { COVERS, type Cover, type Loadout, type Mod, captureKey, coverFills, displayName, flipMods, memberName, modKey, modsByKey, nameKey, patchLoadout, pickCover } from './loadoutStore'
import { ModName } from './modName'
import { revealOnLoad } from './motion'
import { formKeys, hasPreview, noPreviewPossible, previewMade, previewSetKey, useCovers, usePreviewStage, usePreviewState, usePreviewUrl, usePreviewVersion } from './previews'
import { playEmoteSound, stopEmoteSound, useEmoteSound, webpSeconds } from './emoteSound'
import { useVerdict } from './brokenMods'
import { VerdictBadge } from './VerdictBadge'
import { useVfxUpdating } from './vfx/quick'
import { GAME_RUNNING } from './keepOne'
import { CaptionIcon, CaptionStyleBar } from './captionStyle'
import { loadoutHero, silhouetteOf } from './silhouettes'
import { CardTools } from './CardTools'
import { CarouselSlide } from './Carousel'
import './support.css'
import { captionBackgroundKey } from './loadoutStore'

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
  const byKey = modsByKey(p.mods)
  // Previews are cached by name (nameKey), not by member key: each member's preview is its mod's, by that mod's name
  const members = [...new Set(l.on.map(displayName))]
  const byName = new Map(members.map(k => { const m = byKey.get(k); return [m ? nameKey(m.path) : memberName(k), m] as const }))
  const categoryOf = (k: string) => { const m = byName.get(k); return (m && p.modDetails?.[m.path]?.category) || undefined }
  const mine = [...byName.keys()]
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
    const installed = new Set(mine.filter(k => byName.get(k)))
    const older = info !== undefined && !(info.members && info.members.length === installed.size && info.members.every(k => installed.has(k)))
    const kinds = [...new Set(covered.map(categoryOf).filter((c): c is string => Boolean(c)))].sort((a, b) => rank(a) - rank(b))
    slides.unshift({ key: set, label: older ? 'Older render' : kinds.join(' + ') || 'Character', older }) // e.g. "Mesh + Texture + Material"
  }
  // A hero with forms (Magik and Darkchylde, Hulk's three): each other form's image follows its first; a shared slide
  // (several Material mods) gets one more shared slide with their other forms
  const all = slides.flatMap((s): Slide[] => {
    if (!s.keys) return [s, ...formKeys(s.key).map((k, i) => ({ key: k, label: `${s.label} · form ${i + 2}`, older: s.older }))]
    const more = s.keys.flatMap(formKeys)
    return more.length ? [s, { key: more[0], keys: more, label: `${s.label} · other forms` }] : [s]
  })
  return [all, mine] as [Slide[], string[]] // mine: the members' preview names (the emote sound looks them up)
}

/** A picture behind a Text cover's words (CaptionBackground.tsx, in the card's tools): hidden for now (cable, 2026-10-29),
 *  its controls and any saved picture, the code kept for later. */
const CAPTION_BACKGROUND = false

/** What the card's Cover switch calls each source, and its icon. */
const COVER_LABEL: Record<Cover, string> = { preview: 'Preview', capture: 'Capture', image: 'Image', text: 'Text' }
const COVER_ICON: Record<Cover, typeof WandSparkles> = { preview: WandSparkles, capture: Camera, image: ImageIcon, text: Type }
const COVER_WHAT: Record<Cover, string> = {
  preview: 'a generated preview', capture: 'an in-game capture', image: 'your own image', text: 'typed text',
}

/** The page's capture button and whether a capture fits this loadout (CapturePreview.tsx captureTarget). */
export type CaptureSlot = { show: boolean; hero?: string; button: (className: string, label: string, note?: boolean) => React.ReactNode }

/** A loadout's picture. It has four sources, each in its own slot so making one never replaces another: generated
 *  previews (paged with arrows, the slide named on hover), an in-game capture, its own image or video, and typed text
 *  (an icon above the words, in a picked color). The card shows the picked source (cover), or the first it has.
 *  With generate (the loadout page) a Cover switch under the card picks the source; an empty source holds its own way
 *  to fill it (Generate, Capture, choose a file, type), and a filled one keeps it in a corner with an X to remove it. */
export function CardMedia({ p, l, className = '', title, onClick, onRemoveImage, onRemoveCapture, emptyText = 'Click to add an image, or paste one', generate, capture }: {
  p: LoadoutProps; l: Loadout; className?: string; title: string; onClick: () => void; onRemoveImage?: () => void; onRemoveCapture?: () => void
  emptyText?: string; generate?: (className: string) => React.ReactNode; capture?: CaptureSlot
}) {
  usePreviewVersion()
  const page = Boolean(generate)
  const ownUrl = useMediaUrl(l.id, l.mediaRev)
  const savedBackground = useMediaUrl(captionBackgroundKey(l.id), l.captionBackgroundRev)
  const captionBackground = CAPTION_BACKGROUND ? savedBackground : undefined
  const own = ownUrl ?? l.image
  const shot = useMediaUrl(captureKey(l.id), l.captureRev)
  const [previewSlides, previewNames] = usePreviewSlides(p, l)
  const fills = coverFills(l, previewMade(l))
  const auto = pickCover(l, fills)
  // the page shows the picked source even while empty (with its way to fill it); Home shows what there is
  const cover: Cover | null = page ? (l.cover ?? auto ?? 'preview') : auto
  const slides = cover === 'preview' ? previewSlides : []
  const [index, setIndex] = useState(0)
  const [dir, setDir] = useState<1 | -1>(1)
  const turn = (d: 1 | -1) => { setDir(d); setIndex(at + d) }
  const at = slides.length ? ((index % slides.length) + slides.length) % slides.length : 0
  const slide = slides[at]
  const generated = usePreviewUrl(cover === 'preview' ? slide?.key || undefined : undefined)
  const src = cover === 'image' ? own : cover === 'capture' ? shot : cover === 'preview' ? generated : undefined
  const video = cover === 'image' && l.mediaType === 'video' ? ownUrl : undefined
  const [warm] = useState(src) // already cached when the card mounted: shown at once, without the blur-in
  const state = usePreviewState(previewSetKey(l.id))
  const working = state && (cover === 'preview' || cover === null) ? state : null // a card showing another source stays put
  const stage = usePreviewStage(working?.kind === 'running')
  // While it renders the hero's shape sits behind the status, under the shimmer, in place of any older picture
  const shape = working ? silhouetteOf(loadoutHero(l.on, p.mods, p.modDetails)) : undefined
  const caption = l.caption?.trim() || ''
  const [typing, setTyping] = useState(false)
  const words = cover === 'text' && fills.text
  const editing = page && cover === 'text' && (typing || !fills.text)
  const empty = !src && !words
  const impossible = noPreviewPossible(l)
  const saveCaption = (text: string) => { setTyping(false); if (text.trim() !== caption) patchLoadout(l.id, { caption: text.trim() || undefined }) }
  const clearCaption = () => { setTyping(false); patchLoadout(l.id, { caption: undefined, captionIcon: undefined, captionColor: undefined }) }
  // picking Text goes straight into its field, the cursor in it ready to type (also when the field was already showing)
  const captionRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (typing) captionRef.current?.focus() }, [typing, cover])
  const pick = (c: Cover) => { setTyping(c === 'text'); setIndex(0); if (l.cover !== c) patchLoadout(l.id, { cover: c }) }
  const tint = l.captionColor ? { '--cap': l.captionColor } as React.CSSProperties : undefined
  // An animation slide whose emote has a sound in this loadout: while hovered, the clip restarts (a fresh copy of its
  // image) and the sound plays once the restarted clip is on screen (custom/emoteSound.ts). The restart belongs to the
  // slide it was made for: paging ends it and its sound, and paging onto such a slide while hovered starts its own
  const slideKey = slide?.keys ? undefined : slide?.key || undefined
  const sound = useEmoteSound(slideKey, previewNames)
  // muted: the clip still plays, without its sound and its restart. While a new preview renders: no sound at all
  const audible = l.muted || working ? null : sound
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
    if (!hovering.current || !audible || !src || !slideKey || document.documentElement.classList.contains('is-dragging-card')) return
    const key = slideKey
    fetch(src).then(r => r.arrayBuffer()).then(buf => {
      if (!hovering.current || shownKey.current !== key) return // paged on, or left, while it loaded
      setRestart({ key, url: URL.createObjectURL(new Blob([buf], { type: 'image/webp' })), seconds: webpSeconds(buf) })
    }).catch(() => undefined)
  }
  useEffect(() => { dropRestart(); startRestart() }, [slideKey, src, audible?.key, audible?.emote]) // eslint-disable-line react-hooks/exhaustive-deps
  // The sound waits for a deliberate hover (HOVER_MS): sliding the cursor across a card plays nothing
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => { clearTimeout(hoverTimer.current); if (hovering.current) stopEmoteSound() }, []) // this card's sound ends with it, no other card's
  const live = restart && restart.key === slideKey ? restart : null
  const enter = () => { hovering.current = true; clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(startRestart, HOVER_MS) }
  const leave = () => { hovering.current = false; clearTimeout(hoverTimer.current); dropRestart() }

  // On the page a click on the card does what its source is for: choose a file, or edit the text
  const cardClick = !page || cover === 'image' ? onClick : words ? () => setTyping(true) : undefined
  const cardTitle = !page ? title : cover === 'image' ? (own ? 'Click to change the image (or paste one)' : 'Click to add an image, GIF, or video (or paste one)')
    : words ? 'Click to edit the text' : undefined
  const remove = !page || empty || editing ? undefined
    : cover === 'image' ? { what: 'image', run: onRemoveImage } : cover === 'capture' ? { what: 'capture', run: onRemoveCapture }
    : cover === 'text' && (caption || l.captionIcon) ? { what: 'text and icon', run: clearCaption } : undefined // a background has its own remove
  const ctaButton = 'lo-text-btn lo-media-gen-btn'

  const media = (
    <div className={`lo-media ${className}${working ? ` is-${working.kind}` : ''}`} onMouseEnter={enter} onMouseLeave={leave}>
      {/* transitions.dev: Skeleton loader. Shown over the card while its preview renders or waits; the new image
          blurs in when it lands (revealOnLoad). One sign of work, the sweep, with what the render is doing written on it */}
      {working && (
        <span className="lo-skel" role="status">
          {shape && <span className="lo-skel-shape" aria-hidden="true" style={{ maskImage: `url(${shape})`, WebkitMaskImage: `url(${shape})` }} />}
          <span className="lo-skel-label">
            {working.kind === 'running'
              ? <span className="lo-skel-stage" key={stage}>{stage}</span>
              : working.at === 1 ? 'Queued, up next' : `Queued, ${working.at} in line`}
          </span>
        </span>
      )}
      <button type="button" className={`lo-card-image${cardClick ? '' : ' is-still'}`} onClick={cardClick} title={cardTitle} tabIndex={cardClick ? undefined : -1}>
        {cover === 'text' && captionBackground && <span className={`caption-background${l.captionBlur ? ' is-blur' : ''}`} aria-hidden="true">
          <img src={captionBackground} alt="" className="is-loaded" />
          {l.captionDark && <span className="caption-background-tint" />}
        </span>}
        {words && !editing /* while typing, only the field shows the words: no second copy under it */
          ? <span className="lo-card-placeholder lo-card-caption" style={tint}>
              <CaptionIcon name={l.captionIcon} className="lo-cap-icon" />{caption && <span>{caption}</span>}
            </span>
          : !src
            ? page ? <span className="lo-card-placeholder" />
              : impossible
                ? <span className="lo-card-placeholder is-none"><Ban size={28} aria-hidden="true" /><span>No render possible. Open it to type text, or hover and paste an image.</span></span>
                : <span className="lo-card-placeholder"><ImagePlus size={28} aria-hidden="true" /><span>{emptyText}</span></span>
          : slide?.keys
            ? <CarouselSlide slide={at} dir={dir}><span className="lo-media-multi">{slide.keys.map(k => <SlideImage key={k} k={k} />)}</span></CarouselSlide>
          : video
            ? <video src={video} autoPlay loop muted playsInline />
            : <CarouselSlide slide={slides.length > 1 ? at : 0} dir={dir}>
                <img key={src} src={live?.url ?? src} alt="" className={src === warm ? 'is-loaded' : undefined} decoding="async" loading={page ? undefined : 'lazy'}
                  onLoad={e => { revealOnLoad(e); if (audible && live && hovering.current && e.currentTarget.src === live.url) playEmoteSound(audible, live.seconds) }} />
              </CarouselSlide>}
      </button>
      {slides.length > 1 && !working && ( /* no paging while a new preview renders */
        <>
          <button type="button" className="lo-media-arrow is-prev" title="Previous preview" aria-label="Previous preview" onClick={() => turn(-1)}>
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="lo-media-arrow is-next" title="Next preview" aria-label="Next preview" onClick={() => turn(1)}>
            <ChevronRight size={16} />
          </button>
          <span className="lo-media-label">{slide.label}</span>
        </>
      )}
      {slides.length === 1 && slide.older && <span className="lo-media-label">{slide.label}</span>}
      {/* The page's empty source, one build for every option (cable, 2026-10-21): a line on what it does, then its one
          button with an icon. An option that cannot work here says why, its button locked (as Capture is while the game
          is closed) */}
      {page && empty && !working && !editing && (
        <div className="lo-media-cta">
          {/* "Nothing to show" is remembered from the last run, which an older preview kit made: it can always try again */}
          {cover === 'preview' && <><small>{impossible ? 'The last run found nothing to render here.' : 'Renders this loadout on its hero, on this PC.'}</small>{generate!(ctaButton)}</>}
          {cover === 'capture' && (capture?.show
            ? capture.button(ctaButton, 'Capture screenshot', true)
            : <><small>Capture needs a skin, mesh, or texture mod in this loadout.</small>
                <button type="button" className={ctaButton} aria-disabled="true" title="Nothing to capture: try Image or Text"><Lock size={14} aria-hidden="true" /> Capture screenshot</button></>)}
          {/* the same build as Preview and Capture: a line on what it does, then its button */}
          {cover === 'image' && <>
            <small>Shows your own picture, GIF, or video on the card. You can also paste one.</small>
            <span className="nx-cta-pair">
              <button type="button" className={ctaButton} onClick={onClick}><ImagePlus size={14} aria-hidden="true" /> Choose an image</button>
            </span>
          </>}
        </div>
      )}
      {editing && (
        <div className="lo-caption-wrap" style={{ ...tint, ...(captionBackground ? { background: 'transparent' } : {}) }}>
          <CaptionIcon name={l.captionIcon} className="lo-cap-icon" />
          <textarea ref={captionRef} className="lo-caption-edit" autoFocus={typing} defaultValue={caption} maxLength={80} placeholder="Type a title"
            aria-label={`Text on ${l.name}'s card`} spellCheck={false} onFocus={e => e.currentTarget.select()}
            onBlur={e => saveCaption(e.currentTarget.value)}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur() }
              if (e.key === 'Escape') { e.currentTarget.value = caption; e.currentTarget.blur() }
            }} />
          <CaptionStyleBar icon={l.captionIcon} color={l.captionColor}
            onIcon={captionIcon => patchLoadout(l.id, { captionIcon })} onColor={captionColor => patchLoadout(l.id, { captionColor })} />
        </div>
      )}
      {/* A filled source keeps its way to redo it in the corner (the preview's also shows Stop while it renders) */}
      {page && !editing && (!empty || working) && (cover === 'preview' || cover === 'capture') && (
        <div className={`lo-media-gen${working ? ' is-busy' : ''}`}>
          {cover === 'preview' && !impossible && generate!('lo-media-chip')}
          {cover === 'capture' && capture?.show && capture.button('lo-media-chip', 'Capture again')}
        </div>
      )}
      {/* Image and Text keep their tools behind one arrow in the corner (CardTools.tsx) */}
      {page && !working && ((cover === 'image' && !empty) || (cover === 'text' && CAPTION_BACKGROUND)) && (
        <CardTools l={l} text={cover === 'text'} top={editing} alert={p.alert} onImage={onClick} />
      )}
      {remove?.run && (
        <button type="button" className="lo-media-remove" title={`Remove the ${remove.what}`} aria-label={`Remove the ${remove.what}`} onClick={remove.run}>
          <X size={14} />
        </button>
      )}
      {sound && !working && ( /* the speaker steps aside while it renders */
        <button type="button" className={`lo-media-mute${l.muted ? ' is-muted' : ''}`} aria-pressed={Boolean(l.muted)}
          title={l.muted ? `Play ${l.name}'s emote sound on hover` : `Mute ${l.name}'s emote sound (the animation still plays)`}
          aria-label={l.muted ? `Unmute ${l.name}` : `Mute ${l.name}`}
          onClick={() => patchLoadout(l.id, { muted: l.muted ? undefined : true })}>
          {l.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
      )}
    </div>
  )
  if (!page) return media
  return (
    <div className="lp-cover">
      {media}
      {/* What the card shows, everywhere: one source at a time, picked from four */}
      <div className="cover-tabs" role="radiogroup" aria-label="The card shows">
        {COVERS.map(c => {
          // a source that cannot work for this loadout shows a lock, as Capture does while the game is closed
          const locked = c === 'capture' && capture && !capture.show
          const Icon = locked ? Lock : COVER_ICON[c]
          return (
            <button key={c} type="button" role="radio" aria-checked={cover === c} className={`cover-tab${fills[c] ? ' is-filled' : ''}`} onClick={() => pick(c)}
              title={`${fills[c] ? 'Show' : 'Add'} ${COVER_WHAT[c]} on the card`}>
              <Icon size={14} aria-hidden="true" />{COVER_LABEL[c]}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** How long the pointer rests on an animation card before its emote sound plays. */
const HOVER_MS = 250

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
    p.alert.warning(...GAME_RUNNING)
    return
  }
  const failed = await flipMods([mod])
  if (failed.length) p.alert.warning('Not switched', failed.reason ?? `${nameKey(mod.path)} could not be switched.`)
  await p.reload()
}

/** One mod row: name, type, then the optional on/off switch (on the right, like the Library) and any trailing actions.
 *  With onRename, the pencil (or a double-click on the name) renames the mod's files. */
export function ModRow({ p, k: key, mod, onToggle, onRename, unsure, children }: {
  p: LoadoutProps; k: string; mod?: Mod; onToggle?: boolean; onRename?: (mod: Mod, name: string) => void; children?: React.ReactNode
  unsure?: boolean // not installed under its key, but installed mods could be it: the row offers them (LoadoutPage)
}) {
  const k = mod ? nameKey(mod.path) : memberName(key) // the name it shows: the file's own, "!" included
  const category = mod && p.modDetails?.[mod.path]?.category
  const verdict = useVerdict(mod?.path ?? '') // Broken or May crash, as in the Library
  const vfxUpdating = useVfxUpdating(mod?.path) // a right-click VFX update is working on it: its name shimmers
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false) // Esc: the blur that follows must not rename
  const canRename = Boolean(mod && onRename)
  const begin = () => { cancelled.current = false; setDraft(k) }
  const finish = () => { if (!cancelled.current && draft !== null && mod && onRename) onRename(mod, draft); setDraft(null) }
  return (
    <li className={`mod-row ${mod ? (mod.enabled ? 'is-on' : '') : 'is-missing'}`}
      onContextMenu={mod && p.onModContextMenu ? e => p.onModContextMenu!(e, mod, canRename ? begin : undefined) : undefined}
      title={draft !== null || mod ? undefined : unsure ? 'Pick the installed mod this loadout means' : 'Not installed anymore'}>{/* an installed row's badge and switch already say its type and state */}
      {draft !== null
        ? <input className="mod-row-rename" autoFocus value={draft} aria-label={`New name for ${k}`} onFocus={e => e.target.select()}
            onChange={e => setDraft(e.target.value)} onBlur={finish}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() } }} />
        : <span className="mod-row-main">
            <span className="mod-row-name" onDoubleClick={canRename ? begin : undefined}>{vfxUpdating ? <span className="t-shimmer"><ModName name={k} /></span> : <ModName name={k} />}</span>
            {!onToggle && mod?.enabled && <span className="on-dot" role="img" aria-label="On now" title="This mod is on now" />}
            {canRename && (
              <button type="button" className="lo-icon row-rename" title={`Rename ${k} (renames its files)`} aria-label={`Rename ${k}`} onClick={begin}>
                <Pencil size={13} />
              </button>
            )}
          </span>}
      {verdict && <VerdictBadge path={mod!.path} verdict={verdict} />}
      <span className={`mod-type-badge category-badge ${typeClass(category)}`}>{category ?? 'Unknown'}</span>
      {onToggle && (mod
        ? <Switch size="sm" color="primary" checked={Boolean(mod.enabled)} title={mod.enabled ? `Turn ${k} off` : `Turn ${k} on`}
            aria-label={mod.enabled ? `Turn ${k} off` : `Turn ${k} on`} onChange={() => toggleMod(p, mod)} />
        : unsure
          ? <span className="mod-type-badge category-badge unknown-badge" title="Installed mods in other folders have this name: pick one">Which one?</span>
          : <span className="mod-type-badge category-badge deleted-badge" title="This mod was deleted: it is no longer installed">Deleted</span>)}
      {children}
    </li>
  )
}
