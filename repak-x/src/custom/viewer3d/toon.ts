// repakxtra: the toon materials of Rotate in 3D (three's WebGPU renderer, TSL). Each slot picks a recipe from its master
// material, in the game's own priority order: eye, hair, body (head shades the same), else generic. The game's own
// parameters come straight from the slot's material file: the MC_Shade bands become a baked ramp, specular follows the
// bands, then rims, the cubemap reflection, edge darken, base glow, and emissive. Also the inverted hull outline, its
// width from vertex color G like the game's.
import * as THREE from 'three/webgpu'
import {
  Fn, float, vec2, vec3, vec4, uniform, texture, uv, normalMap, normalView, normalWorld, positionView, positionWorld,
  cameraPosition, cameraWorldMatrix, diffuseColor, dot, max, min, pow, clamp, saturate, mix, smoothstep, step, normalize,
  reflect, length, abs, atan, dFdx, dFdy, fwidth, tangentView, bitangentView, cross, attribute, positionLocal, normalLocal,
  modelViewMatrix, cameraProjectionMatrix, screenSize, screenUV, time, hash, floor, fract, cameraNear, cameraFar, viewZToPerspectiveDepth, exp2, mrt, normalWorldGeometry, frontFacing, select, sqrt,
} from 'three/tsl'

type Rgba = { R: number; G: number; B: number; A?: number }
/** A slot's material file (viewer_files in mod_previews.py): the kit's simplified material with its parents' values. */
export type Mat = {
  Textures?: Record<string, string>; Parameters?: { IsTranslucent?: boolean; BlendMode?: number; Switches?: Record<string, boolean> }; Parent?: string; ParentChain?: string[]
  TwoSided?: boolean; BlendMode?: string; Vectors?: Record<string, Rgba>; Scalars?: Record<string, number>
}
export type Recipe = 'eye' | 'hair' | 'body' | 'generic'
export type Node = ReturnType<typeof float>
export type Tex = InstanceType<typeof THREE.Texture> | null
/** A normal map's sample, its blue rebuilt from red and green when it was saved from BC5 (scene.ts rebuildBlue). */
export function normalTex(t: NonNullable<Tex>) {
  const s = texture(t, uv())
  if (!t.userData?.rebuildBlue) return s
  const xy = s.rg.mul(2).sub(1)
  return vec3(s.r, s.g, sqrt(saturate(float(1).sub(dot(xy, xy)))).mul(0.5).add(0.5))
}
/** The textures a slot draws, by role (scene.ts loads them). */
export type Maps = { base: Tex; normal: Tex; orm: Tex; emissive: Tex; spec: Tex; cube: Tex; cubeMask: Tex; rimMask: Tex; shadow: Tex; opacity: Tex; shift: Tex; fx?: Record<string, Tex> }
/** One viewer's shared state: GPU objects to free on dispose, ramps by band values, the outline switch. */
export type Kit = { owned: { dispose?: () => void }[]; ramps: Map<string, unknown>; outline: Node; outlineDist: Node; rim: ShowRim; shells: { visible: boolean }[]; cosmic?: boolean }
/** The skin's show rim light (its MI_<skin>_ShowRimLight_HeroDetails, on M_RimLight_PP; the kit's showrim.json): the
 *  values the post material reads. direction: RimLightDirection (view space, x right, y up, z away); color and outline:
 *  RimLightColor and RimLightOutlineColor (linear); separation: ColorSeperationWidth_2; offset: OutlineOffset (x, y). */
export type ShowRim = { direction: number[]; fresnelPower: number; range: number; separation: number; color: number[]; outline: number[]; offset: number[] }
// Black Panther's default skin (MI_1026001_ShowRimLight_HeroDetails_01 over M_RimLight_PP's defaults); its RimColor1-3
// and TintColor overrides are left over from an older parent, the master no longer reads them
export const SHOW_RIM: ShowRim = { direction: [2, 0.415541, 0], fresnelPower: 5, range: 1, separation: 0.95, color: [1, 1, 1], outline: [0, 0, 0], offset: [-0.12, 0.15] }

/** What the model writes for the show rim light (post.ts): the rim mask and the smooth geometric world normal. The
 *  game's rim shell is a slot of the lobby mesh (MI_<skin>_Rim_HeroDetails, M_RimOnly or M_Hide: a low-poly copy about 2 mm
 *  off the skin, Black Panther's measured 2.2 mm median): it marks green 1 with its own normals, and the model green
 *  0.5. A model without a rim slot (a mod's own mesh) takes the bands on its own normals (post.ts). */
const NORMAL = vec4(normalize(normalWorldGeometry).mul(0.5).add(0.5), 1)
export const CHARACTER = mrt({ rimMask: vec4(0, 0.5, 0, 1), normal: NORMAL })
const SHELL = mrt({ rimMask: vec4(0, 1, 0, 0.5), normal: NORMAL })
/** What an effect writes: no rim, no normal of its own. */
export const NO_RIM = mrt({ rimMask: vec4(0), normal: vec4(0.5, 0.5, 1, 1) })

/** A rim shell slot by its material name, as the game viewer picks them (not the show rim post materials). */
export const isRimSlot = (name: string) => /rim/i.test(name) && !/showrimlight|mvp_rimlight|charim/i.test(name)

/** The rim shell slot's material: draws nothing (its color is fully transparent and it writes no depth) but marks the
 *  rim mask and its own normal wherever it shows, in front of the skin and just past its edge. */
export function rimSlotMaterial() {
  const mat = new THREE.NodeMaterial()
  mat.colorNode = vec4(0, 0, 0, 0)
  mat.emissiveNode = vec3(0)
  mat.mrtNode = SHELL
  mat.transparent = true
  mat.depthWrite = false
  return mat
}

/** The extra textures the glow layers below read, by material texture name. */
export const FX_TEXTURES = ['FX_FlowMask', 'FX_FlowTex', 'GalaxyMask', 'GalaxyTex1', 'GalaxyTex2', 'StarTex1', 'StarTex2', 'StarTex3', 'StarTex4',
  'IrisBaseColor', 'IrisBaseAO', 'ScleraBaseColor', 'HighlightMask', 'ToothBaseColor', 'Matcap - Tex', 'SubSurfaceNoise1', 'CubeMap', 'GalaxyColorTex', 'Unique_Hair_Value', 'AnisotropyBrightness',
  'BackBaseColor', 'BaseTex', 'DiaColorTex', 'CrystalNormal', 'BaseNormal', 'Snow - EmissiveFlickerMap']
/** Of those, the ones sampled as color (sRGB): the rest are masks. */
export const FX_COLOR = /^(IrisBaseColor|ScleraBaseColor|ToothBaseColor|Matcap - Tex|BackBaseColor)$/ // (the jelly's CubeMap is data: linear)

/** A galaxy master by name (M_Common_JellyGalaxy, M_1030504_JellyGalaxy, a StarryBody): other masters list the galaxy's
 *  textures among their defaults with the layer switched off (Iron Fist's body, Winter Soldier's hair). */
export const isGalaxy = (m: Mat) => [m.Parent, ...(m.ParentChain ?? [])].some(p => p && /galax|starry|cosmic|blackhole|_Tie|crystal/i.test(p))
export const isJellyGalaxy = (m: Mat) => [m.Parent, ...(m.ParentChain ?? [])].some(p => p && /jellygalaxy|^M_1060302_Tie$/i.test(p))

/** The lobby glow layers some skins add on top of their shading, or null: the flow glow (a mask of lines lit by a
 *  noise that drifts across them, FX_FlowMask and FX_FlowTex in FX_FlowNoiseColor, Electric Violet's purple veins) and
 *  the jelly galaxy (a starfield fixed to the screen, seen through the body: two smoke layers in the galaxy colors, two
 *  tiled star maps, and two layers of single stars scattered over a grid by their density). shortcut: the 0.5 flow
 *  scale and the galaxy's screen-height units are picked by eye against the game's previews, the masters' graphs are
 *  not read */
