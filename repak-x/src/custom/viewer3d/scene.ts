// repakxtra: the Rotate in 3D scene (three.js) for one preview kit export, <previews>\<key>.3d (kit 19, mod_previews.py
// export_viewer): model.glb (mesh and skeleton), Materials\<slot>.json, tex\ + textures.json, idle.json + idle.bin, props.json.
// Every file comes over IPC as bytes (xtra_viewer.rs get_viewer_file): the glb is parsed from memory and textures are
// ImageBitmaps, so nothing needs a new CSP source. The look follows the approach in docs\rivalsfps\BREAKDOWN.md ("3D skin
// viewer"), written fresh: toon bands, one key light that follows the camera, flat ambient, no outline or rim band
// (repakxtra's rule: no preview outlines). Renders on demand: the idle at 30 fps while the canvas is on screen and the
// window is shown, nothing otherwise. dispose() frees every GPU resource and the WebGL context.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { invoke } from '@tauri-apps/api/core'

type Rgba = { R: number; G: number; B: number; A?: number }
/** A slot's material file (viewer_files in mod_previews.py): the kit's simplified material with its parents' values. */
type Mat = {
  Textures?: Record<string, string>; Parameters?: { IsTranslucent?: boolean; BlendMode?: number }; Parent?: string
  TwoSided?: boolean; BlendMode?: string; Vectors?: Record<string, Rgba>; Scalars?: Record<string, number>
}
type Track = { b: string; m: number; q: number; qo: number; t: number; to: number; rq: number[]; rt: number[] }
type Idle = { v: number; anim?: string; frames?: number; seconds?: number; bin?: string; tracks?: Track[]; none?: string }
type Prop = { glb: string; bone: string; t?: number[]; q?: number[]; idle?: string | null }
export type Viewer = { dispose: () => void; reset: () => void }

const FPS = 30
// Slots the game draws only in effects or as shells around the body (the kit's still render hides them too)
const HIDE = /armou?r|shell|lod|rim/i

const bytes = (key: string, file: string) => invoke<ArrayBuffer>('get_viewer_file', { key, file })
const readJson = async <T,>(key: string, file: string): Promise<T> => JSON.parse(new TextDecoder().decode(await bytes(key, file))) as T

/** The texture a slot draws for one role: the master's own parameter names in order (the kit's BASE_KEYS order), then
 *  any parameter or texture name like it. Effect textures (under /VFX/) never stand in: Rogue's head lists a diamond
 *  noise "BaseTex" before its BaseColor, and its "BaseNormal" before its Normal, so the face drew black and white. */
const pick = (t: Record<string, string>, keys: string[], byParam: RegExp, byName: RegExp) => {
  const ok = ([, v]: [string, string]) => !/\/VFX\//i.test(v)
  const rows = Object.entries(t).filter(ok)
  return keys.map(k => t[k]).find(v => v && ok(['', v]))
    ?? rows.find(([k]) => byParam.test(k))?.[1] ?? rows.find(([, v]) => byName.test(v.split('/').pop() ?? ''))?.[1]
}

/** Builds the viewer in `host` (a sized element). Resolves once the first frame is drawn; rejects when the export
 *  cannot be read. `still`: no idle playback (reduced motion), its first frame only. */
