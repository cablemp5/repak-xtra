// repakxtra: Nexus Mods in the app (xtra_nexus_api.rs). The account (each user's own personal API key, Settings >
// General), update checks for mods installed from Nexus (their source, nexusSource.tsx), and getting a file: Premium
// downloads it straight away, a free account confirms it with Mod manager download on the mod's Files tab, opened in the
// app's Nexus window. The download then installs (App's one-click install) or updates the mod it replaces.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ExternalLink, KeyRound, LogOut, TriangleAlert, X } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import type { NexusSource } from './nexusSource'
import nexusLogo from './logos/nexus.png'
import keyShot from './logos/nexus-api-key.png'
import { ownsTop, useDialogFocus } from './dialogFocus'
import { APP_NAME, EXTENDED } from './edition'
import Checkbox from '../components/ui/Checkbox'
import { prefOn, setPref, useUiPref } from './uiPrefs'

type Alert = ReturnType<typeof useAlert>
type Account = { name: string; premium: boolean }
export type NexusFile = { fileId: number; name: string; version: string; date: number; category: string; groupId: number | null }
export type NexusUpdate = NexusFile & { modId: number }
type Link = { modId: number; fileId: number; key?: string; expires?: number }

/** Marvel Rivals on Nexus Mods (its game id in the GraphQL API, its domain in page links). */
export const GAME_ID = 7106
export const pageUrl = (id: number) => `https://www.nexusmods.com/marvelrivals/mods/${id}`
const KEYS_URL = 'https://www.nexusmods.com/settings/api-keys'

let account: Account | null = null
let checked = false // the saved key was looked at (or there was none)
let updates: Record<string, NexusUpdate> = {}
const listeners = new Set<() => void>()
const notify = () => listeners.forEach(l => l())
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const useNexusAccount = () => useSyncExternalStore(subscribe, () => account)
/** The saved key was looked at (or there was none): until then the account is unknown, not signed out. */
export const useNexusReady = () => useSyncExternalStore(subscribe, () => checked)
const loadAccount = () => invoke<Account | null>('xtra_nexus_account')
  .then(a => { account = a }, () => { account = null }) // the key was turned down: Settings asks for it again
  .finally(() => { checked = true; notify() })
let accountLoaded: Promise<void> = Promise.resolve() // an Install clicked at start waits for it

/** Nexus sends names and summaries with HTML entities (&#39;): plain text. */
export const plain = (s: string) => new DOMParser().parseFromString(s, 'text/html').documentElement.textContent ?? s

/** One query to Nexus's public GraphQL API (no key needed). */
export const gql = <T,>(query: string, variables: Record<string, unknown> = {}) => invoke<T>('xtra_nexus_gql', { query, variables })

const sourceId = (s: NexusSource) => `${s.id}:${s.uploaded}`
/** The newer file for a mod installed from Nexus, once checked (checkUpdates). */
export const updateOf = (s?: NexusSource) => (s ? updates[sourceId(s)] : undefined)
/** Re-renders when an update check finishes. */
export const useNexusUpdates = () => useSyncExternalStore(subscribe, () => updates)

/** Pure: the file that replaces the installed one (uploaded at `uploaded`, Unix seconds), or undefined. The installed
 *  file is the one uploaded at that time (new archive names keep only the minute, so up to 59 s later); a newer version
 *  of it is a newer file of its file group that is not retired (old version, archived, removed). When the installed file is gone from the
 *  mod, a mod with a single main file offers that one if it is newer. */
export function newerFile(files: NexusFile[], uploaded: number): NexusFile | undefined {
  // shortcut: two files of one mod uploaded in the same minute read as the first; a stored file id would settle it
  const mine = files.find(f => f.date >= uploaded && f.date - uploaded < 60)
  const live = files.filter(f => !['OLD_VERSION', 'ARCHIVED', 'REMOVED'].includes(f.category))
  const pool = mine ? live.filter(f => f.groupId !== null && f.groupId === mine.groupId) : live.filter(f => f.category === 'MAIN')
  if (!mine && pool.length !== 1) return undefined
  const after = mine?.date ?? uploaded + 59
  return pool.filter(f => f.date > after).sort((a, b) => b.date - a.date)[0]
}

