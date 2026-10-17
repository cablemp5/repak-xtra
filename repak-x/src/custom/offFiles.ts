// repakxtra: dropped or picked .pak.off/.utoc.off/.ucas.off files (and folders holding them) are copied under their
// real names before the install sees them (xtra_offfiles.rs). Anything else passes through unchanged.
import { invoke } from '@tauri-apps/api/core'

export const OFF_EXT = 'off' // file pickers: "X.pak.off" ends in .off
export const stageOffFiles = (paths: string[]) =>
  invoke<string[]>('xtra_stage_off_files', { paths }).then(p => (Array.isArray(p) ? p : paths), () => paths)
