// repakxtra: header switch for Sigeon V2 (backend: xtra_sigeon.rs). Shows the live state and
// switches between Off and each SigeonLoader.<preset>.ini found in Desktop\Sigeon V2. Until that folder has
// SigeonLoader.asi it reads "not configured" and opens the setup instead.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Check, ChevronDown, Gauge, SlidersHorizontal } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { dialogOpen, isTyping } from './hotkeys'
import SigeonEditor from './SigeonEditor'
import SigeonSetup from './SigeonSetup'

type Status = { state: string; configured: boolean; presets: string[]; storage: string; plugins: string; game_running: boolean; problem?: string | null }

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export default function SigeonControl({ alert }: { alert: ReturnType<typeof useAlert> }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [settingUp, setSettingUp] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const refresh = () => invoke<Status>('sigeon_status').then(setStatus).catch(e => console.warn('[sigeon]', e))

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('sigeon-changed', refresh)   // the editor added, renamed, saved or switched a config
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('sigeon-changed', refresh) }
  }, [])

  // S cycles Off -> each preset -> Off
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 's' || e.ctrlKey || e.altKey || e.metaKey || isTyping(e.target) || dialogOpen()) return
      e.preventDefault()
      const s = await invoke<Status>('sigeon_status').catch(() => null)
      if (!s) return
      if (!s.configured) { setSettingUp(true); return }
      if (s.game_running || s.problem) {
        alert.warning('Sigeon', s.problem ?? 'Close Marvel Rivals to switch.')
        return
      }
      const order: (string | null)[] = [null, ...s.presets]
      const at = order.indexOf(s.state === 'off' ? null : s.state)
      choose(order[(at + 1) % order.length])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    refresh()
    const close = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } } // the menu only, not the Library's selection
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  const choose = async (preset: string | null) => {
    setBusy(true)
    try {
      const state = await invoke<string>('sigeon_set', { preset })
      alert.success('Sigeon', state === 'off' ? 'Turned off.' : `${label(state)} config is on. Applies next game launch.`)
      setOpen(false)
    } catch (e) {
      alert.error('Sigeon not switched', String(e))
    }
    await refresh()
    window.dispatchEvent(new Event('sigeon-changed')) // the type hints (typeHints.tsx) follow the switch
    setBusy(false)
  }

  const state = status?.state ?? 'off'
  const unset = status?.configured === false
  const on = state !== 'off'
  const blocked = Boolean(status?.game_running || status?.problem)

  return (
    <div className="sigeon" ref={wrapRef}>
      {unset ? (
        <button type="button" className="btn-settings sigeon-btn is-unset" onClick={() => setSettingUp(true)}
          aria-haspopup="dialog" title="Set up Sigeon V2">
          <Gauge size={16} /> Sigeon <span className="sigeon-state">Not configured</span>
        </button>
      ) : (
        <button type="button" className={`btn-settings sigeon-btn ${on ? 'is-on' : ''}`} onClick={() => setOpen(v => !v)}
          aria-haspopup="menu" aria-expanded={open} title="Sigeon V2 performance loader">
          <Gauge size={16} /> Sigeon <span className="sigeon-state">{label(state)}</span> <ChevronDown size={14} />
        </button>
      )}
      {open && (
        <div className="sigeon-menu" role="menu">
          {status?.problem && <p className="sigeon-note">{status.problem}</p>}
          {status?.game_running && <p className="sigeon-note">Close Marvel Rivals to switch.</p>}
          {state === 'custom' && <p className="sigeon-note">The live ini was edited by hand; picking an option replaces it.</p>}
          {[null, ...(status?.presets ?? [])].map(p => {
            const current = (p ?? 'off') === state
            return (
              <button key={p ?? 'off'} type="button" role="menuitemradio" aria-checked={current} className="sigeon-item"
                disabled={busy || blocked || current} onClick={() => choose(p)}>
                <span>{p ? `${label(p)} config` : 'Off'}</span>
                {current && <Check size={14} />}
              </button>
            )
          })}
          <button type="button" role="menuitem" className="sigeon-item sigeon-edit" onClick={() => { setOpen(false); setEditing(true) }}>
            <span><SlidersHorizontal size={14} /> Edit configs…</span>
          </button>
          <p className="sigeon-foot" title={status?.storage}>Configs from Desktop\Sigeon V2</p>
        </div>
      )}
      {editing && <SigeonEditor alert={alert} onClose={() => { setEditing(false); refresh() }} />}
      {settingUp && <SigeonSetup alert={alert} onClose={() => { setSettingUp(false); refresh() }}
        onEdit={() => { setSettingUp(false); setEditing(true) }} />}
    </div>
  )
}
