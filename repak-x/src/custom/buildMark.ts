// repakxtra: every window of a test or dev copy (the main one, the VFX Updater, the Asset Explorer) asks the backend for
// its green or amber taskbar icon when it loads (xtra_buildmark.rs). The stable copy does nothing. Imported in main.tsx.
import { invoke } from '@tauri-apps/api/core'
import { BUILD } from './version'

if (BUILD && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  invoke('xtra_buildmark_tint').catch(e => console.warn('[buildMark] Could not color the taskbar icon:', e))
}
