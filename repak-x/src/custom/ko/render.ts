// repakxtra: draws a KO prompt (model.ts) on a canvas at any moment of its animations: the game's layout (canvas, overlay
// and scale box slots), render transforms, opacity, flipbook frames and color tints, as UMG would. Approximate where the
// game uses its own materials (the text gradient, unmultiplied flipbooks): close enough to judge colors by, not a capture.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { type Animation, type KoWidget, type Layer, type Material, type Rgba, evaluate, linearOf, runtimeColor, siteKey } from './model'

export type Rect = { x: number; y: number; w: number; h: number }
export type Images = Map<string, CanvasImageSource & { width: number; height: number }> // by texture package path
export type Scene = { w: KoWidget; materials: Map<string, Material>; images: Images; frame: Rect; core: Rect; phases: Phase[] }
export type Phase = { label: string; anim: Animation | null; start: number; length: number; loop?: boolean }
export const KILL_WORDS: Record<number, string> = { 2: 'DOUBLE!', 3: 'TRIPLE!', 4: 'QUAD!', 5: 'PENTA!', 6: 'HEXA!' }

const sec = (a: Animation) => a.length / a.tick
const find = (w: KoWidget, re: RegExp) => w.animations.find(a => re.test(a.name)) ?? null

/** Fade in, the loop twice, fade out: how the prompt plays after a kill. */
export function phasesOf(w: KoWidget): Phase[] {
  const parts: [string, Animation | null, number][] = [['Fade in', find(w, /fadein/i), 1], ['Loop', find(w, /^anim_loop/i), 2], ['Fade out', find(w, /fadeout/i), 1]]
  let at = 0
  return parts.map(([label, anim, times]) => {
    const length = anim ? sec(anim) * times : 0.5
    const p = { label, anim, start: at, length, loop: times > 1 }
    at += length
    return p
  })
}
export const duration = (s: Scene) => s.phases.reduce((n, p) => n + p.length, 0)

type State = { opacity: Map<string, number>; tx: Map<string, Record<string, number>>; params: Map<string, Record<string, number>> }
/** Every bound value at `t` seconds: each phase before t at its end, the current one at t. */
function stateAt(s: Scene, t: number): State {
  const st: State = { opacity: new Map(), tx: new Map(), params: new Map() }
  for (const p of s.phases) {
    if (!p.anim || t < p.start) break
    const local = Math.min(t - p.start, p.length - 1e-6)
    const at = (p.loop ? local % sec(p.anim) : local) * p.anim.tick
    for (const tr of p.anim.tracks) {
      if (tr.kind === 'float' && tr.property === 'RenderOpacity') { const v = evaluate(tr.curve, at); if (v !== null) st.opacity.set(tr.widget, v) }
      else if (tr.kind === 'transform') {
        const o = st.tx.get(tr.widget) ?? {}
        const bits: [number, string][] = [[1, 'Translation'], [2, 'Translation#1'], [4, 'Rotation'], [8, 'Scale'], [16, 'Scale#1'], [32, 'Shear'], [64, 'Shear#1']]
        for (const [b, k] of bits) if (tr.mask & b) { const v = evaluate(tr.ch[k], at); if (v !== null) o[k] = v }
        st.tx.set(tr.widget, o)
      } else if (tr.kind === 'material') {
        const o = st.params.get(tr.widget) ?? {}
        for (const [k, c] of Object.entries(tr.params)) { const v = evaluate(c, at); if (v !== null) o[k] = v }
        st.params.set(tr.widget, o)
      }
    }
  }
  return st
}

const v2 = (v: any, d: number) => ({ x: v?.X ?? d, y: v?.Y ?? d })
/** A panel's children back to front: a canvas panel's by their slots' ZOrder, in slot order within one. */
const ordered = (w: KoWidget, l: Layer) => l.children
  .map((c, i) => { const k = w.layers.get(c); return { c, z: k?.slot.LayoutData ? Number(k.slot.ZOrder ?? 0) : 0, i } })
  .sort((a, b) => a.z - b.z || a.i - b.i).map(x => x.c)
