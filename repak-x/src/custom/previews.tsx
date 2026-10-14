// caleb fork: generated mod previews (lobby-look renders, UI icons, VFX swatches) made by caleb_previews.rs's
// generator for the mods you pick: the details panel's Generate button (one mod) or the selection bar's Previews
// button (every selected mod, one after another). Loadout cards without an image of their own show the first of
// their mods that has a preview.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ImagePlus, RefreshCw, Square } from 'lucide-react'
import { modKey } from './loadoutStore'

const NOTHING = 'Nothing to show for this mod: previews cover skins, meshes, textures, UI icons and your own VFX releases.'
const FAILED = 'The render failed. Try again, or check the generator in your modding tools.'

const revs = new Map<string, number>() // key -> bump count, so a re-rendered preview reloads
const pending = new Set<string>()       // keys still waiting in the current run
const outcome = new Map<string, string>() // key -> message from its last render
let run = { total: 0, made: 0, none: 0, stopping: false, summary: '' }
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
  notify()
}).catch(() => undefined)

export const usePreviewVersion = () => useSyncExternalStore(subscribe, () => version)
export const hasPreview = (key: string) => revs.has(key)

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

/** Renders the given mods' previews one after another; returns an error message, or null once started. */
const generate = async (paths: string[]) => {
  const jobs = [...new Map(paths.map(p => [modKey(p), [p.replace(/[/\\][^/\\]+$/, ''), modKey(p)] as [string, string]])).values()]
  if (jobs.length === 0 || pending.size > 0) return null
  jobs.forEach(([, k]) => { pending.add(k); outcome.delete(k) })
  run = { total: jobs.length, made: 0, none: 0, stopping: false, summary: '' }
  notify()
  try {
    if (await invoke<boolean>('generate_mod_previews', { jobs })) return null
    pending.clear()
    run.summary = 'Another preview run is still going.'
  } catch (e) {
    pending.clear()
    run.summary = String(e)
  }
  notify()
  return run.summary
}

const stop = () => { run.stopping = true; notify(); invoke('cancel_mod_previews').catch(() => undefined) }

/** Preview block for the mod details panel: the image (if any) and a Generate / Regenerate button. */
export function ModPreview({ path }: { path: string }) {
  const key = modKey(path)
  const url = usePreviewUrl(key)
  const busy = pending.has(key)
  const message = outcome.get(key)
  return (
    <div className="detail-section mod-preview">
      {url && (
        <div className="mod-preview-frame"><img src={url} alt="Generated preview" /></div>
      )}
      <div className="mod-preview-bar">
        <button type="button" className="mod-preview-btn" disabled={pending.size > 0} onClick={() => generate([path])}
          title="Render this mod on its character in the lobby look (about 10 to 40 seconds)">
          {url ? <RefreshCw size={14} /> : <ImagePlus size={14} />}
          {busy ? 'Rendering preview…' : url ? 'Regenerate preview' : 'Generate preview'}
        </button>
        {message && <span className="mod-preview-note">{message}</span>}
      </div>
    </div>
  )
}

/** Selection bar button: previews for every selected mod, with progress and Stop while it runs. */
export function GeneratePreviewsButton({ paths, className = 'btn-ghost bulk-previews', label = 'Previews' }: {
  paths: string[]; className?: string; label?: string
}) {
  usePreviewVersion()
  const running = pending.size > 0
  const done = run.total - pending.size
  if (running) {
    return (
      <button type="button" className={`${className} is-running`} onClick={stop} disabled={run.stopping}
        title="Stop after the mod that is rendering now">
        <Square size={14} />
        {run.stopping ? 'Stopping…' : `Rendering ${Math.min(done + 1, run.total)} of ${run.total}`}
      </button>
    )
  }
  const n = new Set(paths.map(modKey)).size
  return (
    <button type="button" className={className} disabled={n === 0} onClick={() => generate(paths)}
      title={run.summary ? `Last run: ${run.summary}` : `Render previews for these ${n} mods (about 20 seconds each)`}>
      <ImagePlus size={16} />
      <span className="bulk-btn-label">{label}</span>
      {n > 0 && <span className="bulk-num">{n}</span>}
    </button>
  )
}