const FILE_FIELDS = 'fileId name version date category groupId'
/** How often a mod's files are looked at again (App runs checkUpdates on this beat and when the mods change). */
export const CHECK_EVERY = 60 * 60 * 1000
const checkedAt = new Map<number, number>() // by mod id, only checks that got an answer

/** Looks for newer files of the given sources whose mod was not checked within the hour: one query per 40 mods. A
 *  failed query is tried again next time. */
export async function checkUpdates(sources: (NexusSource | undefined)[]) {
  const due = sources.filter((s): s is NexusSource => Boolean(s) && Date.now() - (checkedAt.get(s!.id) ?? 0) >= CHECK_EVERY)
  const ids = [...new Set(due.map(s => s.id))]
  if (!ids.length) return
  ids.forEach(id => checkedAt.set(id, Date.now())) // taken now, so a second call meanwhile skips them
  const files: Record<string, NexusFile[] | null> = {}
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40)
    const query = `{ ${part.map(id => `m${id}: modFiles(modId: ${id}, gameId: ${GAME_ID}) { ${FILE_FIELDS} }`).join(' ')} }`
    const got = await gql<Record<string, NexusFile[] | null>>(query).catch(() => null)
    if (got) Object.assign(files, got); else part.forEach(id => checkedAt.delete(id))
  }
  const next = { ...updates }
  for (const s of due) {
    if (!(`m${s.id}` in files)) continue
    const f = newerFile(files[`m${s.id}`] ?? [], s.uploaded)
    if (f) next[sourceId(s)] = { ...f, modId: s.id }; else delete next[sourceId(s)]
  }
  updates = next
  notify()
}

type Handlers = { install: (archive: string) => Promise<unknown>; update: (oldPath: string, archive: string) => Promise<unknown>; alert: Alert }
let handlers: Handlers | null = null
/** The updates waiting on a Mod manager download, by the file asked for: the mod it replaces. A link for any other
 *  file (an optional extra) installs as itself. Forgotten after half an hour (the page was closed). */
const waiting = new Map<number, { oldPath: string; at: number }>()
const WAIT_MS = 30 * 60 * 1000
/** Files downloading or installing now: a second click on the same one waits for the first. */
const busy = new Set<number>()
let applying: Promise<unknown> = Promise.resolve()

/** Downloads a file (with an nxm:// link's key for free accounts) with a toast that fills, then installs it or updates
 *  the mod at `oldPath` with it. */
/** Mods whose Files tab is open in the Nexus window for a free account's Install, by mod id, until the download comes
 *  back (or half an hour passes): the Nexus Mods tab's card says it is waiting there. */
let pending: Record<number, number> = {}
// a card stops waiting after WAIT_MS on its own: the screen is told then
const setPending = (next: Record<number, number>) => { pending = next; notify(); setTimeout(notify, WAIT_MS + 50) }
let autoMod = 0 // the mod a one-click Install's hidden window is for (xtra_nexus_open's own window)
export const useNexusPending = (modId: number) => useSyncExternalStore(subscribe, () => Date.now() - (pending[modId] ?? 0) < WAIT_MS)
/** Mods downloading from Nexus right now, until their file is handed to the Install dialog: their card says Installing. */
const installing = new Set<number>()
export const useNexusInstalling = (modId: number) => useSyncExternalStore(subscribe, () => installing.has(modId))

async function fetchAndApply(link: Link, oldPath?: string) {
  if (pending[link.modId]) { const { [link.modId]: _, ...rest } = pending; setPending(rest) } // eslint-disable-line @typescript-eslint/no-unused-vars
  if (!handlers) return
  const { alert } = handlers
  if (busy.has(link.fileId)) { alert.info('Already downloading', 'That file is on its way.'); return }
  busy.add(link.fileId)
  installing.add(link.modId); notify()
  try { await download(link, alert, oldPath) } finally { busy.delete(link.fileId); installing.delete(link.modId); notify() }
}

