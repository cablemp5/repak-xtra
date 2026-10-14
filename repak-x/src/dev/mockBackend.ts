// Browser preview only: `npm run dev` opened in a normal browser has no Rust backend,
// so this answers invoke() calls from a snapshot of the real library.
// Refresh the snapshot with `node scripts/capture-dev-fixture.mjs`. Never active inside the app.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'

// DEV guard keeps the snapshot out of release bundles
const fixtures = import.meta.env.DEV ? import.meta.glob('./fixture.local.json', { eager: true, import: 'default' }) : {}
const data: any = Object.values(fixtures)[0] ?? {
  gamePath: '', settings: {}, tags: [], characterData: [], mods: [], folders: [], details: {},
}

let sigeonState = 'off'
const previewUrls: Record<string, string> = import.meta.env.DEV
  ? import.meta.glob('./previews.local/*.png', { eager: true, query: '?url', import: 'default' })
  : {}
const previewCovers: Record<string, { covers?: string[] }> = import.meta.env.DEV
  ? import.meta.glob('./previews.local/*.json', { eager: true, import: 'default' })
  : {}

if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
  mockWindows('main')
  mockIPC((cmd, args: any) => {
    switch (cmd) {
      case 'get_pak_files': return data.mods.map((m: any) => ({ ...m })) // fresh objects, like the real backend
      case 'get_folders': return data.folders
      case 'get_app_settings': return data.settings
      case 'get_game_path': return data.gamePath
      case 'get_all_tags': return data.tags
      case 'get_character_data': return data.characterData
      case 'get_mod_details': return data.details[args?.modPath] ?? null
      case 'plugin:webview|set_webview_zoom': // the browser has no webview zoom; CSS zoom stands in
        document.documentElement.style.zoom = String(args?.value ?? 1)
        return null
      case 'sigeon_status':
        return { state: sigeonState, presets: ['base', 'high'], storage: 'Desktop/Sigeon V2', plugins: '', game_running: false, problem: null }
      case 'sigeon_set':
        sigeonState = args?.preset ?? 'off'
        return sigeonState
      case 'get_hero_image_ids': return data.heroIds ?? []
      case 'list_mod_previews': // copies of %APPDATA%\Repak-X\previews in src/dev/previews.local
        return Object.keys(previewUrls).map(f => f.replace(/^.*\/|\.png$/g, ''))
      case 'get_mod_preview':
        return fetch(previewUrls[`./previews.local/${args?.key}.png`]).then(r => r.arrayBuffer())
      case 'generate_mod_previews': // pretend run: each job reports back as already rendered
        ;(args?.jobs ?? []).forEach(([, key]: [string, string], i: number) => setTimeout(() => emit('mod-preview-ready', key), 600 * (i + 1)))
        setTimeout(() => emit('mod-previews-done', true), 600 * ((args?.jobs ?? []).length + 1))
        return true
      case 'cancel_mod_previews': return null
      case 'get_preview_covers': return previewCovers[`./previews.local/${args?.key}.json`]?.covers ?? []
      case 'get_hero_image':
        return fetch(`/src/dev/heroes.local/${args?.id}.png`).then(r => r.arrayBuffer()).then(b => new Uint8Array(b))
      case 'get_app_version': return __APP_VERSION__
      case 'get_last_seen_version': return __APP_VERSION__
      case 'get_sig_bypasser_status': return 'installed'
      case 'get_skip_launcher_status':
      case 'check_game_running':
      case 'check_for_previous_crash': return false
      case 'check_mod_clashes': return []
      case 'toggle_mod': {
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
