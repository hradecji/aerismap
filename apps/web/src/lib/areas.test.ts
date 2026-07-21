/**
 * Pure-logic tests for area mode. Written against node:test so they run with
 * zero extra dependencies:
 *
 *   pnpm --filter @aerismap/web test
 *
 * (tsx only transpiles — assertions are node:assert/strict).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AREA_FULL_CONFIDENCE_STATIONS,
  ATTRIBUTIONS,
  EAQI_BAND_COLORS,
  eaqiBandForValue,
  regionBandAllowed,
  type AreaStats,
  type Attribution,
} from '@aerismap/shared'
import {
  AREA_CROSSFADE_END,
  AREA_CROSSFADE_START,
  areaBandSummary,
  areaConfidenceLabel,
  areaFillColor,
  areaFillOpacity,
  areaStateFor,
  BOUNDARY_NOTICE,
  NO_DATA_FILL,
  NUTS_SPLIT_ZOOM,
  parseAreaSnapshot,
  stationCircleOpacity,
  viewHasAreaFills,
  withBoundaryAttribution,
} from './areas'

const fullStats: AreaStats = {
  eaqi: 3,
  pollutant: 'pm2_5',
  n: 8,
  nRef: 3,
  nCom: 5,
  med: { pm2_5: 22.4, pm10: 30.1, o3: 61, temperature: 21.4 },
  cnt: { pm2_5: 6, pm10: 5, o3: 2, temperature: 4 },
}

describe('crossfade geometry', () => {
  it('orders NUTS level split before the crossfade window', () => {
    assert.ok(NUTS_SPLIT_ZOOM < AREA_CROSSFADE_START)
    assert.ok(AREA_CROSSFADE_START < AREA_CROSSFADE_END)
  })
})

describe('NO_DATA_FILL', () => {
  const channels = (hex: string) =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const spread = (hex: string) => {
    const c = channels(hex)
    return Math.max(...c) - Math.min(...c)
  }

  it('is not an EAQI band color', () => {
    assert.ok(!(EAQI_BAND_COLORS as readonly string[]).includes(NO_DATA_FILL))
  })

  it('is far less saturated than every EAQI band color', () => {
    assert.ok(spread(NO_DATA_FILL) <= 16, 'no-data gray must be near-neutral')
    for (const color of EAQI_BAND_COLORS) {
      assert.ok(spread(color) >= 90, `${color} should be clearly saturated`)
    }
  })
})

describe('regionBandAllowed (shared contract as this app relies on it)', () => {
  it('one sensor may say "fine", never "emergency"', () => {
    assert.equal(regionBandAllowed(3, 1), true)
    assert.equal(regionBandAllowed(4, 1), false)
    assert.equal(regionBandAllowed(6, 1), false)
    assert.equal(regionBandAllowed(6, 2), true)
    assert.equal(regionBandAllowed(1, 0), true)
  })
})

describe('areaStateFor', () => {
  it('exposes band, per-pollutant bands, temperature, and n for a full region', () => {
    const state = areaStateFor(fullStats)
    assert.equal(state.n, 8)
    assert.equal(state.band, 3)
    assert.equal(state.b_pm2_5, eaqiBandForValue('pm2_5', 22.4))
    assert.equal(state.b_pm10, eaqiBandForValue('pm10', 30.1))
    assert.equal(state.temp, 21.4)
  })

  it('trusts a published band even from a single station', () => {
    const state = areaStateFor({
      eaqi: 2,
      pollutant: 'pm2_5',
      n: 1,
      nRef: 0,
      nCom: 1,
      med: { pm2_5: 12 },
      cnt: { pm2_5: 1 },
    })
    assert.equal(state.n, 1)
    assert.equal(state.band, 2)
    assert.equal(state.b_pm2_5, eaqiBandForValue('pm2_5', 12))
  })

  it('emits no band when ingest withheld eaqi', () => {
    const state = areaStateFor({ n: 1, nRef: 0, nCom: 1, med: { pm2_5: 120 }, cnt: { pm2_5: 1 } })
    assert.equal('band' in state, false)
  })

  it('lets one station set a pollutant band up to 3, never severe', () => {
    const base = { n: 1, nRef: 0, nCom: 1 }
    const fine = areaStateFor({ ...base, med: { pm2_5: 30 }, cnt: { pm2_5: 1 } })
    assert.equal(fine.b_pm2_5, 3)
    const severe = areaStateFor({ ...base, med: { pm2_5: 80 }, cnt: { pm2_5: 1 } })
    assert.equal('b_pm2_5' in severe, false)
  })

  it('lets two stations set any pollutant band, severe included', () => {
    const state = areaStateFor({ n: 2, nRef: 0, nCom: 2, med: { pm2_5: 200 }, cnt: { pm2_5: 2 } })
    assert.equal(state.b_pm2_5, 6)
  })

  it('treats a missing cnt entry as zero: low bands pass, severe are withheld', () => {
    const base = { n: 4, nRef: 0, nCom: 4 }
    const low = areaStateFor({ ...base, med: { pm2_5: 30 } })
    assert.equal(low.b_pm2_5, 3)
    const severe = areaStateFor({ ...base, med: { pm2_5: 100 } })
    assert.equal('b_pm2_5' in severe, false)
  })

  it('temperature and humidity need only one counted station', () => {
    const state = areaStateFor({
      n: 1,
      nRef: 0,
      nCom: 1,
      med: { temperature: 21.4, humidity: 61.5 },
      cnt: { temperature: 1, humidity: 1 },
    })
    assert.equal(state.temp, 21.4)
    assert.equal(state.hum, 61.5)
  })

  it('withholds temperature with no counted stations at all', () => {
    const state = areaStateFor({ n: 1, nRef: 0, nCom: 1, med: { temperature: 21.4 } })
    assert.equal('temp' in state, false)
  })

  it('handles a stats object with no medians', () => {
    const state = areaStateFor({ n: 5, nRef: 5, nCom: 0 })
    assert.deepEqual(state, { n: 5 })
  })
})

describe('areaBandSummary', () => {
  it('reports the band and driving pollutant', () => {
    assert.deepEqual(areaBandSummary(fullStats), {
      kind: 'band',
      band: 3,
      pollutant: 'pm2_5',
    })
  })

  it('reports the band even for one- and two-station regions', () => {
    assert.deepEqual(areaBandSummary({ ...fullStats, n: 1 }), {
      kind: 'band',
      band: 3,
      pollutant: 'pm2_5',
    })
    assert.deepEqual(areaBandSummary({ ...fullStats, n: 2 }), {
      kind: 'band',
      band: 3,
      pollutant: 'pm2_5',
    })
  })

  it('reports too few stations only when none are included', () => {
    assert.deepEqual(areaBandSummary(null), { kind: 'too-few-stations', n: 0 })
    assert.deepEqual(areaBandSummary({ n: 0, nRef: 0, nCom: 0 }), {
      kind: 'too-few-stations',
      n: 0,
    })
  })

  it('reports missing coverage when stations exist but ingest published no band', () => {
    const stats: AreaStats = { n: 1, nRef: 0, nCom: 1, med: { temperature: 12 } }
    assert.deepEqual(areaBandSummary(stats), { kind: 'no-pollutant-coverage' })
  })
})

describe('areaConfidenceLabel', () => {
  it('speaks confidence for one and two stations, plain counts above', () => {
    assert.equal(areaConfidenceLabel(null), 'No stations included')
    assert.equal(areaConfidenceLabel({ n: 0, nRef: 0, nCom: 0 }), 'No stations included')
    assert.equal(
      areaConfidenceLabel({ n: 1, nRef: 0, nCom: 1 }),
      'Single station (0 official, 1 community) — low confidence'
    )
    assert.equal(
      areaConfidenceLabel({ n: 2, nRef: 1, nCom: 1 }),
      'Two stations (1 official, 1 community)'
    )
    assert.equal(areaConfidenceLabel(fullStats), '8 stations (3 official, 5 community)')
  })
})

describe('parseAreaSnapshot', () => {
  it('accepts a valid snapshot', () => {
    const parsed = parseAreaSnapshot({
      generatedAt: '2026-07-21T10:00:00Z',
      areas: { DE21: fullStats },
    })
    assert.ok(parsed)
    assert.equal(parsed.generatedAt, '2026-07-21T10:00:00Z')
    assert.deepEqual(parsed.areas.DE21, fullStats)
  })

  it('rejects non-object / malformed top-level payloads', () => {
    assert.equal(parseAreaSnapshot(null), null)
    assert.equal(parseAreaSnapshot('nope'), null)
    assert.equal(parseAreaSnapshot({ areas: {} }), null)
    assert.equal(parseAreaSnapshot({ generatedAt: '2026-07-21T10:00:00Z' }), null)
    assert.equal(parseAreaSnapshot({ generatedAt: '2026-07-21T10:00:00Z', areas: [] }), null)
  })

  it('drops entries without a numeric n and defaults missing splits to 0', () => {
    const parsed = parseAreaSnapshot({
      generatedAt: 'x',
      areas: {
        BAD1: { eaqi: 2 },
        BAD2: 'nope',
        OK1: { n: 4 },
      },
    })
    assert.ok(parsed)
    assert.deepEqual(Object.keys(parsed.areas), ['OK1'])
    assert.deepEqual(parsed.areas.OK1, { n: 4, nRef: 0, nCom: 0 })
  })

  it('strips invalid bands, pollutants, and non-numeric med/cnt values', () => {
    const parsed = parseAreaSnapshot({
      generatedAt: 'x',
      areas: {
        FR10: {
          n: 5,
          nRef: 1,
          nCom: 4,
          eaqi: 9,
          pollutant: 'plutonium',
          med: { pm2_5: 'high', o3: 42 },
          cnt: { o3: 3 },
        },
      },
    })
    assert.ok(parsed)
    const stats = parsed.areas.FR10!
    assert.equal(stats.eaqi, undefined)
    assert.equal(stats.pollutant, undefined)
    assert.deepEqual(stats.med, { o3: 42 })
    assert.deepEqual(stats.cnt, { o3: 3 })
  })
})

describe('view support', () => {
  it('every view has area fills, humidity included', () => {
    for (const id of ['eaqi', 'pm2_5', 'pm10', 'no2', 'o3', 'so2', 'temperature', 'humidity'] as const) {
      assert.equal(viewHasAreaFills(id), true)
    }
  })
})

describe('paint expressions', () => {
  it('EAQI fill matches feature-state band to the shared colors, gray default', () => {
    const expr = areaFillColor('eaqi') as unknown[]
    assert.equal(expr[0], 'match')
    assert.deepEqual(expr[1], ['coalesce', ['feature-state', 'band'], 0])
    for (const [i, color] of EAQI_BAND_COLORS.entries()) {
      assert.equal(expr[2 + i * 2], i + 1)
      assert.equal(expr[3 + i * 2], color)
    }
    assert.equal(expr[expr.length - 1], NO_DATA_FILL)
  })

  it('pollutant fills read their own feature-state key', () => {
    const expr = areaFillColor('pm10') as unknown[]
    assert.deepEqual(expr[1], ['coalesce', ['feature-state', 'b_pm10'], 0])
  })

  it('temperature fill guards on state presence and falls back to gray', () => {
    const expr = areaFillColor('temperature') as unknown[]
    assert.equal(expr[0], 'case')
    assert.deepEqual(expr[1], ['==', ['typeof', ['feature-state', 'temp']], 'number'])
    const ramp = expr[2] as unknown[]
    assert.equal(ramp[0], 'interpolate-lab')
    assert.deepEqual(ramp[2], ['coalesce', ['feature-state', 'temp'], 0])
    assert.equal(expr[3], NO_DATA_FILL)
  })

  it('humidity fill mirrors the temperature pattern on the hum state key', () => {
    const expr = areaFillColor('humidity') as unknown[]
    assert.equal(expr[0], 'case')
    assert.deepEqual(expr[1], ['==', ['typeof', ['feature-state', 'hum']], 'number'])
    const ramp = expr[2] as unknown[]
    assert.equal(ramp[0], 'interpolate-lab')
    assert.deepEqual(ramp[2], ['coalesce', ['feature-state', 'hum'], 0])
    assert.equal(expr[3], NO_DATA_FILL)
  })

  it('areaStateFor emits hum from a single counted humidity station', () => {
    const base = { n: 5, nRef: 0, nCom: 5 }
    const one = areaStateFor({ ...base, med: { humidity: 61.5 }, cnt: { humidity: 1 } })
    assert.equal(one['hum'], 61.5)
    const uncounted = areaStateFor({ ...base, med: { humidity: 61.5 } })
    assert.equal('hum' in uncounted, false)
  })

  it('fill opacity crossfades on zoom around the graduated confidence ramp', () => {
    const expr = areaFillOpacity() as unknown[]
    assert.deepEqual(expr.slice(0, 3), ['interpolate', ['linear'], ['zoom']])
    assert.equal(expr[3], AREA_CROSSFADE_START)
    assert.deepEqual(expr[4], [
      'interpolate',
      ['linear'],
      ['coalesce', ['feature-state', 'n'], 0],
      1,
      0.3,
      2,
      0.4,
      AREA_FULL_CONFIDENCE_STATIONS,
      0.45,
      10,
      0.85,
    ])
    assert.equal(expr[5], AREA_CROSSFADE_END)
    assert.equal(expr[6], 0)
  })

  it('the graduated ramp low end stays below full confidence', () => {
    assert.ok(AREA_FULL_CONFIDENCE_STATIONS > 2, 'full confidence starts above two stations')
  })

  it('circle opacity passes through untouched when fills are off', () => {
    const base = 0.9 as unknown as Parameters<typeof stationCircleOpacity>[1]
    assert.equal(stationCircleOpacity(false, base), base)
  })

  it('circle opacity fades in across the crossfade window when fills are on', () => {
    const base = 0.9 as unknown as Parameters<typeof stationCircleOpacity>[1]
    assert.deepEqual(stationCircleOpacity(true, base) as unknown, [
      'interpolate',
      ['linear'],
      ['zoom'],
      AREA_CROSSFADE_START,
      0,
      AREA_CROSSFADE_END,
      0.9,
    ])
  })
})

describe('boundary attribution', () => {
  it('the verbatim EuroGeographics notice is in the shared ATTRIBUTIONS', () => {
    assert.equal(BOUNDARY_NOTICE, '© EuroGeographics for the administrative boundaries')
    assert.ok(ATTRIBUTIONS.some((a) => a.label === BOUNDARY_NOTICE))
  })

  it('appends the notice when missing and never duplicates it', () => {
    const base: Attribution[] = [{ label: 'OpenAQ', url: 'https://openaq.org/' }]
    const withNotice = withBoundaryAttribution(base)
    assert.equal(withNotice.length, 2)
    assert.equal(withNotice[1]!.label, BOUNDARY_NOTICE)
    const again = withBoundaryAttribution(withNotice)
    assert.equal(again.filter((a) => a.label === BOUNDARY_NOTICE).length, 1)
  })
})
