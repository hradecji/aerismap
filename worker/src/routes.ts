import { API_PATHS, STORE_KEYS } from '@aerismap/shared'

export interface ApiRoute {
  /** KV key backing this path. */
  key: string
  contentType: string
  /** Stored bytes are gzipped; serve with `Content-Encoding: gzip` untouched. */
  gzip: boolean
  /**
   * Milestone that ships this artifact's producer (plan §9). Until then a
   * missing value gets a "planned" 404 detail instead of the transient
   * "try again in a few minutes" one; once ingest publishes the value it
   * serves normally with no code change.
   */
  plannedMilestone?: string
}

export const API_ROUTES: ReadonlyMap<string, ApiRoute> = new Map([
  [API_PATHS.stations, { key: STORE_KEYS.stations, contentType: 'application/geo+json', gzip: true }],
  // Area mode (NUTS aggregates) ships with M1: a missing value is transient,
  // not a planned layer.
  [API_PATHS.areas, { key: STORE_KEYS.areas, contentType: 'application/json', gzip: true }],
  [
    API_PATHS.tempIsobands,
    {
      key: STORE_KEYS.tempIsobands,
      contentType: 'application/geo+json',
      gzip: true,
      plannedMilestone: 'M2',
    },
  ],
  [
    API_PATHS.aqiGrid,
    { key: STORE_KEYS.aqiGrid, contentType: 'application/geo+json', gzip: true, plannedMilestone: 'M2' },
  ],
  [API_PATHS.meta, { key: STORE_KEYS.meta, contentType: 'application/json', gzip: false }],
])
