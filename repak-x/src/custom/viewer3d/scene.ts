// repakxtra: the Rotate in 3D scene (three.js) for one preview kit export, <previews>\<key>.3d (kit 19, mod_previews.py
// export_viewer): model.glb (mesh and skeleton), Materials\<slot>.json, tex\ + textures.json, idle.json + idle.bin, props.json,
// rig.json (the skin's lobby lights) and showrim.json (its show rim light).
// Every file comes over IPC as bytes (xtra_viewer.rs get_viewer_file): the glb is parsed from memory and textures are
// ImageBitmaps, so nothing needs a new CSP source. The look follows the game's lobby: WebGPU (WebGL 2 where WebGPU is
// missing), the game's toon recipes fed with each material's own values (toon.ts), the hero's own lobby light rig
// turning with the camera, the show rim light, the inverted hull outline (Settings >
// Previews > Outline in 3D, on by default), and Unreal's post chain (post.ts). Renders on demand: the idle at 30 fps
// while the canvas is on screen and the window is shown, nothing otherwise. dispose() frees every GPU resource.
import * as THREE from 'three/webgpu'
import { uniform, lights, vec4, uv, smoothstep, length, float } from 'three/tsl'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { invoke } from '@tauri-apps/api/core'
import { recipeOf, toonMaterial, fxGlow, proceduralEye, jellyGalaxyMaterial, isGalaxy, isJellyGalaxy, FX_TEXTURES, FX_COLOR, isFire, fireMaterial, outlineShell, isRimSlot, rimSlotMaterial, SHOW_RIM, type Mat, type Kit, type ShowRim } from './toon'
import { lobbyPhysics, type PhysicsData } from './physics'
import { isCrystal, isFoxTail, isFlipbook, isHairCard, isEyeShadow, isEyeGlint, crystalMaterial, foxTailMaterial, flipbookMaterial, asHairCard, eyeShadowMaterial, eyeGlintMaterial, furShells } from './special'
import { postChain, type RimBand } from './post'
import { viewerLook, OUTLINE_EVENT } from '../viewerOutline'

type Track = { b: string; m: number; q: number; qo: number; t: number; to: number; rq: number[]; rt: number[] }
type Idle = { v: number; anim?: string; frames?: number; seconds?: number; bin?: string; tracks?: Track[]; none?: string }
type Prop = { glb: string; bone: string; t?: number[]; q?: number[]; idle?: string | null }
/** cosmic: a part draws the game's galaxy material, which the viewer only approximates (the window says so). */
export type Viewer = { dispose: () => void; reset: () => void; cosmic: boolean; pause: (paused: boolean) => void; hold: (held: boolean) => void; lost: Promise<void> }
/** pause: draws nothing while true (a view kept ready out of sight, Options > Default skin). hold: the idle (and its
 *  physics and sounds) stops on the frame it is on, the view still turns (Options > Pause idle). lost: resolves when the
 *  GPU device is lost (a driver reset), the view then draws nothing more. */

const FPS = 30
/** One light of the hero's lobby rig (<skin>_HeroDetail_LightBP, the character lighting channel; the kit's rig.json)
 *  converted the way the game's scene export does: intensity in three's units (Unreal's / PI), linear color, a three
 *  quaternion whose local +X is where the light shines, position in meters from the stand, spot cones in degrees. */
type RigLight = {
  name?: string; kind: 'directional' | 'spot' | 'hemisphere'; color: number[]; intensity: number; castShadow?: boolean
  quaternion?: number[]; position?: number[]; range?: number; outerConeAngle?: number; innerConeAngle?: number
  specularScale?: number; sourceAngle?: number; softSourceAngle?: number; groundColor?: number[]
}
// Black Panther's default skin rig as the game's lobby stage has it (1026001_HeroDetail_LightBP): Main, the cyan
// Rim_Light_02, the warm Rim_Light_01, and the Fill spot. Used when the export has no rig.json of its own.
const RIG: RigLight[] = [
  { name: 'Main_Light', kind: 'directional', color: [1, 1, 1], intensity: 1.5915494, castShadow: true, quaternion: [0.2140097, -0.4846465, 0.13927144, -0.8366128], sourceAngle: 0.5357 },
  { name: 'Rim_Light_02', kind: 'directional', color: [0.13013649, 0.82278585, 0.8962694], intensity: 3.1830988, castShadow: true, quaternion: [0.14521325, -0.9025729, -0.1546556, 0.3746423], sourceAngle: 0.5 },
  { name: 'Fill_Light', kind: 'spot', color: [1, 1, 1], intensity: 3.1830988, castShadow: false, quaternion: [-0.71785927, -0.12873343, 0.27938402, -0.62454015], position: [-1.6799382, 2.418698, 1.9985989], range: 20, innerConeAngle: 0, outerConeAngle: 60 },
  { name: 'Rim_Light_01', kind: 'directional', color: [1, 0.7304609, 0.30946895], intensity: 3.1830988, castShadow: true, quaternion: [0.013449855, 0.43816805, 0.26260704, -0.85957277], sourceAngle: 0.5357, specularScale: 0.5 },
]
// The gallery's character_Shadow_Light: shadow only (the floor's fake shadow at 0.7), fixed in the world, not turned
const SHADOW_LIGHT = { position: [0.5239688, 1.3131104, 1.181713], quaternion: [-0.23610854, 0.42524, -0.29488605, 0.8224755], opacity: 0.7 }
// The start view: the game viewer's free orbit (toward (0, 1, 0), 60 degrees across at 16:9 or wider), from 4.3 m
// instead of its 3 so the whole model and its feet fit
// The game's Hero Profile camera stands 0.454 m to the hero's left at 3.315 m (HG_Stand): the start view keeps that
// angle to the hero and its light rig (7.8 degrees), from farther back and aimed at the hero's middle
const START_TURN = -Math.atan2(0.454, 3.315)
const START = { position: [4.3 * Math.sin(START_TURN), 1.25, 4.3 * Math.cos(START_TURN)], target: [0, 0.95, 0], hfov: 60 }
// Slots the game draws only in effects or as shells around the body (the kit's still render hides them too)
const HIDE = /armou?r|shell|lod|rim/i

