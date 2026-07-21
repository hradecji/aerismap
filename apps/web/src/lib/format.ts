import type { Param, StationKind } from '@aerismap/shared'

export const PARAM_LABELS: Record<Param, string> = {
  pm1: 'PM1',
  pm2_5: 'PM2.5',
  pm10: 'PM10',
  no2: 'NO₂',
  o3: 'O₃',
  so2: 'SO₂',
  co: 'CO',
  temperature: 'Temperature',
  humidity: 'Humidity',
  pressure: 'Pressure',
}

export const PARAM_UNITS: Record<Param, string> = {
  pm1: 'µg/m³',
  pm2_5: 'µg/m³',
  pm10: 'µg/m³',
  no2: 'µg/m³',
  o3: 'µg/m³',
  so2: 'µg/m³',
  // CO is the OpenAQ mass series (id 4) — µg/m³ like the rest, not mg/m³.
  co: 'µg/m³',
  temperature: '°C',
  humidity: '%',
  pressure: 'hPa',
}

const PARAM_DECIMALS: Record<Param, number> = {
  pm1: 1,
  pm2_5: 1,
  pm10: 1,
  no2: 1,
  o3: 1,
  so2: 1,
  co: 0,
  temperature: 1,
  humidity: 0,
  pressure: 0,
}

export function formatValue(param: Param, value: number): string {
  return value.toFixed(PARAM_DECIMALS[param])
}

export function kindLabel(kind: StationKind): string {
  switch (kind) {
    case 'reference':
      return 'Official station'
    case 'community':
      return 'Community sensor'
    case 'model':
      return 'Model point'
  }
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return 'unknown time'
  const ms = now - ts
  if (ms < 60_000) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}
