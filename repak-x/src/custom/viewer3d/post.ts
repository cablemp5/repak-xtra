// repakxtra: Rotate in 3D's post chain, in the order the game's lobby runs it: the show rim light (the skin's
// M_RimLight_PP values), bloom from the emissive pass (six Gaussian levels at the lobby's 1.05), the lobby grade, the
// lobby volume's vignette (0.5), Unreal's tonemapper with the lobby's color correction (saturation 1.06, highlights
// gain 1.03 and offset 0.05) inside its filmic curve (ACES AP1, blue correction, gamut expansion), CAS sharpening, and
// a dither so dark gradients do not band.
import * as THREE from 'three/webgpu'
import {
  Fn, float, vec2, vec3, vec4, uniform, pass, mrt, output, emissive, screenUV, screenSize, screenCoordinate, dot, max, min,
  clamp, saturate, mix, smoothstep, step, sqrt, abs, sign, exp, log, atan, length, fract, select, convertToTexture,
  normalize, pow, fwidth,
} from 'three/tsl'
import type { ShowRim } from './toon'
import { gaussianBlur } from 'three/examples/jsm/tsl/display/GaussianBlurNode.js'

type Node = ReturnType<typeof float>
type M3 = number[][]

const mul3 = (a: M3, b: M3) => a.map(r => [0, 1, 2].map(j => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]))
const apply = (m: M3, v: Node) => vec3(dot(vec3(...m[0]), v), dot(vec3(...m[1]), v), dot(vec3(...m[2]), v))
// ACES and Unreal color matrices (TonemapCommon.ush)
const AP0_2_AP1 = [[1.4514393161, -0.2365107469, -0.2149285693], [-0.0765537734, 1.1762296998, -0.0996759264], [0.0083161484, -0.0060324498, 0.9977163014]]
const AP1_2_AP0 = [[0.6954522414, 0.1406786965, 0.1638690622], [0.0447945634, 0.8596711185, 0.0955343182], [-0.0055258826, 0.0040252103, 1.0015006723]]
const XYZ_2_AP1 = [[1.6410233797, -0.3248032942, -0.2364246952], [-0.6636628587, 1.6153315917, 0.0167563477], [0.0117218943, -0.008284442, 0.9883948585]]
const AP1_2_XYZ = [[0.6624541811, 0.1340042065, 0.156187687], [0.2722287168, 0.6740817658, 0.0536895174], [-0.0055746495, 0.0040607335, 1.0103391003]]
const SRGB_2_XYZ = [[0.4123907993, 0.3575843394, 0.1804807884], [0.2126390059, 0.7151686788, 0.0721923154], [0.0193308187, 0.1191947798, 0.9505321522]]
const XYZ_2_SRGB = [[3.2409699419, -1.5373831776, -0.4986107603], [-0.9692436363, 1.8759675015, 0.0415550574], [0.0556300797, -0.2039769589, 1.0569715142]]
const D65_2_D60 = [[1.0130349146, 0.0061052578, -0.0149709436], [0.0076982301, 0.9981633521, -0.0050320385], [-0.0028413174, 0.0046851567, 0.9245061375]]
const D60_2_D65 = [[0.9872240087, -0.0061132286, 0.0159532883], [-0.0075983718, 1.0018614847, 0.0053300358], [0.0030725771, -0.0050959615, 1.0816806031]]
const SRGB_2_AP1 = mul3(XYZ_2_AP1, mul3(D65_2_D60, SRGB_2_XYZ))
const AP1_2_SRGB = mul3(XYZ_2_SRGB, mul3(D60_2_D65, AP1_2_XYZ))
const BLUE = mul3(AP0_2_AP1, mul3([[0.9404372683, -0.0183068787, 0.0778696104], [0.0083786969, 0.8286599939, 0.1629613092], [0.0005471261, -0.0008833746, 1.0003362486]], AP1_2_AP0))
const BLUE_INV = mul3(AP0_2_AP1, mul3([[1.06318, 0.0233956, -0.0865726], [-0.0106337, 1.20632, -0.19569], [-0.0005908870, 0.00105248, 0.999538]], AP1_2_AP0))
const WIDE_2_AP1 = mul3(mul3(XYZ_2_AP1, [[0.5441691, 0.2395926, 0.1666943], [0.2394656, 0.702153, 0.0583814], [-0.0023439, 0.0361834, 1.0552183]]), AP1_2_SRGB)
const luma = (c: Node) => dot(c, vec3(0.2722287168, 0.6740817658, 0.0536895174))