const bytes = (key: string, file: string) => invoke<ArrayBuffer>('get_viewer_file', { key, file })
const readJson = async <T,>(key: string, file: string): Promise<T> => JSON.parse(new TextDecoder().decode(await bytes(key, file))) as T

/** The texture a slot draws for one role: the master's own parameter names in order (the kit's BASE_KEYS order), then
 *  any parameter or texture name like it. Effect textures (under /VFX/) never stand in: Rogue's head lists a diamond
 *  noise "BaseTex" before its BaseColor, and its "BaseNormal" before its Normal, so the face drew black and white. */
const pick = (t: Record<string, string>, keys: string[], byParam: RegExp, byName: RegExp) => {
  const ok = ([, v]: [string, string]) => !/\/VFX\//i.test(v)
  // a glitter's flicker map (Snow - EmissiveFlickerMap, a sheet of star sprites) is no glow map: picked as one, Phoenix's
  // dress drew bright stars at the full emissive strength (fxGlow adds it faintly)
  const rows = Object.entries(t).filter(r => ok(r) && !/flicker/i.test(r[0]))
  return keys.map(k => t[k]).find(v => v && ok(['', v]))
    ?? rows.find(([k]) => byParam.test(k))?.[1] ?? rows.find(([, v]) => byName.test(v.split('/').pop() ?? ''))?.[1]
}

/** One GPU device for every view (the mod's, the default skin's made in the background, the next one opened). Each view
 *  made its own before, and every one compiled all its shaders again: a 2 to 3 s stall of the GPU process per view that
 *  froze every other open view. On one device the driver keeps what it compiled, so a view of shaders already seen
 *  costs nothing. None (WebGPU missing): each renderer finds its own way (WebGL 2). Lost: the next view asks again. */
let sharedDevice: Promise<unknown> | null = null
const gpuDevice = () => sharedDevice ??= (async () => {
  type Adapter = { features: Set<string>; requestDevice: (d: unknown) => Promise<{ lost: Promise<unknown> }> }
  const gpu = (navigator as unknown as { gpu?: { requestAdapter: (o: unknown) => Promise<Adapter | null> } }).gpu
  const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance', featureLevel: 'compatibility' })
  if (!adapter) return undefined
  const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features] }) // as three asks for its own
  void device.lost.then(() => { sharedDevice = null })
  return device
})().catch(() => { sharedDevice = null; return undefined })

/** Builds the viewer in `host` (a sized element). Resolves once the first frame is drawn; rejects when the export
 *  cannot be read. `still`: no idle playback (reduced motion), its first frame only. `onStep`: how far along (0 to 1) and
 *  what it is doing, for the loader. */
