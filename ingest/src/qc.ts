import {
  computeEaqi,
  eaqiBandForValue,
  EAQI_POLLUTANTS,
  HOTSPOT_MIN_BAND,
  MAX_AGE_SEC,
  PARAMS,
  QC_RULE,
  type EaqiPollutant,
  type Param,
  type Reading,
  type StationFeature,
} from '@aerismap/shared'

/**
 * Spatial QC + hotspot promotion (QC MODE, validated 2026-07-21 against live
 * data by two independent evaluations + judge — see plan §5.6).
 *
 * QC flag (per QC_RULE, pm2_5/pm10 only): a fresh reading x is flagged when
 * x > ratioThreshold × median(fresh same-pollutant readings of OTHER stations
 * within radiusKm) AND x > floorUgM3, computable only with ≥ minNeighbors
 * neighbors. The ratio-vs-median rule is deliberately single-pass over the
 * raw neighbor pool: two co-broken sensors cannot corroborate each other,
 * because the pool's MEDIAN stays anchored by the clean majority (mutual
 * corroboration was the fatal flaw of the rejected candidate design).
 *
 * Flagged readings stay visible in `values` (popups show them with a warning)
 * but are excluded from the station's EAQI here and from region aggregation
 * in areas.ts. Flags are recomputed from scratch every run — carried-forward
 * stations may arrive holding last run's qc/hotspot properties.
 *
 * Hotspot promotion (HOTSPOT_MIN_BAND): a station whose worst UNFLAGGED
 * fresh pollutant band is ≥ 4 is promoted when it is reference-kind OR at
 * least one neighbor within radiusKm has a fresh, unflagged same-pollutant
 * reading within one EAQI band.
 *
 * Performance: a ~0.5° lat/lon grid-bucket index keeps the 9.6k-station ×
 * 50 km neighborhood sweep well under a second (measured ~100 ms-class,
 * matching the validation scripts' bbox-prefilter approach).
 */

/** Grid cell size, degrees. 0.5° lat ≈ 55 km, so a ±1-cell lat ring covers 50 km. */
const CELL_DEG = 0.5
const KM_PER_DEG_LAT = 110.574
const KM_PER_DEG_LON_EQUATOR = 111.32
const EARTH_RADIUS_KM = 6371
const RAD = Math.PI / 180

export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * RAD
  const dLon = (lon2 - lon1) * RAD
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a))
}

interface GridEntry {
  stationId: string
  lon: number
  lat: number
  v: number
}

/** One grid per pollutant, cells keyed `${floor(lon/CELL)}:${floor(lat/CELL)}`. */
type PollutantGrid = Map<string, GridEntry[]>

const cellKey = (x: number, y: number): string => `${x}:${y}`

/**
 * A reading usable for QC/aggregation this run: present and within the same
 * per-kind freshness horizon the snapshot EAQI and area medians use. A fresh
 * reading implies the station itself is non-stale (observedAt ≥ reading.ts).
 */
function freshReading(feature: StationFeature, param: Param, now: Date): Reading | undefined {
  const reading = feature.properties.values[param]
  if (!reading) return undefined
  const ageSec = (now.getTime() - Date.parse(reading.ts)) / 1000
  return ageSec <= MAX_AGE_SEC[feature.properties.kind] ? reading : undefined
}

/** Index every fresh reading of every EAQI pollutant (QC params are a subset). */
function buildGrids(
  features: readonly StationFeature[],
  now: Date
): Map<EaqiPollutant, PollutantGrid> {
  const grids = new Map<EaqiPollutant, PollutantGrid>()
  for (const pollutant of EAQI_POLLUTANTS) grids.set(pollutant, new Map())
  for (const feature of features) {
    const [lon, lat] = feature.geometry.coordinates
    const key = cellKey(Math.floor(lon / CELL_DEG), Math.floor(lat / CELL_DEG))
    for (const pollutant of EAQI_POLLUTANTS) {
      const reading = freshReading(feature, pollutant, now)
      if (!reading) continue
      const grid = grids.get(pollutant)!
      const cell = grid.get(key)
      const entry: GridEntry = { stationId: feature.properties.id, lon, lat, v: reading.v }
      if (cell) cell.push(entry)
      else grid.set(key, [entry])
    }
  }
  return grids
}

/**
 * Fresh same-pollutant entries of OTHER stations within radiusKm (haversine).
 * The lon cell span widens with latitude so high-latitude lookups stay correct.
 */
function neighborsWithin(
  grid: PollutantGrid,
  selfId: string,
  lon: number,
  lat: number,
  radiusKm: number
): GridEntry[] {
  const cellX = Math.floor(lon / CELL_DEG)
  const cellY = Math.floor(lat / CELL_DEG)
  const latSpan = Math.ceil(radiusKm / KM_PER_DEG_LAT / CELL_DEG)
  const kmPerDegLon = KM_PER_DEG_LON_EQUATOR * Math.max(Math.cos(lat * RAD), 0.01)
  const lonSpan = Math.ceil(radiusKm / kmPerDegLon / CELL_DEG)
  const out: GridEntry[] = []
  for (let y = cellY - latSpan; y <= cellY + latSpan; y++) {
    for (let x = cellX - lonSpan; x <= cellX + lonSpan; x++) {
      const cell = grid.get(cellKey(x, y))
      if (!cell) continue
      for (const entry of cell) {
        if (entry.stationId === selfId) continue
        if (haversineKm(lon, lat, entry.lon, entry.lat) <= radiusKm) out.push(entry)
      }
    }
  }
  return out
}

