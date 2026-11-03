// repakxtra: the beta notice, on the welcome screen's first page and at the top of Settings > General.
import { APP_NAME } from './edition'
import mark from './beta-mark.png'

export default function BetaNote({ className = '' }: { className?: string }) {
  return (
    <p className={`beta-note${className ? ` ${className}` : ''}`}>
      <span className="beta-mark" style={{ maskImage: `url(${mark})`, WebkitMaskImage: `url(${mark})` }} aria-hidden="true" />
      <span>{APP_NAME} is currently in beta, so unexpected issues may occur. Please report them if they have not been reported yet.
        You can report bugs and suggest features in cable's Discord server.</span>
    </p>
  )
}
