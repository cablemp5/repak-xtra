// caleb fork: generated mod previews (lobby-look renders, UI icons, VFX swatches) made by caleb_previews.rs's
// generator for the mods you pick: the details panel's Generate button (one mod) or the selection bar's Previews
// button (every selected mod, one after another). A loadout's Generate previews also renders its character mods
// together as one image (key previewSetKey(id)); loadout cards page through the previews (loadoutBits.tsx).
// One run at a time (the generator holds a lock); asking while another runs puts the request in a queue that starts
// when the current run ends.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ListPlus, Sparkles, Square, X } from 'lucide-react'
import { play } from 'cuelume'
import { modKey } from './loadoutStore'
import { revealOnLoad } from './motion'

const NOTHING = 'Nothing to show for this mod: previews cover skins, meshes, textures, UI icons and your own VFX releases.'
const FAILED = 'The render failed. Try again, or check the generator in your modding tools.'

const revs = new Map<string, number>() // key -> bump count, so a re-rendered preview reloads
const pending = new Set<string>()       // keys still waiting in the current run
const outcome = new Map<string, string>() // key -> message from its last render
const covers = new Map<string, string[]>() // loadout render key -> the mods it shows
/** What a run is for: its mods, the loadout's combined render key (if any), and a name to show ("Electric Blue"). */
type Job = { paths: string[]; set?: string; name: string }
const sameJob = (a: { set?: string; name: string }, b: { set?: string; name: string }) => a.set === b.set && a.name === b.name
const queue: Job[] = []
let run = { total: 0, made: 0, none: 0, stopping: false, summary: '', set: undefined as string | undefined, name: '' }
let version = 0
const listeners = new Set<() => void>()
const notify = () => { version++; listeners.forEach(l => l()) }
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }

invoke<string[]>('list_mod_previews').then(keys => { keys.forEach(k => revs.set(k, 0)); notify() }).catch(() => undefined)
listen<string>('mod-preview-ready', e => {
  revs.set(e.payload, (revs.get(e.payload) ?? 0) + 1)
  outcome.delete(e.payload)
  if (pending.delete(e.payload)) run.made++
  notify()
}).catch(() => undefined)
listen<string>('mod-preview-in', e => { // shown in the loadout's combined render instead of its own
  outcome.delete(e.payload)
  if (pending.delete(e.payload)) run.made++
  notify()
}).catch(() => undefined)
listen<string>('mod-preview-none', e => {
  outcome.set(e.payload, NOTHING)
  if (pending.delete(e.payload)) run.none++
  notify()
}).catch(() => undefined)
listen<boolean>('mod-previews-done', e => {
  const left = pending.size
  pending.forEach(k => outcome.set(k, run.stopping ? 'Stopped before this mod.' : FAILED))
  pending.clear()
  const parts = [`${run.made} made`, run.none && `${run.none} with nothing to show`, left && `${left} ${run.stopping ? 'skipped' : 'failed'}`]
  run = { ...run, stopping: false, summary: e.payload || run.made ? parts.filter(Boolean).join(' · ') : FAILED }
  play(run.made ? 'ready' : e.payload ? 'warning' : 'error') // a slow run finished: the result is there
  notify()
  const next = queue.shift()
  if (next) start(next)
}).catch(() => undefined)

export const usePreviewVersion = () => useSyncExternalStore(subscribe, () => version)
export const hasPreview = (key: string) => revs.has(key)
/** Key of a loadout's combined character render. */
export const previewSetKey = (loadoutId: string) => `loadout-${loadoutId}`

/** The mods a loadout's combined render shows (they get no slide of their own). */
export function useCovers(setKey: string) {
  usePreviewVersion()
  const rev = revs.get(setKey)
  useEffect(() => {
    if (rev === undefined) return
    invoke<string[]>('get_preview_covers', { key: setKey }).then(k => { covers.set(setKey, k); notify() }).catch(() => undefined)
  }, [setKey, rev])
  return rev === undefined ? [] : covers.get(setKey) ?? []
}

/** Object URL of the mod's preview, or null while none exists. */
export function usePreviewUrl(key: string | undefined) {
  usePreviewVersion()
  const rev = key !== undefined ? revs.get(key) : undefined
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (key === undefined || rev === undefined) { setUrl(null); return }
    let made: string | null = null
    let live = true
    invoke<ArrayBuffer>('get_mod_preview', { key })
      .then(bytes => {
        if (!live) return
        made = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        setUrl(made)
      })
      .catch(() => live && setUrl(null))
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [key, rev])
  return url
}

const running = () => pending.size > 0

/** Renders the job's previews now, or queues it behind the run that is going. */
export const generatePreviews = (job: Job) => generate(job)
const generate = (job: Job) => {
  if (!running()) start(job)
  else if (!queue.some(q => sameJob(q, job))) { queue.push(job); notify() }
}

