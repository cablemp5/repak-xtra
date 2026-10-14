// Browser preview only: `npm run dev` opened in a normal browser has no Rust backend,
// so this answers invoke() calls from a snapshot of the real library.
// Refresh the snapshot with `node scripts/capture-dev-fixture.mjs`. Never active inside the app.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { normalizeModBaseName } from '../utils/format'

// DEV guard keeps the snapshot out of release bundles
const fixtures = import.meta.env.DEV ? import.meta.glob('./fixture.local.json', { eager: true, import: 'default' }) : {}
const data: any = Object.values(fixtures)[0] ?? {
  gamePath: '', settings: {}, tags: [], characterData: [], mods: [], folders: [], details: {},
}

let sigeonState = 'off'
// Fake Sigeon configs as the editor sees them (caleb_sigeon.rs Line); the license is only ever a placeholder line
const sigeonLine = (key: string, value: string, on = true) => ({ kind: 'entry', key, value, on })
const sigeonPresets: Record<string, any[]> = Object.fromEntries(['base', 'high'].map(v => [v, [
  { kind: 'comment', text: ' SigeonLoader configuration.' }, { kind: 'blank' }, { kind: 'license', set: true }, { kind: 'blank' },
  sigeonLine('variant', v), sigeonLine('lowLatency', '0'), sigeonLine('stretched', '1.0'), sigeonLine('darkHair', '0'),
  sigeonLine('fontAA', '1'), sigeonLine('fixDarkMaps', '1'), sigeonLine('gamma', '0', false), { kind: 'blank' },
  { kind: 'section', name: 'Overrides' }, { kind: 'comment', text: ' ---- Invisible: streaming, threading ----' },
  sigeonLine('r.Streaming.PoolSize', '3072'), sigeonLine('r.OneFrameThreadLag', '1'), { kind: 'comment', text: ' Small shadow extras' },
  sigeonLine('r.ContactShadows', '0'), sigeonLine('r.DetailMode', '1'), { kind: 'blank' },
]]))
const sigeonDeleted: Record<string, any[]> = {}
let mockBypass = 'installed'
let mockGalacta: any = { installed: 'C:/Game/~mods', disabled: false, up_to_date: false }
const galactaRelease = { latest: 'v1.4.1', published: '2026-10-14T14:29:44Z', url: 'https://github.com/0xSaturno/ProjectGalacta/releases/tag/v1.4.1',
  notes: "## What's new:\n\n### Mod Loader:\n- Mods that add custom VFX to abilities are no longer blocked." }
const setupBypass = () => ({ state: mockBypass, sigeon_on: true, license: 'MIT License\n\nCopyright (c) 2023 ThirteenAG',
  files: [{ name: 'dsound.dll', place: 'Binaries\\Win64', size: 415232, sha256: 'bb8767f918c52a2ad055d2de9baffd2478598643b9894f09abd20d1f1ffd170c', found: mockBypass === 'installed' ? 'same' : 'missing' },
    { name: 'MarvelRivalsUTOCSignatureBypass.asi', place: 'Binaries\\Win64\\plugins', size: 44032, sha256: '2f8b183149f30c94319a5f6636491ff39aa22afbbf3f5cbc5fb8f7ecc287a62d', found: mockBypass === 'missing' ? 'missing' : 'same' }] })
const trash = new Map<string, any>() // trash id -> the deleted mod record
// Browser checks flip window.__mockGameRunning live (polled every 5 s); localStorage 'mock.bypass' = 'false' turns the
// fixture's game-lock bypass off at the next load
const mock = window as any
mock.__mockData = data // browser checks add or change mods here, then refresh (Ctrl+Shift+R)
mock.__emit = emit // browser checks fire backend events (mod-preview-ready, ...)
mock.__calls = {} as Record<string, number> // invoke count per command
// window.__previewDelay (ms) holds get_mod_preview and get_preview_covers answers back, for cache race checks
const later = <T,>(v: T | Promise<T>) => (mock.__previewDelay ? new Promise<T>(r => setTimeout(() => r(v), mock.__previewDelay)) : v)
// Lazy loaders, not eager imports: the app's production build drops this dev-only branch with them (eager ones copied
// every local preview PNG into the app's assets)
const previewUrls: Record<string, () => Promise<string>> = import.meta.env.DEV
  ? import.meta.glob<string>('./previews.local/*.png', { query: '?url', import: 'default' })
  : {}
const previewCovers: Record<string, () => Promise<{ covers?: string[]; members?: string[] }>> = import.meta.env.DEV
  ? import.meta.glob<{ covers?: string[]; members?: string[] }>('./previews.local/*.json', { import: 'default' })
  : {}
