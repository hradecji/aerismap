'use client'

import { useEffect, useState } from 'react'
import { BOUNDARY_NOTICE } from '../lib/areas'
import { HOTSPOT_LEGEND_LABEL } from '../lib/hotspots'
import { EAQI_EXPLAINER, collapsedTitle, rampGradient, stripGradient } from '../lib/legendStrip'
import { NARROW_QUERY, useMediaQuery } from '../lib/useMediaQuery'
import type { ViewSpec } from '../lib/views'

interface LegendProps {
  view: ViewSpec
  /** True while area fills are on — adds the confidence note + licence line. */
  areaNote: boolean
  /** True when the loaded snapshot contains hotspot stations — adds the ◉ line. */
  showHotspots: boolean
}

/**
 * Collapsible legend. Collapsed = one row (compact title + slim color strip);
 * expanded = the full key. Default is collapsed on phones, expanded on wider
 * viewports; nothing is persisted — crossing the breakpoint reasserts the
 * default. The EuroGeographics notice is a licence obligation: while fills
 * render it stays visible even collapsed, as a tiny caption under the strip.
 */
export default function Legend({ view, areaNote, showHotspots }: LegendProps) {
  const isNarrow = useMediaQuery(NARROW_QUERY)
  const [choice, setChoice] = useState<boolean | null>(null)
  useEffect(() => setChoice(null), [isNarrow])
  const expanded = choice ?? !isNarrow
  const legend = view.legend

  return (
    <section
      className={expanded ? 'panel legend' : 'panel legend legendClosed'}
      aria-label="Legend"
    >
      <h2 className="legendHeading">
        <button
          type="button"
          className="legendToggle"
          aria-expanded={expanded}
          onClick={() => setChoice(!expanded)}
        >
          <span className="legendTitle">{expanded ? legend.title : collapsedTitle(view)}</span>
          {!expanded && (
            <span
              className="legendStrip"
              style={{ background: stripGradient(legend) }}
              aria-hidden="true"
            />
          )}
          <span className="legendChevron" aria-hidden="true">
            {expanded ? '▾' : '▴'}
          </span>
        </button>
      </h2>
      {expanded ? (
        <div className="legendBody">
          {view.id === 'eaqi' && <p className="legendExplainer">{EAQI_EXPLAINER}</p>}
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
          {showHotspots && <p className="legendHotspot">{HOTSPOT_LEGEND_LABEL}</p>}
          {areaNote && (
            <>
              <p className="legendNote">Region opacity = station count</p>
              <p className="legendBoundary">{BOUNDARY_NOTICE}</p>
            </>
          )}
        </div>
      ) : (
        areaNote && <p className="legendBoundaryMini">{BOUNDARY_NOTICE}</p>
      )}
    </section>
  )
}
