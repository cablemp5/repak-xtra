import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

type Portrait = { hero: string; logo: string }

/** Game logos for KO mods. Blob URLs belong to this install dialog, not the saved loadout. */
export function useKoPortraits(mods: readonly { path: string }[]) {
  const [portraits, setPortraits] = useState<Record<string, Portrait>>({})
  useEffect(() => {
    let live = true
    const urls: string[] = []
    setPortraits({})
    for (const mod of mods) {
      void invoke<Portrait | null>('xtra_ko_portrait', { modPath: mod.path }).then(async portrait => {
        if (!portrait || !live) return
        const bytes = await invoke<ArrayBuffer>('xtra_ko_file', { path: portrait.logo })
        if (!live) return
        const logo = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        urls.push(logo)
        setPortraits(previous => ({ ...previous, [mod.path]: { hero: portrait.hero, logo } }))
      }).catch(e => console.warn('[KO portrait]', e))
    }
    return () => { live = false; urls.forEach(url => URL.revokeObjectURL(url)) }
  }, [mods])
  return portraits
}
