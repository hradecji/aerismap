import { EAQI_BAND_COLORS, EAQI_BAND_NAMES, PARAMS, type StationProperties } from '@aerismap/shared'
import { PARAM_LABELS, PARAM_UNITS, formatValue, kindLabel, relativeTime } from '../lib/format'

interface StationPopupProps {
  station: StationProperties
  now: number
}

export default function StationPopup({ station, now }: StationPopupProps) {
  const title = station.name?.trim() || `${kindLabel(station.kind)} ${station.nativeId}`
  const band = station.eaqi
  const present = PARAMS.filter((p) => station.values[p] !== undefined)
  // Spatial-QC flags: readings stay visible but are marked, and one shared
  // warning explains the exclusion. Only flags for readings actually shown
  // matter here.
  const flagged = (station.qc ?? []).filter((p) => station.values[p] !== undefined)
  const allPollutantsFlagged = band === undefined && flagged.length > 0

  return (
    <div className="popup">
      <div className="popupHead">
        <div className="popupTitle">{title}</div>
        <div className="popupMeta">
          {kindLabel(station.kind)}
          {station.country ? ` · ${station.country}` : ''} · {station.source}
        </div>
      </div>

      {band !== undefined && (
        <div
          className="popupBadge"
          style={{
            backgroundColor: EAQI_BAND_COLORS[band - 1],
            color: band >= 5 ? '#ffffff' : '#0b0b0b',
          }}
        >
          EAQI {band} · {EAQI_BAND_NAMES[band - 1]}
          {station.eaqiPollutant ? (
            <span className="popupBadgeSub"> (driven by {PARAM_LABELS[station.eaqiPollutant]})</span>
          ) : null}
        </div>
      )}
      {allPollutantsFlagged && (
        <div className="popupNote popupWarn">
          No station index — its pollutant readings failed the plausibility check below.
        </div>
      )}

      {present.length > 0 && (
        <dl className="popupValues">
          {present.map((p) => {
            const reading = station.values[p]!
            const isFlagged = flagged.includes(p)
            return (
              <div className="popupRow" key={p}>
                <dt>{PARAM_LABELS[p]}</dt>
                <dd>
                  {formatValue(p, reading.v)}
                  <span className="popupUnit"> {PARAM_UNITS[p]}</span>
                  {isFlagged && <span className="popupFlag">flagged</span>}
                  <span className="popupWhen">{relativeTime(reading.ts, now)}</span>
                </dd>
              </div>
            )
          })}
        </dl>
      )}

      {flagged.length > 0 && (
        <div className="popupNote popupWarn">
          {flagged.map((p) => PARAM_LABELS[p]).join(', ')}: Implausible vs nearby sensors (&gt;4×
          neighbourhood median) — excluded from station index and region stats.
        </div>
      )}
      {station.stale && (
        <div className="popupNote popupStale">
          Stale — last reading {relativeTime(station.observedAt, now)}.
        </div>
      )}
      {station.pmHumidityBias && (
        <div className="popupNote">PM may read high in near-saturated air.</div>
      )}
      {!station.exactLocation && <div className="popupNote">Location is approximate.</div>}
      <div className="popupLicense">Data licence: {station.license}</div>
    </div>
  )
}
