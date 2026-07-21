import type { StoreMetadata } from '@aerismap/shared'

import { problem } from './problem'
import { API_ROUTES } from './routes'

const CACHE_CONTROL = 'public, max-age=300'

/**
 * KV edge cache TTL, aligned with Cache-Control max-age=300: a PoP that has
 * cached a value may keep serving it for up to 5 minutes after the hourly
 * ingest rewrites the key — accepted staleness for hourly data.
 */
const KV_CACHE_TTL_SEC = 300

/**
 * Does an `If-None-Match` / `If-Match` header value match the representation's
 * etag? Handles `*`, comma-separated etag lists, and weak `W/` prefixes
 * (compared weakly — the etag served here is always a quoted strong validator
 * built from StoreMetadata's sha-256, so stripping `W/` before comparing never
 * falsely matches a different representation).
 */
function etagMatches(headerValue: string, httpEtag: string): boolean {
  if (headerValue.trim() === '*') return true
  return headerValue
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .includes(httpEtag)
}

/**
 * Ingest writes StoreMetadata alongside each value; values seeded by hand or
 * via `seed:local` may carry none, and KV metadata is arbitrary JSON, so
 * validate the shape before trusting it.
 */
function isStoreMetadata(metadata: unknown): metadata is StoreMetadata {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    typeof (metadata as { etag?: unknown }).etag === 'string' &&
    typeof (metadata as { size?: unknown }).size === 'number'
  )
}

/** Serve one of the /api/v1/* artifact routes from the DATA KV namespace. */
export async function handleApi(
  request: Request,
  pathname: string,
  data: KVNamespace
): Promise<Response> {
  const { method } = request
  if (method !== 'GET' && method !== 'HEAD') {
    return problem(405, 'Method not allowed', `${method} is not supported; use GET or HEAD.`, {
      Allow: 'GET, HEAD',
    })
  }

  const route = API_ROUTES.get(pathname)
  if (route === undefined) {
    return problem(404, 'Not found', `No API route matches ${pathname}.`)
  }

  // KV has no HEAD equivalent: both verbs fetch the value as a stream (never
  // buffered) and the non-body paths below cancel it before responding.
  const { value, metadata } = await data.getWithMetadata<StoreMetadata>(route.key, {
    type: 'stream',
    cacheTtl: KV_CACHE_TTL_SEC,
  })
  if (value === null) {
    return problem(
      404,
      'Data not yet available',
      route.plannedMilestone !== undefined
        ? `This layer is planned (milestone ${route.plannedMilestone}) and is not published yet.`
        : 'The ingest pipeline has not published this artifact yet. Try again in a few minutes.'
    )
  }

  // The route table stays the source of truth for Content-Type; the stored
  // StoreMetadata carries the same value as a fallback/cross-check.
  const headers = new Headers({
    'Content-Type': route.contentType,
    'Cache-Control': CACHE_CONTROL,
    'Access-Control-Allow-Origin': '*',
  })

  // Conditional requests (RFC 9110 §13) are evaluated fully in the worker —
  // KV has no equivalent of R2's onlyIf. Without valid metadata there is no
  // etag to validate against, so degrade to an unconditional 200 without
  // ETag/Content-Length rather than failing with a 500.
  const meta = isStoreMetadata(metadata) ? metadata : undefined
  if (meta !== undefined) {
    const httpEtag = `"${meta.etag}"` // StoreMetadata.etag is stored unquoted

    const ifMatch = request.headers.get('If-Match')
    if (ifMatch !== null && !etagMatches(ifMatch, httpEtag)) {
      await value.cancel()
      return problem(
        412,
        'Precondition failed',
        `If-Match does not match the current representation (${httpEtag}).`
      )
    }

    headers.set('ETag', httpEtag)

    const ifNoneMatch = request.headers.get('If-None-Match')
    if (ifNoneMatch !== null && etagMatches(ifNoneMatch, httpEtag)) {
      await value.cancel()
      return new Response(null, { status: 304, headers })
    }

    // Exact wire length: with encodeBody 'manual' below the stored bytes go
    // out verbatim, so the stored size is the payload length on the wire.
    headers.set('Content-Length', String(meta.size))
  }

  if (route.gzip) headers.set('Content-Encoding', 'gzip')

  if (method === 'HEAD') {
    await value.cancel()
    return new Response(null, { headers })
  }

  // encodeBody 'manual': the stored bytes already match the declared headers
  // (gzip for .gz keys, identity for meta.json) — stream them through without
  // the runtime re-encoding the body.
  return new Response(value, { headers, encodeBody: 'manual' })
}