export async function createViewer(host: HTMLElement, key: string, still: boolean, live: () => boolean = () => true,
  onStep: (done: number, text: string) => void = () => {}): Promise<Viewer> {
  const owned: { dispose?: () => void; close?: () => void }[] = [] // GPU textures, materials, bitmaps: freed on dispose
  const renderer = new THREE.WebGPURenderer({ alpha: true, powerPreference: 'high-performance', device: await gpuDevice() } as never)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping // the post chain tone maps
  renderer.setClearColor(0x000000, 0)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)) // the 4x MSAA targets grow with it: 2 doubled the memory of two live views for little sharper edges
  renderer.domElement.className = 'v3d-canvas'
  host.appendChild(renderer.domElement)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 100)
  const look = viewerLook()
  const kit: Kit = { owned, ramps: new Map(), outline: uniform(look.outline ? 1 : 0), outlineDist: uniform(4.3), rim: SHOW_RIM, shells: [] }
  const rimOn = uniform(look.rim ? 1 : 0)
  const bands: (RimBand & { to: InstanceType<typeof THREE.Vector3> })[] = [] // the rig's rim lights (post.ts showRim)
  let post: ReturnType<typeof postChain> | null = null
  // the Look switches: the outline, and the rim light (the show rim band and the rig's Rim_Light_* lights)
  const onOutline = () => {
    const l = viewerLook()
    kit.outline.value = l.outline ? 1 : 0
    kit.shells.forEach(s => { s.visible = l.outline })
    rimOn.value = l.rim ? 1 : 0
    if (l.sound && !soundOn) lastCue = -1 // switched on mid-loop: the next cue plays, not one already passed
    soundOn = l.sound
    schedule()
  }
  const controls = new OrbitControls(camera, renderer.domElement)
  let disposed = false, paused = false, held = false, raf = 0, last = 0, onScreen = true, mixer: InstanceType<typeof THREE.AnimationMixer> | null = null
  // Look > Lobby sounds: the lobby idle's sound cues (sounds.json, the kit's viewer_sounds), each played when the idle's
  // clock passes its time, through one AudioContext made on first use and closed on dispose
  let soundOn = look.sound, lastCue = -1, idleAction: { time: number } | null = null, audio: AudioContext | null = null
  let cues: { t: number; file: string }[] = []
  const clips = new Map<string, Promise<AudioBuffer | null>>()
  const playCue = (file: string) => {
    audio ??= new AudioContext()
    const ctx = audio
    if (!clips.has(file)) clips.set(file, bytes(key, file).then(b => ctx.decodeAudioData(b)).catch(() => null))
    void clips.get(file)!.then(buf => {
      if (!buf || disposed || ctx.state === 'closed') return
      const src = ctx.createBufferSource()
      src.buffer = buf
      const half = ctx.createGain() // half the cue's own level: at full it drowned the app's own sounds
      half.gain.value = 0.5
      src.connect(half).connect(ctx.destination)
      src.start()
    })
  }
  const soundTick = () => {
    if (!idleAction || !cues.length) return
    const t = idleAction.time
    if (soundOn && lastCue >= 0) for (const c of cues) if (lastCue <= t ? lastCue < c.t && c.t <= t : c.t > lastCue || c.t <= t) playCue(c.file)
    lastCue = t
  }
  const mixers: InstanceType<typeof THREE.AnimationMixer>[] = []
  const clock = new THREE.Clock()
  const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; schedule() })
  const ro = new ResizeObserver(() => { resize(); schedule() })
  const onVisible = () => { clock.getDelta(); schedule() }
  let tick: (now: number) => void = () => {} // set once the model is in
  // raf clears before tick runs: a frame asked for while the model still loads (the resize and visibility observers
  // fire then) ran the empty tick, kept raf set, and every later ask was dropped (a frozen view)
  const schedule = () => { if (!raf && !disposed) raf = requestAnimationFrame(now => { raf = 0; tick(now) }) }
  const resize = () => {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    // the game viewer's "centered" fov: 60 degrees across, narrower windows keep the 16:9 height
    camera.fov = (360 / Math.PI) * Math.atan(Math.tan((START.hfov * Math.PI) / 360) / Math.max(camera.aspect, 16 / 9))
    camera.updateProjectionMatrix()
    post?.resize()
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(raf)
    io.disconnect(); ro.disconnect()
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener(OUTLINE_EVENT, onOutline)
    controls.dispose()
    mixers.forEach(m => m.stopAllAction())
    // lights' shadow maps too: on the shared GPU device nothing frees them with the renderer
    scene.traverse((o: { geometry?: { dispose: () => void }; isLight?: boolean; shadow?: { dispose?: () => void } }) => { o.geometry?.dispose(); if (o.isLight) o.shadow?.dispose?.() })
    owned.forEach(x => { x.dispose?.(); x.close?.() })
    void audio?.close().catch(() => undefined)
    post?.dispose()
    if (renderer.initialized) renderer.dispose()
    else renderer.init().then(() => renderer.dispose(), () => undefined) // closed mid-start: free the GPU device once it exists
    renderer.domElement.remove()
  }

  try {
    onStep(0, 'Reading the model')
    await renderer.init()
    const model = await readJson<{ glb: string; mesh?: string; target?: string }>(key, 'model.json')
    const [texMap, gltf] = await Promise.all([
      readJson<Record<string, string>>(key, 'textures.json').catch(() => ({} as Record<string, string>)),
      bytes(key, model.glb).then(parseGlb),
    ])
    const check = () => { if (disposed || !live()) throw new Error('closed') }
    check()
    const root = gltf.scene
    scene.add(root)
    const textures = new Map<string, Promise<unknown | null>>()
    let asked = 0, loaded = 0 // textures, for the loader's step
    const counted = () => onStep(0.1 + 0.6 * (++loaded / Math.max(asked, 1)), `Loading textures (${loaded} of ${asked})`)
    const tex = (path: string | undefined, color: boolean, normal = false, channel = 0) => {
      if (!path) return Promise.resolve(null)
      const file = texMap[path.split('.')[0]]
      if (!file) return Promise.resolve(null)
      const id = `${file}|${color}|${normal}|${channel}`
      if (!textures.has(id)) {
        asked++
        textures.set(id, loadTexture(key, file, color, normal, channel).then(t => { if (t) owned.push(t as never); return t }, e => { console.warn('[viewer3d] texture', file, e); return null }).finally(counted))
      }
      return textures.get(id)!
    }
    const materials = new Map<string, Promise<Mat | null>>()
    const matOf = (name: string) => {
      if (!materials.has(name)) materials.set(name, readJson<Mat>(key, `Materials/${name}.json`).catch(() => null))
      return materials.get(name)!
    }
    kit.rim = { ...SHOW_RIM, ...await readJson<Partial<ShowRim>>(key, 'showrim.json').catch(() => ({})) } // the skin's own, else Black Panther's
    await dress(root, matOf, tex, kit)
    check()
    onStep(0.75, 'Setting up the stage')
    const bones = boneMap(root)
    const refPose = new Map([...bones].map(([n, b]) => [n, b.quaternion.clone()])) // before the idle moves them: a pose driver may read its source from it
    const idle = await readJson<Idle>(key, 'idle.json').catch(() => null)
    if (idle?.tracks && idle.bin) {
      mixer = new THREE.AnimationMixer(root)
      mixers.push(mixer)
      idleAction = mixer.clipAction(clipOf(idle, await bytes(key, idle.bin), bones)).play()
      cues = await readJson<{ t: number; file: string }[]>(key, 'sounds.json').catch(() => [])
    }
    // the lobby weapon (Punisher's gun): its own glb hung at the body bone's socket, playing its own idle in step
    for (const p of await readJson<Prop[]>(key, 'props.json').catch(() => [] as Prop[])) {
      const bone = bones.get(THREE.PropertyBinding.sanitizeNodeName(p.bone).toLowerCase())
      if (!bone || !/^props\/[\w.-]+\.glb$/i.test(p.glb)) continue
      try {
        const g = await parseGlb(await bytes(key, p.glb))
        const proot = g.scene
        await dress(proot, matOf, tex, kit)
        if (p.t?.length === 3) proot.position.fromArray(p.t)
        if (p.q?.length === 4) proot.quaternion.fromArray(p.q).normalize()
        bone.add(proot)
        const dir = p.idle?.replace(/\/idle\.json$/, '')
        const pi = dir ? await readJson<Idle>(key, p.idle!).catch(() => null) : null
        if (pi?.tracks && pi.bin) {
          const m = new THREE.AnimationMixer(proot)
          mixers.push(m)
          m.clipAction(clipOf(pi, await bytes(key, `${dir}/${pi.bin}`), boneMap(proot))).play()
        }
      } catch (e) { console.warn('[viewer3d] lobby weapon left out', e) } // never fatal: the body still shows
    }
    mixers.forEach(m => m.update(0))
    // the lobby physics and pose drivers (hair, skirt, cape, ornaments), run after the idle each frame
    const physics = mixer ? lobbyPhysics(root, await readJson<PhysicsData>(key, 'physics.json').catch(() => ({})), bones, refPose) : null
    check()

    // light: the hero's own lobby rig (its rig.json, else Black Panther's) on one group at the stand that turns with the
    // camera, so the model stays lit from the same side of the screen. (Fixed to the model instead, a turned view put
    // the rim lights, up to 25 times the main light, flat on the hero's back: tried, the whole back went cyan.) A skin
    // other than the hero's default also gets the sky light its lobby stage has (1.5 / PI, white over a dark gray
    // ground). shortcut: the stage's own lights are not exported, that row is the one every such stage carries
    const rigData = await readJson<RigLight[]>(key, 'rig.json').catch(() => RIG)
    const rigGroup = new THREE.Group()
    scene.add(rigGroup)
    const skin = /\/Characters\/(\d+)\/(\d+)\//.exec(model.target ?? model.mesh ?? '')
    const sky: RigLight[] = skin && skin[2] !== skin[1] + '001' ? [{ name: 'sky', kind: 'hemisphere', color: [1, 1, 1], groundColor: [0.1458, 0.139, 0.142], intensity: 0.4775 }] : []
    const rig = [...(Array.isArray(rigData) && rigData.length ? rigData : RIG), ...sky].map(l => {
      // a rim light lights no surface: in the game it only draws its band on the edges that face it (post.ts showRim).
      // As a light on the body it washed warm over Black Panther's left side, which the game does not show
      if (l.kind === 'directional' && /rim/i.test(l.name ?? '')) {
        const to = new THREE.Vector3(-1, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(l.quaternion ?? [0, 0, 0, 1])).normalize()
        // (its color at no more than full strength: the game's bands sit at about 0.6 of the light's color on screen, the
        // same for both, where the light's own 10 lux on white would burn out: 0.75 before the tone curve lands there)
        bands.push({ to, dir: uniform(to.clone()), color: l.color.map(c => c * Math.min(l.intensity, 1) * 0.75) })
        return null
      }
      const color = new THREE.Color().setRGB(l.color[0], l.color[1], l.color[2], THREE.LinearSRGBColorSpace)
      if (l.kind === 'hemisphere') {
        const g = l.groundColor ?? [0, 0, 0]
        const sky = new THREE.HemisphereLight(color, new THREE.Color().setRGB(g[0], g[1], g[2], THREE.LinearSRGBColorSpace), l.intensity)
        scene.add(sky)
        return sky
      }
      const outer = l.outerConeAngle ?? 44
      const penumbra = outer > 0 && l.innerConeAngle !== undefined ? Math.min(1, Math.max(0, 1 - l.innerConeAngle / outer)) : 0
      const light = l.kind === 'spot'
        ? new THREE.SpotLight(color, l.intensity, l.range ?? 10, (outer * Math.PI) / 180, penumbra, 2)
        : new THREE.DirectionalLight(color, l.intensity)
      if (l.quaternion?.length === 4) light.quaternion.fromArray(l.quaternion)
      if (l.position?.length === 3) light.position.fromArray(l.position)
      light.add(light.target)
      light.target.position.set(1, 0, 0) // Unreal lights shine along their local +X
      light.userData.specularScale = l.specularScale ?? 1
      light.userData.intensity = l.intensity
      if (l.castShadow && l.kind === 'directional') shadowed(light, l.sourceAngle, l.softSourceAngle) // a spot's shadow is not drawn
      rigGroup.add(light)
      return light
    })
    const fit = frame(root, camera, controls)
    kit.outlineDist.value = fit.dist
    const lit = lights(rig.filter(Boolean))
    root.traverse((o: InstanceType<typeof THREE.Mesh>) => {
      if (!o.isMesh || o.userData.outline || o.userData.rimShell) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      const solid = (m: { visible: boolean; userData: { fire?: boolean } }) => m.visible && !m.userData.fire
      mats.forEach((m: { lightsNode: unknown }) => { m.lightsNode = lit })
      o.castShadow = o.receiveShadow = mats.some(solid) // the rig shadows the model too (its fires cast none)
      if (o.userData.outlineFrom) outlineShell(kit, o, o.userData.outlineFrom)
    })
    window.addEventListener(OUTLINE_EVENT, onOutline)
    // the stage, centered on where the model stands: a soft pool of light that fades out with no edge, a dark contact
    // shadow under the feet so the model stands on it, and the shadow light's cast shadow, as soft as the pool it
    // falls on: drawn from a small map (its blur is a few texels, so a 2048 px map's was half a centimeter, a cutout
    // pasted on the floor), lighter than the contact shadow, and gone well before the pool's edge. shortcut: the
    // pool, contact and cast strengths are picked by eye, the lobby's own floor meshes are not exported
    const sun = new THREE.DirectionalLight(0xffffff, 0.01)
    sun.position.fromArray(SHADOW_LIGHT.position)
    sun.quaternion.fromArray(SHADOW_LIGHT.quaternion)
    sun.add(sun.target)
    sun.target.position.set(1, 0, 0)
    shadowed(sun, 0.5357, 0)
    const r = Math.max(1.2, fit.radius * 2.6)
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r }) // a box the floor's size
    sun.shadow.mapSize.set(256, 256)
    sun.shadow.radius = 2
    scene.add(sun)
    const disc = new THREE.CircleGeometry(r, 128)
    disc.rotateX(-Math.PI / 2)
    const d = length(uv().sub(0.5)).mul(2) // 0 at the center, 1 at the edge
    const pool = float(1).sub(smoothstep(0, 1, d)).pow(2).mul(0.18)
    const floorMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    floorMat.colorNode = vec4(0.82, 0.82, 0.82, pool)
    const contactMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    contactMat.colorNode = vec4(0, 0, 0, float(1).sub(smoothstep(0, 0.22, d)).pow(1.5).mul(0.5))
    const shadowMat = new THREE.ShadowNodeMaterial({ transparent: true, depthWrite: false })
    shadowMat.colorNode = vec4(0, 0, 0, float(1).sub(smoothstep(0.25, 0.85, d)).mul(0.75))
    shadowMat.lightsNode = lights([sun])
    const floor = new THREE.Mesh(disc, floorMat), contact = new THREE.Mesh(disc, contactMat), catcher = new THREE.Mesh(disc, shadowMat)
    catcher.receiveShadow = true
    for (const [i, m] of [floor, contact, catcher].entries()) { m.position.set(0, fit.floor + i * 0.0005, 0); m.renderOrder = i - 3; scene.add(m) }
    owned.push(disc, floorMat, contactMat, shadowMat)
    const up = new THREE.Vector3(0, 1, 0)
    const follow = () => {
      const turn = Math.atan2(camera.position.x, camera.position.z) - START_TURN // none at the start view
      rigGroup.rotation.y = turn
      for (const b of bands) (b.dir as unknown as { value: InstanceType<typeof THREE.Vector3> }).value.copy(b.to).applyAxisAngle(up, turn)
    }
    // left drag turns, middle (or right) drag moves the model in the frame, the wheel zooms
    controls.enablePan = true
    controls.screenSpacePanning = true
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }
    renderer.domElement.addEventListener('mousedown', (e: MouseEvent) => { if (e.button === 1) e.preventDefault() }) // no autoscroll
    renderer.domElement.addEventListener('contextmenu', (e: MouseEvent) => e.preventDefault())
    controls.enableDamping = true
    controls.dampingFactor = 0.25
    controls.minPolarAngle = 0 // straight above to straight below
    controls.maxPolarAngle = Math.PI
    controls.addEventListener('change', () => schedule())
    renderer.domElement.addEventListener('dblclick', () => { fit.reset(); schedule() })
    io.observe(host); ro.observe(host)
    document.addEventListener('visibilitychange', onVisible)
    resize() // first: the bloom sizes its kernels from the real canvas
    post = postChain(renderer, scene, camera, kit.rim, rimOn, bands)
    follow()
    onStep(0.85, 'Drawing the first frame')
    await new Promise(f => setTimeout(f, 0)) // the step paints before the first frame's shaders are built
    await post.compile()
    check()
    post.render()
    // the loader stays until the GPU has drawn it: the shaders and textures of a first frame take it a second or two,
    // and the stage showed empty meanwhile
    await (renderer.backend as { device?: { queue: { onSubmittedWorkDone: () => Promise<void> } } }).device?.queue.onSubmittedWorkDone()
    check()
    onStep(1, 'Drawing the first frame')

    let facing = controls.getAzimuthalAngle()
    tick = (now: number) => {
      raf = 0
      if (disposed || paused || !onScreen || document.hidden) return
      const playing = !still && !held && mixers.length > 0
      const moving = controls.update()
      if (playing && now - last < 1000 / FPS - 2 && !moving) { schedule(); return }
      last = now
      const dt = Math.min(clock.getDelta(), 0.1)
      // how far the view turned about the model: its hair and cloth lag behind, as when the hero is turned in the game
      const at = controls.getAzimuthalAngle(), turned = Math.atan2(Math.sin(at - facing), Math.cos(at - facing))
      facing = at
      if (playing) { mixers.forEach(m => m.update(dt)); physics?.update(dt, turned); soundTick() }
      follow()
      post!.render()
      if (playing || moving) schedule()
    }
    schedule()
    const pause = (p: boolean) => { paused = p; if (!p) { clock.getDelta(); schedule() } }
    const hold = (h: boolean) => { held = h; clock.getDelta(); schedule() }
    const lost = ((renderer.backend as { device?: { lost?: Promise<unknown> } }).device?.lost ?? new Promise(() => {})).then(() => undefined)
    return { dispose, reset: () => { fit.reset(); schedule() }, cosmic: Boolean(kit.cosmic), pause, hold, lost }
  } catch (e) {
    dispose()
    throw e
  }

}