/** A KO prompt's text size: the size its blocks set (the rich text's own styles are in another file), 50 when none does. */
const textSize = (w: KoWidget) => Math.max(0, ...[...w.layers.values()].filter(l => l.kind === 'text').map(l => Number(l.props.DefaultTextStyleOverride?.Font?.Size ?? 0))) || 50
/** A loadout card's KO video loops on this beat (seconds), longer than any one recording, so every card starts together */
export const KO_BEAT = 3.5
export const KO_FONT = 'Refrigerator KO' // ko.css: the game's kill text face, Refrigerator Deluxe Heavy
const TEXT_FONT = (size: number) => `${size}px "${KO_FONT}", Geist, sans-serif`
const TEXT_SQUEEZE = 1 // the face is narrow itself
let measure: CanvasRenderingContext2D | null = null
/** The text's size as drawn: what a scale box fits. */
function textBox(word: string, size: number) {
  measure ??= typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
  if (!measure) return { x: size * 2.6, y: size }
  measure.font = TEXT_FONT(size)
  const m = measure.measureText(word)
  return { x: m.width * TEXT_SQUEEZE + size * 0.25, y: (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) * 1.15 }
}
function desired(w: KoWidget, l: Layer, word: string): { x: number; y: number } {
  if (l.kind === 'image') return v2(l.props.Brush?.ImageSize, 32)
  if (l.kind === 'text') return textBox(word, textSize(w))
  const kids = l.children.map(c => w.layers.get(c)).filter(Boolean) as Layer[]
  if (/canvas/i.test(l.name)) return { x: 0, y: 0 }
  return kids.reduce((m, k) => { const d = desired(w, k, word); return { x: Math.max(m.x, d.x), y: Math.max(m.y, d.y) } }, { x: 0, y: 0 })
}

/** Each layer's box in the root's space, before render transforms. */
export function layout(w: KoWidget, root: Rect, word = KILL_WORDS[4]): Map<string, Rect> {
  const out = new Map<string, Rect>()
  const place = (name: string, r: Rect) => {
    out.set(name, r)
    const l = w.layers.get(name)
    if (!l) return
    for (const c of ordered(w, l)) {
      const k = w.layers.get(c)
      if (!k) continue
      const s = k.slot, d = desired(w, k, word)
      if (k.slotKind === 'CanvasPanelSlot') {
        const L = s.LayoutData ?? {}, off = L.Offsets ?? {}, an = L.Anchors ?? {}
        const mn = v2(an.Minimum, 0), mx = v2(an.Maximum, 0), al = v2(L.Alignment, 0)
        const [left, top, right, bottom] = [off.Left ?? 0, off.Top ?? 0, off.Right ?? 100, off.Bottom ?? 30]
        const auto = Boolean(s.bAutoSize)
        const ax = (x0: number, x1: number, a: number, m: number, M: number, lo: number, hi: number, dd: number) => {
          if (m !== M) { const s0 = x0 + (x1 - x0) * m + lo; return [s0, x0 + (x1 - x0) * M - hi - s0] }
          const size = auto ? dd : hi
          return [x0 + (x1 - x0) * m + lo - a * size, size]
        }
        const [x, ww] = ax(r.x, r.x + r.w, al.x, mn.x, mx.x, left, right, d.x)
        const [y, hh] = ax(r.y, r.y + r.h, al.y, mn.y, mx.y, top, bottom, d.y)
        place(c, { x, y, w: ww, h: hh })
      } else if (k.slotKind === 'OverlaySlot' || k.slotKind === 'ScaleBoxSlot') {
        const pad = s.Padding ?? {}, inner = { x: r.x + (pad.Left ?? 0), y: r.y + (pad.Top ?? 0), w: r.w - (pad.Left ?? 0) - (pad.Right ?? 0), h: r.h - (pad.Top ?? 0) - (pad.Bottom ?? 0) }
        if (k.slotKind === 'ScaleBoxSlot') { const f = Math.min(inner.w / (d.x || 1), inner.h / (d.y || 1)); place(c, { x: inner.x + (inner.w - d.x * f) / 2, y: inner.y + (inner.h - d.y * f) / 2, w: d.x * f, h: d.y * f }); continue }
        const h = String(s.HorizontalAlignment ?? 'Fill'), v = String(s.VerticalAlignment ?? 'Fill')
        // a child larger than its slot is shrunk to it, as Slate arranges an overlay (the 300 px logo in a 264 px holder)
        const ax = (a: string, o: number, size: number, want: number) => {
          const dd = Math.min(want, size)
          return /Fill/.test(a) ? [o, size] : /Left|Top/.test(a) ? [o, dd] : /Right|Bottom/.test(a) ? [o + size - dd, dd] : [o + (size - dd) / 2, dd]
        }
        const [x, ww] = ax(h, inner.x, inner.w, d.x), [y, hh] = ax(v, inner.y, inner.h, d.y)
        place(c, { x, y, w: ww, h: hh })
      } else place(c, r)
    }
  }
  place(w.root, root)
  return out
}

