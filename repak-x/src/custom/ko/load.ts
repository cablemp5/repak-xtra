// repakxtra: a hero's KO prompt read from the installed game (xtra_ko.rs): its widget, materials and textures, ready to
// draw. The KO Editor and the Library's KO previews (koPreview.ts) share it, and what one opened the other reuses.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { type Material, readMaterial, readWidget } from './model'
import { type Images, type Scene, KO_FONT, makeScene } from './render'
import { readAsset } from './export'

export type Hero = { id: string; name: string; widget: string }
export type Loaded = { hero: Hero; scene: Scene; widgetJson: string }

export async function usmapPath(): Promise<string> {
  const s = await invoke<{ usmapPath?: string | null }>('vfx_get_settings').catch(() => ({ usmapPath: null }))
  if (s.usmapPath && await invoke<boolean>('vfx_usmap_exists', { path: s.usmapPath })) return s.usmapPath
  const r = await invoke<{ localPath?: string | null }>('vfx_check_usmap_update', { force: false }).catch(() => ({ localPath: null }))
  if (r.localPath) return r.localPath
  throw new Error('No USMAP yet. Connect to the internet once so repakxtra can fetch it, then try again.')
}

const cache = new Map<string, Promise<Loaded>>() // heroes opened this session, by hero and USMAP, shared while they load
/** Drops a hero's cached load (the game updated under it): the next loadHero reads the game again. */
export const forgetHero = (id: string) => { for (const k of cache.keys()) if (k.startsWith(`${id}|`)) cache.delete(k) }

/** Where a load is: the backend's three slow steps (xtra_ko.rs ko-progress), then the textures read here, counted. */
export type Progress = { step: 1 | 2 | 3 | 4; at: number; done?: number; total?: number }

/** Reads material JSONs and texture PNGs (package path, file) into the maps, over what they hold. */
export async function readFiles(r: { materials: [string, string][]; textures: [string, string][] }, materials: Map<string, Material>, images: Images, tick = () => {}) {
  await Promise.all(r.materials.map(async ([path, file]) => { materials.set(path, readMaterial(await readAsset(file))); tick() }))
  await Promise.all(r.textures.map(async ([path, file]) => {
    const bytes = await invoke<ArrayBuffer>('xtra_ko_file', { path: file }).catch(() => null)
    const image = bytes && await createImageBitmap(new Blob([bytes], { type: 'image/png' })).catch(() => null)
    if (image) images.set(path, image)
    tick()
  }))
}

/** A hero's prompt, read once per session. A second caller while it loads waits on the same read (no progress for it). */
export function loadHero(hero: Hero, usmap: string, onProgress: (p: Progress) => void): Promise<Loaded> {
  const key = `${hero.id}|${usmap}`
  let p = cache.get(key)
  if (!p) {
    p = read(hero, usmap, onProgress)
    cache.set(key, p)
    p.catch(() => { if (cache.get(key) === p) cache.delete(key) }) // a failed read is tried again next time
  }
  return p
}

async function read(hero: Hero, usmap: string, onProgress: (p: Progress) => void): Promise<Loaded> {
  await document.fonts.load(`50px "${KO_FONT}"`).catch(() => undefined) // the text is measured for its layout
  const stop = await listen<number>('ko-progress', e => onProgress({ step: e.payload as 1 | 2 | 3, at: Date.now() }))
  const r = await invoke<{ widgetJson: string; materials: [string, string][]; textures: [string, string][] }>('xtra_ko_load', { usmapPath: usmap, widget: hero.widget })
    .finally(stop)
  let done = 0
  const total = r.textures.length + r.materials.length + 1
  const tick = () => onProgress({ step: 4, at: Date.now(), done: ++done, total })
  onProgress({ step: 4, at: Date.now(), done, total })
  const w = readWidget(await readAsset(r.widgetJson))
  tick()
  const materials = new Map<string, Material>(), images: Images = new Map()
  await readFiles(r, materials, images, tick)
  return { hero, scene: makeScene(w, materials, images), widgetJson: r.widgetJson }
}
