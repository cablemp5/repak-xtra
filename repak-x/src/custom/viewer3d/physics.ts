// repakxtra: Rotate in 3D's lobby physics and pose drivers. The lobby idle never keys a skin's hair, skirt, cape,
// earrings and ornaments: in the game the lobby mesh's PhysicsAsset swings them and its post-process AnimBlueprint's
// pose drivers turn the skirt's roots with the thighs. physics.json (the kit's viewer_physics, preview_fixes/
// viewer_lobby.py) carries both: per simulated bone its swing limit, damping and gravity scale, the kinematic bodies'
// capsules (legs, pelvis, spine, arms, head) the cloth stays out of, and per pose driver its targets and poses.
// Each frame, after the idle: the pose drivers set their bones, then every simulated bone's tip is a particle that
// keeps its speed (damped), falls, stays its length from the bone, inside its swing cone around where the animation
// puts it, and out of the capsules, and the bone turns to point at it. shortcut: one particle per bone (a verlet
// chain, no rigid bodies), twist limits and the bodies' masses are not used, and a little pull toward the animated
// pose keeps it steady; Unreal's solver is not replicated, upgrade if a cape needs real cloth
// Most skins' hair and skirts, and most mods with their own physics, swing on KawaiiPhysics nodes in that AnimBlueprint
// instead (physics.json `kawaii`): the same particles, stepped as the plugin steps them (the speed kept times
// 1 - Damping, half the gravity, a pull of Stiffness toward the animated shape, its node's own capsules, its angle limit),
// and as the view turns they lag behind by a fifth of the chain's share of the turn: the plugin passes on that much of
// the hero's own turning (WorldDampingRotation 0.8, its default), the full share threw hair and skirts out on every drag
import * as THREE from 'three/webgpu'

type Sim = { bone: string; parent: string | null; swing: (number | null)[]; linear: number; angular: number; gravity: number; radius: number }
type Collider = { bone: string; center: number[]; axis: number[]; half: number; radius: number; node?: number }
type Driver = { source: string; targets: number[][]; radius: number | null; bones: string[]; poses: (number[] | null)[][]; method?: 'quat' | 'swing'; fromRef?: boolean; normalize?: 'always' | 'above1'; additive?: boolean }
type Curve = 'damping' | 'stiffness' | 'radius' | 'limit'
type Chain = { node: number; root: string; exclude?: string[]; damping: number; stiffness: number; radius: number; limit: number; gravity: number[]; dummy: number; axis: number[]; turn?: number; curves?: Partial<Record<Curve, number[][]>> }
export type PhysicsData = { sim?: Sim[]; colliders?: Collider[]; drivers?: Driver[]; kawaii?: Chain[] }
type Bone = InstanceType<typeof THREE.Bone>
type V3 = InstanceType<typeof THREE.Vector3>
type Q = InstanceType<typeof THREE.Quaternion>

const X = new THREE.Vector3(1, 0, 0)
const TURN_KEPT = 0.2 // 1 - KawaiiPhysics WorldDampingRotation
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion()

/** Unreal's swing-angle distance between two local rotations (twist about X ignored), degrees. */
const swingAngle = (a: Q, b: Q) => THREE.MathUtils.radToDeg(v1.copy(X).applyQuaternion(a).angleTo(v2.copy(X).applyQuaternion(b)))
/** Unreal's quaternion distance: the whole angle between two rotations, twist included, degrees. */
const quatAngle = (a: Q, b: Q) => THREE.MathUtils.radToDeg(a.angleTo(b))

/** A curve's value at `t`: straight lines between its [time, value] keys, flat past the ends. */
export function curveAt(keys: number[][], t: number) {
  const i = keys.findIndex(k => k[0] >= t)
  if (i <= 0) return keys[i === 0 ? 0 : keys.length - 1][1]
  const [a, b] = [keys[i - 1], keys[i]]
  return a[1] + ((b[1] - a[1]) * (t - a[0])) / Math.max(b[0] - a[0], 1e-9)
}

/** A small dense matrix's inverse (Gauss-Jordan), null when singular. */
export function invert(m: number[][]): number[][] | null {
  const n = m.length, a = m.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r
    if (Math.abs(a[p][c]) < 1e-9) return null
    ;[a[c], a[p]] = [a[p], a[c]]
    const d = a[c][c]
    for (let k = 0; k < 2 * n; k++) a[c][k] /= d
    for (let r = 0; r < n; r++) if (r !== c) { const f = a[r][c]; for (let k = 0; k < 2 * n; k++) a[r][k] -= f * a[c][k] }
  }
  return a.map(r => r.slice(n))
}

