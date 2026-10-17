// repakxtra: the preview kit's state and actions (backend: xtra_kit.rs), shared by Setup's Mod previews card and the
// first-run setup. "Set up previews" is one click: the newest kit (with download progress) when it is missing or old,
// Blender when it is missing (winget), then the generator's own check of this PC, which names anything still missing.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { refreshPreviewsAvailable } from './previews'
import type { useAlert } from '../components/AlertHandler'

type Alert = ReturnType<typeof useAlert>
/** source: where the installed kit came from ("github" or "file"; null for a kit installed before that was recorded) */
export type KitStatus = { version: string | null; source: 'github' | 'file' | null; blender: string | null }
export type KitRelease = { version: string; published: string; notes: string; url: string; asset: string; size: number }
export type Doctor = { ok: boolean; problems: string[] }
/** blender: winget's progress (done of total bytes, or percent when total is 100) and its latest message */
export type KitProgress = { stage: 'download' | 'unpack' | 'blender'; done: number; total: number; text?: string }

/** A kit zip by its file name (repakxtra-preview-kit-v2.zip, also "... (1).zip" from a browser). */
export const isKitZip = (path: string) => /(^|[\\/])repakxtra-preview-kit[^\\/]*\.zip$/i.test(path)
/** Kit versions are whole numbers ("2"); anything else compares as text. */
export const isNewerKit = (latest: string, installed?: string | null) =>
  !installed || (Number.isFinite(+latest) && Number.isFinite(+installed) ? +latest > +installed : latest > installed)
const mb = (n: number) => `${Math.round(n / 1048576)} MB`
/** The generator's check of this PC; when it cannot run (no kit, busy, would not start) that is its one problem. */
const checkPc = () => invoke<Doctor>('previews_doctor').catch((e): Doctor => ({ ok: false, problems: [String(e)] }))
/** "38 MB of 108 MB", "Unpacking…", "Downloading Blender · 120 MB of 345 MB" */
export const progressText = (p: KitProgress | null) =>
  !p ? '' : p.stage === 'unpack' ? 'Unpacking…'
    : p.stage === 'blender' ? [p.text || 'Installing Blender', p.total === 100 ? `${p.done}%` : p.total ? `${mb(p.done)} of ${mb(p.total)}` : ''].filter(Boolean).join(' · ')
    : p.total ? `${mb(p.done)} of ${mb(p.total)}` : mb(p.done)
export const progressShare = (p: KitProgress | null) => (p?.stage !== 'unpack' && p?.total ? Math.min(1, p.done / p.total) : null)
/** Tells every kit card (Setup's, Guided setup's) to re-read the kit: each keeps its own copy of the state. */
const changed = () => window.dispatchEvent(new Event('preview-kit-changed'))
const BLENDER_START: KitProgress = { stage: 'blender', done: 0, total: 0, text: 'Asking winget for Blender (Windows may ask for permission)' }

