// repakxtra: repakxtra's own version, bumped for each repakxtra release. The Repak X version it is built on still comes
// from Cargo (get_app_version).
export const REPAKXTRA_VERSION = '0.17.0'

/** Which copy this is. "dev": the live dev copy (dev.ps1, or the browser preview), served by Vite. "test": made with
 *  `build.ps1 -Test`, which sets VITE_REPAKXTRA_TEST for the frontend build. Both mark themselves: the "xtra" in the app
 *  name takes their color (theme.css, :root[data-build]) and the version line says "dev build" or "test build". */
export const BUILD: 'dev' | 'test' | '' = import.meta.env.DEV ? 'dev' : import.meta.env.VITE_REPAKXTRA_TEST === '1' ? 'test' : ''
if (BUILD) document.documentElement.dataset.build = BUILD

/** The header's and Credits' version line: "v0.3.1 by cable" (dev and test copies add "dev build" or "test build"). */
export const versionTag = () => `v${REPAKXTRA_VERSION}${BUILD ? ` ${BUILD} build` : ''} by cable`

/** repakxtra's newest app release (tag v<semver>) from GitHub, or null. Pre-releases count: GitHub's releases/latest
 *  skips them, so the list is read (xtra_update.rs picks the same one). */
export async function latestRelease(): Promise<{ tag_name: string; body?: string } | null> {
  const res = await fetch('https://api.github.com/repos/cablemp5/repak-xtra/releases?per_page=30', { headers: { Accept: 'application/vnd.github.v3+json' } })
  if (!res.ok) return null
  const list: { tag_name: string; body?: string; draft?: boolean }[] = await res.json()
  const parts = (t: string) => t.slice(1).split('.').map(Number)
  const newer = (a: string, b: string) => { const x = parts(a), y = parts(b); const i = x.findIndex((n, k) => n !== y[k]); return i >= 0 && x[i] > y[i] }
  return list.filter(r => !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name)).reduce<typeof list[0] | null>((best, r) => (!best || newer(r.tag_name, best.tag_name) ? r : best), null)
}
