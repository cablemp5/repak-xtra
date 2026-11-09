// repakxtra: Merge sounds (xtra_soundmerge.rs). Select two or more sound mods in the Library and the selection bar's
// Merge sounds opens a window listing every sound two or more of them change: a column per mod (cable's pick A), each
// tile playing that mod's version (decoded by the preview kit) and picking it with a click (cable's pick A, round 3),
// Use all per column, picks starting on the mod that wins today. A streamed sound is one row with its bank entry. Make merged pack writes it as a normal mod and switches off the originals that hold only
// sounds. A merged pack's details say what it was made from, with Change picks to open the window again.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { invoke } from '@tauri-apps/api/core'
import { AudioLines, Check, CircleCheck, Combine, LoaderCircle, Play, Square } from 'lucide-react'
import heroes from '../data/character_data.json'
import { cue } from './sounds'
import { runOp } from './opDialogs'
import { useDialogFocus } from './dialogFocus'
import { ProgressLoader } from './ProgressLoader'

type Plan = { mods: string[]; banks: { key: string; sounds: { id: number; has: number[]; pick: number; stream?: string | null }[] }[]; only_one: number; skipped: [string, string][]; notes: string[]; shared_files: number }
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
    return () => { live = false; player.stop(); invoke('sound_merge_done').catch(() => undefined) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const shared = plan?.banks.reduce((n, b) => n + b.sounds.length, 0) ?? 0
  // nothing to pick, yet they ship the same bank: only one copy loads today, so the merged pack still lets both play
  const canMake = Boolean(plan) && plan!.mods.length > 1 && (shared > 0 || plan!.shared_files > 0)
  const keeps = useMemo(() => (plan?.mods ?? []).map((_, i) => Object.values(picks).reduce((n, m) => n + Object.values(m).filter(x => x === i).length, 0)), [plan, picks])
  const pick = (key: string, id: number, i: number) => { if (picks[key]?.[id] !== i) cue('select'); setPicks(p => ({ ...p, [key]: { ...p[key], [id]: i } })) }
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
      // a streamed sound's full file goes with its row's pick
      const payload: Picks = {}
      for (const b of plan.banks) {
        for (const s of b.sounds) {
          const who = plan.mods[picks[b.key]?.[s.id] ?? s.pick]
          ;(payload[b.key] ??= {})[String(s.id)] = who
          if (s.stream) (payload[s.stream] ??= {})[String(s.id)] = who
        }
      }
      const made = await invoke<{ path: string; turn_off: string[] }>('sound_merge_make', { paths: plan.mods, picks: payload, name: title.trim() || `Merged ${plan.mods.map(name).join(' + ')}`, replace: open.replace ?? null })
      let off = 0
      for (const p of made.turn_off) {
        if (!(await runOp('turn off this mod', () => invoke('toggle_mod', { modPath: p }), { modes: false }))) break
        off++
      }
      onDone()
      cue('success')
      setDone(`It is on in your Library${off ? `, and ${off === 1 ? 'the original is' : `${off} originals are`} off. Switch them on again any time` : ''}.|${name(made.path)}`)
    } catch (e) {
      cue('warning')
      setError(String(e))
    } finally {
      setMaking(false)
    }
  }

  const n = plan?.mods.length ?? 2
  const [doneText, doneName] = done.split('|')
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <motion.div ref={trap.ref} onKeyDown={trap.onKeyDown} tabIndex={-1} className="modal-content ms-modal" role="dialog" aria-modal="true" aria-label="Merge sounds"
        onClick={e => e.stopPropagation()} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div className="ms-title">
            <h2>Merge sounds</h2>
            {plan && !done && shared > 0 && <p>
              {shared === 1 ? '1 sound' : `${shared} sounds`} {n > 2 ? 'two or more of these mods change' : 'both mods change'}. Pick whose version plays, {list(plan.mods.map((m, i) => `${name(m)} keeps ${keeps[i]}`))}.
              {plan.only_one > 0 && <> {plan.only_one === 1 ? '1 sound only one mod changes comes' : `${plan.only_one} sounds only one mod changes come`} along.</>}
            </p>}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body ms-body">
          {!plan && !error && <div className="ms-center"><ProgressLoader title="Reading the sound banks" step={`Comparing ${list(open.paths.map(name))}`} /></div>}
          {done && <Empty icon={<CircleCheck />} title={`Made ${doneName}`} text={doneText} />}
          {plan && !done && shared === 0 && (plan.shared_files > 0
            ? <Empty icon={<AudioLines />} title="Nothing to pick" text={`They change different sounds in the same bank, so only one of them plays today. The merged pack keeps all ${plan.only_one === 1 ? 'of their sounds' : `${plan.only_one} of their sounds`}.`} />
            : <Empty icon={<CircleCheck />} title="These already play together" text="Each one changes its own sound banks, so the game loads both. There is nothing to merge." />)}
          {plan && !done && plan.banks.map(b => {
            const label = bankLabel(b.key)
            return (
              <section key={b.key} className="ms-bank">
                <div className="ms-bank-head"><b>{label.hero}</b><span>{label.file}</span><em>{b.sounds.length === 1 ? '1 sound' : `${b.sounds.length} sounds`}</em></div>
                <div className="ms-grid" style={{ gridTemplateColumns: `minmax(150px, 1fr) repeat(${n}, minmax(190px, 1.25fr))` }}>
                  <div className="ms-head ms-sticky">Sound</div>
                  {plan.mods.map((m, i) => (
                    <div key={m} className="ms-head">
                      <span title={name(m)}>{name(m)}</span>
                      <button type="button" className="ms-all" onClick={() => pickAll(i)}>Use all</button>
                    </div>
                  ))}
                  {b.sounds.map(s => (
                    <div key={s.id} className="ms-row" role="radiogroup" aria-label={`Sound ${s.id}`}>
                      <div className="ms-sticky ms-num"><b>{s.id}</b>{s.stream && <span className="ms-tag">Streamed</span>}</div>
                      {plan.mods.map((m, i) => {
                        if (!s.has.includes(i)) return <div key={m} className="ms-tile is-none">Not changed</div>
                        const on = (picks[b.key]?.[s.id] ?? s.pick) === i
                        const id = `${b.key}|${s.id}|${i}`
                        return (
                          <div key={m} className={`ms-tile${on ? ' is-on' : ''}`} role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
                            aria-label={`${name(m)}'s version`} onClick={() => pick(b.key, s.id, i)}
                            onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick(b.key, s.id, i) } }}>
                            <button type="button" className="ms-play" aria-label={player.playing === id ? `Stop ${name(m)}'s version` : `Play ${name(m)}'s version`} aria-busy={player.loading === id}
                              onClick={e => { e.stopPropagation(); player.toggle(id, m, s.stream ?? b.key, s.id) }}>
                              {player.loading === id ? <LoaderCircle size={13} className="scan-status-spin" aria-hidden="true" /> : player.playing === id ? <Square size={11} fill="currentColor" aria-hidden="true" /> : <Play size={12} fill="currentColor" aria-hidden="true" />}
                            </button>
                            <span>{on ? 'Plays' : 'Use this'}</span>
                            <span className="ms-check" aria-hidden="true">{on && <Check size={11} strokeWidth={3} />}</span>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
          {plan && !done && (plan.skipped.length > 0 || plan.notes.length > 0) && (
            <div className="ms-notes">
              {plan.skipped.map(([m, why], i) => <p key={i}>{name(m)}: {why}.</p>)}
              {plan.notes.map((t, i) => <p key={`n${i}`}>{t}</p>)}
            </div>
          )}
          {(error || player.error) && <p className="ms-error" role="alert">{error || player.error}</p>}
        </div>
        <div className="ms-foot">
          {done || (plan && !canMake)
            ? <button type="button" className="lo-text-btn" onClick={onClose}>{done ? 'Done' : 'Close'}</button>
            : <>
                {plan && shared > 0 && <label className="ms-name">Name<input value={title} maxLength={80} spellCheck={false} onChange={e => setTitle(e.target.value)} /></label>}
                <button type="button" className="lo-text-btn" onClick={onClose}>Cancel</button>
                {plan && (
                  <button type="button" className={`btn-primary${making ? ' is-working' : ''}`} onClick={make} disabled={making || (shared > 0 && !title.trim())} aria-busy={making}>
                    {making ? <span className="t-shimmer">Making the merged pack</span> : <><Combine size={14} aria-hidden="true" />Make merged pack</>}
                  </button>
                )}
              </>}
        </div>
      </motion.div>
    </div>,
    document.body,
  )
}

/** A centered state in the window: an icon in a soft square, a title, and a line under it. */
function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="ms-center ms-empty">
      <span className="ms-empty-icon" aria-hidden="true">{icon}</span>
      <b>{title}</b>
      <p>{text}</p>
    </div>
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
