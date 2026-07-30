'use client'

/**
 * Close button for the Product Hunt banner. Persists the dismissal in
 * localStorage and sets `data-ph-dismissed` on <html> so the CSS rule in
 * globals.css hides the banner immediately — no unmount, no layout jank. The
 * same attribute is applied pre-paint on later visits by the inline script in
 * layout.tsx.
 */
export function PHBannerDismiss() {
  const dismiss = () => {
    try {
      localStorage.setItem('ph-banner-dismissed', '1')
    } catch {
      /* storage blocked — still hides for this session */
    }
    document.documentElement.setAttribute('data-ph-dismissed', '1')
  }

  return (
    <button
      type="button"
      onClick={dismiss}
      aria-label="Dismiss Product Hunt announcement"
      className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/20 hover:text-white"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  )
}
