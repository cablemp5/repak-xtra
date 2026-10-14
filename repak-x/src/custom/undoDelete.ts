// caleb fork: delete_mod moves files to a trash folder (src/caleb_trash.rs); this toast puts them back.
import { invoke } from '@tauri-apps/api/core'
import type { useAlert } from '../components/AlertHandler'
import { modKey as displayName } from './loadoutStore'

export function offerUndoDelete(alert: ReturnType<typeof useAlert>, paths: string[], reload: () => Promise<unknown>) {
  if (paths.length === 0) return
  const what = paths.length === 1 ? displayName(paths[0]) : `${paths.length} mods`
  const id = alert.info(`Deleted ${what}`, 'Kept in the trash for 7 days.', {
    duration: 10000,
    action: {
      label: 'Undo',
      onClick: async () => {
        alert.dismissAlert(id)
        try {
          await invoke('restore_trashed_mods', { paths })
          alert.success('Restored', what)
        } catch (e) {
          alert.error('Undo incomplete', String(e))
        }
        await reload()
      },
    },
  })
}
