// repakxtra: Merge sounds (xtra_soundmerge.rs). Select two or more sound mods in the Library and the selection bar's
// Merge sounds opens a window listing every sound two or more of them change: a column per mod (cable's pick A), each
// cell playing that mod's version (decoded by the preview kit) and picking it, Use all per column, picks starting on
// the mod that wins today. Make merged pack writes it as a normal mod and switches off the originals that hold only
// sounds. A merged pack's details say what it was made from, with Change picks to open the window again.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { invoke } from '@tauri-apps/api/core'
import { Combine, LoaderCircle, Play, Square } from 'lucide-react'
import heroes from '../data/character_data.json'
import { cue } from './sounds'
import { runOp } from './opDialogs'
import { useDialogFocus } from './dialogFocus'

type Plan = { mods: string[]; banks: { key: string; sounds: { id: number; has: number[]; pick: number }[] }[]; only_one: number; skipped: [string, string][] }
type Picks = Record<string, Record<string, string>> // sound key -> sound id -> the picked mod's path
type Info = { name: string; sources: string[]; picks: Picks }
type Open = { paths: string[]; name?: string; picks?: Picks; replace?: string }

const EVENT = 'repakxtra-merge-sounds'
/** Opens the window for these mods (from the selection bar, or a merged pack's Change picks). */
export const openMergeSounds = (o: Open) => window.dispatchEvent(new CustomEvent<Open>(EVENT, { detail: o }))