// Unreal's film curve at its defaults: slope 0.88, toe 0.55, shoulder 0.26, black clip 0, white clip 0.04
const SLOPE = 0.88, TOE = 0.55, SHOULDER = 0.26, BLACK = 0, WHITE = 0.04
const TOE_SCALE = 1 + BLACK - TOE, SHOULDER_SCALE = 1 + WHITE - SHOULDER
const BT = (0.18 + BLACK) / TOE_SCALE - 1
const TOE_MATCH = Math.log10(0.18) - 0.5 * Math.log((1 + BT) / (1 - BT)) * (TOE_SCALE / SLOPE)
const STRAIGHT_MATCH = (1 - TOE) / SLOPE - TOE_MATCH
const SHOULDER_MATCH = SHOULDER / SLOPE - STRAIGHT_MATCH

/** FilmToneMap: the ACES glow and red fix in AP0, then the toe, straight, and shoulder segments in log10. AP1 in and out. */
function filmic(ap1: Node) {
  const aces = apply(AP1_2_AP0, ap1).toVar()
  const mn = min(min(aces.x, aces.y), aces.z), mx = max(max(aces.x, aces.y), aces.z)
  const sat = max(mx, 1e-10).sub(max(mn, 1e-10)).div(max(mx, 0.01))
  const { x: r, y: g, z: b } = aces
  const yc = r.add(g).add(b).add(sqrt(max(b.mul(b.sub(g)).add(g.mul(g.sub(r))).add(r.mul(r.sub(b))), 0)).mul(1.75)).div(3)
  const sx = sat.sub(0.4).div(0.2), st = max(float(1).sub(abs(sx.mul(0.5))), 0)
  const gain = sign(sx).mul(float(1).sub(st.mul(st))).add(1).mul(0.5).mul(0.05)
  const glow = select(yc.lessThanEqual(0.08 * 2 / 3), gain, select(yc.greaterThanEqual(0.16), float(0), gain.mul(float(0.08).div(yc).sub(0.5))))
  aces.assign(aces.mul(glow.add(1)))
  const ha = sqrt(float(3)).mul(aces.y.sub(aces.z)), hb = aces.x.mul(2).sub(aces.y).sub(aces.z)
  const hue = select(abs(ha).add(abs(hb)).lessThan(1e-8), float(0), atan(ha, hb).mul(180 / Math.PI)) // -180 to 180, centered on red
  const hw = smoothstep(0, 1, float(1).sub(abs(hue.mul(2 / 135))))
  aces.assign(vec3(aces.x.add(hw.mul(hw).mul(sat).mul(float(0.03).sub(aces.x)).mul(0.18)), aces.y, aces.z))
  const wc = max(apply(AP0_2_AP1, aces), 0)
  const c = mix(vec3(luma(wc)), wc, 0.96)
  const lc = log(max(c, 1e-10)).mul(1 / Math.LN10)
  const straight = lc.add(STRAIGHT_MATCH).mul(SLOPE)
  const toe = float(-BLACK).add(float(2 * TOE_SCALE).div(exp(lc.sub(TOE_MATCH).mul(-2 * SLOPE / TOE_SCALE)).add(1)))
  const shoulder = float(1 + WHITE).sub(float(2 * SHOULDER_SCALE).div(exp(lc.sub(SHOULDER_MATCH).mul(2 * SLOPE / SHOULDER_SCALE)).add(1)))
  const below = vec3(step(TOE_MATCH, lc.x), step(TOE_MATCH, lc.y), step(TOE_MATCH, lc.z))
  const above = vec3(step(SHOULDER_MATCH, lc.x), step(SHOULDER_MATCH, lc.y), step(SHOULDER_MATCH, lc.z))
  // blend weight from toe to shoulder, flipped when the shoulder starts below the toe (it does at these defaults)
  const k = saturate(lc.sub(SHOULDER_MATCH).div(TOE_MATCH - SHOULDER_MATCH))
  const toned = mix(mix(toe, straight, below), mix(straight, shoulder, above), k.mul(k).mul(float(3).sub(k.mul(2))))
  return max(mix(vec3(luma(toned)), toned, 0.93), 0)
}

