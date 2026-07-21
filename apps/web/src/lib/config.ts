/**
 * Base URL for the AerisMap API. Empty string = same-origin, which is the
 * production setup (the Cloudflare Worker serves this static export and
 * /api/v1/* from one host). `NEXT_PUBLIC_*` vars are inlined at build time,
 * so set it when starting dev / building, e.g. against the bundled mock API:
 *
 *   node dev/mock-api.mjs &
 *   NEXT_PUBLIC_API_BASE=http://localhost:8787 pnpm --filter @aerismap/web dev
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? ''

export const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron'

/** Initial camera: Europe. */
export const INITIAL_CENTER: [number, number] = [10, 50]
export const INITIAL_ZOOM = 4

/** meta.generatedAt older than this shows the freshness banner. */
export const META_STALE_MS = 2 * 60 * 60 * 1000

/** While the 'no data yet' card shows, re-check for a first snapshot this often. */
export const EMPTY_REPOLL_MS = 3 * 60 * 1000