export function usePreviewKit(alert: Alert) {
  const [kit, setKit] = useState<KitStatus | null>(null)
  const [latest, setLatest] = useState<KitRelease | null | undefined>(undefined) // undefined: not checked yet
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<KitProgress | null>(null)
  const [doctor, setDoctor] = useState<Doctor | null>(null)
  const [checked, setChecked] = useState(false) // Check for updates was clicked: the kit's line says what GitHub has
  const status = () => invoke<KitStatus>('preview_kit_status').then(s => { setKit(s); return s })
  useEffect(() => {
    status().catch(e => alert.warning('Preview kit', String(e)))
    const off = listen<KitProgress>('preview-kit-progress', e => setProgress(e.payload))
    const changed = () => { status().catch(() => undefined) } // a kit zip dropped on the window
    window.addEventListener('preview-kit-changed', changed)
    return () => { off.then(f => f()).catch(() => undefined); window.removeEventListener('preview-kit-changed', changed) }
  }, [])
  const run = async <T,>(what: string, f: () => Promise<T>): Promise<T | undefined> => {
    setBusy(what)
    try { return await f() } catch (e) { alert.warning('Preview kit', String(e)); return undefined } finally { setBusy(null); setProgress(null) }
  }
  const fetchLatest = () => invoke<KitRelease | null>('preview_kit_latest').then(r => { setLatest(r); return r })
  const installKit = async (file?: string) => {
    const v = await invoke<string>('preview_kit_install', { file: file ?? null })
    await status()
    await refreshPreviewsAvailable()
    changed()
    return v
  }
  /** A later step's result, then the check of this PC (so a card always says what is missing). */
  const runDoctorAfter = <T,>(p: Promise<T>, what: string) => run(what, async () => { const r = await p; setDoctor(await checkPc()); return r })

  return {
    kit, latest, busy, progress, doctor, checked,
    update: Boolean(latest && kit?.version && isNewerKit(latest.version, kit.version)),
    /** Asks GitHub for the newest kit; the card's kit line then says what it found (an update is one click: Update to vN). */
    check: () => run('check', async () => { setChecked(false); const r = await fetchLatest(); setChecked(true); return r }),
    /** The newest kit, quietly (offline: nothing to say). */
    peek: () => fetchLatest().catch(() => null),
    checkPc: () => runDoctorAfter(Promise.resolve(), 'doctor'),
    install: (file?: string) => run('install', async () => {
      const was = kit?.version
      const v = await installKit(file)
      alert.success('Preview kit', was ? `Updated to v${v}.` : `v${v} installed.`)
      setDoctor(await checkPc())
      return v
    }),
    installBlender: () => run('blender', async () => {
      setProgress(BLENDER_START)
      const path = await invoke<string>('preview_kit_install_blender')
      await status()
      changed()
      setDoctor(await checkPc())
      return path
    }),
    pickBlender: (path: string) => run('blender', async () => {
      await invoke('preview_kit_set_blender', { path })
      await status()
      changed()
      setDoctor(await checkPc())
    }),
    remove: () => run('remove', async () => {
      await invoke('preview_kit_remove')
      await status()
      changed()
      await refreshPreviewsAvailable()
      setDoctor(null)
      alert.info('Preview kit', 'Removed. Previews already made stay.')
    }),
    /** One click: the newest kit when it is missing or older, Blender when it is missing, then the check. Returns the
     *  check's answer, or undefined when a step failed (its warning names why). */
    setUp: () => run('setup', async () => {
      const now = kit ?? await status()
      const release = latest === undefined ? await fetchLatest() : latest
      if (!now.version && !release) throw new Error('No preview kit has been published yet. If someone sent you the kit zip, drop it on this window.')
      if (release && (!now.version || isNewerKit(release.version, now.version))) await installKit()
      if (!now.blender) { setProgress(BLENDER_START); await invoke<string>('preview_kit_install_blender'); await status(); changed() }
      const d = await checkPc()
      setDoctor(d)
      if (d.ok) alert.success('Mod previews', 'Ready. Generate previews from a loadout.')
      return d
    }),
  }
}

/** A kit zip dropped on the window installs as the kit (not as a mod). Returns whether it handled the drop. */
export async function installDroppedKit(paths: string[], alert: Alert) {
  const zip = paths.length === 1 ? paths[0] : undefined
  if (!zip || !isKitZip(zip)) return false
  const id = alert.showAlert({ color: 'default', title: 'Installing the preview kit', description: 'Unpacking…', isLoading: true, duration: 0 })
  try {
    const v = await invoke<string>('preview_kit_install', { file: zip })
    await refreshPreviewsAvailable()
    alert.updateToast(id, { color: 'success', title: 'Preview kit', description: `v${v} installed. Setup shows whether this PC is ready.`, isLoading: false, duration: 6000 })
    window.dispatchEvent(new Event('preview-kit-changed'))
  } catch (e) {
    alert.updateToast(id, { color: 'warning', title: 'Preview kit not installed', description: String(e), isLoading: false, duration: 10000 })
  }
  return true
}

if (import.meta.env.DEV) {
  console.assert(isKitZip('C:/Downloads/repakxtra-preview-kit-v2.zip') && isKitZip('D:\\x\\repakxtra-preview-kit-v2 (1).zip'), 'isKitZip names')
  console.assert(!isKitZip('C:/mods/repakxtra-preview-kit.pak') && !isKitZip('C:/repakxtra-preview-kit-v2/skin.zip'), 'isKitZip others')
  console.assert(isNewerKit('10', '9') && !isNewerKit('2', '2') && isNewerKit('1', null), 'isNewerKit')
}
