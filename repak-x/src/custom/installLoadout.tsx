// caleb fork: "Save as a loadout" in the install panel (2+ mods). The panel's options are a draft until Install is
// pressed (commitInstallLoadout); App's install flow calls finishInstallLoadout once the files are in place, which
// creates the loadout from the mods that actually landed and, if asked, queues its previews.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import Checkbox from '../components/ui/Checkbox'
import type { useAlert } from '../components/AlertHandler'
import { normalizeModBaseName } from '../utils/format'
import { type Mod, modKey, readLoadouts, writeLoadouts } from './loadoutStore'
import { generatePreviews, previewSetKey } from './previews'

type Options = { name: string; preview: boolean }
let draft: Options | null = null   // what the open panel shows
let pending: Options | null = null // what the install in progress asked for

/** Install pressed: the panel's choice applies to this install (Cancel never gets here, so it never leaks). */
export const commitInstallLoadout = () => { pending = draft }

export function InstallAsLoadout({ count }: { count: number }) {
  const [on, setOn] = useState(false)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState(true)
  useEffect(() => { draft = on && count > 1 ? { name: name.trim() || 'New loadout', preview } : null }, [on, name, preview, count])
  useEffect(() => () => { draft = null }, [])
  if (count < 2) return null
  return (
    <div className="install-loadout">
      <Checkbox checked={on} onChange={(v: boolean) => setOn(v)} size="sm" color="primary">
        <span>Save these {count} mods as a loadout</span>
      </Checkbox>
      {on && (
        <>
          <input className="install-loadout-name" value={name} placeholder="Loadout name" aria-label="Loadout name" autoFocus
            onChange={e => setName(e.target.value)} onKeyDown={e => e.stopPropagation()} />
          <Checkbox checked={preview} onChange={(v: boolean) => setPreview(v)} size="sm" color="primary">
            <span>Generate its preview</span>
          </Checkbox>
        </>
      )}
    </div>
  )
}

/** The installed file's loadout key, the same name App's install flow gives the file (normalizeModBaseName). */
export const installedKey = (m: { customName?: string; mod_name?: string }) =>
  modKey(`${normalizeModBaseName(m.customName || m.mod_name || 'Unnamed_Mod')}.pak`)

/** After a successful install: make the loadout from the mods now on disk, then queue its previews. */
export async function finishInstallLoadout(installed: { customName?: string; mod_name?: string }[], alert: ReturnType<typeof useAlert>) {
  const job = pending
  pending = null
  if (!job) return
  const wanted = new Set(installed.map(installedKey))
  const onDisk = (await invoke<Mod[]>('get_pak_files').catch(() => [] as Mod[])).filter(m => wanted.has(modKey(m.path)))
  const keys = [...new Set(onDisk.map(m => modKey(m.path)))]
  if (keys.length === 0) {
    alert.warning('Loadout not created', `None of the ${wanted.size} installed mods were found in the mods folder.`)
    return
  }
  const id = crypto.randomUUID()
  writeLoadouts([...readLoadouts(), { id, name: job.name, label: 'Other', scope: keys, on: keys }])
  const missing = wanted.size - keys.length
  alert.success(`Loadout ${job.name} created`, `${keys.length} mod${keys.length === 1 ? '' : 's'}${missing ? `; ${missing} could not be found` : ''}.${job.preview ? ' Generating its preview.' : ''}`)
  if (job.preview) generatePreviews({ paths: onDisk.map(m => m.path), set: previewSetKey(id), name: job.name })
}

if (import.meta.env.DEV) {
  console.assert(installedKey({ customName: 'My Mod v2' }) === 'My_Mod_v2', 'installed key matches the file name the install writes')
  console.assert(installedKey({ mod_name: 'ElectricBluePantherIcons_UPDATED_9999999_P' }) === 'ElectricBluePantherIcons_UPDATED', 'existing priority suffix is dropped')
}