const name = (p: string) => p.split(/[\\/]/).pop()!.replace(/(_\d+_P)?\.(pak|bak_repak)$/i, '')
const same = (a: string, b: string) => a.replace(/\.(pak|bak_repak)$/i, '').replace(/\//g, '\\').toLowerCase() === b.replace(/\.(pak|bak_repak)$/i, '').replace(/\//g, '\\').toLowerCase()
const list = (xs: string[]) => xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`
const heroOf = new Map((heroes as { name: string; id: string }[]).map(h => [h.id, h.name.replace(/\s*\([^)]*\)\s*$/, '')]))
/** A bank's heading: its hero (from the skin number in its name) and the file itself. */
const bankLabel = (key: string) => {
  const file = key.split('/').pop()!.replace(/\.(bnk|wem)$/, '')
  const hero = heroOf.get(file.match(/(\d{4})\d{3}/)?.[1] ?? '')
  return { hero: key.endsWith('.wem') ? 'A streamed sound' : hero ?? 'Sound bank', file }
}
const isAudio = (d?: { mod_type?: string; category?: string }) => /Audio/.test(d?.mod_type ?? '') || d?.category === 'Audio'

/** The selection bar's Merge sounds: shown when two or more of the selected mods are sound mods. */
export function MergeSoundsButton({ paths, details }: { paths: string[]; details: Record<string, { mod_type?: string; category?: string } | undefined> }) {
  const sounds = paths.filter(p => isAudio(details[p]))
  if (sounds.length < 2) return null
  return (
    <button type="button" className="btn-ghost bulk-merge-sounds" onClick={() => openMergeSounds({ paths: sounds })}
      title="Merge these sound mods into one pack, so sounds that clash both play, and pick whose version plays where they change the same sound">
      <Combine size={16} aria-hidden="true" /><span className="bulk-btn-label">Merge sounds</span>
    </button>
  )
}

/** Mounted once in the app: the window, opened by openMergeSounds. `onDone` reloads the mod list. */
export function MergeSoundsHost({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState<Open | null>(null)
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<Open>).detail)
    window.addEventListener(EVENT, on)
    invoke('sound_merge_cleanup').catch(() => undefined) // the earlier automatic merger's pak and setting, once
    return () => window.removeEventListener(EVENT, on)
  }, [])
  return open ? <MergeSoundsWindow key={open.paths.join('|')} open={open} onClose={() => setOpen(null)} onDone={onDone} /> : null
}

function MergeSoundsWindow({ open, onClose, onDone }: { open: Open; onClose: () => void; onDone: () => void }) {
  const trap = useDialogFocus(true, onClose)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [error, setError] = useState('')
  const [picks, setPicks] = useState<Record<string, Record<number, number>>>({}) // key -> id -> mod index
  const [title, setTitle] = useState(open.name ?? '')
  const [making, setMaking] = useState(false)
  const [done, setDone] = useState('')
  const player = usePlayer()

  useEffect(() => {
    let live = true
    invoke<Plan>('sound_merge_plan', { paths: open.paths }).then(p => {
      if (!live) return
      setPlan(p)
      // starting picks: today's winner, or what this merged pack was made with
      setPicks(Object.fromEntries(p.banks.map(b => [b.key, Object.fromEntries(b.sounds.map(s => {
        const before = open.picks?.[b.key]?.[String(s.id)]
        const i = before ? p.mods.findIndex(m => same(m, before)) : -1
        return [s.id, s.has.includes(i) ? i : s.pick]
      }))])))
      if (!open.name) setTitle(`Merged ${p.mods.map(name).join(' + ')}`.slice(0, 80))
    }).catch(e => { if (live) setError(String(e)) })
    return () => { live = false; player.stop() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const shared = plan?.banks.reduce((n, b) => n + b.sounds.length, 0) ?? 0
  const keeps = useMemo(() => (plan?.mods ?? []).map((_, i) => Object.values(picks).reduce((n, m) => n + Object.values(m).filter(x => x === i).length, 0)), [plan, picks])
  const pick = (key: string, id: number, i: number) => { cue('select'); setPicks(p => ({ ...p, [key]: { ...p[key], [id]: i } })) }
  const pickAll = (i: number) => {
    cue('select')
    setPicks(p => Object.fromEntries(Object.entries(p).map(([key, m]) => {
      const bank = plan!.banks.find(b => b.key === key)!
      return [key, Object.fromEntries(Object.entries(m).map(([id, cur]) => [id, bank.sounds.find(s => s.id === Number(id))!.has.includes(i) ? i : cur]))]
    })))
  }
  const make = async () => {
    if (!plan || making) return
    setMaking(true)
    setError('')
    try {
      const payload: Picks = Object.fromEntries(Object.entries(picks).map(([key, m]) => [key, Object.fromEntries(Object.entries(m).map(([id, i]) => [id, plan.mods[i]]))]))
      const made = await invoke<{ path: string; turn_off: string[] }>('sound_merge_make', { paths: plan.mods, picks: payload, name: title.trim(), replace: open.replace ?? null })
      let off = 0
      for (const p of made.turn_off) {
        if (!(await runOp('turn off this mod', () => invoke('toggle_mod', { modPath: p }), { modes: false }))) break
        off++
      }
      onDone()
      cue('success')
      setDone(`Made ${name(made.path)}. It is on${off ? `, and ${off === 1 ? 'the original is' : `${off} originals are`} off (switch them on again any time)` : ''}.`)
    } catch (e) {
      cue('warning')
      setError(String(e))
    } finally {
      setMaking(false)
    }
  }

  const cols = plan?.mods.length ?? 2
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <motion.div ref={trap.ref} onKeyDown={trap.onKeyDown} tabIndex={-1} className="modal-content ms-modal" role="dialog" aria-modal="true" aria-label="Merge sounds"
        onClick={e => e.stopPropagation()} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div className="ms-title">
            <h2>Merge sounds</h2>
            {plan && !done && <p className="su-sub">
              {shared > 0
                ? <>{shared === 1 ? '1 sound' : `${shared} sounds`} {plan.mods.length > 2 ? 'two or more of these mods change' : 'both mods change'}. Pick whose version plays. {list(plan.mods.map((m, i) => `${name(m)} keeps ${keeps[i]}`))}.</>
                : 'These mods change no sound in common.'}
              {plan.only_one > 0 && <> {plan.only_one === 1 ? '1 sound only one mod changes comes' : `${plan.only_one} sounds only one mod changes come`} along.</>}
            </p>}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body ms-body">
          {!plan && !error && <p className="ms-wait"><span className="t-shimmer">Reading the sound banks</span></p>}
          {done && <p className="ms-done" role="status">{done}</p>}
          {plan && !done && plan.banks.map(b => {
            const label = bankLabel(b.key)
            return (
              <section key={b.key} className="ms-bank">
                <h3>{label.hero}<span>{label.file}</span></h3>
                <div className="ms-grid" role="table" style={{ gridTemplateColumns: `minmax(140px, 1fr) repeat(${cols}, minmax(150px, 1fr))` }}>
                  <div className="ms-head ms-sticky" role="columnheader">Sound</div>
                  {plan.mods.map((m, i) => (
                    <div key={m} className="ms-head" role="columnheader">
                      <span title={name(m)}>{name(m)}</span>
                      <button type="button" className="ms-all" onClick={() => pickAll(i)}>Use all</button>
                    </div>
                  ))}
                  {b.sounds.map(s => (
                    <div key={s.id} className="ms-row" role="row">
                      <div className="ms-sticky ms-num" role="cell">Sound {s.id}</div>
                      {plan.mods.map((m, i) => {
                        if (!s.has.includes(i)) return <div key={m} className="ms-none" role="cell">Not changed</div>
                        const on = picks[b.key]?.[s.id] === i
                        const id = `${b.key}|${s.id}|${i}`
                        return (
                          <div key={m} className={`ms-cell${on ? ' is-on' : ''}`} role="cell">
                            <button type="button" className="ms-play" aria-label={player.playing === id ? `Stop ${name(m)}'s version` : `Play ${name(m)}'s version`}
                              onClick={() => player.toggle(id, m, b.key, s.id)} aria-busy={player.loading === id}>
                              {player.loading === id ? <LoaderCircle size={14} className="scan-status-spin" aria-hidden="true" /> : player.playing === id ? <Square size={12} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                            </button>
                            <label className="ms-pick">
                              <input type="radio" name={`${b.key}|${s.id}`} checked={on} onChange={() => pick(b.key, s.id, i)} />
                              <span>Use this</span>
                            </label>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
          {plan && !done && plan.skipped.length > 0 && (
            <div className="ms-skipped">{plan.skipped.map(([m, why], i) => <p key={i}>{name(m)} is left out of one bank: {why}.</p>)}</div>
          )}
          {(error || player.error) && <p className="ms-error" role="alert">{error || player.error}</p>}
        </div>
        <div className="ms-foot">
          {done
            ? <button type="button" className="btn-primary" onClick={onClose}>Done</button>
            : <>
                {plan && shared > 0 && <label className="ms-name">Name<input value={title} maxLength={80} spellCheck={false} onChange={e => setTitle(e.target.value)} /></label>}
                <button type="button" className="lo-text-btn" onClick={onClose}>Cancel</button>
                {plan && shared > 0 && (
                  <button type="button" className={`btn-primary${making ? ' is-working' : ''}`} onClick={make} disabled={making || !title.trim()} aria-busy={making}>
                    {making ? <span className="t-shimmer">Making the merged pack</span> : 'Make merged pack'}
                  </button>
                )}
              </>}
        </div>
      </motion.div>
    </div>,
    document.body,
  )
}

/** One sound playing at a time: a mod's version is decoded by the kit once, then played from memory. */
function usePlayer() {
  const audio = useRef<HTMLAudioElement | null>(null)
  const urls = useRef(new Map<string, string>())
  const [playing, setPlaying] = useState('')
  const [loading, setLoading] = useState('')
  const [error, setError] = useState('')
  const stop = () => { audio.current?.pause(); audio.current = null; setPlaying('') }
  useEffect(() => () => { stop(); urls.current.forEach(u => URL.revokeObjectURL(u)) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = async (id: string, path: string, key: string, sound: number) => {
    if (playing === id) { stop(); return }
    stop()
    setError('')
    let url = urls.current.get(id)
    if (!url) {
      setLoading(id)
      try {
        const bytes = await invoke<ArrayBuffer>('sound_merge_play', { path, key, id: sound })
        url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
        urls.current.set(id, url)
      } catch (e) {
        setError(String(e))
        return
      } finally {
        setLoading('')
      }
    }
    const a = new Audio(url)
    audio.current = a
    a.onended = () => { if (audio.current === a) setPlaying('') }
    setPlaying(id)
    a.play().catch(() => setPlaying(''))
  }
  return { playing, loading, error, toggle, stop }
}

/** A merged pack's details: what it was made from, and Change picks. Nothing for any other mod. */
export function MergedPackNote({ path }: { path: string }) {
  const [info, setInfo] = useState<Info | null>(null)
  useEffect(() => {
    let live = true
    invoke<Info | null>('sound_merge_info', { path }).then(i => { if (live) setInfo(i) }).catch(() => undefined)
    return () => { live = false }
  }, [path])
  if (!info) return null
  return (
    <div className="detail-section sound-merge-note">
      <h3>Sounds</h3>
      <p>Merged from {info.sources.length ? list(info.sources.map(name)) : 'mods that are gone now'}.</p>
      {info.sources.length > 1 && (
        <button type="button" className="mod-preview-btn" onClick={() => openMergeSounds({ paths: info.sources, name: info.name, picks: info.picks, replace: path })}>
          <Combine size={14} aria-hidden="true" />Change picks
        </button>
      )}
    </div>
  )
}