export async function createViewer(host: HTMLElement, key: string, still: boolean, live: () => boolean = () => true): Promise<Viewer> {
  const owned: { dispose?: () => void; close?: () => void }[] = [] // GPU textures, materials, bitmaps: freed on dispose
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.domElement.className = 'v3d-canvas'
  host.appendChild(renderer.domElement)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100)
  const controls = new OrbitControls(camera, renderer.domElement)
  let disposed = false, raf = 0, last = 0, onScreen = true, mixer: InstanceType<typeof THREE.AnimationMixer> | null = null
  const mixers: InstanceType<typeof THREE.AnimationMixer>[] = []
  const clock = new THREE.Clock()
  const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; schedule() })
  const ro = new ResizeObserver(() => { resize(); schedule() })
  const onVisible = () => { clock.getDelta(); schedule() }
  let tick: (now: number) => void = () => {} // set once the model is in
  const schedule = () => { if (!raf && !disposed) raf = requestAnimationFrame(now => tick(now)) }
  const resize = () => {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(raf)
    io.disconnect(); ro.disconnect()
    document.removeEventListener('visibilitychange', onVisible)
    controls.dispose()
    mixers.forEach(m => m.stopAllAction())
    scene.traverse((o: { geometry?: { dispose: () => void } }) => o.geometry?.dispose())
    owned.forEach(x => { x.dispose?.(); x.close?.() })
    renderer.dispose()
    renderer.forceContextLoss()
    renderer.domElement.remove()
  }

  try {
    const [texMap, gltf] = await Promise.all([
      readJson<Record<string, string>>(key, 'textures.json').catch(() => ({} as Record<string, string>)),
      readJson<{ glb: string }>(key, 'model.json').then(m => bytes(key, m.glb)).then(parseGlb),
    ])
    const check = () => { if (disposed || !live()) throw new Error('closed') }
    check()
    const root = gltf.scene
    scene.add(root)
    const textures = new Map<string, Promise<unknown | null>>()
    const tex = (path: string | undefined, color: boolean, normal = false, channel = 0) => {
      if (!path) return Promise.resolve(null)
      const file = texMap[path.split('.')[0]]
      if (!file) return Promise.resolve(null)
      const id = `${file}|${color}|${normal}|${channel}`
      if (!textures.has(id)) textures.set(id, loadTexture(key, file, color, normal, channel).then(t => { if (t) owned.push(t as never); return t }, e => { console.warn('[viewer3d] texture', file, e); return null }))
      return textures.get(id)!
    }
    const materials = new Map<string, Promise<Mat | null>>()
    const matOf = (name: string) => {
      if (!materials.has(name)) materials.set(name, readJson<Mat>(key, `Materials/${name}.json`).catch(() => null))
      return materials.get(name)!
    }
    await dress(root, matOf, tex, owned)
    check()
    const bones = boneMap(root)
    const idle = await readJson<Idle>(key, 'idle.json').catch(() => null)
    if (idle?.tracks && idle.bin) {
      mixer = new THREE.AnimationMixer(root)
      mixers.push(mixer)
      mixer.clipAction(clipOf(idle, await bytes(key, idle.bin), bones)).play()
    }
    // the lobby weapon (Punisher's gun): its own glb hung at the body bone's socket, playing its own idle in step
    for (const p of await readJson<Prop[]>(key, 'props.json').catch(() => [] as Prop[])) {
      const bone = bones.get(THREE.PropertyBinding.sanitizeNodeName(p.bone).toLowerCase())
      if (!bone || !/^props\/[\w.-]+\.glb$/i.test(p.glb)) continue
      try {
        const g = await parseGlb(await bytes(key, p.glb))
        const proot = g.scene
        await dress(proot, matOf, tex, owned)
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
    check()

    // light: flat ambient and one key light that turns with the camera (the bands stay readable from every side)
    scene.add(new THREE.AmbientLight(0xffffff, 1.5))
    const key3 = new THREE.DirectionalLight(0xfff6ee, 2.6)
    scene.add(key3, key3.target)
    const fit = frame(root, camera, controls)
    const follow = () => {
      const a = Math.atan2(camera.position.x - fit.x, camera.position.z - fit.z) + 0.6
      key3.position.set(fit.x + Math.sin(a) * 4, fit.y + 2.5, fit.z + Math.cos(a) * 4)
      key3.target.position.set(fit.x, fit.y, fit.z)
    }
    // left drag turns, middle (or right) drag moves the model in the frame, the wheel zooms
    controls.enablePan = true
    controls.screenSpacePanning = true
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }
    renderer.domElement.addEventListener('mousedown', (e: MouseEvent) => { if (e.button === 1) e.preventDefault() }) // no autoscroll
    renderer.domElement.addEventListener('contextmenu', (e: MouseEvent) => e.preventDefault())
    controls.enableDamping = true
    controls.minPolarAngle = Math.PI * 0.3
    controls.maxPolarAngle = Math.PI * 0.62
    controls.addEventListener('change', () => schedule())
    renderer.domElement.addEventListener('dblclick', () => { fit.reset(); schedule() })
    io.observe(host); ro.observe(host)
    document.addEventListener('visibilitychange', onVisible)
    resize()
    follow()
    renderer.render(scene, camera)

    tick = (now: number) => {
      raf = 0
      if (disposed || !onScreen || document.hidden) return
      const playing = !still && mixers.length > 0
      const moving = controls.update()
      if (playing && now - last < 1000 / FPS - 2 && !moving) { schedule(); return }
      last = now
      const dt = Math.min(clock.getDelta(), 0.1)
      if (playing) mixers.forEach(m => m.update(dt))
      follow()
      renderer.render(scene, camera)
      if (playing || moving) schedule()
    }
    schedule()
    return { dispose, reset: () => { fit.reset(); schedule() } }
  } catch (e) {
    dispose()
    throw e
  }

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
 *  BC5 (red and green only, blue empty) gets its blue rebuilt, or every normal would point sideways. */
async function loadTexture(key: string, file: string, color: boolean, normal: boolean, channel = 0): Promise<unknown | null> {
  const blob = new Blob([await bytes(key, file)], { type: 'image/png' })
  let bmp: ImageBitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  let image: ImageBitmap | OffscreenCanvas = bmp
  if (normal && blueEmpty(bmp)) {
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d')!
    g.drawImage(bmp, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height)
    for (let i = 0; i < d.data.length; i += 4) {
      const x = d.data[i] / 127.5 - 1, y = d.data[i + 1] / 127.5 - 1
      d.data[i + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) + 1) * 127.5)
    }
    g.putImageData(d, 0, 0)
    bmp.close()
    image = c
  }
  const t = new THREE.Texture(image)
  t.flipY = false // glTF UVs
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  t.channel = channel // the UV set it reads: 1 for a hair master's ShadowColor(UV1)
  t.needsUpdate = true
  const dispose = t.dispose.bind(t)
  t.dispose = () => { dispose(); if (image instanceof ImageBitmap) image.close() }
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

