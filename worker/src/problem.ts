/**
 * RFC 9457 application/problem+json responses — the error contract carried
 * over from AerisMap v1.
 */
export function problem(
  status: number,
  title: string,
  detail?: string,
  extraHeaders?: Record<string, string>
): Response {
  const body: Record<string, unknown> = { type: 'about:blank', title, status }
  if (detail !== undefined) body.detail = detail
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/problem+json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  })
}
