// repakxtra: Claim role on cable's Discord card (CableDiscord.tsx, xtra_role.rs). The click says "Finish in your browser"
// at once, opens Discord's consent page, and waits for the browser's answer, which comes back through a repakx:// link
// (no polling). Consent pages wait on the member, so it gives up after 5 minutes, and Open again starts a fresh claim
// when the tab was closed. A claimed role is remembered (the role is kept forever). The claim lives here, not in the card:
// closing Settings mid-claim keeps it, and reopening shows where it stands. Each answer names its claim's state. A role
// given counts from any recent claim (an earlier tab, or after the 5 minutes), anything else only from the newest one.
// Role claimed can be clicked to claim again (the role was removed, or the member left and came back).
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { cue } from './sounds'

export type ClaimState = 'idle' | 'waiting' | 'ok' | 'not_member' | 'denied' | 'error' | 'timeout' | 'unset'
/** xtra_role.rs's event: the claim's state token and the Worker's result */
type Answer = { state: string; result: string }

export const GIVE_UP_MS = 5 * 60_000
const AGAIN = 'Discord did not answer. Try again in a moment.'

/** The line under the card for each state (null: nothing to say). Pure. */
export function claimText(state: ClaimState): string | null {
  switch (state) {
    case 'waiting': return 'Finish in your browser…'
    case 'ok': return null // the card's own "Role claimed" says it
    case 'not_member': return 'Join the server first, then claim again.'
    case 'denied': return 'Nothing changed. Try again any time.'
    case 'error': case 'timeout': return AGAIN
    case 'unset': return 'Claim role is not set up yet.'
    default: return 'Get the repakxtra user role in this server.'
  }
}

/** The answer's state, from the result the browser sent back. Unknown words read as an error. Pure. */
export const fromResult = (result: string): ClaimState => (['ok', 'not_member', 'denied'].includes(result) ? result as ClaimState : 'error')

/** Whether an answer changes the card. A role given (ok) from any claim this session made counts until the card says
 *  so. Other answers count only for the newest claim, while it waits or after it gave up waiting. Pure. */
export const answers = (a: Answer, now: ClaimState, mine: string | null, recent: readonly string[]) =>
  recent.includes(a.state) && (a.result === 'ok' ? now !== 'ok' : a.state === mine && (now === 'waiting' || now === 'timeout'))

const CLAIMED = 'repakxtra.discordClaim' // 'ok' once the role was given: the card says so from then on
let state: ClaimState = localStorage.getItem(CLAIMED) === 'ok' ? 'ok' : 'idle'
let mine: string | null = null // the state token of the newest claim, known once the backend made it
const recent: string[] = [] // this session's claims, newest last (xtra_role.rs keeps as many)
let attempt = 0
let timer: ReturnType<typeof setTimeout> | undefined
let listening: Promise<unknown> | null = null
const subscribers = new Set<() => void>()
const set = (s: ClaimState) => { state = s; subscribers.forEach(f => f()) }

function settle(s: ClaimState) {
  clearTimeout(timer)
  set(s)
  if (s === 'ok') { localStorage.setItem(CLAIMED, 'ok'); cue('success', { emphasis: 'subtle' }) }
  if (s === 'not_member') localStorage.removeItem(CLAIMED) // left the server: the role went with them
}

const listenOnce = () => (listening ??= listen<Answer>('xtra-role-claimed', e => {
  if (answers(e.payload, state, mine, recent)) settle(fromResult(e.payload.result))
}).catch(e => { listening = null; throw e })) // a failed subscription is tried again on the next claim

/** Starts a claim, also from Role claimed (to claim again). While one waits (its tab closed, say), it starts a fresh one:
 *  the earlier one can still give the role, nothing else. */
export async function startClaim() {
  clearTimeout(timer)
  const me = ++attempt
  mine = null
  set('waiting')
  const current = () => attempt === me && state === 'waiting'
  timer = setTimeout(() => { if (current()) settle('timeout') }, GIVE_UP_MS)
  try {
    await listenOnce() // before the browser opens, so a fast answer is never missed
    const url = await invoke<string>('xtra_role_claim_start')
    if (!current()) return
    mine = new URL(url).searchParams.get('state')
    if (mine) { recent.push(mine); if (recent.length > 5) recent.shift() }
    await openUrl(url)
  } catch (e) {
    if (current()) settle(String(e).includes('not set up') ? 'unset' : 'error')
  }
}

let checked = false
/** Once: a build without the Worker's address says so before any click, and the button stays off. */
export function checkReady() {
  if (checked) return
  checked = true
  invoke<boolean>('xtra_role_ready').then(ok => { if (!ok && state === 'idle') set('unset') }).catch(() => { checked = false })
}

/** Where the claim stands, for the card. */
export const useClaim = () => useSyncExternalStore(f => { subscribers.add(f); return () => { subscribers.delete(f) } }, () => state, () => 'unset' as ClaimState)

if (import.meta.env.DEV) {
  console.assert(claimText('waiting') === 'Finish in your browser…', 'the click answers at once')
  console.assert(claimText('ok') === null &&claimText('not_member') === 'Join the server first, then claim again.', 'ok and not a member')
  console.assert(claimText('denied') === 'Nothing changed. Try again any time.', 'denied')
  console.assert(claimText('error') === AGAIN && claimText('timeout') === AGAIN, 'an error and the timeout read alike')
  console.assert(claimText('idle') === 'Get the repakxtra user role in this server.', 'before a click: which role, in which server')
  console.assert(fromResult('ok') === 'ok' && fromResult('denied') === 'denied' && fromResult('admin') === 'error', 'results map, unknown is an error')
  console.assert(GIVE_UP_MS === 300_000, 'gives up after 5 minutes')
  console.assert(answers({ state: 'b', result: 'denied' }, 'waiting', 'b', ['a', 'b']), 'this claim\'s answer settles it')
  console.assert(answers({ state: 'a', result: 'ok' }, 'waiting', 'b', ['a', 'b']), 'an earlier tab that gave the role counts')
  console.assert(!answers({ state: 'a', result: 'denied' }, 'waiting', 'b', ['a', 'b']), 'an earlier tab\'s other answers do not')
  console.assert(answers({ state: 'b', result: 'ok' }, 'timeout', 'b', ['b']) && answers({ state: 'b', result: 'denied' }, 'timeout', 'b', ['b']), 'late answers still land')
  console.assert(!answers({ state: 'b', result: 'ok' }, 'ok', 'b', ['b']), 'nothing to change once claimed')
  console.assert(!answers({ state: 'x', result: 'ok' }, 'waiting', 'b', ['b']), 'never a claim this session did not make')
  console.assert(!answers({ state: 'b', result: 'denied' }, 'not_member', 'b', ['b']), 'a settled answer is not replaced by another')
  console.assert(!(['waiting', 'ok', 'not_member', 'denied', 'error', 'timeout', 'unset'] as ClaimState[]).some(s => /[;\u2014]/.test(claimText(s) ?? '')), 'no semicolons or em dashes')
}