export function fxGlow(m: Mat, fx: Record<string, Tex>) {
  let glow: Node | null = null
  const add = (n: Node) => { glow = glow ? glow.add(n) : n }
  if (num(m, ['FlowNoiseSwitch'], 0) > 0 && fx.FX_FlowMask) {
    // as the animated previews draw it: only the lines' cores glow (mask 0.28 to 0.75, in the mask's own color), and a
    // pulse of the noise travels along them at the master's pan speeds (FlowTex_UVTile z, w), black between pulses
    const c = vec(m, ['FX_FlowNoiseColor', 'EmissiveColor'], [1, 1, 1]), peak = Math.max(c[0], c[1], c[2], 1e-3)
    if (peak > 0.01) {
      const mt = vec(m, ['FX_FlowMask_UVTile'], [1, 1, 0, 0]), nt = vec(m, ['FlowTex_UVTile'], [1, 1, 0, 0])
      const mask = texture(fx.FX_FlowMask, uv().mul(vec2(mt[0] || 1, mt[1] || 1))).rgb
      const top = max(mask.r, max(mask.g, mask.b))
      const lines = mask.div(max(top, 1e-3)).mul(smoothstep(0.28, 0.75, top))
      let pulse: Node = float(1)
      if (fx.FX_FlowTex) {
        const pan = nt[2] || nt[3] ? vec2(nt[2], nt[3]) : vec2(0, 0.05) // no pan: down the body, as the previews move it
        const noise = texture(fx.FX_FlowTex, uv().mul(vec2(nt[0] || 1, nt[1] || 1)).add(pan.mul(time))).r
        pulse = smoothstep(0.15, 0.85, pow(noise, Math.max(1, num(m, ['FlowNoisePower'], 1) * 0.6)))
      }
      const strength = Math.min(4, Math.max(1, num(m, ['FlowMaskIntensity'], 1) * num(m, ['FlowNoiseIntensity', 'FX_FlowNoise_Strength'], 1) * 0.6))
      // What makes a skin glow in the game: the line color is far over white (Black Panther's MCU suit and its recolors
      // set 80), and the lobby's bloom spreads whatever is over white around the lines. The color's size is kept as
      // stops over white (80 is 6.3 of them), so the bloom pass, which reads this, puts the same halo round them. A
      // color at 1 or under (Electric Violet's veins) is as before. shortcut: stops, not the raw 80, the master's own
      // scaling between the color and the screen is not read
      const hdr = Math.max(1, Math.log2(1 + peak))
      add(lines.mul(col([c[0] / peak, c[1] / peak, c[2] / peak])).mul(pulse).mul(strength * 0.5 * hdr))
    }
  }
  // a glitter (Snow - EmissiveFlickerMap, Phoenix's Snow Veil dress): its star sprites barely visible, as in the game's
  // lobby and the previews. shortcut: the 0.06 is picked by eye, the master's flicker timing is not read
  if (fx['Snow - EmissiveFlickerMap']) add(texture(fx['Snow - EmissiveFlickerMap'], uv()).rgb.mul(0.06))
  if ((fx.StarTex3 || fx.GalaxyTex1) && isGalaxy(m) && !isJellyGalaxy(m)) {
    // only where the GalaxyMask is white (Nebucy's silver hair and armor have none): every layer below goes through it
    const inMask = fx.GalaxyMask ? texture(fx.GalaxyMask, uv()).r : null
    const put = (n: Node) => add(inMask ? n.mul(inMask) : n)
    const s = screenUV.mul(vec2(screenSize.x.div(screenSize.y), 1)) // screen units: 1 = the view's height
    const size = (k: string, d: number) => Math.max(num(m, [`${k}_Size`], d), 0.01)
    for (const [k, c] of [['GalaxyTex1', 'GalaxyColorTex_Color1'], ['GalaxyTex2', 'GalaxyColorTex_Color2']]) {
      if (fx[k]) put(col(vec(m, [c], [0, 0, 0])).mul(pow(texture(fx[k], s.div(size(k, 0.2))).r, num(m, [`${k}_Power`], 1))).mul(num(m, ['GalaxyColorTex_Power'], 1)))
    }
    // the star maps: a size of 0.15 spans the view's height (their stars stay a pixel or two wide)
    // (only their stars: the faint haze between them stays dark, it read as a blue fog)
    for (const k of ['StarTex3', 'StarTex4']) {
      if (!fx[k]) continue
      const t = texture(fx[k], s.div(size(k, 0.15) / 0.15)).rgb
      put(t.mul(smoothstep(0.35, 0.8, max(t.r, max(t.g, t.b)))).mul(col(vec(m, [`${k}_Color`], [1, 1, 1]))))
    }
    for (const [i, k] of ['StarTex1', 'StarTex2'].entries()) {
      // a quarter of the size: as many stars as the game shows
      if (fx[k]) put(scatter(s.div(size(k, 0.3) * 0.25), fx[k], num(m, [`${k}_Density`], 0.1), 31 * i + 7).mul(col(vec(m, [`${k}_Color`], [1, 1, 1]))))
    }
  }
  return glow
}

/** Single stars over the cells of `p`: at most one per cell, at a random spot anywhere in it, 0.2 to 0.45 of a cell wide,
 *  each its own brightness, never changing size, on a lattice turned per layer so two layers' rows never line up. A
 *  density of 1 or more (White Fox's tails, Hulk's cosmic body) filled every cell and drew an even grid of dots: the
 *  share of lit cells stays at most 0.3. shortcut: the 0.3 cap is picked by eye, the masters' graphs are not read */
function scatter(p: Node, tex: Tex, density: number, seed: number) {
  const a = 0.5 + seed * 0.61, c = Math.cos(a), s = Math.sin(a)
  const r = vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)))
  // cells shifted positive: hash() takes a uint, and every negative sum became 0 (one spot, one size, always lit:
  // a grid over most of the view)
  const cell = floor(r).add(4096), h = (k: number) => hash(cell.x.mul(127.1).add(cell.y.mul(311.7)).add(seed + k))
  const size = h(5).mul(0.25).add(0.2)
  const center = vec2(h(1), h(2)).mul(float(1).sub(size)).add(size.mul(0.5))
  const q = fract(r).sub(center).div(size).add(0.5) // the sprite's own coordinates
  const inside = smoothstep(0.5, 0.3, length(q.sub(0.5))) // round: the sprite's glow does not reach 0 at its square's edge
  return texture(tex, q).r.mul(inside).mul(step(h(3), Math.min(density, 0.3))).mul(h(4).mul(0.7).add(0.3))
}

/** Whether a slot is one of the game's flipbook fires (a SequencesTex of USequences x VSequences frames: Devil
 *  Dinosaur's lobby flames and its burning tail). */
export const isFire = (m: Mat) => Boolean(m.Textures?.SequencesTex) && num(m, ['USequences'], 0) > 0 && num(m, ['VSequences'], 0) > 0

/** A flipbook fire: the frame at the master's play speed (BP_PlaySpeed x 8 frames a second), times its Mask, colored in
 *  the master's three steps (Step1-3 thresholds, softened by Step1-3_Smooth: the outer flame, its body, the hot core),
 *  added on top as light. shortcut: the frame rate and the steps' reading are picked against the lobby previews, the
 *  masters' graphs are not read */