/** The interpolative Gaussian RBF weights of `dist` (this input's distance to each target), its targets' kernel inverse
 *  `inv` and radius: exact at a target, negatives dropped, summing to 1 (Unreal's AlwaysNormalize). With `always` off
 *  (OnlyNormalizeAboveOne) a sum under 1 stays as it is. */
export function rbfWeights(dist: number[], inv: number[][], radius: number, always = true) {
  const phi = dist.map(d => Math.exp(-((d / radius) ** 2)))
  const w = phi.map((_, i) => Math.max(0, phi.reduce((s, p, j) => s + p * inv[j][i], 0)))
  const sum = w.reduce((s, x) => s + x, 0)
  if (sum <= 1e-6) return always ? w.map((_, i) => (i === dist.indexOf(Math.min(...dist)) ? 1 : 0)) : w
  return always || sum > 1 ? w.map(x => x / sum) : w
}

/** The lobby physics of a model, or null when its export has none. `bones`: its bones by lowercase name. `refPose`:
 *  their local rotations in the mesh's reference pose (before the idle moved them), by the same names. */
export function lobbyPhysics(root: InstanceType<typeof THREE.Object3D>, data: PhysicsData, bones: Map<string, Bone>, refPose: Map<string, Q>) {
  const key = (n: string) => THREE.PropertyBinding.sanitizeNodeName(n).toLowerCase() // as the loader names them
  const get = (n: string | null | undefined) => (n ? bones.get(key(n)) : undefined)
  // pose drivers: their targets, kernel and each driven bone's rest
  const drivers = (data.drivers ?? []).flatMap(d => {
    const source = get(d.source), driven = d.bones.map(get)
    if (!source || driven.some(b => !b) || d.targets.length < 2) return []
    const targets = d.targets.map(t => new THREE.Quaternion().fromArray(t).normalize())
    const far = d.method === 'quat' ? quatAngle : swingAngle
    const dist = targets.map(a => targets.map(b => far(a, b)))
    // automatic radius: the targets' mean distance from each other, as Unreal's
    const pairs = dist.flatMap((r, i) => r.filter((_, j) => j > i))
    const radius = Math.max(d.radius ?? pairs.reduce((s, x) => s + x, 0) / Math.max(pairs.length, 1), 1)
    const inv = invert(dist.map(r => r.map(x => Math.exp(-((x / radius) ** 2)))))
    if (!inv) return []
    const rest = (driven as Bone[]).map(b => ({ q: b.quaternion.clone(), p: b.position.clone() }))
    // fromRef: the targets are the source's turn away from its reference pose
    const from = d.fromRef ? refPose.get(key(d.source))?.clone().invert() : undefined
    return [{ source, targets, radius, inv, driven: driven as Bone[], rest, poses: d.poses, far, from, always: d.normalize !== 'above1', additive: d.additive === true }]
  })
  const dq = new THREE.Quaternion(), dp = new THREE.Vector3(), src = new THREE.Quaternion()
  const driverStep = () => {
    // an additive PoseAsset's poses are turns and moves on top of the bone, so its bones start each frame from their rest
    for (const d of drivers) if (d.additive) d.driven.forEach((b, k) => { b.quaternion.copy(d.rest[k].q); b.position.copy(d.rest[k].p) })
    for (const d of drivers) {
      if (d.from) src.multiplyQuaternions(d.from, d.source.quaternion)
      else src.copy(d.source.quaternion)
      const w = rbfWeights(d.targets.map(t => d.far(src, t)), d.inv, d.radius, d.always)
      if (d.additive) { // each pose's share of its turn goes on top of the bone as it stands (two drivers on one bone add up)
        d.driven.forEach((b, k) => w.forEach((wi, i) => {
          const pose = d.poses[i]?.[k]
          if (!pose || wi <= 1e-6) return
          b.quaternion.premultiply(q2.identity().slerp(q1.fromArray(pose), wi))
          b.position.addScaledVector(v3.fromArray(pose, 4), wi)
        }))
        continue
      }
      const left = Math.max(0, 1 - w.reduce((s, x) => s + x, 0)) // weight no target took stays on the bone's own pose
      d.driven.forEach((b, k) => {
        const q = dq.set(0, 0, 0, 0), p = dp.set(0, 0, 0)
        const add = (pose: number[] | null | undefined, wi: number) => {
          if (wi <= 1e-6) return
          q2.copy(pose ? q1.fromArray(pose) : d.rest[k].q)
          if (q.x * q2.x + q.y * q2.y + q.z * q2.z + q.w * q2.w < 0) q2.set(-q2.x, -q2.y, -q2.z, -q2.w) // one hemisphere
          q.set(q.x + q2.x * wi, q.y + q2.y * wi, q.z + q2.z * wi, q.w + q2.w * wi)
          p.addScaledVector(pose ? v3.fromArray(pose, 4) : d.rest[k].p, wi)
        }
        w.forEach((wi, i) => add(d.poses[i]?.[k], wi))
        add(null, left)
        if (q.lengthSq() > 1e-8) { b.quaternion.copy(q.normalize()); b.position.copy(p) }
      })
    }
  }

  const colliders = (data.colliders ?? []).flatMap(c => {
    const bone = get(c.bone)
    if (!bone || c.radius <= 0) return []
    const axis = new THREE.Vector3().fromArray(c.axis).normalize().multiplyScalar(c.half), center = new THREE.Vector3().fromArray(c.center)
    return [{ bone, a: center.clone().sub(axis), b: center.clone().add(axis), radius: c.radius, node: c.node, wa: new THREE.Vector3(), wb: new THREE.Vector3() }]
  })
  const own = colliders.flatMap((c, i) => (c.node === undefined ? [i] : [])) // the PhysicsAsset's bodies
  // simulated bones, parents first, each with its tip (its child's offset, or one link along its axis at a chain's end).
  // keep, pull and fall are per 1/60 s: the speed kept, the pull toward the animated pose, and the fall (meters).
  // turn: the share of the view's turn the particle lags behind by
  const depth = (o: { parent: unknown } | null) => { let n = 0; for (let p = o; p; p = (p as { parent: { parent: unknown } | null }).parent) n++; return n }
  const row = (bone: Bone, tip: V3, o: { limit: number; radius: number; keep: number; pull: number; fall: V3; kawaii: boolean; cols: number[]; turn: number }) => ({
    bone, tip, ...o, rest: bone.quaternion.clone(), ref: bone.quaternion.clone(), p: new THREE.Vector3(), prev: new THREE.Vector3(), ready: false,
    driven: drivers.some(d => d.driven.includes(bone)), poseHead: new THREE.Vector3(), poseTip: new THREE.Vector3(), poseQ: new THREE.Quaternion() })
  const sims = (data.sim ?? []).flatMap(s => {
    const bone = get(s.bone)
    if (!bone) return []
    const child = bone.children.find((c: { isBone?: boolean }) => c.isBone) as Bone | undefined
    const tip = child ? child.position.clone() : new THREE.Vector3(Math.max(bone.position.length(), 0.02), 0, 0) // chains run along +X
    if (tip.lengthSq() < 1e-10) return []
    // the wider of its two swings (an ellipse in Unreal): the narrower froze a bone with one axis locked
    const limit = s.swing.every(x => x === null) ? Math.PI : THREE.MathUtils.degToRad(Math.max(...s.swing.map(x => x ?? 180)))
    return [row(bone, tip, { limit, radius: s.radius, keep: Math.exp(-(s.linear + s.angular * 0.25) / 60), pull: 1 / 12, fall: new THREE.Vector3(0, (-9.8 * s.gravity) / 3600, 0), kawaii: false, cols: own, turn: 0 })]
  })
  // a capsule a bone's tip already sits in at the start (a skirt root inside its thigh's capsule) is no wall for it:
  // pushed out every frame, the skirt stood off the legs (the asset's own collision table is not exported)
  root.updateMatrixWorld(true)
  for (const s of sims) {
    const tip = v1.copy(s.tip).applyMatrix4(s.bone.matrixWorld)
    s.cols = own.filter(i => {
      const c = colliders[i], a = v2.copy(c.a).applyMatrix4(c.bone.matrixWorld), seg = v3.copy(c.b).applyMatrix4(c.bone.matrixWorld).sub(a)
      const t = THREE.MathUtils.clamp(tip.clone().sub(a).dot(seg) / Math.max(seg.lengthSq(), 1e-12), 0, 1)
      return tip.distanceTo(a.addScaledVector(seg, t)) >= c.radius + s.radius
    })
  }
  // KawaiiPhysics chains: every bone under the root (less the ones left out) turns toward the particle of its first
  // child, a leaf toward a dummy bone along its axis. A value with a curve is scaled by it at the particle's share of
  // the chain's length. shortcut: a bone with several children follows the first (the plugin: the last one stepped)
  const taken = new Set(sims.map(s => s.bone))
  for (const c of data.kawaii ?? []) {
    const start = get(c.root), out = new Set((c.exclude ?? []).map(get))
    if (!start) continue
    const found: { bone: Bone; tip: V3; at: number }[] = []
    const walk = (bone: Bone, at: number) => {
      const kids = bone.children.filter((k: { isBone?: boolean }) => k.isBone && !out.has(k as Bone)) as Bone[]
      if (kids.length) found.push({ bone, tip: kids[0].position.clone(), at: at + kids[0].position.length() })
      else if (c.dummy > 0) found.push({ bone, tip: new THREE.Vector3().fromArray(c.axis).multiplyScalar(c.dummy), at: at + c.dummy })
      for (const k of kids) walk(k, at + k.position.length())
    }
    walk(start, 0)
    const total = Math.max(...found.map(f => f.at), 1e-6)
    const cols = colliders.flatMap((x, i) => (x.node === c.node ? [i] : []))
    for (const f of found) {
      if (taken.has(f.bone) || f.tip.lengthSq() < 1e-10) continue
      taken.add(f.bone)
      const at = (k: Curve) => c[k] * (c.curves?.[k]?.length ? curveAt(c.curves[k]!, f.at / total) : 1)
      const limit = at('limit')
      sims.push(row(f.bone, f.tip, { limit: limit > 0 ? THREE.MathUtils.degToRad(limit) : Math.PI, radius: at('radius'), keep: 1 - THREE.MathUtils.clamp(at('damping'), 0, 1),
        pull: THREE.MathUtils.clamp(at('stiffness'), 0, 1), fall: new THREE.Vector3().fromArray(c.gravity).multiplyScalar(0.5 / 3600), kawaii: true, cols, turn: THREE.MathUtils.clamp(c.turn ?? 0, 0, 1) }))
    }
  }
  sims.sort((a, b) => depth(a.bone) - depth(b.bone))
  if (!drivers.length && !sims.length) return null
  const scale = new THREE.Vector3()
  const head = new THREE.Vector3(), want = new THREE.Vector3(), mp = new THREE.Vector3(), ms = new THREE.Vector3()
  const parentQ = new THREE.Quaternion(), worldQ = new THREE.Quaternion(), origin = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0)
  let before = 1 / 60

  // one step of `h` seconds, as the plugin steps at any frame rate: the speed is what the last step moved over its own
  // length, and the speed kept, the pull and the fall are scaled to the step (`e` sixtieths of a second)
  const step = (h: number, turn: number) => {
    root.getWorldScale(scale)
    root.getWorldPosition(origin)
    const k = scale.y || 1, e = h * 60
    for (const s of sims) {
      s.bone.quaternion.copy(s.ref) // the animated pose: its rest (the idle never keys it), or its pose driver's
      s.bone.updateWorldMatrix(false, false)
      head.setFromMatrixPosition(s.bone.matrixWorld)
      // where the animation puts its tip: under the bones above as they now stand, or (KawaiiPhysics) at the animated
      // pose's own offset from this bone, whichever way the bones above have swung
      if (s.kawaii) want.copy(head).add(s.poseTip).sub(s.poseHead)
      else want.copy(s.tip).applyMatrix4(s.bone.matrixWorld)
      const len = head.distanceTo(want)
      if (!s.ready) { s.p.copy(want); s.prev.copy(want); s.ready = true }
      // verlet: keep the speed (damped), lag behind the view's turn, fall, and lean toward the animated pose
      v1.subVectors(s.p, s.prev).multiplyScalar((Math.pow(s.keep, e) * h) / before)
      s.prev.copy(s.p)
      s.p.add(v1)
      if (turn && s.turn) s.p.add(v2.subVectors(s.prev, origin).applyAxisAngle(UP, turn * s.turn * TURN_KEPT).add(origin).sub(s.prev))
      s.p.addScaledVector(s.fall, k * e * e).lerp(want, 1 - Math.pow(1 - s.pull, e))
      // out of the body's capsules
      for (const i of s.cols) {
        const c = colliders[i], seg = v2.subVectors(c.wb, c.wa), t = THREE.MathUtils.clamp(v3.subVectors(s.p, c.wa).dot(seg) / Math.max(seg.lengthSq(), 1e-12), 0, 1)
        const near = v3.copy(c.wa).addScaledVector(seg, t), r = (c.radius + s.radius) * k
        const d = s.p.distanceTo(near)
        if (d < r && d > 1e-9) s.p.sub(near).multiplyScalar(r / d).add(near)
      }
      // inside its swing cone around the animated direction, at its length
      const rest = v1.subVectors(want, head).normalize(), dir = v2.subVectors(s.p, head)
      if (dir.lengthSq() < 1e-12) dir.copy(rest)
      dir.normalize()
      const angle = rest.angleTo(dir)
      if (angle > s.limit) {
        const axis = v3.crossVectors(rest, dir)
        if (axis.lengthSq() > 1e-12) dir.copy(rest).applyAxisAngle(axis.normalize(), s.limit)
      }
      s.p.copy(head).addScaledVector(dir, len)
      // the bone turns its tip from the animated direction to the particle
      q1.setFromUnitVectors(rest, dir)
      s.bone.parent!.matrixWorld.decompose(mp, parentQ, ms) // current: parents come first and update as they go
      if (s.kawaii) worldQ.copy(s.poseQ)
      else worldQ.multiplyQuaternions(parentQ, s.ref)
      s.bone.quaternion.copy(parentQ.invert().multiply(q1.multiply(worldQ)))
      s.bone.updateWorldMatrix(false, false)
    }
    before = h
  }

  return {
    /** One frame: the pose drivers, then the physics in steps of about 1/60 s (one shorter step at a faster screen:
     *  a whole 1/60 s step per frame ran the hair 2.4 times too fast while a 144 Hz view turned). `turn`: how far the
     *  view turned about the model since the last frame (radians). The body's capsules are placed once a frame. */
    update(dt: number, turn = 0) {
      driverStep()
      for (const s of sims) { s.ref.copy(s.driven ? s.bone.quaternion : s.rest); if (s.kawaii) s.bone.quaternion.copy(s.ref) }
      root.updateMatrixWorld(true)
      // KawaiiPhysics pulls toward the animated pose itself: where it puts each bone and its tip this frame
      for (const s of sims) {
        if (!s.kawaii) continue
        s.poseHead.setFromMatrixPosition(s.bone.matrixWorld)
        s.poseTip.copy(s.tip).applyMatrix4(s.bone.matrixWorld)
        s.bone.matrixWorld.decompose(mp, s.poseQ, ms)
      }
      for (const c of colliders) { c.wa.copy(c.a).applyMatrix4(c.bone.matrixWorld); c.wb.copy(c.b).applyMatrix4(c.bone.matrixWorld) }
      const n = THREE.MathUtils.clamp(Math.round(dt * 60), 1, 6), h = Math.max(dt, 1 / 480) / n
      if (Math.abs(turn) > 2) turn = 0 // a jump, not a turn
      for (let i = 0; i < n; i++) step(h, turn / n)
    },
  }
}

