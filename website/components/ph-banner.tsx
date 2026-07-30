import { PHBannerDismiss } from '@/components/ph-banner-dismiss'

// The Product Hunt launch link. Update if the canonical post URL changes.
const PH_URL = 'https://www.producthunt.com/products/tinbase'

/**
 * Site-wide "Product Hunt Launch" announcement strip, rendered above the sticky
 * nav from the root layout. A warm orange→red gradient with a Vote Now CTA.
 * Dismissal is remembered in localStorage and applied before paint by the
 * inline script in layout.tsx (which toggles `data-ph-dismissed` on <html>), so
 * a dismissed banner never flashes — the CSS rule in globals.css hides
 * `.ph-banner` when that attribute is set.
 */
export function PHBanner() {
  return (
    <div className="ph-banner relative bg-[#da552f] text-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 py-1 pl-4 pr-9 sm:px-6">
        <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
          <span aria-hidden="true">🎁</span>
          <span aria-hidden="true">🚀</span>
          <span className="truncate">Product Hunt Launch!</span>
        </p>
        <a
          href={PH_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/30 bg-white/15 px-2.5 py-0 text-xs font-semibold leading-5 text-white transition-colors hover:bg-white/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-2.5" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <path d="M15 3h6v6M10 14 21 3" />
          </svg>
          Vote Now
        </a>
      </div>
      <PHBannerDismiss />
    </div>
  )
}
