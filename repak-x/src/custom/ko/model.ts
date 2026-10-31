// repakxtra: the KO Editor's reading of a KO prompt widget (WBP_Battle_Kill_<hero>_V<n>) from UAssetTool's full JSON, the
// same file the export edits and converts back. Nothing about a hero is written here: the layers, the color roles and the
// animations all come from the game's own file, so a patch that changes the prompt changes the editor with it.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Prop = { $type: string; Name: string; ArrayIndex?: number; Value: any; StructType?: string }
export type Asset = { Imports: { ObjectName: string; OuterIndex: number; ClassName: string }[]; Exports: { ObjectName: string; ClassIndex: number; OuterIndex: number; Data: Prop[] }[] }
export type Rgba = { R: number; G: number; B: number; A: number }
export type Channel = { times: number[]; values: number[]; arrive: number[]; leave: number[]; interp: string[]; def: number | null; tick: number }

const num = (v: any) => (typeof v === 'number' ? v : Number(v) || 0)
const leaf = (t: string) => !/StructPropertyData|ArrayPropertyData/.test(t)

/** A property list as a plain object. A struct holding one value of its own name (a color, a vector, a curve) is that
 *  value. A static array (Translation X and Y) keeps its slots as name, name#1. */
export function props(list: Prop[] | undefined): Record<string, any> {
  const o: Record<string, any> = {}
  for (const p of list ?? []) o[p.ArrayIndex ? `${p.Name}#${p.ArrayIndex}` : p.Name] = value(p)
  return o
}
function value(p: Prop): any {
  if (p.$type.includes('ArrayPropertyData')) return (p.Value ?? []).map(value)
  if (p.$type.includes('StructPropertyData')) {
    const v = p.Value as Prop[]
    if (v?.length === 1 && v[0].Name === p.Name && leaf(v[0].$type)) return value(v[0])
    return props(v)
  }
  if (p.$type.includes('MovieSceneFloatChannelPropertyData')) return channel(p.Value)
  return p.Value
}
function channel(c: any): Channel {
  const vals = c?.Values ?? []
  return {
    times: (c?.Times ?? []).map((t: any) => num(t.Value)), values: vals.map((v: any) => num(v.Value)),
    arrive: vals.map((v: any) => num(v.Tangent?.ArriveTangent)), leave: vals.map((v: any) => num(v.Tangent?.LeaveTangent)),
    interp: vals.map((v: any) => String(v.InterpMode)), def: c?.bHasDefaultValue ? num(c.DefaultValue) : null,
    tick: num(c?.TickResolution?.Numerator) / (num(c?.TickResolution?.Denominator) || 1) || 60000,
  }
}

/** A curve's value at `tick` (UE's constant, linear and Hermite cubic keys). Null: no keys and no default. */
export function evaluate(c: Channel | undefined, tick: number): number | null {
  if (!c) return null
  const { times: t, values: v } = c
  if (!t.length) return c.def
  if (tick <= t[0]) return v[0]
  if (tick >= t[t.length - 1]) return v[v.length - 1]
  let i = 0
  while (t[i + 1] < tick) i++
  const dt = t[i + 1] - t[i], u = (tick - t[i]) / dt
  if (c.interp[i].includes('Constant')) return v[i]
  if (c.interp[i].includes('Linear')) return v[i] + (v[i + 1] - v[i]) * u
  const m0 = c.leave[i] * dt, m1 = c.arrive[i + 1] * dt, u2 = u * u, u3 = u2 * u
  return (2 * u3 - 3 * u2 + 1) * v[i] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * v[i + 1] + (u3 - u2) * m1
}

export type Ref = { name: string; path: string } // an imported object and its package (/Game/...)
export type Layer = {
  name: string; kind: 'image' | 'text' | 'panel'
  parent: string | null; slot: Record<string, any>; slotKind: string
  props: Record<string, any>
  children: string[] // a panel's, in draw order (back to front)
  brush?: Ref | null
}
export type Track =
  | { widget: string; kind: 'float'; property: string; curve: Channel }
  | { widget: string; kind: 'transform'; mask: number; ch: Record<string, Channel> }
  | { widget: string; kind: 'material'; params: Record<string, Channel> }