/** Starts a run; returns an error message, or null once started. */
const start = async ({ paths, set, name }: Job) => {
  const jobs = [...new Map(paths.map(p => [modKey(p), [p.replace(/[/\\][^/\\]+$/, ''), modKey(p)] as [string, string]])).values()]
  if (jobs.length === 0 || running()) return null
  jobs.forEach(([, k]) => { pending.add(k); outcome.delete(k) })
  run = { total: jobs.length, made: 0, none: 0, stopping: false, summary: '', set, name }
  notify()
  try {
    if (await invoke<boolean>('generate_mod_previews', { jobs, set: set ?? null })) return null
    pending.clear()
    run.summary = 'Another preview run is still going.'
  } catch (e) {
    pending.clear()
    run.summary = String(e)
  }
  notify()
  return run.summary
}

/** Stops the run after the mod rendering now, and drops everything queued behind it. */
const stop = () => { queue.length = 0; run.stopping = true; notify(); invoke('cancel_mod_previews').catch(() => undefined) }
const unqueue = (job: { set?: string; name: string }) => {
  const i = queue.findIndex(q => sameJob(q, job))
  if (i >= 0) { queue.splice(i, 1); notify() }
}

/** "Generating Electric Blue · 2 of 9", shimmering while it works. */
const progressText = () => `${run.name} · ${Math.min(run.total - pending.size + 1, run.total)} of ${run.total}`
const Shimmer = ({ text }: { text: string }) => <span className="t-shimmer" data-text={text}>{text}</span>

/** Preview block for the mod details panel: the image (if any) and a Generate / Regenerate button. */
export function ModPreview({ path }: { path: string }) {
  const key = modKey(path)
  const url = usePreviewUrl(key)
  const name = key
  const busy = pending.has(key)
  const queued = queue.some(q => sameJob(q, { name }))
  const message = outcome.get(key)
  return (
    <div className="detail-section mod-preview">
      {url && (
        <div className="mod-preview-frame"><img src={url} alt="Generated preview" onLoad={revealOnLoad} /></div>
      )}
      <div className="mod-preview-bar">
        <button type="button" className="mod-preview-btn" disabled={busy}
          onClick={() => (queued ? unqueue({ name }) : generate({ paths: [path], name }))}
          title={queued ? 'Remove from the preview queue' : running() ? `Queue it: previews for ${run.name} are generating` : 'Render this mod on its character in the lobby look (about 10 to 40 seconds)'}>
          {queued ? <X size={14} /> : running() && !busy ? <ListPlus size={14} /> : <Sparkles size={14} />}
          {busy ? <Shimmer text="Generating preview" /> : queued ? 'Queued' : running() ? 'Queue preview' : url ? 'Regenerate preview' : 'Generate preview'}
        </button>
        {running() && !busy && <span className="mod-preview-note">Generating <Shimmer text={progressText()} /></span>}
        {!running() && message && <span className="mod-preview-note">{message}</span>}
      </div>
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
  const n = new Set(paths.map(modKey)).size
  const job: Job = { paths, set, name: name ?? `${n} selected mod${n === 1 ? '' : 's'}` }
  if (running() && sameJob(run, job)) {
    return (
      <button type="button" className={`${className} is-running`} onClick={stop} disabled={run.stopping}
        title={queue.length ? `Stop after the mod that is rendering now, and clear the ${queue.length} queued` : 'Stop after the mod that is rendering now'}>
        <Square size={14} />
        {run.stopping ? 'Stopping…' : <Shimmer text={`Generating ${Math.min(run.total - pending.size + 1, run.total)} of ${run.total}`} />}
      </button>
    )
  }
  if (running()) {
    const at = queue.findIndex(q => sameJob(q, job))
    return (
      <>
        {at >= 0
          ? <button type="button" className={`${className} is-queued`} onClick={() => unqueue(job)} title="Remove from the preview queue">
              <X size={14} /><span className="bulk-btn-label">Queued{at > 0 ? ` (${at + 1} in line)` : ', up next'}</span>
            </button>
          : <button type="button" className={className} disabled={n === 0} onClick={() => generate(job)}
              title={`Previews for ${run.name} are generating; this starts when they finish`}>
              <ListPlus size={16} /><span className="bulk-btn-label">Queue previews</span>
              {n > 0 && <span className="bulk-num">{n}</span>}
            </button>}
        <span className="preview-run-note" title="Another preview run is going">Generating <Shimmer text={progressText()} /></span>
      </>
    )
  }
  return (
    <button type="button" className={className} disabled={n === 0} onClick={() => generate(job)}
      title={run.summary ? `Last run: ${run.summary}` : `Render previews for these ${n} mods (about 20 seconds each)`}>
      <Sparkles size={16} />
      <span className="bulk-btn-label">{label}</span>
      {n > 0 && <span className="bulk-num">{n}</span>}
    </button>
  )
}
