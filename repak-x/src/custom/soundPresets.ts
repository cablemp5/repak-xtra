// repakxtra: the Sounds tab's built-in sounds. The first four are short recordings in assets/builtin-sounds (original
// recreations made for repakxtra), the rest are made here from oscillators and noise (WebAudio, offline at 48 kHz).
// A slot's Built-in menu plays one or puts it in the slot, rendered to WAV like a dropped file.
import xpOrb from '../assets/builtin-sounds/minecraft-xp-orb.mp3'
import pickUp from '../assets/builtin-sounds/minecraft-pick-up.mp3'
import successChime from '../assets/builtin-sounds/success-chime.mp3'
import osuHit from '../assets/builtin-sounds/osu-hit.mp3'

type Ctx = OfflineAudioContext
type Osc = { type?: OscillatorType; f: number; to?: number; at?: number; dur: number; gain?: number; attack?: number; sweep?: number }

/** One oscillator with a short attack and an exponential fade, its pitch optionally gliding to `to` over `sweep` s. */
function tone(c: Ctx, o: Osc, out: AudioNode = c.destination) {
  const t = o.at ?? 0, g = c.createGain(), osc = c.createOscillator()
  osc.type = o.type ?? 'sine'
  osc.frequency.setValueAtTime(o.f, t)
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.sweep ?? o.dur))
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(o.gain ?? 0.5, t + (o.attack ?? 0.003))
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur)
  osc.connect(g).connect(out)
  osc.start(t)
  osc.stop(t + o.dur + 0.02)
}

/** A burst of filtered noise: the click or thump under a tone. */
function noise(c: Ctx, o: { at?: number; dur: number; gain?: number; filter: BiquadFilterType; f: number; q?: number }) {
  const t = o.at ?? 0, len = Math.ceil(o.dur * c.sampleRate), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2
  const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain()
  src.buffer = buf
  f.type = o.filter; f.frequency.value = o.f; f.Q.value = o.q ?? 0.7
  g.gain.value = o.gain ?? 0.5
  src.connect(f).connect(g).connect(c.destination)
  src.start(t)
}

