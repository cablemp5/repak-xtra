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
import * as THREE from 'three/webgpu'

type Sim = { bone: string; parent: string | null; swing: (number | null)[]; linear: number; angular: number; gravity: number; radius: number }
type Collider = { bone: string; center: number[]; axis: number[]; half: number; radius: number }
type Driver = { source: string; targets: number[][]; radius: number | null; bones: string[]; poses: (number[] | null)[][] }
export type PhysicsData = { sim?: Sim[]; colliders?: Collider[]; drivers?: Driver[] }
type Bone = InstanceType<typeof THREE.Bone>
type V3 = InstanceType<typeof THREE.Vector3>
type Q = InstanceType<typeof THREE.Quaternion>

const X = new THREE.Vector3(1, 0, 0)
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion()

/** Unreal's swing-angle distance between two local rotations (twist about X ignored), degrees. */
const swingAngle = (a: Q, b: Q) => THREE.MathUtils.radToDeg(v1.copy(X).applyQuaternion(a).angleTo(v2.copy(X).applyQuaternion(b)))

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
 *  `inv` and radius: exact at a target, negatives dropped, summing to 1 (Unreal's AlwaysNormalize). */
export function rbfWeights(dist: number[], inv: number[][], radius: number) {
  const phi = dist.map(d => Math.exp(-((d / radius) ** 2)))
  const w = phi.map((_, i) => Math.max(0, phi.reduce((s, p, j) => s + p * inv[j][i], 0)))
  const sum = w.reduce((s, x) => s + x, 0)
  return sum > 1e-6 ? w.map(x => x / sum) : w.map((_, i) => (i === dist.indexOf(Math.min(...dist)) ? 1 : 0))
}

/** The lobby physics of a model, or null when its export has none. `bones`: its bones by lowercase name. */
export function lobbyPhysics(root: InstanceType<typeof THREE.Object3D>, data: PhysicsData, bones: Map<string, Bone>) {
  const get = (n: string | null | undefined) => (n ? bones.get(THREE.PropertyBinding.sanitizeNodeName(n).toLowerCase()) : undefined) // as the loader names them
  // pose drivers: their targets, kernel and each driven bone's rest
  const drivers = (data.drivers ?? []).flatMap(d => {
    const source = get(d.source), driven = d.bones.map(get)
    if (!source || driven.some(b => !b) || d.targets.length < 2) return []
    const targets = d.targets.map(t => new THREE.Quaternion().fromArray(t).normalize())
    const dist = targets.map(a => targets.map(b => swingAngle(a, b)))
    // automatic radius: the targets' mean distance from each other, as Unreal's
    const pairs = dist.flatMap((r, i) => r.filter((_, j) => j > i))
    const radius = Math.max(d.radius ?? pairs.reduce((s, x) => s + x, 0) / Math.max(pairs.length, 1), 1)
    const inv = invert(dist.map(r => r.map(x => Math.exp(-((x / radius) ** 2)))))
    if (!inv) return []
    const rest = (driven as Bone[]).map(b => ({ q: b.quaternion.clone(), p: b.position.clone() }))
    return [{ source, targets, radius, inv, driven: driven as Bone[], rest, poses: d.poses }]
  })
  const dq = new THREE.Quaternion(), dp = new THREE.Vector3()
  const driverStep = () => {
    for (const d of drivers) {
      const w = rbfWeights(d.targets.map(t => swingAngle(d.source.quaternion, t)), d.inv, d.radius)
      d.driven.forEach((b, k) => {
        const q = dq.set(0, 0, 0, 0), p = dp.set(0, 0, 0)
        w.forEach((wi, i) => {
          if (wi <= 0) return
          const pose = d.poses[i]?.[k]
          q2.copy(pose ? q1.fromArray(pose) : d.rest[k].q)
          if (q.x * q2.x + q.y * q2.y + q.z * q2.z + q.w * q2.w < 0) q2.set(-q2.x, -q2.y, -q2.z, -q2.w) // one hemisphere
          q.set(q.x + q2.x * wi, q.y + q2.y * wi, q.z + q2.z * wi, q.w + q2.w * wi)
          p.addScaledVector(pose ? v3.fromArray(pose, 4) : d.rest[k].p, wi)
        })
        if (q.lengthSq() > 1e-8) { b.quaternion.copy(q.normalize()); b.position.copy(p) }
      })
    }
  }

  // simulated bones, parents first, each with its tip (its child's offset, or one link along its axis at a chain's end)
  const depth = (o: { parent: unknown } | null) => { let n = 0; for (let p = o; p; p = (p as { parent: { parent: unknown } | null }).parent) n++; return n }
  const sims = (data.sim ?? []).flatMap(s => {
    const bone = get(s.bone)
    if (!bone) return []
    const child = bone.children.find((c: { isBone?: boolean }) => c.isBone) as Bone | undefined
    const tip = child ? child.position.clone() : new THREE.Vector3(Math.max(bone.position.length(), 0.02), 0, 0) // chains run along +X
    if (tip.lengthSq() < 1e-10) return []
    // the wider of its two swings (an ellipse in Unreal): the narrower froze a bone with one axis locked
    const limit = s.swing.every(x => x === null) ? Math.PI : THREE.MathUtils.degToRad(Math.max(...s.swing.map(x => x ?? 180)))
    return [{ bone, tip, limit, rest: bone.quaternion.clone(), ref: bone.quaternion.clone(), radius: s.radius, drag: s.linear + s.angular * 0.25, gravity: s.gravity,
      p: new THREE.Vector3(), prev: new THREE.Vector3(), ready: false, skip: new Set<number>(), driven: drivers.some(d => d.driven.includes(bone)) }]
  }).sort((a, b) => depth(a.bone) - depth(b.bone))
  const colliders = (data.colliders ?? []).flatMap(c => {
    const bone = get(c.bone)
    if (!bone || c.radius <= 0) return []
    const axis = new THREE.Vector3().fromArray(c.axis).normalize().multiplyScalar(c.half), center = new THREE.Vector3().fromArray(c.center)
    return [{ bone, a: center.clone().sub(axis), b: center.clone().add(axis), radius: c.radius, wa: new THREE.Vector3(), wb: new THREE.Vector3() }]
  })
  if (!drivers.length && !sims.length) return null
  // a capsule a bone's tip already sits in at the start (a skirt root inside its thigh's capsule) is no wall for it:
  // pushed out every frame, the skirt stood off the legs (the asset's own collision table is not exported)
  root.updateMatrixWorld(true)
  for (const s of sims) {
    const tip = v1.copy(s.tip).applyMatrix4(s.bone.matrixWorld)
    colliders.forEach((c, i) => {
      const a = v2.copy(c.a).applyMatrix4(c.bone.matrixWorld), seg = v3.copy(c.b).applyMatrix4(c.bone.matrixWorld).sub(a)
      const t = THREE.MathUtils.clamp(tip.clone().sub(a).dot(seg) / Math.max(seg.lengthSq(), 1e-12), 0, 1)
      if (tip.distanceTo(a.addScaledVector(seg, t)) < c.radius + s.radius) s.skip.add(i)
    })
  }
  const scale = new THREE.Vector3()
  const head = new THREE.Vector3(), want = new THREE.Vector3(), mp = new THREE.Vector3(), ms = new THREE.Vector3()
  const parentQ = new THREE.Quaternion(), worldQ = new THREE.Quaternion()

  const step = (dt: number) => {
    root.getWorldScale(scale)
    const k = scale.y || 1
    const fall = -9.8 * k * dt * dt
    for (const s of sims) {
      s.bone.quaternion.copy(s.ref) // the animated pose: its rest (the idle never keys it), or its pose driver's
      s.bone.updateWorldMatrix(false, false)
      head.setFromMatrixPosition(s.bone.matrixWorld)
      want.copy(s.tip).applyMatrix4(s.bone.matrixWorld) // where the animation puts its tip
      const len = head.distanceTo(want)
      if (!s.ready) { s.p.copy(want); s.prev.copy(want); s.ready = true }
      // verlet: keep the speed (damped), fall, and lean a little toward the animated pose
      const keep = Math.exp(-s.drag * dt)
      v1.subVectors(s.p, s.prev).multiplyScalar(keep)
      s.prev.copy(s.p)
      s.p.add(v1).add(v2.set(0, fall * s.gravity, 0)).lerp(want, Math.min(1, 2 * dt))
      // out of the body's capsules
      for (let i = 0; i < colliders.length; i++) {
        if (s.skip.has(i)) continue
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
      worldQ.multiplyQuaternions(parentQ, s.ref)
      s.bone.quaternion.copy(parentQ.invert().multiply(q1.multiply(worldQ)))
      s.bone.updateWorldMatrix(false, false)
    }
  }

  return {
    /** One frame: the pose drivers, then the physics in fixed 1/60 s steps (as many as the frame took, at most 4: a
     *  step length that changed frame to frame made verlet jitter). The body's capsules are placed once a frame. */
    update(dt: number) {
      driverStep()
      for (const s of sims) s.ref.copy(s.driven ? s.bone.quaternion : s.rest)
      root.updateMatrixWorld(true)
      for (const c of colliders) { c.wa.copy(c.a).applyMatrix4(c.bone.matrixWorld); c.wb.copy(c.b).applyMatrix4(c.bone.matrixWorld) }
      const n = THREE.MathUtils.clamp(Math.round(dt * 60), 1, 4)
      for (let i = 0; i < n; i++) step(1 / 60)
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
}