/** Plain median (no rounding — this is a comparison threshold, not a published value). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export interface QcSummary {
  /** Stations with ≥1 qc-flagged reading this run. */
  qcFlaggedStations: number
  /** Stations promoted to hotspot this run. */
  hotspots: number
}

/**
 * Mutates `features` in place: recomputes per-station `qc` flags, rewrites
 * eaqi/eaqiPollutant for stations whose flag set is (or was) non-empty, and
 * recomputes `hotspot`. Runs inside buildSnapshot BEFORE area aggregation so
 * regions see post-QC data. Composes with pmHumidityBias: that flag is left
 * untouched and a reading can be excluded downstream for either reason.
 */
export function applySpatialQc(features: readonly StationFeature[], now: Date): QcSummary {
  const grids = buildGrids(features, now)
  /** `${stationId}|${param}` for every flagged reading — flagged neighbors must not corroborate hotspots. */
  const flaggedReadings = new Set<string>()
  let qcFlaggedStations = 0
  let hotspots = 0

  for (const feature of features) {
    const props = feature.properties
    const [lon, lat] = feature.geometry.coordinates
    // Recompute from scratch: carried-forward stations may hold last run's flags.
    const hadQc = props.qc !== undefined
    delete props.qc
    delete props.hotspot

    const flags: Param[] = []
    for (const param of QC_RULE.params) {
      const reading = freshReading(feature, param, now)
      // Floor first: a reading ≤ floorUgM3 is never flagged regardless of ratio.
      if (!reading || reading.v <= QC_RULE.floorUgM3) continue
      const neighbors = neighborsWithin(grids.get(param)!, props.id, lon, lat, QC_RULE.radiusKm)
      // < minNeighbors: unflaggable — no evidence either way.
      if (neighbors.length < QC_RULE.minNeighbors) continue
      if (reading.v > QC_RULE.ratioThreshold * median(neighbors.map((n) => n.v))) {
        flags.push(param)
        flaggedReadings.add(`${props.id}|${param}`)
      }
    }

    if (flags.length > 0) {
      props.qc = flags
      qcFlaggedStations++
    }
    if (flags.length > 0 || hadQc) recomputeStationEaqi(feature, flags, now)
  }

  // Hotspot pass runs after every flag is known — corroboration must come
  // from readings that survived QC.
  for (const feature of features) {
    const props = feature.properties
    const band = props.eaqi
    const pollutant = props.eaqiPollutant
    if (band === undefined || band < HOTSPOT_MIN_BAND || pollutant === undefined) continue
    // The driving reading must be fresh (a fully-stale carried station keeps
    // its old eaqi for display but cannot be promoted) and unflagged (always
    // true post-recompute; kept as a cheap invariant guard).
    if (!freshReading(feature, pollutant, now)) continue
    if (flaggedReadings.has(`${props.id}|${pollutant}`)) continue
    if (props.kind === 'reference' || hasCorroboration(feature, band, pollutant)) {
      props.hotspot = true
      hotspots++
    }
  }

  function hasCorroboration(
    feature: StationFeature,
    band: number,
    pollutant: EaqiPollutant
  ): boolean {
    const [lon, lat] = feature.geometry.coordinates
    const neighbors = neighborsWithin(
      grids.get(pollutant)!,
      feature.properties.id,
      lon,
      lat,
      QC_RULE.radiusKm
    )
    for (const entry of neighbors) {
      if (flaggedReadings.has(`${entry.stationId}|${pollutant}`)) continue
      const neighborBand = eaqiBandForValue(pollutant, entry.v)
      if (neighborBand !== undefined && Math.abs(neighborBand - band) <= 1) return true
    }
    return false
  }

  return { qcFlaggedStations, hotspots }
}

/**
 * Rewrite a station's EAQI from its fresh readings minus `flags`. A station
 * whose only scoreable fresh reading is flagged loses its eaqi entirely.
 * Called only for stations that have flags now or had them last run; a
 * previously-flagged station with NO fresh readings at all (fully-stale
 * carry-forward) keeps its carried eaqi untouched — mirroring the
 * "values/EAQI untouched" carry-forward rule in snapshot.ts.
 */
function recomputeStationEaqi(feature: StationFeature, flags: readonly Param[], now: Date): void {
  const props = feature.properties
  const fresh: Partial<Record<Param, Reading>> = {}
  let hasFresh = false
  for (const param of PARAMS) {
    const reading = freshReading(feature, param, now)
    if (!reading) continue
    hasFresh = true
    if (flags.includes(param)) continue
    fresh[param] = reading
  }
  if (!hasFresh && flags.length === 0) return
  const eaqi = computeEaqi(fresh)
  if (eaqi) {
    props.eaqi = eaqi.band
    props.eaqiPollutant = eaqi.pollutant
  } else {
    delete props.eaqi
    delete props.eaqiPollutant
  }
}
