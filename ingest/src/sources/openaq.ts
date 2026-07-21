import { EUROPE_BBOX, type Param, type Reading } from '@aerismap/shared'
import { fetchJson, sleep } from '../http'
import type { SourceResult, StationDraft } from '../types'

const API_BASE = 'https://api.openaq.org/v3'
const PAGE_LIMIT = 1000
/** Hard cap per paginated listing — ~40k rows; anything beyond that is a bug upstream or here. */
const MAX_PAGES = 40
/** OpenAQ's hard limit is 60 req/min — ≥1.1 s spacing keeps sequential requests under it. */
const REQUEST_SPACING_MS = 1_100
/** Ignore "latest" values older than this — dead series still appear in /latest. */
const FRESHNESS_WINDOW_SEC = 6 * 3600
/** Readings further ahead than this are clock skew and would render permanently fresh. */
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000
/** A single OpenAQ page beyond this is upstream misbehaviour, not data. */
const MAX_PAGE_BYTES = 8 * 1024 * 1024
/** Below this the fetch "worked" but the data is implausible (normal ≈ 3.5–4.5k stations). */
const MIN_PLAUSIBLE_STATIONS = 100
/** Persisted /locations registry object (Cloudflare KV when configured, else the local out dir). */
export const OPENAQ_REGISTRY_KEY = 'internal/openaq-registry.json'
/** Reuse the persisted registry below this age; refetch /locations beyond it. */
const REGISTRY_TTL_MS = 24 * 3600 * 1000

/**
 * OpenAQ v3 parameter ids for the mass-concentration (µg/m³) series, with the
 * upstream names the runtime guard asserts against. Verified against OpenAQ's
 * own measurands seed: pm10=1, pm25=2, o3=3, co=4, no2=5, so2=6 are µg/m³;
 * ids 7–10 are the ppm series and must never be used.
 */
const PARAMETER_IDS: ReadonlyArray<{ id: number; param: Param; oaName: string }> = [
  { id: 2, param: 'pm2_5', oaName: 'pm25' },
  { id: 1, param: 'pm10', oaName: 'pm10' },
  { id: 5, param: 'no2', oaName: 'no2' },
  { id: 3, param: 'o3', oaName: 'o3' },
  { id: 6, param: 'so2', oaName: 'so2' },
  { id: 4, param: 'co', oaName: 'co' },
]
const MASS_UNITS = 'µg/m³'

// Documented response shapes (docs.openaq.org) — fields we read, all optional
// so a partial upstream change degrades to dropped rows, not a crash.
interface OaPage<T> {
  meta?: { limit?: number; found?: number | string } | null
  results?: T[] | null
}

export interface OaLocation {
  id?: number
  name?: string | null
  country?: { code?: string | null } | null
  coordinates?: { latitude?: number | null; longitude?: number | null } | null
}

export interface OaLatestRow {
  datetime?: { utc?: string | null } | null
  value?: number
  sensorsId?: number
  locationsId?: number
}

interface OaParameterRow {
  id?: number
  name?: string | null
  units?: string | null
}

export interface RegistryEntry {
  name?: string
  country?: string
  lon: number
  lat: number
}

/** Persists the /locations registry between runs — see OPENAQ_REGISTRY_KEY. */
export interface RegistryStore {
  /** Serialized registry JSON, or undefined when no copy exists. */
  load(): Promise<string | undefined>
  save(body: string): Promise<void>
}

interface CachedRegistry {
  fetchedAt: string
  entries: Array<[number, RegistryEntry]>
}

function parseCachedRegistry(raw: string): CachedRegistry | undefined {
  try {
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown; entries?: unknown }
    if (
      typeof parsed?.fetchedAt !== 'string' ||
      Number.isNaN(Date.parse(parsed.fetchedAt)) ||
      !Array.isArray(parsed.entries)
    ) {
      return undefined
    }
    return { fetchedAt: parsed.fetchedAt, entries: parsed.entries as Array<[number, RegistryEntry]> }
  } catch {
    return undefined
  }
}

/**
 * Runtime guard for PARAMETER_IDS: every configured id must still resolve to
 * the expected (name, µg/m³) pair in /v3/parameters. A mismatch means OpenAQ
 * renumbered or we misconfigured — either way, ingesting would publish
 * mislabeled series, so the source must fail.
 */
