// caleb fork: generated mod previews (lobby-look renders, UI icons, VFX swatches) made by caleb_previews.rs's
// generator for the mods you pick: the details panel's Generate button (one mod) or the selection bar's Previews
// button (every selected mod, one after another). A loadout's Generate previews also renders its character mods
// together as one image (key previewSetKey(id)); loadout cards page through the previews (loadoutBits.tsx).
// One run at a time (the generator holds a lock); asking while another runs puts the request in a queue that starts
// when the current run ends. Unchanged mods report their existing preview without rendering again; Regenerate forces.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { CircleStop, ListPlus, LoaderCircle, Sparkles, X } from 'lucide-react'
import { play } from 'cuelume'
import { useAlert } from '../components/AlertHandler'
import { modKey } from './loadoutStore'
import { revealOnLoad } from './motion'
import { plural } from './modName'

const NOTHING = 'Nothing to show for this mod: previews cover skins, meshes, textures, UI icons and your own VFX releases.'
const FAILED = 'The render failed. The reason is in %APPDATA%\\Repak-X\\previews\\generator.log; try again once it is fixed.'
const SET_FAILED = 'The loadout render failed. The reason is in %APPDATA%\\Repak-X\\previews\\generator.log.'
const BUSY = 'Another preview generator is running (a manual run or an earlier app session).'

const revs = new Map<string, number>() // key -> bump count, so a re-rendered preview reloads
const pending = new Set<string>()       // mod keys still waiting in the current run (a loadout's set key is not one)
const outcome = new Map<string, string>() // key (mod or set) -> message from its last render
export type Covers = { covers: string[]; members: string[] | null } // members null: rendered before that was recorded
const covers = new Map<string, Covers & { rev: number }>() // loadout render key -> the mods it shows and the mods it was rendered for
// Shared caches, so a card that remounts (Home -> page -> Home) shows its image at once without reading it again.
// Entries belong to one revision; a newer one, or none, drops them. A read that finishes after its revision was dropped
// or replaced is thrown away, so it can never bring back an old image or old covers.
const urls = new Map<string, { rev: number; url: string }>() // preview key -> object URL of its PNG
const urlLoads = new Map<string, { rev: number; p: Promise<string | null | undefined> }>()
const coverLoads = new Map<string, { rev: number; p: Promise<unknown> }>()
/** Forget a key's cached image and covers (its revision changed, or it has none now). */
const dropCached = (key: string) => {
  const u = urls.get(key)
  if (u) URL.revokeObjectURL(u.url)
  urls.delete(key)
  urlLoads.delete(key)
  covers.delete(key)
  coverLoads.delete(key)
}
/** What a run is for: its mods, the loadout's combined render key (if any), a name to show ("Electric Blue"), and
 *  force (Regenerate: render even when nothing changed). */
type Job = { paths: string[]; set?: string; name: string; force?: boolean }
type QueuedJob = Job & { id: string }
/** A job's identity: its loadout render key, else its mods in any order. The name is for display only (a loadout can be
 *  renamed mid-run). Pure. */
export const jobId = (j: { paths: string[]; set?: string }) => j.set ?? `mods:${JSON.stringify([...new Set(j.paths.map(modKey))].sort())}`
const keysOf = (j: Job) => [...new Set(j.paths.map(modKey)), ...(j.set ? [j.set] : [])]
const queue: QueuedJob[] = []
let active = false // a run was accepted and its done event has not arrived yet
type SetResult = 'ok' | 'none' | 'failed' | undefined
let run = { id: '', total: 0, made: 0, none: 0, failed: 0, stopping: false, summary: '', set: undefined as string | undefined, name: '', setResult: undefined as SetResult, busy: '' }
let version = 0
const listeners = new Set<() => void>()
const notify = () => { version++; listeners.forEach(l => l()) }
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }

invoke<string[]>('list_mod_previews').then(keys => { keys.forEach(k => revs.set(k, 0)); notify() }).catch(() => undefined)
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
  if (active && e.payload === run.set) run.setResult = 'ok'
  if (active && pending.delete(e.payload)) run.made++
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
listen('mod-previews-busy', () => { // the generator refused: another one holds its lock. Nothing starts until done
  if (!active) return
  run.busy = BUSY
  for (const k of [...pending, ...(run.set ? [run.set] : []), ...queue.flatMap(keysOf)]) outcome.set(k, BUSY)
  pending.clear()
  queue.length = 0
  notify()
}).catch(() => undefined)
listen<boolean>('mod-previews-done', e => {
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
  const summary = run.busy || (e.payload || run.made || run.none || run.failed ? parts.filter(Boolean).join(' · ') : FAILED)
  run = { ...run, stopping: false, summary }
  play(run.busy ? 'warning' : run.made && !failed && run.setResult !== 'failed' ? 'ready' : run.made ? 'warning' : 'error')
  notify()
  startNext()
}).catch(() => undefined)

