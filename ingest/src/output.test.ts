import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { STORE_KEYS, type AreaSnapshot, type StoreMetadata } from '@aerismap/shared'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildArtifacts,
  getFromKv,
  loadPreviousStations,
  readKvConfig,
  readLocalObject,
  uploadToKv,
  writeLocal,
  type KvConfig,
} from './output'
import { buildSnapshot } from './snapshot'
import type { SourceResult } from './types'

const NOW = new Date('2026-07-21T12:00:00Z')

const result: SourceResult = {
  status: { id: 'sensor-community', ok: true, fetchedAt: NOW.toISOString(), stations: 1 },
  stations: [
    {
      lon: 9.2,
      lat: 48.53,
      properties: {
        id: 'sensor-community:49',
        source: 'sensor-community',
        nativeId: '49',
        kind: 'community',
        country: 'DE',
        license: 'ODbL-1.0',
        exactLocation: false,
        values: { pm2_5: { v: 12, ts: '2026-07-21T11:50:00Z' } },
      },
    },
  ],
}
const snapshot = buildSnapshot([result], NOW)

const KV: KvConfig = { accountId: 'acct', namespaceId: 'ns', apiToken: 'secret-token' }

function kvUrl(key: string): string {
  return (
    'https://api.cloudflare.com/client/v4/accounts/acct/storage/kv/namespaces/ns/values/' +
    encodeURIComponent(key)
  )
}

function apiOk(): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: null }), {
    status: 200,
  })
}

function apiError(status: number, errors: Array<{ code: number; message: string }>): Response {
  return new Response(JSON.stringify({ success: false, errors, messages: [], result: null }), {
    status,
  })
}

interface FetchCall {
  url: string
  init: RequestInit
}

/** Stub global fetch (the KV client's default) and record every call. */
function stubFetch(
  handler: (url: string, init: RequestInit, call: number) => Response | Promise<Response>
): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} }
    calls.push(call)
    return handler(call.url, call.init, calls.length)
  })
  return { calls }
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

async function readParts(init: RequestInit): Promise<{ value: Buffer; metadata: StoreMetadata }> {
  const form = init.body as FormData
  const value = form.get('value')
  const metadata = form.get('metadata')
  expect(value).toBeInstanceOf(Blob)
  expect(typeof metadata).toBe('string')
  return {
    value: Buffer.from(await (value as Blob).arrayBuffer()),
    metadata: JSON.parse(metadata as string) as StoreMetadata,
  }
}

describe('buildArtifacts', () => {
  const artifacts = buildArtifacts(snapshot)

  it('emits a gzipped GeoJSON that round-trips, and meta.json last as the atomic pointer', () => {
    expect(artifacts.map((a) => a.key)).toEqual([STORE_KEYS.stations, STORE_KEYS.meta])
    const stations = artifacts[0]!
    expect(stations.contentType).toBe('application/geo+json')
    expect(stations.contentEncoding).toBe('gzip')
    expect(JSON.parse(gunzipSync(stations.body).toString('utf8'))).toEqual(
      JSON.parse(JSON.stringify(snapshot.collection))
    )
    const meta = artifacts[1]!
    expect(meta.contentType).toBe('application/json')
    expect(meta.contentEncoding).toBeUndefined()
    expect(JSON.parse(meta.body.toString('utf8'))).toEqual(JSON.parse(JSON.stringify(snapshot.meta)))
  })

  it('inserts the areas artifact before meta.json and round-trips it through gzip', () => {
    const areas: AreaSnapshot = {
      generatedAt: NOW.toISOString(),
      areas: {
        DE11: { n: 4, nRef: 1, nCom: 3, eaqi: 2, pollutant: 'pm2_5', med: { pm2_5: 8.5 }, cnt: { pm2_5: 4 } },
        DE111: { n: 2, nRef: 0, nCom: 2, med: { pm2_5: 8.5 }, cnt: { pm2_5: 2 } },
      },
    }
    const withAreas = buildArtifacts(snapshot, areas)
    expect(withAreas.map((a) => a.key)).toEqual([STORE_KEYS.stations, STORE_KEYS.areas, STORE_KEYS.meta])
    const artifact = withAreas[1]!
    expect(artifact.contentType).toBe('application/json')
    expect(artifact.contentEncoding).toBe('gzip')
    expect(JSON.parse(gunzipSync(artifact.body).toString('utf8'))).toEqual(
      JSON.parse(JSON.stringify(areas))
    )
  })
})