async function verifyParameterIds(get: (url: string) => Promise<unknown>): Promise<void> {
  const page = (await get(`${API_BASE}/parameters?limit=${PAGE_LIMIT}`)) as OaPage<OaParameterRow>
  const byId = new Map<number, OaParameterRow>()
  for (const row of page.results ?? []) {
    if (typeof row?.id === 'number') byId.set(row.id, row)
  }
  for (const { id, oaName } of PARAMETER_IDS) {
    const row = byId.get(id)
    const name = typeof row?.name === 'string' ? row.name : undefined
    // Tolerate µ (U+00B5) vs μ (U+03BC) — same glyph, either could appear upstream.
    const units =
      typeof row?.units === 'string' ? row.units.replace(/μ/g, 'µ') : undefined
    if (name !== oaName || units !== MASS_UNITS) {
      throw new Error(
        `parameter id ${id} should be (${oaName}, ${MASS_UNITS}) but /parameters reports ` +
          `(${name ?? 'missing'}, ${units ?? 'missing'}) — refusing to ingest a mislabeled series`
      )
    }
  }
}

/** Location registry keyed by locations id; rows without usable coordinates are dropped. */
export function buildRegistry(locations: readonly OaLocation[]): Map<number, RegistryEntry> {
  const registry = new Map<number, RegistryEntry>()
  for (const loc of locations) {
    const lon = loc.coordinates?.longitude
    const lat = loc.coordinates?.latitude
    if (
      typeof loc.id !== 'number' ||
      typeof lon !== 'number' ||
      typeof lat !== 'number' ||
      !Number.isFinite(lon) ||
      !Number.isFinite(lat)
    ) {
      continue
    }
    const country = loc.country?.code
    registry.set(loc.id, {
      ...(typeof loc.name === 'string' && loc.name !== '' ? { name: loc.name } : {}),
      ...(typeof country === 'string' && /^[A-Za-z]{2}$/.test(country)
        ? { country: country.toUpperCase() }
        : {}),
      lon,
      lat,
    })
  }
  return registry
}

/**
 * Join latest rows onto the registry. Rows for unknown locations (non-monitor
 * or out-of-bbox) are dropped, as are non-finite values, sentinel negatives
 * (≤ −10, e.g. OpenAQ passes through −999), rows without a UTC timestamp and
 * — when `now` is given — rows timestamped more than 10 minutes ahead of it
 * (clock-skewed stations). Small negatives (−10 < v < 0) are instrument noise
 * in clean air and clamp to 0. Newest timestamp wins per (location, param).
 */
export function buildOpenaqStations(
  registry: ReadonlyMap<number, RegistryEntry>,
  rowsByParam: ReadonlyArray<readonly [Param, readonly OaLatestRow[]]>,
  now?: Date
): StationDraft[] {
  const valuesByLocation = new Map<number, Partial<Record<Param, Reading>>>()

  for (const [param, rows] of rowsByParam) {
    for (const row of rows) {
      const locationId = row.locationsId
      if (typeof locationId !== 'number' || !registry.has(locationId)) continue
      const value = row.value
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= -10) continue
      const v = value < 0 ? 0 : value
      const utc = row.datetime?.utc
      if (typeof utc !== 'string') continue
      const parsedTs = Date.parse(utc)
      if (Number.isNaN(parsedTs)) continue
      if (now !== undefined && parsedTs > now.getTime() + MAX_FUTURE_SKEW_MS) continue
      const ts = new Date(parsedTs).toISOString().replace('.000Z', 'Z')

      let values = valuesByLocation.get(locationId)
      if (!values) {
        values = {}
        valuesByLocation.set(locationId, values)
      }
      const existing = values[param]
      if (!existing || parsedTs > Date.parse(existing.ts)) {
        values[param] = { v, ts }
      }
    }
  }

  const stations: StationDraft[] = []
  for (const [locationId, values] of valuesByLocation) {
    const entry = registry.get(locationId)
    if (!entry) continue
    stations.push({
      lon: entry.lon,
      lat: entry.lat,
      properties: {
        id: `openaq:${locationId}`,
        source: 'openaq',
        nativeId: String(locationId),
        ...(entry.name ? { name: entry.name } : {}),
        kind: 'reference',
        ...(entry.country ? { country: entry.country } : {}),
        license: 'per-source (OpenAQ/EEA)',
        exactLocation: true,
        values,
      },
    })
  }
  return stations
}

export interface OpenaqOptions {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: Date
  /** Overridable for tests; production default 1100 ms. */
  spacingMs?: number
  /** Overridable for tests; production floor MIN_PLAUSIBLE_STATIONS. */
  minStations?: number
  /** Persistent registry cache; when absent, /locations is fetched every run. */
  registryStore?: RegistryStore
  warn?: (message: string) => void
  /** Injectable clock/sleep so pacing is testable without waiting. */
  nowMs?: () => number
  sleepImpl?: (ms: number) => Promise<void>
}

