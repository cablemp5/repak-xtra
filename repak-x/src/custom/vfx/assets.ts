// repakxtra: what Fix VFX mods carries from a mod's asset JSON onto the game's (UAssetAPI JSON from UAssetTool's to_json).
// Material instances: every Scalar, Vector and Texture parameter entry, matched by its ParameterInfo (name, association,
// index) and copied whole. A texture parameter points into the asset's import table, so the texture's imports (and their
// names) are added to the game's JSON when it does not import that texture yet. Blueprints and data tables: color
// properties picked by name (filter.ts), found again in the game's JSON by property names rather than positions, so an
// update that adds or reorders properties does not break the match. Started from the upstream VFX Updater's lib/.
import type { ColorFilter } from './filter'
import { isExcluded, matchesFilter } from './filter'

type Json = any // UAssetAPI's JSON: deep, loosely typed, edited in place

export type ParamList = 'ScalarParameterValues' | 'VectorParameterValues' | 'TextureParameterValues'
export const PARAM_LISTS: ParamList[] = ['ScalarParameterValues', 'VectorParameterValues', 'TextureParameterValues']
export type ParamId = { name: string; association?: string; index?: number }

/** An object outside the asset, as an import names it: its package, its own name and class. */
export type ObjectRef = { package: string; object: string; className: string; classPackage: string }

/** One parameter entry of a mod's material instance. */
export type ModParam = {
  list: ParamList
  id: ParamId
  entry: Json
  /** Texture parameters: the texture it points at (null: none), or 'unportable' (not an import: cannot be carried) */
  texture?: ObjectRef | null | 'unportable'
  /** The export dependency lists that held the texture's import in the mod (the game's export gets the same) */
  deps?: string[]
}

export type PortResult = 'changed' | 'unchanged' | 'missing' | 'unportable'

/** Name, association and layer index of a material ParameterInfo struct. */
export function readParamId(paramInfo: Json): ParamId | undefined {
  const fields: Json[] = Array.isArray(paramInfo?.Value) ? paramInfo.Value : []
  const name = fields.find(p => p?.Name === 'Name')?.Value
  if (typeof name !== 'string') return undefined
  const association = fields.find(p => p?.Name === 'Association')?.Value
  const index = fields.find(p => p?.Name === 'Index')?.Value
  return { name, association: typeof association === 'string' ? association : undefined, index: typeof index === 'number' ? index : undefined }
}

const entryParamId = (entry: Json) => (Array.isArray(entry?.Value) ? readParamId(entry.Value.find((p: Json) => p?.Name === 'ParameterInfo')) : undefined)

// Unversioned properties drop zero-valued fields, so a missing field means the default
const sameParamId = (a: ParamId, b: ParamId) =>
  a.name === b.name && (a.association ?? 'GlobalParameter') === (b.association ?? 'GlobalParameter') && (a.index ?? -1) === (b.index ?? -1)

const importAt = (json: Json, index: number): Json | undefined => (index < 0 ? json?.Imports?.[-index - 1] : undefined)

/** The material instance export: found by its class, since some assets list their user data before it. */
function mainExport(json: Json): Json | undefined {
  const exps = json?.Exports
  if (!Array.isArray(exps)) return undefined
  return exps.find(e => /^MaterialInstance/.test(importAt(json, e?.ClassIndex)?.ObjectName ?? '')) ?? exps[0]
}

function paramList(json: Json, list: ParamList): Json[] | null {
  const data = mainExport(json)?.Data
  if (!Array.isArray(data)) return null
  const values = data.find((p: Json) => p?.Name === list)?.Value
  return Array.isArray(values) ? values : null
}

/** True when the asset's main export holds material parameter lists (a material instance). */
export const isMaterialInstance = (json: Json) => PARAM_LISTS.some(l => paramList(json, l) !== null)

// ---- imports ----

/** The object an import index names, or undefined when it is not an object inside a package import. */
export function resolveImport(json: Json, index: number): ObjectRef | undefined {
  const obj = importAt(json, index)
  const pkg = obj && importAt(json, obj.OuterIndex)
  if (!obj || !pkg || pkg.ClassName !== 'Package' || pkg.OuterIndex !== 0) return undefined
  return { package: pkg.ObjectName, object: obj.ObjectName, className: obj.ClassName, classPackage: obj.ClassPackage }
}

