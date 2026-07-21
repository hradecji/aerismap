import { describe, expect, it } from 'vitest'
import { computeEaqi, eaqiBandForValue } from './eaqi'

describe('eaqiBandForValue', () => {
  it('treats band bounds as inclusive upper limits', () => {
    expect(eaqiBandForValue('pm2_5', 0)).toBe(1)
    expect(eaqiBandForValue('pm2_5', 5)).toBe(1)
    expect(eaqiBandForValue('pm2_5', 5.1)).toBe(2)
    expect(eaqiBandForValue('pm2_5', 140)).toBe(5)
    expect(eaqiBandForValue('pm2_5', 140.1)).toBe(6)
    expect(eaqiBandForValue('o3', 60)).toBe(1)
    expect(eaqiBandForValue('so2', 275.5)).toBe(6)
  })

  it('rejects non-finite and negative values', () => {
    expect(eaqiBandForValue('pm10', -1)).toBeUndefined()
    expect(eaqiBandForValue('pm10', Number.NaN)).toBeUndefined()
    expect(eaqiBandForValue('pm10', Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})

describe('computeEaqi', () => {
  it('returns the worst band with its dominant pollutant', () => {
    const result = computeEaqi({
      pm2_5: { v: 12, ts: '2026-07-21T10:00:00Z' }, // band 2
      no2: { v: 120, ts: '2026-07-21T10:00:00Z' }, // band 5
      o3: { v: 30, ts: '2026-07-21T10:00:00Z' }, // band 1
    })
    expect(result).toEqual({ band: 5, pollutant: 'no2' })
  })

  it('ignores non-scoreable params and invalid values', () => {
    expect(
      computeEaqi({
        temperature: { v: 21, ts: '2026-07-21T10:00:00Z' },
        pm10: { v: -3, ts: '2026-07-21T10:00:00Z' },
      })
    ).toBeUndefined()
    expect(computeEaqi({})).toBeUndefined()
  })
})
