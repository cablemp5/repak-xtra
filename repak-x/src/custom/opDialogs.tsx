// repakxtra: the three ways a change to the mods folder gets refused (xtra_ops.rs), one small dialog each, shared by every
// change to mod files: install, delete, rename, on/off, priority, move, and restore. Game open waits for the game to
// close and goes on by itself. File in use offers Retry. Name taken offers Keep both (the safe one, blue), Replace (the
// mod there goes to Recently deleted), and Cancel. One blue action per dialog (Hick), Windows' own words for the same
// situations (Jakob), and the words describe the PC, never the app. One dialog at a time: a second request waits.
// The same dialog asks before a preview kit installs from a file (confirmKitFile): it holds programs the app runs.
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { motion } from 'framer-motion'
import { LoaderCircle, ShieldCheck, ShieldAlert } from 'lucide-react'
import { useDialogFocus } from './dialogFocus'
import { cue } from './sounds'

export type OpKind = 'game_running' | 'locked' | 'collision'
export type OpMode = 'replace' | 'keep_both'
type Answer = 'retry' | 'install' | OpMode | null
const TAG = /\[(game_running|locked|collision)\]\s*/

/** The tag xtra_ops.rs put on a refusal, or null for any other error. */
export const opKind = (e: unknown) => (String(e).match(TAG)?.[1] as OpKind | undefined) ?? null
/** A refusal's words without its tag (and whatever a caller put before it). */
export const opText = (e: unknown) => { const s = String(e); const m = s.match(TAG); return m ? s.slice((m.index ?? 0) + m[0].length) : s }

/** kit: the file's size and whether it is the newest published kit (matches null: GitHub could not be asked) */
type KitInfo = { size: number; published: string | null; matches: boolean | null }
type Ask = { kind: OpKind | 'kit'; what: string; text: string; modes: boolean; kit?: KitInfo; resolve: (a: Answer) => void }
let queue: Ask[] = []
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())
const ask = (kind: Ask['kind'], what: string, text = '', modes = true, kit?: KitInfo) =>
  new Promise<Answer>(resolve => { queue = [...queue, { kind, what, text, modes, kit, resolve }]; emit() })
const answer = (a: Answer) => { const [first, ...rest] = queue; queue = rest; emit(); first?.resolve(a) }

/** Runs a change to mod files. Refused for one of the three reasons, it asks and runs again with the answer (Replace or
 *  Keep both go in as `mode`). Resolves with { value } (the change's result), or null when cancelled. Other errors throw.
 *  `what` finishes "Close the game to ...": "rename this mod", "turn off 3 mods". */
export async function runOp<T>(what: string, op: (mode?: OpMode) => Promise<T>, { modes = true } = {}): Promise<{ value: T } | null> {
  let mode: OpMode | undefined
  for (;;) {
    try { return { value: await op(mode) } } catch (e) {
      const kind = opKind(e)
      if (!kind) throw e
      const a = await ask(kind, what, opText(e), modes)
      if (!a) return null
      if (a !== 'retry' && a !== 'install') mode = a
    }
  }
}

/** The app's own lock while the game runs: true once the game has closed (go on), false when the user cancelled. */
export const gameClosed = async (what: string) => (await ask('game_running', what)) !== null

/** Asks before a preview kit installs from `file` (dropped or picked): true to install. */
export const confirmKitFile = async (file: string, kit: KitInfo) =>
  (await ask('kit', file.split(/[\/]/).pop() || file, '', false, kit)) === 'install'

/** Mounted once (App). Shows the first request in the queue. */
export function OpDialogs() {
  const top = useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => queue[0])
  return !top ? null : top.kind === 'kit' && top.kit ? <KitDialog key={`kit:${top.what}`} a={top} k={top.kit} />
    : <OpDialog key={`${top.kind}:${top.what}:${top.text}`} a={top} />
}

