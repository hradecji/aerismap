import {
  MAX_AGE_SEC,
  QC_RULE,
  type Param,
  type Reading,
  type StationFeature,
  type StationProperties,
} from '@aerismap/shared'
import { describe, expect, it } from 'vitest'
import { applySpatialQc, haversineKm } from './qc'

const NOW = new Date('2026-07-21T12:00:00Z')
const FRESH_TS = '2026-07-21T11:50:00Z' // 600 s old: fresh for every kind

/**
 * Geometry cheat sheet at lat ≈ 50: 0.1° lat ≈ 11.1 km, so neighbors placed
 * 0.045°–0.2° apart sit 5–22 km away — comfortably inside the 50 km radius —
 * while 0.5° lat ≈ 55.3 km sits outside it (but inside the same-or-adjacent
 * grid cell, exercising the haversine filter rather than the bucket index).
 */
function station(
  id: string,
  lon: number,
  lat: number,
  values: Partial<Record<Param, Reading>>,
  overrides: Partial<StationProperties> = {}
): StationFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      id,
      source: 'sensor-community',
      nativeId: id.split(':')[1] ?? id,
      kind: 'community',
      license: 'ODbL-1.0',
      exactLocation: true,
      observedAt: FRESH_TS,
      stale: false,
      values,
      ...overrides,
    },
  }
}

/** Station with a single fresh pm2_5 reading plus snapshot-style eaqi. */
function pm25(id: string, lon: number, lat: number, v: number): StationFeature {
  const band = v <= 5 ? 1 : v <= 15 ? 2 : v <= 50 ? 3 : v <= 90 ? 4 : v <= 140 ? 5 : 6
  return station(id, lon, lat, { pm2_5: { v, ts: FRESH_TS } }, {
    eaqi: band as StationProperties['eaqi'],
    eaqiPollutant: 'pm2_5',
  })
}

describe('haversineKm', () => {
  it('matches known distances', () => {
    expect(haversineKm(0, 0, 0, 0)).toBe(0)
    expect(haversineKm(10, 50, 10, 50.1)).toBeCloseTo(11.1, 0)
    // Prague → Brno ≈ 185 km
    expect(haversineKm(14.42, 50.09, 16.61, 49.19)).toBeCloseTo(185, -1)
  })
})

