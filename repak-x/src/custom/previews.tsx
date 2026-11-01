// repakxtra: generated mod previews (lobby-look renders, UI icons, VFX swatches) made by xtra_previews.rs's
// generator for the mods you pick: the details panel's Generate button (one mod) or the selection bar's Previews
// button (every selected mod, one after another). A loadout's Generate previews also renders its character mods
// together as one image (key previewSetKey(id)); loadout cards page through the previews (loadoutBits.tsx).
// One run at a time (the generator holds a lock); asking while another runs puts the request in a queue that starts
// when the current run ends. Unchanged mods report their existing preview without rendering again; Regenerate forces.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ListPlus, WandSparkles, X } from 'lucide-react'
import { play } from 'cuelume'
import { useAlert } from '../components/AlertHandler'
import { type Loadout, coverFills, displayName, memberName, modKey, nameKey, patchLoadout, pickCover, readLoadouts } from './loadoutStore'
import { revealOnLoad } from './motion'
import { EGG_MS, stepEgg, stepText } from './previewStages'
import { plural } from './modName'
import { koPreview } from './ko/koPreview'
import { KO_BEAT } from './ko/render'

const NOTHING = 'Nothing to show for this mod: previews cover skins, meshes, textures, animations, UI icons, VFX colors, and sounds.'
const FAILED = 'The last render failed. The full error is in Logs.'
const SET_FAILED = 'The last loadout render failed. The full error is in Logs.'
const BUSY = 'Another preview generator is running (a manual run or an earlier app session).'

const revs = new Map<string, number>() // key -> bump count, so a re-rendered preview reloads
const pending = new Set<string>()       // mod keys still waiting in the current run (a loadout's set key is not one)
const outcome = new Map<string, string>() // key (mod or set) -> message from its last render
export type Covers = { covers: string[]; members: string[] | null } // members null: rendered before that was recorded
// Mods whose last render had nothing to show, kept across restarts: a loadout of only those counts as done, not missing
const NONE_KEY = 'repakxtra.previewNone'
const none = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(NONE_KEY) ?? '[]') as string[] } catch { return [] } })())
const markNone = (key: string, on: boolean) => {
  if (none.has(key) === on) return
  if (on) none.add(key); else none.delete(key)
  try { localStorage.setItem(NONE_KEY, JSON.stringify([...none])) } catch { /* storage full or off: only this session knows */ }
}
/** A run that ended with failures, for the toast (usePreviewFailureToast): the full errors are in the Logs. */
type Failure = { name: string; failed: number; setFailed: boolean }
const failureListeners = new Set<(f: Failure) => void>()
/** Opens Setup at its Mod previews card (SetupPanel.tsx listens). */
export const openPreviewSetup = () => window.dispatchEvent(new CustomEvent('repakxtra-open-setup', { detail: 'previews' }))
const loadoutOf = (setKey: string) => readLoadouts().find(x => previewSetKey(x.id) === setKey)
/** A finished render: its loadout's card shows the preview when asked for (show: generated from its page or for a new
 *  install), or when the card had nothing else to show. Its image, capture and text all stay, one click away. */
const showPreviewCover = (setKey: string, show: boolean) => {
  const l = loadoutOf(setKey)
  if (l && l.cover !== 'preview' && (show || pickCover(l, coverFills(l, false)) === null)) patchLoadout(l.id, { cover: 'preview' }, false)
}
const covers = new Map<string, Covers & { rev: number }>() // loadout render key -> the mods it shows and the mods it was rendered for
// Shared caches, so a card that remounts (Home -> page -> Home) shows its image at once without reading it again.
// Entries belong to one revision; a newer one, or none, drops them. A read that finishes after its revision was dropped
// or replaced is thrown away, so it can never bring back an old image or old covers.
const urls = new Map<string, { rev: number; url: string }>() // preview key -> object URL of its PNG
const urlLoads = new Map<string, { rev: number; p: Promise<string | null | undefined> }>()
const coverLoads = new Map<string, { rev: number; p: Promise<unknown> }>()
// Card-sized copies (loadThumb), cached and dropped with the full ones
const thumbs = new Map<string, { rev: number; url: string }>()
const thumbLoads = new Map<string, { rev: number; p: Promise<string | null | undefined> }>()
/** Forget a key's cached image and covers (its revision changed, or it has none now). */
const dropCached = (key: string) => {
  const u = urls.get(key)
  if (u) { URL.revokeObjectURL(u.url); videoUrls.delete(u.url) }
  const t = thumbs.get(key)
  if (t && t.url !== u?.url) URL.revokeObjectURL(t.url)
  thumbs.delete(key)
  thumbLoads.delete(key)
  urls.delete(key)
  urlLoads.delete(key)
  covers.delete(key)
  coverLoads.delete(key)
}
/** What a run is for: its mods, the loadout's combined render key (if any), a name to show ("Electric Blue"), and
 *  force (Regenerate: render even when nothing changed). */
