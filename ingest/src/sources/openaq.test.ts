import { describe, expect, it } from 'vitest'
import latestPm25Page from '../fixtures/openaq-latest-pm25.json'
import locationsPage from '../fixtures/openaq-locations.json'
import parametersPage from '../fixtures/openaq-parameters.json'
import {
  buildOpenaqStations,
  buildRegistry,
  fetchOpenaq,
  type OaLatestRow,
  type RegistryEntry,
  type RegistryStore,
} from './openaq'

const EMPTY_PAGE = { meta: { limit: 1000, found: 0 }, results: [] }
const NOW = new Date('2026-07-21T12:00:00Z')

function stubFetch(handler: (url: string) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: string[] = []
  const impl: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    const { status = 200, body = EMPTY_PAGE, headers = {} } = handler(url)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  }
  return { calls, impl }
}

function memoryRegistryStore(initial?: string) {
  const state: { value: string | undefined; saves: number } = { value: initial, saves: 0 }
  const store: RegistryStore = {
    load: async () => state.value,
    save: async (body) => {
      state.value = body
      state.saves++
    },
  }
  return { state, store }
}

describe('buildRegistry', () => {
  const registry = buildRegistry(locationsPage.results)

  it('keys entries by location id with coords, name and country', () => {
    expect(registry.get(2162)).toEqual({
      name: 'London Marylebone Road',
      country: 'GB',
      lon: -0.15459,
      lat: 51.52254,
    })
    expect(registry.size).toBe(3)
  })

  it('drops rows without usable coordinates', () => {
    expect(registry.has(999001)).toBe(false)
  })
})

describe('buildOpenaqStations', () => {
  const registry = buildRegistry(locationsPage.results)
  const stations = buildOpenaqStations(registry, [
    ['pm2_5', latestPm25Page.results],
    ['pm10', []],
  ])
  const byId = new Map(stations.map((s) => [s.properties.id, s]))

  it('joins rows to the registry and keeps the newest value per (location, param)', () => {
    const s = byId.get('openaq:2162')
    expect(s).toBeDefined()
    expect(s!.properties.values.pm2_5).toEqual({ v: 7.2, ts: '2026-07-21T09:00:00Z' })
    expect(s!.lon).toBe(-0.15459)
    expect(s!.lat).toBe(51.52254)
    expect(s!.properties.kind).toBe('reference')
    expect(s!.properties.license).toBe('per-source (OpenAQ/EEA)')
    expect(s!.properties.exactLocation).toBe(true)
    expect(s!.properties.country).toBe('GB')
    expect(s!.properties.name).toBe('London Marylebone Road')
    expect(s!.properties.nativeId).toBe('2162')
  })

  it('drops rows for locations missing from the registry (non-monitor / out of bbox)', () => {
    expect(byId.has('openaq:888000')).toBe(false)
  })

  it('drops negative sentinel values and the stations they would create', () => {
    // location 155207's only row is value=-999
    expect(byId.has('openaq:155207')).toBe(false)
    expect(stations.length).toBe(2)
  })

  it('clamps small negative noise to 0 and drops sentinel negatives at the -10 boundary', () => {
    const rows: OaLatestRow[] = [
      { datetime: { utc: '2026-07-21T09:00:00Z' }, value: -0.7, sensorsId: 1, locationsId: 2162 },
      { datetime: { utc: '2026-07-21T09:00:00Z' }, value: -10, sensorsId: 2, locationsId: 10496 },
    ]
    const clamped = buildOpenaqStations(registry, [['pm2_5', rows]])
    expect(clamped).toHaveLength(1)
    expect(clamped[0]!.properties.id).toBe('openaq:2162')
    expect(clamped[0]!.properties.values.pm2_5).toEqual({ v: 0, ts: '2026-07-21T09:00:00Z' })
  })

  it('drops readings timestamped more than 10 minutes ahead of ingest time', () => {
    const rows: OaLatestRow[] = [
      { datetime: { utc: '2026-07-21T12:11:00Z' }, value: 8, sensorsId: 1, locationsId: 2162 },
      { datetime: { utc: '2026-07-21T12:09:00Z' }, value: 6, sensorsId: 2, locationsId: 10496 },
    ]
    const kept = buildOpenaqStations(registry, [['pm2_5', rows]], NOW)
    expect(kept.map((s) => s.properties.id)).toEqual(['openaq:10496'])
  })

  it('normalizes row timestamps to ISO 8601 Z', () => {
    const rows: OaLatestRow[] = [
      {
        datetime: { utc: '2026-07-21T09:00:00+00:00' },
        value: 3,
        sensorsId: 1,
        locationsId: 10496,
      },
    ]
    const [station] = buildOpenaqStations(buildRegistry(locationsPage.results), [['no2', rows]])
    expect(station!.properties.values.no2?.ts).toBe('2026-07-21T09:00:00Z')
  })
})