if (import.meta.env.DEV) {
  // at a target its pose alone, halfway between two the weights split, and an inverse times its matrix is the identity
  const m = [[1, 0.2], [0.2, 1]], inv = invert(m)!
  console.assert(Math.abs(m[0][0] * inv[0][0] + m[0][1] * inv[1][0] - 1) < 1e-9, 'physics: invert')
  const k = (d: number) => Math.exp(-((d / 45) ** 2)), K = invert([[1, k(45)], [k(45), 1]])!
  const at = rbfWeights([0, 45], K, 45), mid = rbfWeights([22.5, 22.5], K, 45)
  console.assert(Math.abs(at[0] - 1) < 1e-6 && at[1] < 1e-6, 'physics: a target weighs 1', at)
  console.assert(Math.abs(mid[0] - 0.5) < 1e-6, 'physics: halfway splits', mid)
  // far from every target: all of the weight goes to the nearest (always), or none is taken (above one only)
  console.assert(rbfWeights([900, 950], K, 45)[0] === 1 && rbfWeights([900, 950], K, 45, false)[0] < 1e-6, 'physics: far from every target')
  console.assert(curveAt([[0, 1], [1, 2]], 0.5) === 1.5 && curveAt([[0, 1], [1, 2]], -1) === 1 && curveAt([[0, 1], [1, 2]], 3) === 2, 'physics: curve')
}
