import { API_PATHS, STORE_KEYS, type StoreMetadata } from '@aerismap/shared'
import { describe, expect, it } from 'vitest'

import worker, { type Env } from './index'

interface StoredValue {
  bytes: Uint8Array
  /** KV per-key metadata; omit to model a locally-seeded value without any. */
  metadata?: StoreMetadata | Record<string, unknown>
}

interface KvCall {
  key: string
  options: unknown
}

interface MockKv {
  kv: KVNamespace
  /** Every getWithMetadata invocation, in order. */
  calls: KvCall[]
  /** Keys whose returned stream was canceled instead of read. */
  canceled: string[]
}

/**
 * Minimal KVNamespace mock implementing the contract the worker relies on:
 * `getWithMetadata` returns `{ value: stream | null, metadata | null }` (both
 * null when the key is absent) and records calls plus stream cancellations.
 */
function makeKv(store: Partial<Record<string, StoredValue>>): MockKv {
  const calls: KvCall[] = []
  const canceled: string[] = []
  const getWithMetadata = async (key: string, options?: unknown) => {
    calls.push({ key, options })
    const stored = store[key]
    if (stored === undefined) return { value: null, metadata: null, cacheStatus: null }
    // Pull-based source: the underlying cancel() only fires when the worker
    // cancels the stream before consuming it (HEAD / 304 / 412 paths).
    const value = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(stored.bytes)
        controller.close()
      },
      cancel() {
        canceled.push(key)
      },
    })
    return { value, metadata: stored.metadata ?? null, cacheStatus: null }
  }
  return { kv: { getWithMetadata } as unknown as KVNamespace, calls, canceled }
}

function makeFetcher(body: string): Fetcher {
  return {
    fetch: async () => new Response(body),
    connect: () => {
      throw new Error('not implemented')
    },
  } as Fetcher
}

function makeEnv(data: KVNamespace, assetBody = 'asset'): Env {
  return { DATA: data, ASSETS: makeFetcher(assetBody) }
}

function storeEnv(store: Partial<Record<string, StoredValue>>, assetBody = 'asset'): Env {
  return makeEnv(makeKv(store).kv, assetBody)
}

function apiFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const request = new Request(`https://aerismap.example${path}`, init)
  return Promise.resolve(worker.fetch(request as Parameters<typeof worker.fetch>[0], env))
}

const GZ_BYTES = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4])
/** StoreMetadata.etag is the unquoted sha-256 hex… */
const SHA = 'abc123'
/** …and the worker serves it quoted as a strong validator. */
const ETAG = `"${SHA}"`
const GZ_META: StoreMetadata = {
  etag: SHA,
  size: GZ_BYTES.length,
  contentType: 'application/geo+json',
  contentEncoding: 'gzip',
}

describe('GET gzipped GeoJSON artifact', () => {
  const env = storeEnv({ [STORE_KEYS.stations]: { bytes: GZ_BYTES, metadata: GZ_META } })

  it('serves the stored bytes with passthrough gzip headers from StoreMetadata', async () => {
    const res = await apiFetch(env, API_PATHS.stations)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/geo+json')
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('Content-Length')).toBe(String(GZ_BYTES.length))
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('ETag')).toBe(ETAG)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GZ_BYTES)
  })

  it('reads KV as a stream with cacheTtl matching Cache-Control max-age', async () => {
    const mock = makeKv({ [STORE_KEYS.stations]: { bytes: GZ_BYTES, metadata: GZ_META } })
    const res = await apiFetch(makeEnv(mock.kv), API_PATHS.stations)
    await res.arrayBuffer()
    expect(mock.calls).toEqual([
      { key: STORE_KEYS.stations, options: { type: 'stream', cacheTtl: 300 } },
    ])
  })

  it('returns 304 with ETag + Cache-Control, no body, canceled stream when If-None-Match matches', async () => {
    const mock = makeKv({ [STORE_KEYS.stations]: { bytes: GZ_BYTES, metadata: GZ_META } })
    const res = await apiFetch(makeEnv(mock.kv), API_PATHS.stations, {
      headers: { 'If-None-Match': ETAG },
    })
    expect(res.status).toBe(304)
    expect(res.headers.get('ETag')).toBe(ETAG)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.body).toBeNull()
    expect(mock.canceled).toEqual([STORE_KEYS.stations])
  })

  it('matches If-None-Match through weak prefixes and etag lists', async () => {
    for (const value of [`W/${ETAG}`, `"other", ${ETAG}`, `"other", W/${ETAG}`, '*']) {
      const res = await apiFetch(env, API_PATHS.stations, {
        headers: { 'If-None-Match': value },
      })
      expect(res.status, `If-None-Match: ${value}`).toBe(304)
    }
  })

  it('serves 200 when If-None-Match does not match', async () => {
    const res = await apiFetch(env, API_PATHS.stations, {
      headers: { 'If-None-Match': '"other"' },
    })
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GZ_BYTES)
  })

  it('returns 412 problem+json and cancels the stream when If-Match does not match', async () => {
    const mock = makeKv({ [STORE_KEYS.stations]: { bytes: GZ_BYTES, metadata: GZ_META } })
    const res = await apiFetch(makeEnv(mock.kv), API_PATHS.stations, {
      headers: { 'If-Match': '"other"' },
    })
    expect(res.status).toBe(412)
    expect(res.headers.get('Content-Type')).toBe('application/problem+json')
    const body = (await res.json()) as { title: string; status: number }
    expect(body.title).toBe('Precondition failed')
    expect(body.status).toBe(412)
    expect(mock.canceled).toEqual([STORE_KEYS.stations])
  })

  it('serves 200 when If-Match matches (including weak prefix and lists)', async () => {
    for (const value of [ETAG, `W/${ETAG}`, `"other", ${ETAG}`, '*']) {
      const res = await apiFetch(env, API_PATHS.stations, {
        headers: { 'If-Match': value },
      })
      expect(res.status, `If-Match: ${value}`).toBe(200)
      await res.arrayBuffer()
    }
  })
})

