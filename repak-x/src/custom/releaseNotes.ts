import { RELEASE_PREFIX } from './edition'

type Release = { tag_name?: string; body?: unknown; draft?: boolean }
const API = 'https://api.github.com/repos/cablemp5/repak-xtra/releases'

/** Notes for this installed version and edition; never fall back to another edition or version. */
export async function installedReleaseNotes(version: string, prefix = RELEASE_PREFIX, request: typeof fetch = fetch): Promise<string> {
  const tag = `${prefix}${version.replace(/^v/, '')}`
  const headers = { Accept: 'application/vnd.github.v3+json' }
  const notes = (release: Release | null) => !release?.draft && release?.tag_name === tag && typeof release.body === 'string' ? release.body : ''
  const direct = await request(`${API}/tags/${encodeURIComponent(tag)}`, { headers })
  if (direct.ok) {
    const body = notes(await direct.json())
    if (body) return body
  }
  const fallback = await request(`${API}?per_page=30`, { headers })
  if (!fallback.ok) return ''
  const releases: Release[] = await fallback.json()
  return notes(releases.find(release => !release.draft && release.tag_name === tag) ?? null)
}