/** Three tones (dark, mid, lit): the toon bands. shortcut: fixed tones, the game's MC_Shade_* band values are not read
 *  yet (their meaning in the master material is not known); read them when a material shows the bands are off. */
function bands() {
  const t = new THREE.DataTexture(new Uint8Array([150, 150, 150, 255, 215, 215, 215, 255, 255, 255, 255, 255]), 3, 1)
  t.minFilter = t.magFilter = THREE.NearestFilter
  t.needsUpdate = true
  return t
}

/** Each mesh's slots get their game material: toon shading from its base color, normal, AO (ORM's red) and emissive;
 *  eyes unlit; effect shells, translucent glows and the game's invisible M_Hide hidden; masked cut by alpha. */
async function dress(root: InstanceType<typeof THREE.Object3D>, matOf: (name: string) => Promise<Mat | null>,
  tex: (path: string | undefined, color: boolean, normal?: boolean, channel?: number) => Promise<unknown | null>, owned: { dispose?: () => void }[]) {
  const gradient = bands()
  owned.push(gradient)
  const meshes: { material: unknown; frustumCulled: boolean; isMesh?: boolean }[] = []
  root.traverse((o: { isMesh?: boolean; material: unknown; frustumCulled: boolean }) => { if (o.isMesh) meshes.push(o) })
  for (const mesh of meshes) {
    mesh.frustumCulled = false // skinned bounds lag the idle: never cull a limb out
    const slots = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const made = await Promise.all(slots.map(async (old: { name: string; dispose: () => void }) => {
      const name = old?.name ?? ''
      old?.dispose()
      const m: Mat = (name ? await matOf(name) : null) ?? {}
      const hidden = m.Parent === 'M_Hide' || HIDE.test(name) || Boolean(m.Parameters?.IsTranslucent) || /Translucent|Additive/.test(m.BlendMode ?? '')
      if (hidden) {
        const none = new THREE.MeshBasicMaterial({ visible: false })
        owned.push(none)
        return none
      }
      const t = m.Textures ?? {}
      const base = pick(t, ['BaseColor', 'PM_Diffuse', 'DiffuseTex', 'Diffuse', 'BaseTex', 'Albedo'], /Base.?Color|Diffuse|Albedo/i, /_D(_\w+)?$/)
      // the kit's game_material, in toon form: a hair master colors its gray strands with ShadowColor(UV1) on the second
      // UV set (Rogue's brown and white hair drew all white without it), and clips cards by their own OpacityMask
      const [map, normalMap, orm, emissiveMap, shade, alphaMap] = await Promise.all([
        tex(base, true), tex(pick(t, ['Normal', 'PM_Normals'], /Normal/i, /_N$/), false, true), tex(pick(t, ['ORM'], /ORM|MRA/i, /_ORM$/), false),
        tex(pick(t, ['Emissive', 'PM_Emissive'], /Emissive/i, /_E$/), true), tex(t['ShadowColor(UV1)'], true, false, 1), tex(t.OpacityMask, false),
      ])
      const side = m.TwoSided ? THREE.DoubleSide : THREE.FrontSide
      const alphaTest = /Masked/.test(m.BlendMode ?? '') ? 0.3333 : 0
      if (/Eye/i.test(name)) {
        const eye = new THREE.MeshBasicMaterial({ map, side, alphaTest })
        owned.push(eye)
        return eye
      }
      const glow = m.Vectors?.EmissiveColor ?? m.Vectors?.EmissiveTint
      // BaseTint multiplies the base color: a gray one at full strength, a colored one at half (the kit's values)
      const tint = m.Vectors?.BaseTint
      const neutral = tint ? Math.max(tint.R, tint.G, tint.B) - Math.min(tint.R, tint.G, tint.B) < 0.02 : true
      const k = neutral ? 1 : 0.5, part = (v: number) => 1 - k + k * v
      const mat = new THREE.MeshToonMaterial({
        map, normalMap, aoMap: shade ?? orm, emissiveMap, gradientMap: gradient, side, alphaTest,
        alphaMap: alphaTest ? alphaMap : null,
        color: map ? (tint ? new THREE.Color(part(tint.R), part(tint.G), part(tint.B)) : 0xffffff) : 0x9a9a9a,
        emissive: emissiveMap ? new THREE.Color(glow?.R ?? 1, glow?.G ?? 1, glow?.B ?? 1) : 0x000000,
        emissiveIntensity: emissiveMap ? Math.min(2, m.Scalars?.EmissiveStrength ?? 1) : 0,
      })
      if (shade) {
        // the hair color rides in the AO slot (so three sets up its second UV set) and multiplies the base color instead
        mat.onBeforeCompile = (s: { fragmentShader: string }) => {
          s.fragmentShader = s.fragmentShader
            .replace('#include <map_fragment>', '#include <map_fragment>\n\tdiffuseColor.rgb *= texture2D( aoMap, vAoMapUv ).rgb;')
            .replace('#include <aomap_fragment>', '')
        }
        mat.customProgramCacheKey = () => 'shade-uv1'
      }
      if (normalMap) mat.normalScale.set(1, -1) // Unreal's normal maps keep green the other way up
      owned.push(mat)
      return mat
    }))
    mesh.material = Array.isArray(mesh.material) ? made : made[0]
  }
}

