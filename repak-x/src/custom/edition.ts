// Fixed by Vite at build time, never by localStorage or an app setting.
export const EXTENDED = import.meta.env.VITE_REPAKXTRA_EDITION === 'extended'
export const EDITION = EXTENDED ? 'extended' : 'standard'
export const APP_NAME = EXTENDED ? 'repakxploit' : 'repakxtra'
if (typeof document !== 'undefined') document.documentElement.dataset.edition = EDITION
if (typeof document !== 'undefined') document.title = APP_NAME
export const RELEASE_PREFIX = EXTENDED ? 'extended-v' : 'v'
export const LOADER_NAME = EXTENDED ? 'Project Sigeon' : 'Project Galacta'
export const LOADER_PAK = EXTENDED ? '!ProjectSigeon_9999999_P.pak' : '!ProjectGalacta_9999999_P.pak'