type Job = { paths: string[]; set?: string; name: string; force?: boolean; show?: boolean; quiet?: boolean } // quiet: ends without a summary or failure toast (a background render)
type QueuedJob = Job & { id: string }
/** A job's identity: its loadout render key, else its mods in any order. The name is for display only (a loadout can be
 *  renamed mid-run). Pure. */
export const jobId = (j: { paths: string[]; set?: string }) => j.set ?? `mods:${JSON.stringify([...new Set(j.paths.map(nameKey))].sort())}`
const keysOf = (j: Job) => [...new Set(j.paths.map(nameKey)), ...(j.set ? [j.set] : [])]
const queue: QueuedJob[] = []
let active = false // a run was accepted and its done event has not arrived yet
let batchDone = 0  // jobs finished since the queue was last empty, for Home's "3 of 21"
type SetResult = 'ok' | 'none' | 'failed' | undefined
let run = { id: '', total: 0, made: 0, none: 0, failed: 0, stopping: false, summary: '', set: undefined as string | undefined, name: '', setResult: undefined as SetResult, busy: '',
  show: false, step: undefined as string | undefined, quiet: false }
let version = 0
const listeners = new Set<() => void>()
const notify = () => { version++; listeners.forEach(l => l()) }
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }

/** Reads which previews exist. After a run it also drops the other-form images (<key>@2) the generator deleted, since
 *  nothing else reports those as gone. */
const syncPreviewList = () => invoke<string[]>('list_mod_previews').then(keys => {
  const now = new Set(keys)
  for (const k of [...revs.keys()]) if (k.includes('@') && !now.has(k)) { revs.delete(k); dropCached(k) }
  keys.forEach(k => { if (!revs.has(k)) revs.set(k, 0) })
  notify()
}).catch(() => undefined)
syncPreviewList()
/** A character's other forms (Magik's Darkchylde, Hulk's other two): <key>@2, <key>@3 beside <key>. */
export const formKeys = (key: string) => [2, 3, 4].map(n => `${key}@${n}`).filter(k => revs.has(k))
// No generator on this PC (a friend's copy without the preview kit): Generate buttons stay hidden, existing previews still show
let available = false
/** Asks the backend again (after the preview kit was installed or removed in Setup). */
export const refreshPreviewsAvailable = () => invoke<boolean>('previews_available').then(v => { available = v; notify() }).catch(() => undefined)
refreshPreviewsAvailable()
export const usePreviewsAvailable = () => useSyncExternalStore(subscribe, () => available)
listen<string>('mod-preview-ready', e => {
  dropCached(e.payload)
  revs.set(e.payload, (revs.get(e.payload) ?? 0) + 1)
  outcome.delete(e.payload)
  markNone(e.payload, false)
  // The loadout's own render is done: its card shows it now, not after the mods it does not cover render one by one
  if (active && e.payload === run.set) { run.setResult = 'ok'; if (!run.stopping) showPreviewCover(run.set, run.show) }
  if (active && pending.delete(e.payload)) run.made++
  notify()
}).catch(() => undefined)
listen<string>('mod-preview-stage', e => { // what the generator is doing now (previewStages.ts)
  if (!active || run.step === e.payload) return
  run.step = e.payload
  notify()
}).catch(() => undefined)
listen<string>('mod-preview-in', e => { // shown in the loadout's combined render instead of its own
  outcome.delete(e.payload)
  if (active && pending.delete(e.payload)) run.made++
  notify()
}).catch(() => undefined)
listen<string>('mod-preview-none', e => {
  dropCached(e.payload)
  revs.delete(e.payload) // the generator deleted its old image
  if (e.payload.startsWith(previewSetKey(''))) { // a loadout render with nothing to combine: its mods render one by one
    if (active && e.payload === run.set) run.setResult = 'none'
    outcome.delete(e.payload)
  } else {
    outcome.set(e.payload, NOTHING)
    markNone(e.payload, true)
    if (active && pending.delete(e.payload)) run.none++
  }
  notify()
}).catch(() => undefined)
listen<string>('mod-preview-failed', e => { // its last good preview stays
  if (!active) return
  if (e.payload === run.set) {
    run.setResult = 'failed'
    outcome.set(e.payload, SET_FAILED)
  } else {
    outcome.set(e.payload, FAILED)
    if (pending.delete(e.payload)) run.failed++
  }
  notify()
}).catch(() => undefined)
// A mod the generator could not read (encrypted with a key other than the game's): its preview, or the loadout render it
// belongs to, would not show it. The window that started the run says so (usePreviewFailureToast)
const warnListeners = new Set<(key: string) => void>()
listen<string>('mod-preview-warn', e => { if (active && !run.quiet) warnListeners.forEach(l => l(e.payload)) }).catch(() => undefined)
listen('mod-previews-busy', () => { // the generator refused: another one holds its lock. Nothing starts until done
  if (!active) return
  run.busy = BUSY
  for (const k of [...pending, ...(run.set ? [run.set] : []), ...queue.flatMap(keysOf)]) outcome.set(k, BUSY)
  pending.clear()
  queue.length = 0
  notify()
}).catch(() => undefined)
listen<boolean>('mod-previews-done', e => finish(e.payload)).catch(() => undefined)
/** A run's end: the kit's done event, or the KO renderer's when the kit had nothing to do (ok: it ran through). */
function finish(ok: boolean) {
  if (!active) return // a window that did not start this run (Asset Explorer, VFX Updater) stays quiet
  active = false
  const left = pending.size
  pending.forEach(k => outcome.set(k, run.stopping ? 'Stopped before this mod.' : FAILED))
  pending.clear()
  if (run.set && run.setResult === undefined && !run.busy) { // the run ended without a word on the loadout render
    if (run.stopping) outcome.set(run.set, 'Stopped before the loadout render.')
    else { run.setResult = 'failed'; outcome.set(run.set, SET_FAILED) }
  }
  const failed = run.failed + (run.stopping ? 0 : left)
  const parts = [`${run.made} made`, run.none && `${run.none} with nothing to show`, failed && `${failed} failed`,
    run.stopping && left && `${left} skipped`, run.setResult === 'failed' && '1 loadout render failed']
  // Stopped before anything was made is a stop, not a failure
  const stoppedEarly = run.stopping && !run.made && !run.none && !run.failed
  const summary = run.quiet ? '' : run.busy || (stoppedEarly ? 'Stopped' : ok || run.made || run.none || run.failed ? parts.filter(Boolean).join(' · ') : FAILED)
  const stopped = run.stopping
  run = { ...run, stopping: false, summary }
  // Previews made for a loadout become what its card shows when asked for (not on Stop: the user ended it)
  if (run.set && !stopped && (run.setResult === 'ok' || run.made > 0)) showPreviewCover(run.set, run.show)
  if (!run.quiet && !run.busy && (failed || run.setResult === 'failed')) failureListeners.forEach(f => f({ name: run.name, failed, setFailed: run.setResult === 'failed' }))
  play(run.busy ? 'warning' : stoppedEarly ? 'close' : run.made && !failed && run.setResult !== 'failed' ? 'ready' : run.made ? 'warning' : 'error')
  batchDone++
  notify()
  syncPreviewList()
  startNext()
  if (!running()) batchDone = 0
}

