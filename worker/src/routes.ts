import { API_PATHS, R2_KEYS } from '@aerismap/shared'

export interface ApiRoute {
  /** R2 object key backing this path. */
  key: string
  contentType: string
  /** Object bytes are stored gzipped; serve with `Content-Encoding: gzip` untouched. */
  gzip: boolean
  /**
   * Milestone that ships this artifact's producer (plan §9). Until then a
   * missing object gets a "planned" 404 detail instead of the transient
   * "try again in a few minutes" one; once ingest publishes the object it
   * serves normally with no code change.
   */
  plannedMilestone?: string
}

export const API_ROUTES: ReadonlyMap<string, ApiRoute> = new Map([
  [API_PATHS.stations, { key: R2_KEYS.stations, contentType: 'application/geo+json', gzip: true }],
  // Area mode (NUTS aggregates) ships with M1: a missing object is transient,
  // not a planned layer.
  [API_PATHS.areas, { key: R2_KEYS.areas, contentType: 'application/json', gzip: true }],
  [
    API_PATHS.tempIsobands,
    {
      key: R2_KEYS.tempIsobands,
      contentType: 'application/geo+json',
      gzip: true,
      plannedMilestone: 'M2',
    },
  ],
  [
    API_PATHS.aqiGrid,
    { key: R2_KEYS.aqiGrid, contentType: 'application/geo+json', gzip: true, plannedMilestone: 'M2' },
  ],
  [API_PATHS.meta, { key: R2_KEYS.meta, contentType: 'application/json', gzip: false }],
])