export const usePreviewVersion = () => useSyncExternalStore(subscribe, () => version)
export const hasPreview = (key: string) => revs.has(key)
/** Key of a loadout's combined character render. */
export const previewSetKey = (loadoutId: string) => `loadout-${loadoutId}`
/** A loadout has previews when its combined render exists or any of its mods has its own (loadouts of only VFX, UI or
 *  sound mods never get a combined render). */
export const loadoutHasPreview = (l: { id: string; on: string[] }) => hasPreview(previewSetKey(l.id)) || l.on.some(k => hasPreview(modKey(k)))
/** The message from a key's last render (failed, nothing to show, another generator busy), if any. */
export function usePreviewOutcome(key: string) {
  usePreviewVersion()
  return outcome.get(key)
}

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
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
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
/** The cached URL of a preview at its current revision, if it has been read. */
export const cachedPreviewUrl = (key: string | undefined) => {
  const rev = key !== undefined ? revs.get(key) : undefined
  const c = key !== undefined ? urls.get(key) : undefined
  return rev !== undefined && c?.rev === rev ? c.url : null
}

/** Object URL of the mod's preview, or null while none exists. The URL is shared: unmounting never revokes it. */
export function usePreviewUrl(key: string | undefined) {
  usePreviewVersion()
  const rev = key !== undefined ? revs.get(key) : undefined
  const cached = cachedPreviewUrl(key)
  const [shown, setShown] = useState<{ key?: string; url: string | null }>({ key, url: cached })
  useEffect(() => {
    if (key === undefined || rev === undefined) { setShown({ key, url: null }); return }
    let live = true
    loadUrl(key, rev).then(url => { if (live && url !== undefined) setShown({ key, url }) })
    return () => { live = false }
  }, [key, rev])
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
  run.summary = reason
  notify()
  return reason
}

/** Starts a run; returns an error message, or null once started. Sets `active` before its first await, so jobs asked
 *  for in the same tick queue behind it. */