describe('HEAD requests', () => {
  const metaBytes = new TextEncoder().encode('{}')
  const store: Partial<Record<string, StoredValue>> = {
    [STORE_KEYS.stations]: { bytes: GZ_BYTES, metadata: GZ_META },
    [STORE_KEYS.meta]: {
      bytes: metaBytes,
      metadata: { etag: SHA, size: metaBytes.length, contentType: 'application/json' },
    },
  }

  it('mirrors GET status/headers with a null body and cancels the stream on a gzip route', async () => {
    const mock = makeKv(store)
    const res = await apiFetch(makeEnv(mock.kv), API_PATHS.stations, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/geo+json')
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('Content-Length')).toBe(String(GZ_BYTES.length))
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('ETag')).toBe(ETAG)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.body).toBeNull()
    expect(mock.canceled).toEqual([STORE_KEYS.stations])
  })

  it('mirrors GET headers on the meta route', async () => {
    const res = await apiFetch(storeEnv(store), API_PATHS.meta, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(res.headers.get('Content-Length')).toBe(String(metaBytes.length))
    expect(res.body).toBeNull()
  })

  it('returns 304 on HEAD when If-None-Match matches', async () => {
    const res = await apiFetch(storeEnv(store), API_PATHS.stations, {
      method: 'HEAD',
      headers: { 'If-None-Match': ETAG },
    })
    expect(res.status).toBe(304)
    expect(res.headers.get('ETag')).toBe(ETAG)
    expect(res.body).toBeNull()
  })

  it('returns 404 when the artifact is missing', async () => {
    const res = await apiFetch(storeEnv({}), API_PATHS.stations, { method: 'HEAD' })
    expect(res.status).toBe(404)
  })
})

describe('values without usable StoreMetadata (e.g. seeded via seed:local)', () => {
  it('serves 200 with the stored bytes but no ETag/Content-Length when metadata is absent', async () => {
    const env = storeEnv({ [STORE_KEYS.stations]: { bytes: GZ_BYTES } })
    const res = await apiFetch(env, API_PATHS.stations)
    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).toBeNull()
    expect(res.headers.get('Content-Length')).toBeNull()
    expect(res.headers.get('Content-Type')).toBe('application/geo+json')
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GZ_BYTES)
  })

  it('treats malformed metadata like missing metadata instead of failing', async () => {
    const env = storeEnv({
      [STORE_KEYS.stations]: { bytes: GZ_BYTES, metadata: { etag: 42, size: 'nope' } },
    })
    const res = await apiFetch(env, API_PATHS.stations)
    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).toBeNull()
    expect(res.headers.get('Content-Length')).toBeNull()
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GZ_BYTES)
  })

  it('ignores conditional headers when there is no etag to validate against', async () => {
    const env = storeEnv({ [STORE_KEYS.stations]: { bytes: GZ_BYTES } })
    const res = await apiFetch(env, API_PATHS.stations, {
      headers: { 'If-None-Match': ETAG, 'If-Match': '"other"' },
    })
    expect(res.status).toBe(200)
    await res.arrayBuffer()
  })

  it('answers HEAD with a null body and a canceled stream', async () => {
    const mock = makeKv({ [STORE_KEYS.stations]: { bytes: GZ_BYTES } })
    const res = await apiFetch(makeEnv(mock.kv), API_PATHS.stations, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.body).toBeNull()
    expect(mock.canceled).toEqual([STORE_KEYS.stations])
  })
})

