// repakxtra: Claim role on cable's Discord card (CableDiscord.tsx, xtra_role.rs). The click says "Finish in your browser"
// at once, opens Discord's consent page, and waits for the browser's answer, which comes back through a repakx:// link
// (no polling). Consent pages wait on the member, so it gives up after 5 minutes. The claim lives here, not in the card:
// closing Settings mid-claim keeps it, and reopening shows where it stands. Each answer names its claim's state, so an
// answer to an earlier claim never settles a newer one.
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
    case 'waiting': return 'Finish in your browser...'
    case 'ok': return 'Done. You have the role.'
    case 'not_member': return 'Join the server first, then claim again.'
    case 'denied': return 'Nothing changed. Try again any time.'
    case 'error': case 'timeout': return AGAIN
    case 'unset': return 'Claim role is not set up yet.'
    default: return null
  }
}

/** The answer's state, from the result the browser sent back. Unknown words read as an error. Pure. */
export const fromResult = (result: string): ClaimState => (['ok', 'not_member', 'denied'].includes(result) ? result as ClaimState : 'error')

/** Whether an answer settles the claim in progress: only while waiting, and only for the state this claim opened. Pure. */
export const answers = (a: Answer, waiting: boolean, mine: string | null) => waiting && mine !== null && a.state === mine

let state: ClaimState = 'idle'
let mine: string | null = null // the state token of the claim in progress, known once the backend made it
let attempt = 0
let timer: ReturnType<typeof setTimeout> | undefined
let listening: Promise<unknown> | null = null
const subscribers = new Set<() => void>()
const set = (s: ClaimState) => { state = s; subscribers.forEach(f => f()) }

function settle(s: ClaimState) {
  clearTimeout(timer)
  mine = null
  set(s)
  if (s === 'ok') cue('success', { emphasis: 'subtle' })
}

const listenOnce = () => (listening ??= listen<Answer>('xtra-role-claimed', e => {
  if (answers(e.payload, state === 'waiting', mine)) settle(fromResult(e.payload.result))
}))

/** Starts a claim, unless one is waiting. */
export async function startClaim() {
  if (state === 'waiting') return
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
    await openUrl(url)
  } catch (e) {
    if (current()) settle(String(e).includes('not set up') ? 'unset' : 'error')
  }
}

/** Where the claim stands, for the card. */
export const useClaim = () => useSyncExternalStore(f => { subscribers.add(f); return () => { subscribers.delete(f) } }, () => state)

if (import.meta.env.DEV) {
  console.assert(claimText('waiting') === 'Finish in your browser...', 'the click answers at once')
  console.assert(claimText('ok') === 'Done. You have the role.' && claimText('not_member') === 'Join the server first, then claim again.', 'ok and not a member')
  console.assert(claimText('denied') === 'Nothing changed. Try again any time.', 'denied')
  console.assert(claimText('error') === AGAIN && claimText('timeout') === AGAIN, 'an error and the timeout read alike')
  console.assert(claimText('idle') === null, 'nothing shows before a click')
  console.assert(fromResult('ok') === 'ok' && fromResult('denied') === 'denied' && fromResult('admin') === 'error', 'results map, unknown is an error')
  console.assert(GIVE_UP_MS === 300_000, 'gives up after 5 minutes')
  console.assert(answers({ state: 'b', result: 'ok' }, true, 'b'), 'this claim\'s answer settles it')
  console.assert(!answers({ state: 'a', result: 'ok' }, true, 'b'), 'an earlier claim\'s answer does not')
  console.assert(!answers({ state: 'a', result: 'ok' }, true, null), 'nor one that arrives while the new claim is being made')
  console.assert(!answers({ state: 'b', result: 'ok' }, false, 'b'), 'nor one after it settled')
  console.assert(!(['waiting', 'ok', 'not_member', 'denied', 'error', 'timeout', 'unset'] as ClaimState[]).some(s => /[;\u2014]/.test(claimText(s) ?? '')), 'no semicolons or em dashes')
}
