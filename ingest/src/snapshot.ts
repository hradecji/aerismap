import {
  ATTRIBUTIONS,
  computeEaqi,
  EAQI_BAND_SET,
  MAX_AGE_SEC,
  PARAMS,
  type Param,
  type Reading,
  type SnapshotMeta,
  type StationCollection,
  type StationFeature,
  type StationKind,
} from '@aerismap/shared'
import type { IngestSourceStatus, SourceResult } from './types'

export interface Snapshot {
  collection: StationCollection
  meta: SnapshotMeta
}

const round5 = (v: number): number => Math.round(v * 1e5) / 1e5

/** Low-cost optical PM sensors over-read in near-saturated air (plan §5.1: flag, don't correct). */
const PM_HUMIDITY_BIAS_MIN_RH = 95

/**
 * Merge source results into the published artifacts. Deterministic for a given
 * (results, now, previous): features are sorted by station id and every derived
 * field is a pure function of the inputs.
 *
 * When `previous` (the last published snapshot) is given, stations of failed
 * sources are carried forward from it — staleness recomputed against `now`,
 * values/EAQI untouched — so a transient upstream failure degrades to "stale
 * but visible" instead of silently shrinking the map.
 */
export function buildSnapshot(
  results: readonly SourceResult[],
  now: Date,
  previous?: StationCollection
): Snapshot {
  const features: StationFeature[] = []

  for (const result of results) {
    for (const draft of result.stations) {
      const values = draft.properties.values
      const readings = Object.values(values).filter((r): r is Reading => r !== undefined)
      if (readings.length === 0) continue

      let observedAt = readings[0]!.ts
      for (const reading of readings) {
        if (Date.parse(reading.ts) > Date.parse(observedAt)) observedAt = reading.ts
      }
      const ageSec = (now.getTime() - Date.parse(observedAt)) / 1000
      const maxAgeSec = MAX_AGE_SEC[draft.properties.kind]

      // EAQI must reflect current air: readings past the freshness horizon stay
      // in `values` (the popup still shows them) but must not drive the index.
      const freshValues: Partial<Record<Param, Reading>> = {}
      for (const param of PARAMS) {
        const reading = values[param]
        if (reading && (now.getTime() - Date.parse(reading.ts)) / 1000 <= maxAgeSec) {
          freshValues[param] = reading
        }
      }
      const eaqi = computeEaqi(freshValues)

      const humidity = values.humidity
      const pmHumidityBias =
        (values.pm1 !== undefined || values.pm2_5 !== undefined || values.pm10 !== undefined) &&
        humidity !== undefined &&
        humidity.v >= PM_HUMIDITY_BIAS_MIN_RH

      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [round5(draft.lon), round5(draft.lat)],
        },
        properties: {
          ...draft.properties,
          observedAt,
          stale: ageSec > maxAgeSec,
          ...(eaqi ? { eaqi: eaqi.band, eaqiPollutant: eaqi.pollutant } : {}),
          ...(pmHumidityBias ? { pmHumidityBias: true } : {}),
        },
      })
    }
  }

  const sources: IngestSourceStatus[] = results.map((result) => {
    if (result.status.ok || !previous) return result.status
    const carried = previous.features.filter((f) => f.properties.source === result.status.id)
    if (carried.length === 0) return result.status
    for (const feature of carried) {
      const ageSec = (now.getTime() - Date.parse(feature.properties.observedAt)) / 1000
      const maxAgeSec = MAX_AGE_SEC[feature.properties.kind] ?? 0
      // `!(fresh)` so an unparseable observedAt lands on stale, never on fresh.
      features.push({
        ...feature,
        properties: { ...feature.properties, stale: !(ageSec <= maxAgeSec) },
      })
    }
    return {
      ...result.status,
      carriedForward: carried.length,
      detail: `${result.status.detail ?? 'failed'}; carried forward ${carried.length} stations from previous snapshot`,
    }
  })

  // Plain code-unit comparison: byte-deterministic across runtimes, unlike localeCompare.
  features.sort((a, b) => (a.properties.id < b.properties.id ? -1 : a.properties.id > b.properties.id ? 1 : 0))

  const byKind: Partial<Record<StationKind, number>> = {}
  let withEaqi = 0
  for (const feature of features) {
    byKind[feature.properties.kind] = (byKind[feature.properties.kind] ?? 0) + 1
    if (feature.properties.eaqi !== undefined) withEaqi++
  }

  return {
    collection: { type: 'FeatureCollection', features },
    meta: {
      generatedAt: now.toISOString(),
      eaqiBandSet: EAQI_BAND_SET,
      maxAgeSec: MAX_AGE_SEC,
      counts: { stations: features.length, byKind, withEaqi },
      sources,
      attribution: ATTRIBUTIONS,
    },
  }
}
