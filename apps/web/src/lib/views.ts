import {
  EAQI_BAND_COLORS,
  EAQI_BAND_NAMES,
  EAQI_THRESHOLDS,
  type EaqiPollutant,
} from '@aerismap/shared'
import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  FilterSpecification,
} from 'maplibre-gl'
import { PARAM_LABELS } from './format'

export type ViewId = 'eaqi' | EaqiPollutant | 'temperature' | 'humidity'

export interface KindFilter {
  reference: boolean
  community: boolean
}

/** Dots that carry no value in the active view (EAQI view only): muted gray. */
export const NEUTRAL_DOT = '#898781'

export interface RampStop {
  value: number
  color: string
}

export type LegendSpec =
  | {
      kind: 'bands'
      title: string
      entries: { color: string; label: string; detail?: string }[]
    }
  | { kind: 'ramp'; title: string; stops: RampStop[]; ticks: number[] }

export interface ViewSpec {
  id: ViewId
  label: string
  circleColor: DataDrivenPropertyValueSpecification<string>
  strokeColor: string
  /** Extra filter clause hiding stations without this view's value. */
  presenceFilter?: ExpressionSpecification
  legend: LegendSpec
}

/**
 * Flattened property added by the snapshot loader: EAQI band (1–6) for one
 * pollutant. Top-level because MapLibre expressions can't reach into the
 * nested `values` object.
 */
export const bandProp = (p: EaqiPollutant): `_b_${EaqiPollutant}` => `_b_${p}`

/**
 * Temperature, −10…40 °C: diverging blue ↔ red around the physically
 * meaningful 0 °C baseline (freezing), neutral gray midpoint. Poles come from
 * the reference blue ramp and the red family; the midpoint is darkened enough
 * to stay visible on the light positron basemap. Lightness is monotone within
 * each arm (verified in OKLab: cold 0.81→0.43, warm 0.81→0.39), so the ramp
 * stays readable under CVD — magnitude is carried by lightness, sign by hue.
 */
export const TEMPERATURE_STOPS: RampStop[] = [
  { value: -10, color: '#184f95' },
  { value: -5, color: '#5598e7' },
  { value: 0, color: '#c3c2b7' },
  { value: 12, color: '#e5885f' },
  { value: 26, color: '#cf4040' },
  { value: 40, color: '#7c1f1c' },
]

/**
 * Relative humidity, 0…100%: single-hue sequential blue (reference ramp steps
 * 100→700), light→dark with monotone lightness — colorblind-safe by
 * construction and clearly distinct from the gray basemap at the dark end;
 * the light end gets a dark dot stroke for visibility.
 */
export const HUMIDITY_STOPS: RampStop[] = [
  { value: 0, color: '#cde2fb' },
  { value: 25, color: '#9ec5f4' },
  { value: 50, color: '#5598e7' },
  { value: 75, color: '#256abf' },
  { value: 100, color: '#0d366b' },
]

/** MapLibre expression literals don't typecheck as arrays; one contained cast. */
const asExpression = (e: unknown): ExpressionSpecification => e as ExpressionSpecification

const eaqiBandMatch = (input: unknown): ExpressionSpecification =>
  asExpression([
    'match',
    input,
    ...EAQI_BAND_COLORS.flatMap((color, i) => [i + 1, color]),
    NEUTRAL_DOT,
  ])

const rampColor = (prop: string, stops: RampStop[]): ExpressionSpecification =>
  // interpolate-lab keeps the perceptual spacing of the validated stops.
  asExpression([
    'interpolate-lab',
    ['linear'],
    ['get', prop],
    ...stops.flatMap((s) => [s.value, s.color]),
  ])

/** White halo separates saturated EAQI dots from the basemap and each other. */
const EAQI_STROKE = 'rgba(255,255,255,0.85)'
/** Ramp views include very light fills; a dark hairline keeps them visible. */
const RAMP_STROKE = 'rgba(11,11,11,0.28)'

function bandRanges(p: EaqiPollutant): string[] {
  const bounds = EAQI_THRESHOLDS[p]
  const ranges = [`≤ ${bounds[0]}`]
  for (let i = 1; i < bounds.length; i++) ranges.push(`${bounds[i - 1]}–${bounds[i]}`)
  ranges.push(`> ${bounds[bounds.length - 1]}`)
  return ranges
}

