import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  MAX_AGE_SEC,
  regionBandAllowed,
  type StationCollection,
  type StationFeature,
  type StationProperties,
} from '@aerismap/shared'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ASSIGN_BOUNDARIES_PATH,
  assignRegion,
  buildAreas,
  buildAreasForRun,
  loadBoundaryIndex,
  median1,
  prepareBoundaryIndex,
} from './areas'

const NOW = new Date('2026-07-21T12:00:00Z')
const FRESH_TS = '2026-07-21T11:50:00Z' // 600 s old: fresh for every kind

/**
 * Synthetic NUTS-3 fixture (unit tests never parse the real 1:3M file):
 *
 *   AA011  square lon 10–11, lat 50–51        parent AA01
 *   AA012  square lon 11–12, lat 50–51        parent AA01
 *   AA021  square lon 10–12, lat 51–52        parent AA02
 *   BB011  MultiPolygon: square lon 20–21 lat 50–51 with a hole
 *          (20.4–20.6 × 50.4–50.6) + a detached part lon 21.5–22 lat 50–51
 */
function square(minLon: number, minLat: number, maxLon: number, maxLat: number): number[][] {
  return [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ]
}

const FIXTURE = {
  type: 'FeatureCollection' as const,
  features: [
    {
      type: 'Feature' as const,
      properties: { NUTS_ID: 'AA011' },
      geometry: { type: 'Polygon' as const, coordinates: [square(10, 50, 11, 51)] },
    },
    {
      type: 'Feature' as const,
      properties: { NUTS_ID: 'AA012' },
      geometry: { type: 'Polygon' as const, coordinates: [square(11, 50, 12, 51)] },
    },
    {
      type: 'Feature' as const,
      properties: { NUTS_ID: 'AA021' },
      geometry: { type: 'Polygon' as const, coordinates: [square(10, 51, 12, 52)] },
    },
    {
      type: 'Feature' as const,
      properties: { NUTS_ID: 'BB011' },
      geometry: {
        type: 'MultiPolygon' as const,
        coordinates: [
          [square(20, 50, 21, 51), square(20.4, 50.4, 20.6, 50.6)],
          [square(21.5, 50, 22, 51)],
        ],
      },
    },
  ],
}

const INDEX = prepareBoundaryIndex(FIXTURE)

function station(
  id: string,
  lon: number,
  lat: number,
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
      values: { pm2_5: { v: 10, ts: FRESH_TS } },
      ...overrides,
    },
  }
}

function collect(features: StationFeature[]): StationCollection {
  return { type: 'FeatureCollection', features }
}

describe('prepareBoundaryIndex', () => {
  it('counts NUTS-3 regions, distinct NUTS-2 prefixes and the combined universe', () => {
    expect(INDEX.nuts3Count).toBe(4)
    expect(INDEX.nuts2Count).toBe(3) // AA01, AA02, BB01
    expect(INDEX.totalRegions).toBe(7)
  })

  it('rejects malformed input', () => {
    expect(() => prepareBoundaryIndex({ type: 'FeatureCollection', features: 1 as never })).toThrow(
      /not a FeatureCollection/
    )
    expect(() =>
      prepareBoundaryIndex({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { NUTS_ID: 'X' },
            geometry: { type: 'Polygon', coordinates: [square(0, 0, 1, 1)] },
          },
        ],
      })
    ).toThrow(/missing\/short NUTS_ID/)
  })
})

describe('assignRegion', () => {
  it('assigns interior points to their polygon', () => {
    expect(assignRegion(INDEX, 10.5, 50.5)).toBe('AA011')
    expect(assignRegion(INDEX, 11.5, 50.5)).toBe('AA012')
    expect(assignRegion(INDEX, 11, 51.5)).toBe('AA021')
  })

  it('handles MultiPolygon parts and holes', () => {
    expect(assignRegion(INDEX, 20.2, 50.2)).toBe('BB011') // first part
    expect(assignRegion(INDEX, 21.75, 50.5)).toBe('BB011') // detached part
    // hole center: ~13 km from the nearest hole vertex, so no fallback either
    expect(assignRegion(INDEX, 20.5, 50.5)).toBeUndefined()
  })

  it('falls back to the nearest polygon vertex within ~2 km for coastal misses', () => {
    // just outside AA011's west edge, ~0.9 km from the (10, 50) corner
    expect(assignRegion(INDEX, 9.99, 50.005)).toBe('AA011')
    // outside every expanded bbox
    expect(assignRegion(INDEX, 5, 45)).toBeUndefined()
    // inside the expanded bbox but > 2 km from any vertex
    expect(assignRegion(INDEX, 9.99, 50.5)).toBeUndefined()
  })
})