export const usePreviewVersion = () => useSyncExternalStore(subscribe, () => version)
export const hasPreview = (key: string) => revs.has(key)
// Mods the KO renderer makes previews for: the kit never sees them, so a loadout's combined render was not made for them
const KO_KEYS = 'repakxtra.koPreviews'
const koKeys = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(KO_KEYS) || '[]') } catch { return [] } })())
export const isKoPreview = (key: string) => koKeys.has(key)
/** Key of a loadout's combined character render. */
export const previewSetKey = (loadoutId: string) => `loadout-${loadoutId}`
/** A loadout has previews when its combined render exists or any of its mods has its own (loadouts of only VFX, UI or
 *  sound mods never get a combined render). */
export const loadoutHasPreview = (l: { id: string; on: string[] }) => previewMade(l) || noPreviewPossible(l)
/** A loadout's previews exist: its combined render, or any of its mods' own. */
export const previewMade = (l: { id: string; on: string[] }) => hasPreview(previewSetKey(l.id)) || l.on.some(k => namesOf(k).some(hasPreview))
/** What a loadout's card shows (loadoutStore.ts pickCover), with its previews as they are now. */
export const coverOf = (l: Loadout) => pickCover(l, coverFills(l, previewMade(l)))
/** Every mod of the loadout rendered with nothing to show (sounds, unknown types): there is no preview to make. */
export const noPreviewPossible = (l: { on: string[] }) => l.on.length > 0 && l.on.every(k => namesOf(k).some(n => none.has(n)))
/** The preview names a loadout member may be cached under (previews are by file name, which keeps a priority-zero "!"). */
const namesOf = (k: string) => { const n = memberName(k); return n.startsWith('!') ? [n] : [n, `!${n}`] }
/** A loadout's combined render: the mods it shows and the mods it was rendered for; undefined while there is none
 *  (or until it is read, once per revision). */