export function fireMaterial(m: Mat, seq: Tex, mask: Tex, cloud: Tex = null) {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })
  const cols = num(m, ['USequences'], 1), rows = num(m, ['VSequences'], 1)
  const frame = floor(time.mul(num(m, ['BP_PlaySpeed'], 1) * 8)).mod(cols * rows)
  const cell = vec2(frame.mod(cols), floor(frame.div(cols)))
  const fuv = uv().fract().add(cell).div(vec2(cols, rows))
  let v: Node = texture(seq, fuv).r.mul(num(m, ['SequencesTex_Strength'], 1))
  if (mask) v = v.mul(pow(texture(mask, uv()).r, num(m, ['Mask_Power'], 1)).mul(num(m, ['Mask_Strength'], 1)))
  let color: Node
  if (m.Vectors?.FireColor01 && cloud) {
    // a body master's fire (FireColor01-03, CloudTex panned at FireSpeed01): the flipbook breaks up a drifting noise,
    // deep red where it is thin, orange, then yellow in the hottest licks
    const sp = vec(m, ['FireSpeed01'], [0.1, 0.1, 0, 0])
    const n = texture(cloud, uv().add(vec2(sp[0], sp[1]).mul(time))).r
    const heat = saturate(v.mul(n).mul(2))
    const c = (k: string, d: number[]) => col(vec(m, [k], d))
    color = mix(mix(c('FireColor03', [0.6, 0.1, 0]), c('FireColor01', [1, 0.14, 0.05]), smoothstep(0.1, 0.45, heat)), c('FireColor02', [1, 0.58, 0.11]), smoothstep(0.45, 0.9, heat))
      .mul(smoothstep(0.02, 0.2, heat)).mul(1.1)
  } else {
    const step = (i: number) => smoothstep(1 - num(m, [`Step${i}`], 1), 1 - num(m, [`Step${i}`], 1) + Math.max(num(m, [`Step${i}_Smooth`], 0.1), 1e-3), v)
    const c = (i: number) => col(vec(m, [`Step${i}Color`], [1, 0.5, 0.1]))
    color = mix(mix(c(1), c(2), step(2)), c(3), step(3)).mul(step(1))
  }
  mat.colorNode = vec4(color, 1)
  mat.emissiveNode = color // the bloom reads it
  mat.mrtNode = mrt({ rimMask: vec4(0), normal: vec4(0.5, 0.5, 1, 1) })
  mat.userData.fire = true // casts no shadow and takes no rim
  return mat
}

/** The game's eye drawn the way its master builds it on the eyeball's UV (d = uv - 0.5): the iris image fills a disk of
 *  IrisUVRadius with a soft IrisBorderWidth edge, the pupil shifted (PupilShiftX, Y) and dilated (PupilScale), darkened
 *  toward its rim (LimbusDarkScale, Power) and by its AO (IrisBaseAO ^ AOPower), brightened by IrisBrightness, over the
 *  sclera (ScleraBaseColor or white, times ScleraTint, IrisBleedTint under the iris); teeth at uv.x >= 1; the catchlight
 *  (HighlightMask turned -36 degrees, placed by Highlight_UVOffset, in Highlight_Color) added as light. Without these it
 *  was the iris image stretched over the whole ball: a black sphere. Lit by the toon ramp, no specular. */
export function proceduralEye(mat: InstanceType<typeof THREE.MeshStandardNodeMaterial>, m: Mat, fx: Record<string, Tex>) {
  if (!fx.IrisBaseColor || /body/i.test(m.Parent ?? '')) return
  const R = Math.max(num(m, ['IrisUVRadius'], 0.15), 1e-3), W = Math.max(num(m, ['IrisBorderWidth'], 0.04), 1e-4)
  const d = uv().sub(0.5)
  const irisMask = smoothstep(0, 1, saturate(float(R).sub(length(d)).div(W)))
  const u = d.mul(0.5 / R)
  const w = pow(saturate(float(0.45).sub(length(u)).mul(4)), 0.7)
  const h = u.add(vec2(-0.1 * num(m, ['PupilShiftX'], 0), 0.1 * num(m, ['PupilShiftY'], 0)).mul(w))
  const z = saturate(float(1).sub(length(h).mul(2)).mul(num(m, ['PupilScale'], 1)))
  const irisUV = normalize(h.add(1e-5)).mul(0.5).mul(float(1).sub(z)).add(0.5)
  const ao = fx.IrisBaseAO ? pow(max(texture(fx.IrisBaseAO, irisUV).r, 1e-4), num(m, ['AOPower'], 0.25)) : float(1)
  const c = irisUV.sub(0.5)
  const limbus = saturate(float(1).sub(pow(length(c).mul(num(m, ['LimbusDarkScale'], 2)), num(m, ['LimbusDarkPower'], 4))))
  const iris = texture(fx.IrisBaseColor, irisUV).rgb.mul(ao).mul(col(vec(m, ['IrisBaseColorMulti'], [1, 1, 1]))).mul(limbus).mul(num(m, ['IrisBrightness'], 1))
  const ss = Math.max(num(m, ['ScleraScale'], 1), 1e-3)
  const sclera = (fx.ScleraBaseColor ? texture(fx.ScleraBaseColor, d.div(ss).add(0.5)).rgb : vec3(1)).mul(col(vec(m, ['ScleraTint'], [1, 1, 1])))
  const bleed = mix(sclera, sclera.mul(col(vec(m, ['IrisBleedTint'], [1, 1, 1]))), irisMask)
  let color: Node = mix(bleed, iris, irisMask)
  if (fx.ToothBaseColor) color = mix(color, texture(fx.ToothBaseColor, uv().sub(vec2(1, 0))).rgb.mul(col(vec(m, ['Tooth_BaseTint'], [1, 1, 1]))), step(1, uv().x))
  mat.colorNode = color
  const hc = vec(m, ['Highlight_Color', 'HIghlight_Color'], [0, 0, 0])
  if (num(m, ['UseHighlight'], 0) > 0.5 && fx.HighlightMask && Math.max(hc[0], hc[1], hc[2]) > 0) {
    const a = -0.6283185, o = vec(m, ['Highlight_UVOffset'], [0.255, -0.58, 0.1, -0.07])
    const r = vec2(d.x.mul(Math.cos(a)).sub(d.y.mul(Math.sin(a))), d.x.mul(Math.sin(a)).add(d.y.mul(Math.cos(a)))).add(0.5)
    const sx = Math.abs(o[0]) < 1e-4 ? 1 : 1 / o[0], sy = Math.abs(o[1]) < 1e-4 ? 1 : 1 / o[1]
    const huv = fract(r.sub(0.5).mul(vec2(sx, sy)).add(0.5).add(vec2(o[2], o[3])))
    mat.emissiveNode = texture(fx.HighlightMask, huv).rgb.mul(col(hc)).mul(irisMask)
  }
}

/** The galaxy a cosmic material shows through its surface: a window onto space fixed to the screen (scaled by the
 *  camera's distance), two cloud layers in the galaxy colors and two star maps panned by their _UVS, and two layers of
 *  single stars scattered by Density (scatter), faded out toward the silhouette and kept to the
 *  GalaxyMask. */
