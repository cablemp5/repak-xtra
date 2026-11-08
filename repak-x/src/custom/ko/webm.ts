// repakxtra: a minimal WebM writer for KO prompt clips (record.ts). WebCodecs here cannot encode alpha, so the color and
// the alpha (as gray) come from two VP8 encoders, and each frame's alpha rides in its BlockAdditions (BlockAddID 1) with
// AlphaMode 1 on the track: the layout Chromium's own MediaRecorder writes, which its <video> plays with transparency.

export type Frame = { ms: number; key: boolean; color: Uint8Array; alpha: Uint8Array }

/** An EBML size: the shortest vint that holds n (all ones is reserved for "unknown"). */
export const vint = (n: number) => {
  let len = 1
  while (n >= 2 ** (7 * len) - 1) len++
  const out = new Uint8Array(len)
  for (let i = len - 1, v = n; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v & 0xff
  out[0] |= 1 << (8 - len)
  return out
}
const cat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
const el = (id: number, ...body: Uint8Array[]) => {
  const data = cat(body), idBytes: number[] = []
  for (let v = id; v > 0; v = Math.floor(v / 256)) idBytes.unshift(v & 0xff)
  return cat([new Uint8Array(idBytes), vint(data.length), data])
}
const uint = (id: number, n: number) => {
  const b: number[] = []
  for (let v = n; b.length === 0 || v > 0; v = Math.floor(v / 256)) b.unshift(v & 0xff)
  return el(id, new Uint8Array(b))
}
const int16 = (n: number) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]) // two's complement, big-endian
const float = (id: number, v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return el(id, b) }
const str = (id: number, s: string) => el(id, new TextEncoder().encode(s))

/** The whole file. Each keyframe opens a cluster (block times are 16-bit offsets from it); a delta frame names the
 *  frame before it as its reference. */
export function muxWebm(frames: Frame[], width: number, height: number, durationMs: number): Uint8Array<ArrayBuffer> {
  const header = el(0x1a45dfa3, uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2))
  const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000), str(0x4d80, 'repakxtra'), str(0x5741, 'repakxtra'), float(0x4489, durationMs))
  const tracks = el(0x1654ae6b, el(0xae, uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), str(0x86, 'V_VP8'), uint(0x55ee, 1),
    el(0xe0, uint(0xb0, width), uint(0xba, height), uint(0x53c0, 1))))
  const clusters: Uint8Array[] = []
  let blocks: Uint8Array[] = [], start = 0
  const close = () => { if (blocks.length) clusters.push(el(0x1f43b675, uint(0xe7, start), ...blocks)); blocks = [] }
  frames.forEach((f, i) => {
    if (f.key || f.ms - start > 30000) { close(); start = f.ms }
    const block = el(0xa1, new Uint8Array([0x81]), int16(f.ms - start), new Uint8Array([0]), f.color)
    const more = el(0x75a1, el(0xa6, uint(0xee, 1), el(0xa5, f.alpha)))
    const ref = f.key || i === 0 ? [] : [el(0xfb, int16(frames[i - 1].ms - f.ms))]
    const last = i === frames.length - 1 ? [uint(0x9b, Math.max(1, durationMs - f.ms))] : []
    blocks.push(el(0xa0, block, more, ...ref, ...last))
  })
  close()
  return cat([header, el(0x18538067, info, tracks, ...clusters)])
}

if (import.meta.env.DEV) {
  const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  console.assert(hex(vint(0)) === '80' && hex(vint(126)) === 'fe' && hex(vint(127)) === '407f' && hex(vint(300)) === '412c', 'webm vint')
  console.assert(hex(uint(0xd7, 1)) === 'd78101' && hex(uint(0x2ad7b1, 1_000_000)) === '2ad7b1830f4240', 'webm uint')
  console.assert(hex(int16(-17)) === 'ffef', 'webm int16')
  const one = { color: new Uint8Array([1]), alpha: new Uint8Array([2]) }
  const file = hex(muxWebm([{ ms: 0, key: true, ...one }, { ms: 17, key: false, ...one }, { ms: 1000, key: true, ...one }], 2, 2, 1017))
  console.assert(file.startsWith('1a45dfa3') && (file.match(/1f43b675/g) ?? []).length === 2 && file.includes('fb82ffef') && file.includes('53c08101'), 'webm layout')
}