export function useCovers(setKey: string): Covers | undefined {
  usePreviewVersion()
  const rev = revs.get(setKey)
  const cached = covers.get(setKey)
  useEffect(() => {
    if (rev === undefined || covers.get(setKey)?.rev === rev || coverLoads.get(setKey)?.rev === rev) return
    const p: Promise<unknown> = invoke<Covers>('get_preview_covers', { key: setKey }).then(c => {
      if (coverLoads.get(setKey)?.p !== p || revs.get(setKey) !== rev) return // dropped or replaced meanwhile
      coverLoads.delete(setKey)
      covers.set(setKey, { ...c, rev })
      notify()
    }, () => { if (coverLoads.get(setKey)?.p === p) coverLoads.delete(setKey) })
    coverLoads.set(setKey, { rev, p })
  }, [setKey, rev])
  return rev !== undefined && cached?.rev === rev ? cached : undefined
}

/** PNG, an animated WebP (animation mods), or a WebM (KO prompt mods): told apart by the file's signature. */
const imageType = (bytes: ArrayBuffer) => {
  const head = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength))
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm'
  return new TextDecoder().decode(head).slice(8) === 'WEBP' ? 'image/webp' : 'image/png'
}
const videoUrls = new Set<string>()
/** The preview at this URL is a video (a KO prompt mod's): it plays in a BeatVideo, not an img. */
export const isVideoPreview = (url: string | null | undefined) => Boolean(url && videoUrls.has(url))

/** A KO prompt video (a loadout card's, or a KO mod's preview): each play starts on the next beat of one shared clock, so every such card plays the same frame
 *  at the same time. The recording is shorter than the beat: it rests on its last frame (the empty grid) until then. */
export function BeatVideo({ src, beat }: { src: string; beat: number }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    let t: number | undefined
    const next = () => {
      clearTimeout(t)
      t = window.setTimeout(() => { v.currentTime = 0; v.play().catch(() => undefined) }, beat * 1000 - (Date.now() % (beat * 1000)))
    }
    // a card that appears mid-beat joins at the clock's point instead of waiting for the next one
    const join = () => {
      const at = (Date.now() % (beat * 1000)) / 1000
      if (at < v.duration - 0.1) { v.currentTime = at; v.play().catch(() => undefined) } else next()
    }
    v.addEventListener('ended', next)
    v.addEventListener('loadedmetadata', join, { once: true })
    return () => { clearTimeout(t); v.removeEventListener('ended', next); v.removeEventListener('loadedmetadata', join) }
  }, [src, beat])
  return <video ref={ref} src={src} muted playsInline preload="auto" />
}


/** A preview's object URL at this revision: cached, or read once however many cards ask. Resolves to the URL, null
 *  when the read failed, or undefined when the revision was dropped or replaced before it finished. */
function loadUrl(key: string, rev: number): Promise<string | null | undefined> {
  const c = urls.get(key)
  if (c?.rev === rev) return Promise.resolve(c.url)
  const f = urlLoads.get(key)
  if (f?.rev === rev) return f.p
  const p: Promise<string | null | undefined> = invoke<ArrayBuffer>('get_mod_preview', { key }).then(bytes => {
    if (urlLoads.get(key)?.p !== p || revs.get(key) !== rev) return undefined // stale: the bytes are dropped unused
    urlLoads.delete(key)
    const type = imageType(bytes), url = URL.createObjectURL(new Blob([bytes], { type }))
    if (type === 'video/webm') videoUrls.add(url)
    urls.set(key, { rev, url })
    return url
  }, () => {
    if (urlLoads.get(key)?.p !== p) return undefined
    urlLoads.delete(key)
    return null
  })
  urlLoads.set(key, { rev, p })
  return p
}
/** Width of the copy loadout cards draw (THUMB_W px, WebP, same transparency): a card shows a 640 px render at under
 *  200 px, and the browser keeps every drawn picture decoded at its full size, so a grid of 40 held 86 MB of them. */
const THUMB_W = 400
/** A card-sized copy of a preview at this revision, made once in the page from the full picture (which is decoded only
 *  for the moment that takes). The full URL when it is a video, already small, or the copy fails. */
