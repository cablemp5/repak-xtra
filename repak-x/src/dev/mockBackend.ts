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

// localStorage 'mock.fresh' = '1': a fresh PC (the README guide's demos). No game folder until Find it, no bypass or
// Galacta, an empty library; installing a file named like a snapshot mod brings that mod back. 'mock.noPreviews' = '1'
// takes the preview kit away too.
const fresh = localStorage.getItem('mock.fresh') === '1'
const held: any[] = fresh ? data.mods.splice(0) : []
// localStorage 'mock.mods' = N: a library of N mods, the snapshot's repeated under numbered names (Library speed checks)
const many = Number(localStorage.getItem('mock.mods') || 0)
if (many > 0 && data.mods.length) {
  const base = data.mods.slice()
  data.mods = Array.from({ length: many }, (_, i) => {
    const m = base[i % base.length]
    if (i < base.length) return m
    const path = m.path.replace(/((_\d+_P)?\.(pak|bak_repak|pak_disabled))$/i, ` ${i}$1`)
    data.details[path] ??= data.details[m.path]
    return { ...m, path, custom_name: m.custom_name ? `${m.custom_name} ${i}` : m.custom_name }
  })
}
const freshGame = data.gamePath
if (fresh) data.gamePath = ''
// localStorage 'mock.slow' = ms: installs take about that long and report progress like the real ones (README demos)
const slow = () => Number(localStorage.getItem('mock.slow') || 0)
const wait = (k: number) => new Promise(r => setTimeout(r, slow() * k))
const baseName = (p: string) => (p.split(/[\\/]/).pop() || p).replace(/(_\d+_P)?\.(pak|bak_repak|pak_disabled)$/i, '').toLowerCase()

let sigeonState = 'off'
// ?sigeon=unset in the page URL: no Sigeon yet (header > Sigeon not configured opens the setup); a folder whose name
// has "Sigeon" in it has the loader
const sigeonUnset = location.search.includes('sigeon=unset')
const sigeonHome = { path: 'C:\\Users\\you\\Desktop\\Sigeon V2', default: true, loader: !sigeonUnset }
let sigeonDir = sigeonHome
// Fake Sigeon configs as the editor sees them (xtra_sigeon.rs Line); the license is only ever a placeholder line
const sigeonLine = (key: string, value: string, on = true) => ({ kind: 'entry', key, value, on })
const sigeonPresets: Record<string, any[]> = sigeonUnset ? {} : Object.fromEntries(['base', 'high'].map(v => [v, [
  { kind: 'comment', text: ' SigeonLoader configuration.' }, { kind: 'blank' }, { kind: 'license', set: true }, { kind: 'blank' },
  sigeonLine('variant', v), sigeonLine('lowLatency', '0'), sigeonLine('stretched', '1.0'), sigeonLine('darkHair', '0'),
  sigeonLine('fontAA', '1'), sigeonLine('fixDarkMaps', '1'), sigeonLine('gamma', '0', false), { kind: 'blank' },
  { kind: 'section', name: 'Overrides' }, { kind: 'comment', text: ' ---- Invisible: streaming, threading ----' },
  sigeonLine('r.Streaming.PoolSize', '3072'), sigeonLine('r.OneFrameThreadLag', '1'), { kind: 'comment', text: ' Small shadow extras' },
  sigeonLine('r.ContactShadows', '0'), sigeonLine('r.DetailMode', '1'), { kind: 'blank' },
]]))
const sigeonDeleted: Record<string, any[]> = {}
let mockBypass = sigeonUnset || fresh ? 'missing' : 'installed'   // a fresh PC has neither
let mockGalacta: any = { installed: fresh ? null : 'C:/Game/~mods', disabled: false, up_to_date: false }
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
  ? import.meta.glob<string>('./previews.local/*.{png,webp}', { query: '?url', import: 'default' })
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

// repakxtra: the built-in mods' saved state (xtra_builtins.rs BuiltinView); heroes are the skin table's 10xx rows
const builtins: any[] = ['force-default-skin', 'skip-intro-movies', 'custom-quake'].map(id => ({ id, on: false, excluded: [], current: false, active: false, heroes: [] as string[], path: `C:/Mock/Paks/~mods/.repakxtra-builtin/repakxtra-${id}_9999999_P.pak`, size: 150000,
  ...(id === 'custom-quake' ? { quake: { base: '5d7a80', sky: '82c6ed', hidePlants: false, lobby: true } } : {}) }))
