import { useEffect } from 'react';

// repakxtra: one tooltip node at a time, so it keeps a stable id the target can point aria-describedby at
const TOOLTIP_ID = 'global-tooltip';

/** aria-describedby with `id` added or removed, the other ids kept in order. Pure. */
export const withToken = (value: string | null, id: string, on: boolean) => {
  const ids = (value ?? '').split(/\s+/).filter(t => t && t !== id);
  if (on) ids.push(id);
  return ids.join(' ');
};

// Registered at import, before any component's effect, so it runs ahead of every dialog's own window Escape listener
let onEscape: ((e: KeyboardEvent) => void) | null = null;
window.addEventListener('keydown', e => onEscape?.(e), true);

/**
 * Hook to enhance native browser tooltips with custom styled tooltips
 * Intercepts title attributes and shows custom tooltips instead
 * repakxtra: also on keyboard focus, with role="tooltip", aria-describedby and Escape (U16)
 */
export const useGlobalTooltips = () => {
  useEffect(() => {
    let activeTooltip: HTMLDivElement | null = null;
    let showTimeout: ReturnType<typeof setTimeout> | null = null;
    let currentTarget: HTMLElement | null = null;
    // Escape or a click hid this one's tooltip: it stays hidden until the pointer and focus leave it
    let dismissed: HTMLElement | null = null;
    let removalWatch: MutationObserver | null = null;

    const titled = (node: EventTarget | null) =>
      node instanceof Element ? node.closest<HTMLElement>('[title], [data-original-title]') : null;
    const keyboardFocusIn = (el: HTMLElement) => {
      const a = document.activeElement;
      return !!a && el.contains(a) && a.matches(':focus-visible');
    };

    // Takes the native title off (so the browser's own tooltip stays away) while keeping the element's name
    const stash = (target: HTMLElement) => {
      const title = target.getAttribute('title') ?? '';
      target.setAttribute('data-original-title', title);
      target.removeAttribute('title');
      const named = target.hasAttribute('aria-label') || target.hasAttribute('aria-labelledby') || !!target.textContent?.trim();
      if (!named && title) {
        target.setAttribute('aria-label', title);
        target.setAttribute('data-tooltip-label', '');
      }
    };

    const restoreTitle = (target: HTMLElement | null) => {
      if (!target) return;
      const originalTitle = target.getAttribute('data-original-title');
      target.removeAttribute('data-original-title');
      // React may have written a newer title meanwhile: that one wins
      if (originalTitle && !target.hasAttribute('title')) target.setAttribute('title', originalTitle);
      if (target.hasAttribute('data-tooltip-label')) {
        target.removeAttribute('aria-label');
        target.removeAttribute('data-tooltip-label');
      }
      const described = withToken(target.getAttribute('aria-describedby'), TOOLTIP_ID, false);
      if (described) target.setAttribute('aria-describedby', described);
      else target.removeAttribute('aria-describedby');
    };

    const createTooltip = (text: string, targetRect: DOMRect): HTMLDivElement => {
      const tooltip = document.createElement('div');
      tooltip.className = 'global-tooltip';
      tooltip.id = TOOLTIP_ID;
      tooltip.setAttribute('role', 'tooltip');
      tooltip.textContent = text;
      tooltip.style.visibility = 'hidden'; // Hide while measuring
      document.body.appendChild(tooltip);

      // Force layout to get accurate dimensions
      tooltip.offsetHeight;

      // Position tooltip
      const tooltipRect = tooltip.getBoundingClientRect();
      const viewportWidth = window.innerWidth;

      // Default to top placement
      let top = targetRect.top - tooltipRect.height - 8;
      let left = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;

      tooltip.style.visibility = ''; // Show after positioning

      // Adjust if tooltip goes off screen
      if (top < 8) {
        // Show below if no space above
        top = targetRect.bottom + 8;
        tooltip.setAttribute('data-placement', 'bottom');
      } else {
        tooltip.setAttribute('data-placement', 'top');
      }

      if (left < 8) {
        left = 8;
      } else if (left + tooltipRect.width > viewportWidth - 8) {
        left = viewportWidth - tooltipRect.width - 8;
      }

      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${left}px`;

      // Trigger animation
      requestAnimationFrame(() => {
        tooltip.classList.add('visible');
      });

      return tooltip;
    };

    const removeTooltip = () => {
      removalWatch?.disconnect();
      removalWatch = null;
      if (!activeTooltip) return;
      const tooltipToRemove = activeTooltip;
      activeTooltip = null;
      // The leaving one gives up the id, so the next tooltip's id is never doubled while this fades
      tooltipToRemove.removeAttribute('id');
      tooltipToRemove.classList.remove('visible');
      setTimeout(() => {
        if (tooltipToRemove.parentNode) {
          tooltipToRemove.parentNode.removeChild(tooltipToRemove);
        }
      }, 200);
    };

    const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
      if (timer !== null) {
        clearTimeout(timer);
      }
    };

    /** Hide the tooltip and give the current target its title back. */
    const stop = () => {
      clearTimer(showTimeout);
      removeTooltip();
      restoreTitle(currentTarget);
      currentTarget = null;
    };

    const start = (target: HTMLElement) => {
      if (target === currentTarget || target === dismissed || target.hasAttribute('data-no-global-tooltip')) return;
      const title = target.getAttribute('title');
      if (!title) return;

      // If moving to another tooltip target, restore previous title and clear old tooltip
      stop();
      currentTarget = target;
      stash(target);

      showTimeout = setTimeout(() => {
        if (currentTarget !== target || !target.isConnected) return;
        removeTooltip();
        activeTooltip = createTooltip(title, target.getBoundingClientRect());
        // A name that already says it (taken from the title, or the same aria-label): no description that repeats it
        if (!target.hasAttribute('data-tooltip-label') && target.getAttribute('aria-label') !== title) {
          target.setAttribute('aria-describedby', withToken(target.getAttribute('aria-describedby'), TOOLTIP_ID, true));
        }
        // The target can unmount under the tooltip (a dialog closing on Enter): take the tooltip with it
        removalWatch = new MutationObserver(() => { if (!target.isConnected) stop(); });
        removalWatch.observe(document.body, { childList: true, subtree: true });
      }, 500); // 500ms delay like native tooltips
    };

    const handleMouseEnter = (e: MouseEvent) => {
      // Moving across the target's own icons and SVG parts keeps the one tooltip
      if (currentTarget && e.target instanceof Node && currentTarget.contains(e.target) && titled(e.target) === currentTarget) return;
      const target = titled(e.target);
      if (target) start(target);
    };

    const handleMouseLeave = (e: MouseEvent) => {
      const related = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (dismissed && !(related && dismissed.contains(related)) && !keyboardFocusIn(dismissed)) dismissed = null;
      if (!currentTarget) return;
      // Ignore transitions within the same tooltip target subtree
      if (related && currentTarget.contains(related)) return;
      // Keyboard focus still on it: the tooltip stays for the focus
      if (keyboardFocusIn(currentTarget)) return;
      stop();
    };

    const handleFocusIn = (e: FocusEvent) => {
      const el = e.target;
      if (!(el instanceof Element) || !el.matches(':focus-visible')) return; // a click's focus shows nothing extra
      const target = titled(el);
      if (target) start(target);
    };

    const handleFocusOut = (e: FocusEvent) => {
      const related = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (dismissed && !(related && dismissed.contains(related)) && !dismissed.matches(':hover')) dismissed = null;
      if (!currentTarget || (related && currentTarget.contains(related))) return;
      if (currentTarget.matches(':hover')) return; // the pointer still holds it
      stop();
    };

    const handleMouseDown = () => {
      dismissed = currentTarget;
      stop();
    };

    // Escape hides a shown tooltip and nothing else: the dialog around it stays open
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !activeTooltip) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      dismissed = currentTarget;
      stop();
    };

    const handleViewportChange = () => {
      stop();
    };

    // Add event listeners
    document.addEventListener('mouseover', handleMouseEnter, true);
    document.addEventListener('mouseout', handleMouseLeave, true);
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('focusout', handleFocusOut, true);
    onEscape = handleKeyDown;
    window.addEventListener('blur', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange);

    // Cleanup
    return () => {
      document.removeEventListener('mouseover', handleMouseEnter, true);
      document.removeEventListener('mouseout', handleMouseLeave, true);
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('focusout', handleFocusOut, true);
      if (onEscape === handleKeyDown) onEscape = null;
      window.removeEventListener('blur', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('resize', handleViewportChange);
      stop();
    };
  }, []);
};

if (import.meta.env.DEV) {
  console.assert(withToken('help other', TOOLTIP_ID, true) === `help other ${TOOLTIP_ID}`, 'the tooltip id joins existing descriptions')
  console.assert(withToken(`help ${TOOLTIP_ID} other`, TOOLTIP_ID, false) === 'help other', 'removing it keeps the others')
  console.assert(withToken(`${TOOLTIP_ID}`, TOOLTIP_ID, true) === TOOLTIP_ID, 'never added twice')
  console.assert(withToken(null, TOOLTIP_ID, false) === '', 'no attribute stays empty')
}