describe('applySpatialQc — flagging', () => {
  it('flags a railed sensor among clean neighbors and recomputes its EAQI away', () => {
    const features = [
      pm25('sensor-community:railed', 10, 50, 999),
      pm25('sensor-community:c1', 10, 50.1, 10),
      pm25('sensor-community:c2', 10, 50.2, 10),
      pm25('sensor-community:c3', 10, 49.9, 10),
    ]
    const summary = applySpatialQc(features, NOW)
    const byId = new Map(features.map((f) => [f.properties.id, f.properties]))
    const railed = byId.get('sensor-community:railed')!
    expect(railed.qc).toEqual(['pm2_5'])
    // only scoreable reading flagged → no eaqi at all
    expect(railed.eaqi).toBeUndefined()
    expect(railed.eaqiPollutant).toBeUndefined()
    // the reading itself stays visible for popups
    expect(railed.values.pm2_5?.v).toBe(999)
    for (const clean of ['c1', 'c2', 'c3']) {
      expect(byId.get(`sensor-community:${clean}`)!.qc).toBeUndefined()
      expect(byId.get(`sensor-community:${clean}`)!.eaqi).toBe(2)
    }
    expect(summary).toEqual({ qcFlaggedStations: 1, hotspots: 0 })
  })

  it('flags BOTH of two co-broken sensors 5 km apart — the ratio rule is immune to mutual corroboration', () => {
    // A and B are each other's nearest neighbor at 999; the neighborhood
    // MEDIAN stays anchored by the clean majority, so each still exceeds
    // ratio × median. (A mean- or nearest-neighbor-based rule would have let
    // them vouch for each other — candidate A's fatal flaw, pinned here.)
    const features = [
      pm25('sensor-community:brokenA', 10, 50, 999),
      pm25('sensor-community:brokenB', 10, 50.045, 999), // ≈ 5 km from A
      pm25('sensor-community:c1', 10, 50.1, 10),
      pm25('sensor-community:c2', 10, 50.15, 10),
      pm25('sensor-community:c3', 10, 49.9, 10),
    ]
    const summary = applySpatialQc(features, NOW)
    const byId = new Map(features.map((f) => [f.properties.id, f.properties]))
    // A's neighbor pool [999, 10, 10, 10] → median 10 → 999 > 40 ✓ (same for B)
    expect(byId.get('sensor-community:brokenA')!.qc).toEqual(['pm2_5'])
    expect(byId.get('sensor-community:brokenB')!.qc).toEqual(['pm2_5'])
    expect(summary.qcFlaggedStations).toBe(2)
  })

  it('leaves a sparse station (< minNeighbors within 50 km) unflagged — no evidence either way', () => {
    expect(QC_RULE.minNeighbors).toBe(3)
    const features = [
      pm25('sensor-community:lonely', 10, 50, 999),
      pm25('sensor-community:c1', 10, 50.1, 10),
      pm25('sensor-community:c2', 10, 50.2, 10),
    ]
    applySpatialQc(features, NOW)
    expect(features[0]!.properties.qc).toBeUndefined()
    expect(features[0]!.properties.eaqi).toBe(6) // untouched
  })

  it('ignores neighbors beyond 50 km haversine even in adjacent grid cells', () => {
    const features = [
      pm25('sensor-community:lonely', 10, 50, 999),
      // 0.5° lat ≈ 55 km: inside the ±1-cell scan window, outside the radius
      pm25('sensor-community:far1', 10, 50.5, 10),
      pm25('sensor-community:far2', 10, 50.52, 10),
      pm25('sensor-community:far3', 10, 49.5, 10),
    ]
    applySpatialQc(features, NOW)
    expect(features[0]!.properties.qc).toBeUndefined()
  })

  it('applies the 25 µg/m³ floor: a high ratio below the floor never flags', () => {
    expect(QC_RULE.floorUgM3).toBe(25)
    const build = (v: number) => [
      pm25('sensor-community:x', 10, 50, v),
      pm25('sensor-community:c1', 10, 50.1, 5),
      pm25('sensor-community:c2', 10, 50.2, 5),
      pm25('sensor-community:c3', 10, 49.9, 5),
    ]
    const below = build(24) // ratio 4.8 > 4 but under the floor
    applySpatialQc(below, NOW)
    expect(below[0]!.properties.qc).toBeUndefined()

    const atFloor = build(25) // floor is strict: x > 25
    applySpatialQc(atFloor, NOW)
    expect(atFloor[0]!.properties.qc).toBeUndefined()

    const above = build(26)
    applySpatialQc(above, NOW)
    expect(above[0]!.properties.qc).toEqual(['pm2_5'])
  })

  it('requires the ratio strictly: exactly 4× the neighborhood median passes', () => {
    const features = [
      pm25('sensor-community:x', 10, 50, 40), // exactly 4 × 10
      pm25('sensor-community:c1', 10, 50.1, 10),
      pm25('sensor-community:c2', 10, 50.2, 10),
      pm25('sensor-community:c3', 10, 49.9, 10),
    ]
    applySpatialQc(features, NOW)
    expect(features[0]!.properties.qc).toBeUndefined()
  })

  it('evaluates pm2_5 and pm10 independently and keeps the unflagged pollutant in the EAQI', () => {
    const features = [
      station(
        'sensor-community:x',
        10,
        50,
        { pm2_5: { v: 999, ts: FRESH_TS }, pm10: { v: 20, ts: FRESH_TS } },
        { eaqi: 6, eaqiPollutant: 'pm2_5' }
      ),
      station('sensor-community:c1', 10, 50.1, {
        pm2_5: { v: 10, ts: FRESH_TS },
        pm10: { v: 18, ts: FRESH_TS },
      }),
      station('sensor-community:c2', 10, 50.2, {
        pm2_5: { v: 10, ts: FRESH_TS },
        pm10: { v: 18, ts: FRESH_TS },
      }),
      station('sensor-community:c3', 10, 49.9, {
        pm2_5: { v: 10, ts: FRESH_TS },
        pm10: { v: 18, ts: FRESH_TS },
      }),
    ]
    applySpatialQc(features, NOW)
    const x = features[0]!.properties
    expect(x.qc).toEqual(['pm2_5'])
    expect(x.eaqi).toBe(2) // pm10 20 → band 2 survives
    expect(x.eaqiPollutant).toBe('pm10')
  })

  it('recomputes EAQI from the remaining unflagged pollutants (no2 takes over)', () => {
    const features = [
      station(
        'sensor-community:x',
        10,
        50,
        { pm2_5: { v: 999, ts: FRESH_TS }, no2: { v: 30, ts: FRESH_TS } },
        { eaqi: 6, eaqiPollutant: 'pm2_5' }
      ),
      pm25('sensor-community:c1', 10, 50.1, 10),
      pm25('sensor-community:c2', 10, 50.2, 10),
      pm25('sensor-community:c3', 10, 49.9, 10),
    ]
    applySpatialQc(features, NOW)
    expect(features[0]!.properties.qc).toEqual(['pm2_5'])
    expect(features[0]!.properties.eaqi).toBe(3) // no2 30 → band 3
    expect(features[0]!.properties.eaqiPollutant).toBe('no2')
  })

  it('only counts fresh neighbors, honoring the per-kind freshness horizon', () => {
    // 3000 s old: past community's 2700 s horizon, within reference's 10800 s
    const oldTs = new Date(NOW.getTime() - 3000 * 1000).toISOString().replace('.000Z', 'Z')
    expect(MAX_AGE_SEC.community).toBeLessThan(3000)
    expect(MAX_AGE_SEC.reference).toBeGreaterThan(3000)
    const staleCommunityNeighbor = (id: string, lat: number) =>
      station(id, 10, lat, { pm2_5: { v: 10, ts: oldTs } })
    const withStale = [
      pm25('sensor-community:x', 10, 50, 999),
      staleCommunityNeighbor('sensor-community:c1', 50.1),
      staleCommunityNeighbor('sensor-community:c2', 50.2),
      staleCommunityNeighbor('sensor-community:c3', 49.9),
    ]
    applySpatialQc(withStale, NOW)
    expect(withStale[0]!.properties.qc).toBeUndefined() // 0 fresh neighbors

    const referenceNeighbor = (id: string, lat: number) =>
      station(
        id,
        10,
        lat,
        { pm2_5: { v: 10, ts: oldTs } },
        { source: 'openaq', kind: 'reference', license: 'per-source (OpenAQ/EEA)' }
      )
    const withReference = [
      pm25('sensor-community:x', 10, 50, 999),
      referenceNeighbor('openaq:r1', 50.1),
      referenceNeighbor('openaq:r2', 50.2),
      referenceNeighbor('openaq:r3', 49.9),
    ]
    applySpatialQc(withReference, NOW)
    expect(withReference[0]!.properties.qc).toEqual(['pm2_5']) // same age, still fresh for reference
  })

  it('never evaluates a stale reading of the station itself', () => {
    const oldTs = new Date(NOW.getTime() - 3000 * 1000).toISOString().replace('.000Z', 'Z')
    const features = [
      station('sensor-community:x', 10, 50, { pm2_5: { v: 999, ts: oldTs } }, { stale: true }),
      pm25('sensor-community:c1', 10, 50.1, 10),
      pm25('sensor-community:c2', 10, 50.2, 10),
      pm25('sensor-community:c3', 10, 49.9, 10),
    ]
    applySpatialQc(features, NOW)
    expect(features[0]!.properties.qc).toBeUndefined()
  })

  it('clears a stale carried-forward flag: fresh-and-clean recomputes, fully-stale keeps its eaqi', () => {
    // Previously flagged, now healthy with < minNeighbors: flag cleared and
    // the eaqi restored from the reading that is no longer excluded.
    const healed = [
      station(
        'sensor-community:healed',
        10,
        50,
        { pm2_5: { v: 12, ts: FRESH_TS } },
        { qc: ['pm2_5'], eaqi: undefined }
      ),
    ]
    applySpatialQc(healed, NOW)
    expect(healed[0]!.properties.qc).toBeUndefined()
    expect(healed[0]!.properties.eaqi).toBe(2)

    // Fully-stale carry-forward: flag cleared (not recomputable) but the
    // carried eaqi stays untouched, mirroring snapshot.ts carry-forward.
    const oldTs = '2026-07-21T05:00:00Z'
    const carried = [
      station(
        'sensor-community:carried',
        10,
        50,
        { pm10: { v: 21, ts: oldTs } },
        { stale: true, observedAt: oldTs, qc: ['pm10'], eaqi: 2, eaqiPollutant: 'pm10' }
      ),
    ]
    applySpatialQc(carried, NOW)
    expect(carried[0]!.properties.qc).toBeUndefined()
    expect(carried[0]!.properties.eaqi).toBe(2)
  })
})