// CustomQuake (xtra_quake.rs): localStorage 'mock.quakeError' = '1' fails its build, 'mock.quakeOverlap' = '1' says quakeV6 is on too

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
      case 'delete_tag_from_all_mods':
        data.tags = data.tags.filter((t: string) => t !== args?.tag)
        data.mods.forEach((m: any) => { m.custom_tags = (m.custom_tags ?? []).filter((t: string) => t !== args?.tag) })
        return null
      case 'add_tag_to_catalog': if (!data.tags.includes(args?.tag)) data.tags = [...data.tags, args?.tag].sort(); return null
      case 'add_custom_tag': {
        const mod = data.mods.find((m: any) => m.path === args?.modPath)
        if (mod && !(mod.custom_tags ?? []).includes(args?.tag)) mod.custom_tags = [...(mod.custom_tags ?? []), args?.tag]
        return null
      }
      case 'get_character_data': return data.characterData
      // repakxtra: built-in mods (xtra_builtins.rs): a build takes a few seconds, like the real one's 10 to 25
      case 'xtra_builtins_list': return structuredClone(builtins)
      case 'xtra_builtins_refresh': return structuredClone(builtins)
      case 'xtra_builtins_set': {
        const b = builtins.find(x => x.id === args?.id)!
        if (args?.excluded) b.excluded = args.excluded
        if (args?.quake) b.quake = args.quake
        if (args?.on !== undefined) b.on = args.on
        if (!b.on) { b.current = b.active = false; b.overlaps = undefined; return structuredClone(builtins) }
        return new Promise(r => setTimeout(r, 2500)).then(() => {
          if (b.id === 'custom-quake' && localStorage.getItem('mock.quakeError') === '1') {
            Object.assign(b, { current: false, error: localStorage.getItem('mock.quakeErrorKind') === 'write' ? 'Could not write the packages: a file is in use' : 'Not active yet. The game updated and its new mappings are not out. repakxtra checks again at every start' })
            throw b.error
          }
          Object.assign(b, { current: true, active: true, builtAt: Math.floor(Date.now() / 1000), error: undefined,
            ...(b.id === 'custom-quake' && localStorage.getItem('mock.quakeOverlap') === '1' ? { overlaps: ['quakeV6_9999999_P'] } : {}),
            summary: b.id === 'skip-intro-movies' ? '12 startup logo videos turned off' : b.id === 'custom-quake' ? '31,191 textures set in 9 minutes' : `${53 - b.excluded.length} heroes, ${697 - b.excluded.length * 13} skins set to default` })
          return structuredClone(builtins)
        })
      }
      case 'get_mod_details': return data.details[args?.modPath] ?? null
      case 'plugin:webview|set_webview_zoom': // the browser has no webview zoom; CSS zoom stands in
        document.documentElement.style.zoom = String(args?.value ?? 1)
        return null
      case 'sigeon_status':
        return { state: sigeonState, configured: sigeonDir.loader, presets: Object.keys(sigeonPresets).sort(), storage: sigeonDir.path, plugins: '',
          game_running: false, problem: sigeonDir.loader ? null : `${sigeonDir.path}\\SigeonLoader.asi not found` }
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
      case 'sigeon_storage': return { ...sigeonDir }
      case 'sigeon_set_storage':
        sigeonDir = args?.path ? { path: args.path, default: false, loader: /sigeon/i.test(args.path) } : sigeonHome
        return { ...sigeonDir }
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
      case 'setup_bypass': return wait(0.6).then(() => {
        mockBypass = ({ install: 'installed', enable: 'installed', disable: 'disabled', remove: 'missing' } as any)[args?.action] ?? mockBypass
        return setupBypass()
      })
      case 'setup_galacta_status': return args?.online ? { ...mockGalacta, ...galactaRelease } : { ...mockGalacta, up_to_date: null } // offline: no release info, like the backend
      case 'setup_galacta_install': return wait(1.4).then(() => {
        mockGalacta = { installed: 'C:/Game/~mods', disabled: false, up_to_date: true }
        return { ...mockGalacta, ...galactaRelease }
      })
      case 'sigeon_restore': sigeonPresets[args?.name] = sigeonDeleted[args?.name]; return null
      case 'sigeon_set':
        sigeonState = args?.preset ?? 'off'
        return sigeonState
      case 'get_hero_image_ids': return data.heroIds ?? []
      case 'list_mod_previews': // copies of %APPDATA%\Repak-X\previews in src/dev/previews.local
        return Object.keys(previewUrls).map(f => f.replace(/^.*\/|\.(png|webp)$/g, ''))
      case 'get_mod_preview': { // a loadout render made in this page shows a local copy's image ('mock.setImage' = its name)
        const made = previewUrls[`./previews.local/${localStorage.getItem('mock.setImage')}.png`] ?? Object.values(previewUrls)[0]
        const load = previewUrls[`./previews.local/${args?.key}.png`] ?? previewUrls[`./previews.local/${args?.key}.webp`] ?? (setCovers.has(args?.key) ? made : undefined)
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
      // A kit is installed (v4, loaded from a file) unless 'mock.noPreviews' = '1'; 'mock.kit' / 'mock.kitSource' override
      // it, 'mock.kitLatest' is the newest on GitHub ('none': nothing published)
      case 'previews_available': return localStorage.getItem('mock.noPreviews') !== '1'
      case 'preview_kit_status': {
        const version = localStorage.getItem('mock.kit') ?? (localStorage.getItem('mock.noPreviews') === '1' ? null : '4')
        return { version, source: version ? localStorage.getItem('mock.kitSource') || 'file' : null, blender: fresh && !version ? null : 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe' }
      }
      case 'preview_kit_latest': return localStorage.getItem('mock.kitLatest') === 'none' ? null
        : { version: localStorage.getItem('mock.kitLatest') || '4', published: '2026-10-15T12:00:00Z', notes: '## Kit v4\n- Previews for each hero form', url: 'https://github.com/cablemp5/repak-xtra/releases', asset: '', size: 113000000 }
      case 'preview_kit_install': return (async () => {
        const v = localStorage.getItem('mock.kitLatest') || '4', total = 116957394
        for (let i = 1; slow() && i <= 20; i++) { emit('preview-kit-progress', { stage: 'download', done: (total * i) / 20, total }); await wait(0.1) }
        if (slow()) { emit('preview-kit-progress', { stage: 'unpack', done: 0, total: 0 }); await wait(0.8) }
        localStorage.setItem('mock.kit', v); localStorage.setItem('mock.kitSource', args?.file ? 'file' : 'github'); localStorage.removeItem('mock.noPreviews')
        return v
      })()
      case 'preview_kit_remove': localStorage.setItem('mock.noPreviews', '1'); localStorage.removeItem('mock.kit'); return null
      case 'preview_kit_set_blender': return args?.path ?? null
      // Desktop shortcut: localStorage 'mock.shortcut' = '1' once made (a fresh PC has none)
      case 'shortcut_status': return { exists: localStorage.getItem('mock.shortcut') === '1' }
      case 'shortcut_create': localStorage.setItem('mock.shortcut', '1'); return null
      case 'plugin:window|is_maximized': return false   // polled every second: answered, so the console stays readable
      case 'get_ui_log_backlog': return []
      case 'preview_kit_install_blender': return (async () => {
        for (const text of ['Found Blender [BlenderFoundation.Blender] Version 5.2.0', 'Downloading https://download.blender.org/release/Blender5.2/blender-5.2.0-windows-x64.msi', 'Successfully installed'])
          if (slow()) { emit('preview-kit-progress', { stage: 'blender', done: 0, total: 0, text }); await wait(0.7) }
        return 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe'
      })()
      case 'set_game_path': if (fresh) data.gamePath = String(args?.path ?? ''); return String(args?.path ?? '')
      // localStorage 'mock.noGame' = '1': the search finds nothing (an Epic install or a moved folder), like the backend's error
      case 'auto_detect_game_path':
        if (localStorage.getItem('mock.noGame') === '1') throw 'Could not auto-detect Marvel Rivals installation'
        if (fresh) data.gamePath = freshGame; return freshGame
      case 'previews_doctor': return localStorage.getItem('mock.doctor') === 'fail'
        ? { ok: false, problems: ["The game's Paks folder was not found (REPAKXTRA_PAKS is not set)."] } : { ok: true, problems: [] }
      // Capture: the game counts as open while window.__mockGameRunning is set; captures fail (no game to picture)
      case 'capture_game_status': return { running: Boolean(mock.__mockGameRunning), width: 2560, height: 1440 }
      case 'capture_game_now':
      case 'capture_game_hotkey': throw 'The browser preview has no game window to capture.'
      case 'capture_game_cancel': return null
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
      // Recently deleted: what delete_mod put in the trash, newest first
      case 'list_trashed_mods': return [...trash.entries()].reverse().map(([id, m]) => ({ id, paths: [m.path], size: m.file_size ?? 1048576,
        deleted: Math.floor(Date.now() / 1000) - 120, expires: Math.floor(Date.now() / 1000) + 7 * 86400 - 120 }))
      case 'empty_trashed_mods': { let n = 0; for (const id of args?.ids ?? []) if (trash.delete(id)) n++; return n }
      case 'restore_trashed_mods': {
        let restored = 0
        const failed: string[] = []
        for (const id of args?.ids ?? []) {
          const mod = trash.get(id)
          if (!mod) failed.push(`trash ${id}: not found`)
          else if (data.mods.some((m: any) => m.path === mod.path)) failed.push(`${mod.path} already exists, left the trashed copy alone`)
          else { data.mods.push(mod); trash.delete(id); restored++ }
        }
        if (restored) setTimeout(() => emit('mods_dir_changed', null), 200) // the real app's folder watcher sees them come back
        if (failed.length) throw `Restored ${restored} file(s); failed: ${failed.join('; ')}`
        return restored
      }
      // localStorage 'mock.crash' = '1': the newest crash the setup report names
      case 'xtra_newest_crash': return localStorage.getItem('mock.crash') === '1'
        ? { time: Math.floor(Date.now() / 1000) - 3600, crash_type: 'Access Violation', asset_path: '/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001', seconds_since_start: 412,
            message: 'Fatal error: [File:D:/build/Engine/Source/Runtime/CoreUObject/ObjectSerializationError.cpp] ObjectSerializationError', detail: 'Serial size mismatch: Got 4096, Expected 4112',
            build_version: '3962284', engine_version: '5.3.2-3962284+++depot_marvel+S10.5_release', cpu: 'AMD Ryzen 5 5600X 6-Core Processor', gpu: 'AMD Radeon RX 6700 XT',
            gpu_driver: 'AMD Software: Adrenalin Edition 26.10.1', rhi: 'D3D12', os: 'Windows 10 (22H2) [10.0.19045.6466]', ram_gb: 16, oom: false, thread: 'FAsyncLoadingThread',
            faulting_module: 'Marvel-Win64-Shipping', faulting_class: 'game', third_party: ['dsound.dll', 'MarvelRivalsUTOCSignatureBypass.asi'],
            stack: ['Marvel-Win64-Shipping + 10c296b (game)', 'Marvel-Win64-Shipping + 10c38e4 (game)', 'Marvel-Win64-Shipping + 10c41e7 (game)', 'Marvel-Win64-Shipping + 10ca04a (game)', 'Marvel-Win64-Shipping + 10ced44 (game)'] } : null
      case 'xtra_niagara_mods': return (args?.modPaths ?? []).filter((p: string) => /vfx/i.test(p))
      case 'xtra_upstream_running': return Boolean(mock.__repakXOpen)
      case 'xtra_stage_off_files': { // like xtra_offfiles.rs: a .off set becomes one staged .pak
        const out: string[] = []
        for (const p of args?.paths ?? []) {
          const m = p.match(/^(.*[\\/])?(.+)\.(pak|utoc|ucas)\.off$/i)
          const next = m ? `C:/Temp/repakxtra-off/${m[2]}.pak` : p
          if (!out.includes(next)) out.push(next)
        }
        return out
      }
      // xtra_nexus.rs install_paks: the pak names each install source holds (a dropped .pak is itself)
      case 'xtra_install_paks': return (args?.paths ?? []).map((p: string) => { const m = p.match(/([^\\/]+)\.pak$/i); return m ? [m[1]] : [] })
      case 'xtra_nexus_sources': return (args?.paths ?? []).map((p: string) => { // same rule as xtra_nexus.rs
        const file = p.split(/[\\/]/).pop()!
        const m = file.match(/^(.+)[_ ](\d+)[_ ]([0-9A-Za-z.-]+)[_ ](\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})Z[_ ][0-9A-Za-z]+\.(zip|rar|7z)$/i)
        if (m) return { id: Number(m[2]), version: m[3].replace(/-/g, '.'), uploaded: Date.UTC(+m[4], +m[5] - 1, +m[6], +m[7], +m[8]) / 1000, paks: [m[1]] }
        const o = file.match(/^(.+?)-(\d+)-([0-9A-Za-z]+(?:-[0-9A-Za-z]+)*)-(\d{9,11})\.(zip|rar|7z)$/i)
        return o ? { id: Number(o[2]), version: o[3].replace(/-/g, '.'), uploaded: Number(o[4]), paks: [o[1]] } : null
      })
      // Crash suspects: mods whose path has window.__suspectMatch (part of a name) hold the crashed asset
      case 'xtra_crash_suspects': return (args?.modPaths ?? []).filter((p: string) => mock.__suspectMatch && p.includes(mock.__suspectMatch))
      // localStorage 'mock.prevCrash' = '1': a crash from before the app started (its toast at startup)
      case 'check_for_previous_crash': {
        if (localStorage.getItem('mock.prevCrash') !== '1') return null
        const crash_folder = 'C:/Users/you/AppData/Local/Marvel/Saved/Crashes/UECC-Windows-MOCK_0000'
        setTimeout(() => emit('game_crash_detected', { title: 'Game Crashed', description: 'Error: Access Violation', type: 'danger', crash_folder,
          crash_type: 'Access Violation', asset_path: '/Game/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001', character_id: '1026', is_mesh_crash: true }), 500)
        return { crash_folder }
      }
      case 'get_skip_launcher_status': return false
      // localStorage 'mock.clashes': a JSON list of { file_path, mod_paths } to show conflicts (custom/conflicts.ts)
      case 'check_mod_clashes': return JSON.parse(localStorage.getItem('mock.clashes') || '[]')
      // localStorage 'mock.broken' = '1' marks the first mod Broken and the second May crash (xtra_broken.rs reads the game's files)
      // 'mock.broken' = 'vfx' marks every mod with VFX in its name Needs VFX update instead (custom/vfx/VfxNotice.tsx shows)
      case 'xtra_broken_mods':
        // with 'mock.vfxStale' some also have 6 Niagara files the update rewrote (a partial update, mockStale)
        if (localStorage.getItem('mock.broken') === 'vfx') return (args?.modPaths ?? []).filter((p: string) => /vfx/i.test(p) && !/_UPDATED_|_PARTIAL_|_ORIGINAL_/i.test(p)).map((path: string) => ({ path, kind: 'vfx',
          reason: 'A game update changed 381 of the game files this VFX mod replaces, so its effects may look wrong or crash the game. The VFX Updater rebuilds it on the new game files.',
          ...(mockStale(path) ? { staleNiagara: 6 } : {}) }))
        return localStorage.getItem('mock.broken') ? (args?.modPaths ?? []).slice(0, 2).map((path: string, i: number) => ({ path,
          kind: i ? 'risky' : 'broken', reason: i ? 'A Blueprint mod installed before the last game update.' : 'None of the 3 game files it replaces exist in this game version.' })) : []
      // the VFX Updater's list: mods with VFX in their name stand in for the VFX type (no originals with an update beside them)
      case 'xtra_vfx_mods': return { problems: [], mods: data.mods.filter((m: any) => /vfx/i.test(m.path) && !/_BROKEN(_\d+)?_P\./i.test(m.path)).map((m: any) => ({
        path: m.path, utoc: m.utoc_path || m.path.replace(/\.(pak|bak_repak)$/i, '.utoc'), enabled: m.enabled, hero: m.character_name ?? null, modified: m.modified_date ?? 0,
        name: m.custom_name || m.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/(_\d+)?_P$/i, '') })) }
      case 'xtra_game_build': return { updated: Math.floor(Date.now() / 1000) - 3600 * 5, cl: 3962284 }
      // Installing: the file picker returns two fake paks, install adds them to the library and reports done. A folder
      // pick (the Sigeon folder) returns an unzipped Sigeon download.
      case 'plugin:dialog|open':
        if (args?.options?.directory) return 'C:\\Users\\you\\Downloads\\Sigeon V2'
        if (localStorage.getItem('mock.pick')) return JSON.parse(localStorage.getItem('mock.pick')!) // a JSON list of paths
        return ['C:/Fake/Drop/Alpha_Skin_9999999_P.pak', 'C:/Fake/Drop/Beta_Icons_9999999_P.pak']
      // localStorage 'mock.dropType' sets the dropped mods' type (e.g. 'Daredevil - Mesh [Blueprint]')
      // 'mock.dropRaw' = '1': the drop is a raw pak (audio, config: no uassets), as an sfx mod is
      case 'parse_dropped_files': {
        const raw = localStorage.getItem('mock.dropRaw') === '1'
        return (args?.paths ?? []).map((path: string) => ({ path, mod_name: path.split('/').pop(), mod_type: raw ? 'Audio' : localStorage.getItem('mock.dropType') || 'Black Panther - Texture',
          is_dir: false, contains_uassets: !raw, contains_raw_assets: false, auto_to_repak: false, file_size: 1048576 }))
      }
      case 'install_mods':
        for (const m of args?.mods ?? []) {
          if (m.enabled === false) continue // left out of an archive: the real backend skips it too
          const back = held.findIndex(x => baseName(x.path) === baseName(m.path ?? m.mod_name ?? ''))
          if (back >= 0) { // a snapshot mod held back by mock.fresh returns, on
            const old = held.splice(back, 1)[0], at = old.path.replace(/\.(bak_repak|pak_disabled)$/i, '.pak')
            data.mods.push({ ...old, path: at, enabled: true, modified_date: Date.now() / 1000 })
            data.details[at] ??= data.details[old.path]
            continue
          }
          const path = `${data.gamePath}\\${normalizeModBaseName(m.customName || m.mod_name)}.pak`
          if (!data.mods.some((x: any) => x.path === path)) data.mods.push({ ...data.mods[0], path, enabled: true, modified_date: Date.now() / 1000 })
          data.details[path] ??= { ...data.details[data.mods[0].path], mod_name: path.split('\\').pop()?.replace(/\.pak$/, '') } // details open for it
        }
        if (slow()) [20, 45, 70, 90, 100].forEach((p, i) => setTimeout(() => emit('install_progress', p), slow() * 0.3 * (i + 1)))
        setTimeout(() => emit('install_complete', null), 300 + slow() * 1.6)
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
        if (mock.__repakXOpen) throw 'Repak X is open too. Close it to change mods in repakxtra: both apps change the same files.' // window.__repakXOpen = true
        const mod = data.mods.find((m: any) => m.path === args?.modPath)
        if (mod) mod.enabled = !mod.enabled
        return mod?.enabled ?? null
      }
      default: {
        const vfx = mockVfx(cmd, args) // the VFX Updater window's commands
        if (vfx !== undefined) return vfx
        console.debug('[mockBackend] unhandled', cmd, args)
        return null
      }
    }
  }, { shouldMockEvents: true })
}

