import { describe, expect, it } from 'vitest'
import dustFixture from '../fixtures/sc-dust.json'
import tempFixture from '../fixtures/sc-temp.json'
import {
  fetchSensorCommunity,
  mergeScRecords,
  normalizeScTimestamp,
  normalizeScValue,
} from './sensor-community'

describe('normalizeScTimestamp', () => {
  it('converts the zone-less UTC feed format to ISO 8601 Z', () => {
    expect(normalizeScTimestamp('2026-07-21 10:49:41')).toBe('2026-07-21T10:49:41Z')
  })

  it('rejects other formats and impossible dates', () => {
    expect(normalizeScTimestamp('2026-07-21T10:49:41Z')).toBeUndefined()
    expect(normalizeScTimestamp('21.07.2026 10:49')).toBeUndefined()
    expect(normalizeScTimestamp('2026-13-45 99:99:99')).toBeUndefined()
    expect(normalizeScTimestamp('')).toBeUndefined()
  })
})

describe('normalizeScValue plausibility filters', () => {
  it('accepts PM in 0–1000 µg/m³ and rejects PPD42NS-style overloads', () => {
    expect(normalizeScValue('pm10', '0.00')).toBe(0)
    expect(normalizeScValue('pm2_5', '183.49')).toBe(183.49)
    expect(normalizeScValue('pm10', '1000')).toBe(1000)
    expect(normalizeScValue('pm10', '1073.20')).toBeUndefined()
    expect(normalizeScValue('pm2_5', '-1')).toBeUndefined()
  })

  it('rejects the degenerate DHT22 humidity=1.00 and out-of-range humidity', () => {
    expect(normalizeScValue('humidity', '1.00')).toBeUndefined()
    expect(normalizeScValue('humidity', '0.50')).toBeUndefined()
    expect(normalizeScValue('humidity', '1.01')).toBe(1.01)
    expect(normalizeScValue('humidity', '100.00')).toBe(100)
    expect(normalizeScValue('humidity', '100.10')).toBeUndefined()
    expect(normalizeScValue('humidity', '1408.00')).toBeUndefined()
  })

  it('bounds temperature to −60…+60 °C', () => {
    expect(normalizeScValue('temperature', '24.75')).toBe(24.75)
    expect(normalizeScValue('temperature', '-60')).toBe(-60)
    expect(normalizeScValue('temperature', '-142.54')).toBeUndefined()
    expect(normalizeScValue('temperature', '436.00')).toBeUndefined()
  })

  it('normalizes pressure to hPa whether reported in Pa or hPa', () => {
    expect(normalizeScValue('pressure', '99001.22')).toBe(990.01) // Pa → hPa
    expect(normalizeScValue('pressure', '997.60')).toBe(997.6) // already hPa
    expect(normalizeScValue('pressure', '-11948.81')).toBeUndefined()
    expect(normalizeScValue('pressure', '164407.33')).toBeUndefined() // 1644 hPa — implausible
    expect(normalizeScValue('pressure', '10016750')).toBeUndefined()
  })

  it('rejects non-numeric values', () => {
    expect(normalizeScValue('pm10', 'nan')).toBeUndefined()
    expect(normalizeScValue('temperature', '')).toBeUndefined()
  })
})

