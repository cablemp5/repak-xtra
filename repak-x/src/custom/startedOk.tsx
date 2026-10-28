// repakxtra: tells the backend the main window has rendered once (xtra_updater.rs xtra_started_ok). An update waiting
// for this keeps the previous version's files until then, and puts them back if it never comes.
import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

export default function StartedOk() {
  useEffect(() => {
    if ('__TAURI_INTERNALS__' in window) invoke('xtra_started_ok').catch(e => console.warn('[startedOk]', e))
  }, [])
  return null
}
