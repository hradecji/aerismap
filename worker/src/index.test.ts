import { API_PATHS, R2_KEYS } from '@aerismap/shared'
import { describe, expect, it } from 'vitest'

import worker, { type Env } from './index'

interface StoredObject {
  bytes: Uint8Array
  httpEtag: string
}

/**
 * Minimal R2Bucket mock implementing the contract the worker relies on:
 * `get` returns metadata + body stream, `head` metadata only, both null when
 * the key is absent.
 */
function makeBucket(store: Partial<Record<string, StoredObject>>): R2Bucket {
  const meta = (stored: StoredObject) => ({
    httpEtag: stored.httpEtag,
    etag: stored.httpEtag.replaceAll('"', ''),
  })
  const head = async (key: string): Promise<R2Object | null> => {
    const stored = store[key]
    return stored === undefined ? null : (meta(stored) as R2Object)
  }
  const get = async (key: string): Promise<R2ObjectBody | null> => {
    const stored = store[key]
    if (stored === undefined) return null
    return { ...meta(stored), body: new Blob([stored.bytes]).stream() } as R2ObjectBody
  }
  return { get, head } as R2Bucket
}

function makeFetcher(body: string): Fetcher {
  return {
    fetch: async () => new Response(body),
    connect: () => {
      throw new Error('not implemented')
    },
  } as Fetcher
}

function makeEnv(store: Partial<Record<string, StoredObject>>, assetBody = 'asset'): Env {
  return {
    DATA: makeBucket(store),
    ASSETS: makeFetcher(assetBody),
  }
}

function apiFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const request = new Request(`https://aerismap.example${path}`, init)
  return Promise.resolve(worker.fetch(request as Parameters<typeof worker.fetch>[0], env))
}

const GZ_BYTES = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4])
const ETAG = '"abc123"'

describe('GET gzipped GeoJSON artifact', () => {
  const env = makeEnv({ [R2_KEYS.stations]: { bytes: GZ_BYTES, httpEtag: ETAG } })

  it('serves the stored bytes with passthrough gzip headers', async () => {
    const res = await apiFetch(env, API_PATHS.stations)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/geo+json')
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('ETag')).toBe(ETAG)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GZ_BYTES)
  })

  it('returns 304 with ETag + Cache-Control and no body when If-None-Match matches', async () => {
    const res = await apiFetch(env, API_PATHS.stations, {
      headers: { 'If-None-Match': ETAG },
    })
    expect(res.status).toBe(304)
    expect(res.headers.get('ETag')).toBe(ETAG)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.body).toBeNull()
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

  it('returns 412 problem+json when If-Match does not match', async () => {
    const res = await apiFetch(env, API_PATHS.stations, {
      headers: { 'If-Match': '"other"' },
    })
    expect(res.status).toBe(412)
    expect(res.headers.get('Content-Type')).toBe('application/problem+json')
    const body = (await res.json()) as { title: string; status: number }
    expect(body.title).toBe('Precondition failed')
    expect(body.status).toBe(412)
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
  const env = makeEnv({
    [R2_KEYS.stations]: { bytes: GZ_BYTES, httpEtag: ETAG },
    [R2_KEYS.meta]: { bytes: new TextEncoder().encode('{}'), httpEtag: ETAG },
  })

  it('mirrors GET status and headers with a null body on a gzip route', async () => {
    const res = await apiFetch(env, API_PATHS.stations, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/geo+json')
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('ETag')).toBe(ETAG)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.body).toBeNull()
  })

  it('mirrors GET headers on the meta route', async () => {
    const res = await apiFetch(env, API_PATHS.meta, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(res.body).toBeNull()
  })

  it('returns 304 on HEAD when If-None-Match matches', async () => {
    const res = await apiFetch(env, API_PATHS.stations, {
      method: 'HEAD',
      headers: { 'If-None-Match': ETAG },
    })
    expect(res.status).toBe(304)
    expect(res.headers.get('ETag')).toBe(ETAG)
    expect(res.body).toBeNull()
  })

  it('returns 404 when the artifact is missing', async () => {
    const res = await apiFetch(makeEnv({}), API_PATHS.stations, { method: 'HEAD' })
    expect(res.status).toBe(404)
  })
})

describe('GET areas', () => {
  it('serves the stored gzip bytes as application/json with passthrough headers', async () => {
    const env = makeEnv({ [R2_KEYS.areas]: { bytes: GZ_BYTES, httpEtag: ETAG } })
    const res = await apiFetch(env, API_PATHS.areas)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('ETag')).toBe(ETAG)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GZ_BYTES)
  })

  it('mirrors GET headers with a null body on HEAD', async () => {
    const env = makeEnv({ [R2_KEYS.areas]: { bytes: GZ_BYTES, httpEtag: ETAG } })
    const res = await apiFetch(env, API_PATHS.areas, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('ETag')).toBe(ETAG)
    expect(res.body).toBeNull()
  })

  it('returns the transient (not planned-milestone) 404 detail when missing', async () => {
    const res = await apiFetch(makeEnv({}), API_PATHS.areas)
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
    const env = makeEnv({ [R2_KEYS.meta]: { bytes, httpEtag: ETAG } })
    const res = await apiFetch(env, API_PATHS.meta)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(await res.text()).toContain('generatedAt')
  })
})

describe('error responses', () => {
  it('returns 404 problem+json when the artifact is not in R2 yet', async () => {
    const res = await apiFetch(makeEnv({}), API_PATHS.stations)
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
      const res = await apiFetch(makeEnv({}), path)
      expect(res.status, path).toBe(404)
      const body = (await res.json()) as { title: string; detail: string }
      expect(body.title).toBe('Data not yet available')
      expect(body.detail).toBe(
        'This layer is planned (milestone M2) and is not published yet.'
      )
    }
  })

  it('serves a planned layer normally once its object exists (self-healing)', async () => {
    const env = makeEnv({ [R2_KEYS.tempIsobands]: { bytes: GZ_BYTES, httpEtag: ETAG } })
    const res = await apiFetch(env, API_PATHS.tempIsobands)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(GZ_BYTES)
  })

  it('returns 404 problem+json for unknown /api/* paths', async () => {
    const res = await apiFetch(makeEnv({}), '/api/v1/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toBe('application/problem+json')
    const body = (await res.json()) as { title: string }
    expect(body.title).toBe('Not found')
  })

  it('returns 405 problem+json with Allow: GET, HEAD for other methods', async () => {
    const res = await apiFetch(makeEnv({}), API_PATHS.stations, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('GET, HEAD')
    expect(res.headers.get('Content-Type')).toBe('application/problem+json')
    const body = (await res.json()) as { status: number }
    expect(body.status).toBe(405)
  })

  it('returns 500 problem+json when R2 throws', async () => {
    const env: Env = {
      DATA: {
        get: async (_key: string, _options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> => {
          throw new Error('r2 unavailable')
        },
      } as R2Bucket,
      ASSETS: makeFetcher('asset'),
    }
    const res = await apiFetch(env, API_PATHS.meta)
    expect(res.status).toBe(500)
    expect(res.headers.get('Content-Type')).toBe('application/problem+json')
  })
})

describe('non-API paths', () => {
  it('falls through to the ASSETS binding', async () => {
    const res = await apiFetch(makeEnv({}, 'index.html'), '/some/page')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('index.html')
  })
})