function loadThumb(key: string, rev: number): Promise<string | null | undefined> {
  const c = thumbs.get(key)
  if (c?.rev === rev) return Promise.resolve(c.url)
  const f = thumbLoads.get(key)
  if (f?.rev === rev) return f.p
  const p: Promise<string | null | undefined> = loadUrl(key, rev).then(async full => {
    if (!full || videoUrls.has(full)) return full
    let url = full
    try {
      const blob = await (await fetch(full)).blob()
      const head = new Uint8Array(await blob.slice(0, 21).arrayBuffer())
      // an animated WebP (an emote's animation preview) would freeze on one frame: the full one plays
      const animated = new TextDecoder().decode(head.subarray(12, 16)) === 'VP8X' && (head[20] & 0x02) !== 0
      const bmp = animated ? null : await createImageBitmap(blob)
      if (bmp && bmp.width > THUMB_W * 1.25) {
        const small = await createImageBitmap(bmp, { resizeWidth: THUMB_W, resizeQuality: 'high' })
        const canvas = new OffscreenCanvas(small.width, small.height)
        canvas.getContext('2d')!.drawImage(small, 0, 0)
        small.close()
        url = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 }))
      }
      bmp?.close()
    } catch { /* the full picture then */ }
    if (thumbLoads.get(key)?.p !== p || revs.get(key) !== rev) { if (url !== full) URL.revokeObjectURL(url); return undefined }
    thumbLoads.delete(key)
    thumbs.set(key, { rev, url })
    return url
  })
  thumbLoads.set(key, { rev, p })
  return p
}
/** The cached URL of a preview at its current revision, if it has been read (`thumb`: its card-sized copy). */
export const cachedPreviewUrl = (key: string | undefined, thumb = false) => {
  const rev = key !== undefined ? revs.get(key) : undefined
  const c = key !== undefined ? (thumb ? thumbs : urls).get(key) : undefined
  return rev !== undefined && c?.rev === rev ? c.url : null
}

const decodedUrls = new Set<string>()
/** Whether readyPreview already decoded this URL: its image can show at once, without the blur-in. */
export const isDecoded = (url: string | null | undefined) => Boolean(url && decodedUrls.has(url))
/** A preview read and its picture decoded, so a carousel turns onto an image that is already there (no blank frame). */
export async function readyPreview(key: string | undefined, thumb = false): Promise<void> {
  const rev = key !== undefined ? revs.get(key) : undefined
  if (key === undefined || rev === undefined) return
  const url = await (thumb ? loadThumb : loadUrl)(key, rev)
  if (!url || decodedUrls.has(url)) return
  const img = new Image()
  img.src = url
  await img.decode().catch(() => undefined)
  decodedUrls.add(url)
}

/** Object URL of the mod's preview, or null while none exists. The URL is shared: unmounting never revokes it.
 *  `thumb`: its card-sized copy (loadThumb), for loadout cards. */
export function usePreviewUrl(key: string | undefined, thumb = false) {
  usePreviewVersion()
  const rev = key !== undefined ? revs.get(key) : undefined
  const cached = cachedPreviewUrl(key, thumb)
  const [shown, setShown] = useState<{ key?: string; url: string | null }>({ key, url: cached })
  useEffect(() => {
    if (key === undefined || rev === undefined) { setShown({ key, url: null }); return }
    let live = true
    ;(thumb ? loadThumb : loadUrl)(key, rev).then(url => { if (live && url !== undefined) setShown({ key, url }) })
    return () => { live = false }
  }, [key, rev, thumb])
  // A re-rendered preview keeps showing its last image until the new one is read
  return cached ?? (shown.key === key && rev !== undefined ? shown.url : null)
}

const running = () => active
/** The run going now: done of total counts its mods (a loadout's combined render is not one of them). */
const doneOf = () => Math.min(run.total - pending.size + 1, run.total)

/** Renders the job's previews now, or queues it behind the run that is going. Returns the reason it could not start,
 *  or null (started or queued; a queued job that later fails to start reports through the summary and its keys). */
export const generatePreviews = (job: Job): Promise<string | null> => {
  const q: QueuedJob = { ...job, id: jobId(job) }
  if (!running()) return start(q)
  if (!queue.some(x => x.id === q.id)) { queue.push(q); notify() }
  return Promise.resolve(null)
}

/** A start that was refused or threw: this job and everything queued behind it get the reason; nothing else starts. */
const refuse = (job: Job, reason: string) => {
  active = false
  pending.clear()
  for (const j of [job, ...queue]) keysOf(j).forEach(k => outcome.set(k, reason))
  queue.length = 0
  run.summary = job.quiet ? '' : reason
  notify()
  return reason
}

/** Starts a run; returns an error message, or null once started. Sets `active` before its first await, so jobs asked
 *  for in the same tick queue behind it. */
