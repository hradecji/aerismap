import { EUROPE_BBOX, type Param, type Reading } from '@aerismap/shared'
import { fetchJson } from '../http'
import type { SourceResult, StationDraft } from '../types'

const DUST_URL = 'https://data.sensor.community/static/v2/data.dust.min.json'
const TEMP_URL = 'https://data.sensor.community/static/v2/data.temp.min.json'
/** Each dump is ~4.5 MB uncompressed; 10× that is upstream misbehaviour, not data. */
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024
/** Readings further ahead than this are clock skew and would render permanently fresh. */
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000
/** Below this the fetch "worked" but the data is implausible (normal ≈ 9.5k stations). */
const MIN_PLAUSIBLE_STATIONS = 500

/**
 * Sensor.Community value_type → shared Param. Everything else in the feed
 * (durP*, ratioP*, N*, noise_*, pressure_at_sealevel, …) is intentionally ignored.
 */
const VALUE_TYPE_TO_PARAM: Readonly<Record<string, Param>> = {
  P0: 'pm1',
  P1: 'pm10',
  P2: 'pm2_5',
  temperature: 'temperature',
  humidity: 'humidity',
  pressure: 'pressure',
}

/**
 * Feed timestamps are 'YYYY-MM-DD HH:MM:SS' in UTC without a zone designator
 * (verified live 2026-07-21). Returns ISO 8601 Z, or undefined when unparseable.
 */
export function normalizeScTimestamp(raw: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(raw)
  if (!m) return undefined
  const iso = `${m[1]}T${m[2]}Z`
  return Number.isNaN(Date.parse(iso)) ? undefined : iso
}

/**
 * Parse + plausibility-filter one reported value. Returns undefined for
 * implausible readings (all observed in the live feed):
 * - PM outside 0–1000 µg/m³ (PPD42NS reports P1 in the thousands)
 * - temperature outside −60…+60 °C (broken DHT22s report −142 °C / +436 °C)
 * - humidity outside (1, 100] — DHT22s degenerate to a constant 1.00
 * - pressure: the feed reports Pa (~100 000) but a minority of sensors report
 *   hPa directly (~1000); normalize both to hPa, then require 300–1100 hPa.
 */
export function normalizeScValue(param: Param, raw: string): number | undefined {
  if (raw.trim() === '') return undefined // Number('') is 0, not NaN
  const v = Number(raw)
  if (!Number.isFinite(v)) return undefined
  switch (param) {
    case 'pm1':
    case 'pm2_5':
    case 'pm10':
      return v >= 0 && v <= 1000 ? v : undefined
    case 'temperature':
      return v >= -60 && v <= 60 ? v : undefined
    case 'humidity':
      return v > 1 && v <= 100 ? v : undefined
    case 'pressure': {
      const hPa = v > 2000 ? v / 100 : v
      return hPa >= 300 && hPa <= 1100 ? Math.round(hPa * 100) / 100 : undefined
    }
    default:
      return undefined
  }
}

interface ParsedRecord {
  locationId: number
  sensorId: number
  /** ISO 8601 Z */
  ts: string
  lon: number
  lat: number
  country: string | undefined
  exactLocation: boolean
  indoor: boolean
  values: ReadonlyArray<{ valueType: string; value: string }>
}

function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function parseScRecord(raw: unknown): ParsedRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const rec = raw as {
    timestamp?: unknown
    location?: {
      id?: unknown
      latitude?: unknown
      longitude?: unknown
      country?: unknown
      exact_location?: unknown
      indoor?: unknown
    } | null
    sensor?: { id?: unknown } | null
    sensordatavalues?: unknown
  }

  const loc = rec.location
  if (typeof loc !== 'object' || loc === null) return undefined
  const locationId = asFiniteNumber(loc.id)
  const lat = asFiniteNumber(loc.latitude)
  const lon = asFiniteNumber(loc.longitude)
  const ts = typeof rec.timestamp === 'string' ? normalizeScTimestamp(rec.timestamp) : undefined
  if (locationId === undefined || lat === undefined || lon === undefined || ts === undefined) {
    return undefined
  }
  if (!Array.isArray(rec.sensordatavalues)) return undefined

  const values: Array<{ valueType: string; value: string }> = []
  for (const sdv of rec.sensordatavalues as Array<{ value?: unknown; value_type?: unknown }>) {
    if (typeof sdv?.value_type === 'string' && typeof sdv.value === 'string') {
      values.push({ valueType: sdv.value_type, value: sdv.value })
    }
  }

  const countryRaw = typeof loc.country === 'string' ? loc.country.toUpperCase() : ''
  return {
    locationId,
    sensorId: asFiniteNumber(rec.sensor?.id) ?? 0,
    ts,
    lon,
    lat,
    country: /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : undefined,
    exactLocation: loc.exact_location === 1,
    indoor: loc.indoor === 1,
    values,
  }
}

