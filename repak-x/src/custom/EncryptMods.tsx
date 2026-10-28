import { useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { open as choose } from '@tauri-apps/plugin-dialog'
import { LockKeyhole } from 'lucide-react'
import Checkbox from '../components/ui/Checkbox'
import { useDialogFocus } from './dialogFocus'
import { nameKey } from './loadoutStore'
import type { LoadoutProps } from './Loadouts'
import './support.css'

type Props = { mods: { path: string }[]; selected: string[]; blocked: boolean; alert: LoadoutProps['alert']; reload: () => Promise<unknown> }
type Result = { Ok: { path: string; backup: string } } | { Err: string }

function EncryptDialog({ mods, selected, blocked, alert, reload, close }: Props & { close: () => void }) {
  const [paths, setPaths] = useState(() => mods.map(m => m.path))
  const [picked, setPicked] = useState(() => new Set(selected))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string[]>([])
  const focus = useDialogFocus()
  const browse = async () => {
    try {
      const files = await choose({ multiple: true, filters: [{ name: 'Mod files', extensions: ['pak', 'utoc', 'bak_repak', 'pak_disabled'] }] })
      if (!files) return
      const added = typeof files === 'string' ? [files] : files
      setPaths(old => [...new Set([...old, ...added])])
      setPicked(old => new Set([...old, ...added]))
    } catch (e) { alert.warning('Could not choose files', String(e)) }
  }
  const encrypt = async () => {
    if (busy || blocked || picked.size === 0) return
    setBusy(true)
    setResult([])
    try {
      const results = await invoke<Result[]>('xtra_encrypt_mods', { paths: [...picked] })
      const done = results.filter(r => 'Ok' in r)
      setResult(results.map(r => 'Ok' in r ? `${nameKey(r.Ok.path)} encrypted. Disabled originals: ${r.Ok.backup}` : r.Err))
      if (done.length) { alert.success('Encryption complete', `${done.length} mod${done.length === 1 ? '' : 's'} encrypted; disabled originals kept in encryption-backups.`); await reload() }
    } catch (e) { setResult([String(e)]) }
    finally { setBusy(false) }
  }
  return createPortal(<div className="modal-overlay support-overlay" onClick={() => { if (!busy) close() }}>
    <div {...focus} className="support-dialog encrypt-dialog" role="dialog" aria-modal="true" aria-labelledby="encrypt-title" tabIndex={-1}
      onClick={e => e.stopPropagation()} onKeyDown={e => { focus.onKeyDown(e); if (e.key === 'Escape' && !busy) close() }}>
      <h2 id="encrypt-title">Encrypt mods</h2>
      <p>Replace selected files with encrypted versions. Original bundles are backed up outside the library with their PAKs disabled. Mods keep their current on/off state.</p>
      {blocked && <p role="alert">Close the game before encrypting mods.</p>}
      <div className="support-actions">
        <button type="button" className="lo-text-btn" disabled={busy} onClick={() => setPicked(new Set(paths))}>Select all</button>
        <button type="button" className="lo-text-btn" disabled={busy} onClick={() => setPicked(new Set())}>Clear</button>
        <button type="button" className="lo-text-btn" disabled={busy} onClick={browse}>Add files…</button>
      </div>
      <div className="encrypt-list">
        {paths.map(path => <label key={path} title={path}>
          <Checkbox checked={picked.has(path)} disabled={busy} isDisabled={busy} onChange={(on: boolean) => setPicked(old => { const next = new Set(old); if (on) next.add(path); else next.delete(path); return next })} />
          <span>{nameKey(path)}</span>
        </label>)}
        {!paths.length && <p>Add mod files to encrypt.</p>}
      </div>
      {result.length > 0 && <div className="encrypt-results" role="status">{result.map((r, i) => <p key={i}>{r}</p>)}</div>}
      <div className="support-actions">
        <button type="button" className="lo-text-btn" disabled={busy || blocked || !picked.size} onClick={encrypt}>{busy ? 'Encrypting…' : `Encrypt selected (${picked.size})`}</button>
        <button type="button" className="lo-text-btn" disabled={busy} onClick={close}>Close</button>
      </div>
    </div>
  </div>, document.body)
}

export default function EncryptMods(props: Props) {
  const [show, setShow] = useState(false)
  return <>
    <button type="button" className="btn-settings" title="Encrypt selected or all mods" aria-label="Encrypt mods" onClick={() => setShow(true)}><LockKeyhole size={18} /></button>
    {show && <EncryptDialog {...props} close={() => setShow(false)} />}
  </>
}
