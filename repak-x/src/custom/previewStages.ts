// repakxtra: the status line a loadout card (and the details panel) shows while its preview renders: the step the preview
// kit's generator says it is on (mod_previews.py prints "PREVIEW_STAGE <step>", xtra_previews.rs passes it on as
// mod-preview-stage). About 1 step in 20 opens with an easter egg for a moment, then says what it is doing.
// A kit from before the steps were reported never names one: the line then says only that the preview is generating.

/** How long an easter egg shows before the step it stands in for. */
export const EGG_MS = 2600

/** What each of the generator's steps does, in its order for a skin. */
const STEPS: Record<string, string> = {
  read: 'Reading the mod files',
  mount: 'Loading the mods over the game',
  unpack: 'Unpacking an encrypted mod',
  export: 'Exporting the model and textures',
  materials: 'Working out the materials',
  pose: 'Getting the lobby pose',
  render: 'Rendering in Blender',
  finish: 'Adding the glow',
  ui: 'Reading the UI images',
  vfx: 'Comparing the effect colors',
  anim: 'Rendering the animation',
  sound: 'Reading the sound banks',
}
const UNKNOWN = 'Generating the preview'

const EGGS = [
  'Nerfing Black Panther',
  'Buffing Gambit',
  'Making a new Luna skin',
  'Convincing Hulk to sit still',
  'Asking Loki to pick one form',
  'Feeding Jeff',
  'Untangling Venom',
  'Telling Groot to say something else',
  'Putting the squirrels to bed',
  'Polishing Mjolnir',
  'Rerolling Magik\'s portals',
  'Reading the patch notes twice',
]

/** A steady number from a string (FNV-1a, then mixed), so a step's roll stays the same on every re-render. Pure. */
const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  // murmur3's final mix: FNV's low bits alone are uneven, and the egg roll reads them
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** The easter egg a step opens with, or null (most steps). `seed` names the run, the mod and the step. Pure. */
export const stepEgg = (seed: string) => {
  const h = hash(seed)
  return h % 20 === 0 ? EGGS[(h >>> 5) % EGGS.length] : null
}

/** The words for a generator step; an unknown or missing one (an older kit) says only that it is generating. Pure. */
export const stepText = (step: string | undefined) => (step && STEPS[step]) || UNKNOWN

if (import.meta.env.DEV) {
  console.assert(stepText('render') === 'Rendering in Blender' && stepText(undefined) === UNKNOWN && stepText('new-step') === UNKNOWN, 'stepText')
  console.assert(stepEgg('x') === stepEgg('x'), 'stepEgg: the same step rolls the same')
  const eggs = Array.from({ length: 2000 }, (_, i) => stepEgg(`r${i}:render`)).filter(Boolean).length
  console.assert(eggs > 40 && eggs < 180, `stepEgg: about 1 in 20 steps (got ${eggs} of 2000)`)
}