export function galaxyLayer(m: Mat, fx: Record<string, Tex>): Node {
  const edge = float(1).sub(saturate(dot(normalWorld, normalize(cameraPosition.sub(positionWorld)))))
  // the galaxy: screen coordinates (1 = the view's diagonal), scaled up as the camera backs off (1 m to 3 m: 0.125 to 0.75)
  const k = clamp(length(cameraPosition).sub(1).div(2), 0, 1).mul(0.625).add(0.125)
  const sp = screenUV.sub(0.5).mul(screenSize).div(length(screenSize)).mul(0.5774).mul(k)
  const uvsOf = (name: string, d: number[]) => vec(m, [`${name}_UVS`], d)
  const layer = (name: string, size: number, uvs: number[]) =>
    vec2(uvs[2], uvs[3]).mul(time).add(sp.mul(vec2(uvs[0], uvs[1])).div(Math.max(num(m, [`${name}_Size`], size), 1e-3)))
  let galaxy: Node = vec3(0)
  if (fx.GalaxyTex1) {
    const g1 = pow(max(texture(fx.GalaxyTex1, layer('GalaxyTex1', 0.1, uvsOf('GalaxyTex1', [1, 1, -0.01, -0.02]))).rgb, 1e-4), vec3(num(m, ['GalaxyTex1_Power'], 1)))
    const cm = fx.GalaxyColorTex ? pow(max(texture(fx.GalaxyColorTex, layer('GalaxyColorTex', 0.2, uvsOf('GalaxyColorTex', [1, 1, -0.015, -0.03]))).r, 1e-4), num(m, ['GalaxyColorTex_Power'], 1)) : float(1)
    const g2 = fx.GalaxyTex2 ? pow(max(texture(fx.GalaxyTex2, layer('GalaxyTex2', 0.2, uvsOf('GalaxyTex2', [1, 1, -0.015, -0.03]))).r, 1e-4), num(m, ['GalaxyTex2_Power'], 5)) : float(1)
    galaxy = g1.mul(mix(col(vec(m, ['GalaxyColorTex_Color2'], [0, 0.041, 1])), col(vec(m, ['GalaxyColorTex_Color1'], [0.8, 0.054, 0.133])), cm)).mul(g2)
  }
  const starDefaults: Record<string, [number, number, number[]]> = { StarTex1: [0.2, 10, [0, 0.402, 1]], StarTex2: [0.4, 0.54, [3, 0.497, 1.163]] }
  for (const [i, name] of ['StarTex1', 'StarTex2'].entries()) {
    if (!fx[name]) continue
    const [ds, dd, dc] = starDefaults[name]
    const p = sp.mul(50 / Math.max(num(m, [`${name}_Size`], ds), 1e-3))
    galaxy = galaxy.add(col(vec(m, [`${name}_Color`], dc)).mul(scatter(p, fx[name], num(m, [`${name}_Density`], dd), i * 97)))
  }
  const maps: [string, number, number[], number[]][] = [['StarTex3', 0.12, [1, 1, 0.001, -0.008], [0.446, 0.346, 1.5]], ['StarTex4', 0.1, [1, 1, 0.001, -0.008], [0.65, 0.06, 0.151]]]
  for (const [name, size, d, dc] of maps) {
    if (fx[name]) galaxy = galaxy.add(col(vec(m, [`${name}_Color`], dc)).mul(texture(fx[name], layer(name, size, uvsOf(name, d))).g))
  }
  // full where the body faces the camera, gone toward its edges (the rim takes over there), and only on the GalaxyMask
  let gate: Node = smoothstep(0, 1, saturate(float(0.65).sub(edge.sqrt()).mul(5)))
  if (fx.GalaxyMask) gate = gate.mul(texture(fx.GalaxyMask, uv()).g)
  return galaxy.mul(gate)
}

/** The jelly galaxy master (Panther X, cosmic Black Panther, Celestial Soldier's skin), unlit as the game draws it: the
 *  painted color in a fake three step shade from its own light direction (Shadow - ShadeColor1-3 at ShadePos1-3), plus
 *  its matcap, its cube map (tone mapped, toward the edges by CubeMapWidth), its subsurface noise, a fixed fake
 *  specular and a rim, plus the galaxy seen through the body: a window onto space fixed to the screen (scaled by the
 *  camera's distance), two cloud layers in the galaxy colors and two star maps panned by their _UVS, and two layers of
 *  single stars scattered by Density (scatter), faded out toward the silhouette and kept to the
 *  GalaxyMask. Its stars and clouds also feed the bloom. */
export function jellyGalaxyMaterial(m: Mat, base: Tex, fx: Record<string, Tex>, opacity: Tex, masked: boolean) {
  const mat = new THREE.MeshBasicNodeMaterial()
  const V = normalize(cameraPosition.sub(positionWorld)), N = normalWorld
  const ndv = saturate(dot(N, V)), edge = float(1).sub(ndv)
  const albedo = base ? texture(base, uv()) : vec4(1)
  // the fake shade
  const dl = vec(m, ['ShadowLightDirection'], [0.5, 0.5, 0])
  const g = dot(normalize(vec3(dl[0], dl[2], dl[1])), N).add(1).mul(0.5)
  const pos = [num(m, ['Shadow - ShadePos1'], 0.9), num(m, ['Shadow - ShadePos2'], 0.5), num(m, ['Shadow - ShadePos3'], 0.2)]
  const sc = [vec(m, ['Shadow - ShadeColor1'], [0.75, 0.75, 0.75]), vec(m, ['Shadow - ShadeColor2'], [0.177, 0.177, 0.177]), vec(m, ['Shadow - ShadeColor3'], [0, 0, 0])]
  const hi = Math.min(pos[0], pos[1]), lo = Math.min(hi, pos[2])
  const w2 = Math.max((pos[0] - hi) * num(m, ['Shadow - ShadeSmoothness2'], 0.5), 1e-4), w3 = Math.max((hi - lo) * num(m, ['Shadow - ShadeSmoothness3'], 0.5), 1e-4)
  const upper = mix(col(sc[1]), col(sc[0]), saturate(g.sub(hi).div(w2))), lower = mix(col(sc[2]), col(sc[1]), saturate(g.sub(lo).div(w3)))
  const shade = mix(mix(lower, upper, step(hi, g)), col(sc[0]), step(pos[0], g))
  let sum: Node = albedo.rgb.mul(col(vec(m, ['BaseTint'], [1, 1, 1]))).mul(shade)
  if (fx['Matcap - Tex']) sum = sum.add(texture(fx['Matcap - Tex'], normalView.xy.mul(0.5).add(0.5)).rgb.mul(col(vec(m, ['Matcap - Color'], [0, 0, 0]))))
  const cs = num(m, ['CubeMapStrength'], 1)
  if (fx.CubeMap && cs > 0) {
    fx.CubeMap.wrapS = THREE.RepeatWrapping
    fx.CubeMap.needsUpdate = true
    const R = reflect(V.negate(), N)
    const c = texture(fx.CubeMap, vec2(atan(R.x.negate(), R.z).div(Math.PI * 2), float(1).sub(clamp(R.y, -1, 1).acos().div(Math.PI)))).rgb
    sum = sum.add(c.div(c.add(1)).mul(cs).mul(pow(max(edge, 1e-4), Math.max(num(m, ['CubeMapWidth'], 1.4), 1e-3))))
  }
  if (fx.SubSurfaceNoise1) {
    const t = vec(m, ['SubSurfaceNoise1_UVTileOffset'], [1, 1, 0, 0])
    const n = texture(fx.SubSurfaceNoise1, uv().mul(vec2(t[0] || 1, t[1] || 1)).add(vec2(t[2], t[3]))).r
    sum = sum.add(mix(col(vec(m, ['SubSurfaceBaseColor'], [0, 0, 0])), col(vec(m, ['SubSurfaceNoise1Color'], [0, 0, 0])), pow(max(n, 1e-4), Math.max(num(m, ['SubSurfaceNoisePower'], 1), 1e-3))))
  }
  const fd = vec(m, ['FakeSpecularDir'], [0, 0, -1])
  const H = normalize(V.add(normalize(vec3(fd[0], fd[2], fd[1]))))
  sum = sum.add(col(vec(m, ['FakeSpecularColorTint'], [1, 1, 1])).mul(pow(max(dot(N, H), 0), Math.max(1000 - 980 * num(m, ['FakeSpecularRoughness'], 0), 1))))
  sum = sum.add(col(vec(m, ['RimLightColor'], [0.02, 0.1, 0.2])).mul(smoothstep(0, 1, saturate(pow(max(edge, 1e-4), num(m, ['RimFresnelPower'], 3)).div(Math.max(1 - num(m, ['RimRange'], 0.2), 1e-3))))))
  const galaxy = galaxyLayer(m, fx)
  mat.colorNode = vec4(sum.add(galaxy).mul(num(m, ['FakeSpecularNormalStrength'], 1)), 1)
  mat.emissiveNode = galaxy
  if (masked && opacity) { mat.opacityNode = texture(opacity, uv()).r; mat.alphaTest = 0.3333 }
  mat.mrtNode = CHARACTER
  return mat
}

