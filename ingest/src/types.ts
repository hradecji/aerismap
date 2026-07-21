import type { SourceStatus, StationProperties } from '@aerismap/shared'

/**
 * A station as produced by a source adapter: coordinates plus every
 * StationProperties field except the ones derived at snapshot-build time
 * (observedAt, stale, eaqi, eaqiPollutant — see snapshot.ts).
 */
export interface StationDraft {
  lon: number
  lat: number
  properties: Omit<StationProperties, 'observedAt' | 'stale' | 'eaqi' | 'eaqiPollutant'>
}

/** What every source adapter returns — a failed source is `status.ok === false` with no stations. */
export interface SourceResult {
  status: SourceStatus
  stations: StationDraft[]
}

/**
 * SourceStatus plus ingest-local reporting kept out of the shared contract
 * (the worker and web app only read the shared fields; extras in meta.json
 * are harmless).
 */
export interface IngestSourceStatus extends SourceStatus {
  /** Stations carried forward from the previous snapshot because this source failed. */
  carriedForward?: number
}
