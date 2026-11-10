// repakxtra: Rotate in 3D's special materials, each drawn the way the game's own master builds it from the slot's
// material file: the crystal (White Fox's cosmic tails), the fox tail flame, the flipbook effects (lobby flames and
// wisps), translucent hair cards, the eye shadow, and the eye's catchlight card. Effects are unlit and feed the bloom.
import * as THREE from 'three/webgpu'
import {
  float, vec2, vec3, vec4, texture, uv, dot, max, pow, saturate, mix, smoothstep, step, normalize, reflect, abs, atan, clamp,
  floor, fract, time, cameraPosition, positionWorld, positionLocal, normalLocal, normalWorld, normalView, positionView, tangentWorld, luminance, normalMap, uniform, attribute,
} from 'three/tsl'
import { num, vec, col, galaxyLayer, normalTex, CHARACTER, NO_RIM, type Mat, type Tex, type Node, type Kit } from './toon'

/** A static switch of the instance, else `d` (the kit writes only the switches an instance sets itself). */
const on = (m: Mat, name: string, d: boolean) => m.Parameters?.Switches?.[name] ?? d
const translucent = (m: Mat) => /Translucent|Additive/.test(m.BlendMode ?? '') || Boolean(m.Parameters?.IsTranslucent)
const smooth01 = (x: Node) => smoothstep(0, 1, saturate(x))
/** uv turned by `deg` degrees about the middle of the tile. */
const turned = (p: Node, deg: number) => {
  if (!deg) return p
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), q = p.sub(0.5)
  return vec2(q.x.mul(c).sub(q.y.mul(s)), q.x.mul(s).add(q.y.mul(c))).add(0.5)
}
/** An equirect image read along a world direction. */
const along = (t: NonNullable<Tex>, R: Node) => {
  t.wrapS = THREE.RepeatWrapping
  t.needsUpdate = true
  return texture(t, vec2(atan(R.x.negate(), R.z).div(Math.PI * 2), float(1).sub(clamp(R.y, -1, 1).acos().div(Math.PI)))).rgb
}

export const isCrystal = (m: Mat) => /^M_(Common|\d+)_(Crystal|Gem)/i.test(m.Parent ?? '') && !/^M_Common_Crystal$/i.test(m.Parent ?? '')
export const isFoxTail = (m: Mat) => /^M_\d+FoxTail$/i.test(m.Parent ?? '') && Boolean(m.Textures?.SequencesTex)
export const isFlipbook = (m: Mat) => Boolean(m.Textures?.SequencesTex) && num(m, ['USequences'], 0) > 0 && num(m, ['VSequences'], 0) > 0
export const isHairCard = (m: Mat, name: string) => translucent(m) && /eyeshadow|translucent/i.test(m.Parent ?? '') && /hair/i.test(name + ' ' + (m.Parent ?? ''))
export const isEyeShadow = (m: Mat) => /fakeeyeshadow/i.test(m.Parent ?? '')
export const isEyeGlint = (m: Mat) => /eyes?highlight|simpleglass.*eye/i.test(m.Parent ?? '')

/** The crystal master (M_<skin>_Crystal: White Fox's cosmic tails): lit like a plain surface, and on top of that it
 *  glows with its own color plus what a crystal catches: its cube map along the reflection (tone mapped, by BaseTex's
 *  red), a sparkle from a second facet normal (DiaColorTex), its rim lines (RimLine in RimLightColor), all scaled by
 *  the brightness mask (BaseTex's green), and the galaxy seen through it. No refraction: the master has none. */
