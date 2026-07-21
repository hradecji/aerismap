import type { EaqiBand, EaqiPollutant } from './eaqi'

export type StationKind = 'reference' | 'community' | 'model'

export type SourceId = 'sensor-community' | 'openaq' | 'open-meteo' | 'opensensemap'

export const PARAMS = [
  'pm1',
  'pm2_5',
  'pm10',
  'no2',
  'o3',
  'so2',
  'co',
  'temperature',
  'humidity',
  'pressure',
] as const

export type Param = (typeof PARAMS)[number]

/**
 * One measured value. `v` in µg/m³ for all pollutants including co
 * (OpenAQ mass-concentration series; verified against OpenAQ's measurand
 * table: pm10=1, pm25=2, o3=3, co=4, no2=5, so2=6 are µg/m³ — ids 7-10 are
 * the ppm series and must not be used), °C, %, hPa.
 */
export interface Reading {
  v: number
  /** ISO 8601 UTC timestamp of the measurement. */
  ts: string
}

export interface StationProperties {
  /** Stable across runs: `${source}:${nativeId}`. */
  id: string
  source: SourceId
  nativeId: string
  name?: string
  kind: StationKind
  /** ISO 3166-1 alpha-2, when known. */
  country?: string
  /** Licence of this station's data, e.g. 'ODbL-1.0', 'CC-BY-4.0'. */
  license: string
  /** false when the source coarsened the coordinates. */
  exactLocation: boolean
  /** Most recent reading timestamp across params (ISO 8601 UTC). */
  observedAt: string
  /** observedAt older than MAX_AGE_SEC for this kind at build time. */
  stale: boolean
  values: Partial<Record<Param, Reading>>
  eaqi?: EaqiBand
  eaqiPollutant?: EaqiPollutant
  /**
   * Set when a PM reading coincides with co-located relative humidity ≥ 95% —
   * low-cost optical PM sensors over-read in near-saturated air, so the EAQI
   * for this station may be inflated (plan §5.1: flag, don't correct).
   */
  pmHumidityBias?: boolean
}

export interface PointGeometry {
  type: 'Point'
  /** [longitude, latitude], WGS84, ≤5 decimals. */
  coordinates: [number, number]
}

export interface StationFeature {
  type: 'Feature'
  geometry: PointGeometry
  properties: StationProperties
}

export interface StationCollection {
  type: 'FeatureCollection'
  features: StationFeature[]
}