/** Shadow map settings the game viewer uses for a lobby light: 2048 px, bias -0.001, an orthographic box of 8 m around
 *  the light (near -8, far 40), and a PCF radius from Unreal's source angle (0.5357 degrees gives 1.5 texels). */
function shadowed(light: InstanceType<typeof THREE.DirectionalLight>, sourceAngle = 0, softSourceAngle = 0) {
  light.castShadow = true
  light.shadow.mapSize.set(2048, 2048)
  light.shadow.bias = -0.001
  light.shadow.normalBias = 0
  light.shadow.radius = Math.min(8, Math.max(0.5, (((sourceAngle > 0 ? sourceAngle : 0.5357) + softSourceAngle) / 0.5357) * 1.5))
  if ((light as { isDirectionalLight?: boolean }).isDirectionalLight) Object.assign(light.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: -8, far: 40 })
}

function parseGlb(buf: ArrayBuffer): Promise<{ scene: InstanceType<typeof THREE.Group> }> {
  return new Promise((resolve, reject) => new GLTFLoader().parse(buf, '', resolve, reject))
}

/** Bones by lowercase name (glTF node names, sanitized as three's bindings name them). */
function boneMap(root: InstanceType<typeof THREE.Object3D>) {
  const map = new Map<string, InstanceType<typeof THREE.Bone>>()
  root.traverse((o: InstanceType<typeof THREE.Bone>) => { if (o.isBone && !map.has(o.name.toLowerCase())) map.set(o.name.toLowerCase(), o) })
  return map
}