describe('median1', () => {
  it('takes the middle value for odd counts and the midpoint for even counts', () => {
    expect(median1([4, 1, 2])).toBe(2)
    expect(median1([2, 1])).toBe(1.5)
    expect(median1([7])).toBe(7)
  })

  it('rounds to 1 decimal, negatives included', () => {
    expect(median1([10.04])).toBe(10)
    expect(median1([10.06])).toBe(10.1)
    expect(median1([-2.4, -2.2])).toBe(-2.3)
  })
})

describe('buildAreas', () => {
  it('aggregates NUTS-2 over its stations directly, not median-of-medians', () => {
    const built = buildAreas(
      collect([
        station('sensor-community:1', 10.5, 50.5, { values: { pm2_5: { v: 10, ts: FRESH_TS } } }),
        station('sensor-community:2', 11.5, 50.5, { values: { pm2_5: { v: 20, ts: FRESH_TS } } }),
        station('sensor-community:3', 11.6, 50.6, { values: { pm2_5: { v: 30, ts: FRESH_TS } } }),
      ]),
      INDEX,
      NOW
    )
    expect(built.snapshot.areas['AA011']?.med?.pm2_5).toBe(10)
    expect(built.snapshot.areas['AA012']?.med?.pm2_5).toBe(25)
    // direct median over [10, 20, 30] = 20; median-of-medians would be 17.5
    expect(built.snapshot.areas['AA01']?.med?.pm2_5).toBe(20)
    expect(built.snapshot.areas['AA01']?.cnt?.pm2_5).toBe(3)
    expect(built.snapshot.areas['AA01']?.n).toBe(3)
  })

  it('counts stations by kind and excludes model and stale stations entirely', () => {
    const built = buildAreas(
      collect([
        station('sensor-community:1', 10.5, 50.5),
        station('openaq:1', 10.6, 50.6, {
          source: 'openaq',
          kind: 'reference',
          license: 'per-source (OpenAQ/EEA)',
        }),
        station('open-meteo:1', 10.7, 50.7, { source: 'open-meteo', kind: 'model' }),
        station('sensor-community:2', 10.8, 50.8, { stale: true }),
      ]),
      INDEX,
      NOW
    )
    const aa011 = built.snapshot.areas['AA011']!
    expect(aa011.n).toBe(2)
    expect(aa011.nRef).toBe(1)
    expect(aa011.nCom).toBe(1)
    expect(aa011.cnt?.pm2_5).toBe(2)
  })

  it('counts stations outside every polygon as unassigned without failing', () => {
    const built = buildAreas(
      collect([
        station('sensor-community:1', 10.5, 50.5),
        station('sensor-community:2', 37.62, 55.75), // no polygons out east by design
      ]),
      INDEX,
      NOW
    )
    expect(built.unassignedStations).toBe(1)
    expect(Object.keys(built.snapshot.areas)).toEqual(['AA01', 'AA011'])
  })

  it('enriches hotspot stations with their region bands for the contrast rule', () => {
    const hotspot = station('sensor-community:hot', 10.5, 50.5, {
      values: { pm2_5: { v: 95, ts: FRESH_TS } },
      eaqi: 5,
      hotspot: true,
    })
    const built = buildAreas(
      collect([
        hotspot,
        station('sensor-community:2', 10.6, 50.6, { values: { pm2_5: { v: 4, ts: FRESH_TS } } }),
        station('sensor-community:3', 10.7, 50.7, { values: { pm2_5: { v: 6, ts: FRESH_TS } } }),
      ]),
      INDEX,
      NOW
    )
    // AA011 median pm2_5 = 6 → band 2; the hotspot's marker must carry it.
    expect(built.snapshot.areas['AA011']?.eaqi).toBe(2)
    expect(hotspot.properties.regionBands).toEqual({ n2: 2, n3: 2 })
  })

  it('leaves hotspot stations unenriched when their regions publish no band', () => {
    const hotspot = station('sensor-community:solo-hot', 20.2, 50.2, {
      values: { pm2_5: { v: 95, ts: FRESH_TS } },
      eaqi: 5,
      hotspot: true,
    })
    const built = buildAreas(collect([hotspot]), INDEX, NOW)
    // Single station claiming band 5: graduated gating publishes no region
    // band, so there is nothing to contrast against — ring always shows.
    expect(built.snapshot.areas['BB011']?.eaqi).toBeUndefined()
    expect(hotspot.properties.regionBands).toBeUndefined()
  })

  it('includes coarsened-coordinate stations', () => {
    const built = buildAreas(
      collect([station('sensor-community:1', 10.5, 50.5, { exactLocation: false })]),
      INDEX,
      NOW
    )
    expect(built.snapshot.areas['AA011']?.n).toBe(1)
  })

  it('excludes PM readings of pmHumidityBias stations while keeping their other params', () => {
    const built = buildAreas(
      collect([
        station('sensor-community:1', 10.5, 50.5, {
          pmHumidityBias: true,
          values: {
            pm2_5: { v: 80, ts: FRESH_TS },
            pm10: { v: 90, ts: FRESH_TS },
            no2: { v: 30, ts: FRESH_TS },
            temperature: { v: 21, ts: FRESH_TS },
            humidity: { v: 97, ts: FRESH_TS },
          },
        }),
        station('sensor-community:2', 10.6, 50.6, { values: { pm2_5: { v: 10, ts: FRESH_TS } } }),
      ]),
      INDEX,
      NOW
    )
    const aa011 = built.snapshot.areas['AA011']!
    expect(aa011.med?.pm2_5).toBe(10) // biased 80 dropped
    expect(aa011.cnt?.pm2_5).toBe(1)
    expect(aa011.med?.pm10).toBeUndefined()
    expect(aa011.med?.no2).toBe(30)
    expect(aa011.med?.temperature).toBe(21)
  })

  it('applies the per-kind freshness horizon to individual readings', () => {
    // 3000 s old: past community's 2700 s, within reference's 10800 s
    const oldTs = new Date(NOW.getTime() - 3000 * 1000).toISOString().replace('.000Z', 'Z')
    expect(MAX_AGE_SEC.community).toBeLessThan(3000)
    expect(MAX_AGE_SEC.reference).toBeGreaterThan(3000)
    const built = buildAreas(
      collect([
        station('sensor-community:1', 10.5, 50.5, {
          values: { pm2_5: { v: 40, ts: oldTs }, temperature: { v: 20, ts: FRESH_TS } },
        }),
        station('openaq:1', 11.5, 50.5, {
          source: 'openaq',
          kind: 'reference',
          values: { pm2_5: { v: 40, ts: oldTs } },
        }),
      ]),
      INDEX,
      NOW
    )
    const community = built.snapshot.areas['AA011']!
    expect(community.cnt?.pm2_5).toBeUndefined() // too old for community
    expect(community.med?.temperature).toBe(20)
    expect(community.n).toBe(1) // the station itself still counts
    const reference = built.snapshot.areas['AA012']!
    expect(reference.cnt?.pm2_5).toBe(1) // same age, still fresh for reference
  })

  it('graduated gating truth table: one station may say "fine" (band ≤ 3), never "emergency"', () => {
    // shared gate, pinned: cnt ≥ 2 always allowed; cnt == 1 only bands ≤ 3
    expect(regionBandAllowed(2, 1)).toBe(true)
    expect(regionBandAllowed(3, 1)).toBe(true)
    expect(regionBandAllowed(4, 1)).toBe(false)
    expect(regionBandAllowed(5, 1)).toBe(false)
    expect(regionBandAllowed(6, 2)).toBe(true)

    const single = (v: number) =>
      buildAreas(
        collect([station('sensor-community:1', 10.5, 50.5, { values: { pm2_5: { v, ts: FRESH_TS } } })]),
        INDEX,
        NOW
      ).snapshot.areas['AA011']!

    const band2 = single(10) // cnt 1 × band 2 → colors (the ≥3 cliff is gone)
    expect(band2.eaqi).toBe(2)
    expect(band2.pollutant).toBe('pm2_5')

    const band3 = single(50) // cnt 1 × band 3 → still allowed
    expect(band3.eaqi).toBe(3)

    const band4 = single(60) // cnt 1 × band 4 → blocked
    expect(band4.eaqi).toBeUndefined()
    expect(band4.pollutant).toBeUndefined()
    expect(band4.med?.pm2_5).toBe(60) // stats still published for n ≥ 1

    const band5 = single(100) // cnt 1 × band 5 → blocked
    expect(band5.eaqi).toBeUndefined()
    expect(band5.cnt?.pm2_5).toBe(1)
  })

  it('two-station rule: band from the MIN of the two values, published med unchanged', () => {
    const built = buildAreas(
      collect([
        station('sensor-community:1', 10.5, 50.5, { values: { pm2_5: { v: 10, ts: FRESH_TS } } }),
        station('sensor-community:2', 10.6, 50.6, { values: { pm2_5: { v: 999, ts: FRESH_TS } } }),
      ]),
      INDEX,
      NOW
    )
    const aa011 = built.snapshot.areas['AA011']!
    expect(aa011.med?.pm2_5).toBe(504.5) // median stays the published med
    expect(aa011.cnt?.pm2_5).toBe(2)
    expect(aa011.eaqi).toBe(2) // band from min(10, 999) — one liar can't paint a region
    expect(aa011.pollutant).toBe('pm2_5')
  })

  it('two-station rule still shows emergency when BOTH stations corroborate it', () => {
    const built = buildAreas(
      collect([
        station('sensor-community:1', 10.5, 50.5, { values: { pm2_5: { v: 150, ts: FRESH_TS } } }),
        station('sensor-community:2', 10.6, 50.6, { values: { pm2_5: { v: 200, ts: FRESH_TS } } }),
      ]),
      INDEX,
      NOW
    )
    // min(150, 200) = 150 → band 6, allowed at cnt 2
    expect(built.snapshot.areas['AA011']!.eaqi).toBe(6)
  })

  it('a blocked single-sensor severe band does not stop an allowed pollutant from coloring', () => {
    const built = buildAreas(
      collect([
        // pm2_5 cnt 1 at band 5 (blocked); no2 cnt 2 min 30 → band 3 (allowed)
        station('sensor-community:1', 10.5, 50.5, {
          values: { pm2_5: { v: 100, ts: FRESH_TS }, no2: { v: 30, ts: FRESH_TS } },
        }),
        station('sensor-community:2', 10.6, 50.6, { values: { no2: { v: 35, ts: FRESH_TS } } }),
      ]),
      INDEX,
      NOW
    )
    const aa011 = built.snapshot.areas['AA011']!
    expect(aa011.eaqi).toBe(3)
    expect(aa011.pollutant).toBe('no2')
    expect(aa011.med?.pm2_5).toBe(100) // the blocked value stays visible in stats
  })

  it('excludes qc-flagged readings from medians and counts, keeping other params', () => {
    const built = buildAreas(
      collect([
        station('sensor-community:railed', 10.5, 50.5, {
          qc: ['pm2_5'],
          values: { pm2_5: { v: 999, ts: FRESH_TS }, no2: { v: 30, ts: FRESH_TS } },
        }),
        station('sensor-community:2', 10.6, 50.6, {
          values: { pm2_5: { v: 10, ts: FRESH_TS }, no2: { v: 34, ts: FRESH_TS } },
        }),
      ]),
      INDEX,
      NOW
    )
    const aa011 = built.snapshot.areas['AA011']!
    expect(aa011.n).toBe(2) // the station still counts, only its flagged reading is dropped
    expect(aa011.med?.pm2_5).toBe(10)
    expect(aa011.cnt?.pm2_5).toBe(1)
    expect(aa011.med?.no2).toBe(32) // unflagged param of the flagged station still contributes
    expect(aa011.cnt?.no2).toBe(2)
    // pm2_5 cnt 1 band 2 and no2 cnt 2 min 30 band 3 → worst allowed = 3
    expect(aa011.eaqi).toBe(3)
    expect(aa011.pollutant).toBe('no2')
  })

  it('leaves a region uncolored when its only readings are qc-flagged', () => {
    const built = buildAreas(
      collect([
        station('sensor-community:railed', 10.5, 50.5, {
          qc: ['pm2_5'],
          values: { pm2_5: { v: 999, ts: FRESH_TS } },
        }),
      ]),
      INDEX,
      NOW
    )
    const aa011 = built.snapshot.areas['AA011']!
    expect(aa011.n).toBe(1)
    expect(aa011.med).toBeUndefined()
    expect(aa011.cnt).toBeUndefined()
    expect(aa011.eaqi).toBeUndefined()
    expect(built.areasColored).toBe(0)
  })

  it('composes qc and pmHumidityBias exclusions — either alone drops the reading', () => {
    const built = buildAreas(
      collect([
        station('sensor-community:both', 10.5, 50.5, {
          qc: ['pm2_5'],
          pmHumidityBias: true,
          values: { pm2_5: { v: 999, ts: FRESH_TS }, humidity: { v: 97, ts: FRESH_TS } },
        }),
        station('sensor-community:2', 10.6, 50.6, { values: { pm2_5: { v: 10, ts: FRESH_TS } } }),
      ]),
      INDEX,
      NOW
    )
    const aa011 = built.snapshot.areas['AA011']!
    expect(aa011.med?.pm2_5).toBe(10)
    expect(aa011.cnt?.pm2_5).toBe(1)
  })

  it('colors with the worst pollutant that meets the per-pollutant threshold', () => {
    const built = buildAreas(
      collect([
        // pm2_5 median 10 → band 2 (cnt 3); no2 median 70 → band 4 (cnt 2)
        station('sensor-community:1', 10.5, 50.5, {
          values: { pm2_5: { v: 10, ts: FRESH_TS }, no2: { v: 70, ts: FRESH_TS } },
        }),
        station('sensor-community:2', 10.6, 50.6, {
          values: { pm2_5: { v: 10, ts: FRESH_TS }, no2: { v: 70, ts: FRESH_TS } },
        }),
        station('sensor-community:3', 10.7, 50.7, { values: { pm2_5: { v: 10, ts: FRESH_TS } } }),
      ]),
      INDEX,
      NOW
    )
    const aa011 = built.snapshot.areas['AA011']!
    expect(aa011.eaqi).toBe(4)
    expect(aa011.pollutant).toBe('no2')
  })

  it('ignores a worse pollutant measured by too few stations', () => {
    const built = buildAreas(
      collect([
        // pm2_5 median 10 → band 2 (cnt 3); so2 300 → band 6 but cnt 1
        station('sensor-community:1', 10.5, 50.5, {
          values: { pm2_5: { v: 10, ts: FRESH_TS }, so2: { v: 300, ts: FRESH_TS } },
        }),
        station('sensor-community:2', 10.6, 50.6, { values: { pm2_5: { v: 10, ts: FRESH_TS } } }),
        station('sensor-community:3', 10.7, 50.7, { values: { pm2_5: { v: 10, ts: FRESH_TS } } }),
      ]),
      INDEX,
      NOW
    )
    const aa011 = built.snapshot.areas['AA011']!
    expect(aa011.eaqi).toBe(2)
    expect(aa011.pollutant).toBe('pm2_5')
    expect(aa011.cnt?.so2).toBe(1)
  })

  it('breaks band ties by EAQI pollutant order (first wins, like computeEaqi)', () => {
    const values = {
      pm2_5: { v: 20, ts: FRESH_TS }, // band 3
      pm10: { v: 50, ts: FRESH_TS }, // band 3
    }
    const built = buildAreas(
      collect([
        station('sensor-community:1', 10.5, 50.5, { values }),
        station('sensor-community:2', 10.6, 50.6, { values }),
        station('sensor-community:3', 10.7, 50.7, { values }),
      ]),
      INDEX,
      NOW
    )
    const aa011 = built.snapshot.areas['AA011']!
    expect(aa011.eaqi).toBe(3)
    expect(aa011.pollutant).toBe('pm2_5')
  })

  it('publishes a station-only region when nothing maps to AREA_PARAMS', () => {
    const built = buildAreas(
      collect([station('sensor-community:1', 10.5, 50.5, { values: { co: { v: 300, ts: FRESH_TS } } })]),
      INDEX,
      NOW
    )
    const aa011 = built.snapshot.areas['AA011']!
    expect(aa011.n).toBe(1)
    expect(aa011.med).toBeUndefined()
    expect(aa011.cnt).toBeUndefined()
  })

  it('stamps generatedAt and reports areasColored/areasTotal', () => {
    const three = (region: 'AA011' | 'AA021') => {
      const [lon, lat] = region === 'AA011' ? [10.5, 50.5] : [10.5, 51.5]
      return [
        station(`sensor-community:${region}-1`, lon, lat),
        station(`sensor-community:${region}-2`, lon + 0.1, lat),
        station(`sensor-community:${region}-3`, lon + 0.2, lat),
      ]
    }
    const built = buildAreas(collect([...three('AA011'), ...three('AA021')]), INDEX, NOW)
    expect(built.snapshot.generatedAt).toBe(NOW.toISOString())
    // AA011, AA021 and their NUTS-2 parents AA01, AA02 all reach n ≥ 3
    expect(built.areasColored).toBe(4)
    expect(built.areasTotal).toBe(INDEX.totalRegions)
  })

  it('is deterministic: sorted keys, byte-identical across input orderings', () => {
    const stations = [
      station('sensor-community:1', 11.5, 50.5),
      station('sensor-community:2', 10.5, 50.5),
      station('sensor-community:3', 10.5, 51.5),
    ]
    const one = buildAreas(collect(stations), INDEX, NOW)
    const two = buildAreas(collect([...stations].reverse()), INDEX, NOW)
    expect(Object.keys(one.snapshot.areas)).toEqual(['AA01', 'AA011', 'AA012', 'AA02', 'AA021'])
    expect(JSON.stringify(one.snapshot)).toBe(JSON.stringify(two.snapshot))
  })
})

