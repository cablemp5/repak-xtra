// repakxtra: Repak X open at the same time (backend: xtra_identity.rs). While it is, repakxtra changes no mods (the
// backend refuses with a clear message), so the two never write the same files; one notice says so when it opens. When
// it closes, repakxtra takes the repakx:// links back (Repak X claims them when it starts).
import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { useAlert } from '../components/AlertHandler'

export function useUpstreamWatch(alert: ReturnType<typeof useAlert>) {
  useEffect(() => {
    let open = false
    const check = () => invoke<boolean>('xtra_upstream_running').then(now => {
      if (now && !open) {
        alert.info('Repak X is open too', 'repakxtra changes no mods while it is, so the two never write the same files. Close Repak X to switch or install mods here.', { duration: 12000 })
      }
      if (!now && open) invoke('xtra_protocol_reclaim').catch(() => undefined)
      open = now
    }).catch(() => undefined)
    check()
    // Not while minimized: one check the moment the window shows again
    const t = setInterval(() => { if (!document.hidden) check() }, 5000)
    const onShow = () => { if (!document.hidden) check() }
    document.addEventListener('visibilitychange', onShow)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onShow) }
  }, [alert])
}