const ROOT: Rect = { x: 0, y: 0, w: 1920, h: 1080 }
/** The scene and the part of the root worth showing: the icon, the text and the bars, not the full-screen effects. */
export function makeScene(w: KoWidget, materials: Map<string, Material>, images: Images): Scene {
  const boxes = layout(w, ROOT)
  const keep = [...w.layers.values()].filter(l => l.kind !== 'panel' && /icon|angle|text|loop_0|line/i.test(l.name)).map(l => boxes.get(l.name)!).filter(Boolean)
  const all = keep.length ? keep : [...boxes.values()]
  // the icon and the kill text: what a portrait loadout card shows, and what the stage centers on
  const core = union([...w.layers.values()].filter(l => /^(overlay_icon|scalebox)/i.test(l.name)).map(l => boxes.get(l.name)!).filter(Boolean)) ?? union(all)!
  // the prompt sits against the screen's right edge, the root's: what lies past it is off screen in the game too. The
  // banner's far tail is left out so the prompt shows large
  const x0 = Math.max(Math.min(...all.map(r => r.x)), core.x - core.w * 1.6), y0 = Math.min(...all.map(r => r.y)), x1 = Math.min(ROOT.w, Math.max(...all.map(r => r.x + r.w))), y1 = Math.max(...all.map(r => r.y + r.h))
  const padX = (x1 - x0) * 0.06, padY = (y1 - y0) * 0.2
  return { w, materials, images, core, frame: { x: x0 - padX, y: y0 - padY, w: x1 - x0 + padX * 1.6, h: y1 - y0 + padY * 2 }, phases: phasesOf(w) }
}

const union = (rs: Rect[]): Rect | null => {
  if (!rs.length) return null
  const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y))
  return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y }
}
/** `core` grown to the aspect of `size`, around its center: the frame for a picture of another shape than the stage. */
export function frameFor(core: Rect, size: { w: number; h: number }, margin = 1.15): Rect {
  const a = size.w / size.h
  let w = core.w * margin, h = core.h * margin
  if (w / h > a) h = w / a; else w = h * a
  // flush with the screen's right edge: nothing past it is ever seen in the game
  const x = Math.min(core.x + core.w / 2 - w / 2, ROOT.w - w)
  return { x, y: core.y + core.h / 2 - h / 2, w, h }
}

export type DrawOptions = { kills: number; colors: Map<string, string>; focus?: string[]; background?: boolean; frame?: Rect; checker?: boolean; ground?: string }
const srgb = (c: number) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)))