// The VFX Updater window (custom/vfx/) in the browser: a fake run with materials to rebuild, Niagara systems that pass
// through, one the game lacks and one parameter the game dropped. window.__vfxStep sets the ms each tool step takes (400).
// localStorage 'mock.vfxFail' = part of a mod's name makes its extraction fail; 'mock.vfxUnreadable' adds an asset the
// tool cannot read (which now fails the mod: an unread asset may be one that needed rebuilding). 'mock.vfxStale' makes its
// Niagara systems older than the game's, so they are left out (a partial update).
const vfxFiles = new Map<string, string>()
/** 'mock.vfxStale': the mods (by any of their files) whose Niagara systems are older than the game's, about half of them */
const mockStale = (path: string) => Boolean(localStorage.getItem('mock.vfxStale')) && path.replace(/\.[^.\\/]+$/, '').length % 2 === 0
const vfxStep = () => new Promise(r => setTimeout(r, mock.__vfxStep ?? 400))
const vfxEntry = (name: string, v: number) => ({ Name: '0', Value: [{ Name: 'ParameterInfo', Value: [{ Name: 'Name', Value: name }] },
  { Name: 'ParameterValue', StructType: 'LinearColor', Value: [{ Name: 'ParameterValue', Value: { R: v, G: v / 2, B: 1, A: 1 } }] }] })
