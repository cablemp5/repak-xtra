/** repakxtra: a plain name for a color ("5d7a80" is "Slate"), for CustomQuake's row in the Library. The nearest of a short
 *  list of common colors, by the "redmean" distance (cheap, and closer to how the eye sees color than plain RGB). */
const NAMED: [string, string][] = [
  ['Black', '000000'], ['Dark Gray', '404040'], ['Gray', '808080'], ['Light Gray', 'c0c0c0'], ['White', 'ffffff'], ['Slate', '708090'],
  ['Red', 'ff0000'], ['Dark Red', '8b0000'], ['Orange', 'ffa500'], ['Brown', '8b5a2b'], ['Tan', 'd2b48c'], ['Yellow', 'ffff00'],
  ['Green', '00ff00'], ['Dark Green', '006400'], ['Light Green', '90ee90'], ['Olive', '808000'], ['Teal', '008080'], ['Cyan', '00ffff'],
  ['Light Blue', '87ceeb'], ['Blue', '0000ff'], ['Navy', '000080'], ['Purple', '800080'], ['Violet', '8a2be2'],
  ['Pink', 'ffc0cb'], ['Hot Pink', 'ff69b4'], ['Magenta', 'ff00ff'],
]

const rgb = (hex: string) => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16))

/** The common color nearest to a 6 digit hex ("5d7a80"). Pure. */
export function colorName(hex: string): string {
  const [r, g, b] = rgb(hex)
  let best = NAMED[0][0]
  let bestD = Infinity
  for (const [name, h] of NAMED) {
    const [r2, g2, b2] = rgb(h)
    const m = (r + r2) / 2
    const d = (2 + m / 256) * (r - r2) ** 2 + 4 * (g - g2) ** 2 + (2 + (255 - m) / 256) * (b - b2) ** 2
    if (d < bestD) { bestD = d; best = name }
  }
  return best
}

if (import.meta.env.DEV) {
  console.assert(colorName('5d7a80') === 'Slate' && colorName('82c6ed') === 'Light Blue' && colorName('ff0000') === 'Red' && colorName('00ff04') === 'Green' && colorName('ffffff') === 'White', 'color names')
}
