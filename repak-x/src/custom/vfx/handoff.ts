// repakxtra: the main window hands mods to the VFX window (custom/vfx/VfxUpdaterWindow.tsx): the Library's "Send to VFX
// Updater" (one mod) and the Update VFX mods notice (every flagged mod, started at once). A localStorage entry, so a window
// that is still opening reads it on mount and an open one hears it through the storage event. Not a repakxtra.* key:
// devStorage would copy it to the shared file. The VFX window answers with repakxtra:vfx-fixed events for each fix
// (VfxNotice.tsx swaps the original for the fix in loadouts).
import type { VfxReport } from './pipeline'

const KEY = 'repakxtra-vfx:queue'

export type Handoff = { paths: string[]; start: boolean; at: number }
export type Fixed = { from: string; to: string; /** loadouts move from the original to the update (a no-op when the update kept the name) */ swap: boolean }
export const FIXED_EVENT = 'repakxtra:vfx-fixed'

export const sendToVfx = (paths: string[], start: boolean) => localStorage.setItem(KEY, JSON.stringify({ paths, start, at: Date.now() } satisfies Handoff))

/** The VFX window asks the main window to open a loadout's page (VfxNotice.tsx listens there), and brings it forward. */
export const OPEN_LOADOUT_EVENT = 'repakxtra:open-loadout'
export async function openLoadoutInMain(id: string) {
  const { emitTo } = await import('@tauri-apps/api/event')
  await emitTo('main', OPEN_LOADOUT_EVENT, id).catch(() => {})
}

/** Opens the VFX window, or brings it forward. */
export async function openVfxWindow() {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const existing = await WebviewWindow.getByLabel('vfx-updater')
  if (existing) { await existing.unminimize().catch(() => {}); await existing.setFocus(); return }
  const w = new WebviewWindow('vfx-updater', { url: '/vfx-updater', title: 'VFX Updater', width: 760, height: 820, minWidth: 600, minHeight: 560, center: true, resizable: true, decorations: false })
  w.once('tauri://error', e => console.error('[VFX] Failed to create window:', e))
}

/** Hands mods to the VFX window and opens it: `start` updates them at once (the Update VFX mods notice). */
export async function fixInVfxWindow(paths: string[], start: boolean) {
  if (paths.length) sendToVfx(paths, start)
  await openVfxWindow()
}

/** The waiting handoff, taken (removed) so it is acted on once. */
export function takeHandoff(): Handoff | null {
  const raw = localStorage.getItem(KEY)
  if (!raw) return null
  localStorage.removeItem(KEY)
  try {
    const h = JSON.parse(raw)
    return Array.isArray(h?.paths) ? { paths: h.paths.filter((p: unknown) => typeof p === 'string'), start: Boolean(h.start), at: Number(h.at) || 0 } : null
  } catch { return null }
}

export const onHandoff = (fn: (h: Handoff) => void) => {
  const listener = (e: StorageEvent) => { if (e.key === KEY && e.newValue) { const h = takeHandoff(); if (h) fn(h) } }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}

/** A right-click update's report (quick.ts), shown in the VFX window under its mod: Show report, or a failure's Open. */
const REPORT = 'repakxtra-vfx:report'
export const sendReport = (report: VfxReport) => localStorage.setItem(REPORT, JSON.stringify({ report, at: Date.now() }))
/** The waiting report, taken (removed) so it is shown once. */
export function takeReport(): VfxReport | null {
  const raw = localStorage.getItem(REPORT)
  if (!raw) return null
  localStorage.removeItem(REPORT)
  try { const r = JSON.parse(raw)?.report; return r && typeof r.mod === 'string' ? r as VfxReport : null } catch { return null }
}
export const onReport = (fn: (r: VfxReport) => void) => {
  const listener = (e: StorageEvent) => { if (e.key === REPORT && e.newValue) { const r = takeReport(); if (r) fn(r) } }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}

/** The utoc beside a mod's main file, which the fix reads (a mod record's utoc_path, or its .pak / .bak_repak). */
export const utocOf = (path: string) => (/\.utoc$/i.test(path) ? path : `${path.replace(/(\.pak)?(\.bak_repak|\.pak_disabled)?$/i, '')}.utoc`)

if (import.meta.env.DEV) {
  console.assert(utocOf('C:/m/A_9999999_P.bak_repak') === 'C:/m/A_9999999_P.utoc' && utocOf('C:/m/A_P.pak') === 'C:/m/A_P.utoc', 'utoc beside on and off mods')
  console.assert(utocOf('C:/m/A_P.utoc') === 'C:/m/A_P.utoc', 'a utoc stays')
}
