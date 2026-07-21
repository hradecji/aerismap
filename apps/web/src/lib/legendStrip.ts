import { NEUTRAL_DOT, type LegendSpec, type ViewSpec } from './views'

/**
 * The integrated-index explainer — one line, shown under the expanded EAQI
 * legend title. This is the answer to “invent an integrated index”: EAQI
 * already is one, so say how it integrates.
 */
export const EAQI_EXPLAINER = 'Worst of PM2.5 · PM10 · NO₂ · O₃ · SO₂ decides'

/** Continuous gradient for a ramp legend, stops placed by value. */
export function rampGradient(legend: Extract<LegendSpec, { kind: 'ramp' }>): string {
  const first = legend.stops[0]!
  const last = legend.stops[legend.stops.length - 1]!
  const span = last.value - first.value
  const parts = legend.stops.map(
    (s) => `${s.color} ${(((s.value - first.value) / span) * 100).toFixed(1)}%`
  )
  return `linear-gradient(to right, ${parts.join(', ')})`
}

/**
 * The slim band shown in the collapsed one-row legend. Ramps keep their
 * continuous gradient; band legends become equal hard-stop segments. The
 * neutral “No index” swatch is dropped — the strip depicts the scale, not
 * the absence of one.
 */
export function stripGradient(legend: LegendSpec): string {
  if (legend.kind === 'ramp') return rampGradient(legend)
  const colors = legend.entries.map((e) => e.color).filter((c) => c !== NEUTRAL_DOT)
  const pct = (i: number) => ((i / colors.length) * 100).toFixed(1)
  const parts = colors.map((c, i) => `${c} ${pct(i)}% ${pct(i + 1)}%`)
  return `linear-gradient(to right, ${parts.join(', ')})`
}

/** Compact title for the collapsed row; the expanded title stays verbose. */
export function collapsedTitle(view: ViewSpec): string {
  return view.id === 'eaqi' ? 'Air quality index' : view.label
}