async function download(link: Link, alert: Alert, oldPath?: string) {
  const id = alert.showAlert({ color: 'default', title: oldPath ? 'Downloading the update' : 'Downloading from Nexus Mods', description: '0%', isLoading: true, duration: 0, progressValue: 0 })
  const un = listen<{ fileId: number; percent: number }>('nexus_download_progress', e => {
    if (e.payload.fileId === link.fileId) alert.updateToast(id, { progressValue: e.payload.percent, description: `${e.payload.percent}%` })
  })
  let archive: string
  try {
    archive = await invoke<string>('xtra_nexus_download', { modId: link.modId, fileId: link.fileId, key: link.key ?? null, expires: link.expires ?? null })
  } catch (e) {
    alert.error('Download failed', String(e))
    return
  } finally {
    un.then(f => f())
    alert.dismissAlert(id)
  }
  await apply(archive, oldPath) // the cache copy goes a day later
}

/** One install or update at a time, each to its end (its loadout too): downloads may finish together. */
function apply(archive: string, oldPath?: string) {
  const run = applying.then(() => (oldPath ? handlers?.update(oldPath, archive) : handlers?.install(archive)))
  applying = run.catch(() => undefined)
  return run
}

/** Gets a file of a Nexus mod and installs it, or updates the installed mod at `oldPath`. Premium downloads it now;
 *  a free account gets the mod's Files tab in the Nexus window (on that file's Mod manager download, when known), and
 *  the download link it opens finishes the job (useNexus). */
export async function getNexusFile(modId: number, fileId?: number, oldPath?: string) {
  if (!handlers) return
  await accountLoaded
  if (!account) {
    handlers.alert.warning('Nexus Mods account needed', 'Add your personal API key in Settings > General > Nexus Mods to install and update from Nexus.')
    return
  }
  if (account.premium && fileId) return fetchAndApply({ modId, fileId }, oldPath)
  if (oldPath && fileId) waiting.set(fileId, { oldPath, at: Date.now() })
  if (!oldPath) setPending({ ...pending, [modId]: Date.now() })
  // one-click Install (experimental): a known file downloads in a hidden Nexus window, no click there
  const auto = Boolean(fileId) && prefOn('nexus-auto')
  if (auto && !oldPath && !autoMod) autoMod = modId
  await openWindow(`${pageUrl(modId)}?tab=files${fileId ? `&file_id=${fileId}&nmm=1` : ''}`, auto)
    .catch(e => {
      if (pending[modId]) { const { [modId]: _, ...rest } = pending; setPending(rest) } // eslint-disable-line @typescript-eslint/no-unused-vars
      handlers?.alert.error('Could not open Nexus Mods', String(e))
    })
}

/** Install from the Nexus tab: a mod with one main file goes straight to that file, others open their Files tab to
 *  pick one (Premium included). */
export async function installFromNexus(modId: number) {
  const files = await gql<{ modFiles: NexusFile[] }>(`{ modFiles(modId: ${modId}, gameId: ${GAME_ID}) { ${FILE_FIELDS} } }`).then(d => d.modFiles, () => [])
  const main = files.filter(f => f.category === 'MAIN')
  return getNexusFile(modId, main.length === 1 ? main[0].fileId : undefined)
}

const openWindow = (url: string, auto = false) => invoke('xtra_nexus_open', { url, auto })

/** Opens a mod's Nexus page in the app's Nexus window. */
export const openNexusPage = (modId: number) => EXTENDED
  ? openWindow(pageUrl(modId)).catch(() => undefined)
  : openOutside(pageUrl(modId)) // repakxtra has no Nexus window: the browser

/** App's hook: the account at start, and each Mod manager download (from the Nexus window or a browser) installed or
 *  applied as the update it was asked for. */
