// repakxtra: one run of a slow read at a time (the mods-folder listing, App.tsx listMods). A call while one runs shares
// the single rerun that starts when it ends, because the running one may have begun before the caller's change. So a
// burst of calls runs the work twice at most, where each call used to run it again.
export function oneAtATime<T>(work: () => Promise<T>): () => Promise<T> {
  let busy: { now: Promise<T>; next: Promise<T> | null } | null = null
  const run = (): Promise<T> => {
    if (busy) return (busy.next ??= busy.now.then(run, run))
    const now: Promise<T> = work().finally(() => { if (busy?.now === now) busy = null })
    busy = { now, next: null }
    return now
  }
  return run
}

if (import.meta.env.DEV) void (async () => {
  let runs = 0
  const end: ((fail?: boolean) => void)[] = []
  const read = oneAtATime(() => new Promise<number>((ok, fail) => { const n = ++runs; end.push(bad => (bad ? fail(n) : ok(n))) }))
  const a = read(), b = read(), c = read()
  console.assert(runs === 1 && b === c && a !== b, 'calls during a run share one rerun, which waits for the run to end')
  end[0]()
  console.assert(await a === 1 && runs === 2, 'the rerun starts when the run ends')
  end[1](true)
  console.assert(await b.catch(n => -n) === -2 && runs === 2, 'the rerun is its callers\' result, also when it fails')
  const d = read(), e = read()
  console.assert(runs === 3 && d !== e, 'a call after a run ended starts its own')
  end[2](true)
  await d.catch(() => 0)
  end[3]()
  console.assert(await e === 4 && runs === 4, 'a failed run still lets the waiting rerun start')
})()