/** The recipe the game's master material asks for (its match rules, highest priority first). */
export function recipeOf(m: Mat): Recipe {
  const p = m.Parent ?? '', t = m.Textures ?? {}
  if (/eye/i.test(p) && (t.IrisBaseColor || t.ScleraBaseColor || m.Scalars?.IrisUVRadius !== undefined)) return 'eye'
  if (/hair|_Fur\b/i.test(p)) return 'hair'
  if (/fluff|body|skin|\bM_\d+_Arms\w*\b|\bM_Common_Show\b|\bM_\d+\w*Weapons?\w*\b/i.test(p)) return 'body'
  return 'generic'
}

export const num = (m: Mat, keys: string[], d: number) => { for (const k of keys) { const v = m.Scalars?.[k]; if (Number.isFinite(v)) return v! } return d }
export const vec = (m: Mat, keys: string[], d: number[]) => { for (const k of keys) { const v = m.Vectors?.[k]; if (v) return [v.R, v.G, v.B, v.A ?? 1] } return d }
export const col = (c: number[]) => uniform(new THREE.Color(c[0], c[1], c[2]))
const V = () => normalize(positionView.negate())

/** The toon ramp as a 1024 x 1 half float texture: above band 0's threshold it rises from band 0's tone to white,
 *  between bands 0 and 1 from band 1's to band 0's, then fades to black, with alpha the deep shadow weight. */
function ramp(kit: Kit, b0: number[], b1: number[], b2: number[], soft: number[]) {
  const id = [b0, b1, b2, soft.slice(0, 3)].join('|')
  if (kit.ramps.has(id)) return kit.ramps.get(id)
  const c01 = (x: number) => Math.min(1, Math.max(0, x)), ss = (x: number) => { const t = c01(x); return t * t * (3 - 2 * t) }
  const [tA, tB, tC] = [b0[3], b1[3], b2[3]], [sA, sB, sC] = soft.slice(0, 3).map(s => Math.max(s, 1e-3))
  const data = new Uint16Array(1024 * 4), h = THREE.DataUtils.toHalfFloat
  for (let i = 0; i < 1024; i++) {
    const x = i / 1023, w = (lo: number, hi: number, s: number) => c01(ss((x - lo) / Math.max(hi - lo, 1e-4)) / s)
    let px: number[]
    if (x > tA) { const k = w(tA, 1, sA); px = [0, 1, 2].map(j => b0[j] + (1 - b0[j]) * k).concat(0) }
    else if (x > tB) { const k = w(tB, tA, sB); px = [0, 1, 2].map(j => b1[j] + (b0[j] - b1[j]) * k).concat(0) }
    else if (x > tC) { const k = w(tC, tB, sC); px = [0, 1, 2].map(j => b1[j] * k).concat(1 - k) }
    else px = [0, 0, 0, 1]
    px.forEach((v, j) => { data[i * 4 + j] = h(v) })
  }
  const t = new THREE.DataTexture(data, 1024, 1, THREE.RGBAFormat, THREE.HalfFloatType)
  t.minFilter = t.magFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.generateMipmaps = false
  t.needsUpdate = true
  kit.ramps.set(id, t)
  kit.owned.push(t)
  return t
}

/** The ramp at x, four taps across the pixel's footprint so band edges stay smooth. */
const rampAt = (lut: unknown, x: Node) => {
  const c = saturate(x), hw = fwidth(c).mul(0.5)
  let sum: Node = null
  for (const k of [-0.75, -0.25, 0.25, 0.75]) {
    const tap = texture(lut, vec2(saturate(c.add(hw.mul(k))).mul(1023).add(0.5).div(1024), 0.5))
    sum = sum ? sum.add(tap) : tap
  }
  return sum.mul(0.25)
}

/** GGX with a Hammon visibility term and Schlick fresnel (f90 from f0's green), roughness widened by curvature. */
function ggx(N: Node, L: Node, a: Node, f0: Node) {
  const v = V(), H = normalize(L.add(v))
  const NoH = max(dot(N, H), 0), VoH = max(dot(v, H), 0), NoL = max(dot(N, L), 0), NoV = saturate(abs(dot(N, v)).add(1e-5))
  // specular antialiasing: roughness widened where the normal turns within a pixel (the game viewer's 2x and 0.25 cap,
  // doubled here: its value left the gold and sheen sparkling when zoomed out)
  const dx = dFdx(N), dy = dFdy(N), a2 = saturate(a.mul(a).add(min(dot(dx, dx).add(dot(dy, dy)).mul(4), 0.5)))
  const d = NoH.mul(NoH).mul(a2.sub(1)).add(1), D = a2.div(d.mul(d).mul(Math.PI))
  const vis = float(0.5).div(max(mix(a, 1, NoV).mul(NoL).add(mix(a, 1, NoL).mul(NoV)), 1e-4))
  const fc = pow(float(1).sub(VoH), 5)
  return D.mul(vis).mul(vec3(saturate(f0.y.mul(50))).mul(fc).add(f0.mul(float(1).sub(fc))))
}

type Look = {
  lut: unknown; scale?: Node; spec?: (L: Node, band: Node) => Node; indirect?: Node; ao?: Node; finish?: Node
  /** band 2's tone: the deep shadow fill a shadow casting light adds where the ramp falls to black */
  fill?: Node
  /** the environment's reflection, from the radiance three gathers at the material's roughness */
  env?: (radiance: Node) => Node
}

/** Toon lighting, per light: the ramp on N.L times the light's shadow (shadows land on the bands), times the light's
 *  unshadowed color (no 1/PI, as the game does); for a shadow casting light band 2's tone fills the deep shadow;
 *  specular banded by the same ramp and scaled per light; then indirect diffuse plus reflections, and rims and glow
 *  added before emissive. */
class ToonModel extends THREE.LightingModel {
  look: Look
  constructor(look: Look) { super(); this.look = look }
  direct({ lightDirection: L, lightColor, reflectedLight, lightNode }: { lightDirection: Node; lightColor: Node; reflectedLight: Node; lightNode: { light?: { castShadow?: boolean; isDirectionalLight?: boolean; userData?: { specularScale?: number } }; shadowNode?: Node; baseColorNode?: Node } }) {
    // the unshadowed color: directional lights only (three keeps a spot's cone and distance falloff in lightColor)
    const casts = Boolean(lightNode?.light?.castShadow && lightNode.light.isDirectionalLight && lightNode.shadowNode && lightNode.baseColorNode)
    const shadow = casts ? lightNode.shadowNode : float(1)
    const full = casts ? lightNode.baseColorNode : lightColor // the light without its shadow
    const band = rampAt(this.look.lut, max(dot(normalView, L), 0).mul(shadow))
    let d = diffuseColor.rgb.mul(band.rgb).mul(full)
    if (lightNode?.light?.castShadow && this.look.fill) d = d.add(diffuseColor.rgb.mul(this.look.fill).mul(band.a).mul(1 / Math.PI).mul(saturate(length(full).mul(10))))
    reflectedLight.directDiffuse.addAssign(this.look.scale ? d.mul(this.look.scale) : d)
    if (this.look.spec) {
      const scale = lightNode?.light?.userData?.specularScale ?? 1
      reflectedLight.directSpecular.addAssign(clamp(this.look.spec(L, band.rgb).mul(full).mul(scale * Math.PI), 0, 8)) // 16 let single pixels spike
    }
  }
  indirect(builder: { context: { irradiance?: Node; radiance?: Node; reflectedLight?: Node } }) {
    const { irradiance, radiance, reflectedLight } = builder.context
    if (!irradiance || !reflectedLight) return
    const d = diffuseColor.rgb.mul(irradiance)
    reflectedLight.indirectDiffuse.addAssign(this.look.ao ? d.mul(this.look.ao) : d)
    if (this.look.indirect) reflectedLight.indirectSpecular.addAssign(this.look.indirect)
    if (this.look.env && radiance) reflectedLight.indirectSpecular.addAssign(this.look.env(radiance))
  }
  finish(builder: { context: { outgoingLight?: Node } }) {
    const out = builder.context.outgoingLight
    if (!out) return
    if (this.look.finish) out.rgb.addAssign(this.look.finish)
  }
}

