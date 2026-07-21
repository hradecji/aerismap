import { useCallback, useEffect, useRef, useState } from 'react'
import {
  API_PATHS,
  AREA_FULL_CONFIDENCE_STATIONS,
  AREA_PARAMS,
  ATTRIBUTIONS,
  EAQI_BAND_COLORS,
  EAQI_POLLUTANTS,
  eaqiBandForValue,
  regionBandAllowed,
  type AreaParam,
  type AreaSnapshot,
  type AreaStats,
  type Attribution,
  type EaqiBand,
  type EaqiPollutant,
} from '@aerismap/shared'
import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
} from 'maplibre-gl'
import { fetchJson } from './snapshot'
import { HUMIDITY_STOPS, TEMPERATURE_STOPS, type ViewId } from './views'

/** Area rendering mode: auto choropleth→dots crossfade, or classic points. */
export type AreaMode = 'auto' | 'points'

/** NUTS-2 fills below this zoom, NUTS-3 fills at/above it. */
export const NUTS_SPLIT_ZOOM = 5.5
/** Fills start fading out / circles start fading in here… */
export const AREA_CROSSFADE_START = 6.5
/** …and circles fully rule past here. */
export const AREA_CROSSFADE_END = 8

/**
 * "No data" fill: near-zero saturation, light value — reads as an absence,
 * unmistakable next to the saturated EAQI band colors (asserted in tests).
 */
export const NO_DATA_FILL = '#c9c7c1'

/** Verbatim licence notice — must render wherever area fills are visible. */
export const BOUNDARY_NOTICE = '© EuroGeographics for the administrative boundaries'

/** Every view can render area fills (EAQI/pollutant bands, temp/humidity ramps). */
export function viewHasAreaFills(_id: ViewId): boolean {
  return true
}

/** MapLibre expression literals don't typecheck as arrays; one contained cast. */
const asExpression = (e: unknown): ExpressionSpecification => e as ExpressionSpecification

/**
 * Feature-state payload for one region, graduated confidence applied
 * client-side (2026-07-21, replacing the hard ≥3-station cliff):
 * - `band` is emitted whenever ingest published `eaqi` — the published band
 *   already encodes the graduated rules (QC exclusion, min-of-two,
 *   regionBandAllowed), so trust it.
 * - `b_<pollutant>` (band of the pollutant median) passes through the shared
 *   regionBandAllowed gate: any count for bands ≤ 3, ≥ 2 stations for severe
 *   bands — one sensor may say "fine", never "emergency".
 * - `temp`/`hum` are not health claims: any single finite median suffices.
 * - `n` (station count) drives the opacity confidence ramp.
 */
export function areaStateFor(stats: AreaStats): Record<string, number> {
  const state: Record<string, number> = { n: stats.n }
  if (stats.eaqi !== undefined) state['band'] = stats.eaqi
  for (const p of EAQI_POLLUTANTS) {
    const med = stats.med?.[p]
    if (med === undefined) continue
    const band = eaqiBandForValue(p, med)
    if (band !== undefined && regionBandAllowed(band, stats.cnt?.[p] ?? 0)) {
      state[`b_${p}`] = band
    }
  }
  for (const [param, key] of [
    ['temperature', 'temp'],
    ['humidity', 'hum'],
  ] as const) {
    const med = stats.med?.[param]
    if (med !== undefined && Number.isFinite(med) && (stats.cnt?.[param] ?? 0) >= 1) {
      state[key] = med
    }
  }
  return state
}

const eaqiStateMatch = (key: string): ExpressionSpecification =>
  asExpression([
    'match',
    // Missing feature-state → null; coalesce to 0 → falls to the default gray.
    ['coalesce', ['feature-state', key], 0],
    ...EAQI_BAND_COLORS.flatMap((color, i) => [i + 1, color]),
    NO_DATA_FILL,
  ])

const rampStateFill = (
  key: string,
  stops: readonly { value: number; color: string }[]
): ExpressionSpecification =>
  asExpression([
    'case',
    ['==', ['typeof', ['feature-state', key]], 'number'],
    [
      'interpolate-lab',
      ['linear'],
      ['coalesce', ['feature-state', key], 0],
      ...stops.flatMap((s) => [s.value, s.color]),
    ],
    NO_DATA_FILL,
  ])

