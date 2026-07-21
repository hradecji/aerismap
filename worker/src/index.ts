import { handleApi } from './api'
import { problem } from './problem'

export interface Env {
  DATA: R2Bucket
  ASSETS: Fetcher
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url)

    // run_worker_first routes only /api/* here; everything else is served by
    // the asset worker. The fallthrough keeps `wrangler dev` and any future
    // routing changes correct.
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, pathname, env.DATA)
      } catch (err) {
        console.error(
          JSON.stringify({ event: 'api_error', pathname, error: err instanceof Error ? err.message : String(err) })
        )
        return problem(500, 'Internal server error')
      }
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