export type Animation = { name: string; length: number; tick: number; tracks: Track[] }
/** One place a color is written: export, then the path of property names down to it (the export edits the same path). */
export type ColorSite = { exportIndex: number; path: string[]; widget: string; prop: string; rgba: Rgba }
/** A site's lookup key: its widget and property path, a struct's same-named value folded (Brush.TintColor.SpecifiedColor). */
export const siteKey = (widget: string, path: string[]) => `${widget}|${path.filter((p, i) => p !== path[i - 1]).join('.')}`
export type Role = { id: string; name: string; rgba: Rgba; sites: ColorSite[]; widgets: string[]; parts: string[] }
export type KoWidget = { root: string; layers: Map<string, Layer>; animations: Animation[]; roles: Role[]; defaults: Record<string, any>; resolve: (i: number) => Ref | null }

export function readWidget(a: Asset): KoWidget {
  const ex = a.Exports, im = a.Imports
  const name = (i: number) => (i > 0 ? ex[i - 1]?.ObjectName : i < 0 ? im[-i - 1]?.ObjectName : '') ?? ''
  const cls = (i: number) => (i < 0 ? im[-i - 1]?.ObjectName : ex[i - 1]?.ObjectName) ?? ''
  const resolve = (i: number): Ref | null => {
    if (!i) return null
    if (i > 0) return { name: name(i), path: '' }
    let o = im[-i - 1], pkg = o
    while (pkg && pkg.OuterIndex) pkg = im[-pkg.OuterIndex - 1]
    return o ? { name: o.ObjectName, path: pkg?.ObjectName ?? '' } : null
  }
  const byName = new Map<string, number>()
  ex.forEach((e, i) => byName.set(e.ObjectName, i + 1))
  const p = (i: number) => props(ex[i - 1]?.Data)

  const tree = ex.find(e => cls(e.ClassIndex) === 'WidgetTree')
  const root = name(props(tree?.Data).RootWidget ?? 0)
  const layers = new Map<string, Layer>()
  ex.forEach((e, i) => {
    if (name(e.OuterIndex) !== 'WidgetTree') return
    const c = cls(e.ClassIndex), o = p(i + 1)
    const kind = /Image$/.test(c) ? 'image' : /Text/.test(c) ? 'text' : 'panel'
    const slotIdx = o.Slot ?? 0, slot = slotIdx ? p(slotIdx) : {}
    layers.set(e.ObjectName, { name: e.ObjectName, kind, props: o, slot, slotKind: slotIdx ? cls(ex[slotIdx - 1].ClassIndex) : '',
      children: (o.Slots ?? []).map((si: number) => name(p(si).Content ?? 0)).filter(Boolean),
      parent: slot.Parent ? name(slot.Parent) : null, brush: kind === 'image' ? resolve(o.Brush?.ResourceObject ?? 0) : null })
  })

  const animations: Animation[] = []
  ex.forEach((e, i) => {
    if (cls(e.ClassIndex) !== 'WidgetAnimation') return
    const wa = p(i + 1), ms = p(wa.MovieScene)
    const guidToWidget = new Map<string, string>((wa.AnimationBindings ?? []).map((b: any) => [b.AnimationGuid, b.WidgetName]))
    const tracks: Track[] = []
    let tick = 60000
    for (const b of ms.ObjectBindings ?? []) {
      const widget = guidToWidget.get(b.ObjectGuid) ?? b.BindingName
      for (const ti of b.Tracks ?? []) {
        const t = p(ti), tc = cls(ex[ti - 1].ClassIndex)
        for (const si of t.Sections ?? []) {
          const s = p(si)
          if (tc === 'MovieSceneFloatTrack') { tracks.push({ widget, kind: 'float', property: t.PropertyBinding?.PropertyName, curve: s.FloatCurve }); tick = s.FloatCurve?.tick ?? tick }
          else if (tc === 'MovieScene2DTransformTrack') tracks.push({ widget, kind: 'transform', mask: s.TransformMask?.Mask ?? 0, ch: s })
          else if (tc === 'MovieSceneWidgetMaterialTrack') tracks.push({ widget, kind: 'material', params: Object.fromEntries((s.ScalarParameterNamesAndCurves ?? []).map((c: any) => [c.ParameterName, c.ParameterCurve])) })
        }
      }
    }
    const range = ms.PlaybackRange ?? {}
    const hi = num(range.UpperBound?.Value?.Value ?? range.UpperBound?.Value) || Math.max(0, ...tracks.flatMap(t => t.kind === 'float' ? t.curve?.times ?? [] : t.kind === 'transform' ? Object.values(t.ch).flatMap((c: any) => c?.times ?? []) : Object.values(t.params).flatMap(c => c.times)))
    animations.push({ name: wa.MovieScene ? name(wa.MovieScene) : e.ObjectName, length: hi, tick, tracks })
  })

  const cdo = ex.findIndex(e => e.ObjectName.startsWith('Default__'))
  const defaults = cdo >= 0 ? p(cdo + 1) : {}
  return { root, layers, animations, roles: overridden(readRoles(a, name, cls), defaults, [...layers.keys()]), defaults, resolve }
}