/** Fades rims where the normal turns fast across a pixel (thin creases would sparkle). */
const steady = () => { const dx = dFdx(normalView), dy = dFdy(normalView); return saturate(float(1).sub(max(dot(dx, dx), dot(dy, dy)))) }
const band01 = (fres: Node, power: number, range: number) => smoothstep(0, 1, saturate(pow(fres, power).div(Math.max(1 - range, 1e-4))))

/** Karis's fit of the split-sum environment BRDF: how much of the environment a surface reflects at its f0. */
function envBrdf(f0: Node, rough: Node) {
  const r = rough.mul(vec4(-1, -0.0275, -0.572, 0.022)).add(vec4(1, 0.0425, 1.04, -0.04))
  const nv = saturate(abs(dot(normalView, V())).add(1e-5))
  const a004 = min(r.x.mul(r.x), exp2(nv.mul(-9.28))).mul(r.x).add(r.y)
  const ab = vec2(-1.04, 1.04).mul(a004).add(r.zw)
  return f0.mul(ab.x).add(saturate(f0.y.mul(50)).mul(ab.y))
}

/** The material for one slot. `masked`: cut by alpha at the game's 0.3333. */
export function toonMaterial(kit: Kit, m: Mat, recipe: Recipe, maps: Maps, tint: number[], masked: boolean) {
  const mat = new THREE.MeshStandardNodeMaterial()
  const outside = maps.base ? texture(maps.base, uv()) : vec4(0.6, 0.6, 0.6, 1)
  // a two sided cloth's inside (a cape's lining, a sash's back): its own BackBaseColor on the faces turned away
  const base = maps.fx?.BackBaseColor && m.TwoSided ? select(frontFacing, outside, texture(maps.fx.BackBaseColor, uv())) : outside
  const ndv = max(dot(normalView, V()), 0)
  const bands = (d: number[][]) => ramp(kit, vec(m, ['MC_Shade_0'], d[0]), vec(m, ['MC_Shade_1'], d[1]), vec(m, ['MC_Shade_2'], d[2]), vec(m, ['MC_ShadeSmoothness_3'], d[3]))
  // a missing NormalIntensity counts as 1 (the recipes say 0, flat): only exports made before the kit wrote the
  // master's defaults lack it
  const normalIntensity = num(m, ['NormalIntensity', 'NormalIntensity_b'], 1)
  if (maps.normal) mat.normalNode = normalMap(normalTex(maps.normal), uniform(new THREE.Vector2(normalIntensity, -normalIntensity))) // Unreal's green is flipped
  const opacity = maps.opacity ? texture(maps.opacity, uv()).r : base.a
  if (masked) { mat.opacityNode = opacity; mat.alphaTest = 0.3333 }
  mat.side = m.TwoSided ? THREE.DoubleSide : THREE.FrontSide

  if (recipe === 'eye') {
    // the eye recipe's flat path (the kit exports no eye displacement texture): the iris texture, toon lit, no specular
    const t = vec(m, ['BaseTint'], [1, 1, 1, 0])
    mat.colorNode = /body/i.test(m.Parent ?? '') && t[3] > 0 ? base.rgb.mul(col(t)) : base.rgb
    const lut = bands([[0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], [0.02, 0.02, 0.02, 0]])
    mat.mrtNode = CHARACTER
    // the shadow side's fill, as the body has it (MC_Shade_2's color): without it eyes in shadow went black
    mat.setupLightingModel = () => new ToonModel({ lut, fill: col(vec(m, ['MC_Shade_2'], [0.5, 0.5, 0.5, 0.5])) })
    return mat
  }

  if (recipe === 'hair') return hair(mat, m, maps, base, ndv, bands)

  const generic = recipe === 'generic'
  const albedo = base.rgb.mul(col(tint))
  // edge darken: darker toward the silhouette, only when the material sets it
  const edge = num(m, ['EdgeDarken'], NaN), edgeF = num(m, ['EdgeDarkenFresnel'], NaN)
  const color = Number.isFinite(edge) && Number.isFinite(edgeF) ? albedo.mul(mix(1, 1 - edge, pow(float(1).sub(ndv), Math.max(edgeF, 1e-3)))) : albedo
  mat.colorNode = color
  // ORM: red AO, green roughness, blue metal. A missing RoughnessPower (exports older than the kit's master defaults)
  // counts as 0 (the recipes say 1, fully rough)
  const orm = maps.orm ? texture(maps.orm, uv()) : null
  const rough = orm ? clamp(saturate(orm.g.add(num(m, ['RoughnessPower'], 0))), 0.04, 1) : float(1)
  const metal = orm ? orm.b : float(0)
  const ao = orm ? mix(1, orm.r, num(m, ['AOIntensity'], 0)) : undefined
  const cleanMetal = smoothstep(0.25, 0.5, metal), smooth = float(1).sub(rough)
  const scale = float(1).sub(cleanMetal.mul(0.85)).mul(smooth.mul(smooth).mul(0.25).add(1))
  const lut = bands([[0.76042, 0.76042, 0.76042, 0.8], [0.19792, 0.19792, 0.19792, 0.5], [0.03646, 0.03646, 0.03646, 0.2], [0.2, 0.2, 0.2, 0]])
  const fill = col(vec(m, ['MC_Shade_2'], [0.03646, 0.03646, 0.03646, 0.2]))

  // specular: a GGX lobe from the ORM roughness, plus the specular map's lobe at its own roughness, both banded
  let spec: Look['spec'], env: Look['env']
  const specMul = num(m, ['SpecularMultiplier'], 1)
  mat.roughnessNode = rough // the roughness three blurs the environment by
  if (specMul > 0 || maps.spec) {
    const w = /skin/i.test(m.Parent ?? '') ? saturate(smooth.mul(specMul)) : float(Math.min(1, Math.max(0, specMul * 0.5)))
    const f0 = mix(vec3(0.08).mul(w), color, cleanMetal)
    const r = max(rough, 0.02), a = r.mul(r)
    const st = Math.min(1, Math.max(0.05, num(m, ['ExtraSpecularRoughness'], 1))), st2 = st * st
    const mask = maps.spec ? (() => {
      const k = saturate(saturate(texture(maps.spec, uv()).rgb.mul(col(vec(m, ['ExtraSpecularTint'], [0, 0, 0])))).sub(0.01).mul(1.0101))
      return k.mul(k).mul(vec3(3).sub(k.mul(2)))
    })() : null
    spec = (L, band) => {
      const main = ggx(normalView, L, a, f0)
      return (mask ? main.add(ggx(normalView, L, float(st2), mask)) : main).mul(band)
    }
    if (specMul > 0) env = radiance => radiance.mul(envBrdf(f0, rough))
  }

  // cubemap reflection: the equirect image along the reflection turned about up, at the material's mip, shaped by N.V
  let indirect: Node | undefined
  const cw = num(m, ['CubeMap_Width'], NaN), cr = num(m, ['CubeMap_Roughness'], NaN), ci = num(m, ['CubeMap_Invert'], NaN)
  const ciw = num(m, ['CubeMap_InvertWidth'], NaN), crot = num(m, ['CubeMap_Rotation'], NaN), cns = num(m, ['CubeMap_NormalScale'], NaN)
  const ctint = vec(m, ['CubeMap_RelectionTint'], [])
  if (maps.cube && [cw, cr, ci, ciw, crot, cns].every(Number.isFinite) && ctint.length) {
    maps.cube.wrapS = THREE.RepeatWrapping
    maps.cube.wrapT = THREE.ClampToEdgeWrapping
    maps.cube.needsUpdate = true
    const R = reflect(normalize(cameraPosition.sub(positionWorld)).negate(), normalWorld)
    const c = Math.cos(crot * Math.PI * 2), s = Math.sin(crot * Math.PI * 2)
    const Rr = vec3(R.x.mul(c).sub(R.z.mul(s)), R.y, R.x.mul(s).add(R.z.mul(c)))
    const cubeEnv = texture(maps.cube, vec2(atan(Rr.x.negate(), Rr.z).div(Math.PI * 2), float(1).sub(clamp(Rr.y, -1, 1).acos().div(Math.PI)))).level(cr).rgb
    const n = max(ndv.mul(1 + cns), 0)
    const w = cw === 0 ? float(1) : pow(clamp(float(1).sub(n), cw < 0 ? 1e-4 : 0, 1), cw)
    const iw = ciw === 0 ? float(1) : pow(clamp(float(1).sub(w), ciw < 0 ? 1e-4 : 0, 1), ciw)
    indirect = cubeEnv.mul(col(ctint)).mul(mix(w, iw, ci)).mul(maps.cubeMask ? texture(maps.cubeMask, uv()).r : 1)
    env = undefined // the cube map replaces the environment's reflection
  }

  // rims: a front rim toward the material's direction (Unreal axes, y and z swapped) and a back rim away from it
  const fres = max(abs(float(1).sub(abs(dot(normalView, V())))), 1e-5)
  const rimMask = maps.rimMask ? texture(maps.rimMask, uv()).r : float(1)
  const d = vec(m, ['RimLightDirection'], [0, 0, 0]), dl = Math.hypot(d[0], d[1], d[2])
  const rimRange = num(m, ['RimRange'], generic ? 0 : 0.4)
  const rimColor = rimRange > 1e-3 ? vec(m, ['RimLightColor'], [0, 0, 0]) : [0, 0, 0]
  const facing = dl ? dot(normalWorld, vec3(d[0] / dl, d[2] / dl, d[1] / dl)) : float(0)
  const front = col(rimColor).mul(band01(fres, num(m, ['RimFresnelPower'], generic ? 1 : 5), rimRange)).mul(dl ? saturate(facing) : 0)
  const backSide = dl ? float(1).sub(smoothstep(0, 1, saturate(facing.add(1)))) : float(1)
  const back = col(vec(m, ['BackRimColor'], [0, 0, 0])).mul(band01(fres, num(m, ['BackFresnelPower'], 5), num(m, ['BackRimRange'], 0.4))).mul(backSide)
  let finish = front.add(back).mul(rimMask).mul(steady())

  // base glow (the albedo lit by itself) and emissive: the material's emissive map times its color and strength
  const strength = num(m, ['EmissiveStrength', 'EmissiveStrengthR'], 0), glowPower = num(m, ['BaseGlowPower'], 0)
  const emissiveColor = vec(m, ['EmissiveColor', 'EmissiveColorR'], generic ? [0, 0, 0, 0] : [1, 1, 1, 0])
  const glowColor = strength > 1 ? vec(m, ['BaseGlowColor', 'EmissiveColor'], [1, 1, 1]) : vec(m, ['BaseGlowColor'], [0, 0, 0])
  if (glowPower > 0) finish = finish.add(albedo.mul(col(glowColor)).mul(float(1).sub(metal)))
  if (strength > 0 && maps.emissive) mat.emissiveNode = texture(maps.emissive, uv()).rgb.mul(col(emissiveColor)).mul(strength)

  mat.mrtNode = CHARACTER
  mat.setupLightingModel = () => new ToonModel({ lut, scale, spec, indirect, ao, finish, env, fill })
  return mat
}