function inEuropeBbox(lon: number, lat: number): boolean {
  const [minLon, minLat, maxLon, maxLat] = EUROPE_BBOX
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat
}

export interface ScMergeResult {
  stations: StationDraft[]
  /** Records that failed structural parsing (not plausibility/scope filters). */
  malformedRecords: number
}

/**
 * Merge dust + temp records into one station per location.id.
 *
 * Readings merge per-param, newest timestamp wins. This is deliberately finer
 * than whole-record dedupe: the live feed contains back-to-back records from
 * the same sensor where the newer one carries only humidity and the older one
 * the PM values — record-level "keep newest" would drop the PM data.
 * Processing order is made deterministic by sorting on (ts, sensorId, input
 * position) with later entries winning timestamp ties. When `now` is given,
 * records timestamped more than 10 minutes ahead of it are dropped
 * (clock-skewed stations would otherwise render permanently fresh).
 */
export function mergeScRecords(
  recordSets: ReadonlyArray<readonly unknown[]>,
  now?: Date
): ScMergeResult {
  let malformedRecords = 0
  const parsed: ParsedRecord[] = []
  for (const set of recordSets) {
    for (const raw of set) {
      const rec = parseScRecord(raw)
      if (!rec) {
        malformedRecords++
        continue
      }
      if (rec.indoor || !inEuropeBbox(rec.lon, rec.lat)) continue
      if (now !== undefined && Date.parse(rec.ts) > now.getTime() + MAX_FUTURE_SKEW_MS) continue
      parsed.push(rec)
    }
  }

  parsed.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
    return a.sensorId - b.sensorId
  })

  interface Accumulator {
    meta: ParsedRecord
    values: Partial<Record<Param, Reading>>
  }
  const byLocation = new Map<number, Accumulator>()

  for (const rec of parsed) {
    let acc = byLocation.get(rec.locationId)
    if (!acc) {
      acc = { meta: rec, values: {} }
      byLocation.set(rec.locationId, acc)
    } else if (rec.ts >= acc.meta.ts) {
      acc.meta = rec // newest record wins for coords/flags
    }
    for (const { valueType, value } of rec.values) {
      const param = VALUE_TYPE_TO_PARAM[valueType]
      if (!param) continue
      const v = normalizeScValue(param, value)
      if (v === undefined) continue
      const existing = acc.values[param]
      if (!existing || rec.ts >= existing.ts) {
        acc.values[param] = { v, ts: rec.ts }
      }
    }
  }

  const stations: StationDraft[] = []
  for (const [locationId, acc] of byLocation) {
    if (Object.keys(acc.values).length === 0) continue // every reading implausible
    stations.push({
      lon: acc.meta.lon,
      lat: acc.meta.lat,
      properties: {
        id: `sensor-community:${locationId}`,
        source: 'sensor-community',
        nativeId: String(locationId),
        kind: 'community',
        ...(acc.meta.country ? { country: acc.meta.country } : {}),
        license: 'ODbL-1.0',
        exactLocation: acc.meta.exactLocation,
        values: acc.values,
      },
    })
  }
  return { stations, malformedRecords }
}

export interface SensorCommunityOptions {
  fetchImpl?: typeof fetch
  now?: Date
  /** Overridable for tests; production floor MIN_PLAUSIBLE_STATIONS. */
  minStations?: number
}

export async function fetchSensorCommunity(
  options: SensorCommunityOptions = {}
): Promise<SourceResult> {
  const { fetchImpl, now = new Date(), minStations = MIN_PLAUSIBLE_STATIONS } = options
  try {
    // Sequential on purpose: two ~4.5 MB uncompressed downloads from a
    // donation-funded host — don't hit it with parallel requests.
    const dust = await fetchJson(DUST_URL, {
      timeoutMs: 60_000,
      retries: 2,
      maxBytes: MAX_RESPONSE_BYTES,
      fetchImpl,
    })
    const temp = await fetchJson(TEMP_URL, {
      timeoutMs: 60_000,
      retries: 2,
      maxBytes: MAX_RESPONSE_BYTES,
      fetchImpl,
    })
    if (!Array.isArray(dust) || !Array.isArray(temp)) {
      throw new Error('unexpected payload: expected JSON arrays')
    }
    const { stations, malformedRecords } = mergeScRecords([dust, temp], now)
    if (malformedRecords > 0) {
      console.warn(`[ingest] sensor-community: skipped ${malformedRecords} malformed records`)
    }
    if (stations.length < minStations) {
      return {
        status: {
          id: 'sensor-community',
          ok: false,
          detail: `implausibly low yield: ${stations.length} stations < floor ${minStations} (normal ≈ 9.5k) — not publishing this source`,
        },
        stations: [],
      }
    }
    return {
      status: {
        id: 'sensor-community',
        ok: true,
        fetchedAt: new Date().toISOString(),
        stations: stations.length,
      },
      stations,
    }
  } catch (err) {
    return {
      status: {
        id: 'sensor-community',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      },
      stations: [],
    }
  }
}