// Loadout renders made in this page: what get_preview_covers reports for them (the local copies have no members)
const setCovers = new Map<string, { covers: string[]; members: string[] | null }>()
// window.__previewMock picks how generate_mod_previews answers: 'ok' (default), 'busy' (another generator holds the
// lock), 'fail-set' (the loadout render fails), 'throw' (the start throws), 'refuse' (a run is going); an array is used
// one entry per call. window.__previewStep sets the ms between events (600).
const previewMode = (): string => (Array.isArray(mock.__previewMock) ? mock.__previewMock.shift() : mock.__previewMock) ?? 'ok'

if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
  mockWindows('main')
  mockIPC((cmd, args: any) => {
    mock.__calls[cmd] = (mock.__calls[cmd] ?? 0) + 1
    switch (cmd) {
      case 'get_pak_files': return data.mods.map((m: any) => ({ ...m })) // fresh objects, like the real backend
      case 'get_folders': return data.folders
      case 'get_app_settings':
        return localStorage.getItem('mock.bypass') === 'false' ? { ...data.settings, bypassGameRunningLock: false } : data.settings
      case 'get_game_path': return data.gamePath
      case 'get_all_tags': return data.tags
      case 'get_character_data': return data.characterData
      case 'get_mod_details': return data.details[args?.modPath] ?? null
      case 'plugin:webview|set_webview_zoom': // the browser has no webview zoom; CSS zoom stands in
        document.documentElement.style.zoom = String(args?.value ?? 1)
        return null
      case 'sigeon_status':
        return { state: sigeonState, presets: Object.keys(sigeonPresets).sort(), storage: 'Desktop/Sigeon V2', plugins: '', game_running: false, problem: null }
      case 'sigeon_read': return structuredClone(sigeonPresets[args?.preset])
      case 'sigeon_save':
        sigeonPresets[args?.preset] = args?.lines
        return { state: sigeonState, applied: sigeonState === args?.preset }
      case 'sigeon_create':
        sigeonPresets[args?.name] = args?.from ? structuredClone(sigeonPresets[args?.from]) : [
          { kind: 'license', set: false }, { kind: 'blank' }, sigeonLine('variant', 'base'), sigeonLine('lowLatency', '0'), sigeonLine('stretched', '1.0'),
          sigeonLine('darkHair', '0'), sigeonLine('fontAA', '0'), sigeonLine('fixDarkMaps', '0'), sigeonLine('gamma', '0', false),
          sigeonLine('enableCAS', '1', false), { kind: 'blank' }, { kind: 'section', name: 'Overrides' }]
        return null
      case 'sigeon_storage': return { path: 'C:\\Users\\you\\Desktop\\Sigeon V2', default: true, loader: true }
      case 'sigeon_set_storage': return { path: args?.path ?? 'C:\\Users\\you\\Desktop\\Sigeon V2', default: !args?.path, loader: !args?.path }
      case 'sigeon_open': return null
      case 'sigeon_rename':
        sigeonPresets[args?.to] = sigeonPresets[args?.from]; delete sigeonPresets[args?.from]
        if (sigeonState === args?.from) sigeonState = args?.to
        return null
      case 'sigeon_delete':
        if (sigeonState === args?.name) throw new Error(`${args?.name} is the config in use.`)
        sigeonDeleted[args?.name] = sigeonPresets[args?.name]; delete sigeonPresets[args?.name]; return null
      // Setup panel: fake bypass files and a fake Galacta release (no game folder, no network)
      case 'setup_bypass_status': return setupBypass()
      case 'setup_bypass':
        mockBypass = ({ install: 'installed', enable: 'installed', disable: 'disabled', remove: 'missing' } as any)[args?.action] ?? mockBypass
        return setupBypass()
      case 'setup_galacta_status': return { ...mockGalacta, ...(args?.online ? galactaRelease : {}) }
      case 'setup_galacta_install':
        mockGalacta = { installed: 'C:/Game/~mods', disabled: false, up_to_date: true }
        return { ...mockGalacta, ...galactaRelease }
      case 'sigeon_restore': sigeonPresets[args?.name] = sigeonDeleted[args?.name]; return null
      case 'sigeon_set':
        sigeonState = args?.preset ?? 'off'
        return sigeonState
      case 'get_hero_image_ids': return data.heroIds ?? []
      case 'list_mod_previews': // copies of %APPDATA%\Repak-X\previews in src/dev/previews.local
        return Object.keys(previewUrls).map(f => f.replace(/^.*\/|\.png$/g, ''))
      case 'get_mod_preview': { // a loadout render made in this page shows a local copy's image
        const load = previewUrls[`./previews.local/${args?.key}.png`] ?? (setCovers.has(args?.key) ? Object.values(previewUrls)[0] : undefined)
        if (!load) throw `No preview for ${args?.key}`
        return later(load().then(url => fetch(url)).then(r => r.arrayBuffer()))
      }
      case 'generate_mod_previews': { // pretend run: each job reports back as already rendered
        const mode = previewMode()
        if (mode === 'throw') throw 'Preview generator not found at C:/Fake/tools/previews/mod_previews.py'
        if (mode === 'refuse') return false
        const keys: string[] = (args?.jobs ?? []).map(([, key]: [string, string]) => key)
        const set: string | null = args?.set ?? null
        let t = 0
        const at = (f: () => void) => setTimeout(f, (t += mock.__previewStep ?? 600))
        if (mode === 'busy') {
          at(() => emit('mod-previews-busy'))
          at(() => emit('mod-previews-done', false))
          return true
        }
        let alone = keys
        if (set && mode === 'fail-set') at(() => emit('mod-preview-failed', set))
        else if (set) { // the first mod renders in the loadout's image, the rest alone
          alone = keys.slice(1)
          at(() => {
            setCovers.set(set, { covers: keys.slice(0, 1), members: [...keys].sort() })
            emit('mod-preview-ready', set)
            emit('mod-preview-in', keys[0])
          })
        }
        alone.forEach(k => at(() => emit('mod-preview-ready', k)))
        at(() => emit('mod-previews-done', true))
        return true
      }
      case 'cancel_mod_previews': return null
      case 'get_preview_covers':
        return later(setCovers.get(args?.key) ?? previewCovers[`./previews.local/${args?.key}.json`]?.()
          .then(c => ({ covers: c?.covers ?? [], members: c?.members ?? null })) ?? { covers: [], members: null })
      case 'get_hero_image':
        return fetch(`/src/dev/heroes.local/${args?.id}.png`).then(r => r.arrayBuffer()).then(b => new Uint8Array(b))
      case 'get_app_version': return __APP_VERSION__
      case 'get_last_seen_version': return __APP_VERSION__
      case 'get_sig_bypasser_status': return 'installed'
      case 'check_game_running': return Boolean(mock.__mockGameRunning)
      case 'delete_mod': {
        if (trash.has(args?.trashId)) throw `Trash id ${args?.trashId} is already used`
        const i = data.mods.findIndex((m: any) => m.path === args?.path)
        if (i >= 0) trash.set(args?.trashId, data.mods.splice(i, 1)[0])
        return null
      }
      case 'restore_trashed_mods': {
        let restored = 0
        const failed: string[] = []
        for (const id of args?.ids ?? []) {
          const mod = trash.get(id)
          if (!mod) failed.push(`trash ${id}: not found`)
          else if (data.mods.some((m: any) => m.path === mod.path)) failed.push(`${mod.path} already exists, left the trashed copy alone`)
          else { data.mods.push(mod); trash.delete(id); restored++ }
        }
        if (failed.length) throw `Restored ${restored} file(s); failed: ${failed.join('; ')}`
        return restored
      }
      case 'get_skip_launcher_status':
      case 'check_for_previous_crash': return false
      case 'check_mod_clashes': return []
      // Installing: the file picker returns two fake paks, install adds them to the library and reports done
      case 'plugin:dialog|open': return ['C:/Fake/Drop/Alpha_Skin_9999999_P.pak', 'C:/Fake/Drop/Beta_Icons_9999999_P.pak']
      case 'parse_dropped_files':
        return (args?.paths ?? []).map((path: string) => ({ path, mod_name: path.split('/').pop(), mod_type: 'Black Panther - Texture',
          is_dir: false, contains_uassets: true, contains_raw_assets: false, auto_to_repak: false, file_size: 1048576 }))
      case 'install_mods':
        for (const m of args?.mods ?? []) {
          const path = `${data.gamePath}\\${normalizeModBaseName(m.customName || m.mod_name)}.pak`
          if (!data.mods.some((x: any) => x.path === path)) data.mods.push({ ...data.mods[0], path, enabled: true, modified_date: Date.now() / 1000 })
        }
        setTimeout(() => emit('install_complete', null), 300)
        return null
      case 'rename_mod': { // same folder, priority suffix and extension, new name
        const mod = data.mods.find((m: any) => m.path === args?.modPath)
        if (!mod) throw 'Mod not found'
        const [, dir, , tail] = mod.path.match(/^(.*[\\/])(.*?)((_\d+_P)?(\.pak)?(\.bak_repak|\.pak_disabled)?)$/)
        mod.path = `${dir}${args.newName}${tail}`
        return mod.path
      }
      case 'toggle_mod': {
        if (mock.__toggleFail && String(args?.modPath).includes(mock.__toggleFail)) throw 'The file is in use' // window.__toggleFail = part of a path
        const mod = data.mods.find((m: any) => m.path === args?.modPath)
        if (mod) mod.enabled = !mod.enabled
        return mod?.enabled ?? null
      }
      default:
        console.debug('[mockBackend] unhandled', cmd, args)
        return null
    }
  }, { shouldMockEvents: true })
}
