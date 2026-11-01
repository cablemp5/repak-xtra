// Browser preview only (mockBackend.ts): `?data=worst|one|empty|1000` swaps the snapshot library for worst-case data,
// so layout breaks show up before a real library finds them. A small bar at the bottom flips between them.
const DIR = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\MarvelRivals\\MarvelGame\\Marvel\\Content\\Paks\\~mods\\'

export const dataMode = new URLSearchParams(location.search).get('data') ?? 'demo'

const mod = (file: string, extra: any = {}) => ({
  path: DIR + file, utoc_path: null, enabled: true, custom_name: null, folder_id: '~mods', custom_tags: [],
  file_size: 18_874_368, modified_date: 1792655573, priority: 0, character_name: null, skin_name: null, ...extra,
})
const details = (name: string, extra: any = {}) => ({
  mod_name: name, mod_type: 'Hulk - Mesh', character_name: 'Hulk', category: 'Mesh', character_id: '1011',
  file_count: 12, total_size: 18_874_368, files: [], is_iostore: true, is_encrypted: false, has_blueprint: false, is_hybrid: false, ...extra,
})
const longFiles = Array.from({ length: 40 }, (_, i) =>
  `Marvel/Content/Marvel/Characters/1048/1048001/Meshes/SK_1048_1048001_Body_Lod${i % 4}_Optimized_GalacticClaw_Final_${i}.uasset`)

/** Real naming patterns seen in mod folders, spread so each of the first rows breaks something different. */
const WORST: [any, any | null][] = [
  [mod('Z_Psylocke_Vengeance_GalacticClaw_FullBodyRecolor_BlackGold_CustomVFX_NoOutline_v12_9999999_P.pak', {
    custom_tags: ['psylocke', 'recolor', 'vfx', 'galacta', 'favorites', 'season-5', 'testing', 'black-gold', 'claw', 'ranked-safe', 'nexus', 'keep'],
  }), details('Z_Psylocke_Vengeance_GalacticClaw_FullBodyRecolor_BlackGold_CustomVFX_NoOutline_v12_9999999_P', {
    mod_type: 'Psylocke - Skin [Project Galacta]', character_name: 'Psylocke', category: 'Skin', character_id: '1048',
    file_count: 4812, total_size: 4_617_089_843, files: longFiles, is_encrypted: true, has_blueprint: true,
  })],
  [mod('PeniParker_Mech_9999999_P.pak', { custom_name: "Peni Parker's SP//dr Mech, Neon Pink Anime Edition (Season 5 fix, final final)" }),
    details('PeniParker_Mech_9999999_P', { mod_type: 'Multiple Heroes (4)', character_name: 'Multiple Heroes', category: 'Mesh', character_id: '' })],
  [mod('a_9999999_P.pak', { file_size: 0, enabled: false }), null],
  [mod('ルナ・スノー_アニバーサリー衣装_改_9999999_P.pak', { custom_tags: ['needs-retesting-after-season-5-patch-and-galacta-update'] }),
    details('ルナ・スノー_アニバーサリー衣装_改_9999999_P', { mod_type: 'Luna Snow - Texture', character_name: 'Luna Snow', category: 'Texture', character_id: '1031' })],
  [mod('Hela_Flame_9999999_P.pak', { custom_name: '🔥 Hela, Flame Queen 👩🏽‍💻' }), details('Hela_Flame_9999999_P', { mod_type: 'Hela - VFX', character_name: 'Hela', category: 'VFX', character_id: '1024' })],
  [mod('ThorLoki_9999999_P.pak', { custom_name: '<b>Thor</b> &amp; Loki **brothers**' }), details('ThorLoki_9999999_P', { mod_type: 'Thor - Audio', character_name: 'Thor', category: 'Audio', character_id: '1039' })],
  [mod('Hulk_GammaGlow_9999999_P_9999999_P_9999999_P.pak', { priority: 7, file_size: 4_617_089_843, modified_date: 0 }), details('Hulk_GammaGlow_9999999_P_9999999_P_9999999_P')],
  [mod('Ultron_Skin_9999999_P.pak', { custom_name: 'Đặng Thị Ngọc Hân, Ultron Chrome' }), details('Ultron_Skin_9999999_P', { mod_type: 'Ultron - Texture', character_name: 'Ultron', category: 'Texture', character_id: '1058' })],
  [mod('BlackPanther_Recolor_A_9999999_P.pak', { custom_name: 'Black Panther Recolor' }), details('BlackPanther_Recolor_A_9999999_P', { mod_type: 'Black Panther - Texture', character_name: 'Black Panther', category: 'Texture', character_id: '1026' })],
  [mod('BlackPanther_Recolor_B_9999999_P.pak', { custom_name: 'Black Panther Recolor' }), details('BlackPanther_Recolor_B_9999999_P', { mod_type: 'Black Panther - Texture', character_name: 'Black Panther', category: 'Texture', character_id: '1026' })],
  [mod('CloakAndDagger_9999999_P.pak', { custom_tags: ['x'] }), details('CloakAndDagger_9999999_P', { mod_type: 'Cloak & Dagger - Mesh', character_name: 'Cloak & Dagger', category: 'Mesh', character_id: '1025' })],
]

/** Swap the library in `data` for the chosen mode. 'demo' and '1000' keep the snapshot (1000 is mockBackend's mock.mods). */
export function applyDataMode(data: any) {
  if (dataMode === 'empty') data.mods = []
  else if (dataMode === 'one') data.mods = data.mods.slice(0, 1)
  else if (dataMode === 'worst') {
    data.mods = WORST.map(([m]) => m)
    for (const [m, d] of WORST) if (d) data.details[m.path] = d
    data.tags = [...new Set([...data.tags, ...WORST.flatMap(([m]) => m.custom_tags)])].sort()
  }
  if (data.folders?.[0]) data.folders[0].mod_count = dataMode === '1000' ? 1000 : data.mods.length
}

/** Plain bar, bottom center: not part of the design under test. */
export function mountDataToggle() {
  const bar = document.createElement('div')
  bar.style.cssText = 'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:2px;'
    + 'padding:3px;border-radius:8px;background:#3a3a3a;font:12px system-ui,sans-serif'
  for (const [mode, label] of [['demo', 'Demo data'], ['worst', 'Worst case'], ['empty', 'Empty'], ['one', 'One'], ['1000', '1,000 rows']]) {
    const b = document.createElement('button')
    b.textContent = label
    const on = mode === dataMode
    b.style.cssText = `border:0;border-radius:6px;padding:4px 10px;cursor:pointer;background:${on ? '#fff' : 'transparent'};color:${on ? '#111' : '#ddd'}`
    b.onclick = () => { const u = new URL(location.href); mode === 'demo' ? u.searchParams.delete('data') : u.searchParams.set('data', mode); location.href = u.href }
    bar.append(b)
  }
  const add = () => document.body.append(bar)
  document.body ? add() : addEventListener('DOMContentLoaded', add)
}