export function crystalMaterial(m: Mat, t: { diffuse: Tex; normal: Tex; cube: Tex; base: Tex; dia: Tex; rimLine: Tex }, fx: Record<string, Tex>, masked: boolean) {
  const mat = new THREE.MeshStandardNodeMaterial()
  if (t.normal) mat.normalNode = normalMap(normalTex(t.normal), uniform(new THREE.Vector2(1, -1)))
  const V = normalize(cameraPosition.sub(positionWorld)), N = normalWorld
  const edge = saturate(float(1).sub(saturate(dot(N, V))))
  const d = t.diffuse ? texture(t.diffuse, uv()) : vec4(1)
  const albedo = d.rgb.mul(col(vec(m, ['BaseColor'], [1, 1, 1]).map(x => Math.min(x, 1))))
  mat.colorNode = albedo
  mat.roughnessNode = float(0.5)
  mat.metalnessNode = float(0)
  const mask = t.base ? texture(t.base, uv()) : vec4(1)
  let extra: Node = vec3(0)
  if (t.cube) {
    const env = along(t.cube, reflect(V.negate(), N))
    const w = num(m, ['cubeMapWidth', 'CubeMapWidth'], 0.8)
    const shape = mix(mask.r, 1, pow(max(edge, 1e-4), w <= 0.01 ? 1 : w).mul(mask.r).mul(0.3))
    extra = env.div(env.add(1)).mul(shape).mul(num(m, ['cubeMapStrength', 'CubeMapStrength'], 0.7))
    if (t.dia) { // the facets: the same sky along a second normal, as one brightness in the crystal's color
      const n2 = texture(t.dia, uv()).rgb.mul(2).sub(1)
      const N2 = normalize(N.add(tangentWorld.mul(n2.x)).add(normalize(N.cross(tangentWorld)).mul(n2.y)))
      extra = extra.add(col(vec(m, ['Cyr_BaseColor'], [1, 1, 1]).map(x => Math.min(x, 1))).mul(saturate(luminance(along(t.cube, reflect(V.negate(), N2))))))
    }
  }
  const rc = vec(m, ['RimLightColor'], [1, 1, 1]), top = Math.max(rc[0], rc[1], rc[2], 1e-4)
  const rimShape = t.rimLine ? texture(t.rimLine, uv()).r : pow(max(edge, 1e-4), Math.max(num(m, ['RimFresnelPower'], 5), 1.5))
  extra = extra.add(col([rc[0] / top, rc[1] / top, rc[2] / top]).mul(rimShape).mul(Math.max(num(m, ['RimRange'], 0.4), 0) * Math.min(top, 1)))
  const e = num(m, ['EmissionWeight'], 0.4), hi = num(m, ['Cyr_Base_High'], e), lo = num(m, ['Cyr_Base_Low'], e)
  const bright = pow(max(mask.g, 1e-8), num(m, ['Cyr_DarkNum'], 0.5)).mul(hi).add(lo)
  let glow: Node = albedo.add(extra.mul(bright))
  if (fx.GalaxyTex1) glow = glow.add(galaxyLayer(m, fx))
  mat.emissiveNode = glow
  if (masked) { mat.opacityNode = d.a; mat.alphaTest = 0.3333 }
  mat.mrtNode = CHARACTER
  return mat
}

/** The flipbook frame at the master's rate (BP_PlaySpeed x 0.25 x frames a second, one frame faded into the next),
 *  read at `local` inside each cell. Returns the sheet's sample. */
function sheet(m: Mat, seq: NonNullable<Tex>, local: Node, speed: number) {
  const U = Math.max(1, Math.round(num(m, ['USequences'], 1))), W = Math.max(1, Math.round(num(m, ['VSequences'], 1)))
  const N = U * W, P = Math.max(N - num(m, ['LastBlankNumber'], 0), 1)
  const pos = fract(time.mul((num(m, ['BP_PlaySpeed'], speed) * 0.25 * N) / P)).mul(P)
  const cell = (i: Node) => vec2(i.mod(U).add(local.x).div(U), floor(i.div(U)).add(local.y).div(W))
  const a = floor(pos), b = a.add(1).mod(P)
  return mix(texture(seq, cell(a)), texture(seq, cell(b)), fract(pos))
}

/** The three step ramp every flipbook master colors with: where the driver passes each Step (softened by its
 *  Smooth) the next color takes over. Returns the bands (1: outer, 2: body, 3: core) and the three smooth steps. */
function steps(m: Mat, x: Node, prefix = '') {
  const s = (i: number, d: number, ds: number) => smooth01(float(num(m, [`${prefix}Step${i}`], d)).sub(x).div(Math.max(num(m, [`${prefix}Step${i}_Smooth`], ds), 1e-5)))
  const s1 = s(1, 1, 0.1), s2 = s(2, 0.6, 0.1), s3 = s(3, 0.06, 0.1)
  return { s1, s2, s3, b1: saturate(s1.sub(s2)), b2: saturate(s2.sub(s3)), b3: saturate(s3) }
}

/** The liner color: a gradient across the mesh's own UV (turned by LinerColorRotate) between LinerColor02 and 01. */
function liner(m: Mat) {
  const r = (num(m, ['LinerColorRotate'], 0) * Math.PI) / 180, o = vec(m, ['LinerColor_Offset&Softness'], [1, 1, 0.5, 0.5])
  const q = dot(uv().sub(0.5), vec2(Math.cos(r), -Math.sin(r))).add(0.5)
  const w = smooth01(float(o[0]).sub(q).div(Math.max(o[1], 1e-5)))
  const lightness = num(m, ['Lightness'], 0)
  const tone = lightness ? pow(max(saturate(q), 1e-5), lightness) : step(1e-5, q)
  return { color: mix(col(vec(m, ['LinerColor02'], [0, 0, 0])), col(vec(m, ['LinerColor01'], [1, 1, 1])), w).mul(tone), q }
}