export function useNexus(h: Handlers) {
  handlers = h
  useEffect(() => {
    accountLoaded = loadAccount()
    const take = (link: Link) => {
      const w = waiting.get(link.fileId)
      waiting.delete(link.fileId)
      void fetchAndApply(link, w && Date.now() - w.at < WAIT_MS ? w.oldPath : undefined)
    }
    const un = listen<Link>('nexus-nxm', e => take(e.payload))
    // a plain download in the Nexus window (xtra_nexus_open's on_download) installs the same way
    const file = listen<string>('nexus-file', e => { setPending({}); void apply(e.payload) }) // which mod it is for is unknown: none waits
    // a Nexus window closed (by hand, or after its download): its cards stop waiting. A one-click window waits for its
    // mod, the Nexus window for the others
    const closed = listen<string>('nexus-window-closed', e => {
      const one = e.payload === 'nexus-auto'
      setPending(Object.fromEntries(Object.entries(pending).filter(([id]) => (Number(id) === autoMod) !== one)))
      if (one) autoMod = 0
    })
    const failed = listen<string>('nexus-download-failed', () => {
      setPending({})
      handlers?.alert.error('The Nexus download failed', 'The Nexus window is open again. Click Slow download to try once more.')
    })
    // the API keys page's Copy closed the Nexus window (nexus-theme.js): where the key goes now
    const copied = listen('nexus-key-copied', () => {
      handlers?.alert.success('API key copied', 'It is on your clipboard. Paste it in step 3 and click Connect.', { keep: true })
      document.querySelector<HTMLInputElement>('.nx-step-key .nx-key-input')?.focus()
    })
    // once listening: the links that came first (one that started the app)
    un.then(() => invoke<Link[]>('xtra_nexus_pending')).then(held => held.forEach(take)).catch(() => undefined)
    return () => { un.then(f => f()); file.then(f => f()); copied.then(f => f()); closed.then(f => f()); failed.then(f => f()) }
  }, [])
}

type Picture = { modId: number; name: string; pictureUrl: string | null; thumbnailLargeUrl: string | null }

/** The loadout page's From Nexus (over its Image cover): the main picture of each Nexus mod in the loadout. A click
 *  makes it the loadout's image (`onPick`, which says itself when it could not save). Esc or a click outside closes. */
