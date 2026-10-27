import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import packageJson from './package.json'
import lucideSwap from './src/custom/icons/vitePlugin' // repakxtra: Lucide icons

export default defineConfig({
  define: {
    '__APP_VERSION__': JSON.stringify(packageJson.version),
  },
  plugins: [
    lucideSwap(),
    {
      name: 'edition-features', enforce: 'pre',
      load(id: string) {
        if (process.env.VITE_REPAKXTRA_EDITION === 'extended' && /[\\/]custom[\\/]LegacySetup\.tsx$/.test(id)) {
          return 'export default function LegacySetup() { return null }'
        }
        if (process.env.VITE_REPAKXTRA_EDITION !== 'extended' && /[\\/]custom[\\/]ExtendedAccess\.tsx$/.test(id)) {
          return 'export default function ExtendedAccess({ children }) { return children }'
        }
        if (process.env.VITE_REPAKXTRA_EDITION !== 'extended' && /[\\/]custom[\\/]SigeonControl\.tsx$/.test(id)) {
          return 'export default function SigeonControl() { return null }'
        }
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'edition.json', source: JSON.stringify({ edition: process.env.VITE_REPAKXTRA_EDITION === 'extended' ? 'extended' : 'standard' }) })
      },
    },
    // repakxtra: the browser-preview mock (src/dev) is empty in the app's build, so none of its local fixtures and
    // preview PNGs get bundled
    { name: 'drop-dev-mock', apply: 'build', enforce: 'pre', load: (id: string) => (/[\/]src[\/]dev[\/]mockBackend\.ts$/.test(id) ? 'export {}' : null) },
    react(),
  ],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // Handle SPA routes for secondary windows
    historyApiFallback: true,
  },
  // Ensure all routes serve index.html
  appType: 'spa',
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: 'dist',
    chunkSizeWarningLimit: 1000, // Increase limit to 1000 kB
  },
})