/** One texture from the export: an ImageBitmap (decoded off the main thread), color or data. A normal map saved from
 *  BC5 (red and green only, blue empty) is marked rebuildBlue: the shader rebuilds its blue (toon.ts normalTex), or
 *  every normal would point sideways. (Rebuilt here before, a full-size canvas readback held the page during load.) */
async function loadTexture(key: string, file: string, color: boolean, normal: boolean, channel = 0): Promise<unknown | null> {
  const blob = new Blob([await bytes(key, file)], { type: 'image/png' })
  const image: ImageBitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const t = new THREE.Texture(image)
  if (normal && blueEmpty(image)) t.userData.rebuildBlue = true
  t.flipY = false // glTF UVs
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  t.channel = channel // the UV set it reads: 1 for a hair master's ShadowColor(UV1)
  t.needsUpdate = true
  const dispose = t.dispose.bind(t)
  t.dispose = () => { dispose(); image.close() }
  return t
}

/** Blue channel nearly empty on a 32 px sample: a two-channel (BC5) normal map. */
function blueEmpty(bmp: ImageBitmap) {
  const c = new OffscreenCanvas(32, 32), g = c.getContext('2d')!
  g.drawImage(bmp, 0, 0, 32, 32)
  const d = g.getImageData(0, 0, 32, 32).data
  let b = 0
  for (let i = 2; i < d.length; i += 4) b += d[i]
  return b / (d.length / 4) < 24
}