const grounds: Partial<Record<'black' | 'white', CanvasRenderingContext2D>> = {}
/** Draws the prompt with a transparent background (a loadout card's video). Additive layers need something under them,
 *  so it is drawn over black and over white and the transparency read from the difference: a pixel the same on both is
 *  solid, one that only shows over black (a glow) gets its brightness as its opacity. Exact over black. */
export function drawClear(ctx: CanvasRenderingContext2D, s: Scene, t: number, size: { w: number; h: number }, o: DrawOptions) {
  const read = (ground: 'black' | 'white') => {
    let g = grounds[ground]
    if (!g || g.canvas.width !== size.w || g.canvas.height !== size.h) {
      const c = document.createElement('canvas'); c.width = size.w; c.height = size.h
      g = grounds[ground] = c.getContext('2d', { willReadFrequently: true })!
    }
    draw(g, s, t, size, { ...o, checker: false, ground })
    return g.getImageData(0, 0, size.w, size.h).data
  }
  const b = read('black'), w = read('white')
  const out = ctx.createImageData(size.w, size.h), px = out.data
  for (let i = 0; i < px.length; i += 4) {
    const a = 255 - Math.min(w[i] - b[i], w[i + 1] - b[i + 1], w[i + 2] - b[i + 2])
    if (a <= 0) continue
    const k = 255 / a
    px[i] = Math.min(255, b[i] * k); px[i + 1] = Math.min(255, b[i + 1] * k); px[i + 2] = Math.min(255, b[i + 2] * k); px[i + 3] = a
  }
  ctx.putImageData(out, 0, 0)
}

