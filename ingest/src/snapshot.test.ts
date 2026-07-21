import { ATTRIBUTIONS, MAX_AGE_SEC, type StationCollection, type StationFeature } from '@aerismap/shared'
import { describe, expect, it } from 'vitest'
import { buildSnapshot } from './snapshot'
import type { IngestSourceStatus, SourceResult, StationDraft } from './types'

const NOW = new Date('2026-07-21T12:00:00Z')

function communityDraft(overrides: Partial<StationDraft['properties']> & { lon?: number; lat?: number } = {}): StationDraft {
  const { lon = 9.2, lat = 48.53, ...props } = overrides
  return {
    lon,
    lat,
    properties: {
      id: 'sensor-community:49',
      source: 'sensor-community',
      nativeId: '49',
      kind: 'community',
      country: 'DE',
      license: 'ODbL-1.0',
      exactLocation: false,
      values: { pm2_5: { v: 12, ts: '2026-07-21T11:50:00Z' } },
      ...props,
    },
  }
}

function asResult(stations: StationDraft[], id: 'sensor-community' | 'openaq' = 'sensor-community'): SourceResult {
  return { status: { id, ok: true, fetchedAt: NOW.toISOString(), stations: stations.length }, stations }
}

describe('buildSnapshot', () => {
  it('computes observedAt as the newest reading timestamp', () => {
    const draft = communityDraft({
      values: {
        pm2_5: { v: 12, ts: '2026-07-21T11:40:00Z' },
        temperature: { v: 21, ts: '2026-07-21T11:55:00Z' },
      },
    })
    const { collection } = buildSnapshot([asResult([draft])], NOW)
    expect(collection.features[0]!.properties.observedAt).toBe('2026-07-21T11:55:00Z')
  })

  it('applies staleness per station kind', () => {
    // 3000 s old: beyond community's 2700 s, within reference's 10800 s
    const ts = new Date(NOW.getTime() - 3000 * 1000).toISOString().replace('.000Z', 'Z')
    const community = communityDraft({ values: { pm2_5: { v: 5, ts } } })
    const reference = communityDraft({
      id: 'openaq:1',
      source: 'openaq',
      nativeId: '1',
      kind: 'reference',
      license: 'per-source (OpenAQ/EEA)',
      exactLocation: true,
      values: { pm2_5: { v: 5, ts } },
    })
    const { collection } = buildSnapshot(
      [asResult([community]), asResult([reference], 'openaq')],
      NOW
    )
    const byId = new Map(collection.features.map((f) => [f.properties.id, f]))
    expect(MAX_AGE_SEC.community).toBeLessThan(3000)
    expect(byId.get('sensor-community:49')!.properties.stale).toBe(true)
    expect(byId.get('openaq:1')!.properties.stale).toBe(false)
  })

  it('attaches EAQI band and dominant pollutant when scoreable', () => {
    const draft = communityDraft({
      values: {
        pm2_5: { v: 12, ts: '2026-07-21T11:50:00Z' }, // band 2
        pm10: { v: 130, ts: '2026-07-21T11:50:00Z' }, // band 4
      },
    })
    const { collection, meta } = buildSnapshot([asResult([draft])], NOW)
    expect(collection.features[0]!.properties.eaqi).toBe(4)
    expect(collection.features[0]!.properties.eaqiPollutant).toBe('pm10')
    expect(meta.counts.withEaqi).toBe(1)
  })

  it('omits EAQI for stations without scoreable pollutants', () => {
    const draft = communityDraft({
      values: { temperature: { v: 21, ts: '2026-07-21T11:50:00Z' } },
    })
    const { collection, meta } = buildSnapshot([asResult([draft])], NOW)
    expect(collection.features[0]!.properties.eaqi).toBeUndefined()
    expect(collection.features[0]!.properties.eaqiPollutant).toBeUndefined()
    expect(meta.counts.withEaqi).toBe(0)
  })

  it('rounds coordinates to 5 decimals', () => {
    const draft = communityDraft({ lon: 9.123456789, lat: 48.987654321 })
    const { collection } = buildSnapshot([asResult([draft])], NOW)
    expect(collection.features[0]!.geometry.coordinates).toEqual([9.12346, 48.98765])
  })

  it('is deterministic: sorted by id and byte-identical across input orderings', () => {
    const a = communityDraft()
    const b = communityDraft({ id: 'sensor-community:100', nativeId: '100' })
    const c = communityDraft({ id: 'openaq:7', source: 'openaq', nativeId: '7', kind: 'reference' })
    const one = buildSnapshot([asResult([b, a, c])], NOW)
    const two = buildSnapshot([asResult([c, a, b])], NOW)
    expect(one.collection.features.map((f) => f.properties.id)).toEqual([
      'openaq:7',
      'sensor-community:100',
      'sensor-community:49',
    ])
    expect(JSON.stringify(one.collection)).toBe(JSON.stringify(two.collection))
  })

  it('assembles meta counts, source statuses and attribution', () => {
    const community = communityDraft()
    const failed: SourceResult = {
      status: { id: 'openaq', ok: false, detail: 'OPENAQ_API_KEY not set; official layer skipped' },
      stations: [],
    }
    const { meta } = buildSnapshot([asResult([community]), failed], NOW)
    expect(meta.generatedAt).toBe(NOW.toISOString())
    expect(meta.eaqiBandSet).toBe('eaqi-2025')
    expect(meta.maxAgeSec).toEqual(MAX_AGE_SEC)
    expect(meta.counts).toEqual({
      stations: 1,
      byKind: { community: 1 },
      withEaqi: 1,
      qcFlaggedStations: 0,
      hotspots: 0,
    })
    expect(meta.sources).toEqual([
      { id: 'sensor-community', ok: true, fetchedAt: NOW.toISOString(), stations: 1 },
      { id: 'openaq', ok: false, detail: 'OPENAQ_API_KEY not set; official layer skipped' },
    ])
    expect(meta.attribution).toEqual(ATTRIBUTIONS)
  })

  it('drops drafts with no readings at all', () => {
    const empty = communityDraft({ values: {} })
    const { collection, meta } = buildSnapshot([asResult([empty])], NOW)
    expect(collection.features).toHaveLength(0)
    expect(meta.counts.stations).toBe(0)
  })

  it('excludes readings past the freshness horizon from EAQI but keeps them in values', () => {
    const oldTs = new Date(NOW.getTime() - (MAX_AGE_SEC.community + 60) * 1000)
      .toISOString()
      .replace('.000Z', 'Z')
    const draft = communityDraft({
      values: {
        pm10: { v: 130, ts: oldTs }, // band 4 but too old to drive the index
        pm2_5: { v: 12, ts: '2026-07-21T11:50:00Z' }, // band 2, fresh
      },
    })
    const { collection } = buildSnapshot([asResult([draft])], NOW)
    const props = collection.features[0]!.properties
    expect(props.values.pm10).toEqual({ v: 130, ts: oldTs }) // popup still shows it
    expect(props.eaqi).toBe(2)
    expect(props.eaqiPollutant).toBe('pm2_5')
  })

  it('omits EAQI entirely when every scoreable reading is past the horizon', () => {
    const oldTs = new Date(NOW.getTime() - (MAX_AGE_SEC.community + 60) * 1000)
      .toISOString()
      .replace('.000Z', 'Z')
    const draft = communityDraft({ values: { pm2_5: { v: 12, ts: oldTs } } })
    const { collection, meta } = buildSnapshot([asResult([draft])], NOW)
    expect(collection.features[0]!.properties.eaqi).toBeUndefined()
    expect(collection.features[0]!.properties.values.pm2_5?.v).toBe(12)
    expect(meta.counts.withEaqi).toBe(0)
  })

  it('applies spatial QC before the counts: a railed sensor is flagged and loses its EAQI', () => {
    const ts = '2026-07-21T11:50:00Z'
    // 0.1° lat ≈ 11 km — three clean neighbors well within the 50 km radius
    const railed = communityDraft({
      id: 'sensor-community:900',
      nativeId: '900',
      values: { pm2_5: { v: 500, ts } },
    })
    const cleans = [1, 2, 3].map((i) =>
      communityDraft({
        id: `sensor-community:90${i}`,
        nativeId: `90${i}`,
        lat: 48.53 + i * 0.1,
        values: { pm2_5: { v: 10, ts } },
      })
    )
    const { collection, meta } = buildSnapshot([asResult([railed, ...cleans])], NOW)
    const byId = new Map(collection.features.map((f) => [f.properties.id, f.properties]))
    expect(byId.get('sensor-community:900')!.qc).toEqual(['pm2_5'])
    expect(byId.get('sensor-community:900')!.eaqi).toBeUndefined() // only scoreable reading flagged
    expect(byId.get('sensor-community:900')!.values.pm2_5?.v).toBe(500) // popup still shows it
    expect(byId.get('sensor-community:901')!.qc).toBeUndefined()
    expect(meta.counts.qcFlaggedStations).toBe(1)
    expect(meta.counts.withEaqi).toBe(3) // counted AFTER the QC recompute
    expect(meta.counts.hotspots).toBe(0)
  })

  it('promotes a lone reference station at band ≥ 4 to hotspot and counts it', () => {
    const reference = communityDraft({
      id: 'openaq:1',
      source: 'openaq',
      nativeId: '1',
      kind: 'reference',
      license: 'per-source (OpenAQ/EEA)',
      values: { no2: { v: 70, ts: '2026-07-21T11:50:00Z' } }, // band 4
    })
    const { collection, meta } = buildSnapshot([asResult([reference], 'openaq')], NOW)
    expect(collection.features[0]!.properties.hotspot).toBe(true)
    expect(meta.counts.hotspots).toBe(1)
  })

  it('flags pmHumidityBias only when PM coincides with humidity ≥ 95%', () => {
    const ts = '2026-07-21T11:50:00Z'
    const flagged = communityDraft({
      values: { pm2_5: { v: 40, ts }, humidity: { v: 96.2, ts } },
    })
    const dry = communityDraft({
      id: 'sensor-community:100',
      nativeId: '100',
      values: { pm2_5: { v: 40, ts }, humidity: { v: 94.9, ts } },
    })
    const noPm = communityDraft({
      id: 'sensor-community:101',
      nativeId: '101',
      values: { temperature: { v: 12, ts }, humidity: { v: 99, ts } },
    })
    const { collection } = buildSnapshot([asResult([flagged, dry, noPm])], NOW)
    const byId = new Map(collection.features.map((f) => [f.properties.id, f]))
    expect(byId.get('sensor-community:49')!.properties.pmHumidityBias).toBe(true)
    expect(byId.get('sensor-community:100')!.properties.pmHumidityBias).toBeUndefined()
    expect(byId.get('sensor-community:101')!.properties.pmHumidityBias).toBeUndefined()
  })
})

