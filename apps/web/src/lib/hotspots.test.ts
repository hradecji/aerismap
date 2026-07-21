/** Pure-logic tests for the hotspot overlay; run via `pnpm --filter @aerismap/web test`. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  EAQI_BAND_COLORS,
  HOTSPOT_MIN_BAND,
  type StationCollection,
  type StationFeature,
} from '@aerismap/shared'
import {
  collectionHasHotspots,
  HOTSPOT_LEGEND_LABEL,
  hotspotCoreRadius,
  hotspotFilter,
  hotspotRingColor,
  hotspotRingRadius,
} from './hotspots'
import { NEUTRAL_DOT } from './views'

const station = (over: Partial<StationFeature['properties']>): StationFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [10, 50] },
  properties: {
    id: 'sensor-community:1',
    source: 'sensor-community',
    nativeId: '1',
    kind: 'community',
    license: 'ODbL-1.0',
    exactLocation: true,
    observedAt: '2026-07-21T10:00:00Z',
    stale: false,
    values: {},
    ...over,
  },
})

const collection = (...features: StationFeature[]): StationCollection => ({
  type: 'FeatureCollection',
  features,
})

describe('hotspotFilter', () => {
  it('requires hotspot truthiness AND a band to color by', () => {
    assert.deepEqual(hotspotFilter() as unknown, [
      'all',
      ['==', ['to-boolean', ['get', 'hotspot']], true],
      ['has', 'eaqi'],
    ])
  })
})

describe('hotspotRingColor', () => {
  it('matches the station band to the shared EAQI colors with a neutral default', () => {
    const expr = hotspotRingColor() as unknown[]
    assert.equal(expr[0], 'match')
    assert.deepEqual(expr[1], ['coalesce', ['get', 'eaqi'], 0])
    for (const [i, color] of EAQI_BAND_COLORS.entries()) {
      assert.equal(expr[2 + i * 2], i + 1)
      assert.equal(expr[3 + i * 2], color)
    }
    assert.equal(expr[expr.length - 1], NEUTRAL_DOT)
  })

  it('covers every band a hotspot can carry (≥ HOTSPOT_MIN_BAND)', () => {
    // Promotion demands band ≥ HOTSPOT_MIN_BAND; the match table spans 1–6,
    // so every promotable band resolves to an official color.
    assert.ok(HOTSPOT_MIN_BAND >= 1 && HOTSPOT_MIN_BAND <= EAQI_BAND_COLORS.length)
  })
})

describe('hotspot radii', () => {
  const stops = (expr: unknown): number[] =>
    (expr as unknown[]).slice(3).filter((_, i) => i % 2 === 1) as number[]

  it('ring is prominently larger than the core at every zoom stop', () => {
    const ring = stops(hotspotRingRadius())
    const core = stops(hotspotCoreRadius())
    assert.equal(ring.length, core.length)
    for (let i = 0; i < ring.length; i++) {
      assert.ok(ring[i]! >= core[i]! + 4, `ring must clearly enclose the core (stop ${i})`)
    }
  })

  it('both interpolate on zoom', () => {
    for (const expr of [hotspotRingRadius(), hotspotCoreRadius()]) {
      assert.deepEqual((expr as unknown[]).slice(0, 3), ['interpolate', ['linear'], ['zoom']])
    }
  })
})

describe('collectionHasHotspots', () => {
  it('is false for null and for hotspot-free collections', () => {
    assert.equal(collectionHasHotspots(null), false)
    assert.equal(collectionHasHotspots(collection()), false)
    assert.equal(collectionHasHotspots(collection(station({ eaqi: 5 }))), false)
  })

  it('is true as soon as one station carries hotspot === true', () => {
    const fc = collection(station({}), station({ eaqi: 5, hotspot: true }))
    assert.equal(collectionHasHotspots(fc), true)
  })

  it('ignores non-boolean-true hotspot values', () => {
    const fc = collection(station({ hotspot: false }))
    assert.equal(collectionHasHotspots(fc), false)
  })
})

describe('legend line', () => {
  it('uses the ring glyph and names the corroboration', () => {
    assert.equal(HOTSPOT_LEGEND_LABEL, '◉ corroborated hotspot')
  })
})