export function NexusPictures({ ids, onPick, onClose }: { ids: number[]; onPick: (image: Blob) => Promise<boolean>; onClose: () => void }) {
  const [pics, setPics] = useState<Picture[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState('')
  const focus = useDialogFocus() // a dialog: Tab stays inside, focus goes back to From Nexus, the page's Esc waits
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const list = ids.map(id => `{ gameDomain: "marvelrivals", modId: ${id} }`).join(', ') // numbers only: nothing to escape
    gql<{ legacyModsByDomain: { nodes: Picture[] } }>(`{ legacyModsByDomain(ids: [${list}]) { nodes { modId name pictureUrl thumbnailLargeUrl } } }`)
      .then(d => setPics(d.legacyModsByDomain.nodes.filter(p => p.pictureUrl)), e => setError(String(e)))
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && ownsTop(focus.ref.current)) { e.stopPropagation(); close.current() } }
    const out = (e: MouseEvent) => { if (ownsTop(focus.ref.current) && !focus.ref.current?.contains(e.target as Node)) close.current() }
    window.addEventListener('keydown', key, true)
    document.addEventListener('mousedown', out)
    return () => { window.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', out) }
  }, [ids.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  const pick = async (p: Picture) => {
    setBusy(p.modId); setError('')
    try {
      const r = await fetch(p.pictureUrl!)
      if (!r.ok) throw new Error(`Nexus Mods answered ${r.status}`)
      if (await onPick(await r.blob())) close.current()
    } catch (e) { setError(`The picture did not download. ${e instanceof Error ? e.message : e}`) } finally { setBusy(null) }
  }
  return (
    <div className="nx-pics" ref={focus.ref} onKeyDown={focus.onKeyDown} role="dialog" aria-modal="true" aria-label="Pictures from Nexus Mods" tabIndex={-1}>
      <div className="nx-pics-head">
        <span>Pictures from Nexus Mods</span>
        <button type="button" className="lo-icon" aria-label="Close" title="Close" onClick={() => close.current()}><X size={14} /></button>
      </div>
      {!pics && !error && <small>Loading…</small>}
      {pics && !pics.length && <small>None of these mods has a picture on Nexus Mods.</small>}
      {pics && pics.length > 0 && (
        <div className="nx-pics-grid">
          {pics.map(p => (
            <button key={p.modId} type="button" className="nx-pic" disabled={busy !== null} aria-busy={busy === p.modId} onClick={() => pick(p)} title={`Use the picture of ${plain(p.name)}`}>
              <img src={p.thumbnailLargeUrl ?? p.pictureUrl!} alt={plain(p.name)} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {error && <small role="alert">{error}</small>}
    </div>
  )
}

/** The key field's state and Save: checks the key with Nexus, then stores it (xtra_nexus_set_key). */
function useKeySave() {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const save = async () => {
    setBusy(true); setError(null)
    try {
      account = await invoke<Account>('xtra_nexus_set_key', { key: key.trim() })
      setKey('')
      notify()
    } catch (e) { setError(String(e)); field.current?.focus() } finally { setBusy(false) }
  }
  return { key, setKey, busy, error, field, save }
}

/** The Nexus Mods tab while signed out: a header, then the steps to a personal API key (NexusSteps). */
export function NexusSignIn() {
  return (
    <section className="nx-signin" aria-labelledby="nx-signin-title">
      <header className="nx-signin-head">
        <img src={nexusLogo} alt="" className="nx-signin-logo" />
        <div>
          <h2 id="nx-signin-title">Connect Nexus Mods</h2>
          <p>Browse, install, and update Marvel Rivals mods without leaving {APP_NAME}.</p>
        </div>
      </header>
      <NexusSteps />
      <p className="nx-signin-foot">Free accounts work too: Install opens the mod's file in the Nexus window, and one click on Slow download there installs it here.</p>
    </section>
  )
}

/** Getting a personal API key, three steps in the order they happen (open the page, find the key at its bottom, paste
 *  it here), each number in the app's step ring. The signed-out tab and Settings both show it. */
function NexusSteps() {
  const { key, setKey, busy, error, field, save } = useKeySave()
  return (
      <ol className="nx-steps">
        <li>
          <span className="nx-step-n" aria-hidden="true">1</span>
          <div className="nx-step-body">
            <b>Sign in to Nexus Mods, once</b>
            <span>The API keys page opens in {APP_NAME}'s Nexus window. Sign in there if it asks. You stay signed in, and installs use it too.</span>
            <button type="button" className="lo-text-btn nx-step-btn" onClick={() => { void openWindow(KEYS_URL).catch(() => openOutside(KEYS_URL)) }}><ExternalLink size={14} aria-hidden="true" /> Open API keys page</button>
          </div>
        </li>
        <li>
          <span className="nx-step-n" aria-hidden="true">2</span>
          <div className="nx-step-body">
            <b>Scroll all the way down to Personal API Key</b>
            <span>Click Request Api Key, then copy the key it shows.</span>
            <img className="nx-step-shot" src={keyShot} alt="The Personal API Key section at the bottom of the Nexus Mods API keys page, with its orange Request Api Key button" />
          </div>
        </li>
        <li>
          <span className="nx-step-n" aria-hidden="true">3</span>
          <div className="nx-step-body">
            <b>Paste it here</b>
            <div className="nx-step-key">
              <input ref={field} className="nx-key-input" type="password" value={key} placeholder="Personal API key" autoComplete="off" spellCheck={false}
                aria-label="Nexus Mods personal API key" onChange={e => setKey(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && key.trim()) save() }} />
              <button type="button" className="lo-text-btn nx-step-save" disabled={busy || !key.trim()} onClick={save}><KeyRound size={14} aria-hidden="true" /> {busy ? 'Checking…' : 'Connect'}</button>
            </div>
            {error ? <span className="nx-step-error" role="alert">{error}</span>
              : <span className="nx-step-note">Kept only in Windows Credential Manager on this PC. Sign out in Settings removes it.</span>}
          </div>
        </li>
      </ol>
  )
}

const openOutside = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))

/** Settings > General > Nexus Mods: paste a personal API key, or see who is signed in and sign out. */
/** Settings > Nexus Mods, free accounts: one-click Install, off until switched on (experimental). */
function AutoInstallPref() {
  const on = useUiPref('nexus-auto')
  return (
    <div className="setting-item">
      <Checkbox checked={on} onChange={(checked: boolean) => setPref('nexus-auto', checked)}>
        <span>One-click Install (experimental)</span>
      </Checkbox>
      <p className="setting-subtext">
        Install clicks Slow download for you in a hidden Nexus window. If it has not finished after 40 seconds the window shows.
      </p>
      <p className="nx-auto-warn"><TriangleAlert size={14} aria-hidden="true" />
        Turning this on risks a ban of your Nexus Mods account. Nexus asks free accounts to download on its site, and automated downloads break its rules.
      </p>
    </div>
  )
}

export function NexusSetting() {
  const a = useNexusAccount()
  const ready = useNexusReady() // until the saved key is looked at, signed in is unknown: no sign-in steps yet
  const [error, setError] = useState<string | null>(null)
  const signOut = async () => {
    try {
      await invoke('xtra_nexus_forget_key')
      account = null
      setError(null)
      notify()
    } catch (e) { setError(`Not signed out: ${e}`) } // the key is still saved
  }
  return (
    <div className="setting-section">
      <h3 className="setting-icon-label"><img src={nexusLogo} alt="" className="nx-setting-logo" />Nexus Mods</h3>
      <div className="setting-group">
        {!ready && !a ? (
          <p className="setting-subtext xs-note">Checking your Nexus Mods account…</p>
        ) : a ? (<>
          <div className="xs-row">
            <div className="xs-text">
              <span className="xs-label">{a.name ? `Signed in as ${a.name}` : 'Key saved. Nexus Mods could not be reached to check it.'}</span>
              <span className="setting-subtext">
                {a.premium ? 'Premium: installs and updates download straight away.' : `Free account: each install or update opens the mod on Nexus. Click Slow download there and ${APP_NAME} does the rest.`}
              </span>
            </div>
            <button type="button" className="action-btn" onClick={signOut}><LogOut size={14} /> Sign out</button>
          </div>
          {!a.premium && <AutoInstallPref />}
        </>) : (
          <>
            <p className="setting-subtext xs-note">
              Connect your Nexus account to browse, install, and update mods here. Nexus Mod manager downloads then open in {APP_NAME}.
            </p>
            <div className="nx-setting-steps"><NexusSteps /></div>
          </>
        )}
        {error && <p className="setting-subtext nx-key-error" role="alert">{error}</p>}
      </div>
    </div>
  )
}

if (import.meta.env.DEV) {
  const f = (fileId: number, date: number, groupId: number | null, category = 'MAIN') => ({ fileId, name: '', version: '', date, category, groupId })
  console.assert(newerFile([f(1, 1000, 7, 'OLD_VERSION'), f(2, 2000, 7), f(3, 3000, 8)], 1000)?.fileId === 2, 'newerFile: the same group, not another file')
  console.assert(newerFile([f(1, 1030, 7), f(2, 2000, 7, 'ARCHIVED')], 1000) === undefined, 'newerFile: an archived one is no update')
  console.assert(newerFile([f(1, 1000, 7)], 1000) === undefined, 'newerFile: up to date')
  console.assert(newerFile([f(2, 2000, 7), f(3, 1500, 8, 'OPTIONAL')], 1000)?.fileId === 2, 'newerFile: installed file gone, the one main file')
  console.assert(newerFile([f(2, 2000, 7), f(3, 1500, 8)], 1000) === undefined, 'newerFile: installed file gone, two main files')
}
