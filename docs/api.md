# AerisMap v2 — HTTP API reference

The public read surface of AerisMap: five JSON endpoints served by the
Cloudflare Worker ([`worker/src/api.ts`](../worker/src/api.ts)) straight from
Workers KV, plus two static boundary GeoJSONs. Everything is `GET`/`HEAD`
only, unauthenticated, and CORS-open (`Access-Control-Allow-Origin: *`) — the
dataset is meant to be fetched by third parties, subject to the
[licence](#licence) below.

Live base URL: `https://aerismap.jiri-hradec-jr.workers.dev`
(local dev: `http://localhost:8787` — see
[README § Local development](../README.md#local-development)).

All samples in this document were captured against the live deployment on
2026-07-21.

## Routes

| Route | Backing KV key | Content-Type | Status |
|---|---|---|---|
| `GET /api/v1/stations` | `latest/stations.geojson.gz` | `application/geo+json` | live |
| `GET /api/v1/areas` | `latest/areas.json.gz` | `application/json` | live |
| `GET /api/v1/meta` | `latest/meta.json` | `application/json` | live |
| `GET /api/v1/layers/temperature` | `latest/temp-isobands.geojson.gz` | `application/geo+json` | planned (M2) → 404 |
| `GET /api/v1/layers/aqi-model` | `latest/aqi-grid.geojson.gz` | `application/geo+json` | planned (M2) → 404 |

All `.gz`-suffixed keys are stored gzipped and served with
`Content-Encoding: gzip`; `latest/meta.json` is stored plain.

Static assets (not KV, served by the Worker's asset handler):

| Route | Content |
|---|---|
| `GET /boundaries/nuts2.geojson` | NUTS-2 boundary polygons ([details](#boundary-static-assets)) |
| `GET /boundaries/nuts3.geojson` | NUTS-3 boundary polygons (with splices, [details](#boundary-static-assets)) |

The route table is defined in [`worker/src/routes.ts`](../worker/src/routes.ts);
paths and KV keys come from the shared contract
([`packages/shared/src/contracts.ts`](../packages/shared/src/contracts.ts),
`API_PATHS` / `STORE_KEYS`).

The two `layers/*` routes exist but their ingest producers ship with milestone
M2 ([plan §9](../aerismap-v2-plan.md#9-milestones)). Until then they answer
`404` with a distinct "planned" detail (see [Errors](#errors)); the moment the
KV keys exist they serve normally with no code change.

## Freshness and caching

- Data is rebuilt by the hourly ingest job (GitHub Actions cron `7 * * * *`,
  i.e. minute 7 of every hour). GitHub cron start times have jitter of
  several minutes — e.g. the 20:07 UTC slot on 2026-07-21 published its
  snapshot at `generatedAt: 20:12:15Z`. Do not treat minute 7 as exact.
- Every successful response carries `Cache-Control: public, max-age=300`.
- The Worker reads KV with `cacheTtl: 300`, so a Cloudflare PoP may keep
  serving a cached value for up to 5 minutes after ingest rewrites the key.
  Worst case, a response is ~5 minutes behind the newest publish — accepted
  staleness for hourly data.
- `latest/meta.json` is uploaded **last** each run, so a `meta` response
  showing a new `generatedAt` means the stations artifact for that run was
  already in KV when meta was written (effectively atomic publish; per-PoP
  cache timing can still briefly skew what one edge location returns).
- `areas` is the one artifact that can lag: if area aggregation fails in a
  run, the previous `latest/areas.json.gz` stays published while stations and
  meta still update, so `areas.generatedAt` may be older than
  `meta.generatedAt`.
- If ingest itself fails or stops, the Worker keeps serving the last stored
  artifacts indefinitely — check `meta.generatedAt` (and its `sources[]`) to
  detect this. Freshness horizons per station kind are in
  [`SnapshotMeta.maxAgeSec`](#get-apiv1meta).

There is no per-client rate limiting, but the whole deployment shares the
Workers free plan's 100k requests/day. Poll at most once per `max-age`
window and use conditional requests. Caveat for browser JS on other origins: the Worker answers OPTIONS with 405 (no preflight handling), so custom conditional headers from cross-origin scripts will fail preflight — rely on the browser HTTP cache honouring ETag natively instead.

## Response headers

Success responses (`200`, and `304` where applicable) carry:

| Header | Value |
|---|---|
| `Content-Type` | From the route table (`application/geo+json` or `application/json`) |
| `Content-Encoding` | `gzip` for the `.gz`-backed routes — the stored gzip bytes are passed through verbatim (`encodeBody: 'manual'`), never re-encoded. `meta` is stored plain and has no `Content-Encoding` |
| `ETag` | Strong validator: `"<sha-256 hex of the stored bytes>"`, computed by ingest and stored as KV per-key metadata ([`StoreMetadata`](../packages/shared/src/contracts.ts)). Changes exactly when the artifact bytes change |
| `Content-Length` | Exact stored byte length (the gzipped size for `.gz` keys) |
| `Cache-Control` | `public, max-age=300` |
| `Access-Control-Allow-Origin` | `*` (also present on error responses) |

Two caveats observed on the live edge:

- **Clients that do not send `Accept-Encoding: gzip`** (including `curl`
  without `--compressed`) get the body transparently decompressed by
  Cloudflare's front line; in that case the edge drops `Content-Length` and
  weakens the ETag to `W/"<same hex>"`. Echoing that weak form back in
  `If-None-Match` still works — the Worker strips the `W/` prefix before
  comparing.
- **Values written without valid metadata** (e.g. hand-seeded or via the
  local `seed:local` script) degrade gracefully: the Worker serves a plain
  `200` without `ETag`/`Content-Length` and skips conditional-request
  handling rather than failing. Production values written by ingest always
  carry metadata.

Approximate payload sizes on the wire (2026-07-21, 12,138 stations):
`stations` ~505 KB gz, `areas` ~33 KB gz, `meta` ~1.5 KB plain.

## Conditional requests

Full RFC 9110 conditional handling, evaluated in the Worker:

- `If-None-Match` matching the current ETag → `304 Not Modified` (with
  `ETag` and `Cache-Control`, no body).
- `If-Match` **not** matching → `412 Precondition Failed`
  (`problem+json`, see below).
- Both headers accept `*`, comma-separated ETag lists, and `W/`-prefixed
  weak forms (compared after stripping `W/`).

```sh
$ curl -s -i --compressed -H 'If-None-Match: "d42603cf…c58a848"' \
    https://aerismap.jiri-hradec-jr.workers.dev/api/v1/meta
HTTP/2 304
etag: "d42603cfcb54864110b59d63e9526f4e5f28dad752b04a14b98a57e41c58a848"
cache-control: public, max-age=300
```

## HEAD

`HEAD` is supported on every API route and returns the same headers as `GET`
with no body. Note that KV has no HEAD equivalent — the Worker fetches the
value stream and cancels it, so a `HEAD` still costs a KV read; it saves
bandwidth, not backend work.

Any other method gets `405` with `Allow: GET, HEAD`.

## Errors

All errors are RFC 9457 `application/problem+json`
([`worker/src/problem.ts`](../worker/src/problem.ts)) with
`Cache-Control: no-store` and CORS `*`:

```json
{"type": "about:blank", "title": "…", "status": 404, "detail": "…"}
```

| Status | When | `detail` |
|---|---|---|
| `404` | Path is not in the route table | `No API route matches /api/v1/nope.` |
| `404` | Route exists, KV key absent, route is a planned M2 layer | `This layer is planned (milestone M2) and is not published yet.` |
| `404` | Route exists, KV key absent, artifact is expected (e.g. fresh deployment before the first ingest run) | `The ingest pipeline has not published this artifact yet. Try again in a few minutes.` |
| `405` | Method other than GET/HEAD (response carries `Allow: GET, HEAD`) | `POST is not supported; use GET or HEAD.` |
| `412` | `If-Match` does not match | `If-Match does not match the current representation ("…").` |
| `500` | Unexpected failure (also logged as structured JSON `{"event":"api_error",…}` visible in Cloudflare Workers Logs) | — |

The two `404` flavours for missing values are worth distinguishing when
debugging: "planned (milestone M2)" is permanent-until-M2, "try again in a
few minutes" means the pipeline should have published and has not.

## `GET /api/v1/stations`

A GeoJSON `FeatureCollection` of every ingested station (12,138 features on
2026-07-21). Geometry is `Point` with `[longitude, latitude]` in WGS84,
≤5 decimals. TypeScript source of truth:
[`packages/shared/src/types.ts`](../packages/shared/src/types.ts)
(`StationProperties`).

```sh
curl -s --compressed https://aerismap.jiri-hradec-jr.workers.dev/api/v1/stations
```

A representative feature (an official station promoted to hotspot):

```json
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [20.47529, 44.79696] },
  "properties": {
    "id": "openaq:11588",
    "source": "openaq",
    "nativeId": "11588",
    "name": "Belgrade-Vracar",
    "kind": "reference",
    "country": "RS",
    "license": "per-source (OpenAQ/EEA)",
    "exactLocation": true,
    "values": {
      "no2": { "v": 12.75566, "ts": "2026-07-21T18:00:00Z" },
      "o3":  { "v": 120.52,   "ts": "2026-07-21T18:00:00Z" },
      "so2": { "v": 6.41805,  "ts": "2026-07-21T18:00:00Z" }
    },
    "observedAt": "2026-07-21T18:00:00Z",
    "stale": false,
    "eaqi": 4,
    "eaqiPollutant": "o3",
    "hotspot": true,
    "regionBands": { "n2": 2, "n3": 2 }
  }
}
```

### `properties` field by field

| Field | Type | Semantics |
|---|---|---|
| `id` | string | Stable across runs: `` `${source}:${nativeId}` `` |
| `source` | string | `sensor-community` \| `openaq` (M2 adds `open-meteo`) |
| `nativeId` | string | The station's id in the source system |
| `name` | string? | Human-readable name when the source provides one (Sensor.Community stations usually have none) |
| `kind` | string | `reference` (official monitor) \| `community` \| `model` |
| `country` | string? | ISO 3166-1 alpha-2, when known |
| `license` | string | Licence of *this station's* data, e.g. `ODbL-1.0`, `per-source (OpenAQ/EEA)` |
| `exactLocation` | boolean | `false` when the source coarsened the coordinates (Sensor.Community rounds to ~2 decimals for privacy) — treat the point as approximate to a few hundred metres |
| `values` | object | Per-parameter latest [`Reading`](#readings-and-parameters); a parameter is absent when the station does not report it |
| `observedAt` | string | Most recent reading timestamp across all params, ISO 8601 UTC |
| `stale` | boolean | `observedAt` older than the per-kind horizon at snapshot build time: 2,700 s (45 min) for `community`, 10,800 s (3 h) for `reference`/`model` (`MAX_AGE_SEC`, echoed in [`meta`](#get-apiv1meta)). Stale stations keep their last `values`/`eaqi` for display but are excluded from region aggregates |
| `eaqi` | number? | Consolidated EAQI band 1–6 (1 Good … 6 Extremely poor, band set `eaqi-2025` — thresholds in [plan §5.4](../aerismap-v2-plan.md#54-normalize-build-upload)). Worst band across fresh, QC-passed pollutant readings; absent when no scoreable pollutant exists |
| `eaqiPollutant` | string? | Pollutant driving `eaqi` |
| `pmHumidityBias` | boolean? | Set when a PM reading coincides with co-located relative humidity ≥ 95% — low-cost optical PM sensors over-read in near-saturated air, so `eaqi` may be inflated. Flag only: the station keeps its EAQI, but its PM readings are excluded from region medians |
| `qc` | string[]? | Params whose readings failed spatial QC (reading > 4× the same-pollutant neighbourhood median within 50 km, ≥3 neighbours, and > 25 µg/m³ — see [README § Data quality](../README.md#data-quality)). Flagged readings stay present in `values` but are excluded from `eaqi` and from region aggregation. Recomputed from scratch every run |
| `hotspot` | boolean? | Corroborated pollution epicentre: band ≥ 4 from a fresh, unflagged reading, backed by a neighbour within one band or by reference-grade pedigree |
| `regionBands` | object? | Only on hotspot stations: EAQI bands of the containing regions, `{ n2?, n3? }` (NUTS-2 parent / NUTS-3). Contrast rule for renderers: show a hotspot marker only when the station's band **exceeds** the region band at the displayed NUTS level — a marker must carry surprise, not repeat the choropleth fill. Keys are absent when the region has no band; a station in an uncoloured region should always show |

Absent optional fields mean "no"/"unknown" — ingest omits rather than writing
`false`/`null`.

### Readings and parameters

Each entry in `values` is `{ "v": number, "ts": "ISO 8601 UTC" }`. Possible
parameter keys (`PARAMS` in the shared package):

`pm1`, `pm2_5`, `pm10`, `no2`, `o3`, `so2`, `co` — µg/m³ (including `co`:
it is OpenAQ's mass-concentration series, **not** mg/m³ or ppm);
`temperature` — °C; `humidity` — % RH; `pressure` — hPa.

Only `pm2_5`, `pm10`, `no2`, `o3`, `so2` have EAQI bandings; `pm1`, `co` and
`pressure` are informational.

## `GET /api/v1/areas`

Hourly per-region aggregates for the NUTS choropleth ("area mode" — concept
in [README § Area mode](../README.md#area-mode), full semantics in
[plan §5.5](../aerismap-v2-plan.md#55-area-mode-shipped-with-m1)). One flat
JSON object over NUTS-2 *and* NUTS-3 ids. TypeScript source of truth:
`AreaSnapshot` / `AreaStats` in
[`packages/shared/src/contracts.ts`](../packages/shared/src/contracts.ts).

```sh
curl -s --compressed https://aerismap.jiri-hradec-jr.workers.dev/api/v1/areas
```

```json
{
  "generatedAt": "2026-07-21T20:12:15.638Z",
  "areas": {
    "AT11": {
      "n": 12, "nRef": 5, "nCom": 7,
      "med": { "pm2_5": 2.3, "pm10": 3.4, "no2": 3.5, "o3": 59.7,
               "so2": 3.3, "temperature": 23.3, "humidity": 40.8 },
      "cnt": { "pm2_5": 9, "pm10": 8, "no2": 3, "o3": 1, "so2": 3,
               "temperature": 6, "humidity": 5 },
      "eaqi": 1,
      "pollutant": "pm2_5"
    },
    "BE341": {
      "n": 1, "nRef": 0, "nCom": 1,
      "med": { "temperature": 28.3, "humidity": 33.3 },
      "cnt": { "temperature": 1, "humidity": 1 }
    }
  }
}
```

| Field | Type | Semantics |
|---|---|---|
| `generatedAt` | string | Build time of *this* artifact — may lag `meta.generatedAt` if the latest run's area aggregation failed (see [Freshness](#freshness-and-caching)) |
| `areas` | object | Keyed by `NUTS_ID`: 4 characters = NUTS-2, 5 characters = NUTS-3. Joins onto the [boundary assets](#boundary-static-assets). Only regions with ≥ 1 included station appear. A NUTS-2 entry aggregates that region's stations directly (a single median — not a median of its NUTS-3 medians) |

Per region (`AreaStats`):

| Field | Type | Semantics |
|---|---|---|
| `n` | number | Included stations: non-stale and assigned to the region (coarsened-coordinate stations count — the median is robust to small offsets). QC-flagged and humidity-biased *readings* are excluded from the medians below, but such a station still counts here and for its clean params |
| `nRef` / `nCom` | number | Split of `n` by `reference` / `community` kind |
| `med` | object? | Per-param **median** of included readings, 1 decimal. Params: `pm2_5`, `pm10`, `no2`, `o3`, `so2`, `temperature`, `humidity` (`AREA_PARAMS`) |
| `cnt` | object? | Per-param count of stations contributing to that median |
| `eaqi` | number? | Region band 1–6 = worst *eligible* pollutant band. Eligibility is graduated: a single station can only produce bands ≤ 3 (one sensor may say "fine", never "emergency"); with exactly two stations a pollutant is banded from the **min** of the pair; ≥ 2 stations allow any band. Absent when no pollutant clears the gate |
| `pollutant` | string? | Pollutant driving `eaqi` |

Reading the absences: a region *missing entirely* from `areas` had zero
included stations this run (all stale, or in a country outside NUTS
assignment); a region *present without `eaqi`* has stations but no
EAQI-eligible pollutant coverage (like `BE341` above — temperature/humidity
only), or its only band failed the graduated gate. On 2026-07-21 the map had
1,435 region entries, 1,403 of them banded, out of 1,864 total regions
(`meta.counts`).

Note for per-pollutant renderers: only the overall `eaqi` carries the full
graduated ruleset (including min-of-two). If you band a single `med` value
yourself, gate it by the same rule using `cnt` — the raw pair of values
needed for min-of-two is not published.

## `GET /api/v1/meta`

Snapshot metadata — the first thing to check when debugging freshness or
coverage. Small (~1.5 KB), stored uncompressed. TypeScript source of truth:
`SnapshotMeta` in
[`packages/shared/src/contracts.ts`](../packages/shared/src/contracts.ts).

```sh
curl -s https://aerismap.jiri-hradec-jr.workers.dev/api/v1/meta
```

```json
{
  "generatedAt": "2026-07-21T20:12:15.638Z",
  "eaqiBandSet": "eaqi-2025",
  "maxAgeSec": { "community": 2700, "reference": 10800, "model": 10800 },
  "counts": {
    "stations": 12138,
    "byKind": { "reference": 2482, "community": 9656 },
    "withEaqi": 11149,
    "qcFlaggedStations": 349,
    "hotspots": 117,
    "areasColored": 1403,
    "areasTotal": 1864
  },
  "sources": [
    { "id": "sensor-community", "ok": true,
      "fetchedAt": "2026-07-21T20:11:56.611Z", "stations": 9656 },
    { "id": "openaq", "ok": true,
      "fetchedAt": "2026-07-21T20:12:15.637Z", "stations": 2482 }
  ],
  "attribution": [
    { "label": "Sensor.Community", "url": "https://sensor.community/",
      "license": "ODbL-1.0" }
  ]
}
```

(`attribution` trimmed — the full list matches `ATTRIBUTIONS` in the shared
package and includes the mandatory EuroGeographics notice.)

| Field | Semantics |
|---|---|
| `generatedAt` | When the snapshot finished building, ISO 8601 UTC. The web app shows a stale-data banner when this is > 2 h old |
| `eaqiBandSet` | Band-set identifier (`eaqi-2025`) — bump means thresholds changed |
| `maxAgeSec` | The per-kind staleness horizons applied to this snapshot |
| `counts.stations` / `byKind` / `withEaqi` | Total stations, split by kind, and how many carry an EAQI band |
| `counts.qcFlaggedStations` | Stations with ≥ 1 spatially QC-flagged reading |
| `counts.hotspots` | Stations promoted to corroborated hotspots |
| `counts.areasColored` / `areasTotal` | Regions banded this run / total regions in the boundary set |
| `sources[]` | Per-source status: `id`, `ok`, `fetchedAt` (successful fetch time), `stations` contributed, `detail` (human-readable error or skip reason when `!ok`, e.g. `"OPENAQ_API_KEY not set"`). When a source fails and its stations are carried forward from the previous snapshot, ingest adds `carriedForward` (count) — an ingest-side extra beyond the shared type |
| `attribution[]` | `{ label, url, license? }` list to display wherever the data is reused |

## Planned M2 layer routes

`GET /api/v1/layers/temperature` (DWD ICON temperature isobands) and
`GET /api/v1/layers/aqi-model` (CAMS Europe AQ grid) are reserved and
currently return:

```sh
$ curl -s https://aerismap.jiri-hradec-jr.workers.dev/api/v1/layers/temperature
{"type":"about:blank","title":"Data not yet available","status":404,
 "detail":"This layer is planned (milestone M2) and is not published yet."}
```

Their content will be GeoJSON (`application/geo+json`, gzip-stored) with the
same header/caching behaviour as the shipped routes. Schemas will be added
here when the M2 producers land
([plan §5.3](../aerismap-v2-plan.md#53-model-layers--open-meteos-open-data-s3-bucket-not-the-api)).

## Boundary static assets

The choropleth joins `areas` values onto vendored NUTS boundary GeoJSONs,
served as static assets (not from KV — they change only when the NUTS
edition is re-vendored, and are cached by the asset pipeline with its own
ETag/`must-revalidate` headers):

- `GET /boundaries/nuts2.geojson` — 340 features, ~0.6 MB raw
- `GET /boundaries/nuts3.geojson` — 1,527 features, ~1.2 MB raw

Feature properties are trimmed to exactly `NUTS_ID`, `LEVL_CODE`,
`NAME_LATN`, `CNTR_CODE` (geometry: `Polygon`/`MultiPolygon`, EPSG:4326,
1:20M generalisation). **Join contract:** feature identity is `NUTS_ID` —
MapLibre uses `promoteId: 'NUTS_ID'` and sets per-feature state from the
`areas` object. Anything joining these files should key on `NUTS_ID`, never
on feature index.

Provenance quirks to know before assuming "pure NUTS-2024"
(regenerated by
[`ingest/scripts/prepare-boundaries.ts`](../ingest/scripts/prepare-boundaries.ts),
which pins expected upstream feature counts and fails loudly on GISCO drift):

- **UK splice** — NUTS-2024 dropped the United Kingdom, so UK units are
  spliced in from the NUTS-2021 edition (41 NUTS-2, 179 NUTS-3 features;
  same schema and licence).
- **Bosnia splice** — Bosnia and Herzegovina has NUTS-2 but no NUTS-3
  subdivision; its three NUTS-2 polygons (`BA01`–`BA03`, `LEVL_CODE: 2`)
  are duplicated into `nuts3.geojson` so BiH renders at every zoom. Do not
  assume every feature in `nuts3.geojson` has `LEVL_CODE: 3` or a 5-char id.
  This is also why 340 + 1,527 features roll up to `areasTotal: 1864`
  (the three BA ids exist at both levels and are counted once).
- A third artifact, `ingest/data/nuts3-assign.geojson.gz` (1:3M), is used
  server-side for station→region assignment and is **not** served over HTTP.

**Licence obligation:** the boundaries are
"© EuroGeographics for the administrative boundaries" (Eurostat GISCO,
non-commercial use). That verbatim notice must remain visible wherever these
polygons — or anything derived from them — are rendered or redistributed.
See [README § Data licensing](../README.md#data-licensing).

## Licence

The artifacts under `/api/v1/*` form a derived database including
Sensor.Community data and are offered under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
— **share-alike**: attribute AerisMap and the sources listed in
[`/api/v1/meta`](#get-apiv1meta) `attribution[]`, and keep any derived
database open under the same terms. Per-station licences are in each
feature's `license` property. Full source list and the code-licence status:
[README § Data licensing](../README.md#data-licensing).