export async function fetchOpenaq(options: OpenaqOptions = {}): Promise<SourceResult> {
  const {
    env = process.env,
    fetchImpl,
    now = new Date(),
    spacingMs = REQUEST_SPACING_MS,
    minStations = MIN_PLAUSIBLE_STATIONS,
    registryStore,
    warn = (m) => console.warn(`[ingest] openaq: ${m}`),
    nowMs = () => Date.now(),
    sleepImpl = sleep,
  } = options

  const apiKey = env.OPENAQ_API_KEY
  if (!apiKey) {
    return {
      status: { id: 'openaq', ok: false, detail: 'OPENAQ_API_KEY not set; official layer skipped' },
      stations: [],
    }
  }

  let lastRequestAt = Number.NEGATIVE_INFINITY
  /** Epoch ms before which no request may start — pushed out when the rate limit is exhausted. */
  let notBefore = 0

  async function pacedGet(url: string): Promise<unknown> {
    const wait = Math.max(lastRequestAt + spacingMs, notBefore) - nowMs()
    if (wait > 0) await sleepImpl(wait)
    lastRequestAt = nowMs()
    return fetchJson(url, {
      timeoutMs: 30_000,
      retries: 3,
      backoffMs: 1_000,
      maxBytes: MAX_PAGE_BYTES,
      headers: { 'X-API-Key': apiKey! },
      fetchImpl,
      onResponseHeaders: (headers) => {
        const remaining = Number(headers.get('x-ratelimit-remaining'))
        const resetSec = Number(headers.get('x-ratelimit-reset'))
        if (remaining === 0 && Number.isFinite(resetSec) && resetSec > 0) {
          notBefore = nowMs() + Math.min(resetSec, 60) * 1_000
        }
      },
    })
  }

  async function pagedList<T>(makeUrl: (page: number) => string): Promise<T[]> {
    const all: T[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = makeUrl(page)
      const data = (await pacedGet(url)) as OaPage<T>

      const results = Array.isArray(data.results) ? data.results : []
      all.push(...results)
      const limit = data.meta?.limit ?? PAGE_LIMIT
      if (results.length < limit) return all
      // meta.found is a number, or a string like ">1000" meaning "more pages exist".
      const found = data.meta?.found
      if (typeof found === 'number' && page * limit >= found) return all
      if (page === MAX_PAGES) warn(`page cap ${MAX_PAGES} reached for ${url}; results truncated`)
    }
    return all
  }

  try {
    // Cheap once-per-run guard: the configured ids must still be the µg/m³ series.
    await verifyParameterIds(pacedGet)

    let cached: CachedRegistry | undefined
    if (registryStore) {
      try {
        const raw = await registryStore.load()
        if (raw !== undefined) {
          cached = parseCachedRegistry(raw)
          if (!cached) warn('cached registry is malformed; refetching /locations')
        }
      } catch (err) {
        warn(`cached registry load failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    let registry: Map<number, RegistryEntry>
    let registryWarning: string | undefined
    const cacheAgeMs = cached ? now.getTime() - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY
    if (cached && cacheAgeMs >= 0 && cacheAgeMs < REGISTRY_TTL_MS) {
      registry = new Map(cached.entries)
    } else {
      try {
        const locations = await pagedList<OaLocation>(
          (page) =>
            `${API_BASE}/locations?bbox=${EUROPE_BBOX.join(',')}&monitor=true&limit=${PAGE_LIMIT}&page=${page}`
        )
        registry = buildRegistry(locations)
        if (registryStore) {
          try {
            await registryStore.save(
              JSON.stringify({ fetchedAt: now.toISOString(), entries: [...registry] })
            )
          } catch (err) {
            warn(`registry cache save failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      } catch (err) {
        if (!cached) throw err
        registryWarning = `/locations refresh failed (${err instanceof Error ? err.message : String(err)}); using cached registry from ${cached.fetchedAt}`
        warn(registryWarning)
        registry = new Map(cached.entries)
      }
    }

    const datetimeMin = new Date(now.getTime() - FRESHNESS_WINDOW_SEC * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')

    const rowsByParam: Array<readonly [Param, OaLatestRow[]]> = []
    for (const { id, param } of PARAMETER_IDS) {
      const rows = await pagedList<OaLatestRow>(
        (page) =>
          `${API_BASE}/parameters/${id}/latest?limit=${PAGE_LIMIT}&datetime_min=${encodeURIComponent(datetimeMin)}&page=${page}`
      )
      rowsByParam.push([param, rows])
    }

    const stations = buildOpenaqStations(registry, rowsByParam, now)
    if (stations.length < minStations) {
      return {
        status: {
          id: 'openaq',
          ok: false,
          detail: `implausibly low yield: ${stations.length} stations < floor ${minStations} (normal ≈ 3.5–4.5k) — not publishing this source`,
        },
        stations: [],
      }
    }
    return {
      status: {
        id: 'openaq',
        ok: true,
        fetchedAt: new Date().toISOString(),
        stations: stations.length,
        ...(registryWarning ? { detail: registryWarning } : {}),
      },
      stations,
    }
  } catch (err) {
    return {
      status: {
        id: 'openaq',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      },
      stations: [],
    }
  }
}