/** Linear sRGB in, display-referred linear sRGB out. */
const tonemap = Fn(([color]: [Node]) => {
  const c = apply(SRGB_2_AP1, color).toVar()
  const L = max(luma(c), 1e-6), chroma = c.div(L), d = chroma.sub(1)
  const expand = float(1).sub(exp(dot(d, d).mul(-4 * Math.LN2))).mul(float(1).sub(exp(L.mul(L).mul(-4 * Math.LN2))))
  c.assign(mix(c, apply(WIDE_2_AP1, c), expand))
  // Unreal's ColorCorrect in three zones (shadows to 0.09, highlights from 0.5): the lobby's tonemap-grade sets
  // saturation 1.06 everywhere and highlights gain 1.03 plus offset 0.05; contrast and gamma stay at 1
  const lum = luma(c), sat = max(mix(vec3(lum), c, 1.06), 0)
  const wH = smoothstep(0.5, 1, lum) // shadows and midtones grade alike here
  c.assign(sat.mul(float(1).sub(wH)).add(sat.mul(1.03).add(0.05).mul(wH)))
  c.assign(mix(c, apply(BLUE, c), 0.6))
  c.assign(filmic(c))
  c.assign(mix(c, apply(BLUE_INV, c), 0.6))
  return max(apply(AP1_2_SRGB, c), 0)
})

/** AMD's contrast adaptive sharpening at strength s (0 to 1): a cross filter whose weight backs off on strong edges.
 *  `alpha` comes in separately: a texture made from a computed color is drawn opaque, so its own alpha is always 1. */
function cas(tex: Node, s: number, alpha: Node) {
  const px = vec2(1).div(screenSize), at = (x: number, y: number) => tex.sample(screenUV.add(px.mul(vec2(x, y)))).rgb
  const e = tex.sample(screenUV).rgb, a = at(-1, -1), b = at(0, -1), cc = at(1, -1), d = at(-1, 0), f = at(1, 0), g = at(-1, 1), h = at(0, 1), i = at(1, 1)
  const mnC = min(min(min(d, e), min(f, b)), h), mn = mnC.add(min(min(min(mnC, a), min(cc, g)), i))
  const mxC = max(max(max(d, e), max(f, b)), h), mx = mxC.add(max(max(max(mxC, a), max(cc, g)), i))
  const w = sqrt(saturate(min(mn, float(2).sub(mx)).div(max(mx, 1e-4)))).mul(-1 / (8 - 3 * s))
  return vec4(saturate(b.add(d).add(f).add(h).mul(w).add(e).div(w.mul(4).add(1))), alpha)
}

const BLOOM = [[0.061, 64], [0.066, 30], [0.066, 10], [0.1176, 2], [0.138, 1], [0.3465, 0.3]] // tint, size: Unreal's six levels

/** How far a rim shell's normal must turn toward a rim light (N.L) before its band shows. */
const RIM_CUT = 0.35
/** One rim light of the rig for the bands: where it shines from (world, turned with the rig each frame) and its color
 *  times its strength. */
export type RimBand = { dir: Node; color: number[] }

/** The rim lights as the game draws them in the hero's lobby, before bloom. Measured on a Hero Profile screenshot of
 *  Black Panther: a hard cyan band on the edges that face the cyan Rim_Light and a thinner cream one on those that
 *  face the warm Rim_Light, each in the light's own color whatever the suit's (the suit under them is nearly black),
 *  and no wash of either light over the body. So: on the model (rim mask green, its smooth normal) a band in each rim
 *  light's color where the normal turns toward that light past RIM_CUT, the way a white surface lit with a hard step
 *  would show, times the post material's RimLightColor. The bands need no rim shell: that screenshot's mod has an
 *  empty one and shows them. shortcut: RIM_CUT is fitted to that screenshot's band widths, and the post material's own
 *  direction, fresnel, separation and offset line are not used (as the game viewer reads them they gave one white
 *  band, which the game does not show) */
function showRim(color: Node, rimMask: Node, normals: Node, bands: RimBand[], r: ShowRim, on: Node) {
  // coverage, not a hard step: the mask is resolved from 4x MSAA, so its edge carries partial values that keep the
  // bands antialiased
  const model = smoothstep(0, 0.5, rimMask.sample(screenUV).g)
  const N = normalize(normals.sample(screenUV).rgb.mul(2).sub(1))
  let light: Node = vec3(0), band: Node = float(0)
  for (const l of bands) {
    const v = dot(N, l.dir).sub(RIM_CUT)
    const aa = max(fwidth(v), 1e-4) // the hard cut, softened over one pixel's footprint
    const m = smoothstep(aa.negate(), aa, v).mul(model)
    light = light.add(vec3(l.color[0] * r.color[0], l.color[1] * r.color[1], l.color[2] * r.color[2]).mul(m))
    band = max(band, m)
  }
  return vec4(max(mix(color.rgb, light, band.mul(on)), 0), color.a) // on: the viewer's Rim light switch
}

