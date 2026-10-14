// caleb fork: generated mod previews (game-look renders, UI icons, VFX swatches) made one mod at a time by
// caleb_previews.rs's generator. The details panel has the Generate button; loadout cards without an image of
// their own show the first of their mods that has a preview.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ImagePlus, RefreshCw } from 'lucide-react'
import { modKey } from './loadoutStore'

const revs = new Map<string, number>() // key -> bump count, so a re-rendered preview reloads
let generating: string | null = null
const outcome = new Map<string, string>() // key -> message from its last render
let version = 0
const listeners = new Set<() => void>()
const notify = () => { version++; listeners.forEach(l => l()) }
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }

invoke<string[]>('list_mod_previews').then(keys => { keys.forEach(k => revs.set(k, 0)); notify() }).catch(() => undefined)
listen<string>('mod-preview-ready', e => { revs.set(e.payload, (revs.get(e.payload) ?? 0) + 1); notify() }).catch(() => undefined)
listen<[string, boolean]>('mod-previews-done', e => {
  const [key, ok] = e.payload
  const made = revs.has(key)
  outcome.set(key, !ok ? 'The render failed. Try again, or check the generator in your modding tools.'
    : made ? '' : 'Nothing to show for this mod: previews cover skins, meshes, textures, UI icons and your own VFX releases.')
  generating = null
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

const generate = async (path: string) => {
  const key = modKey(path)
  const modsDir = path.replace(/[/\\][^/\\]+$/, '')
  outcome.delete(key)
  generating = key
  notify()
  try {
    if (!(await invoke<boolean>('generate_mod_preview', { modsDir, key }))) {
      generating = null
      outcome.set(key, 'Another preview is still rendering. Try again when it finishes.')
      notify()
    }
  } catch (e) {
    generating = null
    outcome.set(key, String(e))
    notify()
  }
}

/** Preview block for the mod details panel: the image (if any) and a Generate / Regenerate button. */
export function ModPreview({ path }: { path: string }) {
  const key = modKey(path)
  const url = usePreviewUrl(key)
  const busy = generating === key
  const message = outcome.get(key)
  return (
    <div className="detail-section mod-preview">
      {url && (
        <div className="mod-preview-frame"><img src={url} alt="Generated preview" /></div>
      )}
      <div className="mod-preview-bar">
        <button type="button" className="mod-preview-btn" disabled={generating !== null} onClick={() => generate(path)}
          title="Render this mod on its character with the game's toon look (about 10 to 30 seconds)">
          {url ? <RefreshCw size={14} /> : <ImagePlus size={14} />}
          {busy ? 'Rendering preview…' : url ? 'Regenerate preview' : 'Generate preview'}
        </button>
        {message && <span className="mod-preview-note">{message}</span>}
      </div>
    </div>
  )
}