/** The kit's idle (format v1) as a clip on these bones: rotations for every bone it keys; translations only for the
 *  root, the pelvis and the ik_ helpers, so an idle borrowed from another skin keeps this mesh's own bone spacing. */
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
    if (t.t > 0 && /^(root|pelvis|ik_)/i.test(t.b)) {
      tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, t.t === 1 ? [0] : times, new Float32Array(bin, t.to, t.t * 3)))
    }
  }
  return new THREE.AnimationClip('idle', seconds, tracks)
}

/** Fits the camera to what is drawn in the idle's first pose (front view, a little above the waist), and returns the
 *  center plus reset (the double click). The turntable's widest view is the footprint's diagonal, so it never crops. */
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
  const fov = (camera.fov * Math.PI) / 180
  const reset = () => {
    const halfW = Math.hypot(size.x, size.z) / 2
    const fovH = 2 * Math.atan(Math.tan(fov / 2) * Math.max(0.3, camera.aspect))
    const d = Math.max(size.y / 2 / Math.tan(fov / 2), halfW / Math.tan(fovH / 2)) * 1.12 + size.z / 2
    camera.position.set(c.x, c.y + size.y * 0.04, c.z + d)
    camera.near = d / 50
    camera.far = d * 10
    camera.updateProjectionMatrix()
    controls.target.set(c.x, c.y, c.z)
    controls.update()
  }
  reset()
  ;(controls as unknown as { minDistance: number; maxDistance: number }).minDistance = Math.max(size.x, size.y, size.z) * 0.6
  ;(controls as unknown as { minDistance: number; maxDistance: number }).maxDistance = Math.max(size.x, size.y, size.z) * 4
  return { x: c.x, y: c.y, z: c.z, reset }
}
