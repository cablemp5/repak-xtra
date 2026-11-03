// repakxtra: makes a KO prompt mod from the KO Editor's colors. It starts from the installed game's own widget every time
// (xtra_ko.rs reads it per game build), writes the colors into it, converts it back, checks that it reads back whole, packs
// it for the normal install dialog. Nothing stored from an older game build goes in, so a patch never leaves an old widget behind.
import { invoke } from '@tauri-apps/api/core'
import { type Asset, type Role, applyRole, linearOf } from './model'

export type KoStep = 'Writing the colors' | 'Rebuilding the widget' | 'Checking it' | 'Packing the mod'
export type KoBuild = { usmapPath: string; widgetJson: string; widgetRel: string; roles: Role[]; colors: Map<string, string>; name: string; step: (s: KoStep) => void }
export const readAsset = async (path: string): Promise<Asset> => JSON.parse((await invoke<string>('vfx_read_json_file', { path })).replace(/^﻿/, ''))

export async function buildKo(o: KoBuild): Promise<string> {
  o.step('Writing the colors')
  const stage = await invoke<string>('xtra_ko_stage')
  const asset = await readAsset(o.widgetJson)
  let changed = 0
  for (const r of o.roles) {
    const hex = o.colors.get(r.id)
    if (hex) changed += applyRole(asset, r, linearOf(hex))
  }
  if (!changed) throw new Error('No color was changed, so there is nothing to install.')
  await invoke('vfx_write_json_file', { path: `${stage}/json/${o.widgetRel}.json`, content: JSON.stringify(asset) })

  o.step('Rebuilding the widget')
  const built = await invoke<string[]>('vfx_convert_json_to_uassets', { usmapPath: o.usmapPath, inputDir: `${stage}/json`, outputDir: `${stage}/out` })
  if (!built.length) throw new Error('The widget could not be rebuilt. Check the USMAP in Setup, then try again.')

  // a widget that does not read back whole with today's USMAP would crash the game: it never goes in
  o.step('Checking it')
  const unread = await invoke<string[]>('xtra_vfx_verify', { usmapPath: o.usmapPath, dir: `${stage}/out`, rels: [o.widgetRel], jsonDir: `${stage}/json`, stageDir: stage })
  if (unread.length) throw new Error('The rebuilt widget does not read back with the game\'s USMAP, so it was not installed.')

  o.step('Packing the mod')
  const stem = o.name.trim().replace(/[^A-Za-z0-9 _-]/g, '').split(/\s+/).join('_') || 'KO_prompt'
  const utoc = await invoke<string>('vfx_pack_to_iostore', { usmapPath: o.usmapPath, inputDir: `${stage}/out`, outputBase: `${stage}/pack/${stem}`, allowedAssets: [`${o.widgetRel}.uasset`] })

  return utoc.replace(/\.utoc$/i, '.pak')
}
