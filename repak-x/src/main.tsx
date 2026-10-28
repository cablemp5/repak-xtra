import './custom/storageCarryOver' // repakxtra: settings saved under the old key prefix, before any module reads them
import './custom/devStorage' // repakxtra: the dev copy loads the app's saved loadouts; the app keeps that copy
import './custom/buildMark' // repakxtra: test and dev copies color every window's taskbar icon
import './dev/mockBackend' // repakxtra: fake backend for the browser preview, inert in the app
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ExtendedAccess from './custom/ExtendedAccess'
import VfxUpdaterWindow from './custom/vfx/VfxUpdaterWindow' // repakxtra: in place of the upstream VFX Updater's page
import EncryptWindow from './custom/EncryptWindow' // repakxtra
import AssetExplorerPage from './modules/asset-explorer/AssetExplorerPage'
import './custom/theme.css' // repakxtra: theme for every window, last so it wins the cascade
import './custom/uiPrefs' // repakxtra: UI scale and optional controls in every window

// Disable default browser context menu
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element #root not found')
}

// Secondary windows share this bundle and are told apart by their route.
// Adding one here also means adding it to SECONDARY_WINDOW_ROUTES in
// index.html, which is what dismisses the splash overlay for them.
const SECONDARY_WINDOWS: { route: string; view: () => JSX.Element }[] = [
  { route: 'vfx-updater', view: () => <VfxUpdaterWindow /> }, // repakxtra
  { route: '/encrypt', view: () => <EncryptWindow /> }, // repakxtra
  { route: 'asset-explorer', view: () => <AssetExplorerPage /> },
]

const secondary = SECONDARY_WINDOWS.find(w => window.location.href.includes(w.route))
const rootView = secondary ? secondary.view() : <App />

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ExtendedAccess>{rootView}</ExtendedAccess>
  </React.StrictMode>,
)