/** The post chain for this scene and camera. `resize()` keeps the bloom's reach the same share of the frame. */
export function postChain(renderer: InstanceType<typeof THREE.WebGPURenderer>, scene: unknown, camera: { projectionMatrixInverse: unknown; matrixWorld: unknown }, rim: ShowRim, rimOn: Node, bands: RimBand[]) {
  const scenePass = pass(scene, camera, { samples: 4 })
  // rimMask and normal: written by the model's materials (toon.ts CHARACTER), empty everywhere else
  scenePass.setMRT(mrt({ output, emissive: vec4(emissive, output.a), rimMask: vec4(0), normal: vec4(0.5, 0.5, 1, 1) }))
  for (const t of ['rimMask', 'normal']) scenePass.getTexture(t).type = THREE.UnsignedByteType // 8 bits do: a quarter less memory
  // the sharpen stage's texture renders this pass inside three's state reset, which clears opaque black: keep it clear
  const drawPass = scenePass.updateBefore.bind(scenePass)
  scenePass.updateBefore = (frame: unknown) => {
    const alpha = renderer.getClearAlpha()
    renderer.setClearAlpha(0)
    drawPass(frame)
    renderer.setClearAlpha(alpha)
  }
  const color = showRim(scenePass.getTextureNode('output'), scenePass.getTextureNode('rimMask'), scenePass.getTextureNode('normal'), bands, rim, rimOn)
  const glowSrc = scenePass.getTextureNode('emissive')
  const h0 = Math.max(1, renderer.getDrawingBufferSize(new THREE.Vector2()).y), reach = uniform(1)
  let bloom: Node = vec3(0)
  const targets: { dispose: () => void }[] = [scenePass] // render targets freed on dispose (the shared GPU device outlives the view)
  BLOOM.forEach(([tint, size], i) => {
    const scale = 0.5 ** (BLOOM.length - i)
    const sigma = Math.max(0.5, (h0 * scale * 4 * size * 0.005) / Math.sqrt(33.4))
    const blur = gaussianBlur(glowSrc, reach, sigma, { resolutionScale: scale })
    targets.push(blur)
    bloom = bloom.add(blur.rgb.mul(tint * 1.05 / BLOOM.length))
  })
  // the lobby grade: highlights lifted a little and offset, saturation up a touch
  let rgb = color.rgb.add(bloom)
  const hi = smoothstep(0.5, 1, dot(rgb, vec3(0.2126, 0.7152, 0.0722)))
  rgb = mix(vec3(dot(rgb, vec3(0.2126, 0.7152, 0.0722))), rgb, 1.015)
  rgb = clamp(mix(rgb, rgb.mul(1.03).add(0.05), hi), 0, 4)
  // the lobby volume's vignette (intensity 0.5, hardness 0.7), then the viewer's own light one
  const x = screenUV.x, y = screenUV.y
  const l = float(1).sub(saturate(x.mul(y).mul(float(1).sub(x)).mul(float(1).sub(y)).mul(0.7 * 20)))
  rgb = rgb.mul(float(1).sub(l.pow(1.5).mul(0.5 * 0.5)))
  rgb = rgb.mul(saturate(float(1).sub(length(screenUV.sub(0.5)).pow(2).mul(0.1))))
  const graded = convertToTexture(vec4(tonemap(rgb), 1))
  targets.push(graded)
  const sharp = cas(graded, 0.8, color.a)
  const noise = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))))).sub(0.5).div(255)
  const pipeline = new THREE.RenderPipeline(renderer)
  pipeline.outputNode = vec4(sharp.rgb.add(noise.mul(sharp.a)), sharp.a)
  return {
    render: () => pipeline.render(),
    /** Builds the model's shaders for the scene pass ahead of its first frame (createRenderPipelineAsync): built on the
     *  first frame instead, the GPU process stalled for 1 to 3 s and every open view froze meanwhile (the default skin
     *  made in the background froze the mod's view). Same target and MRT as the pass, so the first frame reuses them. */
    compile: async () => {
      const r = renderer as unknown as { setRenderTarget: (t: unknown) => void; setMRT: (m: unknown) => void; compileAsync: (s: unknown, c: unknown) => Promise<void> }
      const p = scenePass as unknown as { renderTarget: unknown; getMRT: () => unknown }
      r.setRenderTarget(p.renderTarget); r.setMRT(p.getMRT())
      try { await r.compileAsync(scene, camera) } finally { r.setMRT(null); r.setRenderTarget(null) }
    },
    resize: () => { reach.value = Math.max(1, renderer.getDrawingBufferSize(new THREE.Vector2()).y) / h0 },
    dispose: () => { pipeline.dispose(); targets.forEach(t => t.dispose()) },
  }
}