/** An FM bell: a carrier whose brightness (the modulator's depth) dies away faster than its ring. */
function bell(c: Ctx, f: number, dur: number, at = 0, gain = 0.45) {
  const car = c.createOscillator(), mod = c.createOscillator(), depth = c.createGain(), g = c.createGain()
  car.frequency.value = f; mod.frequency.value = f * 3.5
  depth.gain.setValueAtTime(f * 1.2, at); depth.gain.exponentialRampToValueAtTime(1, at + dur * 0.6)
  g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(gain, at + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  mod.connect(depth).connect(car.frequency)
  car.connect(g).connect(c.destination)
  for (const o of [car, mod]) { o.start(at); o.stop(at + dur + 0.02) }
}

/** A built-in sound: a recording (`file`, a bundled URL) or a recipe (`make`, rendered for `seconds`). */
export type Preset = { id: string; name: string; hint: string } & ({ file: string } | { seconds: number; make: (c: Ctx) => void })

export const PRESETS: Preset[] = [
  { id: 'xp-orb', name: 'Minecraft XP Orb', hint: 'Glassy plink', file: xpOrb },
  { id: 'pick-up', name: 'Minecraft Pick up', hint: 'Quick item pop', file: pickUp },
  { id: 'success', name: 'Success chime', hint: 'Bright point chime', file: successChime },
  { id: 'osu-hit', name: 'Osu Hit', hint: 'Crisp rhythm-game hit', file: osuHit },
  { id: 'bubble', name: 'Bubble pop', hint: 'Short clean pop', seconds: 0.15, make: c => {
    tone(c, { f: 320, to: 1500, sweep: 0.035, dur: 0.07, gain: 0.7, attack: 0.001 }); noise(c, { dur: 0.004, filter: 'highpass', f: 3000, gain: 0.25 }) } },
  { id: 'tap', name: 'Rhythm tap', hint: 'Crisp drum-pad hit', seconds: 0.15, make: c => {
    noise(c, { dur: 0.018, filter: 'bandpass', f: 2600, q: 1.2, gain: 0.9 }); tone(c, { f: 190, to: 90, sweep: 0.05, dur: 0.07, gain: 0.55, attack: 0.001 }) } },
  { id: 'chime', name: 'Glass chime', hint: 'Three quick high notes', seconds: 1, make: c => {
    [1568, 1976, 2349].forEach((f, i) => tone(c, { f, at: i * 0.06, dur: 0.8, gain: 0.3 })) } },
  { id: 'levelup', name: 'Level up', hint: 'Rising four-note arpeggio', seconds: 0.9, make: c => {
    [523, 659, 784, 1047].forEach((f, i) => tone(c, { type: 'triangle', f, at: i * 0.07, dur: i === 3 ? 0.6 : 0.18, gain: 0.4 })) } },
  { id: 'tick', name: 'Soft tick', hint: 'Tiny dry click', seconds: 0.05, make: c => {
    noise(c, { dur: 0.005, filter: 'highpass', f: 4000, gain: 0.6 }); tone(c, { f: 2400, dur: 0.012, gain: 0.25, attack: 0.001 }) } },
  { id: 'marimba', name: 'Marimba knock', hint: 'Warm wooden note', seconds: 0.4, make: c => {
    tone(c, { f: 523, dur: 0.3, gain: 0.55, attack: 0.001 }); tone(c, { f: 2093, dur: 0.06, gain: 0.15, attack: 0.001 }) } },
  { id: 'zap', name: 'Laser zap', hint: 'Falling sci-fi blast', seconds: 0.25, make: c => {
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4000; lp.connect(c.destination)
    tone(c, { type: 'sawtooth', f: 1800, to: 150, dur: 0.2, gain: 0.3, attack: 0.001 }, lp) } },
  { id: 'thunk', name: 'Heavy thunk', hint: 'Deep punchy impact', seconds: 0.3, make: c => {
    tone(c, { f: 140, to: 50, sweep: 0.18, dur: 0.25, gain: 0.8, attack: 0.001 }); noise(c, { dur: 0.025, filter: 'lowpass', f: 900, gain: 0.6 }) } },
  { id: 'ping', name: 'Sonar ping', hint: 'Soft long ping', seconds: 1.3, make: c => {
    tone(c, { f: 1318.5, dur: 1.2, gain: 0.45, attack: 0.012 }) } },
  { id: 'crit', name: 'Critical ding', hint: 'Sharp headshot ding', seconds: 0.5, make: c => {
    noise(c, { dur: 0.006, filter: 'highpass', f: 3000, gain: 0.4 }); tone(c, { type: 'square', f: 1319, dur: 0.05, gain: 0.12, attack: 0.001 }); tone(c, { f: 2637, at: 0.01, dur: 0.4, gain: 0.4, attack: 0.001 }) } },
]

/** The silence before a recording's first sound cut away (2 ms kept), so it plays the moment the game asks. */
function trimStart(b: AudioBuffer): AudioBuffer {
  const chans = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
  let at = 0
  while (at < b.length && chans.every(d => Math.abs(d[at]) < 0.003)) at++ // -50 dBFS
  at = Math.max(0, at - Math.round(b.sampleRate * 0.002))
  if (at === 0 || at >= b.length) return b
  const out = new AudioBuffer({ numberOfChannels: b.numberOfChannels, length: b.length - at, sampleRate: b.sampleRate })
  chans.forEach((d, c) => out.copyToChannel(d.subarray(at), c))
  return out
}

/** How loud it sounds: the RMS of its loudest 50 ms (all channels), so a short hit and a long tone compare fairly. */
export function loudness(b: AudioBuffer): number {
  const chans = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
  const w = Math.min(b.length, Math.round(b.sampleRate * 0.05))
  let best = 0
  for (let s = 0; ; s += Math.max(1, w >> 1)) {
    const end = Math.min(s + w, b.length)
    let e = 0
    for (const d of chans) for (let i = s; i < end; i++) e += d[i] * d[i]
    best = Math.max(best, Math.sqrt(e / Math.max(1, (end - s) * chans.length)))
    if (end >= b.length) break
  }
  return best
}

const CEILING = 0.89 // -1 dBFS
const MAX_SQUASH = 0.25 // the limiter takes peaks down 12 dB at most: past that a click turns into a buzz (18 dB gained under 1 dB)

/** `b` times `gain` through a peak limiter: 3 ms look-ahead, 60 ms release, never above the ceiling. Returns the copy and
 *  the deepest gain the limiter applied (1 when it did nothing). */
function boost(b: AudioBuffer, gain: number): { out: AudioBuffer; squash: number } {
  const n = b.length, sr = b.sampleRate, chans = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
  const need = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let pk = 0
    for (const d of chans) pk = Math.max(pk, Math.abs(d[i] * gain))
    need[i] = pk > CEILING ? CEILING / pk : 1
  }
  const ahead = Math.round(sr * 0.003), rel = Math.exp(-1 / (sr * 0.06))
  const env = new Float32Array(n)
  let g = 1, squash = 1
  for (let i = n - 1; i >= 0; i--) { // the lowest need over the next 3 ms, so the gain is down before the peak arrives
    let m = need[i]
    for (let j = i + 1; j <= Math.min(n - 1, i + ahead); j++) m = Math.min(m, need[j])
    env[i] = m
  }
  const out = new AudioBuffer({ numberOfChannels: chans.length, length: n, sampleRate: sr })
  const outs = chans.map(() => new Float32Array(n))
  for (let i = 0; i < n; i++) {
    g = env[i] < g ? env[i] : env[i] + (g - env[i]) * rel // instant down, slow back up
    squash = Math.min(squash, g)
    chans.forEach((d, c) => { outs[c][i] = Math.max(-CEILING, Math.min(CEILING, d[i] * gain * g)) })
  }
  outs.forEach((d, c) => out.copyToChannel(d, c))
  return { out, squash }
}

