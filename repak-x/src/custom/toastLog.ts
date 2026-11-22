// repakxtra: every problem toast (an error or a warning) also lands in the bottom Logs drawer with its whole text. The
// toast keeps a short sentence, and a toast with no action of its own gets Details, which opens the drawer on that line.
import { log } from '../utils/uiLog'

/** window event: open the Logs drawer on the entry whose id is `detail` (LogDrawer.tsx listens) */
export const SHOW_LOG = 'repakxtra:show-log'
export const showLog = (id: string) => window.dispatchEvent(new CustomEvent(SHOW_LOG, { detail: id }))

const SHORT = 120
/** A long description (usually a raw error) cut to its first sentence, or to SHORT characters. Pure. */
export function shortText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= SHORT) return text
  const sentence = flat.match(/^.{20,}?[.!?](?=\s)/)?.[0]
  return sentence && sentence.length <= SHORT ? `${sentence} Details are in Logs.` : `${flat.slice(0, SHORT - 1).trimEnd()}… Details are in Logs.`
}

type Details = { label: string; onClick: () => void }
type ToastLike<A> = { color?: string; title?: string; description?: string; action?: A; isLoading?: boolean; icon?: unknown }
/** Logs a problem toast and returns what the toast shows instead (a short description, a Details action), or null for
 *  any other toast. `dismiss` closes the toast when Details opens Logs. */
export function logProblem<A>(t: ToastLike<A>, dismiss?: () => void): { description?: string; fullText?: string; action: A | Details; logId: string } | null {
  if ((t.color !== 'danger' && t.color !== 'warning') || t.isLoading || t.icon) return null // icon: the crash toast has its own Details
  const text = [t.title, t.description].filter(Boolean).join(': ')
  const logId = log(t.color === 'danger' ? 'error' : 'warn', 'Notice', text)
  return {
    description: typeof t.description === 'string' ? shortText(t.description) : t.description,
    fullText: t.description, // what the caller passed: the same problem again is matched on it (AlertHandler)
    action: t.action ?? { label: 'Details', onClick: () => { dismiss?.(); showLog(logId) } }, // the toast goes: it would cover the line
    logId,
  }
}

if (import.meta.env.DEV) {
  console.assert(shortText('Game folder not found.') === 'Game folder not found.', 'a short text stays')
  const long = `Could not read the mod file. ${'os error 32 '.repeat(30)}`
  console.assert(shortText(long) === 'Could not read the mod file. Details are in Logs.', 'a long one keeps its first sentence', shortText(long))
  console.assert(logProblem({ color: 'success', title: 'x' }) === null && logProblem({ color: 'danger', title: 'x', isLoading: true }) === null, 'only problem toasts that finished')
  console.assert(shortText('x'.repeat(400)).length <= SHORT + 22 && shortText('x'.repeat(400)).endsWith('… Details are in Logs.'), 'no sentence: cut')
}
