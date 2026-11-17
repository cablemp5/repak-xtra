// repakxtra: the Sounds tab (xtra_sounds.rs). Groups on the left (Combat, Killstreaks, Healing, Kill feed, Alerts,
// Match, Announcer) with how many of their slots have a sound, the picked group's slots on the right. Drop an audio
// file on a slot (or click it to browse), drop several files or a folder anywhere and files named like a slot fill
// it. The page decodes each file (WebView2 reads .wav, .mp3, .ogg, .flac, and .m4a) to 48 kHz 16-bit WAV and the app
// keeps it per slot. Make mod builds one mod, repakxtra-sounds, into the Library. Play compares yours with the
// game's own (that one needs the preview kit's decoder).
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as pick } from '@tauri-apps/plugin-dialog'
import { Check, FolderOpen, Play, Square, Volume2, X } from 'lucide-react'
import data from '../data/sound_slots.json'
import type { LoadoutProps } from './Loadouts'
import { useView } from './loadoutStore'
import { cue } from './sounds'
import { Num } from './motion'

type Slot = { id: string; group: string; name: string }
type State = { names: Record<string, string>; made: string | null; can_play_original: boolean }
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
  const out = await off.startRendering()
  const planes = Array.from({ length: ch }, (_, c) => out.getChannelData(c))
  const wav = new DataView(new ArrayBuffer(44 + frames * ch * 2))
  const text = (o: number, s: string) => [...s].forEach((c, i) => wav.setUint8(o + i, c.charCodeAt(0)))
  text(0, 'RIFF'); wav.setUint32(4, 36 + frames * ch * 2, true); text(8, 'WAVEfmt ')
  wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, ch, true); wav.setUint32(24, 48000, true)
  wav.setUint32(28, 48000 * ch * 2, true); wav.setUint16(32, ch * 2, true); wav.setUint16(34, 16, true)
  text(36, 'data'); wav.setUint32(40, frames * ch * 2, true)
  for (let i = 0, o = 44; i < frames; i++) for (let c = 0; c < ch; c++, o += 2) wav.setInt16(o, Math.max(-1, Math.min(1, planes[c][i])) * 32767, true)
  return { wav: new Uint8Array(wav.buffer), cut }
}

export type SoundsProps = Pick<LoadoutProps, 'alert' | 'blocked' | 'reload'>