describe('applySpatialQc — hotspot promotion', () => {
  const NO2_FRESH = (id: string, lon: number, lat: number, v: number, band: number) =>
    station(id, lon, lat, { no2: { v, ts: FRESH_TS } }, {
      eaqi: band as StationProperties['eaqi'],
      eaqiPollutant: 'no2',
    })

  it('promotes a community station at band ≥ 4 only with a neighbor within one band', () => {
    // no2 is not a QC param, so high values cannot be flagged away here.
    const corroborated = [
      NO2_FRESH('sensor-community:hot', 10, 50, 70, 4), // band 4
      NO2_FRESH('sensor-community:n1', 10, 50.1, 50, 3), // band 3 → within 1
    ]
    const summary = applySpatialQc(corroborated, NOW)
    expect(corroborated[0]!.properties.hotspot).toBe(true)
    expect(corroborated[1]!.properties.hotspot).toBeUndefined() // band 3 < HOTSPOT_MIN_BAND
    expect(summary.hotspots).toBe(1)

    const uncorroborated = [
      NO2_FRESH('sensor-community:hot', 10, 50, 70, 4), // band 4
      NO2_FRESH('sensor-community:n1', 10, 50.1, 20, 2), // band 2 → two bands away
    ]
    expect(applySpatialQc(uncorroborated, NOW).hotspots).toBe(0)
    expect(uncorroborated[0]!.properties.hotspot).toBeUndefined()

    const alone = [NO2_FRESH('sensor-community:hot', 10, 50, 70, 4)]
    expect(applySpatialQc(alone, NOW).hotspots).toBe(0)
  })

  it('promotes a reference station at band ≥ 4 without any corroboration', () => {
    const features = [
      station(
        'openaq:hot',
        10,
        50,
        { no2: { v: 70, ts: FRESH_TS } },
        {
          source: 'openaq',
          kind: 'reference',
          license: 'per-source (OpenAQ/EEA)',
          eaqi: 4,
          eaqiPollutant: 'no2',
        }
      ),
    ]
    const summary = applySpatialQc(features, NOW)
    expect(features[0]!.properties.hotspot).toBe(true)
    expect(summary.hotspots).toBe(1)
  })

  it('never promotes on a flagged reading, and flagged neighbors cannot corroborate', () => {
    // x sits at pm2_5 85 (band 4). Its neighbor pool [999, 999, 12] has
    // median 999, so x itself stays unflagged; both railed neighbors get
    // flagged (their pools have median 85/12-dominated). The only clean
    // neighbor reads band 2 — two bands away — so x must NOT be promoted:
    // corroboration by railed sensors would resurrect exactly the false
    // hotspots the QC flag exists to kill.
    const features = [
      pm25('sensor-community:x', 10, 50, 85),
      pm25('sensor-community:railed1', 10, 50.1, 999),
      pm25('sensor-community:railed2', 10, 50.15, 999),
      pm25('sensor-community:clean', 10, 49.9, 12),
    ]
    const summary = applySpatialQc(features, NOW)
    const byId = new Map(features.map((f) => [f.properties.id, f.properties]))
    expect(byId.get('sensor-community:railed1')!.qc).toEqual(['pm2_5'])
    expect(byId.get('sensor-community:railed2')!.qc).toEqual(['pm2_5'])
    expect(byId.get('sensor-community:x')!.qc).toBeUndefined()
    expect(byId.get('sensor-community:x')!.eaqi).toBe(4)
    expect(byId.get('sensor-community:x')!.hotspot).toBeUndefined()
    // the railed stations lost their eaqi, so they cannot be hotspots either
    expect(summary.hotspots).toBe(0)
  })

  it('ignores corroborating neighbors beyond 50 km', () => {
    const features = [
      NO2_FRESH('sensor-community:hot', 10, 50, 70, 4),
      NO2_FRESH('sensor-community:far', 10, 50.5, 70, 4), // ≈ 55 km
    ]
    expect(applySpatialQc(features, NOW).hotspots).toBe(0)
  })
})
