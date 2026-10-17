// repakxtra: an emote's sound over its animation preview. The generator records which emote each animation preview
// shows and saves each sound mod's emote sounds as WAVs (xtra_previews.rs get_preview_emotes, get_preview_audio).
// Hovering a loadout's animation slide restarts the clip and plays the sound of the same emote from one of the
// loadout's sound mods, cut to the clip's length and looping with it, while Sound effects is on (sounds.ts). An emote is
// "<hero>-<item index>", like "1026-205".
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isSoundOn } from './sounds'

type Emotes = { anim: Record<string, string[]>; audio: Record<string, string[]> }
type Sound = { key: string; emote: string }
let emotes: Emotes = { anim: {}, audio: {} }
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const load = () => invoke<Emotes>('get_preview_emotes').then(e => { emotes = e; listeners.forEach(l => l()) }).catch(() => undefined)
load()

/** Same emote: same item index, and the same hero or a universal emote (hero 9999) on either side. */
export const sameEmote = (a: string, b: string) => {
  const [ha, ia] = a.split('-'), [hb, ib] = b.split('-')
  return ia === ib && (ha === hb || ha === '9999' || hb === '9999')
}

/** The sound to play over `slideKey`'s animation: the first of `keys` (the loadout's mods) with a sound for its emote. */
export function emoteSoundFor(slideKey: string | undefined, keys: string[], e: Emotes = emotes): Sound | null {
  const shown = slideKey ? e.anim[slideKey] : undefined
  if (!shown?.length) return null
  for (const key of keys) {
    const emote = e.audio[key]?.find(s => shown.some(a => sameEmote(a, s)))
    if (emote) return { key, emote }
  }
  return null
}

export const useEmoteSound = (slideKey: string | undefined, keys: string[]) => {
  useSyncExternalStore(subscribe, () => emotes)
  return emoteSoundFor(slideKey, keys)
}

/** An animated WebP's loop length in seconds: its frames' durations (ANMF chunks) added up; 0 when not animated. */
export function webpSeconds(buf: ArrayBuffer) {
  const v = new DataView(buf)
  let ms = 0
  for (let at = 12; at + 8 <= v.byteLength;) {
    const id = String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3))
    const size = v.getUint32(at + 4, true)
    if (id === 'ANMF' && at + 8 + 15 <= v.byteLength) ms += v.getUint8(at + 20) | (v.getUint8(at + 21) << 8) | (v.getUint8(at + 22) << 16)
    at += 8 + size + (size & 1)
  }
  return ms / 1000
}

let ctx: AudioContext | null = null
const decoded = new Map<string, Promise<AudioBuffer | null>>()
const soundBuffer = (s: Sound) => {
  const id = `${s.key}/${s.emote}`
  if (!decoded.has(id)) {
    decoded.set(id, invoke<ArrayBuffer>('get_preview_audio', { key: s.key, emote: s.emote })
      .then(bytes => ctx!.decodeAudioData(bytes))
      .catch(() => { decoded.delete(id); return null }))
  }
  return decoded.get(id)!
}
listen('mod-previews-done', () => { decoded.clear(); load() }).catch(() => undefined) // a run may have changed them

/** The sound exactly `seconds` long: cut, or padded with silence, so one loop of it is one loop of the clip. */
function fitted(b: AudioBuffer, seconds: number) {
  const out = ctx!.createBuffer(b.numberOfChannels, Math.max(1, Math.round(seconds * b.sampleRate)), b.sampleRate)
  for (let c = 0; c < b.numberOfChannels; c++) out.copyToChannel(b.getChannelData(c).subarray(0, out.length), c)
  return out
}

let playing: AudioBufferSourceNode | null = null
let turn = 0 // a stop (or a newer play) while the sound is still loading cancels it
/** Plays the sound from its start, looping every `loopSeconds` with the clip (once, whole, without a length). */
export async function playEmoteSound(sound: Sound, loopSeconds: number) {
  stopEmoteSound()
  if (!isSoundOn()) return
  const mine = turn
  ctx ??= new AudioContext()
  ctx.resume().catch(() => undefined) // refused before the first click in the app: then it stays silent
  const b = await soundBuffer(sound)
  if (!b || mine !== turn) return
  const node = ctx.createBufferSource()
  node.buffer = loopSeconds > 0 ? fitted(b, loopSeconds) : b
  node.loop = loopSeconds > 0
  const gain = ctx.createGain()
  gain.gain.value = 0.7
  node.connect(gain).connect(ctx.destination)
  node.start()
  playing = node
}
export function stopEmoteSound() {
  turn++
  try { playing?.stop() } catch { /* already ended */ }
  playing = null
}

if (import.meta.env.DEV) {
  const e: Emotes = { anim: { Dance: ['1029-212'], Uni: ['9999-297'] }, audio: { Sfx: ['1029-212'], Other: ['1026-205'], BpSfx: ['1026-297'] } }
  console.assert(emoteSoundFor('Dance', ['Other', 'Sfx'], e)?.key === 'Sfx', 'the loadout mod with the same emote')
  console.assert(emoteSoundFor('Uni', ['BpSfx'], e)?.emote === '1026-297', 'a universal emote matches any hero')
  console.assert(emoteSoundFor('Dance', ['Other'], e) === null && emoteSoundFor(undefined, ['Sfx'], e) === null, 'no match, no sound')
  // RIFF....WEBP, then two ANMF frames of 66 ms and 1000 ms (duration at payload bytes 12-14)
  const anmf = (ms: number) => [65, 78, 77, 70, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ms & 255, (ms >> 8) & 255, 0, 0]
  const webp = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, ...anmf(66), ...anmf(1000)])
  console.assert(Math.abs(webpSeconds(webp.buffer) - 1.066) < 1e-9, 'webpSeconds adds the frames')
}