const vfxJson = (game: boolean, i: number) => JSON.stringify({ NameMap: [], Imports: [{ ObjectName: 'MaterialInstanceConstant', ClassName: 'Class', OuterIndex: -2 }, { ObjectName: '/Script/Engine', ClassName: 'Package', OuterIndex: 0 }],
  Exports: [{ ObjectName: `MI_${i}`, ClassIndex: -1, Data: [{ Name: 'VectorParameterValues', Value: [vfxEntry('Glow_Color', game ? 1 : 0.2), ...(game && i === 3 ? [] : [vfxEntry('Rim_Tint', game ? 0.5 : 0.9)])] }] }] })
const vfxAssets = (dir: string) => [
  ...Array.from({ length: 24 }, (_, i) => `${dir}/Marvel/Content/Marvel/VFX/Materials/Characters/1026/MI_1026_Glow_${String(i).padStart(2, '0')}.uasset`),
  ...Array.from({ length: 6 }, (_, i) => `${dir}/Marvel/Content/Marvel/VFX/Particles/NS_1026_Burst_${i}.uasset`),
  ...(localStorage.getItem('mock.vfxUnreadable') ? [`${dir}/Marvel/Content/Marvel/VFX/Materials/Characters/1026/MI_1026_Broken.uasset`] : []),
  `${dir}/Marvel/Content/Marvel/VFX/Materials/Characters/1026/MI_1026_ModOwn.uasset`]
