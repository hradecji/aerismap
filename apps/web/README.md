# @aerismap/web

Next.js static export of the AerisMap map UI (MapLibre GL JS v5, OpenFreeMap
positron basemap). The build output in `out/` is served by the Cloudflare
Worker alongside `/api/v1/*`.

## Configuration

- `NEXT_PUBLIC_API_BASE` — base URL for the API, **inlined at build time**.
  Leave unset (empty) for production: the Worker serves the app and the API
  from the same origin. Set it for local dev against a mock or remote API.

## Development

```sh
# against the bundled mock API (8 stations covering all views/states):
node dev/mock-api.mjs                # add --stale to test the freshness banner
NEXT_PUBLIC_API_BASE=http://localhost:8787 pnpm --filter @aerismap/web dev

# plain (no API → friendly "no data yet" state over the basemap):
pnpm --filter @aerismap/web dev
```

## Build & checks

```sh
pnpm --filter @aerismap/web typecheck
pnpm --filter @aerismap/web build     # emits apps/web/out/
```