/** The name map entry an FName string needs: UAssetAPI stores "T_Foo_2" as "T_Foo" plus a number (FName.FromStringFragments). */
export function nameBase(value: string) {
  const m = value.match(/^(.+)_(\d+)$/)
  return m && (m[2].length === 1 || m[2][0] !== '0') && m[1].length >= 1 ? m[1] : value
}

function addNames(json: Json, names: string[]) {
  if (!Array.isArray(json.NameMap)) json.NameMap = []
  const have = new Set<string>(json.NameMap)
  for (const n of names.map(nameBase)) if (!have.has(n)) { json.NameMap.push(n); have.add(n) }
}

const IMPORT_TYPE = 'UAssetAPI.Import, UAssetAPI'
const newImport = (objectName: string, outer: number, classPackage: string, className: string) =>
  ({ $type: IMPORT_TYPE, ObjectName: objectName, OuterIndex: outer, ClassPackage: classPackage, ClassName: className, PackageName: null, bImportOptional: false })

/** The import index of `ref` in this asset, adding its package and object imports (and their names) when missing. */
export function ensureImport(json: Json, ref: ObjectRef): number {
  if (!Array.isArray(json.Imports)) json.Imports = []
  const imports: Json[] = json.Imports
  const index = (i: number) => -i - 1
  let pkg = imports.findIndex(im => im?.ClassName === 'Package' && im?.OuterIndex === 0 && im?.ObjectName === ref.package)
  const found = pkg < 0 ? -1 : imports.findIndex(im => im?.OuterIndex === index(pkg) && im?.ObjectName === ref.object && im?.ClassName === ref.className)
  if (found >= 0) return index(found)
  addNames(json, [ref.package, ref.object, ref.className, ref.classPackage, 'Package', '/Script/CoreUObject'])
  if (pkg < 0) pkg = imports.push(newImport(ref.package, 0, '/Script/CoreUObject', 'Package')) - 1
  return index(imports.push(newImport(ref.object, index(pkg), ref.classPackage, ref.className)) - 1)
}

const DEP_LISTS = ['SerializationBeforeSerializationDependencies', 'CreateBeforeSerializationDependencies', 'SerializationBeforeCreateDependencies', 'CreateBeforeCreateDependencies']

// ---- material parameters ----

const valueField = (entry: Json) => (Array.isArray(entry?.Value) ? entry.Value.find((p: Json) => p?.Name === 'ParameterValue') : undefined)

/** Every parameter of the mod's material instance that the filter does not exclude. */
export function readModParams(json: Json, filter: ColorFilter): ModParam[] {
  const out: ModParam[] = []
  const exp = mainExport(json)
  for (const list of PARAM_LISTS) {
    for (const entry of paramList(json, list) ?? []) {
      const id = entryParamId(entry)
      if (!id || isExcluded(id.name, filter)) continue
      const p: ModParam = { list, id, entry }
      if (list === 'TextureParameterValues') {
        const v = valueField(entry)?.Value
        if (v === 0 || v === null || v === undefined) p.texture = null
        else {
          const ref = typeof v === 'number' ? resolveImport(json, v) : undefined
          p.texture = ref ?? 'unportable'
          if (ref) p.deps = DEP_LISTS.filter(d => Array.isArray(exp?.[d]) && exp[d].includes(v))
        }
      }
      out.push(p)
    }
  }
  return out
}

/** Replaces the game's entry for `p` with the mod's whole entry. Copying the entry, not just its value, keeps its
 *  unversioned struct header in step with which fields are zero: UAssetAPI writes that header verbatim, so flipping a
 *  value to or from zero in place would either be dropped or desync the stream. */
export function portParam(json: Json, p: ModParam): PortResult {
  const values = paramList(json, p.list)
  const i = values ? values.findIndex(e => { const id = entryParamId(e); return id !== undefined && sameParamId(id, p.id) }) : -1
  if (!values || i < 0) return 'missing'
  if (p.texture === 'unportable') return 'unportable'
  // The entry's own Name is its array slot, which is the game's, not the mod's
  const next = { ...structuredClone(p.entry), Name: values[i].Name }
  if (p.texture) {
    const field = valueField(next)
    const was = JSON.stringify(json.Imports ?? []), names = (json.NameMap ?? []).length
    const index = ensureImport(json, p.texture)
    field.Value = index
    if (JSON.stringify(values[i]) === JSON.stringify(next)) {
      // same texture already: nothing to add
      if (JSON.stringify(json.Imports) !== was) { json.Imports = JSON.parse(was); json.NameMap.length = names }
      return 'unchanged'
    }
    const exp = mainExport(json)
    for (const d of p.deps ?? []) if (Array.isArray(exp[d]) && !exp[d].includes(index)) exp[d].push(index)
  } else if (JSON.stringify(values[i]) === JSON.stringify(next)) return 'unchanged'
  values[i] = next
  return 'changed'
}

