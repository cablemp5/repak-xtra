// repakxtra: the Sounds tab (xtra_sounds.rs). Groups on the left (Combat, Killstreaks, Healing, Kill feed, Alerts,
// Match, Announcer, and each hero's ult line as their team and their enemies hear it) with how many of their slots have a sound, the picked group's slots on the right. Drop an audio
// file on a slot (or click it to browse), drop several files or a folder anywhere and files named like a slot fill
// it. The page decodes each file (WebView2 reads .wav, .mp3, .ogg, .flac, and .m4a) to 48 kHz 16-bit WAV and the app
// keeps it per slot. Make mod builds a mod from every filled slot and opens the install card. Play compares yours with the
// game's own (that one needs the preview kit's decoder).
// Make mod is a maker, not one mod's switch: each build is a new pak handed to the install card (as the KO Editor's)
// Built-in on a slot offers the app's own sounds (soundPresets.ts): play one, or pick it for the slot.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as pick } from '@tauri-apps/plugin-dialog'
import { Box, ChevronDown, FolderOpen, Lock, Play, Search, Square, Volume2, X } from 'lucide-react'
import data from '../data/sound_slots.json'
import type { LoadoutProps } from './Loadouts'
import { useView } from './loadoutStore'
import { modalOpen } from './dialogFocus'
import { cue } from './sounds'
import { Num } from './motion'
import { PRESETS, renderPreset, type Preset } from './soundPresets'
import ConfirmRow from './ConfirmRow'

type Slot = { id: string; group: string; name: string }
type State = { names: Record<string, string>; can_play_original: boolean }
const GROUPS = data.groups as { id: string; name: string }[]
const SLOTS = data.slots as Slot[]
const MAX_SECONDS = 30
const AUDIO = ['wav', 'mp3', 'ogg', 'flac', 'm4a']

const norm = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]/g, '')
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p
/** The slot a file's name stands for: group and name ("Announcer Victory.wav"), or the name alone when only one slot has
 *  it ("Double kill.wav", while a plain "Victory.wav" fills neither Match's nor the announcer's) */
const slotFor = (path: string) => {
  const n = norm(fileName(path))
  const full = SLOTS.find(s => norm(`${GROUPS.find(g => g.id === s.group)?.name} ${s.name}`) === n)
  const plain = SLOTS.filter(s => norm(s.name) === n)
  return full ?? (plain.length === 1 ? plain[0] : undefined)
}

/** Audio as a 16-bit WAV at its own rate (48 kHz here), at most two channels. */
function encodeWav(out: AudioBuffer): Uint8Array {
  const ch = Math.min(2, out.numberOfChannels), frames = out.length, rate = out.sampleRate
  const planes = Array.from({ length: ch }, (_, c) => out.getChannelData(c))
  const wav = new DataView(new ArrayBuffer(44 + frames * ch * 2))
  const text = (o: number, s: string) => [...s].forEach((c, i) => wav.setUint8(o + i, c.charCodeAt(0)))
  text(0, 'RIFF'); wav.setUint32(4, 36 + frames * ch * 2, true); text(8, 'WAVEfmt ')
  wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, ch, true); wav.setUint32(24, rate, true)
  wav.setUint32(28, rate * ch * 2, true); wav.setUint16(32, ch * 2, true); wav.setUint16(34, 16, true)
  text(36, 'data'); wav.setUint32(40, frames * ch * 2, true)
  for (let i = 0, o = 44; i < frames; i++) for (let c = 0; c < ch; c++, o += 2) wav.setInt16(o, Math.max(-1, Math.min(1, planes[c][i])) * 32767, true)
  return new Uint8Array(wav.buffer)
}

/** Any audio file the WebView can decode, as a 48 kHz 16-bit WAV of at most MAX_SECONDS (mono stays mono). */
async function toWav(bytes: ArrayBuffer): Promise<{ wav: Uint8Array; cut: boolean }> {
  const ctx = new AudioContext({ sampleRate: 48000 }) // decoded at 48 kHz, so the render below resamples nothing
  const buf = await ctx.decodeAudioData(bytes).finally(() => void ctx.close())
  const ch = Math.min(2, buf.numberOfChannels)
  const cut = buf.duration > MAX_SECONDS
  const frames = Math.max(1, Math.ceil(Math.min(buf.duration, MAX_SECONDS) * 48000))
  const off = new OfflineAudioContext(ch, frames, 48000)
  const src = off.createBufferSource()
  src.buffer = buf
  src.connect(off.destination)
  src.start()
  return { wav: encodeWav(await off.startRendering()), cut }
}