/** Fill color for the active view; null = fills are hidden in this view. */
export function areaFillColor(id: ViewId): ExpressionSpecification | null {
  if (!viewHasAreaFills(id)) return null
  if (id === 'temperature') return rampStateFill('temp', TEMPERATURE_STOPS)
  if (id === 'humidity') return rampStateFill('hum', HUMIDITY_STOPS)
  return eaqiStateMatch(id === 'eaqi' ? 'band' : `b_${id}`)
}

/**
 * Confidence encoding × zoom crossfade. Opacity interpolates on station
 * count — the graduated low end whispers (n=1 → 0.30, n=2 → 0.40), full
 * confidence starts at AREA_FULL_CONFIDENCE_STATIONS (0.45) and tops out at
 * 10+ (0.85) — then fades to 0 across the crossfade window. Regions without
 * state coalesce to n=0 and clamp to the low stop — the no-data gray stays
 * readable.
 */
export function areaFillOpacity(): DataDrivenPropertyValueSpecification<number> {
  const confidence = [
    'interpolate',
    ['linear'],
    ['coalesce', ['feature-state', 'n'], 0],
    1,
    0.3,
    2,
    0.4,
    AREA_FULL_CONFIDENCE_STATIONS,
    0.45,
    10,
    0.85,
  ]
  return asExpression([
    'interpolate',
    ['linear'],
    ['zoom'],
    AREA_CROSSFADE_START,
    confidence,
    AREA_CROSSFADE_END,
    0,
  ]) as DataDrivenPropertyValueSpecification<number>
}

/** Borders ride the same crossfade so they never outlive their fills. */
export function areaLineOpacity(): DataDrivenPropertyValueSpecification<number> {
  return asExpression([
    'interpolate',
    ['linear'],
    ['zoom'],
    AREA_CROSSFADE_START,
    0.55,
    AREA_CROSSFADE_END,
    0,
  ]) as DataDrivenPropertyValueSpecification<number>
}

/** fill-outline-color is capped at 1px — hover emphasis needs a line layer. */
export function areaLineWidth(): DataDrivenPropertyValueSpecification<number> {
  return asExpression([
    'case',
    ['boolean', ['feature-state', 'hover'], false],
    2,
    0.6,
  ]) as DataDrivenPropertyValueSpecification<number>
}

export function areaLineColor(): DataDrivenPropertyValueSpecification<string> {
  return asExpression([
    'case',
    ['boolean', ['feature-state', 'hover'], false],
    'rgba(11,11,11,0.85)',
    'rgba(11,11,11,0.3)',
  ]) as DataDrivenPropertyValueSpecification<string>
}

/**
 * Station circles: invisible under the pure choropleth, fading in across the
 * crossfade window to their normal (stale-aware) opacity. When fills are off
 * the base expression passes through untouched — current behavior.
 */
export function stationCircleOpacity(
  fillsShown: boolean,
  base: DataDrivenPropertyValueSpecification<number>
): DataDrivenPropertyValueSpecification<number> {
  if (!fillsShown) return base
  return asExpression([
    'interpolate',
    ['linear'],
    ['zoom'],
    AREA_CROSSFADE_START,
    0,
    AREA_CROSSFADE_END,
    base,
  ]) as DataDrivenPropertyValueSpecification<number>
}

/** What the region popup should lead with. */
export type AreaBandSummary =
  | { kind: 'band'; band: EaqiBand; pollutant?: EaqiPollutant }
  | { kind: 'too-few-stations'; n: number }
  | { kind: 'no-pollutant-coverage' }

/**
 * Graduated gating (2026-07-21): a single station may carry a band now, so
 * 'too-few-stations' only means "no stations at all". A region with stations
 * but no published band either lacks pollutant coverage or its only band
 * failed the corroboration rule — the client can't tell which, so one
 * honest message covers both.
 */
export function areaBandSummary(stats: AreaStats | null | undefined): AreaBandSummary {
  if (!stats || stats.n < 1) {
    return { kind: 'too-few-stations', n: stats?.n ?? 0 }
  }
  if (stats.eaqi === undefined) return { kind: 'no-pollutant-coverage' }
  return stats.pollutant !== undefined
    ? { kind: 'band', band: stats.eaqi, pollutant: stats.pollutant }
    : { kind: 'band', band: stats.eaqi }
}

/**
 * Region-popup station-count line with confidence wording by n. Whether the
 * shown band used the min-of-two rule is not knowable client-side, so this
 * never claims it — counts and confidence only.
 */