/** The template's placeholder colors: a prompt whose class says bOverrideColor has them replaced in the game by its
 *  BaseColor (the bar, the hero logo, the kill icon) and HighlightColor (the line, the bar glow, the burst). Read from the
 *  44 heroes that set it (game build 3984769): never a hero's own color there, always one of these four. */
const PLACEHOLDERS: [string, string][] = [['#FF914C', 'BaseColor'], ['#818CA9', 'BaseColor'], ['#FFB671', 'HighlightColor'], ['#8F9AAD', 'HighlightColor']]
const near = (hex: string, c: Rgba) => [1, 3, 5].every(i => Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(hexOf(c).slice(i, i + 2), 16)) <= 2)

/** Placeholder roles folded into the Main or Highlight role they follow in the game: one color to pick, and the export
 *  writes it to the placeholders too (right whether or not the game replaces them). */
/** The layer colors a prompt whose class says bOverrideColor gets from the game at runtime, by layer name: the bar, its
 *  inner layer, the hero logo and the kill icon take BaseColor, the bar's glow, the lines and the burst HighlightColor.
 *  The file's own value there is a placeholder (orange) or nothing at all (white), on 44 of 54 heroes (game build 3984769).
 *  The bar's shadow layer (_03, or _01 where a hero swapped them) keeps its black tint. */
export function runtimeColor(widget: string): 'BaseColor' | 'HighlightColor' | null {
  if (/^Img_Vx_Buttom\w*_Glow$|^Img_Vx_Line|^Img_Kill_Burst|Unstoppable/i.test(widget)) return 'HighlightColor'
  if (/^Img_Vx_Buttom(Loop|FadeIn|FadeOut)_0?\d$|^Img_Icon_01$|^Img_Kill_Angle/i.test(widget)) return 'BaseColor'
  return null
}

function overridden(roles: Role[], defaults: Record<string, any>, layers: string[]): Role[] {
  if (!defaults.bOverrideColor) return roles
  const owner = (prop: string) => roles.find(r => r.sites.some(s => !s.widget && s.prop === prop))
  // hovering Main or Highlight shows every layer the game paints with it
  for (const prop of ['BaseColor', 'HighlightColor'] as const) {
    const r = owner(prop)
    if (r) r.widgets = [...new Set([...r.widgets, ...layers.filter(l => runtimeColor(l) === prop)])]
  }
  return roles.filter(r => {
    // only on layers the game repaints: picking it would change nothing in the game, so it is not offered
    if (r.sites.every(x => x.widget && x.prop === 'ColorAndOpacity' && runtimeColor(x.widget))) return false
    const to = PLACEHOLDERS.find(([hex]) => near(hex, r.rgba))?.[1]
    const into = to && r.sites.every(s => s.widget) ? owner(to) : undefined
    if (!into || into === r) return true
    into.sites.push(...r.sites)
    into.widgets = [...new Set([...into.widgets, ...r.widgets])]
    into.parts = [...new Set([...into.parts, ...r.parts])]
    return false
  })
}