/** The length fade along the mesh's V (Linear_A, Linear_B and their hardness). */
function lengthFade(m: Mat, c: Node) {
  const a = saturate(c.sub(1).add(num(m, ['Linear_A'], 1)).div(Math.max(num(m, ['Linear_A_Hardness'], 0.2), 1e-5)))
  const b = saturate(float(num(m, ['Linear_B'], 1)).sub(c).div(Math.max(num(m, ['Linear_B_Hardness'], 0.2), 1e-5)))
  return { a, b }
}

function effect(color: Node, alpha: Node, m: Mat, cut: boolean) {
  const mat = new THREE.MeshBasicNodeMaterial({ side: m.TwoSided ? THREE.DoubleSide : THREE.FrontSide })
  if (cut) { // an opaque or masked effect: its glow as the color, cut where it fades out
    mat.colorNode = vec4(color, 1)
    mat.opacityNode = alpha
    mat.alphaTest = 0.3333
  } else { // a translucent one: added on top as light
    mat.colorNode = vec4(color.mul(alpha), 1)
    mat.transparent = true
    mat.depthWrite = false
    mat.blending = THREE.AdditiveBlending
  }
  mat.emissiveNode = cut ? color : color.mul(alpha)
  mat.mrtNode = NO_RIM
  mat.userData.fire = true // casts no shadow, takes no rim
  return mat
}

/** The fox tail flame (M_1060FoxTail: White Fox's lobby tails): two turned copies of the flipbook multiplied, so it
 *  lights only where both overlap, colored by the three steps under the liner gradient, plus the master's own edge
 *  glow and tip glow, a little desaturated, fading out along its length. shortcut: its flow noise layer and its fire
 *  rim need textures the kit does not export (LineTex, ColorTex, NoiseTex, FireTex02), they are left out */
export function foxTailMaterial(m: Mat, seq: NonNullable<Tex>) {
  seq.wrapS = seq.wrapT = THREE.RepeatWrapping
  seq.needsUpdate = true
  const tile = vec(m, ['UVS_BaseTexture'], [1, 0.9, 0, 0]), scope = num(m, ['UseRepeatTile_Scope'], 0.55), sharp = num(m, ['UseRepeatTile_Sharpness'], 1)
  const layer = (key: string, d: number[]) => {
    const o = vec(m, [key], d)
    const p = fract(turned(uv().mul(vec2(tile[0], tile[1])).add(vec2(tile[2], tile[3]).mul(time)).add(vec2(o[0], o[1])), o[2]))
    const s = sheet(m, seq, p, 2.5)
    const win = (e: Node) => saturate(float(1).sub(abs(float(0.5).sub(e)).mul(scope)).mul(sharp))
    return s.g.add(s.a).mul(0.5).mul(win(p.x)).mul(win(p.y))
  }
  const x = saturate(float(1).sub(layer('UV_OffsetR_BaseTexture', [-0.25, 0.1, 180, 0]).mul(layer('UV_OffsetR_BaseTexture02', [0.25, 0.1, 180, 0]))))
  const k = steps(m, x), c = (i: number, d: number[]) => col(vec(m, [`Step${i}Color`], d))
  const stepColor = c(1, [0, 0.75, 0.75]).mul(saturate(float(1).sub(k.s2))).add(c(2, [0, 1, 1]).mul(k.b2)).add(c(3, [0, 1, 1]).mul(k.b3))
  const l = liner(m), v = uv().y
  const fres = max(abs(float(1).sub(max(dot(normalView, normalize(positionView.negate())), 0))), 1e-5)
  const f5 = pow(fres, 5)
  const edgeGlow = vec3(f5.mul(4.95).add(0.05), f5.mul(3.1812).add(0.0321), f5.mul(0.3352).add(0.0034))
  const tip = vec3(0, 3.82805, 4).mul(saturate(pow(fres, 1.5).mul(0.96).add(0.04).mul(7).sub(3))).mul(smooth01(v.sub(0.4).mul(1.66667)))
  const sum = edgeGlow.add(tip).add(l.color.mul(stepColor).mul(saturate(l.q.add(0.5)))).mul(num(m, ['EmissiveColorStrength'], 1))
  const color = mix(sum, vec3(luminance(sum)), num(m, ['FX_DesaturationDiss', 'FX_Desaturation'], 0.4))
  const f = lengthFade(m, v), strength = num(m, ['Linear_Strength'], 1)
  if (translucent(m)) return effect(color, f.a.mul(f.b).pow(2).mul(strength), m, false)
  const sm = (e: Node) => e.mul(e).mul(float(3).sub(e.mul(2)))
  return effect(color, sm(f.a).mul(sm(f.b)).mul(strength).sub(0.0834), m, true)
}