// ---- color properties (blueprints, data tables) ----

/** One step down the JSON: an object key, an array position, or (for arrays of named things) the nth element with that
 *  Name (or export ObjectName), which survives an update adding or reordering properties. */
export type Step = string | number | { name: string; nth: number }
export type Rgba = { R: number; G: number; B: number; A: number }
export type ColorProp = { label: string; path: Step[]; rgba: Rgba; name: string; structType: string }

const COLOR_NAMES = new Set(['ColorAndOpacity', 'SpecifiedColor', 'BaseColor', 'HighlightColor', 'FontTopColor', 'FontButtomColor', 'VectorParameter',
  'ShadowColor', 'ContentColor', 'OutlineColor', 'Color', 'TextColor', 'BackgroundColor', 'Emissive', 'ParameterValue'])

const nameOf = (el: Json): string | undefined => (typeof el?.Name === 'string' ? el.Name : typeof el?.ObjectName === 'string' ? el.ObjectName : undefined)

/** The step for array element i: by name when it has one. */
function stepFor(arr: Json[], i: number): Step {
  const name = nameOf(arr[i])
  if (name === undefined) return i
  let nth = 0
  for (let j = 0; j < i; j++) if (nameOf(arr[j]) === name) nth++
  return { name, nth }
}

export function walk(json: Json, path: Step[]): Json {
  let cur = json
  for (const s of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    if (typeof s === 'object') {
      if (!Array.isArray(cur)) return undefined
      let n = s.nth
      cur = cur.find(el => nameOf(el) === s.name && n-- === 0)
    } else cur = cur[s]
  }
  return cur
}

const num = (v: unknown) => parseFloat(v as string) || 0
const rgbaOf = (c: Json): Rgba => ({ R: num(c.R), G: num(c.G), B: num(c.B), A: num(c.A) })

/** The LinearColor value inside a color property: LinearColor holds it at Value[0].Value, SlateColor in SpecifiedColor. */
function colorValuePath(node: Json): Step[] | null {
  if (node.StructType === 'LinearColor') return node?.Value?.[0]?.Value && typeof node.Value[0].Value.R !== 'undefined' ? ['Value', 0, 'Value'] : null
  if (node.StructType === 'SlateColor' && Array.isArray(node.Value)) {
    const i = node.Value.findIndex((e: Json) => e?.Name === 'SpecifiedColor' && e?.StructType === 'LinearColor')
    return i >= 0 && typeof node.Value[i]?.Value?.[0]?.Value?.R !== 'undefined' ? ['Value', stepFor(node.Value, i), 'Value', 0, 'Value'] : null
  }
  return null
}

function findColors(node: Json, path: Step[], owner: string, filter: ColorFilter, out: ColorProp[]) {
  if (!node || typeof node !== 'object') return
  if (!Array.isArray(node) && COLOR_NAMES.has(node.Name) && (node.StructType === 'LinearColor' || node.StructType === 'SlateColor')) {
    const inner = colorValuePath(node)
    const label = `${owner} - ${node.Name}`
    if (inner && matchesFilter(label, filter)) out.push({ label, path: [...path, ...inner], rgba: rgbaOf(walk(node, inner)), name: node.Name, structType: node.StructType })
    if (inner) return
  }
  if (Array.isArray(node)) node.forEach((el, i) => { path.push(stepFor(node, i)); findColors(el, path, owner, filter, out); path.pop() })
  else for (const key of Object.keys(node)) { path.push(key); findColors(node[key], path, owner, filter, out); path.pop() }
}

/** The color properties of a blueprint or data table that the filter picks. Material instances have none here: their
 *  vectors travel as parameters (readModParams). */
