import { useCallback, useEffect, useState } from 'react'
import {
  API_PATHS,
  EAQI_POLLUTANTS,
  eaqiBandForValue,
  type SnapshotMeta,
  type StationCollection,
} from '@aerismap/shared'
import { API_BASE } from './config'

export type SnapshotStatus = 'loading' | 'ready' | 'empty' | 'error'

export interface Snapshot {
  status: SnapshotStatus
  /** Flattened for MapLibre expressions; null until loaded. */
  stations: StationCollection | null
  meta: SnapshotMeta | null
  /**
   * Server clock minus client clock, measured from the meta response's Date
   * header — add to Date.now() before comparing against server-issued
   * timestamps like meta.generatedAt. 0 when the header was absent or
   * unparseable (client clock fallback).
   */
  clockSkewMs: number
  error?: string
  retry: () => void
}

/**
 * MapLibre expressions can't reach into the nested `values` object, so after
 * fetch we mirror what the map needs as top-level feature properties:
 * `_b_<pollutant>` (EAQI band 1–6, via the shared threshold tables) and raw
 * `_temperature` / `_humidity`. Ingest artifacts stay clean; the popup keeps
 * reading the full `values` object.
 */
function flatten(collection: StationCollection): StationCollection {
  for (const feature of collection.features) {
    const { values } = feature.properties
    const extra: Record<string, number> = {}
    for (const pollutant of EAQI_POLLUTANTS) {
      const reading = values[pollutant]
      if (!reading) continue
      const band = eaqiBandForValue(pollutant, reading.v)
      if (band !== undefined) extra[`_b_${pollutant}`] = band
    }
    if (values.temperature && Number.isFinite(values.temperature.v)) {
      extra['_temperature'] = values.temperature.v
    }
    if (values.humidity && Number.isFinite(values.humidity.v)) {
      extra['_humidity'] = values.humidity.v
    }
    // Region bands (hotspot stations only) — flat for the contrast filter.
    const rb = feature.properties.regionBands
    if (rb?.n2 !== undefined) extra['_rb2'] = rb.n2
    if (rb?.n3 !== undefined) extra['_rb3'] = rb.n3
    Object.assign(feature.properties, extra)
  }
  return collection
}

export type FetchResult<T> =
  | { ok: true; data: T; skewMs: number | null }
  | { ok: false; notFound: boolean; message: string }

export async function fetchJson<T>(path: string): Promise<FetchResult<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' } })
    // Server-vs-client clock skew from the Date header, captured at response
    // time; null (= trust the client clock) when absent or unparseable.
    const serverDate = Date.parse(res.headers.get('date') ?? '')
    const skewMs = Number.isFinite(serverDate) ? serverDate - Date.now() : null
    if (!res.ok) {
      return { ok: false, notFound: res.status === 404, message: `HTTP ${res.status}` }
    }
    return { ok: true, data: (await res.json()) as T, skewMs }
  } catch (err) {
    return {
      ok: false,
      notFound: false,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

function isStationCollection(data: unknown): data is StationCollection {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'FeatureCollection' &&
    Array.isArray((data as { features?: unknown }).features)
  )
}

/**
 * Minimal shape check for the fields the UI actually reads. Meta is
 * enrichment, so anything malformed degrades to "no meta" (App falls back to
 * the shared ATTRIBUTIONS list) instead of crashing the render.
 */
function isSnapshotMeta(data: unknown): data is SnapshotMeta {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { generatedAt?: unknown }).generatedAt === 'string' &&
    Array.isArray((data as { attribution?: unknown }).attribution)
  )
}

interface SnapshotState {
  status: SnapshotStatus
  stations: StationCollection | null
  meta: SnapshotMeta | null
  clockSkewMs: number
  error?: string
}

export function useSnapshot(): Snapshot {
  const [state, setState] = useState<SnapshotState>({
    status: 'loading',
    stations: null,
    meta: null,
    clockSkewMs: 0,
  })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', stations: null, meta: null, clockSkewMs: 0 })
    void (async () => {
      const [stationsRes, metaRes] = await Promise.all([
        fetchJson<unknown>(API_PATHS.stations),
        fetchJson<unknown>(API_PATHS.meta),
      ])
      if (cancelled) return
      // meta is enrichment; a missing/failed/malformed meta never blocks the map.
      const meta = metaRes.ok && isSnapshotMeta(metaRes.data) ? metaRes.data : null
      const clockSkewMs = metaRes.ok && metaRes.skewMs !== null ? metaRes.skewMs : 0
      if (!stationsRes.ok) {
        setState(
          stationsRes.notFound
            ? { status: 'empty', stations: null, meta, clockSkewMs }
            : { status: 'error', stations: null, meta, clockSkewMs, error: stationsRes.message }
        )
        return
      }
      if (!isStationCollection(stationsRes.data)) {
        setState({
          status: 'error',
          stations: null,
          meta,
          clockSkewMs,
          error: 'Unexpected stations response shape',
        })
        return
      }
      let stations: StationCollection
      try {
        stations = flatten(stationsRes.data)
      } catch {
        // e.g. features with null properties/values: fail soft to the error card.
        setState({
          status: 'error',
          stations: null,
          meta,
          clockSkewMs,
          error: 'Malformed stations payload',
        })
        return
      }
      setState({ status: 'ready', stations, meta, clockSkewMs })
    })()
    return () => {
      cancelled = true
    }
  }, [attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  return { ...state, retry }
}
