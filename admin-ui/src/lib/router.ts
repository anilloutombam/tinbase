/**
 * Tiny history router for the studio SPA — no dependency, instant swaps.
 *
 * Routes are `/_/<tab>[/<section>]` (or `/<tab>[/<section>]` in vite dev):
 * the dashboard lives at `/_/`, pages at `/_/table`, and pages with inner
 * navigation expose their section as a second segment (`/_/database/functions`,
 * `/_/table/posts`). The server serves the app shell for every `/_/*` route,
 * so deep links, refresh, and back/forward all work.
 *
 * @module
 */
import { useSyncExternalStore } from 'react'
import { NAV_SECTIONS, type Tab } from '../components/layout/nav'

/**
 * Current path, read from `document.URL` rather than `window.location.pathname`.
 *
 * They agree under normal hosting. They differ when the studio is embedded in a
 * document whose location it does not control — a `blob:` iframe, which is how
 * Lifo previews an in-VM tinbase without a service worker. `window.location` is
 * [Unforgeable], so an embedder cannot virtualize it; `document.URL` is a plain
 * getter on Document.prototype, so an embedder can. Reading through it costs
 * nothing here and makes the studio embeddable.
 */
function currentPath(): string {
  try {
    return new URL(document.URL).pathname
  } catch {
    return window.location.pathname
  }
}

const PREFIX = currentPath().startsWith('/_') ? '/_' : ''
const TAB_IDS = new Set<string>(NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.id)))

export interface Route {
  tab: Tab
  /** second path segment — page-defined (sub-page id, table name, …) */
  section: string | null
}

function parse(): Route {
  const segs = currentPath().slice(PREFIX.length).split('/').filter(Boolean)
  const tab = TAB_IDS.has(segs[0]) ? (segs[0] as Tab) : 'home'
  const section = segs[1] ? decodeURIComponent(segs[1]) : null
  return { tab, section }
}

/** Builds the URL path for a tab (+ optional section). */
export function pathFor(tab: Tab, section?: string | null): string {
  if (tab === 'home') return `${PREFIX}/`
  return section ? `${PREFIX}/${tab}/${encodeURIComponent(section)}` : `${PREFIX}/${tab}`
}

/* ── store ── */

let current: Route = parse()
const listeners = new Set<() => void>()

function refresh() {
  const next = parse()
  if (next.tab !== current.tab || next.section !== current.section) {
    current = next
    listeners.forEach((l) => l())
  }
}

window.addEventListener('popstate', refresh)

/**
 * Navigates to a tab (+ optional section). `replace` swaps the current history
 * entry instead of pushing — use for state-sync (e.g. selected table) so the
 * back button isn't flooded.
 */
export function navigate(tab: Tab, section: string | null = null, opts: { replace?: boolean } = {}): void {
  const p = pathFor(tab, section)
  if (currentPath() !== p) {
    if (opts.replace) window.history.replaceState(null, '', p)
    else window.history.pushState(null, '', p)
  }
  refresh()
}

/** The current route, live across pushState/popstate. */
export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current
  )
}