/** Hair: the albedo overlaid with its shadow color (second UV set), toon diffuse less the scatter, anisotropic GGX
 *  along the strands shifted by the shift map, its energy remapped and capped by the specular limit, view-space rims. */
function hair(mat: InstanceType<typeof THREE.MeshStandardNodeMaterial>, m: Mat, maps: Maps, base: Node, ndv: Node, bands: (d: number[][]) => unknown) {
  // the strand id map (Unique_Hair_Value): picks one of eight ColorIdTint colors, and turns the strands' tangent
  const idMap = maps.fx?.Unique_Hair_Value
  const id = idMap ? texture(idMap, uv()).r : float(1)
  let tinted: Node = base.rgb
  const tints = Array.from({ length: 8 }, (_, i) => vec(m, [`ColorIdTint${i}`], [1, 1, 1]))
  if (idMap && tints.some(c => Math.abs(c[0] - 1) + Math.abs(c[1] - 1) + Math.abs(c[2] - 1) > 0.01)) {
    const slot = floor(saturate(id).mul(7).add(0.5))
    let tint: Node = col(tints[0])
    for (let i = 1; i < 8; i++) tint = mix(tint, col(tints[i]), step(i - 0.5, slot))
    tinted = tinted.mul(tint)
  }
  let albedo = saturate(tinted.mul(col(vec(m, ['BaseTint'], [1, 1, 1]))).mul(Math.max(num(m, ['Color Boost'], 1), 1)))
  if (maps.shadow) {
    const b = texture(maps.shadow, uv(1)).rgb.mul(col(vec(m, ['ShadowTint'], [1, 1, 1])))
    albedo = saturate(mix(albedo.mul(b).mul(2), float(1).sub(float(1).sub(albedo).mul(float(1).sub(b)).mul(2)), step(0.5, albedo)))
  }
  const keep = Math.max(0, 1 - num(m, ['Scatter'], 0.2))
  mat.colorNode = albedo
  const orm = maps.orm ? texture(maps.orm, uv()) : null
  const rough = saturate(pow(max(float(1).sub(ndv), 1e-4), Math.max(num(m, ['EdgeRoughnessFresnel'], 6.7619), 1e-3))
    .mul(num(m, ['EdgeRoughnessPower'], 1)).add(orm ? orm.g : num(m, ['RoughnessPower'], 0)))
  const ao = orm ? mix(1, orm.r, num(m, ['AOIntensity'], 0)) : undefined
  const soft = vec(m, ['MC_ShadeSmoothness_3'], [0.2, 0.2, 0.2, 0])
  const lut = bands([[0.76042, 0.76042, 0.76042, 0.8], [0.19792, 0.19792, 0.19792, 0.5], [0.03646, 0.03646, 0.03646, 0.2], soft])
  const fill = col(vec(m, ['MC_Shade_2'], [0.03646, 0.03646, 0.03646, 0.2]))

  const limit = num(m, ['SpecularLimit'], 1), sw = soft[3], dir = num(m, ['Anisotropy Direction'], -0.9)
  const sp = num(m, ['SpecularShiftPower'], 0), extra = 0
  let spec: Look['spec']
  if (limit > 1e-4) {
    const t = vec(m, ['Tangent'], [0, -1, 0]), ta = vec(m, ['TangentA'], [0, 0, 0.3]), tb = vec(m, ['TangentB'], [0, 0, -0.3])
    const N = normalView
    // the master's tangent turned by the strand id (TangentA at id 0 to TangentB at 1), in tangent space
    const f = vec3(t[0], t[1], t[2]).add(mix(vec3(ta[0], ta[1], ta[2]), vec3(tb[0], tb[1], tb[2]), id))
    const t0 = normalize(tangentView.mul(f.x).add(bitangentView.mul(f.y)).add(N.mul(f.z)))
    const T0 = normalize(t0.sub(N.mul(dot(N, t0))))
    const hm = maps.shift ? texture(maps.shift, uv(2)).r : float(0.5)
    // the highlight's cap: SpecularLimit, lowered where the AnisotropyBrightness map (second UV set) is dark
    const ceiling = maps.fx?.AnisotropyBrightness ? saturate(texture(maps.fx.AnisotropyBrightness, uv(1)).r.mul(limit)) : float(limit)
    const shift = saturate(hm.mul(sp).add(0.5 - sp * 0.5 + extra)).mul(2).sub(1)
    spec = (L, band) => {
      const v = V(), B = normalize(cross(N, T0)), Ns = normalize(N.add(T0.mul(shift))), T = normalize(cross(Ns, B))
      const H = normalize(L.add(v)), NoL = max(dot(N, L), 0), NoV = saturate(abs(dot(Ns, v)).add(1e-4))
      const r = max(rough, 0.02), a = r.mul(r), at = max(a.mul(1 + dir), 1e-3), ab = max(a.mul(1 - dir), 1e-3), a2 = at.mul(ab)
      const q = vec3(dot(T, H).mul(ab), dot(B, H).mul(at), dot(Ns, H).mul(a2)), w2 = a2.div(max(dot(q, q), 1e-7))
      const D = w2.mul(w2).mul(a2).div(Math.PI)
      const gv = length(vec3(at.mul(dot(T, L)), NoL, ab.mul(dot(B, L)))), gl = length(vec3(at.mul(dot(T, v)), NoV, ab.mul(dot(B, v))))
      const vis = float(0.5).div(max(gv.mul(NoV).add(gl.mul(NoL)), 1e-4))
      const fc = pow(float(1).sub(max(dot(v, H), 0)), 5)
      const Y = D.mul(vis).mul(vec3(saturate(albedo.y.mul(50))).mul(fc).add(albedo.mul(float(1).sub(fc)))).mul(band)
      const lum = saturate(dot(Y, vec3(0.3, 0.59, 0.11))).add(1e-4)
      return Y.mul(clamp(mix(-0.01 * sw, sw + 1, lum), 0, ceiling).div(lum))
    }
  }

  // rims: the direction is in view space, taken to world by the camera
  const fres = max(float(1).sub(saturate(ndv)), 1e-4)
  const rb = (p: number, range: number) => smoothstep(0, 1, saturate(pow(fres, Math.max(p, 1e-3)).div(1 - Math.min(Math.max(range, 0), 0.999))))
  const d = vec(m, ['RimLightDirection'], [0, 0, 1])
  const facing = d[0] || d[1] || d[2] ? dot(normalize(cameraWorldMatrix.mul(vec4(d[0], d[1], -d[2], 0)).xyz), normalWorld) : float(1)
  const front = col(vec(m, ['RimLightColor'], [0, 0, 0])).mul(rb(num(m, ['RimFresnelPower'], 5), num(m, ['RimRange'], 0.4))).mul(saturate(facing))
  const back = col(vec(m, ['BackRimColor'], [0, 0, 0])).mul(rb(num(m, ['BackFresnelPower'], 5), num(m, ['BackRimRange'], 0.4)))
    .mul(float(1).sub(smoothstep(0, 1, saturate(facing.add(1)))))
  let finish = front.add(back).mul(steady())
  if (num(m, ['BaseGlowPower'], 0) > 0) finish = finish.add(base.rgb.mul(col(vec(m, ['BaseGlowColor'], [0, 0, 0]))))
  const strength = num(m, ['EmissiveStrength'], 0)
  if (strength > 0 && maps.emissive) mat.emissiveNode = texture(maps.emissive, uv(1)).rgb.mul(col(vec(m, ['EmissiveColor'], [1, 1, 1]))).mul(strength)

  mat.mrtNode = CHARACTER
  mat.setupLightingModel = () => new ToonModel({ lut, scale: float(keep), spec, ao, finish, fill })
  return mat
}