const ROLE_NAMES: Record<string, string> = { BaseColor: 'Main', HighlightColor: 'Highlight', FontTopColor: 'Text top', FontButtomColor: 'Text bottom' }
/** What a layer is, in words a player knows: Img_Vx_ButtomLoop_02 is the bar, Img_Icon_01 the hero logo. */
export function partName(widget: string) {
  const w = widget.toLowerCase()
  if (/buttom|bottom/.test(w)) return w.includes('glow') ? 'Bar glow' : 'Bar'
  if (w.includes('line')) return 'Line'
  if (w.includes('icon')) return 'Hero logo'
  if (w.includes('angle')) return w.includes('glow') ? 'Kill icon glow' : 'Kill icon'
  if (w.includes('burst')) return 'Burst'
  if (w.includes('unstoppable')) return 'Unstoppable'
  if (w.startsWith('rtext')) return 'Text'
  // the two slash layers every prompt has: 01 drawn behind 02. A layer a patch adds keeps a number
  const n = w.match(/vx_?0*(\d+)/)
  return n ? (n[1] === '1' ? 'Back slash' : n[1] === '2' ? 'Front slash' : `Effect ${n[1]}`) : widget.replace(/^(img|rtext|panel|overlay)_/i, '').replace(/_/g, ' ')
}

/** Every color in the widget, grouped by its game value: one role per distinct color, edited together. */
function readRoles(a: Asset, name: (i: number) => string, cls: (i: number) => string): Role[] {
  const sites: ColorSite[] = []
  a.Exports.forEach((e, i) => {
    const widget = name(e.OuterIndex) === 'WidgetTree' ? e.ObjectName : e.ObjectName.startsWith('Default__') ? '' : null
    if (widget === null || cls(e.ClassIndex) === 'WidgetTree') return
    const walk = (list: Prop[], path: string[]) => {
      for (const p of list ?? []) {
        if (p.$type.includes('LinearColorPropertyData') && p.Value) sites.push({ exportIndex: i, path: [...path, p.Name], widget, prop: path[0] ?? p.Name, rgba: { R: num(p.Value.R), G: num(p.Value.G), B: num(p.Value.B), A: num(p.Value.A) } })
        else if (Array.isArray(p.Value) && p.Value[0]?.$type) walk(p.Value, [...path, p.Name])
      }
    }
    walk(e.Data, [])
  })
  const key = (c: Rgba) => [c.R, c.G, c.B].map(x => x.toFixed(3)).join(',')
  const groups = new Map<string, ColorSite[]>()
  for (const s of sites) groups.set(key(s.rgba), [...(groups.get(key(s.rgba)) ?? []), s])
  const used = new Map<string, number>()
  return [...groups.entries()].map(([id, list]) => {
    const own = list.find(s => !s.widget && ROLE_NAMES[s.prop])
    const count = new Map<string, number>()
    for (const s of list) if (s.widget) count.set(partName(s.widget), (count.get(partName(s.widget)) ?? 0) + 1)
    const parts = [...count.keys()].sort((x, y) => count.get(y)! - count.get(x)!)
    const c = list[0].rgba, grey = Math.abs(c.R - c.G) < 0.01 && Math.abs(c.G - c.B) < 0.01
    let label = own ? ROLE_NAMES[own.prop]
      : grey && c.R > 0.9 ? `${parts[0] ?? 'Color'} light` : grey && c.R < 0.02 ? `${parts[0] ?? 'Color'} shadow`
        : parts.slice(0, 2).join(' and ') || 'Color'
    const n = (used.get(label) ?? 0) + 1; used.set(label, n)
    if (n > 1) label = `${label} ${n}`
    return { id, name: label, rgba: list[0].rgba, sites: list, widgets: [...new Set(list.map(s => s.widget).filter(Boolean))], parts }
  }).sort((x, y) => Number(!x.sites.some(s => !s.widget)) - Number(!y.sites.some(s => !s.widget)) || y.sites.length - x.sites.length)
}