describe('mergeScRecords (live-data fixtures)', () => {
  const { stations, malformedRecords } = mergeScRecords([dustFixture, tempFixture])
  const byId = new Map(stations.map((s) => [s.properties.id, s]))

  it('parses every fixture record', () => {
    expect(malformedRecords).toBe(0)
  })

  it('keys stations by location and merges PM + temp files', () => {
    const s49 = byId.get('sensor-community:49')
    expect(s49).toBeDefined()
    // PM sensor record + DHT22 record merged into one station
    expect(s49!.properties.values.pm2_5).toEqual({ v: 183.49, ts: '2026-07-21T10:49:41Z' })
    expect(s49!.properties.values.temperature).toEqual({ v: 24.75, ts: '2026-07-21T10:49:49Z' })
    // P1=1073.20 (implausible) and humidity=1.00 (degenerate) are dropped
    expect(s49!.properties.values.pm10).toBeUndefined()
    expect(s49!.properties.values.humidity).toBeUndefined()
    expect(s49!.properties.kind).toBe('community')
    expect(s49!.properties.license).toBe('ODbL-1.0')
    expect(s49!.properties.country).toBe('DE')
    expect(s49!.properties.nativeId).toBe('49')
  })

  it('converts BME280 Pa pressure to hPa and keeps hPa-reporting sensors as-is', () => {
    expect(byId.get('sensor-community:65')!.properties.values.pressure).toEqual({
      v: 990.01,
      ts: '2026-07-21T10:49:13Z',
    })
    expect(byId.get('sensor-community:6425')!.properties.values.pressure?.v).toBe(997.6)
  })

  it('drops indoor stations', () => {
    // location 82688 is indoor in both files
    expect(byId.has('sensor-community:82688')).toBe(false)
  })

  it('drops stations outside EUROPE_BBOX', () => {
    // location 35400 is in the US
    expect(byId.has('sensor-community:35400')).toBe(false)
  })

  it('drops stations whose every reading is implausible', () => {
    // location 24316: humidity=1408, temperature=436
    expect(byId.has('sensor-community:24316')).toBe(false)
  })

  it('merges per-param across back-to-back records from the same sensor', () => {
    // sensor 61704 at location 47627 pushed humidity-only at 10:50:18 and
    // PM-only at 10:50:17 — both must survive
    const s = byId.get('sensor-community:47627')!
    expect(s.properties.values.humidity).toEqual({ v: 84.47, ts: '2026-07-21T10:50:18Z' })
    expect(s.properties.values.pm10).toEqual({ v: 4.16, ts: '2026-07-21T10:50:17Z' })
    expect(s.properties.values.pm2_5).toEqual({ v: 1.2, ts: '2026-07-21T10:50:17Z' })
  })

  it('collapses exact duplicate records and maps P0 to pm1', () => {
    // location 3985 appears twice with identical payloads
    const s = byId.get('sensor-community:3985')!
    expect(s.properties.values.pm1).toEqual({ v: 1.2, ts: '2026-07-21T10:48:55Z' })
    expect(s.properties.values.pm10?.v).toBe(1.5)
    expect(s.properties.values.pm2_5?.v).toBe(1.5)
    expect(s.properties.exactLocation).toBe(true)
  })

  it('flags coarsened coordinates via exact_location', () => {
    expect(byId.get('sensor-community:49')!.properties.exactLocation).toBe(false)
    expect(byId.get('sensor-community:3985')!.properties.exactLocation).toBe(true)
  })

  it('filters per-value, not per-record, on partially broken sensors', () => {
    // location 1113: temperature −142.54 dropped; humidity 100.00 and
    // pressure 64690.84 Pa (646.91 hPa) survive
    const s = byId.get('sensor-community:1113')!
    expect(s.properties.values.temperature).toBeUndefined()
    expect(s.properties.values.humidity?.v).toBe(100)
    expect(s.properties.values.pressure?.v).toBe(646.91)
    // location 5113: negative pressure dropped, rest kept
    const s2 = byId.get('sensor-community:5113')!
    expect(s2.properties.values.pressure).toBeUndefined()
    expect(s2.properties.values.temperature?.v).toBe(36.56)
    expect(s2.properties.values.humidity?.v).toBe(33.58)
  })

  it('skips malformed records without dropping the rest', () => {
    const result = mergeScRecords([[null, 42, { timestamp: 'x' }, ...dustFixture], tempFixture])
    expect(result.malformedRecords).toBe(3)
    expect(result.stations.length).toBe(stations.length)
  })

  it('drops records timestamped more than 10 minutes ahead of ingest time', () => {
    const scRecord = (ts: string, locationId: number) => ({
      timestamp: ts,
      location: {
        id: locationId,
        latitude: '48.5',
        longitude: '9.2',
        country: 'DE',
        exact_location: 0,
        indoor: 0,
      },
      sensor: { id: locationId * 10 },
      sensordatavalues: [{ value: '5.0', value_type: 'P2' }],
    })
    const now = new Date('2026-07-21T12:00:00Z')
    const result = mergeScRecords(
      [[scRecord('2026-07-21 12:11:00', 1), scRecord('2026-07-21 12:09:00', 2)]],
      now
    )
    expect(result.stations.map((s) => s.properties.nativeId)).toEqual(['2'])
  })
})

describe('fetchSensorCommunity', () => {
  const impl: typeof fetch = async (input) =>
    new Response(
      JSON.stringify(String(input).includes('dust') ? dustFixture : tempFixture),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  const now = new Date('2026-07-21T12:00:00Z')

  it('reports ok:false when the yield is under the plausibility floor (default 500)', async () => {
    const result = await fetchSensorCommunity({ fetchImpl: impl, now })
    expect(result.status.ok).toBe(false)
    expect(result.status.detail).toContain('implausibly low yield')
    expect(result.status.detail).toContain('floor 500')
    expect(result.stations).toEqual([])
  })

  it('publishes when the yield clears the floor', async () => {
    const result = await fetchSensorCommunity({ fetchImpl: impl, now, minStations: 1 })
    expect(result.status.ok).toBe(true)
    expect(result.status.stations).toBeGreaterThan(0)
    expect(result.stations.length).toBe(result.status.stations)
  })
})
