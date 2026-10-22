// repakxtra: which names the VFX Updater carries over. Includes pick the color properties of blueprints and data tables
// (a name containing any of them), excludes are never carried, material parameters included. Edited in the VFX window's
// Color names, saved as repakxtra.vfx.filter (so the dev copy shares it). The defaults are the upstream updater's lists.
export type ColorFilter = { includes: string[]; excludes: string[] }

export const DEFAULT_FILTER: ColorFilter = {
  includes: ['color', 'emissive', 'glow', 'tint', 'Enemy', 'Emiss', 'Diff'],
  excludes: ['Offset', 'uv', 'ColorMaskChannel', 'MaskColor_Enemy'],
}

const KEY = 'repakxtra.vfx.filter'
const words = (v: unknown) => (Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string' && w.trim() !== '').map(w => w.trim()) : null)

export function readFilter(): ColorFilter {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    const includes = words(v?.includes), excludes = words(v?.excludes)
    if (includes && excludes) return { includes, excludes }
  } catch { /* unreadable: the defaults */ }
  return DEFAULT_FILTER
}

export const writeFilter = (f: ColorFilter) => localStorage.setItem(KEY, JSON.stringify(f))
export const resetFilter = () => localStorage.removeItem(KEY)

/** "color, glow,  tint" -> ["color", "glow", "tint"]. */
export const parseWords = (text: string) => text.split(',').map(w => w.trim()).filter(Boolean)

const hits = (name: string, list: string[]) => { const n = name.toLowerCase(); return list.some(w => n.includes(w.toLowerCase())) }
export const isExcluded = (name: string, f: ColorFilter) => hits(name, f.excludes)
export const matchesFilter = (name: string, f: ColorFilter) => !hits(name, f.excludes) && hits(name, f.includes)

if (import.meta.env.DEV) {
  console.assert(matchesFilter('WBP_Hud - BaseColor', DEFAULT_FILTER) && !matchesFilter('Panel - UVOffset', DEFAULT_FILTER), 'includes pick colors, excludes win')
  console.assert(parseWords(' a, ,b ').join('|') === 'a|b', 'comma lists drop blanks')
}
