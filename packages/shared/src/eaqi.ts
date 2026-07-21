import type { Param, Reading } from './types'

/**
 * European Air Quality Index, revised 2024/25 band set ("eaqi-2025") —
 * thresholds verified against the deployed AerisMap v1 bundle on 2026-07-21.
 * Cross-check against EEA primary documentation before public launch
 * (tracked in aerismap-v2-plan.md §10).
 */
export const EAQI_BAND_SET = 'eaqi-2025' as const

export type EaqiBand = 1 | 2 | 3 | 4 | 5 | 6

export const EAQI_BAND_NAMES = [
  'Good',
  'Fair',
  'Moderate',
  'Poor',
  'Very poor',
  'Extremely poor',
] as const

/** Official EEA band colors, index-aligned with EAQI_BAND_NAMES (band n → index n-1). */
export const EAQI_BAND_COLORS = [
  '#50f0e6',
  '#50ccaa',
  '#f0e641',
  '#ff5050',
  '#960032',
  '#7d2181',
] as const

/**
 * Upper bounds (µg/m³) of bands 1–5 per pollutant; a value above the last
 * bound is band 6. Values are compared inclusively: v ≤ bound → that band.
 */
export const EAQI_THRESHOLDS = {
  pm2_5: [5, 15, 50, 90, 140],
  pm10: [15, 45, 120, 195, 270],
  no2: [10, 25, 60, 100, 150],
  o3: [60, 100, 120, 160, 180],
  so2: [20, 40, 125, 190, 275],
} as const satisfies Partial<Record<Param, readonly number[]>>

export type EaqiPollutant = keyof typeof EAQI_THRESHOLDS

export const EAQI_POLLUTANTS = Object.keys(EAQI_THRESHOLDS) as EaqiPollutant[]

export function eaqiBandForValue(param: EaqiPollutant, value: number): EaqiBand | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined
  const bounds = EAQI_THRESHOLDS[param]
  for (let i = 0; i < bounds.length; i++) {
    if (value <= bounds[i]!) return (i + 1) as EaqiBand
  }
  return 6
}

/**
 * Consolidated EAQI = worst (max) band across the pollutants present,
 * with the dominant pollutant. Undefined when no scoreable pollutant exists.
 */
export function computeEaqi(
  values: Partial<Record<Param, Reading>>
): { band: EaqiBand; pollutant: EaqiPollutant } | undefined {
  let worst: { band: EaqiBand; pollutant: EaqiPollutant } | undefined
  for (const pollutant of EAQI_POLLUTANTS) {
    const reading = values[pollutant]
    if (!reading) continue
    const band = eaqiBandForValue(pollutant, reading.v)
    if (band !== undefined && (worst === undefined || band > worst.band)) {
      worst = { band, pollutant }
    }
  }
  return worst
}
