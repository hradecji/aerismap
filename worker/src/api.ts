import { problem } from './problem'
import { API_ROUTES } from './routes'

const CACHE_CONTROL = 'public, max-age=300'

/**
 * Does an `If-None-Match` / `If-Match` header value match the object's etag?
 * Handles `*`, comma-separated etag lists, and weak `W/` prefixes (compared
 * weakly — R2's `httpEtag` is always a quoted strong validator, so stripping
 * `W/` before comparing never falsely matches a different representation).
 */
function etagMatches(headerValue: string, httpEtag: string): boolean {
  if (headerValue.trim() === '*') return true
  return headerValue
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .includes(httpEtag)
}

function hasBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return 'body' in object
}

/** Discard an R2 body we are not going to send, so the stream is released. */
async function discardBody(object: R2Object | R2ObjectBody): Promise<void> {
  if (hasBody(object)) await object.body.cancel()
}

/** Serve one of the /api/v1/* artifact routes from the R2 bucket. */
export async function handleApi(
  request: Request,
  pathname: string,
  data: R2Bucket
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

  // HEAD needs only metadata; GET fetches the body up front and discards it
  // again on the conditional-request paths below.
  const object = method === 'HEAD' ? await data.head(route.key) : await data.get(route.key)
  if (object === null) {
    return problem(
      404,
      'Data not yet available',
      route.plannedMilestone !== undefined
        ? `This layer is planned (milestone ${route.plannedMilestone}) and is not published yet.`
        : 'The ingest pipeline has not published this artifact yet. Try again in a few minutes.'
    )
  }

  // Conditional requests (RFC 9110 §13): evaluated explicitly rather than via
  // R2's onlyIf, which must not be fed raw request headers.
  const ifMatch = request.headers.get('If-Match')
  if (ifMatch !== null && !etagMatches(ifMatch, object.httpEtag)) {
    await discardBody(object)
    return problem(
      412,
      'Precondition failed',
      `If-Match does not match the current representation (${object.httpEtag}).`
    )
  }

  const headers = new Headers({
    'Content-Type': route.contentType,
    'Cache-Control': CACHE_CONTROL,
    ETag: object.httpEtag,
    'Access-Control-Allow-Origin': '*',
  })

  const ifNoneMatch = request.headers.get('If-None-Match')
  if (ifNoneMatch !== null && etagMatches(ifNoneMatch, object.httpEtag)) {
    await discardBody(object)
    return new Response(null, { status: 304, headers })
  }

  if (route.gzip) headers.set('Content-Encoding', 'gzip')

  if (method === 'HEAD' || !hasBody(object)) {
    return new Response(null, { headers })
  }

  if (route.gzip) {
    // encodeBody 'manual': the stored bytes are already gzip — stream them
    // through without the runtime re-encoding the body.
    return new Response(object.body, { headers, encodeBody: 'manual' })
  }

  return new Response(object.body, { headers })
}
