// repakxtra: delete_mod moves files to a trash folder (src/xtra_trash.rs), one folder per deletion named by
// its trash id; this toast puts exactly those deletions back.
import { invoke } from '@tauri-apps/api/core'
import type { useAlert } from '../components/AlertHandler'
import { nameKey as displayName } from './loadoutStore'
import { gameClosed, runOp } from './opDialogs'

export type TrashedMod = { id: string; path: string }

/** `blocked` is read on click, so a game start (or bypass change) after the delete still counts. `label` names what was
 *  deleted when it is not mods by path (a folder: its files' deletions, path unused). */
export function offerUndoDelete(alert: ReturnType<typeof useAlert>, entries: TrashedMod[], reload: () => Promise<unknown>, blocked: () => boolean, label?: string) {
  if (entries.length === 0) return
  const what = label ?? (entries.length === 1 ? displayName(entries[0].path) : `${entries.length} mods`)
  const id = alert.info(`Deleted ${what}`, 'Kept for 7 days in Settings > Recently deleted.', {
    duration: 10000,
    action: {
      label: 'Undo',
      onClick: async () => {
        if (blocked() && !(await gameClosed('put it back'))) return // the shared dialog waits for the game to close
        alert.dismissAlert(id)
        try {
          // a mod of that name installed since: Keep both or Replace (the shared dialog, xtra_trash.rs restore_from)
          if (await runOp('put it back', mode => invoke('restore_trashed_mods', { ids: entries.map(e => e.id), mode }))) alert.success('Restored', what)
        } catch (e) {
          alert.error('Undo incomplete', String(e))
        }
        await reload()
      },
    },
  })
}