/** Writes `rgb` (linear, 0 to 1) into every place of the role, alpha kept. Returns how many were changed. */
export function applyRole(a: Asset, role: Role, rgb: [number, number, number]): number {
  let n = 0
  for (const s of role.sites) {
    let list: Prop[] = a.Exports[s.exportIndex].Data
    let p: Prop | undefined
    for (const step of s.path) {
      p = list?.find(q => q.Name === step)
      if (!p) break
      if (Array.isArray(p.Value)) list = p.Value
    }
    if (p && p.$type.includes('LinearColorPropertyData')) { p.Value = { ...p.Value, R: rgb[0], G: rgb[1], B: rgb[2] }; n++ }
  }
  return n
}

// ---- color: hex in the pickers, linear in the game's file ----
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)
export const hexOf = (c: Rgba) => '#' + [c.R, c.G, c.B].map(v => Math.round(Math.min(1, Math.max(0, toSrgb(v))) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
/** `hex` with its hue turned by `deg` (HSL, in the picker's sRGB): greys, white and black stay as they are. */
export function shiftHue(hex: string, deg: number): string {
  if (!deg) return hex.toUpperCase()
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min
  if (!d) return hex.toUpperCase()
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h = (((h * 60 + deg) % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2
  const [R, G, B] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return '#' + [R, G, B].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
}
export const linearOf = (hex: string): [number, number, number] => [1, 3, 5].map(i => toLin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number]

/** A material instance's flipbook: its texture and grid, from its own JSON. */
export type Material = { parent: string; texture: string | null; rows: number; cols: number; scalars: Record<string, number>; mask: string | null }
export function readMaterial(a: Asset): Material {
  const e = a.Exports.find(x => x.ObjectName && x.Data?.some(p => p.Name === 'Parent')) ?? a.Exports[0]
  const o = props(e?.Data)
  const ref = (i: number) => {
    if (!(i < 0)) return ''
    let x = a.Imports[-i - 1]
    while (x && x.OuterIndex) x = a.Imports[-x.OuterIndex - 1]
    return x?.ObjectName ?? ''
  }
  const scalars: Record<string, number> = {}
  for (const s of o.ScalarParameterValues ?? []) scalars[s.ParameterInfo?.Name] = num(s.ParameterValue)
  // the picture, not its mask (a hero logo's flipbook reveal keeps both)
  const texs = (o.TextureParameterValues ?? []).map((t: any) => ref(t.ParameterValue)).filter(Boolean) as string[]
  const tex = texs.find(t => !/mask/i.test(t.split('/').pop() ?? '')) ?? texs[0] ?? null
  return { mask: texs.find(t => /mask/i.test(t) && t !== tex) ?? null, parent: ref(o.Parent ?? 0).split('/').pop() ?? '', texture: tex, rows: scalars.Number_Rows || 1, cols: scalars.Number_Colums || scalars.Number_Columns || 1, scalars }
}

if (import.meta.env?.DEV) {
  const c: Channel = { times: [0, 100], values: [0, 10], arrive: [0, 0], leave: [0, 0], interp: ['RCIM_Linear', 'RCIM_Linear'], def: null, tick: 60000 }
  console.assert(evaluate(c, 50) === 5 && evaluate(c, -1) === 0 && evaluate(c, 200) === 10, 'linear keys')
  console.assert(evaluate({ ...c, interp: ['RCIM_Cubic', 'RCIM_Cubic'] }, 50) === 5, 'flat cubic is smooth step')
  console.assert(hexOf({ R: 1, G: 0, B: 0, A: 1 }) === '#FF0000' && Math.abs(linearOf('#808080')[0] - 0.2158) < 0.001, 'color round trip')
  console.assert(shiftHue('#FF0000', 120) === '#00FF00' && shiftHue('#808080', 90) === '#808080' && shiftHue('#00FF00', -120) === '#FF0000', 'hue shift')
  console.assert(runtimeColor('Img_Vx_ButtomLoop_02') === 'BaseColor' && runtimeColor('Img_Vx_ButtomLoop_Glow') === 'HighlightColor' && runtimeColor('Img_Vx_LineLoop') === 'HighlightColor' && runtimeColor('Img_Vx02_Loop') === null, 'runtime colors')
  console.assert(partName('Img_Vx_ButtomLoop_02') === 'Bar' && partName('Img_Vx02_FadeIn') === 'Front slash' && partName('Img_Vx03_Loop') === 'Effect 3', 'part names')
}