const start = async (job: QueuedJob): Promise<string | null> => {
  const jobs = [...new Map(job.paths.map(p => [nameKey(p), [p.replace(/[/\\][^/\\]+$/, ''), nameKey(p)] as [string, string]])).values()]
  if (jobs.length === 0) return null
  active = true
  jobs.forEach(([, k]) => { pending.add(k); outcome.delete(k) })
  if (job.set) outcome.delete(job.set)
  run = { id: job.id, total: jobs.length, made: 0, none: 0, failed: 0, stopping: false, summary: '', set: job.set, name: job.name, setResult: undefined, busy: '',
    show: Boolean(job.show), step: undefined, quiet: Boolean(job.quiet) }
  notify()
  // KO prompt mods: the KO Editor's renderer plays theirs into an animated WebP (custom/ko/koPreview.ts), the kit the rest
  const kit: typeof jobs = []
  for (const [dir, k] of jobs) {
    if (run.stopping) break
    const path = job.paths.find(p => nameKey(p) === k)!
    try {
      if (await koPreview(path, k, () => { run.step = 'ko'; notify() })) { koKeys.add(k); localStorage.setItem(KO_KEYS, JSON.stringify([...koKeys])) }
      else kit.push([dir, k])
    } catch (e) {
      console.warn(`KO preview of ${k} failed:`, e)
      outcome.set(k, FAILED)
      if (pending.delete(k)) run.failed++
      notify()
    }
  }
  if (run.stopping || !kit.length) {
    if (job.set && !run.stopping) run.setResult = 'none' // nothing left for a combined render to show
    finish(true)
    return null
  }
  run.step = undefined
  try {
    if (await invoke<boolean>('generate_mod_previews', { jobs: kit, set: job.set ?? null, force: Boolean(job.force) })) return null
    return refuse(job, 'Another preview run is still going.')
  } catch (e) {
    return refuse(job, String(e))
  }
}

/** After a run: the next queued job that has mods. */
const startNext = () => {
  let next: QueuedJob | undefined
  while (!running() && (next = queue.shift())) start(next)
}

/** Where a loadout's combined render stands: rendering now (mod done of total), waiting (1 = up next), or neither.
 *  Once its own render lands the card is done, though the run goes on for mods the render does not show (an emote, a
 *  UI or sound mod): their steps are not this card's work. */
export function usePreviewState(set: string) {
  usePreviewVersion()
  if (running() && run.set === set && run.setResult !== 'ok') return { kind: 'running' as const, done: doneOf(), total: run.total }
  const at = queue.findIndex(q => q.set === set)
  return at >= 0 ? { kind: 'queued' as const, at: at + 1 } : null
}

/** While `on`: the step the generator reports for the current mod, in words ("Rendering in Blender"); a step that rolls
 *  an easter egg shows it first, for EGG_MS (custom/previewStages.ts). Empty while off. */
export function usePreviewStage(on: boolean) {
  usePreviewVersion()
  const seed = on ? `${run.id}:${doneOf()}:${run.step}` : ''
  const egg = run.step ? stepEgg(seed) : null
  const [eggDone, setEggDone] = useState('')
  useEffect(() => {
    if (!egg) return
    const id = setTimeout(() => setEggDone(seed), EGG_MS)
    return () => clearTimeout(id)
  }, [egg, seed])
  if (!on) return ''
  // every line trails off ("Rendering in Blender…"): it is still going
  const line = run.stopping ? 'Stopping' : egg && eggDone !== seed ? egg : stepText(run.step)
  return line.endsWith('…') ? line : `${line}…`
}

/** What waits behind the run: loadouts, selections, or "preview jobs" when the queue holds both. */
const queuedText = () => {
  const sets = queue.filter(q => q.set).length
  return sets === queue.length ? plural(sets, 'loadout') : sets === 0 ? plural(queue.length, 'selection') : `${queue.length} preview jobs`
}

/** The run going now and how many wait behind it (Home's status line); null when idle. */
export function usePreviewBatch() {
  usePreviewVersion()
  if (!running()) return null
  return { name: run.name, done: doneOf(), total: run.total, left: queue.length, leftText: queuedText(), stopping: run.stopping,
    job: batchDone + 1, jobs: batchDone + 1 + queue.length }
}

/** The last run's result line ("4 made · 1 failed"), kept until the next run starts or it is dismissed. */
export function usePreviewSummary() {
  usePreviewVersion()
  return running() ? '' : run.summary
}
export const dismissPreviewSummary = () => { run.summary = ''; notify() }

/** Queues every loadout that has installed mods (one combined render each, one after another). `missing`: only the
 *  loadouts with no preview yet; `all`: every one, rendered again even when nothing changed. A card already showing its
 *  image, capture or text keeps showing it (showPreviewCover). Returns how many, or the reason the first could not
 *  start (then nothing is queued). */
export async function generateAllLoadouts(loadouts: { id: string; name: string; on: string[] }[], mods: { path: string }[], which: 'missing' | 'all' = 'all') {
  const byKey = new Map(mods.map(m => [modKey(m.path), m.path]))
  const jobs = loadouts
    .filter(l => which === 'all' || !loadoutHasPreview(l))
    .map(l => ({ paths: l.on.map(k => byKey.get(displayName(k))).filter((x): x is string => Boolean(x)), set: previewSetKey(l.id), name: l.name, force: which === 'all' }))
    .filter(j => j.paths.length > 0)
  const started = jobs.map(generatePreviews) // all asked for in this tick: the first starts, the rest queue behind it
  const error = (await Promise.all(started)).find(Boolean) ?? null
  return { count: error ? 0 : jobs.length, error }
}

