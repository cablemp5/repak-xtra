// caleb fork: mod names shown whole (Caleb, 2026-10-14: no split into slug, tag chips and a version chip).

/** "1 mod", "3 mods" */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function ModName({ name }: { name: string }) {
  return <span className="mn"><span className="mn-slug">{name}</span></span>
}