/** A slot's Built-in menu: each of the app's own sounds, with a play button to hear it and its name to pick it. In a
 *  portal under the button (fixed, flipped up near the window's foot), so the scrolling slot list never clips it. */
function PresetMenu({ anchor, onPick, onClose }: { anchor: HTMLElement; onPick: (p: Preset) => void; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect(), h = menu.current?.offsetHeight ?? 320
    setPos({ top: r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - 6 - h) : r.bottom + 6, right: innerWidth - r.right })
  }, [anchor])
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc, true)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc, true) }
  }, [anchor, onClose])
  const ctx = useRef<AudioContext | null>(null)
  useEffect(() => () => void ctx.current?.close(), [])
  const hear = async (p: Preset) => {
    ctx.current ??= new AudioContext()
    const src = ctx.current.createBufferSource()
    src.buffer = await renderPreset(p)
    src.connect(ctx.current.destination)
    src.start()
  }
  return createPortal(
    <div ref={menu} className="xtra-menu snd-preset-menu" role="menu" aria-label="Built-in sounds"
      style={{ position: 'fixed', top: pos?.top ?? -9999, right: pos?.right ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      {PRESETS.map(p => (
        <div key={p.id} className="snd-preset-row">
          <button type="button" className="lo-icon" title={`Play ${p.name}`} aria-label={`Play ${p.name}`} onClick={() => void hear(p)}><Play size={14} /></button>
          <button type="button" role="menuitem" className="xtra-item" onClick={() => onPick(p)} title={`Use ${p.name} for this slot`}>
            <span className="snd-preset-name">{p.name}</span><small>{p.hint}</small>
          </button>
        </div>
      ))}
    </div>, document.body)
}

export type SoundsProps = Pick<LoadoutProps, 'alert' | 'blocked'> & { onInstall: (path: string) => Promise<void> }

export default function SoundsScreen({ alert, blocked, onInstall }: SoundsProps) {
  const shown = useView() === 'sounds'
  const [group, setGroup] = useState(GROUPS[0].id)
  const [query, setQuery] = useState('') // Search sounds: slots of every group whose name (or group) matches
  const [st, setSt] = useState<State>({ names: {}, can_play_original: false })
  const [reading, setReading] = useState<Record<string, { name: string; n: number }>>({}) // slot -> the newest file being read, and how many are
  const [over, setOver] = useState<string | null>(null) // the slot (or 'folder') a drag is over
  const [playing, setPlaying] = useState<string | null>(null) // `${slot}:yours` or `${slot}:game`
  const playingNow = useRef<string | null>(null) // the same, for the drop listener (bound once per view, so its state is stale)
  playingNow.current = playing
  const [making, setMaking] = useState<string | null>(null)
  const audio = useRef<{ el: HTMLAudioElement; url: string } | null>(null)
  const newest = useRef<Record<string, number>>({}) // per slot, the latest drop or pick that reached it: an earlier one never lands over it
  const dropSeq = useRef(0) // numbers each drop or pick when it happens (a folder's files share their drop's number)
  const [batches, setBatches] = useState(0) // folders or file sets being read: Make waits for all of them
  const [menuFor, setMenuFor] = useState<{ slot: Slot; anchor: HTMLElement } | null>(null) // the slot whose Built-in menu is open
  const playToken = useRef(0) // a play still loading when another starts (or Stop) never starts after it

  const asked = useRef(0) // only the newest state read lands: a slower, older one never overwrites it
  // repakxtra: a failed read says so once (slots would look empty, as if nothing was saved)
  const refresh = () => { const n = ++asked.current; return invoke<State>('sounds_state').then(v => { if (n === asked.current) setSt(v) }).catch(e => { if (n === asked.current) alert.warning('Could not read your sounds', `The slots may look empty. ${String(e)}`, { action: { label: 'Try again', onClick: () => { void refresh() } } }) }) }
  useEffect(() => { if (shown) void refresh() }, [shown])
  useEffect(() => { // the preview kit installed in Setup turns the Game buttons on
    window.addEventListener('preview-kit-changed', refresh)
    return () => window.removeEventListener('preview-kit-changed', refresh)
  }, [])

  const stop = () => {
    playToken.current++
    if (audio.current) { audio.current.el.pause(); URL.revokeObjectURL(audio.current.url) }
    audio.current = null
    setPlaying(null)
  }
  useEffect(() => { if (!shown) stop() }, [shown])

  /** A dropped or browsed file into a slot. True when the slot got its sound. */
  const assign = (slot: Slot, path: string, seq = ++dropSeq.current) => put(slot, fileName(path), async () => {
    const bytes = await invoke<ArrayBuffer>('sounds_read', { path })
    return toWav(bytes).catch(() => { throw new Error(`${fileName(path)} could not be read as audio. Use a .wav, .mp3, or .ogg.`) })
  }, seq)
  /** A built-in sound into a slot, under its name. */
  const pickPreset = (slot: Slot, p: Preset) => { setMenuFor(null); if (clearingRef.current) return; void put(slot, p.name, async () => ({ wav: encodeWav(await renderPreset(p)), cut: false }), ++dropSeq.current) }
  const put = async (slot: Slot, name: string, load: () => Promise<{ wav: Uint8Array; cut: boolean }>, seq: number): Promise<boolean> => {
    if (clearingRef.current || seq < (newest.current[slot.id] ?? 0)) return false // clearing, or a later drop already filled this slot
    if (playingNow.current?.startsWith(`${slot.id}:`)) stop()
    newest.current[slot.id] = seq
    setReading(r => ({ ...r, [slot.id]: { name, n: (r[slot.id]?.n ?? 0) + 1 } }))
    try {
      const { wav, cut } = await load()
      if (newest.current[slot.id] !== seq) return false // a newer file was put on this slot while this one was read
      await invoke('sounds_set', wav, { headers: { slot: slot.id, name: encodeURIComponent(name) } })
      if (cut) alert.info(slot.name, `Only its first ${MAX_SECONDS} seconds are used.`)
      return true
    } catch (e) {
      cue('warning'); alert.warning(slot.name, e instanceof Error ? e.message : String(e))
      return false
    } finally {
      try { await refresh() } finally {
        setReading(r => { const { [slot.id]: was, ...rest } = r; return was && was.n > 1 ? { ...r, [slot.id]: { ...was, n: was.n - 1 } } : rest })
      }
    }
  }

  /** Several files or folders: each file fills the slots its name stands for. */
  const fillByName = async (paths: string[], seq = ++dropSeq.current) => {
    setBatches(n => n + 1) // from the drop on, listing the folder included: Make waits until every file is in
    try { await fillFiles(paths, seq) } finally { setBatches(n => n - 1) }
  }
  const fillFiles = async (paths: string[], seq: number) => {
    const files = (await Promise.all(paths.map(async p => {
      const inside = await invoke<string[]>('sounds_folder', { path: p }).catch(() => [])
      return inside.length ? inside : [p]
    }))).flat().filter(p => AUDIO.includes(p.split('.').pop()?.toLowerCase() ?? ''))
    // one file per slot: a group-and-name file ("Combat Bodyshot kill") wins over a plain one, else the first found
    const bySlot = new Map<string, readonly [Slot, string]>()
    for (const f of files) {
      const s = slotFor(f)
      const full = s && norm(fileName(f)) !== norm(s.name)
      if (s && (!bySlot.has(s.id) || full)) bySlot.set(s.id, [s, f])
    }
    const pairs = [...bySlot.values()]
    if (!pairs.length) {
      cue('warning')
      alert.warning('No file matched a slot', files.length ? 'Name each file like its slot, for example Double kill.wav, or drop one file on a slot.' : 'Drop .wav, .mp3, or .ogg files.')
      return
    }
    // one at a time: each file is read and decoded whole, a folder of songs at once would fill the WebView's memory
    let added = 0
    for (const [s, f] of pairs) if (await assign(s, f, seq)) added++
    const left = files.length - pairs.length
    if (added) { cue('success'); alert.success(`${added} ${added === 1 ? 'sound' : 'sounds'} added`, left ? `${left} ${left === 1 ? 'file was' : 'files were'} not used: no slot matched, or another file filled it.` : undefined) }
  }

  // Files dropped on the window: on a slot they fill it, anywhere else they fill the slots their names match.
  // App.tsx leaves drops alone while this view shows (no install panel)
  const slotAt = (pos?: { x: number; y: number }) => {
    if (!pos) return null
    const el = document.elementFromPoint(pos.x / devicePixelRatio, pos.y / devicePixelRatio)
    return el?.closest<HTMLElement>('[data-snd-slot]')?.dataset.sndSlot ?? null
  }
  useEffect(() => {
    if (!shown) return
    type P = { paths?: string[]; position?: { x: number; y: number } }
    const offs = [
      listen<P>('tauri://drag-over', e => setOver(modalOpen() || clearingRef.current ? null : slotAt(e.payload.position))),
      listen('tauri://drag-leave', () => setOver(null)),
      listen<P>('tauri://drag-drop', e => {
        setOver(null)
        if (modalOpen() || clearingRef.current) return // a dialog over the tab gets the drop, and Clear all blocks new imports until done
        const paths = e.payload.paths ?? []
        const slot = SLOTS.find(s => s.id === slotAt(e.payload.position))
        const seq = ++dropSeq.current // numbered now, as dropped, not when the folder check below comes back
        if (slot && paths.length === 1) {
          setBatches(n => n + 1) // Make waits through the check too
          void invoke<string[]>('sounds_folder', { path: paths[0] })
            .then(async inside => { if (inside.length) await fillByName(paths, seq); else await assign(slot, paths[0], seq) })
            .finally(() => setBatches(n => n - 1))
        } else if (paths.length) void fillByName(paths, seq)
      }),
    ]
    return () => offs.forEach(o => void o.then(f => f()))
  }, [shown]) // eslint-disable-line react-hooks/exhaustive-deps

  const browse = async (slot: Slot) => {
    if (clearingRef.current) return
    const path = await pick({ multiple: false, filters: [{ name: 'Audio', extensions: AUDIO }] })
    if (typeof path === 'string' && !clearingRef.current) await assign(slot, path)
  }
  const browseFolder = async () => {
    if (clearingRef.current) return
    const path = await pick({ directory: true })
    if (typeof path === 'string' && !clearingRef.current) await fillByName([path])
  }
  const clear = async (slot: Slot) => {
    if (clearingRef.current) return
    newest.current[slot.id] = ++dropSeq.current // a folder import still running never fills it again
    if (playing?.startsWith(`${slot.id}:`)) stop()
    await invoke('sounds_clear', { slot: slot.id }).catch(e => alert.warning(slot.name, String(e)))
    await refresh()
  }
  const [askClear, setAskClear] = useState(false) // Clear all's in-place confirm
  const [clearing, setClearing] = useState(false)
  const clearingRef = useRef(false)
  const importing = batches > 0 || Object.keys(reading).length > 0
  useEffect(() => { if (!Object.keys(st.names).length) setAskClear(false) }, [st]) // nothing left to clear: the ask goes, never comes back on its own
  /** Every filled slot back to the game's sound, waiting for imports first and blocking new ones until done. */
  const clearAll = async () => {
    if (clearingRef.current || importing) return
    clearingRef.current = true
    setMenuFor(null)
    const cut = ++dropSeq.current
    for (const s of SLOTS) newest.current[s.id] = cut // invalidates every slot, including empty ones
    stop()
    setClearing(true)
    try {
      const latest = await invoke<State>('sounds_state').catch(() => null)
      const ids = latest ? [...new Set([...Object.keys(st.names), ...Object.keys(latest.names)])] : SLOTS.map(s => s.id)
      const failed: string[] = []
      for (const id of ids) await invoke('sounds_clear', { slot: id }).catch(e => { failed.push(`${SLOTS.find(s => s.id === id)?.name ?? id}: ${String(e)}`) })
      if (failed.length) { cue('warning'); alert.warning(failed.length === 1 ? 'One sound was not cleared' : `${failed.length} sounds were not cleared`, failed.join(', ')) }
      await refresh()
    } finally {
      clearingRef.current = false
      setClearing(false)
      setAskClear(false)
    }
  }
  const play = async (slot: Slot, kind: 'yours' | 'game') => {
    const key = `${slot.id}:${kind}`
    if (playing === key) { stop(); return }
    stop()
    const token = playToken.current
    setPlaying(key)
    try {
      const wav = await invoke<ArrayBuffer>(kind === 'yours' ? 'sounds_get' : 'sounds_original', { slot: slot.id })
      if (token !== playToken.current) return // stopped, or another sound started, while this one loaded
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
      const el = new Audio(url)
      audio.current = { el, url }
      el.onended = () => { if (audio.current?.el === el) stop() }
      await el.play()
    } catch (e) {
      if (token !== playToken.current) return
      setPlaying(null)
      cue('warning'); alert.warning(slot.name, e instanceof Error ? e.message : String(e))
    }
  }

  const count = Object.keys(st.names).length
  const make = async () => {
    setMaking('Encoding sounds')
    try {
      await onInstall(await invoke<string>('sounds_make')) // the install card names it and puts it in the Library
    } catch (e) {
      cue('warning'); alert.warning('Could not make the sound mod', e instanceof Error ? e.message : String(e))
    } finally {
      setMaking(null)
    }
  }
  const why = blocked ? 'Close Marvel Rivals first' : clearing ? 'Wait for the sounds being cleared' : batches || Object.keys(reading).length ? 'Wait for the sounds being read'
    : !count ? 'Add a sound to a slot first' : null
  const words = (t: string) => ` ${t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} ` // spaces kept: "overtime" is not "over time"
  const q = words(query).trim()
  const groupOf = (s: Slot) => GROUPS.find(g => g.id === s.group)?.name ?? ''
  const inGroup = q ? SLOTS.filter(s => words(`${groupOf(s)} ${s.name}`).includes(` ${q}`)) : SLOTS.filter(s => s.group === group)
  const groupDone = inGroup.filter(s => st.names[s.id]).length

  return (
    <section className="lo-screen snd-screen" hidden={!shown} aria-label="Sounds">
      {/* the Loadouts and Nexus Mods pages' head: the title, then the page's one action */}
      <header className="lo-screen-head">
        <div className="lo-head-main"><div className="lo-title-row">
          <h2>Sounds</h2>
          <label className="lp-search lo-search">
            <Search size={14} aria-hidden="true" />
            <input value={query} placeholder="Search sounds" aria-label="Search sounds in every group" onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setQuery('') }} />
            {query && <button type="button" className="lo-icon" aria-label="Clear search" title="Clear search" onClick={() => setQuery('')}><X size={13} /></button>}
          </label>
        </div></div>
        <div className="lo-head-tools">
          {askClear && count ? <ConfirmRow busy={clearing || importing} yes={clearing ? 'Clearing…' : 'Clear all'} onYes={() => void clearAll()} onNo={() => setAskClear(false)}
            text={count === 1 ? "Clear your sound? Its slot plays the game's own again." : `Clear all ${count} sounds? Their slots play the game's own again.`} />
            : <>
              <span className="snd-total">{count ? `${count} of ${SLOTS.length} sounds replaced` : 'Nothing replaced yet'}</span>
              {count > 0 && <button type="button" className="lo-text-btn snd-clear-all" disabled={clearing || importing} onClick={() => setAskClear(true)}
                title={importing ? 'Wait for the sounds being read' : "Put every slot back to the game's sound"}>Clear all</button>}
            </>}
          <button type="button" className={`lo-text-btn snd-make${making ? ' is-working' : why ? ' is-locked' : ' is-primary'}`}
            onClick={() => { if (!making && !why) void make() }} disabled={Boolean(making) || Boolean(why)} aria-busy={Boolean(making)}
            aria-disabled={!making && Boolean(why)} title={why ?? 'Build a mod with every sound you added, then choose how to install it'}>
            {making ? <span className="t-text-in"><span className="t-shimmer">{making}</span></span>
              : <span className="snd-btn-in">{why ? <Lock size={16} aria-hidden /> : <Box size={16} aria-hidden />}Make mod</span>}
          </button>
        </div>
      </header>
      <div className="lo-body snd">
      <aside className="snd-side" aria-label="Sound groups">
        <div className="snd-groups" role="tablist" aria-orientation="vertical">
          {GROUPS.map(g => {
            const all = SLOTS.filter(s => s.group === g.id)
            const done = all.filter(s => st.names[s.id]).length
            return (
              <button key={g.id} type="button" role="tab" aria-selected={g.id === group && !q} className={`snd-group${g.id === group && !q ? ' is-active' : ''}`} onClick={() => { setGroup(g.id); setQuery('') }}>
                <span className="snd-group-name">{g.name}</span>
                <span className={`lo-group-count${done ? ' is-some' : ''}`}><Num id={`snd-${g.id}`} value={done} />/{all.length}</span>
              </button>
            )
          })}
        </div>
        <button type="button" data-snd-slot="folder" className={`snd-folder${over === 'folder' ? ' is-over' : ''}`} disabled={clearing} onClick={() => void browseFolder()}
          title="Pick a folder of sounds">
          <span className="snd-folder-title"><FolderOpen size={16} aria-hidden />Drop a folder</span>
          <span className="snd-folder-note">Files named like a slot fill it, for example Double kill.wav</span>
        </button>
      </aside>

      <div className="snd-main">
        <div className="snd-head">
          <h2 className="snd-title">{q ? `Matching “${query.trim()}”` : GROUPS.find(g => g.id === group)?.name}
            <span className="snd-meta">{inGroup.length} {inGroup.length === 1 ? 'slot' : 'slots'} · {groupDone ? `${groupDone} replaced` : 'none replaced'}</span>
          </h2>
        </div>

        <ul className="snd-slots" key={q ? 'search' : group}>
          {!inGroup.length && <li className="snd-none">No sound matches “{query.trim()}”. Try a group name, like Announcer.</li>}
          {inGroup.map(s => {
            const name = st.names[s.id]
            const busy = reading[s.id]?.name
            return (
              <li key={s.id} data-snd-slot={s.id} className={`snd-slot${name ? ' is-set' : ''}${over === s.id ? ' is-over' : ''}`}
                onClick={e => { if (!(e.target as HTMLElement).closest('button') && !busy && !clearing) void browse(s) }}>
                <span className="snd-icon" aria-hidden><Volume2 size={16} /></span>
                <span className="snd-text">
                  <span className="snd-name">{s.name}{q && <span className="snd-in"> · {groupOf(s)}</span>}</span>
                  <span className="snd-hint">{busy ? <span className="t-shimmer">Reading {busy}</span>
                    : <span>{name ?? 'Drop an audio file or click to browse'}</span>}</span>
                </span>
                <span className="snd-tools">
                  <button type="button" className="snd-play" disabled={!st.can_play_original} onClick={() => void play(s, 'game')}
                    title={st.can_play_original ? (playing === `${s.id}:game` ? 'Stop' : "Play the game's sound") : "Playing the game's sound needs the preview kit (Setup)"}
                    aria-label={`Play the game's ${s.name}`}>
                    {playing === `${s.id}:game` ? <Square size={12} aria-hidden /> : <Play size={12} aria-hidden />}Game
                  </button>
                  {name && <>
                    <button type="button" className="snd-play" disabled={clearing} onClick={() => void play(s, 'yours')} title={playing === `${s.id}:yours` ? 'Stop' : 'Play yours'} aria-label={`Play your ${s.name}`}>
                      {playing === `${s.id}:yours` ? <Square size={12} aria-hidden /> : <Play size={12} aria-hidden />}Yours
                    </button>
                    <span className="snd-sep" aria-hidden />{/* apart from Yours, so a play click never lands on clear */}
                    <button type="button" className="lo-icon" disabled={Boolean(busy) || clearing} onClick={() => void clear(s)} title="Back to the game's sound" aria-label={`Remove your ${s.name}`}><X size={14} /></button>
                  </>}
                  <button type="button" className="lo-text-btn snd-browse" aria-haspopup="menu" aria-expanded={menuFor?.slot.id === s.id} disabled={Boolean(busy) || clearing}
                    onClick={e => { const anchor = e.currentTarget; setMenuFor(m => m?.slot.id === s.id ? null : { slot: s, anchor }) }} title="Pick one of the app's own sounds">
                    Built-in<ChevronDown size={14} aria-hidden />
                  </button>
                  <button type="button" className="lo-text-btn snd-browse" disabled={Boolean(busy) || clearing} onClick={() => void browse(s)}>{name ? 'Replace' : 'Browse'}</button>
                </span>
              </li>
            )
          })}
        </ul>
        {menuFor && <PresetMenu anchor={menuFor.anchor} onPick={p => pickPreset(menuFor.slot, p)} onClose={() => setMenuFor(null)} />}
      </div>
      </div>
    </section>
  )
}
