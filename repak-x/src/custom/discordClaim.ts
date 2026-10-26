// repakxtra: Claim role on cable's Discord card (CableDiscord.tsx, xtra_role.rs). The click says "Finish in your browser"
// at once, opens Discord's consent page, and waits for the browser's answer, which comes back through a repakx:// link
// (no polling). Consent pages wait on the member, so it gives up after 5 minutes.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openUrl } from '@tauri-apps/plugin-shell'

export type ClaimState = 'idle' | 'waiting' | 'ok' | 'not_member' | 'denied' | 'error' | 'timeout' | 'unset'

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

/** Starts a claim and reports each state. Resolves with the final one. */
export function claimRole(report: (state: ClaimState) => void): Promise<ClaimState> {
  report('waiting')
  return new Promise<ClaimState>(resolve => {
    let done = false
    let stop = () => {}
    const finish = (s: ClaimState) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stop()
      report(s)
      resolve(s)
    }
    const timer = setTimeout(() => finish('timeout'), GIVE_UP_MS)
    // listening before the browser opens, so a fast answer is never missed
    listen<string>('xtra-role-claimed', e => finish(fromResult(e.payload)))
      .then(un => { if (done) un(); else stop = un })
      .then(() => invoke<string>('xtra_role_claim_start'))
      .then(url => openUrl(url))
      .catch(e => finish(String(e).includes('not set up') ? 'unset' : 'error'))
  })
}

if (import.meta.env.DEV) {
  console.assert(claimText('waiting') === 'Finish in your browser...', 'the click answers at once')
  console.assert(claimText('ok') === 'Done. You have the role.' && claimText('not_member') === 'Join the server first, then claim again.', 'ok and not a member')
  console.assert(claimText('denied') === 'Nothing changed. Try again any time.', 'denied')
  console.assert(claimText('error') === AGAIN && claimText('timeout') === AGAIN, 'an error and the timeout read alike')
  console.assert(claimText('idle') === null, 'nothing shows before a click')
  console.assert(fromResult('ok') === 'ok' && fromResult('denied') === 'denied' && fromResult('admin') === 'error', 'results map, unknown is an error')
  console.assert(GIVE_UP_MS === 300_000, 'gives up after 5 minutes')
  console.assert(!(['waiting', 'ok', 'not_member', 'denied', 'error', 'timeout', 'unset'] as ClaimState[]).some(s => /[;—]/.test(claimText(s) ?? '')), 'no semicolons or em dashes')
}
