// Dev-only mock of the AerisMap API — never imported by the app, never bundled.
//
//   node dev/mock-api.mjs            # fresh snapshot
//   node dev/mock-api.mjs --stale    # meta 3 h old, to exercise the freshness banner
//   NEXT_PUBLIC_API_BASE=http://localhost:8787 pnpm --filter @aerismap/web dev
//
// Paths mirror API_PATHS in @aerismap/shared (plain strings so this stays
// runnable with bare `node`).

import { createServer } from 'node:http'

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787
const STALE_META = process.argv.includes('--stale')

const now = Date.now()
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()

const station = (lon, lat, props) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: props,
})

const stations = {
  type: 'FeatureCollection',
  features: [
    station(13.4, 52.52, {
      id: 'openaq:1001',
      source: 'openaq',
      nativeId: '1001',
      name: 'Berlin Mitte',
      kind: 'reference',
      country: 'DE',
      license: 'CC-BY-4.0',
      exactLocation: true,
      observedAt: iso(50),
      stale: false,
      values: {
        pm2_5: { v: 9.2, ts: iso(50) },
        pm10: { v: 18.4, ts: iso(50) },
        no2: { v: 32.1, ts: iso(50) },
        o3: { v: 41.0, ts: iso(50) },
      },
      eaqi: 3,
      eaqiPollutant: 'no2',
    }),
    station(-3.7, 40.42, {
      id: 'openaq:2178',
      source: 'openaq',
      nativeId: '2178',
      name: 'Madrid Retiro',
      kind: 'reference',
      country: 'ES',
      license: 'CC-BY-4.0',
      exactLocation: true,
      observedAt: iso(70),
      stale: false,
      values: {
        o3: { v: 168.0, ts: iso(70) },
        no2: { v: 14.2, ts: iso(70) },
      },
      eaqi: 5,
      eaqiPollutant: 'o3',
    }),
    station(10.75, 59.91, {
      id: 'openaq:3300',
      source: 'openaq',
      nativeId: '3300',
      name: 'Oslo Kirkeveien',
      kind: 'reference',
      country: 'NO',
      license: 'CC-BY-4.0',
      exactLocation: true,
      observedAt: iso(45),
      stale: false,
      values: {
        pm10: { v: 8.0, ts: iso(45) },
        so2: { v: 3.2, ts: iso(45) },
      },
      eaqi: 1,
      eaqiPollutant: 'pm10',
    }),
    station(2.35, 48.86, {
      id: 'sensor-community:41221',
      source: 'sensor-community',
      nativeId: '41221',
      kind: 'community',
      country: 'FR',
      license: 'ODbL-1.0',
      exactLocation: true,
      observedAt: iso(6),
      stale: false,
      values: {
        pm2_5: { v: 7.8, ts: iso(6) },
        pm10: { v: 16.3, ts: iso(6) },
        temperature: { v: 24.6, ts: iso(6) },
        humidity: { v: 48, ts: iso(6) },
      },
      eaqi: 2,
      eaqiPollutant: 'pm2_5',
    }),
    station(14.42, 50.09, {
      id: 'sensor-community:50877',
      source: 'sensor-community',
      nativeId: '50877',
      kind: 'community',
      country: 'CZ',
      license: 'ODbL-1.0',
      exactLocation: true,
      observedAt: iso(9),
      stale: false,
      // temperature/humidity only → no EAQI: neutral gray dot in the EAQI view
      values: {
        temperature: { v: 21.9, ts: iso(9) },
        humidity: { v: 63, ts: iso(9) },
        pressure: { v: 1014, ts: iso(9) },
      },
    }),
    station(21.01, 52.23, {
      id: 'sensor-community:61012',
      source: 'sensor-community',
      nativeId: '61012',
      kind: 'community',
      country: 'PL',
      license: 'ODbL-1.0',
      exactLocation: true,
      observedAt: iso(240),
      stale: true,
      values: {
        pm2_5: { v: 61.5, ts: iso(240) },
        pm10: { v: 88.0, ts: iso(240) },
      },
      eaqi: 4,
      eaqiPollutant: 'pm2_5',
    }),
    station(9.19, 45.46, {
      id: 'sensor-community:70233',
      source: 'sensor-community',
      nativeId: '70233',
      kind: 'community',
      country: 'IT',
      license: 'ODbL-1.0',
      exactLocation: false,
      observedAt: iso(12),
      stale: false,
      // Spatial-QC demo: railed PM2.5 flagged, no other pollutant → no EAQI.
      values: {
        pm2_5: { v: 101.0, ts: iso(12) },
        temperature: { v: 31.4, ts: iso(12) },
        humidity: { v: 34, ts: iso(12) },
      },
      qc: ['pm2_5'],
    }),
    station(23.73, 37.98, {
      id: 'sensor-community:80455',
      source: 'sensor-community',
      nativeId: '80455',
      kind: 'community',
      country: 'GR',
      license: 'ODbL-1.0',
      exactLocation: true,
      observedAt: iso(15),
      stale: false,
      values: {
        pm2_5: { v: 152.0, ts: iso(15) },
        pm10: { v: 210.0, ts: iso(15) },
        temperature: { v: 35.8, ts: iso(15) },
        humidity: { v: 22, ts: iso(15) },
      },
      eaqi: 6,
      eaqiPollutant: 'pm2_5',
      // Corroborated epicenter demo: ◉ ring marker + legend line.
      hotspot: true,
    }),
  ],
}

