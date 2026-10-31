// repakxtra: the Library's preview of a KO prompt mod, made by the KO Editor's renderer instead of the preview kit. The
// mod's own widget plays over the game's textures for its hero, once on a transparent background, saved as a WebM (record.ts)
// in the mod's preview slot. Only mods that change nothing but one KO widget come here (xtra_ko.rs xtra_ko_mod).
import { invoke } from '@tauri-apps/api/core'
import { readWidget } from './model'
import { makeScene } from './render'
import { recordClip } from './record'
import { readAsset } from './export'
import { type Hero, loadHero, readFiles, usmapPath } from './load'

const SIZE = { w: 640, h: 904 } // the kit's preview size (640 by 905), even for the encoder

let heroes: Promise<Hero[]> | null = null

/** Makes and saves the mod's KO preview. False when the mod is not a KO-only mod, or its files cannot be listed (the kit
 *  renders it then). Throws when a KO mod fails to render.
 *  `onKo` runs once it is known to be one, before the slow part. */
export async function koPreview(modPath: string, key: string, onKo: () => void): Promise<boolean> {
  if (!await invoke<boolean>('xtra_ko_is_mod', { modPath })) return false
  const usmap = await usmapPath()
  const m = await invoke<{ hero: string; widgetJson: string; materials: [string, string][]; textures: [string, string][] } | null>('xtra_ko_mod', { usmapPath: usmap, modPath })
  if (!m) throw new Error('This KO prompt mod could not be read.')
  heroes ??= invoke<Hero[]>('xtra_ko_heroes', { usmapPath: usmap }).catch(e => { heroes = null; throw e })
  const hero = (await heroes).find(h => h.id === m.hero)
  if (!hero) return false
  onKo()
  const game = await loadHero(hero, usmap, () => undefined)
  // the mod's widget (its colors and timing) with its own textures and materials over the game's
  const materials = new Map(game.scene.materials), images = new Map(game.scene.images)
  await readFiles(m, materials, images)
  const scene = makeScene(readWidget(await readAsset(m.widgetJson)), materials, images)
  const clip = await recordClip(scene, SIZE, 4, new Map())
  if (!clip) throw new Error('This WebView cannot record video.')
  await invoke('xtra_ko_save_preview', new Uint8Array(await clip.arrayBuffer()), { headers: { key: encodeURIComponent(key) } })
  return true
}
