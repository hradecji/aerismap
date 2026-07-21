import {
  AREA_PARAMS,
  EAQI_BAND_COLORS,
  EAQI_BAND_NAMES,
  type AreaStats,
} from '@aerismap/shared'
import { areaBandSummary, areaConfidenceLabel, BOUNDARY_NOTICE } from '../lib/areas'

/** Gas pollutants community sensors cannot measure — drives the PM-only disclosure. */
const GAS_PARAMS = ['no2', 'o3', 'so2'] as const
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
        <div className="popupMeta">{areaConfidenceLabel(stats)}</div>
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
      {summary.kind === 'band' && !GAS_PARAMS.some((p) => (cnt[p] ?? 0) > 0) && (
        <div className="popupNote">
          PM only — no station here measures gas pollutants (O₃, NO₂, SO₂), so summer ozone
          episodes are invisible until official stations are ingested.
        </div>
      )}
      {summary.kind === 'too-few-stations' && (
        <div className="popupNote">No stations reported fresh data in this region.</div>
      )}
      {summary.kind === 'no-pollutant-coverage' && (
        <div className="popupNote">
          No pollutant band met the confidence rules — severe bands need at least two stations.
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