/** Draws the prompt at `t` seconds into `ctx` (canvas pixels), fit to `size`. `colors`: role id to hex, the edits. */
export function draw(ctx: CanvasRenderingContext2D, s: Scene, t: number, size: { w: number; h: number }, o: DrawOptions) {
  const { w } = s
  const st = stateAt(s, t)
  const kill = Math.min(6, Math.max(2, o.kills)) - 2
  const boxes = layout(w, ROOT, KILL_WORDS[kill + 2])
  // a color as edited: a role's site matched by widget and property path
  const siteRole = new Map<string, string>()
  for (const r of w.roles) for (const site of r.sites) siteRole.set(siteKey(site.widget, site.path), r.id)
  const roleOf = new Map(w.roles.map(r => [r.id, r]))
  // the hovered role's layers: its widgets, and the text when it holds the text's colors (they live on the class)
  const focusRoles = o.focus?.length ? w.roles.filter(r => o.focus!.includes(r.id)) : []
  const focusSet = focusRoles.length ? new Set(focusRoles.flatMap(r => [...r.widgets,
    ...(r.sites.some(x => !x.widget && /^Font/.test(x.prop)) ? [...w.layers.values()].filter(l => l.kind === 'text').map(l => l.name) : [])])) : null
  const color = (widget: string, path: string, base: Rgba | undefined): Rgba => {
    // a SlateColor holds its color one level down (Brush.TintColor.SpecifiedColor): never read its alpha off the wrapper
    const def: Rgba = (base as any)?.SpecifiedColor ?? base ?? { R: 1, G: 1, B: 1, A: 1 }
    const id = siteRole.get(`${widget}|${path}`), hex = id ? o.colors.get(id) : undefined
    // a placeholder folded into Main or Highlight shows that role's color, as the game draws it
    const role = id ? roleOf.get(id) : undefined
    const [R, G, B] = hex ? linearOf(hex) : role ? [role.rgba.R, role.rgba.G, role.rgba.B] : [def.R, def.G, def.B]
    return { R, G, B, A: def.A }
  }
  const frame = o.frame ?? s.frame
  const fit = Math.min(size.w / frame.w, size.h / frame.h)
  ctx.save()
  ctx.clearRect(0, 0, size.w, size.h)
  // the backdrop is painted, not left transparent: additive layers need something under them (and a saved frame keeps it)
  if (o.ground) { ctx.fillStyle = o.ground; ctx.fillRect(0, 0, size.w, size.h) } // one flat color (drawClear)
  else if (o.background !== false) {
    // the editor's grid sits on one flat color (cable, 2026-11-01: no glow behind it); other uses keep the soft light
    const g = o.checker ? '#0b0b0b' : ctx.createRadialGradient(size.w * 0.38, size.h * 0.4, 0, size.w * 0.38, size.h * 0.4, Math.max(size.w, size.h) * 0.75)
    if (typeof g !== 'string') { g.addColorStop(0, '#0e0e0e'); g.addColorStop(0.55, '#080808'); g.addColorStop(1, '#030303') }
    ctx.fillStyle = g; ctx.fillRect(0, 0, size.w, size.h)
    // the editor's stage: a dark line grid behind the prompt, a design canvas's ground
    if (o.checker) {
      const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, cell = 24 * dpr, line = Math.max(1, Math.round(dpr))
      ctx.fillStyle = 'rgba(255, 255, 255, 0.045)'
      for (let x = cell; x < size.w; x += cell) ctx.fillRect(Math.round(x), 0, line, size.h)
      for (let y = cell; y < size.h; y += cell) ctx.fillRect(0, Math.round(y), size.w, line)
    }
  }
  ctx.translate((size.w - frame.w * fit) / 2, (size.h - frame.h * fit) / 2)
  ctx.scale(fit, fit)
  ctx.translate(-frame.x, -frame.y)
  ctx.beginPath(); ctx.rect(frame.x, frame.y, Math.min(frame.w, ROOT.w - frame.x), frame.h); ctx.clip()

  const swap: Record<string, any> = { Img_Kill_Angle: w.defaults.AngleTextures?.[kill], Img_Kill_Angle_Glow: w.defaults.AngleGlowTextures?.[kill], Img_Kill_Burst_Vx: w.defaults.AngleVXMaterials?.[kill] }

  const visit = (name: string, alpha: number) => {
    const l = w.layers.get(name), r = boxes.get(name)
    if (!l || !r) return
    if (/Collapsed|Hidden/.test(String(l.props.Visibility ?? ''))) return
    const op = alpha * (st.opacity.get(name) ?? l.props.RenderOpacity ?? 1)
    if (op <= 0.001) return
    ctx.save()
    const base = l.props.RenderTransform ?? {}, tx = st.tx.get(name) ?? {}
    const g = (k: string, b: number) => tx[k] ?? b
    const piv = v2(l.props.RenderTransformPivot, 0.5)
    const px = r.x + r.w * piv.x, py = r.y + r.h * piv.y
    ctx.translate(px + g('Translation', base.Translation?.X ?? 0), py + g('Translation#1', base.Translation?.Y ?? 0))
    ctx.rotate((g('Rotation', base.Angle ?? 0) * Math.PI) / 180)
    const shx = g('Shear', base.Shear?.X ?? 0), shy = g('Shear#1', base.Shear?.Y ?? 0)
    if (shx || shy) ctx.transform(1, Math.tan((shy * Math.PI) / 180), Math.tan((shx * Math.PI) / 180), 1, 0, 0)
    ctx.scale(g('Scale', base.Scale?.X ?? 1), g('Scale#1', base.Scale?.Y ?? 1))
    ctx.translate(-px, -py)
    const dim = focusSet && l.kind !== 'panel' && !focusSet.has(name) ? 0.05 : 1 // the rest nearly gone while a row is hovered
    if (l.kind === 'image') drawImage(ctx, s, l, r, op * dim, st.params.get(name), swap[name], color)
    else if (l.kind === 'text') drawText(ctx, w, l, r, op * dim, KILL_WORDS[kill + 2], color)
    else for (const c of ordered(w, l)) visit(c, op)
    ctx.restore()
  }
  visit(w.root, 1)
  ctx.restore()
}