describe('GET areas', () => {
  const areasMeta: StoreMetadata = {
    etag: SHA,
    size: GZ_BYTES.length,
    contentType: 'application/json',
    contentEncoding: 'gzip',
  }

  it('serves the stored gzip bytes as application/json with passthrough headers', async () => {
    const env = storeEnv({ [STORE_KEYS.areas]: { bytes: GZ_BYTES, metadata: areasMeta } })
    const res = await apiFetch(env, API_PATHS.areas)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('Content-Length')).toBe(String(GZ_BYTES.length))
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('ETag')).toBe(ETAG)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GZ_BYTES)
  })

  it('mirrors GET headers with a null body on HEAD', async () => {
    const env = storeEnv({ [STORE_KEYS.areas]: { bytes: GZ_BYTES, metadata: areasMeta } })
    const res = await apiFetch(env, API_PATHS.areas, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('ETag')).toBe(ETAG)
    expect(res.body).toBeNull()
  })

  it('returns the transient (not planned-milestone) 404 detail when missing', async () => {
    const res = await apiFetch(storeEnv({}), API_PATHS.areas)
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toBe('application/problem+json')
    const body = (await res.json()) as { title: string; detail: string }
    expect(body.title).toBe('Data not yet available')
    expect(body.detail).toContain('Try again in a few minutes')
    expect(body.detail).not.toContain('planned')
  })
})

describe('GET meta', () => {
  it('serves meta.json as plain application/json', async () => {
    const bytes = new TextEncoder().encode('{"generatedAt":"2026-07-21T12:07:00Z"}')
    const env = storeEnv({
      [STORE_KEYS.meta]: {
        bytes,
        metadata: { etag: SHA, size: bytes.length, contentType: 'application/json' },
      },
    })
    const res = await apiFetch(env, API_PATHS.meta)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(res.headers.get('Content-Length')).toBe(String(bytes.length))
    expect(await res.text()).toContain('generatedAt')
  })
})

describe('error responses', () => {
  it('returns 404 problem+json when the artifact is not in KV yet', async () => {
    const res = await apiFetch(storeEnv({}), API_PATHS.stations)
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toBe('application/problem+json')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    const body = (await res.json()) as { title: string; status: number; detail: string }
    expect(body.title).toBe('Data not yet available')
    expect(body.status).toBe(404)
    expect(body.detail).toContain('Try again in a few minutes')
  })

  it('returns a planned-layer 404 detail for the M2 model layers', async () => {
    for (const path of [API_PATHS.tempIsobands, API_PATHS.aqiGrid]) {
      const res = await apiFetch(storeEnv({}), path)
      expect(res.status, path).toBe(404)
      const body = (await res.json()) as { title: string; detail: string }
      expect(body.title).toBe('Data not yet available')
      expect(body.detail).toBe(
        'This layer is planned (milestone M2) and is not published yet.'
      )
    }
  })

  it('serves a planned layer normally once its value exists (self-healing)', async () => {
    const env = storeEnv({
      [STORE_KEYS.tempIsobands]: {
        bytes: GZ_BYTES,
        metadata: { ...GZ_META, contentType: 'application/geo+json' },
      },
    })
    const res = await apiFetch(env, API_PATHS.tempIsobands)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GZ_BYTES)
  })

  it('returns 404 problem+json for unknown /api/* paths', async () => {
    const res = await apiFetch(storeEnv({}), '/api/v1/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toBe('application/problem+json')
    const body = (await res.json()) as { title: string }
    expect(body.title).toBe('Not found')
  })

  it('returns 405 problem+json with Allow: GET, HEAD for other methods', async () => {
    const res = await apiFetch(storeEnv({}), API_PATHS.stations, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('GET, HEAD')
    expect(res.headers.get('Content-Type')).toBe('application/problem+json')
    const body = (await res.json()) as { status: number }
    expect(body.status).toBe(405)
  })

  it('returns 500 problem+json when KV throws', async () => {
    const env: Env = {
      DATA: {
        getWithMetadata: async () => {
          throw new Error('kv unavailable')
        },
      } as unknown as KVNamespace,
      ASSETS: makeFetcher('asset'),
    }
    const res = await apiFetch(env, API_PATHS.meta)
    expect(res.status).toBe(500)
    expect(res.headers.get('Content-Type')).toBe('application/problem+json')
  })
})

describe('non-API paths', () => {
  it('falls through to the ASSETS binding', async () => {
    const res = await apiFetch(storeEnv({}, 'index.html'), '/some/page')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('index.html')
  })
})
