// repakxtra: delete_mod moves files to a trash folder (src/xtra_trash.rs), one folder per deletion named by
// its trash id; this toast puts exactly those deletions back.
import { invoke } from '@tauri-apps/api/core'
import type { useAlert } from '../components/AlertHandler'
import { modKey as displayName } from './loadoutStore'

export type TrashedMod = { id: string; path: string }

/** `blocked` is read on click, so a game start (or bypass change) after the delete still counts. */
export function offerUndoDelete(alert: ReturnType<typeof useAlert>, entries: TrashedMod[], reload: () => Promise<unknown>, blocked: () => boolean) {
  if (entries.length === 0) return
  const what = entries.length === 1 ? displayName(entries[0].path) : `${entries.length} mods`
  const id = alert.info(`Deleted ${what}`, 'Kept in the trash for 7 days.', {
    duration: 10000,
    action: {
      label: 'Undo',
      onClick: async () => {
        if (blocked()) {
          alert.warning('Game running', 'Undo waits until the game is closed.')
          return
        }
        alert.dismissAlert(id)
        try {
          await invoke('restore_trashed_mods', { ids: entries.map(e => e.id) })
          alert.success('Restored', what)
        } catch (e) {
          alert.error('Undo incomplete', String(e))
        }
        await reload()
      },
    },
  })
}