function OpDialog({ a }: { a: Ask }) {
  const { ref, onKeyDown } = useDialogFocus(true, () => answer(null))
  useEffect(() => { cue(a.kind === 'game_running' ? 'open' : 'warning') }, [])
  // Game open: checks every 1.5 s and goes on by itself once the game is gone
  useEffect(() => {
    if (a.kind !== 'game_running') return
    let live = true
    const check = async () => {
      const running = await invoke<boolean>('check_game_running').catch(() => true)
      if (!live) return
      if (!running) { cue('success', { emphasis: 'subtle' }); answer('retry') } else timer = setTimeout(check, 1500)
    }
    let timer = setTimeout(check, 1500)
    return () => { live = false; clearTimeout(timer) }
  }, [a])
  const title = a.kind === 'game_running' ? `Close the game to ${a.what}`
    : a.kind === 'locked' ? 'Another program is using this mod'
    : a.text || 'A mod with this name is already there'
  const body = a.kind === 'game_running' ? 'The game keeps the mods it loaded open. This finishes by itself once the game closes.'
    : a.kind === 'locked' ? (a.text || 'Close the program using it, then try again.')
    : a.modes ? 'Keep both adds a number to this one. Replace moves the one there to Recently deleted.' : 'Pick another name, or move the one there first.'
  return (
    <div className="modal-overlay op-overlay" onClick={() => answer(null)}>
      <motion.div ref={ref} className="modal-content op-modal" role="alertdialog" aria-modal="true" aria-labelledby="op-title" aria-describedby="op-body"
        tabIndex={-1} onKeyDown={onKeyDown} onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <h2 id="op-title" className="op-title">{title}</h2>
        <p id="op-body" className="op-body">{body}</p>
        {a.kind === 'game_running' && (
          <p className="op-wait" role="status"><LoaderCircle size={14} className="scan-status-spin" aria-hidden="true" />Waiting for the game to close</p>
        )}
        <div className="op-actions">
          <button type="button" className="lo-text-btn" onClick={() => answer(null)}>Cancel</button>
          {a.kind === 'locked' && <button type="button" className="btn-primary" onClick={() => answer('retry')}>Retry</button>}
          {a.kind === 'collision' && a.modes && <>
            <button type="button" className="lo-text-btn" onClick={() => answer('replace')}>Replace</button>
            <button type="button" className="btn-primary" onClick={() => answer('keep_both')}>Keep both</button>
          </>}
        </div>
      </motion.div>
    </div>
  )
}

if (import.meta.env.DEV) {
  console.assert(opKind('Restored 0 file(s); failed: [collision] M is back.') === 'collision' && opKind('plain') === null, 'opKind finds a tag anywhere')
  console.assert(opText('Failed to rename file: [locked] Another program is using it.') === 'Another program is using it.', 'opText drops the tag and what came before')
}

/** For a change that already failed elsewhere (an install, which runs in the background): asks as runOp would, and is
 *  true when the change should run again. No Replace or Keep both: the caller cannot pass them on. */
export async function retryAfter(e: unknown, what: string) {
  const kind = opKind(e)
  return kind ? (await ask(kind, what, opText(e), false)) === 'retry' : false
}

/** The kit confirm: what installing it means, the file (name and size), and whether it is the published kit. Cancel
 *  first, Install last and blue (Serial position, Hick). The match line has an icon and words, never color alone. */
function KitDialog({ a, k }: { a: Ask; k: KitInfo }) {
  const { ref, onKeyDown } = useDialogFocus(true, () => answer(null))
  useEffect(() => { cue('warning') }, [])
  const mb = k.size >= 1048576 ? `${Math.round(k.size / 1048576)} MB` : `${Math.max(1, Math.round(k.size / 1024))} KB`
  const Icon = k.matches ? ShieldCheck : ShieldAlert
  return (
    <div className="modal-overlay op-overlay" onClick={() => answer(null)}>
      <motion.div ref={ref} className="modal-content op-modal" role="alertdialog" aria-modal="true" aria-labelledby="op-title" aria-describedby="op-body"
        tabIndex={-1} onKeyDown={onKeyDown} onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <h2 id="op-title" className="op-title">Install this preview kit?</h2>
        <p id="op-body" className="op-body">It installs programs that repakxtra runs on this PC to make previews. Only continue if you built this kit or got it from the repakxtra releases page.</p>
        <div className="op-file">
          <span className="op-file-name" title={a.what}><span>{a.what}</span></span>
          <span className="op-file-size">{mb}</span>
        </div>
        {k.matches === null
          ? <p className="op-body">Could not check it against the published kit.</p>
          : <p className={`op-match ${k.matches ? 'is-match' : 'is-other'}`}><Icon size={14} aria-hidden="true" />
              {k.matches ? `Matches the published kit v${k.published}` : `Not the published kit v${k.published}. Its contents are not checked.`}</p>}
        <div className="op-actions">
          <button type="button" className="lo-text-btn" onClick={() => answer(null)}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => answer('install')}>Install</button>
        </div>
      </motion.div>
    </div>
  )
}