describe('fetchOpenaq', () => {
  it('skips without failing when OPENAQ_API_KEY is not set', async () => {
    const result = await fetchOpenaq({ env: {} })
    expect(result.status).toEqual({
      id: 'openaq',
      ok: false,
      detail: 'OPENAQ_API_KEY not set; official layer skipped',
    })
    expect(result.stations).toEqual([])
  })

  it('verifies parameter ids, fetches registry then per-parameter latest, joining into stations', async () => {
    const { calls, impl } = stubFetch((url) => {
      if (url.includes('/parameters?')) return { body: parametersPage }
      if (url.includes('/locations?')) return { body: locationsPage }
      if (url.includes('/parameters/2/latest')) return { body: latestPm25Page }
      return { body: EMPTY_PAGE }
    })
    const result = await fetchOpenaq({
      env: { OPENAQ_API_KEY: 'test-key' },
      fetchImpl: impl,
      now: NOW,
      spacingMs: 0,
      minStations: 0,
    })

    expect(result.status.ok).toBe(true)
    expect(result.status.stations).toBe(2)
    expect(result.stations.map((s) => s.properties.id).sort()).toEqual([
      'openaq:10496',
      'openaq:2162',
    ])

    // the µg/m³-series guard runs first, then the registry
    expect(calls[0]).toBe('https://api.openaq.org/v3/parameters?limit=1000')
    expect(calls[1]).toBe(
      'https://api.openaq.org/v3/locations?bbox=-25,34,45,72&monitor=true&limit=1000&page=1'
    )
    // datetime_min = now − 6 h, ISO without milliseconds, URL-encoded
    expect(calls[2]).toContain('/parameters/2/latest?limit=1000&datetime_min=2026-07-21T06%3A00%3A00Z&page=1')
    // one latest listing per mass-series parameter id, in order (never the ppm ids 7-10)
    expect(calls.slice(2).map((u) => /\/parameters\/(\d+)\//.exec(u)?.[1])).toEqual([
      '2',
      '1',
      '5',
      '3',
      '6',
      '4',
    ])
  })

  it('fails the source when a configured id no longer resolves to the µg/m³ series', async () => {
    const mutated = {
      ...parametersPage,
      results: parametersPage.results.map((row) =>
        row.id === 5 ? { ...row, units: 'ppm' } : row
      ),
    }
    const { calls, impl } = stubFetch((url) => {
      if (url.includes('/parameters?')) return { body: mutated }
      return { body: EMPTY_PAGE }
    })
    const result = await fetchOpenaq({
      env: { OPENAQ_API_KEY: 'test-key' },
      fetchImpl: impl,
      spacingMs: 0,
      minStations: 0,
      warn: () => {},
    })
    expect(result.status.ok).toBe(false)
    expect(result.status.detail).toContain('parameter id 5')
    expect(result.status.detail).toContain('mislabeled')
    expect(calls.filter((u) => u.includes('/locations?'))).toHaveLength(0)
    expect(result.stations).toEqual([])
  })

  it('reports ok:false when the yield is implausibly low (default floor 100)', async () => {
    const { impl } = stubFetch((url) => {
      if (url.includes('/parameters?')) return { body: parametersPage }
      if (url.includes('/locations?')) return { body: locationsPage }
      if (url.includes('/parameters/2/latest')) return { body: latestPm25Page }
      return { body: EMPTY_PAGE }
    })
    const result = await fetchOpenaq({
      env: { OPENAQ_API_KEY: 'test-key' },
      fetchImpl: impl,
      now: NOW,
      spacingMs: 0,
    })
    expect(result.status.ok).toBe(false)
    expect(result.status.detail).toContain('implausibly low yield: 2 stations < floor 100')
    expect(result.stations).toEqual([])
  })

  it('spaces requests ≥ spacingMs and sleeps until reset when the rate limit is exhausted', async () => {
    let t = 0
    const sleeps: number[] = []
    const { impl } = stubFetch((url) => {
      if (url.includes('/parameters?')) return { body: parametersPage }
      if (url.includes('/locations?')) {
        return {
          body: locationsPage,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '7' },
        }
      }
      return { body: EMPTY_PAGE }
    })
    const result = await fetchOpenaq({
      env: { OPENAQ_API_KEY: 'test-key' },
      fetchImpl: impl,
      now: NOW,
      spacingMs: 1100,
      minStations: 0,
      nowMs: () => t,
      sleepImpl: async (ms) => {
        sleeps.push(ms)
        t += ms
      },
    })
    expect(result.status.ok).toBe(true)
    // no wait before the first request; plain spacing before /locations; the
    // exhausted-limit response pushes the next request out to the 7 s reset;
    // the remaining latest listings fall back to plain spacing
    expect(sleeps[0]).toBe(1100)
    expect(sleeps[1]).toBe(7000)
    expect(sleeps.slice(2)).toEqual([1100, 1100, 1100, 1100, 1100])
  })

  it('paginates using meta.found, including the ">N" string form', async () => {
    const [a, b, c] = locationsPage.results
    const { calls, impl } = stubFetch((url) => {
      if (url.includes('/parameters?')) return { body: parametersPage }
      if (url.includes('/locations?')) {
        if (url.endsWith('page=1')) return { body: { meta: { limit: 2, found: '>2' }, results: [a, b] } }
        return { body: { meta: { limit: 2, found: '>2' }, results: [c] } }
      }
      return { body: EMPTY_PAGE }
    })
    const result = await fetchOpenaq({
      env: { OPENAQ_API_KEY: 'test-key' },
      fetchImpl: impl,
      spacingMs: 0,
      minStations: 0,
    })
    expect(result.status.ok).toBe(true)
    const locationCalls = calls.filter((u) => u.includes('/locations?'))
    expect(locationCalls).toHaveLength(2)
    expect(locationCalls[1]).toContain('page=2')
  })

  it('retries 429 responses with backoff and then succeeds', async () => {
    let latestHits = 0
    const { impl } = stubFetch((url) => {
      if (url.includes('/parameters?')) return { body: parametersPage }
      if (url.includes('/locations?')) return { body: locationsPage }
      if (url.includes('/parameters/2/latest')) {
        latestHits++
        if (latestHits === 1) return { status: 429, body: {}, headers: { 'retry-after': '0' } }
        return { body: latestPm25Page }
      }
      return { body: EMPTY_PAGE }
    })
    const result = await fetchOpenaq({
      env: { OPENAQ_API_KEY: 'test-key' },
      fetchImpl: impl,
      now: NOW,
      spacingMs: 0,
      minStations: 0,
    })
    expect(latestHits).toBe(2)
    expect(result.status.ok).toBe(true)
    expect(result.status.stations).toBe(2)
  }, 10_000)

  it('reports a failed status instead of throwing on hard HTTP errors', async () => {
    const { impl } = stubFetch(() => ({ status: 401, body: { detail: 'invalid key' } }))
    const result = await fetchOpenaq({
      env: { OPENAQ_API_KEY: 'bad-key' },
      fetchImpl: impl,
      spacingMs: 0,
      minStations: 0,
    })
    expect(result.status.ok).toBe(false)
    expect(result.status.detail).toContain('HTTP 401')
    expect(result.stations).toEqual([])
  })

  describe('registry persistence', () => {
    const cachedEntries: Array<[number, RegistryEntry]> = [
      [2162, { name: 'London Marylebone Road', country: 'GB', lon: -0.15459, lat: 51.52254 }],
    ]

    it('reuses a cached registry younger than 24 h and skips /locations', async () => {
      const { state, store } = memoryRegistryStore(
        JSON.stringify({ fetchedAt: '2026-07-21T02:00:00Z', entries: cachedEntries })
      )
      const { calls, impl } = stubFetch((url) => {
        if (url.includes('/parameters?')) return { body: parametersPage }
        if (url.includes('/parameters/2/latest')) return { body: latestPm25Page }
        return { body: EMPTY_PAGE }
      })
      const result = await fetchOpenaq({
        env: { OPENAQ_API_KEY: 'test-key' },
        fetchImpl: impl,
        now: NOW,
        spacingMs: 0,
        minStations: 0,
        registryStore: store,
      })
      expect(result.status.ok).toBe(true)
      expect(calls.some((u) => u.includes('/locations?'))).toBe(false)
      expect(result.stations.map((s) => s.properties.id)).toEqual(['openaq:2162'])
      expect(state.saves).toBe(0)
    })

    it('refetches /locations and saves when the cached registry is older than 24 h', async () => {
      const { state, store } = memoryRegistryStore(
        JSON.stringify({ fetchedAt: '2026-07-19T00:00:00Z', entries: cachedEntries })
      )
      const { calls, impl } = stubFetch((url) => {
        if (url.includes('/parameters?')) return { body: parametersPage }
        if (url.includes('/locations?')) return { body: locationsPage }
        if (url.includes('/parameters/2/latest')) return { body: latestPm25Page }
        return { body: EMPTY_PAGE }
      })
      const result = await fetchOpenaq({
        env: { OPENAQ_API_KEY: 'test-key' },
        fetchImpl: impl,
        now: NOW,
        spacingMs: 0,
        minStations: 0,
        registryStore: store,
      })
      expect(result.status.ok).toBe(true)
      expect(calls.some((u) => u.includes('/locations?'))).toBe(true)
      expect(state.saves).toBe(1)
      const saved = JSON.parse(state.value!) as { fetchedAt: string; entries: unknown[] }
      expect(saved.fetchedAt).toBe(NOW.toISOString())
      expect(saved.entries).toHaveLength(3)
    })

    it('falls back to a stale cached registry when /locations fails, with a warning in detail', async () => {
      const { store } = memoryRegistryStore(
        JSON.stringify({ fetchedAt: '2026-07-19T00:00:00Z', entries: cachedEntries })
      )
      const { impl } = stubFetch((url) => {
        if (url.includes('/parameters?')) return { body: parametersPage }
        if (url.includes('/locations?')) return { status: 404, body: {} }
        if (url.includes('/parameters/2/latest')) return { body: latestPm25Page }
        return { body: EMPTY_PAGE }
      })
      const result = await fetchOpenaq({
        env: { OPENAQ_API_KEY: 'test-key' },
        fetchImpl: impl,
        now: NOW,
        spacingMs: 0,
        minStations: 0,
        registryStore: store,
        warn: () => {},
      })
      expect(result.status.ok).toBe(true)
      expect(result.status.detail).toContain('using cached registry from 2026-07-19T00:00:00Z')
      expect(result.stations.map((s) => s.properties.id)).toEqual(['openaq:2162'])
    })
  })
})
