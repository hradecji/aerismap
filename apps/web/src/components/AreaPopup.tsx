import {
  AREA_MIN_POLLUTANT_STATIONS,
  AREA_MIN_STATIONS,
  AREA_PARAMS,
  EAQI_BAND_COLORS,
  EAQI_BAND_NAMES,
  type AreaStats,
} from '@aerismap/shared'
import { areaBandSummary, BOUNDARY_NOTICE } from '../lib/areas'
import { PARAM_LABELS, PARAM_UNITS, formatValue } from '../lib/format'

interface AreaPopupProps {
  nutsId: string
  name: string
  /** NUTS level from the boundary feature (2 or 3), when present. */
  level?: number
  /** null when the region has no entry in the snapshot. */
  stats: AreaStats | null
}

export default function AreaPopup({ nutsId, name, level, stats }: AreaPopupProps) {
  const summary = areaBandSummary(stats)
  const med = stats?.med ?? {}
  const cnt = stats?.cnt ?? {}
  const present = AREA_PARAMS.filter((p) => med[p] !== undefined)

  return (
    <div className="popup">
      <div className="popupHead">
        <div className="popupTitle">{name}</div>
        <div className="popupMeta">
          {nutsId}
          {level !== undefined ? ` · NUTS ${level}` : ''}
        </div>
        <div className="popupMeta">
          {stats
            ? `${stats.n} station${stats.n === 1 ? '' : 's'} (${stats.nRef} official, ${stats.nCom} community)`
            : 'No stations included'}
        </div>
      </div>

      {summary.kind === 'band' && (
        <div
          className="popupBadge"
          style={{
            backgroundColor: EAQI_BAND_COLORS[summary.band - 1],
            color: summary.band >= 5 ? '#ffffff' : '#0b0b0b',
          }}
        >
          EAQI {summary.band} · {EAQI_BAND_NAMES[summary.band - 1]}
          {summary.pollutant ? (
            <span className="popupBadgeSub"> (driven by {PARAM_LABELS[summary.pollutant]})</span>
          ) : null}
        </div>
      )}
      {summary.kind === 'too-few-stations' && (
        <div className="popupNote">
          Not enough stations ({summary.n} of {AREA_MIN_STATIONS} needed).
        </div>
      )}
      {summary.kind === 'no-pollutant-coverage' && (
        <div className="popupNote">
          No pollutant measured by at least {AREA_MIN_POLLUTANT_STATIONS} stations.
        </div>
      )}

      {present.length > 0 && (
        <dl className="popupValues">
          {present.map((p) => (
            <div className="popupRow" key={p}>
              <dt>{PARAM_LABELS[p]}</dt>
              <dd>
                {formatValue(p, med[p]!)}
                <span className="popupUnit"> {PARAM_UNITS[p]}</span>
                {cnt[p] !== undefined && (
                  <span className="popupWhen">
                    {cnt[p]} station{cnt[p] === 1 ? '' : 's'}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {present.length > 0 && (
        <div className="popupNote">Values are medians across included stations.</div>
      )}

      <div className="popupLicense">{BOUNDARY_NOTICE}</div>
    </div>
  )
}
