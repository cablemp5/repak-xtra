// repakxtra: one quiet line per mod type for what makes working mods look broken: sounds tied to cooldowns in the
// practice range. Shown in mod details and as the type badge's tooltip.

export function typeHint(category: string | null | undefined) {
  if (category === 'Audio') return 'In the practice range, sounds tied to cooldowns (like dash resets) stay silent while no-cooldowns is on.'
  return undefined
}

/** The hint for this type, or undefined: for the type badge's title. */
export const useTypeHint = (category: string | null | undefined) => typeHint(category)

/** ModDetailsPanel's line under the type badges. */
export function TypeHint({ category }: { category?: string | null }) {
  const hint = useTypeHint(category)
  return hint ? <p className="type-hint">{hint}</p> : null
}

if (import.meta.env.DEV) {
  console.assert(typeHint('Audio')?.startsWith('In the practice range') && !typeHint('UI') && !typeHint('Mesh'), 'type hints')
}