let vfxLock: { token: string; window: string; name?: string | null } | null = null
const VFX_USMAP = 'C:\\Users\\you\\AppData\\Roaming\\Repak-X\\usmap\\5.3.2-3939753+++depot_marvel+S10.5_release-Marvel.usmap'
function mockVfx(cmd: string, args: any): unknown {
  const dirOf = (k: string) => `C:/Temp/xvfx/${k}`
  switch (cmd) {
    case 'vfx_get_settings': return { usmapPath: VFX_USMAP }
    // the run lock (xtra_vfx.rs): one window in the browser, so a holder and a change event are enough
    case 'xtra_vfx_claim':
      if (vfxLock && vfxLock.token !== args.token) return false
      vfxLock = { token: args.token, window: 'main', name: args.name ?? null }; emit('vfx_lock_changed', vfxLock); return true
    case 'xtra_vfx_release': if (vfxLock?.token === args.token) vfxLock = null; emit('vfx_lock_changed', vfxLock); return null
    case 'xtra_vfx_lock': return vfxLock
    case 'xtra_vfx_stale': return mockStale(String(args.modPath)) ? (args.files as string[]).filter(f => /NS_/.test(f)) : []
    case 'xtra_vfx_old_layout': return []
    case 'xtra_vfx_layout_scan': return 0
    case 'xtra_layout_scan': return 0
    case 'xtra_vfx_source': return String(args.modPath)
    case 'xtra_skin_table_hero': return null
    // the mock's USMAP is older than its game: Niagara files stay left out, as in a real run before a matching USMAP
    case 'xtra_vfx_niagara': return { ready: false, why: 'The USMAP is older than the game', files: [] }
    case 'vfx_save_settings': return null
    case 'vfx_check_usmap_update': return vfxStep().then(() => ({ updated: false, upToDate: true, skipped: false, localPath: VFX_USMAP,
      filename: '5.3.2-3939753+++depot_marvel+S10.5_release-Marvel.usmap', version: 'S10.5_release', buildNumber: 3939753, commitDate: '2026-10-16', message: 'USMAP is up to date' }))
    case 'vfx_usmap_exists': return true
    case 'xtra_vfx_dirs': return { modExtract: dirOf('mod_extract'), modJson: dirOf('mod_json'), editedJson: dirOf('edited_json'), finalUassets: dirOf('final'), stage: dirOf('stage'),
      vanillaExtract: dirOf('vanilla_extract'), vanillaJson: dirOf('vanilla_json'), vanillaIndex: dirOf('vanilla/index.json') }
    case 'vfx_extract_mod_assets':
      return vfxStep().then(() => {
        const fail = localStorage.getItem('mock.vfxFail')
        if (fail && String(args?.modPath).includes(fail)) throw '[VFX] Extract mod assets failed: Failed to read container: the .utoc is not an IoStore container'
        return vfxAssets(args.outputDir)
      })
    case 'xtra_vfx_detect': return vfxStep().then(() => {
      emit('vfx_progress', { stage: 'Reading asset types', step: 1, current: args.paths.length, total: args.paths.length, message: `Read ${args.paths.length} of ${args.paths.length} asset types` })
      return Object.fromEntries(args.paths.map((p: string) => [p, /Broken/.test(p) ? { kind: 'other', class: null, error: 'Unversioned properties cannot be serialized without valid mappings' }
        : { kind: 'material_instance', class: 'MaterialInstanceConstant', error: null }]))
    })
    case 'vfx_copy_uasset_files': return []
    case 'vfx_write_json_file': vfxFiles.set(args.path, args.content); return null
    case 'vfx_read_json_file': {
      if (vfxFiles.has(args.path)) return vfxFiles.get(args.path)
      if (/index\.json$/.test(args.path)) throw 'Failed to read JSON file: not found'
      const i = Number(args.path.match(/_(\d+)\.json$/)?.[1] ?? 0)
      return vfxJson(args.path.includes('vanilla_json'), i)
    }
    case 'vfx_convert_uassets_to_json': return vfxStep().then(() => {
      const list = (vfxFiles.get(`${args.inputDir}/uasset_list.txt`) ?? '').split('\n').filter(Boolean)
      const names = list.length ? list : vfxAssets('').map(p => p.slice(1).replace(/\.uasset$/, '')).filter(p => !/NS_|Broken|ModOwn/.test(p))
      return names.map(n => `${args.outputDir}/${n}.json`)
    })
    case 'vfx_extract_vanilla_assets': return vfxStep().then(() => {
      const found = args.filterPatterns.filter((p: string) => !/ModOwn/.test(p))
      vfxFiles.set(`${args.outputDir}/uasset_list.txt`, found.join('\n'))
      return found.map((p: string) => `${args.outputDir}/${p}.uasset`)
    })
    case 'vfx_convert_json_to_uassets': return vfxStep().then(() => vfxAssets(args.outputDir))
    case 'vfx_pack_to_iostore': return vfxStep().then(() => `${args.outputBase}.utoc`)
    case 'xtra_vfx_place': {
      const dir = String(args.source).replace(/[\\/][^\\/]*$/, ''), stem = String(args.source).split(/[\\/]/).pop()!.replace(/\.utoc$/i, '')
      const [, base, prio = ''] = stem.match(/^(.*?)((?:_\d+)?_P)?$/i) ?? [stem, stem]
      const keep = args.keepName !== false, partial = Boolean(args.partial)
      const source = `${dir}\\${stem}.pak`
      if (partial) return { fixed: `${dir}\\${base}_PARTIAL${prio}.pak`, source, original: `${dir}\\${base}_ORIGINAL${prio}.bak_repak`, turnedOff: true, replaced: false, trashed: false }
      const fixed = keep ? `${dir}\\${stem}.pak` : `${dir}\\${base}_UPDATED_9999999_P.pak`
      return { fixed, source, original: `${dir}\\${keep ? `${base}_BROKEN${prio}` : stem}.bak_repak`, turnedOff: Boolean(args.turnOffOriginal || args.trashOriginal), replaced: false, trashed: Boolean(args.trashOriginal) }
    }
    default: return undefined
  }
}