/** Stops the run now (the generator is ended mid-render) and drops everything queued behind it. */
export const stopPreviews = () => stop()
const stop = () => { queue.length = 0; run.stopping = true; notify(); invoke('cancel_mod_previews').catch(() => undefined) }
const unqueue = (id: string) => {
  const i = queue.findIndex(q => q.id === id)
  if (i >= 0) { queue.splice(i, 1); notify() }
}

/** One toast per run that had failures (mounted once, on Home): what failed, that the full error is in Logs, and where
 *  to send it if it keeps happening. Open logs opens the log drawer (App.tsx listens). */
export function usePreviewFailureToast(alert: ReturnType<typeof useAlert>) {
  useEffect(() => {
    const show = (f: Failure) => {
      const n = f.failed + (f.setFailed ? 1 : 0)
      const what = f.setFailed && !f.failed ? `The ${f.name} render failed.` : `${plural(n, 'preview')} for ${f.name} failed.`
      const id = alert.error('Preview failed', `${what} The full error is in Logs. If it keeps happening, export the log there and send it to cable on Discord.`, {
        duration: 15000,
        action: { label: 'Open logs', onClick: () => { alert.dismissAlert(id); window.dispatchEvent(new Event('repakxtra-open-logs')) } },
      })
    }
    const warn = (key: string) => alert.warning('Preview may not match the game', key.startsWith(previewSetKey(''))
      ? `A mod in ${run.name} is encrypted with a key other than the game's, so the loadout's preview was made without it.`
      : `${key} is encrypted with a key other than the game's, so its files could not be read for a preview.`, { duration: 15000 })
    failureListeners.add(show)
    warnListeners.add(warn)
    return () => { failureListeners.delete(show); warnListeners.delete(warn) }
  }, [alert])
}

/** A Generate button on a PC without the preview kit: grayed out, says what is missing, and opens Setup at Mod previews. */
export function PreviewsUnavailable({ className, label }: { className: string; label: string }) {
  return (
    <button type="button" className={`${className} is-unavailable`} onClick={openPreviewSetup}
      aria-label={`${label}: needs the preview kit. Set it up in Setup`}
      title="Previews need the preview kit and Blender (both free). Click to set them up in Setup > Mod previews.">
      <WandSparkles size={16} /><span className="bulk-btn-label">{label}</span><span className="setup-chip">Set up</span>
    </button>
  )
}

/** "Electric Blue · preview 2 of 9", shimmering while it works. */
const progressText = () => `${run.name} · preview ${doneOf()} of ${run.total}`
const Shimmer = ({ text }: { text: string }) => <span className="t-shimmer">{text}</span>

/** Starts or queues a job from a button and shows why when it could not start. */
const ask = async (alert: ReturnType<typeof useAlert>, job: Job) => {
  const error = await generatePreviews(job)
  if (error) alert.warning('Previews not started', error)
}

/** Preview block for the mod details panel: the image (if any) and a Generate / Regenerate button. */
export function ModPreview({ path }: { path: string }) {
  const alert = useAlert()
  const canGenerate = usePreviewsAvailable()
  const key = nameKey(path)
  const url = usePreviewUrl(key)
  const id = jobId({ paths: [path] })
  const busy = pending.has(key)
  const queued = queue.some(q => q.id === id)
  const message = outcome.get(key)
  const forms = formKeys(key)
  const stage = usePreviewStage(busy)
  return (
    <div className="detail-section mod-preview">
      {url && (
        <div className={`mod-preview-frame${forms.length ? ' has-forms' : ''}`}>
          {isVideoPreview(url) ? <BeatVideo src={url} beat={KO_BEAT} /> : <img src={url} alt="Generated preview" onLoad={revealOnLoad} />}
          {forms.map(k => <FormImage key={k} k={k} />)}
        </div>
      )}
      {!canGenerate && <div className="mod-preview-bar"><PreviewsUnavailable className="mod-preview-btn" label="Generate preview" /></div>}
      {canGenerate && <div className="mod-preview-bar">
        <button type="button" className="mod-preview-btn" disabled={busy}
          onClick={() => (queued ? unqueue(id) : ask(alert, { paths: [path], name: key, force: Boolean(url) }))}
          title={queued ? 'Remove from the preview queue' : running() ? `Queue it: previews for ${run.name} are generating` : 'Render this mod on its character in the lobby look (about 10 to 40 seconds)'}>
          {queued ? <X size={14} /> : running() && !busy ? <ListPlus size={14} /> : <WandSparkles size={14} />}
          {busy ? <Shimmer text={stage || 'Generating preview'} /> : queued ? 'Queued' : running() ? 'Queue preview' : url ? 'Regenerate preview' : 'Generate preview'}
        </button>
        {running() && !busy && <span className="mod-preview-note">Generating <Shimmer text={progressText()} /></span>}
        {!running() && message && <span className="mod-preview-note">{message}</span>}
      </div>}
    </div>
  )
}