export function areaConfidenceLabel(stats: AreaStats | null | undefined): string {
  if (!stats || stats.n < 1) return 'No stations included'
  const split = `${stats.nRef} official, ${stats.nCom} community`
  if (stats.n === 1) return `Single station (${split}) — low confidence`
  if (stats.n === 2) return `Two stations (${split})`
  return `${stats.n} stations (${split})`
}

/**
 * The licence requires the EuroGeographics notice on the attribution surface
 * whenever boundaries render; append it if the (possibly server-sent)
 * attribution list lacks it.
 */
export function withBoundaryAttribution(list: Attribution[]): Attribution[] {
  if (list.some((a) => a.label === BOUNDARY_NOTICE)) return list
  const entry = ATTRIBUTIONS.find((a) => a.label === BOUNDARY_NOTICE) ?? {
    label: BOUNDARY_NOTICE,
    url: 'https://ec.europa.eu/eurostat/web/gisco/geodata/statistical-units',
  }
  return [...list, entry]
}

const isBand = (v: unknown): v is EaqiBand =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 6

const isPollutant = (v: unknown): v is EaqiPollutant =>
  typeof v === 'string' && (EAQI_POLLUTANTS as string[]).includes(v)

function numericSubset(raw: unknown): Partial<Record<AreaParam, number>> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const rec = raw as Record<string, unknown>
  const out: Partial<Record<AreaParam, number>> = {}
  let any = false
  for (const p of AREA_PARAMS) {
    const v = rec[p]
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[p] = v
      any = true
    }
  }
  return any ? out : undefined
}

/**
 * Validate/sanitize an AreaSnapshot payload. Top-level shape failures → null
 * (area mode unavailable); malformed entries and non-numeric fields are
 * dropped so one bad region can't take down the mode.
 */
export function parseAreaSnapshot(data: unknown): AreaSnapshot | null {
  if (typeof data !== 'object' || data === null) return null
  const { generatedAt, areas } = data as { generatedAt?: unknown; areas?: unknown }
  if (typeof generatedAt !== 'string') return null
  if (typeof areas !== 'object' || areas === null || Array.isArray(areas)) return null
  const out: Record<string, AreaStats> = {}
  for (const [id, raw] of Object.entries(areas as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const s = raw as Record<string, unknown>
    if (typeof s.n !== 'number' || !Number.isFinite(s.n) || s.n < 0) continue
    const stats: AreaStats = {
      n: s.n,
      nRef: typeof s.nRef === 'number' && Number.isFinite(s.nRef) ? s.nRef : 0,
      nCom: typeof s.nCom === 'number' && Number.isFinite(s.nCom) ? s.nCom : 0,
    }
    if (isBand(s.eaqi)) stats.eaqi = s.eaqi
    if (isPollutant(s.pollutant)) stats.pollutant = s.pollutant
    const med = numericSubset(s.med)
    if (med) stats.med = med
    const cnt = numericSubset(s.cnt)
    if (cnt) stats.cnt = cnt
    out[id] = stats
  }
  return { generatedAt, areas: out }
}

export type AreaSnapshotStatus = 'loading' | 'ready' | 'unavailable'

export interface AreaSnapshotResult {
  status: AreaSnapshotStatus
  /** Non-null exactly when status === 'ready'. */
  areas: AreaSnapshot | null
  /** Refetch — a no-op while loading or already ready. */
  retry: () => void
}

/**
 * Fetch the hourly area aggregate. Any failure (404 before the first area
 * ingest, network, malformed body) degrades to 'unavailable': points-only,
 * with only a subtle note in the layers panel.
 */
export function useAreaSnapshot(): AreaSnapshotResult {
  const [state, setState] = useState<{ status: AreaSnapshotStatus; areas: AreaSnapshot | null }>({
    status: 'loading',
    areas: null,
  })
  const [attempt, setAttempt] = useState(0)
  const statusRef = useRef<AreaSnapshotStatus>('loading')

  useEffect(() => {
    statusRef.current = state.status
  }, [state.status])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', areas: null })
    void (async () => {
      const res = await fetchJson<unknown>(API_PATHS.areas)
      if (cancelled) return
      if (!res.ok) {
        setState({ status: 'unavailable', areas: null })
        return
      }
      const parsed = parseAreaSnapshot(res.data)
      setState(
        parsed
          ? { status: 'ready', areas: parsed }
          : { status: 'unavailable', areas: null }
      )
    })()
    return () => {
      cancelled = true
    }
  }, [attempt])

  const retry = useCallback(() => {
    if (statusRef.current !== 'unavailable') return
    setAttempt((n) => n + 1)
  }, [])

  return { ...state, retry }
}
