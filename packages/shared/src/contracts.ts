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

/**
 * KV keys written by ingest (Cloudflare KV REST API) and read by the worker
 * (KV binding). KV was chosen over R2 so the whole stack stays on the
 * card-free Workers Free plan (decision 2026-07-21); artifacts measure
 * ~0.4 MB gz total against KV's 25 MiB/value and 1 GB/namespace caps.
 */
export const STORE_KEYS = {
  stations: 'latest/stations.geojson.gz',
  areas: 'latest/areas.json.gz',
  tempIsobands: 'latest/temp-isobands.geojson.gz',
  aqiGrid: 'latest/aqi-grid.geojson.gz',
  meta: 'latest/meta.json',
} as const

/**
 * KV per-key metadata written by ingest alongside each value; the worker
 * serves ETag/Content-Length from it (KV has no native object metadata).
 */
export interface StoreMetadata {
  /** Strong ETag: sha-256 hex of the stored bytes, unquoted. */
  etag: string
  /** Stored byte length (the gzipped size for .gz keys). */
  size: number
  contentType: string
  contentEncoding?: 'gzip'
}

export const API_PATHS = {
  stations: '/api/v1/stations',
  areas: '/api/v1/areas',
  tempIsobands: '/api/v1/layers/temperature',
  aqiGrid: '/api/v1/layers/aqi-model',
  meta: '/api/v1/meta',
} as const

/**
 * NUTS boundary GeoJSONs served as immutable static assets (not from KV).
 * Prepared once by ingest/scripts/prepare-boundaries.ts from Eurostat GISCO
 * NUTS-2024 1:20M (plus the NUTS-2021 UK splice); properties kept per
 * feature: NUTS_ID, LEVL_CODE, NAME_LATN, CNTR_CODE. MapLibre joins area
 * values via promoteId: 'NUTS_ID'.
 */
export const BOUNDARY_ASSETS = {
  nuts2: '/boundaries/nuts2.geojson',
  nuts3: '/boundaries/nuts3.geojson',
} as const

/**
 * Spatial-QC rule (empirically validated 2026-07-21 against live data by two
 * independent evaluations + judge; see plan §5.6): a PM reading is flagged
 * when it exceeds ratioThreshold × the median of same-pollutant readings
 * from other stations within radiusKm AND exceeds floorUgM3. Stations with
 * fewer than minNeighbors candidates are unflaggable (no evidence either way).
 */
export const QC_RULE = {
  radiusKm: 50,
  minNeighbors: 3,
  ratioThreshold: 4,
  floorUgM3: 25,
  params: ['pm2_5', 'pm10'] as const,
} as const

/**
 * Graduated region gating (decided 2026-07-21, replacing the hard ≥3-station
 * cliff): a QC-passed reading from even a single station may color a region
 * in the low bands, but severe bands demand corroboration — one sensor may
 * say "fine", never "emergency".
 */
export function regionBandAllowed(band: EaqiBandLike, cnt: number): boolean {
  return cnt >= 2 || band <= 3
}
type EaqiBandLike = 1 | 2 | 3 | 4 | 5 | 6

/** Opacity anchor: regions reach full confidence rendering at this count. */
export const AREA_FULL_CONFIDENCE_STATIONS = 3
/** With exactly two stations, band from the MIN of the two (one liar can't paint a region). */
export const AREA_TWO_STATION_RULE = 'min' as const
/** Hotspot promotion: band ≥ 4, reading unflagged, corroborated within one band (or reference-kind). */
export const HOTSPOT_MIN_BAND = 4

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
    /** Stations with ≥1 spatial-QC-flagged reading (see QC_RULE; absent before QC mode). */
    qcFlaggedStations?: number
    /** Stations promoted to corroborated hotspots (see HOTSPOT_MIN_BAND). */
    hotspots?: number
  }
  sources: SourceStatus[]
  attribution: Attribution[]
}

/** Pollutants/params aggregated per region (medians in AreaStats.med). */
export const AREA_PARAMS = ['pm2_5', 'pm10', 'no2', 'o3', 'so2', 'temperature', 'humidity'] as const
export type AreaParam = (typeof AREA_PARAMS)[number]

/**
 * Hourly per-region aggregate. Semantics (updated 2026-07-21 with QC +
 * graduated gating): per-pollutant MEDIAN across included stations (stale
 * stations, qc-flagged readings, and pmHumidityBias PM excluded; coarsened
 * coordinates included), each median banded with eaqi-2025; band eligibility
 * per pollutant follows regionBandAllowed (cnt ≥ 2 always, a single station
 * only for bands ≤ 3), with exactly two stations banding from the MIN of the
 * pair; region band = worst eligible pollutant.
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
