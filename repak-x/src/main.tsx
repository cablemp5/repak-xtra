import './custom/storageCarryOver' // repakxtra: settings saved under the old key prefix, before any module reads them
import './custom/devStorage' // repakxtra: the dev copy loads the app's saved loadouts; the app keeps that copy
import './custom/buildMark' // repakxtra: test and dev copies color every window's taskbar icon
import './dev/mockBackend' // repakxtra: fake backend for the browser preview, inert in the app
import React, { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// repakxtra: each secondary window's code loads only in that window, so the main window never parses it
const VfxUpdaterWindow = lazy(() => import('./custom/vfx/VfxUpdaterWindow')) // repakxtra: in place of the upstream VFX Updater's page
const EncryptWindow = lazy(() => import('./custom/EncryptWindow')) // repakxtra
const GalactaWindow = lazy(() => import('./custom/GalactaWindow')) // repakxtra
import StartedOk from './custom/startedOk' // repakxtra: an update keeps its rollback until the window has rendered
const AssetExplorerPage = lazy(() => import('./modules/asset-explorer/AssetExplorerPage'))
import './custom/theme.css' // repakxtra: theme for every window, last so it wins the cascade
import './custom/uiPrefs' // repakxtra: UI scale and optional controls in every window
import './custom/smoothCaret' // repakxtra: the gliding caret in every text field
import './custom/segSlide' // repakxtra: the sliding pill on every segmented bar

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
  { route: '/galacta', view: () => <GalactaWindow /> }, // repakxtra
  { route: 'asset-explorer', view: () => <AssetExplorerPage /> },
]

const secondary = SECONDARY_WINDOWS.find(w => window.location.href.includes(w.route))
const rootView = secondary ? <Suspense fallback={null}>{secondary.view()}</Suspense> : <App />

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {rootView}
    {!secondary && <StartedOk />}{/* repakxtra */}
  </React.StrictMode>,
)