/** A flipbook effect (M_StdMoAni and its kin: the lobby flames and wisps around a hero): the sheet's green drives
 *  either a flat tint (BaseColor) or the three step ramp, under the liner gradient, cut by the length fade, the
 *  Mask, and the mesh's vertex alpha. shortcut: its dissolve, depth fade, distance fade and vertex offset (the strip
 *  that turns to the camera) are left out, so a strip effect shows at its mesh's own width */
export function flipbookMaterial(m: Mat, seq: NonNullable<Tex>, mask: Tex, hasVertexColor: boolean) {
  const tile = vec(m, ['UVS_BaseTexture'], [1, 1, 0, 0]), o = vec(m, ['UV_OffsetR_BaseTexture'], [0, 0, 0, 0])
  const local = turned(uv().mul(vec2(tile[0], tile[1])).add(vec2(o[0], o[1])), o[2])
  const p = pow(max(sheet(m, seq, local, 3).g, 1e-7), num(m, ['SequencesTex_Power'], 1)).mul(num(m, ['SequencesTex_Strength'], 1))
  let color: Node, alpha: Node
  if (on(m, 'Use3Smooth', true)) {
    const k = steps(m, float(1).sub(p)), c = (i: number, d: number[]) => vec(m, [`Step${i}Color`], d)
    const first = on(m, 'UsePureColor', true) ? saturate(float(1).sub(k.s2)) : k.b1
    color = col(c(1, [1, 0, 0])).mul(first).add(col(c(2, [0, 1, 0])).mul(k.b2)).add(col(c(3, [0, 0, 1])).mul(k.b3)).mul(c(3, [0, 0, 1, 1])[3] ?? 1)
    alpha = saturate(k.b1.mul(num(m, ['Step1_Alpha'], 1)).add(k.b2.mul(num(m, ['Step2_Alpha'], 1))).add(k.b3.mul(num(m, ['Step3_Alpha'], 1))))
  } else {
    alpha = saturate(p)
    color = col(vec(m, ['BaseColor'], [1, 1, 1])).mul(alpha)
  }
  if (on(m, 'UseLinerColor', true)) color = color.mul(liner(m).color)
  color = color.mul(num(m, ['EmissiveColorStrength'], 1))
  if (on(m, 'UseLinearMask', true)) {
    const f = lengthFade(m, on(m, '13LinearMaskRotate', false) ? uv().x : uv().y)
    alpha = alpha.min(smooth01(f.a).mul(smooth01(f.b)).mul(num(m, ['Linear_Strength'], 1)))
  }
  if (mask && on(m, 'UseMask', false)) {
    const mt = vec(m, ['UV_TilingR_Mask'], [1, 1, 0, 0]), ms = vec(m, ['UV_S_O_Mask'], [0, 0, 0, 0])
    const muv = turned(uv().mul(vec2(mt[0], mt[1])).add(vec2(ms[2], ms[3])).add(vec2(ms[0], ms[1]).mul(time)), mt[2])
    alpha = alpha.mul(pow(max(texture(mask, muv).g, 1e-7), num(m, ['Mask_Power'], 1)).mul(num(m, ['Mask_Strength'], 1)))
  }
  const see = translucent(m)
  if (see && hasVertexColor) alpha = alpha.mul(attribute('color', 'vec4').a)
  return effect(color, saturate(alpha), m, !see)
}

/** A translucent hair card (M_Common_Translucent_Lobby on a hair slot): the hair recipe's own material, blended by
 *  its opacity mask on top of the opaque hair, writing no depth and casting no shadow. */
export function asHairCard(mat: InstanceType<typeof THREE.MeshStandardNodeMaterial>, base: Tex, opacity: Tex) {
  mat.transparent = true
  mat.depthWrite = false
  mat.alphaTest = 0
  mat.opacityNode = opacity ? texture(opacity, uv()).r : base ? texture(base, uv()).a : float(1)
  mat.userData.fire = true // casts no shadow
  mat.userData.order = 2
  return mat
}