/** Each mesh's slots get the game's recipe for their master material (toon.ts) with the textures it reads; effect
 *  shells, translucent glows and the game's invisible M_Hide hidden; masked cut by alpha. A body or generic slot is
 *  marked for the outline (userData.outlineFrom), added once the camera is framed. */
async function dress(root: InstanceType<typeof THREE.Object3D>, matOf: (name: string) => Promise<Mat | null>,
  tex: (path: string | undefined, color: boolean, normal?: boolean, channel?: number) => Promise<unknown | null>, kit: Kit) {
  const meshes: InstanceType<typeof THREE.Mesh>[] = []
  root.traverse((o: InstanceType<typeof THREE.Mesh>) => { if (o.isMesh) meshes.push(o) })
  // every mesh at once: one after another, a mesh's textures were asked for only when the one before had all of its
  // own (a model with many parts opened about a fifth slower: 9 loads each way, 2026-11-11)
  // (allSettled: a mesh that fails must not end the wait while the others still load, or what they made after the
  // viewer was disposed would never be freed)
  const done = await Promise.allSettled(meshes.map(async mesh => {
    mesh.frustumCulled = false // skinned bounds lag the idle: never cull a limb out
    const slots = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const made = await Promise.all(slots.map(async (old: { name: string; dispose: () => void }) => {
      const name = old?.name ?? ''
      old?.dispose()
      const m: Mat = (name ? await matOf(name) : null) ?? {}
      if (isRimSlot(name)) { // the game's rim shell: marks the show rim light, draws nothing
        const shell = rimSlotMaterial()
        kit.owned.push(shell)
        mesh.userData.rimShell = true
        return shell
      }
      const gone = m.Parent === 'M_Hide' || HIDE.test(name)
      const own = <T extends { dispose?: () => void }>(x: T) => { kit.owned.push(x); return x }
      const t0 = m.Textures ?? {}
      if (!gone) { // the masters with a look of their own (special.ts), then the game's translucent rest stays hidden
        const seq = isFire(m) ? await tex(t0.SequencesTex, false) as never : null
        if (isEyeShadow(m)) return own(eyeShadowMaterial(m))
        if (isEyeGlint(m)) return own(eyeGlintMaterial(m, await tex(t0.HighlightMask, false) as never))
        if (seq && isFoxTail(m)) return own(foxTailMaterial(m, seq))
        // a body master's own fire (Devil Dinosaur's burning tube), then every other flipbook: the lobby flames and wisps
        if (seq && m.Vectors?.FireColor01 && t0.CloudTex) return own(fireMaterial(m, seq, null, await tex(t0.CloudTex, false) as never))
        // (a translucent one only on a fox tail: the others are strips the game widens toward the camera, drawn at their
        // mesh's own width they were sheets of light around Devil Dinosaur's neck)
        if (seq && isFlipbook(m) && (!/Translucent|Additive/.test(m.BlendMode ?? '') || /FoxTail/i.test(m.Parent ?? ''))) return own(flipbookMaterial(m, seq, t0.Mask ? await tex(t0.Mask, false) as never : null, mesh.geometry.hasAttribute('color')))
      }
      const hairCard = !gone && isHairCard(m, name)
      const hidden = gone || (!hairCard && (Boolean(m.Parameters?.IsTranslucent) || /Translucent|Additive/.test(m.BlendMode ?? '')))
      if (hidden) {
        const none = new THREE.MeshBasicMaterial({ visible: false })
        kit.owned.push(none)
        return none
      }
      const t = m.Textures ?? {}
      const base = pick(t, ['BaseColor', 'PM_Diffuse', 'DiffuseTex', 'Diffuse', 'BaseTex', 'Albedo'], /Base.?Color|Diffuse|Albedo/i, /_D(_\w+)?$/)
      const [baseMap, normal, orm, emissive, spec, cube, cubeMask, rimMask, shadow, opacity, shift] = await Promise.all([
        tex(base, true), tex(pick(t, ['Normal', 'PM_Normals'], /Normal/i, /_N$/), false, true), tex(pick(t, ['ORM', 'MRO'], /ORM|MRA/i, /_ORM$/), false),
        tex(pick(t, ['Emissive', 'PM_Emissive'], /Emissive/i, /_E$/), true), tex(t.SpecularTexture ?? t.PM_SpecularMasks, true), tex(t.CubeMap_Tex, true),
        tex(t.CubeMap_Mask, true), tex(t.RimLightMask, false), tex(t['ShadowColor(UV1)'] ?? t.ShadowColor, true, false, 1),
        tex(t.OpacityMask ?? t.OpacityTexture, false), tex(t.SpecularShift, false, false, 2),
      ]) as never[]
      // BaseTint multiplies the base color: a gray one at full strength, a colored one at half (the kit's values)
      const bt = m.Vectors?.BaseTint
      const neutral = bt ? Math.max(bt.R, bt.G, bt.B) - Math.min(bt.R, bt.G, bt.B) < 0.02 : true
      const k = neutral ? 1 : 0.5, part = (v: number) => 1 - k + k * v
      // the game's fur master (shells the mesh already carries): the body recipe with no cut-out, not hair cards
      const fur = /^M_\d+_Fur$/i.test(m.Parent ?? '') && m.Scalars?.FurLength !== undefined
      const recipe = hairCard ? 'hair' : fur ? 'body' : recipeOf(m)
      const fx = Object.fromEntries(await Promise.all(FX_TEXTURES.filter(k => t[k]).map(async k => [k, await tex(t[k], FX_COLOR.test(k) || /_D$/.test(t[k]))]))) // masks are linear
      const maps = { base: baseMap, normal, orm, emissive, spec, cube, cubeMask, rimMask, shadow, opacity, shift, fx }
      const tint = bt ? [part(bt.R), part(bt.G), part(bt.B)] : [1, 1, 1]
      const mat = toonMaterial(kit, m, recipe, maps, tint, /Masked/.test(m.BlendMode ?? '') && !fur)
      if (fur && !Array.isArray(mesh.material)) furShells(kit, mesh, m, () => toonMaterial(kit, m, recipe, maps, tint, false), await tex(t.Pattern_Map, false) as never, await tex(t.LDTG_Map, false) as never)
      if (isCrystal(m)) { // White Fox's cosmic tails
        mat.dispose()
        kit.cosmic = kit.cosmic || Boolean(fx.GalaxyTex1)
        return own(crystalMaterial(m, { diffuse: await tex(t.DiffuseTex, true) as never, normal: await tex(t.CrystalNormal ?? t.BaseNormal ?? t.NormalMap ?? t.Normal, false, true) as never,
          cube: await tex(t.CubeMap ?? t.ReflectTex, false) as never, base: fx.BaseTex, dia: fx.DiaColorTex, rimLine: await tex(t.RimLine, false) as never }, fx, /Masked/.test(m.BlendMode ?? '')))
      }
      if (hairCard) return own(asHairCard(mat, baseMap, opacity))
      if (recipe === 'eye') proceduralEye(mat, m, fx)
      const glow = fxGlow(m, fx)
      if (isGalaxy(m) && (fx.GalaxyTex1 || fx.StarTex1 || fx.StarTex3)) kit.cosmic = true
      if (isJellyGalaxy(m)) { // the game's jelly galaxy: its own unlit recipe in place of the toon one
        const jelly = jellyGalaxyMaterial(m, baseMap, fx, opacity, /Masked/.test(m.BlendMode ?? ''))
        kit.owned.push(jelly)
        if (!Array.isArray(mesh.material)) mesh.userData.outlineFrom = jelly
        return jelly
      }
      if (glow) mat.emissiveNode = mat.emissiveNode ? mat.emissiveNode.add(glow) : glow
      kit.owned.push(mat)
      if (!Array.isArray(mesh.material) && recipe !== 'eye') mesh.userData.outlineFrom = mat
      return mat
    }))
    mesh.material = Array.isArray(mesh.material) ? made : made[0]
    mesh.renderOrder = Math.max(0, ...made.map((x: { userData?: { order?: number } }) => x.userData?.order ?? 0)) // eye glints over eyes, hair cards last
  }))
  const failed = done.find(d => d.status === 'rejected')
  if (failed) throw (failed as PromiseRejectedResult).reason
}