/** Another form's image beside the first in the details panel. */
function FormImage({ k }: { k: string }) {
  const src = usePreviewUrl(k)
  return src ? <img src={src} alt="Generated preview, another form" onLoad={revealOnLoad} /> : null
}

/** Previews for a set of mods (the selection bar, a loadout page), with progress and Stop while its own run goes.
 * While a different run goes it says so, and offers to queue this one. With `set` (a loadout), its character mods
 * render together as one image under that key. */
export function GeneratePreviewsButton({ paths, set, name, className = 'btn-ghost bulk-previews', label = 'Previews', stopOnly = false }: {
  /** stopOnly: while it runs, only its Stop button (a loadout page, whose card already shows the progress) */
  paths: string[]; set?: string; name?: string; className?: string; label?: string; stopOnly?: boolean
}) {
  usePreviewVersion()
  const alert = useAlert()
  const canGenerate = usePreviewsAvailable()
  const n = new Set(paths.map(modKey)).size
  // A loadout that already has its preview: the button renders it again, even when nothing changed
  const again = Boolean(set && (hasPreview(set) || paths.some(p => hasPreview(nameKey(p)))))
  const job: Job = { paths, set, name: name ?? `${n} selected mod${n === 1 ? '' : 's'}`, force: again, show: Boolean(set) }
  const text = again ? label.replace(/^Generate/, 'Regenerate') : label
  if (!canGenerate) return <PreviewsUnavailable className={className} label={label} />
  const id = jobId(job)
  if (running() && run.id === id) {
    // What it is doing (the dot loader and "2 of 9"), and Stop as its own button beside it
    // On a loadout page's card (stopOnly) a chip like its others: the small stop square and one word
    const stopBtn = stopOnly
      ? <button type="button" className={className} onClick={stop} disabled={run.stopping}
          title={queue.length ? `Stop generating previews, and clear the ${queue.length} queued` : 'Stop generating previews'}>
          <span className="stop-glyph" aria-hidden="true" />{run.stopping ? 'Stopping…' : 'Stop'}
        </button>
      : <button type="button" className={`${className} run-stop-btn`} onClick={stop} disabled={run.stopping}
          title={queue.length ? `Stop now, and clear the ${queue.length} queued` : 'Stop now'}>
          <span className="stop-glyph" aria-hidden="true" />Stop
        </button>
    if (stopOnly) return stopBtn
    return (
      <span className="run-group">
        <span className={`${className} is-running`} role="status">
          {run.stopping ? 'Stopping…' : <Shimmer text={`Generating ${doneOf()} of ${run.total}`} />}
        </span>
        {stopBtn}
      </span>
    )
  }
  if (running()) {
    const at = queue.findIndex(q => q.id === id)
    return (
      <>
        {at >= 0
          ? <button type="button" className={`${className} is-queued`} onClick={() => unqueue(id)} title="Remove from the preview queue">
              <X size={14} /><span className="bulk-btn-label">Queued{at > 0 ? ` (${at + 1} in line)` : ', up next'}</span>
            </button>
          : <button type="button" className={className} disabled={n === 0} onClick={() => ask(alert, job)}
              title={`Previews for ${run.name} are generating; this starts when they finish`}>
              <ListPlus size={16} /><span className="bulk-btn-label">Queue previews</span>
              {n > 0 && <span className="bulk-num">{n}</span>}
            </button>}
      </>
    )
  }
  return (
    <button type="button" className={className} disabled={n === 0} onClick={() => ask(alert, job)}
      title={run.summary ? `Last run: ${run.summary}` : again ? `Render this loadout's previews again (about 20 seconds per mod)` : `Render previews for these ${n} mods (about 20 seconds each)`}>
      <WandSparkles size={16} />
      <span className="bulk-btn-label">{text}</span>
      {n > 0 && <span className="bulk-num">{n}</span>}
    </button>
  )
}

if (import.meta.env.DEV) {
  // A job is the same job whatever order its mods come in, and a loadout's job survives a rename
  console.assert(jobId({ paths: ['C:/m/A_9999999_P.pak', 'B.bak_repak'] }) === jobId({ paths: ['C:/x/B.pak', 'A.pak', 'A.pak'] }), 'jobId: same mods, any order')
  console.assert(jobId({ paths: ['A.pak'] }) !== jobId({ paths: ['A.pak', 'B.pak'] }), 'jobId: different mods')
  console.assert(jobId({ paths: ['A.pak'], set: 'loadout-x' }) === jobId({ paths: ['B.pak'], set: 'loadout-x' }), 'jobId: a loadout keeps its id')
}