const FUR_LAYERS = 12
/** The fur master's coat (M_<hero>_Fur: FurLength in cm, the strand pattern tiled by UV_Scale, the LDTG map's red as
 *  the length): the mesh drawn again in FUR_LAYERS shells pushed out along its normals, each kept only where the
 *  strand pattern is higher than the shell stands, so strands thin toward their tips. shortcut: no combing (the
 *  flow map), and the density, thickness, and growth maps are not read */
export function furShells(kit: Kit, mesh: InstanceType<typeof THREE.Mesh>, m: Mat, make: () => InstanceType<typeof THREE.MeshStandardNodeMaterial>, pattern: Tex, ldtg: Tex) {
  if (!mesh.parent || !pattern) return
  pattern.wrapS = pattern.wrapT = THREE.RepeatWrapping
  pattern.needsUpdate = true
  const len = num(m, ['FurLength'], 3) * 0.01, tile = vec(m, ['UV_Scale'], [11, 11])
  const skinned = (mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh
  for (let i = 1; i <= FUR_LAYERS; i++) {
    const t = i / FUR_LAYERS, mat = make()
    mat.positionNode = positionLocal.add(normalLocal.mul((ldtg ? texture(ldtg, uv()).r : float(1)).mul(len * t)))
    mat.opacityNode = texture(pattern, uv().mul(vec2(tile[0], tile[1]))).r
    mat.alphaTest = t * 0.9
    mat.userData.fire = true // casts no shadow
    const shell = skinned ? new THREE.SkinnedMesh(mesh.geometry, mat) : new THREE.Mesh(mesh.geometry, mat)
    if (skinned) shell.bind(mesh.skeleton, mesh.bindMatrix)
    shell.position.copy(mesh.position); shell.quaternion.copy(mesh.quaternion); shell.scale.copy(mesh.scale)
    shell.frustumCulled = false
    mesh.parent.add(shell)
    kit.owned.push(mat)
  }
}

/** The shadow over the eye (M_Common_FakeEyeShadow): no texture, one flat ShadowColor whose strength comes from the
 *  card's own UV: toward its sides (WidthRange) and along its height (HeightRange), whichever is lower. */
export function eyeShadowMaterial(m: Mat) {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide })
  const range = (x: Node, lo: number, hi: number) => saturate(x.sub(lo).div(Math.max(hi - lo, 1e-3)))
  const w = smoothstep(0, 1, range(abs(uv().x.mul(2).sub(1)), num(m, ['WidthRangeMin'], 0), num(m, ['WidthRangeMax'], 1)))
  const h = range(uv().y, num(m, ['HeightRangeMin'], 0), num(m, ['HeightRangeMax'], 1))
  const hh = mix(smoothstep(0, 1, h), pow(max(h, 1e-5), num(m, ['HeightLinearPower'], 2.2)), num(m, ['Height - UseLinearGradient', 'Height_UseLinearGradient'], 0))
  const flip = (x: Node, k: number) => (k > 0 ? float(1).sub(x) : x)
  const alpha = flip(w, num(m, ['ReverseWidth'], 0)).min(flip(hh, num(m, ['ReverseHeight'], 0))).mul(num(m, ['Height - TotalOpacity', 'Height_TotalOpacity'], 1))
  mat.colorNode = vec4(col(vec(m, ['ShadowColor'], [0, 0, 0])), saturate(alpha))
  mat.emissiveNode = vec3(0)
  mat.mrtNode = NO_RIM
  mat.userData.fire = true
  return mat
}

/** The eye's catchlight card (M_SimpleGlass_EyesHighLight): a white glint from its HighlightMask, added over the eye.
 *  shortcut: steady, the master also slides and dims it as the camera turns */
export function eyeGlintMaterial(m: Mat, mask: Tex) {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
  const o = vec(m, ['UVOffset'], [0, 0, 0])
  const k = (mask ? texture(mask, vec2(uv().x.add(o[0]).mul(num(m, ['TileX'], 1)), uv().y.add(o[1]).mul(num(m, ['TileY'], 1)))).r : float(1)).mul(num(m, ['HighlightIntensity'], 1))
  mat.colorNode = vec4(vec3(k).mul(num(m, ['Opacity_HighLight'], 0.5)), 1)
  mat.emissiveNode = vec3(0)
  mat.polygonOffset = true
  mat.polygonOffsetFactor = mat.polygonOffsetUnits = -4
  mat.mrtNode = NO_RIM
  mat.userData.fire = true
  mat.userData.order = 1
  return mat
}
