import type { EAQI_BAND_SET } from './eaqi'
import type { SourceId, StationKind } from './types'

/** Ingestion coverage: [minLon, minLat, maxLon, maxLat]. */
export const EUROPE_BBOX = [-25, 34, 45, 72] as const

/** Staleness horizon per station kind, seconds (v1-compatible). */
export const MAX_AGE_SEC = {
  community: 2700,
  reference: 10800,
  model: 10800,
} as const

/** R2 object keys written by ingest and read by the worker. */
export const R2_KEYS = {
  stations: 'latest/stations.geojson.gz',
  areas: 'latest/areas.json.gz',
  tempIsobands: 'latest/temp-isobands.geojson.gz',
  aqiGrid: 'latest/aqi-grid.geojson.gz',
  meta: 'latest/meta.json',
} as const

export const API_PATHS = {
  stations: '/api/v1/stations',
  areas: '/api/v1/areas',
  tempIsobands: '/api/v1/layers/temperature',
  aqiGrid: '/api/v1/layers/aqi-model',
  meta: '/api/v1/meta',
} as const

/**
 * NUTS boundary GeoJSONs served as immutable static assets (not from R2).
 * Prepared once by ingest/scripts/prepare-boundaries.ts from Eurostat GISCO
 * NUTS-2024 1:20M (plus the NUTS-2021 UK splice); properties kept per
 * feature: NUTS_ID, LEVL_CODE, NAME_LATN, CNTR_CODE. MapLibre joins area
 * values via promoteId: 'NUTS_ID'.
 */
export const BOUNDARY_ASSETS = {
  nuts2: '/boundaries/nuts2.geojson',
  nuts3: '/boundaries/nuts3.geojson',
} as const

/** A region is colored only with ≥3 included stations… */
export const AREA_MIN_STATIONS = 3
/** …and only by a pollutant measured by ≥2 of them. */
export const AREA_MIN_POLLUTANT_STATIONS = 2

export interface SourceStatus {
  id: SourceId
  ok: boolean
  /** ISO 8601 UTC of the successful fetch. */
  fetchedAt?: string
  /** Stations contributed to the snapshot. */
  stations?: number
  /** Human-readable error / skip reason when !ok. */
  detail?: string
}

export interface Attribution {
  label: string
  url: string
  license?: string
}

export interface SnapshotMeta {
  /** ISO 8601 UTC when this snapshot finished building. */
  generatedAt: string
  eaqiBandSet: typeof EAQI_BAND_SET
  maxAgeSec: typeof MAX_AGE_SEC
  counts: {
    stations: number
    byKind: Partial<Record<StationKind, number>>
    withEaqi: number
    /** NUTS regions that received a color this run (absent before area mode). */
    areasColored?: number
    /** Total NUTS regions in the published boundary set. */
    areasTotal?: number
  }
  sources: SourceStatus[]
  attribution: Attribution[]
}

/** Pollutants/params aggregated per region (medians in AreaStats.med). */
export const AREA_PARAMS = ['pm2_5', 'pm10', 'no2', 'o3', 'so2', 'temperature', 'humidity'] as const
export type AreaParam = (typeof AREA_PARAMS)[number]

/**
 * Hourly per-region aggregate. Semantics (decided 2026-07-21): per-pollutant
 * MEDIAN across included stations (stale stations excluded; PM readings from
 * pmHumidityBias stations excluded; coarsened-coordinate stations included),
 * each median banded with eaqi-2025, region band = worst pollutant that has
 * ≥ AREA_MIN_POLLUTANT_STATIONS stations; no color below AREA_MIN_STATIONS.
 */
export interface AreaStats {
  /** Region band, absent when below the honesty thresholds. */
  eaqi?: import('./eaqi').EaqiBand
  /** Pollutant driving the band. */
  pollutant?: import('./eaqi').EaqiPollutant
  /** Included stations in the region. */
  n: number
  nRef: number
  nCom: number
  /** Per-param median of included readings, 1 decimal. */
  med?: Partial<Record<AreaParam, number>>
  /** Per-param count of contributing stations. */
  cnt?: Partial<Record<AreaParam, number>>
}

/** Payload of latest/areas.json.gz — one flat map over NUTS-2 AND NUTS-3 ids. */
export interface AreaSnapshot {
  generatedAt: string
  /** Keyed by NUTS_ID (4-char = NUTS-2, 5-char = NUTS-3). */
  areas: Record<string, AreaStats>
}

export const ATTRIBUTIONS: Attribution[] = [
  { label: 'Sensor.Community', url: 'https://sensor.community/', license: 'ODbL-1.0' },
  { label: 'OpenAQ', url: 'https://openaq.org/', license: 'varies by underlying source' },
  { label: 'European Environment Agency (via OpenAQ)', url: 'https://www.eea.europa.eu/' },
  {
    label: 'Open-Meteo · CAMS ENSEMBLE (Copernicus)',
    url: 'https://open-meteo.com/',
    license: 'CC-BY-4.0',
  },
  { label: 'OpenFreeMap · OpenMapTiles © OpenStreetMap contributors', url: 'https://openfreemap.org/' },
  {
    // Mandatory verbatim notice from the Eurostat/GISCO download agreement;
    // must be visible in the map legend/attribution wherever areas render.
    label: '© EuroGeographics for the administrative boundaries',
    url: 'https://ec.europa.eu/eurostat/web/gisco/geodata/statistical-units',
    license: 'non-commercial, attribution required',
  },
]
