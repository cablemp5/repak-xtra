// repakxtra: what `lucide-react` resolves to while set.ts says 'lucide' (vitePlugin.ts): Lucide itself, with the shield and
// warning icons swapped for the game's artwork (rivals.tsx). Local exports win over `export *`.
export * from 'lucide-react'
export { Shield, ShieldCheck, ShieldOff, TriangleAlert, AlertTriangle } from './rivals'