describe('writeLocal', () => {
  let dir: string | undefined
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('mirrors the KV key layout on disk', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aerismap-ingest-test-'))
    const artifacts = buildArtifacts(snapshot)
    const paths = await writeLocal(artifacts, dir)
    expect(paths).toEqual([join(dir, STORE_KEYS.stations), join(dir, STORE_KEYS.meta)])
    const gz = await readFile(paths[0]!)
    expect(JSON.parse(gunzipSync(gz).toString('utf8')).type).toBe('FeatureCollection')
  })
})

describe('uploadToKv', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('PUTs each artifact as multipart value+metadata with etag/size/encoding, meta.json last', async () => {
    const { calls } = stubFetch(() => apiOk())
    const areas: AreaSnapshot = { generatedAt: NOW.toISOString(), areas: {} }
    const artifacts = buildArtifacts(snapshot, areas)

    await uploadToKv(artifacts, KV)

    // Same ordering as buildArtifacts — the meta.json pointer is written last.
    expect(calls.map((c) => c.url)).toEqual([
      kvUrl(STORE_KEYS.stations),
      kvUrl(STORE_KEYS.areas),
      kvUrl(STORE_KEYS.meta),
    ])
    for (const call of calls) {
      expect(call.init.method).toBe('PUT')
      expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
    }

    const stations = await readParts(calls[0]!.init)
    expect(stations.value.equals(artifacts[0]!.body)).toBe(true)
    expect(stations.metadata).toEqual({
      etag: sha256(artifacts[0]!.body),
      size: artifacts[0]!.body.byteLength,
      contentType: 'application/geo+json',
      contentEncoding: 'gzip',
    })

    const meta = await readParts(calls[2]!.init)
    expect(meta.value.equals(artifacts[2]!.body)).toBe(true)
    expect(meta.metadata).toEqual({
      etag: sha256(artifacts[2]!.body),
      size: artifacts[2]!.body.byteLength,
      contentType: 'application/json',
    })
    expect(meta.metadata.contentEncoding).toBeUndefined()
  })

  it('fails fast on a non-retryable status, quoting the API errors[] and never reaching meta.json', async () => {
    const { calls } = stubFetch(() =>
      apiError(403, [{ code: 10000, message: 'Authentication error' }])
    )
    await expect(uploadToKv(buildArtifacts(snapshot), KV)).rejects.toThrow(
      /KV PUT latest\/stations\.geojson\.gz failed: HTTP 403 — 10000 Authentication error/
    )
    expect(calls).toHaveLength(1) // no retry on 4xx, and meta.json was never attempted
  })

  it('retries 5xx with backoff and succeeds on a later attempt', async () => {
    const { calls } = stubFetch((_url, _init, call) =>
      call === 1 ? apiError(500, [{ code: 10013, message: 'internal error' }]) : apiOk()
    )
    const artifacts = buildArtifacts(snapshot)
    await uploadToKv([artifacts[0]!], KV, { backoffMs: 0 })
    expect(calls.map((c) => c.url)).toEqual([kvUrl(STORE_KEYS.stations), kvUrl(STORE_KEYS.stations)])
  })

  it('surfaces the API errors[] after retries are exhausted on persistent 5xx', async () => {
    const { calls } = stubFetch(() => apiError(500, [{ code: 10013, message: 'internal error' }]))
    await expect(uploadToKv([buildArtifacts(snapshot)[0]!], KV, { backoffMs: 0 })).rejects.toThrow(
      /HTTP 500 — 10013 internal error/
    )
    expect(calls).toHaveLength(3) // first attempt + 2 retries
  })
})

