// repakxtra: the Loading Bay launcher's mark (the arrow of its logo, traced), one color like the Steam and Epic icons
// beside it in Settings > Launcher.
export function LoadingBayIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true">
      <path d="M.95 0h10.12l12 12-12 12H.95v-6.12L6.83 12 .95 6.12zM6.83 5.88v12.24L13.66 12z" />
    </svg>
  )
}