/** `b` brought up (or down) to `target` loudness, peaks held at -1 dBFS. A sound that would need its peaks taken down
 *  more than 12 dB stops there, a little quieter than the target. */
function match(b: AudioBuffer, target: number): AudioBuffer {
  const now = loudness(b)
  if (!now) return b
  let lo = 0, hi = (target / now) * 8, best = boost(b, target / now)
  if (best.squash >= MAX_SQUASH && Math.abs(loudness(best.out) - target) < target * 0.01) return best.out
  for (let k = 0; k < 24; k++) { // the gain that lands on the target after limiting, within the squash allowance
    const mid = (lo + hi) / 2, t = boost(b, mid)
    if (t.squash < MAX_SQUASH || loudness(t.out) > target) hi = mid; else { lo = mid; best = t }
  }
  return best.out
}

/** A preset as it was made: a recording from its first sound on, a recipe rendered in mono. */
async function raw(p: Preset): Promise<AudioBuffer> {
  if ('file' in p) {
    const bytes = await (await fetch(p.file)).arrayBuffer()
    const ctx = new AudioContext({ sampleRate: 48000 })
    return trimStart(await ctx.decodeAudioData(bytes).finally(() => void ctx.close()))
  }
  const c = new OfflineAudioContext(1, Math.ceil(p.seconds * 48000), 48000)
  p.make(c)
  return c.startRendering()
}

/** The loudest built-in sound's loudness, which every other one is brought to (read once). */
let loudest: Promise<number> | null = null
const target = () => loudest ??= Promise.all(PRESETS.map(async p => loudness(await raw(p)))).then(l => Math.min(Math.max(...l), CEILING))

/** A preset as audio at 48 kHz, as loud as the loudest built-in sound. */
export async function renderPreset(p: Preset): Promise<AudioBuffer> {
  const [b, t] = await Promise.all([raw(p), target()])
  return match(b, t)
}