const start = async (job: QueuedJob): Promise<string | null> => {
  const jobs = [...new Map(job.paths.map(p => [modKey(p), [p.replace(/[/\\][^/\\]+$/, ''), modKey(p)] as [string, string]])).values()]
  if (jobs.length === 0) return null
  active = true
  jobs.forEach(([, k]) => { pending.add(k); outcome.delete(k) })
  if (job.set) outcome.delete(job.set)
  run = { id: job.id, total: jobs.length, made: 0, none: 0, failed: 0, stopping: false, summary: '', set: job.set, name: job.name, setResult: undefined, busy: '' }
  notify()
  try {
    if (await invoke<boolean>('generate_mod_previews', { jobs, set: job.set ?? null, force: Boolean(job.force) })) return null
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

/** Where a loadout's combined render stands: rendering now (mod done of total), waiting (1 = up next), or neither. */
export function usePreviewState(set: string) {
  usePreviewVersion()
  if (running() && run.set === set) return { kind: 'running' as const, done: doneOf(), total: run.total }
  const at = queue.findIndex(q => q.set === set)
  return at >= 0 ? { kind: 'queued' as const, at: at + 1 } : null
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
  return { name: run.name, done: doneOf(), total: run.total, left: queue.length, leftText: queuedText(), stopping: run.stopping }
}

/** The last run's result line ("4 made · 1 failed"), kept until the next run starts or it is dismissed. */
export function usePreviewSummary() {
  usePreviewVersion()
  return running() ? '' : run.summary
}
export const dismissPreviewSummary = () => { run.summary = ''; notify() }

/** Queues every loadout that has installed mods (one combined render each, one after another). `missing`: only the
 *  loadouts with no preview yet; `all`: every one, rendered again even when nothing changed. Returns how many, or the
 *  reason the first could not start (then nothing is queued). */
export async function generateAllLoadouts(loadouts: { id: string; name: string; on: string[] }[], mods: { path: string }[], which: 'missing' | 'all' = 'all') {
  const byKey = new Map(mods.map(m => [modKey(m.path), m.path]))
  const jobs = loadouts
    .filter(l => which === 'all' || !loadoutHasPreview(l))
    .map(l => ({ paths: l.on.map(k => byKey.get(modKey(k))).filter((x): x is string => Boolean(x)), set: previewSetKey(l.id), name: l.name, force: which === 'all' }))
    .filter(j => j.paths.length > 0)
  const started = jobs.map(generatePreviews) // all asked for in this tick: the first starts, the rest queue behind it
  const error = (await Promise.all(started)).find(Boolean) ?? null
  return { count: error ? 0 : jobs.length, error }
}

/** Stops the run after the mod rendering now, and drops everything queued behind it. */
export const stopPreviews = () => stop()
const stop = () => { queue.length = 0; run.stopping = true; notify(); invoke('cancel_mod_previews').catch(() => undefined) }
const unqueue = (id: string) => {
  const i = queue.findIndex(q => q.id === id)
  if (i >= 0) { queue.splice(i, 1); notify() }
}

/** "Electric Blue · mod 2 of 9", shimmering while it works. */
const progressText = () => `${run.name} · mod ${doneOf()} of ${run.total}`
const Shimmer = ({ text }: { text: string }) => <span className="t-shimmer" data-text={text}>{text}</span>

/** Starts or queues a job from a button and shows why when it could not start. */
const ask = async (alert: ReturnType<typeof useAlert>, job: Job) => {
  const error = await generatePreviews(job)
  if (error) alert.warning('Previews not started', error)
}

/** Preview block for the mod details panel: the image (if any) and a Generate / Regenerate button. */
export function ModPreview({ path }: { path: string }) {
  const alert = useAlert()
  const canGenerate = usePreviewsAvailable()
  const key = modKey(path)
  const url = usePreviewUrl(key)
  const id = jobId({ paths: [path] })
  const busy = pending.has(key)
  const queued = queue.some(q => q.id === id)
  const message = outcome.get(key)
  return (
    <div className="detail-section mod-preview">
      {url && (
        <div className="mod-preview-frame"><img src={url} alt="Generated preview" onLoad={revealOnLoad} /></div>
      )}
      {canGenerate && <div className="mod-preview-bar">
        <button type="button" className="mod-preview-btn" disabled={busy}
          onClick={() => (queued ? unqueue(id) : ask(alert, { paths: [path], name: key, force: Boolean(url) }))}
          title={queued ? 'Remove from the preview queue' : running() ? `Queue it: previews for ${run.name} are generating` : 'Render this mod on its character in the lobby look (about 10 to 40 seconds)'}>
          {queued ? <X size={14} /> : running() && !busy ? <ListPlus size={14} /> : <Sparkles size={14} />}
          {busy ? <Shimmer text="Generating preview" /> : queued ? 'Queued' : running() ? 'Queue preview' : url ? 'Regenerate preview' : 'Generate preview'}
        </button>
        {running() && !busy && <span className="mod-preview-note">Generating <Shimmer text={progressText()} /></span>}
        {!running() && message && <span className="mod-preview-note">{message}</span>}
      </div>}
    </div>
  )
}

/** Previews for a set of mods (the selection bar, a loadout page), with progress and Stop while its own run goes.
 * While a different run goes it says so, and offers to queue this one. With `set` (a loadout), its character mods
 * render together as one image under that key. */
export function GeneratePreviewsButton({ paths, set, name, className = 'btn-ghost bulk-previews', label = 'Previews' }: {
  paths: string[]; set?: string; name?: string; className?: string; label?: string
}) {
  usePreviewVersion()
  const alert = useAlert()
  const canGenerate = usePreviewsAvailable()
  const n = new Set(paths.map(modKey)).size
  // A loadout that already has its preview: the button renders it again, even when nothing changed
  const again = Boolean(set && (hasPreview(set) || paths.some(p => hasPreview(modKey(p)))))
  const job: Job = { paths, set, name: name ?? `${n} selected mod${n === 1 ? '' : 's'}`, force: again }
  const text = again ? label.replace(/^Generate/, 'Regenerate') : label
  if (!canGenerate) return null
  const id = jobId(job)
  if (running() && run.id === id) {
    return (
      <button type="button" className={`${className} is-running`} onClick={stop} disabled={run.stopping}
        title={queue.length ? `Stop after the mod that is rendering now, and clear the ${queue.length} queued` : 'Stop after the mod that is rendering now'}>
        {/* a spinner while it works; pointing at it shows Stop */}
        <span className="run-icon" aria-hidden="true"><LoaderCircle size={14} className="run-spin" /><CircleStop size={14} className="run-stop" /></span>
        {run.stopping ? 'Stopping…' : <Shimmer text={`Generating mod ${doneOf()} of ${run.total}`} />}
      </button>
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
        <span className="preview-run-note" title="Another preview run is going">Generating <Shimmer text={progressText()} /></span>
      </>
    )
  }
  return (
    <button type="button" className={className} disabled={n === 0} onClick={() => ask(alert, job)}
      title={run.summary ? `Last run: ${run.summary}` : again ? `Render this loadout's previews again (about 20 seconds per mod)` : `Render previews for these ${n} mods (about 20 seconds each)`}>
      <Sparkles size={16} />
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