const opaqueCache = new WeakMap<object, boolean>()
/** Whether an image has no transparent pixels (sampled small, once). */
function opaque(img: CanvasImageSource & { width: number; height: number }) {
  let v = opaqueCache.get(img)
  if (v === undefined) {
    const c = document.createElement('canvas'); c.width = 32; c.height = 32
    const x = c.getContext('2d', { willReadFrequently: true })!
    x.drawImage(img, 0, 0, 32, 32)
    const d = x.getImageData(0, 0, 32, 32).data
    v = true
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { v = false; break }
    opaqueCache.set(img, v)
  }
  return v
}

const scratch = typeof document !== 'undefined' ? document.createElement('canvas') : null
function drawImage(ctx: CanvasRenderingContext2D, s: Scene, l: Layer, r: Rect, op: number, params: Record<string, number> | undefined,
  swapRef: number | undefined, color: (w: string, p: string, b: Rgba | undefined) => Rgba) {
  const ref = swapRef ? s.w.resolve(swapRef) : l.brush
  if (!ref || !scratch) return
  const mat = s.materials.get(ref.path)
  const img = s.images.get(mat ? mat.texture ?? '' : ref.path)
  if (!img) return
  // the game paints these layers with Main or Highlight at runtime, whatever the file keeps there
  const rt = s.w.defaults.bOverrideColor ? runtimeColor(l.name) : null
  const c1 = rt ? { ...color('', rt, s.w.defaults[rt]), A: 1 } : color(l.name, 'ColorAndOpacity', l.props.ColorAndOpacity), c2 = color(l.name, 'Brush.TintColor.SpecifiedColor', l.props.Brush?.TintColor?.SpecifiedColor)
  const tint = { R: c1.R * c2.R, G: c1.G * c2.G, B: c1.B * c2.B, A: c1.A * c2.A }
  if (op * tint.A <= 0.001 && !/unmult/i.test(mat?.parent ?? '')) return
  // the flipbook frame: of the picture, or of its mask when the material has one (the picture then shows whole)
  const frame = (w: number, h: number) => {
    if (!mat || (mat.rows <= 1 && mat.cols <= 1)) return [0, 0, w, h]
    const n = mat.rows * mat.cols, p = params?.Anim_Percent ?? mat.scalars.Anim_Percent ?? 0
    const f = Math.min(n - 1, Math.max(0, Math.floor(p * n)))
    const fw = w / mat.cols, fh = h / mat.rows
    return [(f % mat.cols) * fw, Math.floor(f / mat.cols) * fh, fw, fh]
  }
  const mask = mat?.mask ? s.images.get(mat.mask) : undefined
  const [sx, sy, sw, sh] = mask ? [0, 0, img.width, img.height] : frame(img.width, img.height)
  const W = Math.max(1, Math.round(Math.min(sw, 1024))), H = Math.max(1, Math.round(sh * (W / sw)))
  if (scratch.width !== W || scratch.height !== H) { scratch.width = W; scratch.height = H }
  const sc = scratch.getContext('2d')!
  // the shape: the textures are white, their alpha is the shape (a mask cuts it further)
  sc.globalAlpha = 1; sc.globalCompositeOperation = 'copy'; sc.drawImage(img, sx, sy, sw, sh, 0, 0, W, H)
  if (mask) { const [mx, my, mw, mh] = frame(mask.width, mask.height); sc.globalCompositeOperation = 'destination-in'; sc.drawImage(mask, mx, my, mw, mh, 0, 0, W, H) }
  // tint: multiply (a sheet with its own colors keeps them), then cut back to the shape
  const paint = (rgb: string) => {
    sc.globalCompositeOperation = 'multiply'; sc.fillStyle = rgb; sc.fillRect(0, 0, W, H)
    sc.globalCompositeOperation = 'destination-in'; sc.drawImage(img, sx, sy, sw, sh, 0, 0, W, H)
    if (mask) { const [mx, my, mw, mh] = frame(mask.width, mask.height); sc.drawImage(mask, mx, my, mw, mh, 0, 0, W, H) }
  }
  const rgb = `rgb(${srgb(tint.R)},${srgb(tint.G)},${srgb(tint.B)})`
  const parent = mat?.parent ?? ''
  // (a sheet with no transparency of its own keys its black out instead: additive, below)
  if (/unmult/i.test(parent) && !opaque(img) && !/^Img_Vx02_/i.test(l.name)) {
    // premultiplied ("unmultiplied") blending: what is under is dimmed by the tint's alpha, then the tint is added at
    // full strength. A 10% white over the bar adds its color and barely dims: the bar's lighter inner band
    paint('#000'); ctx.globalAlpha = Math.min(1, op * tint.A); ctx.drawImage(scratch, 0, 0, W, H, r.x, r.y, r.w, r.h)
    sc.globalCompositeOperation = 'copy'; sc.drawImage(img, sx, sy, sw, sh, 0, 0, W, H)
    if (mask) { const [mx, my, mw, mh] = frame(mask.width, mask.height); sc.globalCompositeOperation = 'destination-in'; sc.drawImage(mask, mx, my, mw, mh, 0, 0, W, H) }
    paint(rgb); ctx.globalAlpha = Math.min(1, op); ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(scratch, 0, 0, W, H, r.x, r.y, r.w, r.h)
  } else {
    paint(rgb)
    ctx.globalAlpha = Math.min(1, op * tint.A)
    // additive materials, sheets with no transparency of their own, and the front slash: a light layer over the rest
    // (its look in the game, the linear dodge of the top effect layer)
    ctx.globalCompositeOperation = /add/i.test(parent) || /_add$/i.test(ref.path) || opaque(img) || /^Img_Vx02_/i.test(l.name) ? 'lighter' : 'source-over'
    ctx.drawImage(scratch, 0, 0, W, H, r.x, r.y, r.w, r.h)
  }
  ctx.globalCompositeOperation = 'source-over'
}

