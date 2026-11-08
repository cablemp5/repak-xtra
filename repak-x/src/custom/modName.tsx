// repakxtra: mod names shown whole (no split into slug, tag chips and a version chip).

/** "1 mod", "3 mods" */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** "1st", "2nd", "3rd", "11th", "22nd" */
export const ordinal = (n: number) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
if (import.meta.env.DEV) {
  console.assert([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal).join() === '1st,2nd,3rd,4th,11th,12th,13th,21st,22nd,101st,111th', 'ordinal')
}

export function ModName({ name }: { name: string }) {
  return <span className="mn"><span className="mn-slug">{name}</span></span>
}