export function readColors(json: Json, filter: ColorFilter): ColorProp[] {
  const out: ColorProp[] = []
  if (isMaterialInstance(json) || !Array.isArray(json?.Exports)) return out
  const first = json.Exports[0]
  if (first?.$type === 'UAssetAPI.ExportTypes.DataTableExport, UAssetAPI' && Array.isArray(first.Table?.Data)) {
    first.Table.Data.forEach((row: Json, i: number) => {
      if (row?.StructType === 'RichTextStyleRow') findColors(row.Value, ['Exports', stepFor(json.Exports, 0), 'Table', 'Data', stepFor(first.Table.Data, i), 'Value'], row.Name, filter, out)
    })
    return out
  }
  json.Exports.forEach((exp: Json, i: number) => {
    if (Array.isArray(exp?.Data)) findColors(exp.Data, ['Exports', stepFor(json.Exports, i), 'Data'], exp.ObjectName || `Export_${i}`, filter, out)
  })
  return out
}

export type ColorResult = 'changed' | 'unchanged' | 'missing'

/** Writes the mod's color into the game's JSON at the same property, when that property is there and differs. */
export function applyColor(json: Json, c: ColorProp): ColorResult {
  const path = c.path
  const target = walk(json, path)
  // the property itself, a few steps up, must still be the same kind of color
  const owner = walk(json, path.slice(0, path.length - (c.structType === 'SlateColor' ? 5 : 3)))
  if (!target || typeof target !== 'object' || typeof target.R === 'undefined' || owner?.Name !== c.name || owner?.StructType !== c.structType) return 'missing'
  const now = rgbaOf(target)
  if (now.R === c.rgba.R && now.G === c.rgba.G && now.B === c.rgba.B && now.A === c.rgba.A) return 'unchanged'
  Object.assign(target, c.rgba)
  return 'changed'
}

if (import.meta.env.DEV) {
  const imp = (ObjectName: string, OuterIndex: number, ClassName: string, ClassPackage = '/Script/Engine') => ({ ObjectName, OuterIndex, ClassName, ClassPackage })
  const tex = (name: string, value: number) => ({ Name: '0', Value: [{ Name: 'ParameterInfo', Value: [{ Name: 'Name', Value: name }] }, { Name: 'ParameterValue', Value: value }] })
  const asset = (imports: object[], value: number, names: string[]) => ({
    NameMap: names, Imports: imports,
    Exports: [{ ClassIndex: -1, CreateBeforeSerializationDependencies: [-3], Data: [{ Name: 'TextureParameterValues', Value: [tex('BaseColor', value)] }] }],
  })
  const game = asset([imp('MaterialInstanceConstant', -4, 'Class'), imp('/Game/T/T_Old', 0, 'Package', '/Script/CoreUObject'), imp('T_Old', -2, 'Texture2D'), imp('/Script/Engine', 0, 'Package')], -3, ['T_Old'])
  const mod = asset([imp('MaterialInstanceConstant', -4, 'Class'), imp('/Game/T/T_New_2', 0, 'Package', '/Script/CoreUObject'), imp('T_New_2', -2, 'Texture2D'), imp('/Script/Engine', 0, 'Package')], -3, ['T_New'])
  const [p] = readModParams(mod, { includes: [], excludes: [] })
  console.assert(typeof p.texture === 'object' && p.texture?.object === 'T_New_2' && p.deps?.[0] === 'CreateBeforeSerializationDependencies', 'a texture parameter names its texture')
  console.assert(portParam(game, p) === 'changed', 'a new texture is carried')
  const at = (game.Exports[0].Data[0].Value[0].Value[1] as { Value: number }).Value
  console.assert(resolveImport(game, at)?.object === 'T_New_2' && game.Imports.length === 6, 'its imports are added to the game asset')
  console.assert(game.NameMap.includes('T_New') && game.NameMap.includes('/Game/T/T_New') && !game.NameMap.includes('T_New_2'), 'names go in as UAssetAPI splits them')
  console.assert((game.Exports[0].CreateBeforeSerializationDependencies as number[]).includes(at), 'the export depends on the new texture like the mod did')
  console.assert(portParam(game, p) === 'unchanged' && game.Imports.length === 6, 'a second port adds nothing')
  console.assert(nameBase('T_X_02') === 'T_X_02' && nameBase('T_X_2') === 'T_X' && nameBase('T_X_0') === 'T_X', 'name numbers follow FName rules')
}