function pollutantView(p: EaqiPollutant): ViewSpec {
  const ranges = bandRanges(p)
  return {
    id: p,
    label: PARAM_LABELS[p],
    circleColor: eaqiBandMatch(['get', bandProp(p)]),
    strokeColor: EAQI_STROKE,
    presenceFilter: asExpression(['has', bandProp(p)]),
    legend: {
      kind: 'bands',
      title: `${PARAM_LABELS[p]} · EAQI bands, µg/m³`,
      entries: EAQI_BAND_NAMES.map((name, i) => ({
        color: EAQI_BAND_COLORS[i]!,
        label: name,
        detail: ranges[i]!,
      })),
    },
  }
}

export const VIEWS: ViewSpec[] = [
  {
    id: 'eaqi',
    label: 'EAQI',
    circleColor: asExpression([
      'case',
      ['has', 'eaqi'],
      eaqiBandMatch(['get', 'eaqi']),
      NEUTRAL_DOT,
    ]),
    strokeColor: EAQI_STROKE,
    legend: {
      kind: 'bands',
      title: 'European Air Quality Index',
      entries: [
        ...EAQI_BAND_NAMES.map((name, i) => ({ color: EAQI_BAND_COLORS[i]!, label: name })),
        { color: NEUTRAL_DOT, label: 'No index' },
      ],
    },
  },
  ...(['pm2_5', 'pm10', 'no2', 'o3', 'so2'] as const).map(pollutantView),
  {
    id: 'temperature',
    label: 'Temperature',
    circleColor: rampColor('_temperature', TEMPERATURE_STOPS),
    strokeColor: RAMP_STROKE,
    presenceFilter: asExpression(['has', '_temperature']),
    legend: {
      kind: 'ramp',
      title: 'Air temperature, °C',
      stops: TEMPERATURE_STOPS,
      ticks: [-10, 0, 10, 20, 30, 40],
    },
  },
  {
    id: 'humidity',
    label: 'Humidity',
    circleColor: rampColor('_humidity', HUMIDITY_STOPS),
    strokeColor: RAMP_STROKE,
    presenceFilter: asExpression(['has', '_humidity']),
    legend: {
      kind: 'ramp',
      title: 'Relative humidity, %',
      stops: HUMIDITY_STOPS,
      ticks: [0, 25, 50, 75, 100],
    },
  },
]

export function buildFilter(
  view: ViewSpec,
  kinds: KindFilter,
  showStale: boolean
): FilterSpecification {
  const allowed = [
    ...(kinds.reference ? ['reference'] : []),
    ...(kinds.community ? ['community'] : []),
  ]
  const clauses: unknown[] = [['in', ['get', 'kind'], ['literal', allowed]]]
  if (!showStale) clauses.push(['!', ['to-boolean', ['get', 'stale']]])
  if (view.presenceFilter) clauses.push(view.presenceFilter)
  return asExpression(['all', ...clauses]) as FilterSpecification
}

export function circleRadius(id: ViewId): DataDrivenPropertyValueSpecification<number> {
  if (id === 'eaqi') {
    // Stations without an index render as smaller neutral dots.
    const at = (scored: number, unscored: number) => ['case', ['has', 'eaqi'], scored, unscored]
    return asExpression([
      'interpolate',
      ['linear'],
      ['zoom'],
      3,
      at(2.5, 1.6),
      8,
      at(5, 2.8),
      12,
      at(9, 5),
    ]) as DataDrivenPropertyValueSpecification<number>
  }
  return asExpression([
    'interpolate',
    ['linear'],
    ['zoom'],
    3,
    2.5,
    8,
    5,
    12,
    9,
  ]) as DataDrivenPropertyValueSpecification<number>
}

/** Worse bands draw on top so hotspots stay visible in dense areas. */
export function circleSortKey(view: ViewSpec): DataDrivenPropertyValueSpecification<number> {
  if (view.id === 'eaqi') {
    return asExpression(['coalesce', ['get', 'eaqi'], 0]) as DataDrivenPropertyValueSpecification<number>
  }
  if (view.id !== 'temperature' && view.id !== 'humidity') {
    return asExpression([
      'coalesce',
      ['get', bandProp(view.id)],
      0,
    ]) as DataDrivenPropertyValueSpecification<number>
  }
  return 0
}