export default function SoundsScreen({ alert, blocked, reload }: SoundsProps) {
  const shown = useView() === 'sounds'
  const [group, setGroup] = useState(GROUPS[0].id)
  const [st, setSt] = useState<State>({ names: {}, made: null, can_play_original: false })
  const [reading, setReading] = useState<Record<string, string>>({}) // slot -> file being read
  const [over, setOver] = useState<string | null>(null) // the slot (or 'folder') a drag is over
  const [playing, setPlaying] = useState<string | null>(null) // `${slot}:yours` or `${slot}:game`
  const [making, setMaking] = useState<string | null>(null)
  const [made, setMade] = useState(false)
  const audio = useRef<{ el: HTMLAudioElement; url: string } | null>(null)
  const playToken = useRef(0) // a play still loading when another starts (or Stop) never starts after it

  const refresh = () => invoke<State>('sounds_state').then(setSt).catch(() => undefined)
  useEffect(() => { if (shown) void refresh() }, [shown])

  const stop = () => {
    playToken.current++
    if (audio.current) { audio.current.el.pause(); URL.revokeObjectURL(audio.current.url) }
    audio.current = null
    setPlaying(null)
  }
  useEffect(() => { if (!shown) stop() }, [shown])

  /** True when the slot got its sound. */
  const assign = async (slot: Slot, path: string): Promise<boolean> => {
    setReading(r => ({ ...r, [slot.id]: fileName(path) }))
    try {
      const bytes = await invoke<ArrayBuffer>('sounds_read', { path })
      const { wav, cut } = await toWav(bytes).catch(() => { throw new Error(`${fileName(path)} could not be read as audio. Use a .wav, .mp3, or .ogg.`) })
      await invoke('sounds_set', wav, { headers: { slot: slot.id, name: encodeURIComponent(fileName(path)) } })
      if (cut) alert.info(slot.name, `Only its first ${MAX_SECONDS} seconds are used.`)
      setMade(false)
      return true
    } catch (e) {
      cue('warning'); alert.warning(slot.name, e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setReading(r => { const { [slot.id]: _, ...rest } = r; return rest })
      await refresh()
    }
  }

  /** Several files or folders: each file fills the slots its name stands for. */
  const fillByName = async (paths: string[]) => {
    const files = (await Promise.all(paths.map(async p => {
      const inside = await invoke<string[]>('sounds_folder', { path: p }).catch(() => [])
      return inside.length ? inside : [p]
    }))).flat().filter(p => AUDIO.includes(p.split('.').pop()?.toLowerCase() ?? ''))
    const pairs = files.flatMap(f => { const s = slotFor(f); return s ? [[s, f] as const] : [] })
    if (!pairs.length) {
      cue('warning')
      alert.warning('No file matched a slot', files.length ? 'Name each file like its slot, for example Double kill.wav, or drop one file on a slot.' : 'Drop .wav, .mp3, or .ogg files.')
      return
    }
    // one at a time: each file is read and decoded whole, a folder of songs at once would fill the WebView's memory
    let added = 0
    for (const [s, f] of pairs) if (await assign(s, f)) added++
    const left = files.length - pairs.length
    if (added) { cue('success'); alert.success(`${added} ${added === 1 ? 'sound' : 'sounds'} added`, left ? `${left} ${left === 1 ? 'file' : 'files'} matched no slot.` : undefined) }
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
      listen<P>('tauri://drag-over', e => setOver(slotAt(e.payload.position))),
      listen('tauri://drag-leave', () => setOver(null)),
      listen<P>('tauri://drag-drop', e => {
        setOver(null)
        const paths = e.payload.paths ?? []
        const slot = SLOTS.find(s => s.id === slotAt(e.payload.position))
        if (slot && paths.length === 1) void invoke<string[]>('sounds_folder', { path: paths[0] }).then(async inside => { if (inside.length) await fillByName(paths); else await assign(slot, paths[0]) })
        else if (paths.length) void fillByName(paths)
      }),
    ]
    return () => offs.forEach(o => void o.then(f => f()))
  }, [shown]) // eslint-disable-line react-hooks/exhaustive-deps

  const browse = async (slot: Slot) => {
    const path = await pick({ multiple: false, filters: [{ name: 'Audio', extensions: AUDIO }] })
    if (typeof path === 'string') await assign(slot, path)
  }
  const browseFolder = async () => {
    const path = await pick({ directory: true })
    if (typeof path === 'string') await fillByName([path])
  }
  const clear = async (slot: Slot) => {
    if (playing?.startsWith(`${slot.id}:`)) stop()
    await invoke('sounds_clear', { slot: slot.id }).catch(e => alert.warning(slot.name, String(e)))
    setMade(false)
    await refresh()
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
      const path = await invoke<string>('sounds_make')
      setMade(true)
      cue('success')
      alert.success(st.made ? 'Sounds mod updated' : 'Sounds mod made', path.endsWith('.pak')
        ? 'repakxtra-sounds is in your Library and on. Your sounds play in the next match.'
        : 'repakxtra-sounds is in your Library and switched off. Switch it on to hear your sounds.')
      await refresh()
      void reload()
    } catch (e) {
      cue('warning'); alert.warning('Could not make the sounds mod', e instanceof Error ? e.message : String(e))
    } finally {
      setMaking(null)
    }
  }
  const why = blocked ? 'Close Marvel Rivals first' : Object.keys(reading).length ? 'Wait for the sounds being read'
    : !count ? (st.made ? "Every slot is back to the game. Delete repakxtra-sounds in the Library to hear the game's sounds again" : 'Add a sound to a slot first') : null
  const inGroup = SLOTS.filter(s => s.group === group)
  const groupDone = inGroup.filter(s => st.names[s.id]).length

  return (
    <section className="snd" hidden={!shown} aria-label="Sounds">
      <aside className="snd-side" aria-label="Sound groups">
        <div className="snd-groups" role="tablist" aria-orientation="vertical">
          {GROUPS.map(g => {
            const all = SLOTS.filter(s => s.group === g.id)
            const done = all.filter(s => st.names[s.id]).length
            return (
              <button key={g.id} type="button" role="tab" aria-selected={g.id === group} className={`snd-group${g.id === group ? ' is-active' : ''}`} onClick={() => setGroup(g.id)}>
                <span className="snd-group-name">{g.name}</span>
                <span className={`lo-group-count${done ? ' is-some' : ''}`}><Num id={`snd-${g.id}`} value={done} />/{all.length}</span>
              </button>
            )
          })}
        </div>
        <button type="button" data-snd-slot="folder" className={`snd-folder${over === 'folder' ? ' is-over' : ''}`} onClick={() => void browseFolder()}
          title="Pick a folder of sounds">
          <span className="snd-folder-title"><FolderOpen size={16} aria-hidden />Drop a folder</span>
          <span className="snd-folder-note">Files named like a slot fill it, for example Double kill.wav</span>
        </button>
      </aside>

      <div className="snd-main">
        <div className="snd-head">
          <h2 className="snd-title">{GROUPS.find(g => g.id === group)?.name}
            <span className="snd-meta">{inGroup.length} slots · {groupDone ? `${groupDone} replaced` : 'none replaced'}</span>
          </h2>
          <span className="snd-total">{count ? `${count} of ${SLOTS.length} sounds replaced` : 'Nothing replaced yet'}</span>
          <button type="button" className={`lo-text-btn snd-make${making ? ' is-working' : made ? ' is-installed' : why ? ' is-locked' : ' is-primary'}`}
            onClick={() => { if (!making && !why) void make() }} disabled={Boolean(making) || Boolean(why)} aria-busy={Boolean(making)}
            title={why ?? 'Build one mod with every sound you added, into the Library'}>
            {making ? <span className="t-text-in"><span className="t-shimmer">{making}</span></span>
              : made ? <span className="t-text-in snd-btn-in"><Check size={16} aria-hidden />In your Library</span>
              : st.made ? 'Update mod' : 'Make mod'}
          </button>
        </div>

        <ul className="snd-slots" key={group}>
          {inGroup.map(s => {
            const name = st.names[s.id]
            const busy = reading[s.id]
            return (
              <li key={s.id} data-snd-slot={s.id} className={`snd-slot${name ? ' is-set' : ''}${over === s.id ? ' is-over' : ''}`}
                onClick={e => { if (!(e.target as HTMLElement).closest('button') && !busy) void browse(s) }}>
                <span className="snd-icon" aria-hidden><Volume2 size={16} /></span>
                <span className="snd-text">
                  <span className="snd-name">{s.name}</span>
                  <span className="snd-hint">{busy ? <span className="t-shimmer">Reading {busy}</span>
                    : <span>{name ?? 'Drop a .wav, .mp3, or .ogg here, or click to browse'}</span>}</span>
                </span>
                <span className="snd-tools">
                  <button type="button" className="snd-play" disabled={!st.can_play_original} onClick={() => void play(s, 'game')}
                    title={st.can_play_original ? (playing === `${s.id}:game` ? 'Stop' : "Play the game's sound") : "Playing the game's sound needs the preview kit (Setup)"}
                    aria-label={`Play the game's ${s.name}`}>
                    {playing === `${s.id}:game` ? <Square size={12} aria-hidden /> : <Play size={12} aria-hidden />}Game
                  </button>
                  {name && <>
                    <button type="button" className="snd-play" onClick={() => void play(s, 'yours')} title={playing === `${s.id}:yours` ? 'Stop' : 'Play yours'} aria-label={`Play your ${s.name}`}>
                      {playing === `${s.id}:yours` ? <Square size={12} aria-hidden /> : <Play size={12} aria-hidden />}Yours
                    </button>
                    <button type="button" className="lo-icon" onClick={() => void clear(s)} title="Back to the game's sound" aria-label={`Remove your ${s.name}`}><X size={14} /></button>
                  </>}
                  <button type="button" className="lo-text-btn snd-browse" disabled={Boolean(busy)} onClick={() => void browse(s)}>{name ? 'Replace' : 'Browse'}</button>
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