/** The kit's idle (format v1) as a clip on these bones: rotations for every bone it keys; translations as they are for
 *  the root, the pelvis and the ik_ helpers, and for every other bone as its movement from the idle's own rest pose
 *  (rt) added to this mesh's rest position: the necklace and chest bones move (Black Panther's necklace stood still and
 *  showed the bare chest), and an idle borrowed from another skin keeps this mesh's own bone spacing. */
function clipOf(idle: Idle, bin: ArrayBuffer, bones: Map<string, InstanceType<typeof THREE.Bone>>) {
  const frames = Math.max(2, idle.frames ?? 2), seconds = Math.max(0.1, idle.seconds ?? 1)
  const times = Float32Array.from({ length: frames }, (_, i) => (i * seconds) / (frames - 1))
  const tracks: unknown[] = []
  for (const t of idle.tracks ?? []) {
    const bone = bones.get(THREE.PropertyBinding.sanitizeNodeName(t.b).toLowerCase())
    if (!bone) continue
    if (t.q > 0) {
      const raw = new Int16Array(bin, t.qo, t.q * 4)
      const v = new Float32Array(raw.length)
      for (let i = 0; i < raw.length; i += 4) {
        const x = raw[i] / 32767, y = raw[i + 1] / 32767, z = raw[i + 2] / 32767, w = raw[i + 3] / 32767
        const n = Math.hypot(x, y, z, w) || 1
        v[i] = x / n; v[i + 1] = y / n; v[i + 2] = z / n; v[i + 3] = w / n
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, t.q === 1 ? [0] : times, v))
    }
    if (t.t > 0) {
      const v = new Float32Array(bin, t.to, t.t * 3)
      const absolute = /^(root|pelvis|ik_)/i.test(t.b)
      if (!absolute && t.rt?.length !== 3) continue
      const keys = absolute ? v : v.map((x, i) => bone.position.getComponent(i % 3) + x - t.rt[i % 3])
      tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, t.t === 1 ? [0] : times, keys))
    }
  }
  return new THREE.AnimationClip('idle', seconds, tracks)
}

