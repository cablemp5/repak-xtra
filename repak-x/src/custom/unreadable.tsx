// repakxtra: mods whose details read closed the app the last time (xtra_parse_guard.rs). The backend skips them until
// their files change. The Library shows them with a yellow "Could not be read" status tag (the Broken tag's look) and
// offers once per start to move each to Recently deleted.
import { invoke } from '@tauri-apps/api/core'
import { useSyncExternalStore } from 'react'
import type { useAlert } from '../components/AlertHandler'
import { nameKey as displayName } from './loadoutStore'

let paths = new Set<string>()
const subs = new Set<() => void>()
const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb) } }
const norm = (p: string) => p.toLowerCase()
const offered = new Set<string>()

/** Asks the backend which mods it skipped, tags them, and offers each one once per start. */
export async function checkUnreadable(alert: ReturnType<typeof useAlert>, move: (path: string) => unknown) {
  const list = await invoke<string[] | null>('unreadable_mods').catch(() => null) ?? []
  paths = new Set(list.map(norm))
  subs.forEach(f => f())
  for (const path of list) {
    if (offered.has(norm(path))) continue
    offered.add(norm(path))
    const id = alert.warning('Could not be read', `${displayName(path)} closed repakxtra the last time it was read, so it is skipped until the file changes. Delete moves it to Recently deleted.`, {
      duration: 0,
      action: { label: 'Delete', onClick: () => { alert.dismissAlert(id); void move(path) } },
    })
  }
}

export function UnreadableBadge({ path }: { path: string }) {
  const on = useSyncExternalStore(subscribe, () => paths.has(norm(path)))
  if (!on) return null
  return <span className="mod-type-badge broken-badge is-broken" title="This mod closed repakxtra the last time it was read, so it is skipped until the file changes. Delete it, or replace it with a fixed copy.">Could not be read</span>
}