describe('buildSnapshot carry-forward', () => {
  function previousFeature(
    id: string,
    source: 'sensor-community' | 'openaq',
    observedAt: string
  ): StationFeature {
    const reference = source === 'openaq'
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [13.46966, 52.51407] },
      properties: {
        id,
        source,
        nativeId: id.split(':')[1]!,
        kind: reference ? 'reference' : 'community',
        license: reference ? 'per-source (OpenAQ/EEA)' : 'ODbL-1.0',
        exactLocation: reference,
        observedAt,
        stale: false,
        values: { pm10: { v: 21, ts: observedAt } },
        eaqi: 2,
        eaqiPollutant: 'pm10',
      },
    }
  }

  // 2 h old (fresh for reference), 7 h old (stale for reference), 10 min old
  const previous: StationCollection = {
    type: 'FeatureCollection',
    features: [
      previousFeature('openaq:10496', 'openaq', '2026-07-21T10:00:00Z'),
      previousFeature('openaq:2162', 'openaq', '2026-07-21T05:00:00Z'),
      previousFeature('sensor-community:49', 'sensor-community', '2026-07-21T11:50:00Z'),
    ],
  }
  const failedOpenaq: SourceResult = {
    status: { id: 'openaq', ok: false, detail: 'implausibly low yield: 3 stations < floor 100' },
    stations: [],
  }

  it('carries a failed source forward with staleness recomputed and values/EAQI untouched', () => {
    const { collection, meta } = buildSnapshot([asResult([communityDraft()]), failedOpenaq], NOW, previous)
    expect(collection.features.map((f) => f.properties.id)).toEqual([
      'openaq:10496',
      'openaq:2162',
      'sensor-community:49',
    ])
    const byId = new Map(collection.features.map((f) => [f.properties.id, f]))
    expect(byId.get('openaq:10496')!.properties.stale).toBe(false)
    expect(byId.get('openaq:10496')!.properties.eaqi).toBe(2)
    expect(byId.get('openaq:10496')!.properties.values.pm10).toEqual({
      v: 21,
      ts: '2026-07-21T10:00:00Z',
    })
    expect(byId.get('openaq:2162')!.properties.stale).toBe(true)
    // the fresh sensor-community result wins over its previous copy
    expect(byId.get('sensor-community:49')!.properties.values.pm2_5).toEqual({
      v: 12,
      ts: '2026-07-21T11:50:00Z',
    })
    expect(meta.counts).toEqual({
      stations: 3,
      byKind: { reference: 2, community: 1 },
      withEaqi: 3,
      qcFlaggedStations: 0,
      hotspots: 0,
    })
    const openaqStatus = meta.sources.find((s) => s.id === 'openaq') as IngestSourceStatus
    expect(openaqStatus.ok).toBe(false)
    expect(openaqStatus.carriedForward).toBe(2)
    expect(openaqStatus.detail).toBe(
      'implausibly low yield: 3 stations < floor 100; carried forward 2 stations from previous snapshot'
    )
  })

  it('leaves the status untouched when the failed source contributed nothing before', () => {
    const noOpenaq: StationCollection = {
      type: 'FeatureCollection',
      features: [previousFeature('sensor-community:49', 'sensor-community', '2026-07-21T11:50:00Z')],
    }
    const { collection, meta } = buildSnapshot([asResult([communityDraft()]), failedOpenaq], NOW, noOpenaq)
    expect(collection.features.map((f) => f.properties.id)).toEqual(['sensor-community:49'])
    expect(meta.sources.find((s) => s.id === 'openaq')).toEqual(failedOpenaq.status)
  })

  it('behaves as before when no previous snapshot is available', () => {
    const { collection, meta } = buildSnapshot([asResult([communityDraft()]), failedOpenaq], NOW)
    expect(collection.features.map((f) => f.properties.id)).toEqual(['sensor-community:49'])
    expect(meta.sources.find((s) => s.id === 'openaq')).toEqual(failedOpenaq.status)
  })
})
