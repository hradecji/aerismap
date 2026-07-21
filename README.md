# AerisMap v2

Europe-wide air-quality and temperature map. ~13–14k community and official
stations plus model layers on one MapLibre map, scored with the European Air
Quality Index (EAQI), refreshed hourly, hosted for $0/month.

- **Community sensors** — [Sensor.Community](https://sensor.community/) PM +
  co-located temperature (~9.5k locations)
- **Official stations** — EEA reference network via
  [OpenAQ v3](https://openaq.org/) (~3.5–4.5k stations)
- **Model layers** — planned (M2): CAMS Europe AQ grid and DWD ICON
  temperature isobands from
  [Open-Meteo's open-data bucket](https://open-meteo.com/)

Planning docs: [aerismap-v2-plan.md](aerismap-v2-plan.md) (architecture — the
"how, exactly") and [aerismap-europe-upgrade.md](aerismap-europe-upgrade.md)
(data-source brief — the "what and why").

## Architecture

```
┌────────────────────────────┐        ┌──────────────────────────────┐
│  GitHub Actions (hourly)   │        │  Cloudflare (free plan)      │
│  ingest/ (Node + TS)       │        │                              │
│                            │  S3    │  ┌────────────────────────┐  │
│  1. Sensor.Community dumps │  API   │  │ R2 bucket (private)    │  │
│  2. OpenAQ v3 latest       ├───────▶│  │  latest/*.geojson.gz   │  │
│  3. Open-Meteo S3 grids    │  put   │  └───────────┬────────────┘  │
│     (CAMS AQ + ICON temp)  │        │              │ binding       │
│                            │        │  ┌───────────▼────────────┐  │
│  normalize → EAQI → build  │        │  │ Worker (aerismap)      │  │
│  GeoJSON artifacts         │        │  │  /api/v1/* → R2        │  │
└────────────────────────────┘        │  │  /* → static assets    │  │
                                      │  │  (Next.js export)      │  │
                                      │  └────────────────────────┘  │
                                      │   *.workers.dev              │
                                      └──────────────────────────────┘
```

Cloudflare only *serves*; all fetching and normalizing runs in an hourly
GitHub Actions job (a free-plan cron Worker gets 10 ms CPU and 50
subrequests — unusable for ingestion). The Worker answers five read-only API
routes straight from R2 and serves the static Next.js export for everything
else.

| Route | R2 object |
|---|---|
| `GET /api/v1/stations` | `latest/stations.geojson.gz` |
| `GET /api/v1/areas` | `latest/areas.json.gz` |
| `GET /api/v1/layers/temperature` — planned (M2) | `latest/temp-isobands.geojson.gz` |
| `GET /api/v1/layers/aqi-model` — planned (M2) | `latest/aqi-grid.geojson.gz` |
| `GET /api/v1/meta` | `latest/meta.json` |

The two planned routes answer 404 (`problem+json` with a "planned, milestone
M2" detail) until their ingest stages ship; they start serving automatically
once the objects exist in R2.

### Area mode

At low zoom the map renders a choropleth of Eurostat NUTS-2/NUTS-3 regions
instead of ~10k individual dots. Each region's hourly aggregate takes the
per-pollutant **median** across its non-stale stations, bands each median with
EAQI, and colors the region by the **worst pollutant** — but only when the
region has ≥ 3 included stations and the pollutant is measured by ≥ 2 of them
(regions below the thresholds stay uncolored rather than pretending). Fill
opacity encodes confidence (station count), and zooming in crossfades the
choropleth automatically into the station dots.

## Monorepo layout

```
aeris/
├── apps/web/          Next.js (output: 'export') + MapLibre GL JS frontend
├── packages/shared/   Shared contract: station schema, EAQI bands, R2 keys, API paths
├── ingest/            Ingest pipeline (run hourly by GitHub Actions, runnable locally)
├── worker/            Cloudflare Worker: /api/v1/* from R2, everything else static assets
└── .github/workflows/ ingest.yml (hourly cron) + deploy.yml (push to main)
```

Requires Node ≥ 22 (CI uses 24) and [pnpm](https://pnpm.io/) (version pinned
via the `packageManager` field). On Node ≤ 24, `corepack enable` suffices;
Node ≥ 25 no longer bundles Corepack, so install pnpm directly with
`npm i -g pnpm@10`.

## Local development

```sh
# 1. Install
pnpm install

# 2. Build data artifacts locally (no R2 env set → writes ingest/.artifacts/ instead of uploading)
pnpm --filter @aerismap/ingest ingest

# 3. Seed the local R2 simulator with those artifacts
pnpm --filter @aerismap/worker seed:local

# 4. Build the static web app (the Worker serves apps/web/out)
pnpm --filter @aerismap/web build

# 5. Run the Worker locally and open http://localhost:8787
pnpm --filter @aerismap/worker dev
```

For frontend iteration,
`NEXT_PUBLIC_API_BASE=http://localhost:8787 pnpm --filter @aerismap/web dev`
gives Next.js hot reload; run the Worker (step 5) alongside it so the API
base points at something live.

Checks: `pnpm typecheck` and `pnpm test` run across all packages.

## Deployment

1. Create a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free
   plan is sufficient).
2. Create the R2 bucket: `pnpm --filter @aerismap/worker exec wrangler r2
   bucket create aerismap-data` (or via the dashboard). The name must match
   `bucket_name` in `worker/wrangler.jsonc`.
3. Create an **R2 API token** (dashboard → R2 → Manage API tokens →
   Object Read & Write, scoped to `aerismap-data`). Note the Access Key ID,
   Secret Access Key, and your account ID — the ingest job uploads via the
   S3 API with these.
4. First deploy from your machine: `pnpm install && pnpm --filter
   @aerismap/web build` (the Worker serves `apps/web/out`, which must exist),
   then `pnpm --filter @aerismap/worker exec wrangler login` and
   `pnpm --filter @aerismap/worker deploy`. This registers the `aerismap`
   Worker on your `*.workers.dev` subdomain.
5. Create a **Cloudflare API token** for CI (dashboard → My Profile → API
   Tokens → "Edit Cloudflare Workers" template) and add the GitHub repo
   secrets:

   | Secret | Used by | Value |
   |---|---|---|
   | `CLOUDFLARE_API_TOKEN` | deploy.yml | API token with Workers edit permission |
   | `CLOUDFLARE_ACCOUNT_ID` | deploy.yml | Cloudflare account ID |
   | `R2_ACCOUNT_ID` | ingest.yml | Cloudflare account ID (S3 endpoint) |
   | `R2_ACCESS_KEY_ID` | ingest.yml | R2 API token access key |
   | `R2_SECRET_ACCESS_KEY` | ingest.yml | R2 API token secret |
   | `OPENAQ_API_KEY` | ingest.yml (optional) | [Free OpenAQ key](https://explore.openaq.org/register) for the official-station source |

6. Push to `main` — `deploy.yml` typechecks, tests, builds the web export,
   and deploys the Worker. `ingest.yml` then publishes fresh data at minute 7
   of every hour (or trigger it manually under Actions → Ingest → Run
   workflow).

Note: the repo should stay **public** — GitHub Actions minutes are unlimited
for public repos, and the hourly ingest job would exhaust a private repo's
free tier. GitHub also auto-disables cron schedules after 60 days without
repository activity; any commit resets the clock.

## Data licensing

The published dataset (the GeoJSON artifacts served under `/api/v1/*`) is a
derived database that includes Sensor.Community data and is therefore offered
under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
— share-alike: if you build on it, attribute AerisMap and its sources and keep
your derived database open under the same terms. The artifacts are openly
fetchable (CORS `*`) by design.

Data sources and attribution:

- [Sensor.Community](https://sensor.community/) — ODbL 1.0 (database) /
  DbCL 1.0 (contents)
- [OpenAQ](https://openaq.org/) /
  [European Environment Agency](https://www.eea.europa.eu/) — licence varies
  by underlying source
- [Open-Meteo](https://open-meteo.com/) open-data ·
  CAMS ENSEMBLE (Copernicus) · DWD ICON — CC-BY 4.0
- [OpenFreeMap](https://openfreemap.org/) · OpenMapTiles ·
  © OpenStreetMap contributors (basemap)
- Boundary data **© EuroGeographics for the administrative boundaries**
  ([Eurostat GISCO](https://ec.europa.eu/eurostat/web/gisco/geodata/statistical-units),
  non-commercial use; this notice must remain visible in the app wherever the
  area layer renders). The NUTS boundary GeoJSONs are vendored into the repo
  by `ingest/scripts/prepare-boundaries.ts`.

The **code** licence is TBD — it must be settled at M2 kickoff together with
the GPL-2.0-only `.om`-reader question (see plan §7).