/** Normals averaged over vertices that share a position, so the hull does not split along UV seams. */
function weldedNormals(g: InstanceType<typeof THREE.BufferGeometry>) {
  const pos = g.attributes.position, nrm = g.attributes.normal, groups = new Map<string, number[]>()
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`
    const list = groups.get(k)
    if (list) list.push(i); else groups.set(k, [i])
  }
  const out = new Float32Array(pos.count * 3), v = new THREE.Vector3()
  for (const list of groups.values()) {
    v.set(0, 0, 0)
    for (const i of list) v.set(v.x + nrm.getX(i), v.y + nrm.getY(i), v.z + nrm.getZ(i))
    if (v.lengthSq() > 1e-10) v.normalize()
    for (const i of list) out.set([v.x, v.y, v.z], i * 3)
  }
  const shell = new THREE.BufferGeometry()
  for (const [name, attr] of Object.entries(g.attributes)) shell.setAttribute(name, name === 'normal' ? new THREE.BufferAttribute(out, 3) : attr)
  if (g.index) shell.setIndex(g.index)
  shell.morphAttributes = g.morphAttributes
  shell.morphTargetsRelative = g.morphTargetsRelative
  return shell
}

/** The outline: a back-facing copy of the mesh pushed out along its normals, drawn black just behind the surface. Its
 *  width follows vertex color G like the game's (the face and gems carry little or none, the body 0.05 to 0.3): 3 px of
 *  a 1080 px tall view at G 0.15 from the start view, at most twice that, and a fixed size on the model, so it thins as
 *  the camera backs off (kit.outlineDist: the start view's distance) and grows at most 1.5x zoomed in. A mesh without
 *  vertex colors draws the G 0.15 width. `source`: the slot's material, whose alpha cut the outline keeps. */
export function outlineShell(kit: Kit, mesh: InstanceType<typeof THREE.Mesh>, source: InstanceType<typeof THREE.MeshStandardNodeMaterial>) {
  const g = mesh.geometry
  if (!mesh.parent || !g.hasAttribute('normal')) return
  const mat = new THREE.NodeMaterial()
  mat.vertexNode = Fn(() => {
    const mvp = cameraProjectionMatrix.mul(modelViewMatrix)
    const p = mvp.mul(vec4(positionLocal, 1)), q = mvp.mul(vec4(positionLocal.sub(normalLocal), 1))
    // 3 px at the start view, as measured on the game's Hero Profile (2 to 5 px on arms, waist, and legs: G 0.1 to 0.3)
    const width = g.hasAttribute('color') ? attribute('color', 'vec4').y.div(0.15).min(2) : float(1)
    return p.add(normalize(p.sub(q)).mul(3 * 2 / 1080).mul(min(kit.outlineDist, p.w.mul(1.5))).mul(width).mul(kit.outline))
  })()
  mat.colorNode = vec4(0, 0, 0, 1)
  mat.emissiveNode = vec3(0) // the bloom pass reads emissive: WebGL 2 leaves it unset otherwise
  mat.depthNode = viewZToPerspectiveDepth(positionView.z.sub(0.005), cameraNear, cameraFar)
  mat.side = THREE.BackSide
  if (source.alphaTest > 0 && source.opacityNode) { mat.opacityNode = source.opacityNode; mat.alphaTest = source.alphaTest }
  const geo = weldedNormals(g)
  const skinned = (mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh
  const shell = skinned ? new THREE.SkinnedMesh(geo, mat) : new THREE.Mesh(geo, mat)
  if (skinned) shell.bind(mesh.skeleton, mesh.bindMatrix)
  if (mesh.morphTargetInfluences) { shell.morphTargetInfluences = mesh.morphTargetInfluences; shell.morphTargetDictionary = mesh.morphTargetDictionary }
  shell.position.copy(mesh.position); shell.quaternion.copy(mesh.quaternion); shell.scale.copy(mesh.scale)
  shell.name = `${mesh.name}__outline`
  kit.shells.push(shell)
  shell.visible = Boolean(kit.outline.value)
  shell.frustumCulled = false
  shell.userData.outline = true
  mesh.parent.add(shell)
  kit.owned.push(mat, geo)
}