/** Measures what is drawn in the idle's first pose and puts the camera at the game viewer's start (START); returns the
 *  model's center, floor height and radius, the start view's distance, plus reset (the double click). */
function frame(root: InstanceType<typeof THREE.Object3D>, camera: InstanceType<typeof THREE.PerspectiveCamera>, controls: { target: { set: (x: number, y: number, z: number) => void }; update: () => void }) {
  root.updateMatrixWorld(true)
  const box = new THREE.Box3()
  root.traverse((o: { isMesh?: boolean; isSkinnedMesh?: boolean; boundingBox: unknown; material: unknown }) => {
    if (!o.isMesh) return
    if (o.isSkinnedMesh) o.boundingBox = null // skinned bounds are cached from the bind pose: measure this pose
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    if (mats.some((m: { visible: boolean }) => m.visible)) box.expandByObject(o)
  })
  if (box.isEmpty()) box.setFromObject(root)
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3())
  // the game viewer's start for every hero, so models compare one to one with it
  // a model bigger than a hero (Devil Dinosaur) backs the start view off by as much
  const k = Math.max(1, size.y / 2.1, Math.max(size.x, size.z) / 2.4)
  // the limits first, wide enough for the start view, so reset is exactly START
  ;(controls as unknown as { minDistance: number; maxDistance: number }).minDistance = Math.min(Math.max(size.x, size.y, size.z) * 0.6, 2.5)
  ;(controls as unknown as { minDistance: number; maxDistance: number }).maxDistance = Math.max(Math.max(size.x, size.y, size.z) * 4, 6)
  // panning moves the view's center at most this far from the model's, so it never leaves the frame
  ;(controls as unknown as { cursor: { copy: (v: unknown) => void }; maxTargetRadius: number }).cursor.copy(c)
  ;(controls as unknown as { maxTargetRadius: number }).maxTargetRadius = Math.max(Math.max(size.x, size.y, size.z) * 0.4, Math.hypot(c.x - START.target[0] * k, c.y - START.target[1] * k, c.z - START.target[2] * k))
  const reset = () => {
    camera.position.set(START.position[0] * k, START.position[1] * k, START.position[2] * k)
    controls.target.set(START.target[0] * k, START.target[1] * k, START.target[2] * k)
    controls.update()
  }
  reset()
  const dist = Math.hypot(START.position[0] - START.target[0], START.position[1] - START.target[1], START.position[2] - START.target[2]) * k
  return { x: c.x, y: c.y, z: c.z, floor: box.min.y, radius: Math.max(size.x, size.z, size.y * 0.5) / 2, dist, reset }
}
