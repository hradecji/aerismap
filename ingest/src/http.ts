/** Sent on every upstream request — mandatory for Sensor.Community, good manners elsewhere. */
export const USER_AGENT = 'AerisMap/2.0 (+https://github.com/aerismap; hosted ingest)'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string
  ) {
    super(`HTTP ${status} for ${url}`)
    this.name = 'HttpError'
  }
}

/** Response exceeded FetchJsonOptions.maxBytes — deliberately non-retryable. */
export class ResponseTooLargeError extends Error {
  constructor(url: string, maxBytes: number, detail: string) {
    super(`response for ${url} exceeds ${maxBytes} bytes (${detail})`)
    this.name = 'ResponseTooLargeError'
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface FetchJsonOptions {
  /** Per-attempt timeout. Default 60 s. */
  timeoutMs?: number
  /** Retries after the first attempt. Default 2. */
  retries?: number
  /** Base backoff before retry n is `backoffMs * 2^(n-1)`. Default 1 s. */
  backoffMs?: number
  /**
   * Reject bodies larger than this many bytes: via Content-Length when
   * advertised over the cap, otherwise by counting while streaming (the
   * transfer is aborted past the cap, before JSON.parse). Over-cap responses
   * throw ResponseTooLargeError immediately and are never retried.
   */
  maxBytes?: number
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  /** Observes every received response's headers (e.g. rate-limit bookkeeping). */
  onResponseHeaders?: (headers: Headers) => void
}

/** Read the body counting bytes; throws ResponseTooLargeError past maxBytes. */
async function readBodyCapped(res: Response, url: string, maxBytes: number): Promise<string> {
  const advertised = Number(res.headers.get('content-length'))
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new ResponseTooLargeError(url, maxBytes, `Content-Length ${advertised}`)
  }
  const reader = res.body?.getReader()
  if (!reader) {
    const text = await res.text()
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > maxBytes) throw new ResponseTooLargeError(url, maxBytes, `${bytes} bytes buffered`)
    return text
  }
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => {}) // abort the transfer; its error is irrelevant past the cap
      throw new ResponseTooLargeError(url, maxBytes, `aborted after ${received} bytes streamed`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * GET a JSON document with timeout, retries and exponential backoff.
 * Retries network errors, 5xx and 429 (honouring Retry-After when sane);
 * any other 4xx — and an over-`maxBytes` response — fails immediately.
 */
export async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  const {
    timeoutMs = 60_000,
    retries = 2,
    backoffMs = 1_000,
    maxBytes,
    headers = {},
    fetchImpl = fetch,
    onResponseHeaders,
  } = options

  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1))

    let res: Response
    try {
      res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      lastError = err // network failure or timeout — retryable
      continue
    }

    onResponseHeaders?.(res.headers)

    if (res.ok) {
      if (maxBytes === undefined) {
        try {
          return await res.json()
        } catch (err) {
          lastError = err // truncated/invalid body — retryable
          continue
        }
      }
      let text: string
      try {
        text = await readBodyCapped(res, url, maxBytes)
      } catch (err) {
        if (err instanceof ResponseTooLargeError) throw err
        lastError = err // truncated body mid-stream — retryable
        continue
      }
      try {
        return JSON.parse(text)
      } catch (err) {
        lastError = err
        continue
      }
    }

    lastError = new HttpError(res.status, url)
    if (res.status !== 429 && res.status < 500) throw lastError
    if (res.status === 429 && attempt < retries) {
      const retryAfterSec = Number(res.headers.get('retry-after'))
      if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
        await sleep(Math.min(retryAfterSec * 1_000, 60_000))
      }
    }
  }
  throw lastError
}
