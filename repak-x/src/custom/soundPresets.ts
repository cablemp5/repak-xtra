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
  { id: 'osu-hit', name: 'osu hit', hint: 'Crisp rhythm-game hit', file: osuHit },
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

/** A preset as audio at 48 kHz: a recording as it was made, a recipe in mono with its peak set to -1 dBFS. */
export async function renderPreset(p: Preset): Promise<AudioBuffer> {
  if ('file' in p) {
    const bytes = await (await fetch(p.file)).arrayBuffer()
    const ctx = new AudioContext({ sampleRate: 48000 })
    return ctx.decodeAudioData(bytes).finally(() => void ctx.close())
  }
  const c = new OfflineAudioContext(1, Math.ceil(p.seconds * 48000), 48000)
  p.make(c)
  const out = await c.startRendering()
  const d = out.getChannelData(0)
  let peak = 0
  for (const v of d) peak = Math.max(peak, Math.abs(v))
  if (peak > 0) { const k = 0.89 / peak; for (let i = 0; i < d.length; i++) d[i] *= k }
  return out
}
