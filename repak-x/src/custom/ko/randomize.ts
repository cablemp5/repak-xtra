import { hexOf, type Role } from './model'
import { hexToHsv, hsvToHex } from './ColorPicker'

export type RandomizeOptions = { keepNeutral: boolean; hue: boolean; saturation: boolean; value: boolean }
export const DEFAULT_RANDOMIZE: RandomizeOptions = { keepNeutral: true, hue: true, saturation: false, value: false }

export function randomizeColors(roles: Pick<Role, 'id' | 'rgba'>[], colors: Map<string, string>, options: RandomizeOptions, random = Math.random): Record<string, string> {
  return Object.fromEntries(roles.flatMap(r => {
    const game = hexOf(r.rgba), hex = colors.get(r.id) ?? game
    let next = hex
    if (!(options.keepNeutral && /^#(000000|ffffff)$/i.test(hex)) && (options.hue || options.saturation || options.value)) {
      const [h, s, v] = hexToHsv(hex.slice(1))
      next = '#' + hsvToHex(options.hue ? random() * 360 : h, options.saturation ? random() : s, options.value ? random() : v).toUpperCase()
    }
    return next.toUpperCase() === game ? [] : [[r.id, next]]
  }))
}

if (import.meta.env.DEV) {
  const roles = [
    { id: 'black', rgba: { R: 0, G: 0, B: 0, A: 1 } },
    { id: 'white', rgba: { R: 1, G: 1, B: 1, A: 1 } },
    { id: 'red', rgba: { R: 1, G: 0, B: 0, A: 1 } },
  ]
  const kept = randomizeColors(roles, new Map(), DEFAULT_RANDOMIZE, () => 1 / 3)
  console.assert(!('black' in kept) && !('white' in kept) && kept.red === '#00FF00', 'randomization keeps default black and white out of saved edits')
  delete kept.red
  console.assert(Object.keys(kept).length === 0, 'resetting the changed rows leaves no saved colors or sidebar dot')
  console.assert(randomizeColors(roles, new Map([['red', '#FFFFFF']]), DEFAULT_RANDOMIZE).red === '#FFFFFF', 'shuffle respects current color overrides')
  const saturation = { ...DEFAULT_RANDOMIZE, hue: false, saturation: true }
  console.assert(randomizeColors(roles, new Map(), saturation, () => 0.5).red === '#FF8080', 'saturation randomization preserves hue and value')
  const value = { ...DEFAULT_RANDOMIZE, hue: false, value: true }
  console.assert(randomizeColors(roles, new Map(), value, () => 0.5).red === '#800000', 'value randomization preserves hue and saturation')
  const all = { keepNeutral: false, hue: true, saturation: true, value: true }
  const mixed = randomizeColors(roles, new Map(), all, () => 0.5)
  console.assert(Object.values(mixed).every(hex => hex === '#408080'), 'all channels can randomize black and white when preservation is off')
  const protectedColors = randomizeColors(roles, new Map(), { ...all, keepNeutral: true }, () => 0.5)
  console.assert(!('black' in protectedColors) && !('white' in protectedColors), 'preservation also applies when all three channels are selected')
  console.assert(randomizeColors(roles, new Map([['red', '#AbC123']]), { ...all, hue: false, saturation: false, value: false }).red === '#AbC123', 'no selected channels leaves colors unchanged')
}