describe('buildAreasForRun', () => {
  const dirs: string[] = []
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  it('builds areas from a gzipped boundary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aerismap-areas-test-'))
    dirs.push(dir)
    const path = join(dir, 'nuts3-assign.geojson.gz')
    await writeFile(path, gzipSync(Buffer.from(JSON.stringify(FIXTURE))))
    const built = await buildAreasForRun(collect([station('sensor-community:1', 10.5, 50.5)]), NOW, {
      path,
      warn: () => {
        throw new Error('unexpected warning')
      },
    })
    expect(built?.snapshot.areas['AA011']?.n).toBe(1)
  })

  it('degrades to a ::warning and no artifact when boundaries cannot be loaded', async () => {
    const warnings: string[] = []
    const built = await buildAreasForRun(collect([]), NOW, {
      path: '/nonexistent/nuts3-assign.geojson.gz',
      warn: (m) => warnings.push(m),
    })
    expect(built).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^::warning::area aggregation failed:/)
    expect(warnings[0]).toContain('previous areas artifact stays in place')
  })
})

// The ONE test allowed to parse the real vendored 1:3M file (~1.8 MB gz).
describe('vendored assignment boundaries (smoke)', () => {
  it('exists, has the expected region universe, and assigns known points', async () => {
    await access(ASSIGN_BOUNDARIES_PATH)
    const index = await loadBoundaryIndex()
    // 1,345 NUTS-2024 + 179 UK NUTS-2021 + 3 BA NUTS-2 (spliced — Bosnia has
    // no NUTS-3 subdivision, so its NUTS-2 units live in the NUTS-3 layer too)
    expect(index.nuts3Count).toBe(1527)
    expect(index.nuts2Count).toBe(340)
    // BA ids exist at both levels but count once: 1527 + (340 − 3)
    expect(index.totalRegions).toBe(1864)
    const prague = assignRegion(index, 14.42, 50.09)
    expect(prague).toBe('CZ010')
    expect(prague!.slice(0, 4)).toBe('CZ01')
    const london = assignRegion(index, -0.1276, 51.5074)
    expect(london).toBe('UKI32') // NUTS-2021 UK splice
    expect(assignRegion(index, 37.62, 55.75)).toBeUndefined() // Moscow: no polygons by design
  })
})
