// repakxtra: a link to a mod's Nexus Mods page, for mods installed from Nexus (their source, nexusSource.tsx). It opens
// in the browser.
export const pageUrl = (id: number) => `https://www.nexusmods.com/marvelrivals/mods/${id}`
const openOutside = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))
export const openNexusPage = (modId: number) => openOutside(pageUrl(modId))
