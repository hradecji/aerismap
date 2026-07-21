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
│                            │  KV    │  ┌────────────────────────┐  │
│  1. Sensor.Community dumps │  REST  │  │ Workers KV             │  │
│  2. OpenAQ v3 latest       ├───────▶│  │ (namespace DATA)       │  │
│  3. Open-Meteo S3 grids    │  API   │  │  latest/*.geojson.gz   │  │
│     (CAMS AQ + ICON temp)  │  put   │  └───────────┬────────────┘  │
│                            │        │              │ binding       │
│  normalize → EAQI → build  │        │  ┌───────────▼────────────┐  │
│  GeoJSON artifacts         │        │  │ Worker (aerismap)      │  │
└────────────────────────────┘        │  │  /api/v1/* → KV        │  │
                                      │  │  /* → static assets    │  │
                                      │  │  (Next.js export)      │  │
                                      │  └────────────────────────┘  │
                                      │   *.workers.dev              │
                                      └──────────────────────────────┘
```

Cloudflare only *serves*; all fetching and normalizing runs in an hourly
GitHub Actions job (a free-plan cron Worker gets 10 ms CPU and 50
subrequests — unusable for ingestion). The Worker answers five read-only API
routes straight from Workers KV (namespace binding `DATA`) and serves the
static Next.js export for everything else.

| Route | KV key |
|---|---|
| `GET /api/v1/stations` | `latest/stations.geojson.gz` |
| `GET /api/v1/areas` | `latest/areas.json.gz` |
| `GET /api/v1/layers/temperature` — planned (M2) | `latest/temp-isobands.geojson.gz` |
| `GET /api/v1/layers/aqi-model` — planned (M2) | `latest/aqi-grid.geojson.gz` |
| `GET /api/v1/meta` | `latest/meta.json` |

The two planned routes answer 404 (`problem+json` with a "planned, milestone
M2" detail) until their ingest stages ship; they start serving automatically
once the keys exist in KV.

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
├── packages/shared/   Shared contract: station schema, EAQI bands, store keys, API paths
├── ingest/            Ingest pipeline (run hourly by GitHub Actions, runnable locally)
├── worker/            Cloudflare Worker: /api/v1/* from KV, everything else static assets
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

# 2. Build data artifacts locally (no Cloudflare KV env set → writes ingest/.artifacts/ instead of uploading)
pnpm --filter @aerismap/ingest ingest

# 3. Seed the local KV simulator with those artifacts
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

The whole stack runs on the **card-free Workers Free plan** — Workers KV was
chosen over R2 as the artifact store precisely because activating R2 requires
putting a payment card on the Cloudflare account (a deliberate project
decision: no billing surface at all), while KV is included in the Free plan.
Nothing below asks for billing details.

1. Create a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free
   plan; no payment card needed).
2. Create the KV namespace: `pnpm --filter @aerismap/worker exec wrangler kv
   namespace create DATA` (or via the dashboard). Put the namespace id it
   prints into the `kv_namespaces` entry (binding `DATA`) in
   `worker/wrangler.jsonc` — the same id also becomes the
   `CLOUDFLARE_KV_NAMESPACE_ID` repo secret below.
3. First deploy from your machine: `pnpm install && pnpm --filter
   @aerismap/web build` (the Worker serves `apps/web/out`, which must exist),
   then `pnpm --filter @aerismap/worker exec wrangler login` and
   `pnpm --filter @aerismap/worker deploy`. This registers the `aerismap`
   Worker on your `*.workers.dev` subdomain.
4. Create **one custom Cloudflare API token** for CI (dashboard → My Profile
   → API Tokens → Create Custom Token) with two permissions:
   **Account → Workers Scripts → Edit** (used by deploy.yml) and
   **Account → Workers KV Storage → Edit** (used by ingest.yml to upload
   artifacts via the KV REST API). Then add the GitHub repo secrets:

   | Secret | Used by | Value |
   |---|---|---|
   | `CLOUDFLARE_API_TOKEN` | deploy.yml + ingest.yml | The custom API token above (Workers Scripts:Edit + Workers KV Storage:Edit) |
   | `CLOUDFLARE_ACCOUNT_ID` | deploy.yml + ingest.yml | Cloudflare account ID |
   | `CLOUDFLARE_KV_NAMESPACE_ID` | ingest.yml | The `DATA` namespace id from step 2 (this deployment uses `20dedaab5bfb468c900b4346669eb41e`; namespace ids are not secrets, but keeping it alongside the others is convenient) |
   | `OPENAQ_API_KEY` | ingest.yml (optional) | [Free OpenAQ key](https://explore.openaq.org/register) for the official-station source |

5. Push to `main` — `deploy.yml` typechecks, tests, builds the web export,
   and deploys the Worker. `ingest.yml` then publishes fresh data at minute 7
   of every hour (or trigger it manually under Actions → Ingest → Run
   workflow).

KV free-plan headroom (limits per
[Cloudflare's KV docs](https://developers.cloudflare.com/kv/platform/limits/)):
the hourly ingest writes 5 keys × 24 runs ≈ **120 writes/day of the 1,000/day
cap**; the artifacts total **~0.42 MB gz of the 1 GB storage cap** (largest
single value ~398 KB vs the 25 MiB/value cap); API reads draw on 100k KV
reads/day, matching the Worker's own 100k req/day. If a cap is ever exceeded,
the behavior is failed requests for the rest of the UTC day — the Worker
carries forward and serves the last stored (stale) artifacts, and there is
never a surprise bill, because no billing is configured.

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