describe('getFromKv', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GETs the raw value with the bearer token', async () => {
    const { calls } = stubFetch(() => new Response(new Uint8Array([1, 2, 3])))
    const body = await getFromKv('internal/openaq-registry.json', KV)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(kvUrl('internal/openaq-registry.json'))
    expect(calls[0]!.init.method).toBe('GET')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
    expect(body?.equals(Buffer.from([1, 2, 3]))).toBe(true)
  })

  it('treats 404 as absent', async () => {
    stubFetch(() => apiError(404, [{ code: 10009, message: "get: 'key not found'" }]))
    expect(await getFromKv(STORE_KEYS.stations, KV)).toBeUndefined()
  })

  it('throws with the API errors[] on other failures', async () => {
    stubFetch(() => apiError(403, [{ code: 10000, message: 'Authentication error' }]))
    await expect(getFromKv(STORE_KEYS.stations, KV)).rejects.toThrow(
      /KV GET latest\/stations\.geojson\.gz failed: HTTP 403 — 10000 Authentication error/
    )
  })
})

describe('loadPreviousStations (KV carry-forward)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('round-trips the previously published artifact from KV', async () => {
    const stationsArtifact = buildArtifacts(snapshot)[0]!
    const { calls } = stubFetch(() => new Response(new Uint8Array(stationsArtifact.body)))
    const previous = await loadPreviousStations(KV, undefined, () => {})
    expect(calls.map((c) => c.url)).toEqual([kvUrl(STORE_KEYS.stations)])
    expect(previous?.features.map((f) => f.properties.id)).toEqual(['sensor-community:49'])
  })

  it('tolerates KV absence (404) without a warning', async () => {
    stubFetch(() => apiError(404, [{ code: 10009, message: "get: 'key not found'" }]))
    const warnings: string[] = []
    expect(await loadPreviousStations(KV, undefined, (m) => warnings.push(m))).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('degrades a KV failure to a warning', async () => {
    stubFetch(() => apiError(403, [{ code: 10000, message: 'Authentication error' }]))
    const warnings: string[] = []
    expect(await loadPreviousStations(KV, undefined, (m) => warnings.push(m))).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('10000 Authentication error')
  })
})

describe('loadPreviousStations (local out dir)', () => {
  const dirs: string[] = []
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })
  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'aerismap-ingest-test-'))
    dirs.push(dir)
    return dir
  }

  it('round-trips the previously published artifact', async () => {
    const dir = await tempDir()
    await writeLocal(buildArtifacts(snapshot), dir)
    const previous = await loadPreviousStations(undefined, dir, () => {})
    expect(previous?.features.map((f) => f.properties.id)).toEqual(['sensor-community:49'])
  })

  it('tolerates absence', async () => {
    const dir = await tempDir()
    expect(await readLocalObject(STORE_KEYS.stations, dir)).toBeUndefined()
    expect(await loadPreviousStations(undefined, dir, () => {})).toBeUndefined()
    expect(await loadPreviousStations(undefined, undefined, () => {})).toBeUndefined()
  })

  it('tolerates a corrupt artifact with a warning', async () => {
    const dir = await tempDir()
    const path = join(dir, STORE_KEYS.stations)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'not gzip at all')
    const warnings: string[] = []
    expect(await loadPreviousStations(undefined, dir, (m) => warnings.push(m))).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })
})

describe('readKvConfig', () => {
  it('returns undefined unless all three Cloudflare settings are set', () => {
    expect(readKvConfig({})).toBeUndefined()
    expect(readKvConfig({ CLOUDFLARE_API_TOKEN: 'tok' })).toBeUndefined()
    expect(
      readKvConfig({ CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' })
    ).toBeUndefined()
    expect(
      readKvConfig({ CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_KV_NAMESPACE_ID: 'ns' })
    ).toBeUndefined()
  })

  it('maps the three env vars onto the config', () => {
    expect(
      readKvConfig({
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_KV_NAMESPACE_ID: 'ns',
      })
    ).toEqual({ accountId: 'acct', namespaceId: 'ns', apiToken: 'tok' })
  })
})