function drawText(ctx: CanvasRenderingContext2D, w: KoWidget, l: Layer, r: Rect, op: number, word: string,
  color: (w: string, p: string, b: Rgba | undefined) => Rgba) {
  const size = textSize(w), box = textBox(word, size), k = r.h / box.y || 1 // the scale box's fit
  const flat = Boolean(l.props.DefaultTextStyleOverride?.ColorAndOpacity) // the flash copy is plain white
  ctx.globalAlpha = Math.min(1, op)
  ctx.font = TEXT_FONT(size)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.save()
  ctx.translate(r.x + r.w / 2, r.y + r.h / 2); ctx.scale(k, k)
  ctx.transform(TEXT_SQUEEZE, 0, -(l.props.DefaultTextStyleOverride?.Font?.SkewAmount ?? 0.2), 1, 0, 0)
  const rgb = (c: Rgba) => `rgb(${srgb(c.R)},${srgb(c.G)},${srgb(c.B)})`
  if (flat) ctx.fillStyle = rgb(color(l.name, 'DefaultTextStyleOverride.ColorAndOpacity.SpecifiedColor', l.props.DefaultTextStyleOverride.ColorAndOpacity))
  else {
    // the game's gradient: FontTopColor at the top, FontButtomColor at the bottom (bOverrideFontColor, every hero)
    const gr = ctx.createLinearGradient(0, -size / 2, 0, size / 2)
    gr.addColorStop(0, rgb(color('', 'FontTopColor', w.defaults.FontTopColor)))
    gr.addColorStop(1, rgb(color('', 'FontButtomColor', w.defaults.FontButtomColor)))
    ctx.fillStyle = gr
  }
  ctx.fillText(word, 0, 0)
  ctx.restore()
}
