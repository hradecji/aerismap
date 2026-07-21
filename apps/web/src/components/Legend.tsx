import { BOUNDARY_NOTICE } from '../lib/areas'
import type { LegendSpec, ViewSpec } from '../lib/views'

function rampGradient(legend: Extract<LegendSpec, { kind: 'ramp' }>): string {
  const first = legend.stops[0]!
  const last = legend.stops[legend.stops.length - 1]!
  const span = last.value - first.value
  const parts = legend.stops.map(
    (s) => `${s.color} ${(((s.value - first.value) / span) * 100).toFixed(1)}%`
  )
  return `linear-gradient(to right, ${parts.join(', ')})`
}

interface LegendProps {
  view: ViewSpec
  /** True while area fills are on — adds the confidence note + licence line. */
  areaNote: boolean
}

export default function Legend({ view, areaNote }: LegendProps) {
  const legend = view.legend
  return (
    <section className="panel legend" aria-label="Legend">
      <h2 className="panelTitle">{legend.title}</h2>
      {legend.kind === 'bands' ? (
        <ul className="legendBands">
          {legend.entries.map((entry) => (
            <li key={entry.label}>
              <span className="swatch" style={{ backgroundColor: entry.color }} />
              <span className="legendLabel">{entry.label}</span>
              {entry.detail && <span className="legendDetail">{entry.detail}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="legendRamp">
          <div className="rampBar" style={{ background: rampGradient(legend) }} />
          <div className="rampTicks">
            {legend.ticks.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        </div>
      )}
      {areaNote && (
        <>
          <p className="legendNote">Region opacity = station count</p>
          <p className="legendBoundary">{BOUNDARY_NOTICE}</p>
        </>
      )}
    </section>
  )
}
