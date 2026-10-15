// repakxtra: repakxtra's own version, bumped for each repakxtra release. The Repak X version it is built on still comes
// from Cargo (get_app_version).
export const REPAKXTRA_VERSION = '0.2.0'

/** The header's and Credits' version line: "v0.2.0 (RepakX v2.0.1, forked by cable)" */
export const versionTag = (repakx?: string) =>
  repakx ? `v${REPAKXTRA_VERSION} (RepakX v${repakx}, forked by cable)` : `v${REPAKXTRA_VERSION} (forked by cable)`
