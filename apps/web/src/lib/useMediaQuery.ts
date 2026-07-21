'use client'

import { useCallback, useSyncExternalStore } from 'react'

/**
 * The phone breakpoint — must match the `@media (max-width: 640px)` blocks in
 * globals.css so JS defaults (legend collapsed, layers behind a button) flip
 * at the same width as the CSS.
 */
export const NARROW_QUERY = '(max-width: 640px)'

/**
 * Reactive media-query match. Nothing is persisted — the value tracks the
 * live viewport only, so defaults derived from it are resize-safe by
 * construction. Static prerender sees `false` (the wide default); hydration
 * corrects it synchronously before paint.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    [query]
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  )
}