const meta = {
  generatedAt: iso(STALE_META ? 185 : 25),
  eaqiBandSet: 'eaqi-2025',
  maxAgeSec: { community: 2700, reference: 10800, model: 10800 },
  counts: {
    stations: stations.features.length,
    byKind: { reference: 3, community: 5 },
    withEaqi: 6,
  },
  sources: [
    { id: 'sensor-community', ok: true, fetchedAt: iso(26), stations: 5 },
    { id: 'openaq', ok: true, fetchedAt: iso(27), stations: 3 },
  ],
  attribution: [
    { label: 'Sensor.Community', url: 'https://sensor.community/', license: 'ODbL-1.0' },
    { label: 'OpenAQ', url: 'https://openaq.org/', license: 'varies by underlying source' },
    { label: 'European Environment Agency (via OpenAQ)', url: 'https://www.eea.europa.eu/' },
    {
      label: 'Open-Meteo · CAMS ENSEMBLE (Copernicus)',
      url: 'https://open-meteo.com/',
      license: 'CC-BY-4.0',
    },
    {
      label: 'OpenFreeMap · OpenMapTiles © OpenStreetMap contributors',
      url: 'https://openfreemap.org/',
    },
  ],
}

// Regional aggregates keyed by NUTS-2 id (all present in the shipped
// boundaries) — enough coverage to exercise fills, the confidence-opacity
// ramp, and the EuroGeographics notice in the legend.
const areas = {
  generatedAt: iso(20),
  areas: {
    DE30: {
      n: 4,
      nRef: 2,
      nCom: 2,
      eaqi: 3,
      pollutant: 'no2',
      med: { pm2_5: 9.2, no2: 32.1, temperature: 23.9, humidity: 52 },
      cnt: { pm2_5: 4, no2: 3, temperature: 2, humidity: 2 },
    },
    ES30: {
      n: 3,
      nRef: 3,
      nCom: 0,
      eaqi: 5,
      pollutant: 'o3',
      med: { o3: 168.0, no2: 14.2 },
      cnt: { o3: 3, no2: 3 },
    },
    FR10: {
      n: 6,
      nRef: 1,
      nCom: 5,
      eaqi: 2,
      pollutant: 'pm2_5',
      med: { pm2_5: 7.8, pm10: 16.3, temperature: 24.6, humidity: 48 },
      cnt: { pm2_5: 6, pm10: 5, temperature: 4, humidity: 4 },
    },
    // Temp/humidity only → no band: renders the no-data gray in EAQI view.
    CZ01: {
      n: 2,
      nRef: 0,
      nCom: 2,
      med: { temperature: 21.9, humidity: 63 },
      cnt: { temperature: 2, humidity: 2 },
    },
    ITC4: {
      n: 5,
      nRef: 2,
      nCom: 3,
      eaqi: 2,
      pollutant: 'pm10',
      med: { pm10: 21.0, temperature: 30.2, humidity: 35 },
      cnt: { pm10: 5, temperature: 3, humidity: 3 },
    },
    EL30: {
      n: 4,
      nRef: 1,
      nCom: 3,
      eaqi: 6,
      pollutant: 'pm2_5',
      med: { pm2_5: 152.0, pm10: 210.0, temperature: 35.1, humidity: 24 },
      cnt: { pm2_5: 4, pm10: 4, temperature: 2, humidity: 2 },
    },
    // Single station → low-confidence (faint) fill.
    NO08: {
      n: 1,
      nRef: 1,
      nCom: 0,
      eaqi: 1,
      pollutant: 'pm10',
      med: { pm10: 8.0, so2: 3.2, temperature: 14.2 },
      cnt: { pm10: 1, so2: 1, temperature: 1 },
    },
  },
}

const routes = new Map([
  ['/api/v1/stations', stations],
  ['/api/v1/areas', areas],
  ['/api/v1/meta', meta],
])

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const body = routes.get(url.pathname)
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (!body) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ title: 'Not Found', status: 404 }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}).listen(PORT, () => {
  console.log(`mock AerisMap API on http://localhost:${PORT} (meta ${STALE_META ? 'STALE' : 'fresh'})`)
})
