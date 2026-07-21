import { describe, expect, it } from 'vitest'
import { fetchJson, HttpError, ResponseTooLargeError } from './http'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function countingFetch(make: () => Response) {
  const state = { calls: 0 }
  const impl: typeof fetch = async () => {
    state.calls++
    return make()
  }
  return { state, impl }
}

describe('fetchJson maxBytes', () => {
  it('passes bodies under the cap through to JSON.parse', async () => {
    const { impl } = countingFetch(() => jsonResponse({ ok: 1 }))
    await expect(fetchJson('https://x.test/small', { fetchImpl: impl, maxBytes: 1024 })).resolves.toEqual({ ok: 1 })
  })

  it('rejects via an over-cap Content-Length without retrying', async () => {
    // hand-rolled response: the Response constructor recomputes content-length
    const fake = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '9999999' }),
      body: null,
      text: async () => '{}',
    } as unknown as Response
    const { state, impl } = countingFetch(() => fake)
    await expect(
      fetchJson('https://x.test/huge', { fetchImpl: impl, maxBytes: 1024, retries: 3 })
    ).rejects.toBeInstanceOf(ResponseTooLargeError)
    expect(state.calls).toBe(1)
  })

  it('aborts while streaming past the cap without retrying', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1024))
    const { state, impl } = countingFetch(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 8; i++) controller.enqueue(chunk)
          controller.close()
        },
      })
      return new Response(stream, { status: 200 })
    })
    await expect(
      fetchJson('https://x.test/stream', { fetchImpl: impl, maxBytes: 4096, retries: 3 })
    ).rejects.toBeInstanceOf(ResponseTooLargeError)
    expect(state.calls).toBe(1)
  })

  it('still fails fast on non-retryable HTTP errors when maxBytes is set', async () => {
    const { state, impl } = countingFetch(() => jsonResponse({}, { status: 404 }))
    await expect(
      fetchJson('https://x.test/missing', { fetchImpl: impl, maxBytes: 1024, retries: 3 })
    ).rejects.toBeInstanceOf(HttpError)
    expect(state.calls).toBe(1)
  })
})

describe('fetchJson onResponseHeaders', () => {
  it('observes the headers of every received response', async () => {
    const seen: Array<string | null> = []
    const { impl } = countingFetch(() =>
      jsonResponse({ ok: 1 }, { headers: { 'x-ratelimit-remaining': '41' } })
    )
    await fetchJson('https://x.test/headers', {
      fetchImpl: impl,
      onResponseHeaders: (headers) => seen.push(headers.get('x-ratelimit-remaining')),
    })
    expect(seen).toEqual(['41'])
  })
})
