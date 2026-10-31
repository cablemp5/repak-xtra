// repakxtra: the status line a loadout card (and the details panel) shows while its preview renders: the step the preview
// kit's generator says it is on (mod_previews.py prints "PREVIEW_STAGE <step>", xtra_previews.rs passes it on as
// mod-preview-stage). About 1 step in 50 opens with an easter egg for a moment, then says what it is doing.
// A kit from before the steps were reported never names one: the line then says only that the preview is generating.

/** How long an easter egg shows before the step it stands in for. */
export const EGG_MS = 2600

/** What each of the generator's steps does, in its order for a skin. */
// The words say what the step really does (2026-10-21: "mount" is a file copy, the game loads during export, and
// "finish" sizes and saves the image). Keys a newer kit may print are here already, so it needs no app update.
const STEPS: Record<string, string> = {
  read: 'Reading the mod files',
  mount: 'Copying the mod files',
  unpack: 'Unpacking an encrypted mod',
  skins: "Listing the game's skins",
  table: 'Reading the skin table',
  export: 'Loading the game and exporting the model',
  materials: 'Reading the material settings',
  pose: 'Getting the lobby pose',
  blender: 'Loading the model into Blender',
  shading: 'Building the materials',
  render: 'Rendering in Blender',
  glow: 'Rendering the glow',
  finish: 'Finishing the image',
  ui: 'Reading the UI images',
  vfx: 'Comparing the effect colors',
  clips: 'Reading the animation clips',
  rig: 'Exporting the clips and the model',
  anim: 'Rendering the animation',
  webp: 'Saving the animation',
  ko: 'Recording the KO prompt', // custom/ko/koPreview.ts, not the kit
  sound: 'Reading the sound banks',
}
const UNKNOWN = 'Generating the preview'

const EGGS = [
  'Nerfing Black Panther',
  'Buffing Gambit',
  'Making a new Luna skin',
  'Glazing Haunt',
  'Watching Karkat',
  'Hitting a Cable combo',
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
  return h % 50 === 0 ? EGGS[(h >>> 5) % EGGS.length] : null
}

/** The words for a generator step; an unknown or missing one (an older kit) says only that it is generating. Pure. */
export const stepText = (step: string | undefined) => (step && STEPS[step]) || UNKNOWN

if (import.meta.env.DEV) {
  console.assert(stepText('render') === 'Rendering in Blender' && stepText(undefined) === UNKNOWN && stepText('new-step') === UNKNOWN, 'stepText')
  console.assert(stepEgg('x') === stepEgg('x'), 'stepEgg: the same step rolls the same')
  const eggs = Array.from({ length: 2000 }, (_, i) => stepEgg(`r${i}:render`)).filter(Boolean).length
  console.assert(eggs > 15 && eggs < 70, `stepEgg: about 1 in 50 steps (got ${eggs} of 2000)`)
}
