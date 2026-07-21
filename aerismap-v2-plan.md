# AerisMap v2 — Architecture Plan

*Companion to [aerismap-europe-upgrade.md](aerismap-europe-upgrade.md) (the data-source brief). That document is the "what and why"; this one is the "how, exactly." All numbers below were verified against live endpoints and current official docs on **2026-07-21** by an adversarially-checked research pass — sizes, quotas, and rate limits are measured, not guessed.*

---

## 1. Locked decisions

| # | Decision | Choice | Consequence |
|---|---|---|---|
| D1 | Hosting budget | **$0/mo, card-free** — Cloudflare Workers Free plan + GitHub Actions for ingestion | Cloudflare only *serves*; all fetching/normalizing runs in an hourly GitHub Actions job (needed because a free-plan cron Worker gets 10 ms CPU and 50 subrequests — unusable). Artifact store is **Workers KV** (included in the card-free Free plan); **R2 was rejected** because activating it requires a payment card on the account and Cloudflare offers no hard spend cap — a billing surface this project deliberately refuses (decision 2026-07-21) |
| D2 | Domain | **workers.dev for now** | No edge caching (Cache API is non-functional on workers.dev). Every API hit = one Worker invocation + one KV read. Fine at hobby traffic; custom domain is a later drop-in upgrade |
| D3 | Stack | **Next.js (static export) + Node + TypeScript** — no Vue/Nuxt carried over from v1 | v1 backend is rebuilt anyway (repo not public); we reuse v1's *contract*: the GeoJSON station schema, the `eaqi-2025` band tables, and the API shape — all reverse-engineered and verified |
| D4 | Scope | **Visualization only** — no history store, and correlation *analysis* is explicitly not this project's job | No D1 database at all. The product is the map: AQ and temperature as toggleable layers users compare visually. Any statistical correlation work happens elsewhere; if it ever produces outputs, they can be rendered as just another layer |

**v2.0 deliverables:** Europe-wide station map (community + official, ~13–14k points, EAQI-colored), a temperature layer, and a modeled AQ gap-fill layer — served from Cloudflare, refreshed hourly, at $0/mo.

---

## 2. System overview

```
┌────────────────────────────┐        ┌──────────────────────────────┐
│  GitHub Actions (hourly)   │        │  Cloudflare (free plan)      │
│  Node 22 + TypeScript      │        │                              │
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

Why this shape: the ingest job needs ~15 MB of uncompressed fetches, JSON parsing of multi-MB documents, grid decoding, and geometry generation — trivial in an Actions runner (7 GB RAM, minutes of CPU, any runtime), hostile in a free Worker. Cloudflare's free tier is excellent at exactly what remains: serving static assets (free, unlimited) and small API reads (100k req/day).

---

## 3. Repository layout (monorepo, public)

```
aeris/
├── apps/web/          Next.js 15 (output: 'export'), React, MapLibre GL JS v5.x
├── packages/shared/   TS types: station schema, EAQI bands/colors, GeoJSON contracts
├── ingest/            Node 22 + TS ingest pipeline (run by GH Actions, runnable locally)
├── worker/            Cloudflare Worker: /api/v1/* from KV binding (DATA), else static assets
│   └── wrangler.jsonc assets dir → apps/web/out, run_worker_first: ["/api/*"]
└── .github/workflows/
    ├── ingest.yml     cron: "7 * * * *"  (offset minute — see §8 jitter note)
    └── deploy.yml     on push to main: build Next export, wrangler deploy
```

The repo must be **public**: GitHub Actions minutes are unlimited for public repos (private free tier is 2,000 min/month; an hourly ~3-min job eats ~2,200). The project is meant to be open-source anyway — and ODbL share-alike (§7) points the same direction.

Next.js notes: `output: 'export'` produces a plain static site — no OpenNext adapter, no SSR, no Node server. The map is fully client-rendered; Next is used for its DX/routing/TS setup, not its server. If we ever want SSR, OpenNext-on-Workers exists, but nothing in this app needs it.

---

## 4. Serving layer (Cloudflare Worker, free plan)

- **Static assets**: the Next export, served free and unlimited (asset requests don't count as Worker requests). SPA mode via `not_found_handling: "single-page-application"`.
- **API routes** (Worker → KV binding `DATA`, ~5 routes):
  - `GET /api/v1/stations` → `latest/stations.geojson.gz` (full Europe; no bbox param — see below)
  - `GET /api/v1/areas` → `latest/areas.json.gz` (NUTS area aggregates — §5.5)
  - `GET /api/v1/layers/temperature` → `latest/temp-isobands.geojson.gz`
  - `GET /api/v1/layers/aqi-model` → `latest/aqi-grid.geojson.gz`
  - `GET /api/v1/meta` → `latest/meta.json` (run timestamp, source freshness, attribution block)
- Serve gzip bodies with `Content-Encoding: gzip` passthrough; set `ETag` + `Content-Length` from the per-key `StoreMetadata` written by ingest (sha-256 of the stored bytes — KV has no native object metadata, unlike R2) + `Cache-Control: public, max-age=300` so browsers/proxies revalidate cheaply even without edge cache. RFC 9457 `problem+json` errors (kept from v1's contract).
- **Design change vs v1:** v1 had `?bbox=` server-side filtering. With static hourly artifacts, one full-Europe file is simpler and *more* cacheable; MapLibre culls by viewport client-side. At ~1–2 MB gzipped this is an acceptable initial load (revisit with tiling if it grows — §10).
- **Free-plan budget:** 100k Worker req/day. A map session ≈ 3–4 API hits; static assets are free. Comfortable to ~25k sessions/day. Beyond the limit, `run_worker_first` routes return 429 (no graceful fallback) — acceptable for now, and the fix (custom domain + edge cache) is already scoped as an upgrade, not a redesign.
- **KV budget (Workers Free plan):** writes 5 keys/hour = ~120/day of the **1,000 writes/day** cap; reads draw on **100k KV reads/day** (aligned with the Worker's own 100k req/day, one KV read per API hit); storage: `latest/` artifacts total ~0.42 MB gz of the **1 GB** namespace cap, largest value ~398 KB of the **25 MiB/value** cap. Over-cap behavior is failed requests for the rest of the UTC day — the Worker keeps serving the last stored (stale) artifacts, and there is never a bill (no card on the account, no billing surface). One KV nuance accepted: writes are eventually consistent across edge locations (~60 s), irrelevant at hourly cadence.

---

## 5. Ingestion pipeline (GitHub Actions, hourly)

One TypeScript entrypoint (`ingest/run.ts`), four stages, ~2–3 min wall-clock. Every upstream fetch sends `User-Agent: AerisMap/2.0 (+repo URL; contact email)` — mandatory for Sensor.Community, good manners everywhere.

### 5.1 Community layer — Sensor.Community (primary density source)

Verified live 2026-07-21: **9,691 active PM sensor locations (97.8% in Europe)**, 7,803 temperature locations, **74.3% of PM locations have a co-located temperature/humidity sensor** (BME280/DHT22) — the brief's "free co-located temperature" bonus is real and quantified.

Recipe:
1. `GET https://data.sensor.community/static/v2/data.dust.min.json` — 4.5 MB, PM only, 5-min averages, regenerated ~every 5 min. (Served **uncompressed**; no gzip even if requested.)
2. `GET .../data.temp.min.json` — 4.1 MB, temperature/humidity/pressure only.
3. Join on `location.id`; project to compact records; drop `indoor==1`, non-European country codes, and `exact_location==0` handling (coarsened coords → flag, don't drop).
4. Plausibility filters: DHT22 degenerate humidity readings (observed `humidity=1.00`), PM range checks; flag (don't silently correct) high-humidity PM over-reads in v2.0 — full humidity correction is a later refinement.

Yield: ~9.5k PM points, ~7.2k with co-located temperature. Do **not** use the `airrohr/v1/filter/box=` endpoint Europe-wide (measured 18.7 MB — 2× the dump) or `data.1h.json` (8.9 MB single parse; the two small files are safer and fresher).

*(openSenseMap adds only ~3k active European boxes and its Europe-wide temperature query times out — deferred to a later milestone as a top-up, PDDL-licensed.)*

### 5.2 Official layer — OpenAQ v3 (EEA network, harmonised)

The EEA's own Parquet API was evaluated and rejected for hourly polling (19,607 whole-timeseries files, 6.3 GB corpus — batch tool, not a live feed). OpenAQ v3 re-publishes the EEA UTD feed in poll-friendly JSON, ~1–2 h behind measurement. Expect **~3,500–4,500 active European reference stations**.

Recipe (free API key, header `X-API-Key`; limits 60 req/min, 2,000 req/hr — we use ~40–80/run):
1. Daily registry refresh: `GET /v3/locations?bbox=-25,34,45,72&monitor=true&limit=1000&page=N` → station id/coords/country registry (kept as a KV key between runs).
2. Hourly: for each parameter id in `[2 pm25, 1 pm10, 5 no2, 3 o3, 6 so2, 4 co]`: `GET /v3/parameters/{id}/latest?limit=1000&datetime_min=<now-6h>&page=N`, paginate via `meta.found`. **Warning:** ids 7–10 (no2/co/so2/o3 in **ppm**) are a real trap — the original research recommended them; the µg/m³ mass-concentration series above is the one EAQI needs.
3. **`datetime_min` is load-bearing**: OpenAQ's "latest" returns the last value of *dead* series too; without the filter the map renders stale stations as live. Also surface per-point observation age in the UI (v1's `stale` flag pattern).

### 5.3 Model layers — Open-Meteo's open-data S3 bucket (not the API)

The brief assumed the point API; the research killed that: hourly polling of a ~4,000-point Europe grid ≈ **96,000 call-weight/day vs a 10,000/day free cap** (~10× over). The correct source is Open-Meteo's AWS Open Data bucket (`s3://openmeteo`, anonymous HTTPS, CC-BY-4.0), which publishes whole model grids as `.om` files supporting HTTP range reads:

- **AQ gap-fill**: `data_spatial/cams_europe/` — full 0.1° CAMS Europe grid (~700×420 cells), all 25 pollutant variables in a **~1.8 MB file per hourly timestep**, one run/day with 97 forecast hours. Select the timestep matching the current hour. **`european_aqi` is not stored** — compute EAQI in-ingest from pm2_5/pm10/no2/o3/so2 using the shared band tables, and validate a sample against the live Open-Meteo API to catch divergence. Label this layer *model forecast, not measurement* (the run can be up to ~38 h old late in its cycle).
- **Temperature**: `data_spatial/dwd_icon_eu/` — ~7 km hourly `temperature_2m`, observed mirror latency ~3.5 h. Fallback for >70.5°N and gaps: `ecmwf_ifs025` / `dwd_icon` global. Decode grid → downsample → `@turf/isobands` (grid is already rectangular, no IDW needed) → MultiPolygon GeoJSON rendered as a translucent fill layer. Also drive the *station-level* temperature dots from Sensor.Community's co-located sensors (§5.1) so the layer shows model field + ground truth together.
- **Caveats**: 7-day file retention, no SLA — the previous hour's artifacts in KV are the fallback (serve stale with a freshness banner). The official `.om` readers (`@openmeteo/file-reader` TS/WASM, and the Python reader) are **GPL-2.0-only** — see §7.

### 5.4 Normalize, build, upload

- Normalize everything into the v1-derived station schema (verified from the deployed bundle): `{id, source, nativeId, kind: reference|community|model, country, license, exactLocation, stale, observedAt, values:{param:{value,ts,flags}}, eaqi, eaqiPollutant, ...}` — v1 even reserved `kind: "model"`, which v2 finally populates.
- EAQI scoring with the verified **eaqi-2025** bands (thresholds pm2_5 [5,15,50,90,140], pm10 [15,45,120,195,270], no2 [10,25,60,100,150], o3 [60,100,120,160,180], so2 [20,40,125,190,275]; colors #50f0e6/#50ccaa/#f0e641/#ff5050/#960032/#7d2181). Cross-check once against EEA's official revised-index documentation before launch.
- Emit gzipped artifacts (coordinate precision trimmed to 4–5 decimals, terse property keys): `stations.geojson.gz` (~1–2 MB gz for ~14k points), `temp-isobands.geojson.gz`, `aqi-grid.geojson.gz`, `meta.json`.
- Upload to Workers KV via the Cloudflare REST API (custom API token with **Workers KV Storage → Edit** in repo secrets — `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_KV_NAMESPACE_ID`). Each value is written together with its `StoreMetadata` (sha-256 etag, byte size, content type/encoding) since KV has no native object metadata. KV has no copy/rename, so `latest/` can't be swapped atomically as a set: writes are per-key atomic — write the data keys first and `meta.json` last, so a mid-upload map load sees at worst the previous hour's data with matching-or-older meta, never a torn artifact.

### 5.5 Area mode (shipped with M1)

Aggregates the station snapshot into Eurostat NUTS regions so low zoom reads as a regional choropleth instead of ~10k overlapping dots. Decisions (locked 2026-07-21):

- **Region set: NUTS-2 + NUTS-3** from GISCO NUTS-2024 1:20M, with a **zoom handoff at ~z5.5** (NUTS-2 below, NUTS-3 above). The **UK is spliced in from NUTS-2021** (it left the NUTS-2024 release). Kept properties per feature: `NUTS_ID`, `LEVL_CODE`, `NAME_LATN`, `CNTR_CODE`.
- **Semantics: median → band → worst pollutant.** Per region, take the per-pollutant *median* across included stations (stale excluded; PM readings from `pmHumidityBias` stations excluded; QC-flagged readings excluded — §5.6; coarsened-coordinate stations included), band each median with eaqi-2025, and color by the worst-banded pollutant. **Honesty gating (revised 2026-07-21 — §5.6):** the original hard cliff (`AREA_MIN_STATIONS = 3` / `AREA_MIN_POLLUTANT_STATIONS = 2`, both exports since removed) is replaced by graduated gating: a pollutant with even a single QC-passed contributing station may color a region in bands ≤ 3 (`regionBandAllowed`), a pollutant with exactly two stations takes its band from the *min* of the pair (`AREA_TWO_STATION_RULE`), and a region is colored if any pollutant passes. Fill opacity still encodes confidence (station count, full at `AREA_FULL_CONFIDENCE_STATIONS = 3`).
- **UX: auto areas→dots crossfade.** No layer toggle — zooming in fades the choropleth out and the station circles in, so the handoff is continuous and the per-station detail is never more than a zoom away.

Architecture: the boundary GeoJSONs are **immutable static assets** (`/boundaries/nuts2.geojson`, `/boundaries/nuts3.geojson`, ~450 KB gz total), prepared once by `ingest/scripts/prepare-boundaries.ts` and vendored into the repo — they never touch KV or the hourly job. The hourly ingest publishes only the *values*: `latest/areas.json.gz` (~9 KB gz — `AreaSnapshot`, one flat map keyed by `NUTS_ID`), served at `GET /api/v1/areas`. The frontend joins values onto geometry client-side via MapLibre **feature-state** (`promoteId: 'NUTS_ID'`), so an hourly refresh moves ~9 KB, not ~450 KB.

Coverage gaps (accepted): NUTS covers the EU/EFTA/candidate space, so **UA has no subnational regions and RU/BY/AM/MD/GE are absent entirely — ≈ 320 stations render dots-only** there at every zoom. **LAU/municipality-level areas are explicitly deferred to the custom-domain milestone**: ~98k polygons are far beyond inline GeoJSON and require PMTiles on R2 (measured 48.5 MB at z4–z10) — which now also **requires enabling R2 (payment card) — revisit only if that stance changes** (§1 D1) — and only pays off once a custom domain enables edge caching (§10).

Licensing: the GISCO download agreement makes the notice **"© EuroGeographics for the administrative boundaries"** mandatory and the data non-commercial; the notice must stay visible in the app wherever the area layer renders (it is in the shared `ATTRIBUTIONS` block).

### 5.6 Sensor QC & graduated confidence (validated + shipped 2026-07-21)

**The incident.** A batch of railed SDS011 sensors stuck at ~1000 µg/m³ painted **DE403, ITH2 and ITH20 "Extremely poor"**: each region had only two contributing PM stations, so a two-value median (the midpoint of the pair) let a single broken sensor drag the region band to the top of the scale. The §5.5 honesty thresholds were built against *sparse* data, not *wrong* data — this incident showed the pipeline needed an explicit quality gate.

**Validation method.** Three candidate flagging statistics were implemented **twice, independently**, run against live data, and reconciled by a judge pass. The band-distance candidate (flag a station whose EAQI band sits ≥ N bands above its neighbors') was **disqualified empirically**: co-broken sensors cluster geographically and corroborate each other's bands, so it caught only **24/111** railed pm2_5 sensors. The ratio-to-neighborhood-median statistic won on every axis and is what shipped.

**The adopted rule** (`QC_RULE` in `packages/shared/src/contracts.ts`; applied per pollutant to `pm2_5` and `pm10`): a reading *x* is flagged when

> *x* > **4 ×** median(same-pollutant readings of *other* stations within **50 km** haversine, fresh within the community staleness horizon) **AND** *x* > **25 µg/m³**,

computable only with **≥ 3 neighbors** — with fewer, the station is *unflaggable* (no evidence either way, not a pass). Evidence from the validation run: catches **109/111** railed pm2_5 and **4/4** railed pm10 sensors, heals the DE403/ITH2/ITH20 false purples, **~2.8%** overall flag rate, **~91%** short-term flag stability, **zero false hotspots**. Flagged params are listed in `StationProperties.qc`; flagged readings are **excluded from station EAQI and from region medians** but stay present in `values` so popups can show them with a warning.

**Companion rules** (same contracts file):

- **Min-of-two banding** (`AREA_TWO_STATION_RULE = 'min'`): when a region pollutant has exactly 2 contributing stations, its band comes from the *min* of the two values (the published `med` stays the median). One liar can't paint a region.
- **Graduated gating** (`regionBandAllowed(band, cnt)`): `cnt ≥ 2` always allowed; `cnt == 1` allowed only for bands ≤ 3 — *one sensor may say "fine", never "emergency"*. A region is colored if **any** pollutant passes, so n ≥ 1 now suffices; removing the ≥3-station cliff lights up **~385 previously-blank regions**, rendered faint via the opacity ramp (full confidence at `AREA_FULL_CONFIDENCE_STATIONS = 3`).
- **Hotspot promotion** (`HOTSPOT_MIN_BAND = 4`): a station gets `properties.hotspot = true` when its worst **unflagged** pollutant band is ≥ 4 **and** either `kind === 'reference'` or ≥ 1 neighbor within 50 km has a fresh same-pollutant reading within 1 EAQI band. Corroborated epicenters stay prominently visible even at choropleth zooms — QC removes liars without hiding real events.

**Residual risks (from the judge; accepted):**

1. **Winter smog is analytically argued, empirically untested.** Broad genuine elevation lifts the neighborhood median, so the 4× ratio shouldn't flag it — but the rule was validated in July; the first winter-smog episode is the real test.
2. **Flag churn at the 25 µg/m³ frontier**: ~10–14% of flags flip between consecutive runs where readings hover near the floor/ratio boundary. Cosmetic at hourly cadence; hysteresis (e.g. flag at 4×, unflag at 3×) is a possible future refinement (§10).
3. **2 railed sensors are structurally unflaggable** (0–1 neighbors within 50 km). Defense in depth bounds the damage: alone in a region, graduated gating blocks severe bands (cnt 1, band > 3); with one companion, min-of-two banding overrides it; their dots still render railed, which is honest.
4. **Possible suppression of real hyper-local events** in the 25–50 µg/m³ gray zone: a genuine plume confined to one station that reads > 4× its neighbors gets flagged like a broken sensor. The reading remains visible in the popup (with the warning), so the information is dimmed, not destroyed.

---

## 6. Frontend (apps/web)

- **MapLibre GL JS v5.x, pinned** (v6 is in transition with breaking changes). 14k points is comfortably within a plain GeoJSON source + circle layer (the official guidance: tens of thousands of points are fine; set source `maxZoom: 12`).
- **EAQI coloring** via a data-driven `step`/`match` expression from the shared band tables. **Clustering off by default** — count-bubbles hide per-station EAQI, which is the whole point of the map. If low-zoom clutter demands it, cluster with `clusterProperties: {maxEaqi: ["max", ["get","eaqi"]]}` and color clusters by worst member, never by count.
- **Layers/toggles**: EAQI (default) · per-pollutant · temperature (isoband fill under the circle layer + station temp values) · AQ model grid. Toggle = `setLayoutProperty` visibility. Source-class filter (reference/community/model) with the trust caveat surfaced, per the brief's §6.
- **Basemap: OpenFreeMap** (`tiles.openfreemap.org/styles/positron` — what v1 uses): no keys, no request limits, commercial use allowed, donation-funded/no SLA. Documented fallback: self-hosted Protomaps PMTiles on R2 (a Europe extract should fit the 10 GB free tier — verify size before relying on it; requires enabling R2 (payment card) — revisit only if that stance changes, §1 D1). Do **not** use raw OSM tiles (usage policy forbids production apps) or MapTiler free (hard-pauses on quota).
- **Attribution footer** (legally required, see §7): Sensor.Community (ODbL) · OpenAQ/EEA · CAMS ENSEMBLE · Open-Meteo · DWD ICON · OpenFreeMap/OpenMapTiles © OpenStreetMap contributors.

---

## 7. Licensing obligations (act-on list, not FYI)

| Source | Licence | What we must do |
|---|---|---|
| Sensor.Community | **ODbL 1.0** (db) + DbCL 1.0 (contents) | Attribute; **share-alike**: our published normalized dataset (the GeoJSON artifacts are a derived database, publicly used) must be offered under ODbL. Practically: state it in the repo/footer, keep artifacts publicly fetchable. Aligns with the public repo (D1/D3) |
| OpenAQ | Varies per underlying source | Attribute OpenAQ + EEA; comply with source terms |
| Open-Meteo S3 open data | CC-BY 4.0 | Attribute Open-Meteo **and** CAMS ENSEMBLE (and DWD for ICON) |
| CAMS / Copernicus | CC-BY-style | Attribution as above |
| OpenFreeMap | Free incl. commercial | Attribute OpenMapTiles + OSM contributors |
| `@openmeteo/file-reader` (and the Python `.om` reader) | **GPL-2.0-only** | Running it server-side in Actions is fine; *shipping it in our public repo* makes GPL compatibility a question for our repo licence. Options: licence `ingest/` (or the whole repo) GPL-compatible (e.g. GPL/AGPL), isolate the decode step, or write a minimal `.om` range-reader ourselves. **Decide at M2 kickoff** |
| Open-Meteo point API (fallback only) | Free tier = non-commercial | Fine while the site has no ads/subscriptions |

---

## 8. Operational risks (accepted, with mitigations)

1. **GitHub Actions cron jitter & auto-disable** — scheduled runs can slip minutes-to-tens-of-minutes at busy hours (use an offset minute, `7 * * * *`), and GitHub *disables schedules after 60 days without repo activity*. Mitigation: freshness banner driven by `meta.json` age; any commit resets the 60-day clock; optionally a keepalive step. The map must degrade to "stale but visible", never blank.
2. **Sensor.Community fragility** — uncompressed dumps, wiki-documented API, terms changed before (UA mandate 2022). Mitigation: previous artifacts remain served; monitor dump sizes in `meta.json`.
3. **OpenAQ coverage drift** — its EEA adapter has historically dropped records on upstream format changes. Mitigation (later milestone): occasional reconciliation against the EEA Parquet API in a weekly Actions job.
4. **Open-Meteo S3 mirror lag/no SLA** — serve previous hour; point-API spot-check as canary.
5. **workers.dev 100k req/day + 429 cliff** — fine at hobby scale; the upgrade path (custom domain → Cache API/cache rules → near-zero origin hits) is additive, no redesign.
6. **KV free-plan write cap (1,000 writes/day)** — the hourly job uses ~120/day (5 keys × 24 runs), so only a runaway retry loop or heavy manual re-running could approach it. Over-cap writes fail for the rest of the UTC day; the Worker keeps serving the last stored artifacts (stale-but-visible, same degradation mode as risk 1) and no bill is possible — there is no card on the account. Mitigation: no unbounded upload retries in ingest; freshness banner surfaces the stall.
7. **Double-counting** across community networks — moot until openSenseMap is added; then dedup by coordinate proximity.
8. **Spatial-QC residuals (§5.6)** — winter-smog behavior of `QC_RULE` is argued, not yet observed (first winter is the empirical test); ~10–14% flag churn at the 25 µg/m³ frontier (hysteresis scoped in §10); 2 railed sensors structurally unflaggable with 0–1 neighbors (graduated gating + min-of-two banding bound their region damage); genuine hyper-local events in the 25–50 µg/m³ gray zone can be flagged as sensor faults (reading stays visible in the popup with the warning). Mitigation for all four: the rule lives in one shared constant (`QC_RULE`) and re-validation against live data is cheap to rerun.

---

## 9. Milestones

- **M0 — Skeleton (a weekend):** monorepo scaffold; Next static export + MapLibre + OpenFreeMap renders; Worker serves assets + a stub `/api/v1/meta` from KV; deploy workflow green on workers.dev.
- **M1 — Europe-wide stations:** ingest Sensor.Community + OpenAQ in Actions; EAQI scoring; `stations.geojson.gz` to KV; map shows ~13–14k EAQI-colored points with source-class filter and staleness handling. *This alone completes brief goals #1 and #2.*
- **M2 — Model layers:** `.om` decoding (GPL decision made); CAMS EAQI grid layer; ICON temperature isobands + co-located station temps; layer toggle UX. *Completes brief goal #3's "simple version".*
- **M3 — Hardening:** openSenseMap top-up + dedup; humidity flagging→correction for community PM; EEA reconciliation job; custom domain + edge caching when traffic or the 429 cliff warrants.
- **Stretch (pure visualization, no statistics):** a bivariate AQ×temperature color view (3×3 Stevens grid via paint expressions — no plugin exists, none needed) as an alternative to eyeballing two toggled layers. Only if the toggle UX feels lacking.

---

## 10. Deferred / open items

- Payload strategy if station count outgrows ~1–2 MB gz (openSenseMap, network growth): switch `/api/v1/stations` to quantized tile keys — the KV key layout supports it without breaking the contract (per-tile values are tiny next to the 25 MiB/value cap; watch the read-op multiplier against the 100k reads/day budget instead).
- **LAU/municipality-level area mode** (custom-domain milestone): 98k polygons → PMTiles on R2, measured 48.5 MB at z4–z10 — needs the custom domain + edge cache first (see §5.5), and requires enabling R2 (payment card) — revisit only if that stance changes (§1 D1).
- PMTiles Europe extract size check (basemap fallback readiness; the R2 caveat above applies to that fallback too).
- EAQI band cross-check against EEA primary docs (pre-launch task, M1).
- `.om` reader licence decision (M2).
- **QC hysteresis** at the flag frontier (§5.6 residual 2): asymmetric thresholds (e.g. flag at 4×, unflag at 3×) would cut the observed ~10–14% run-to-run flag churn; needs a small state carry between ingest runs (previous flag set in KV) — take up only if churn proves user-visible.
- **Winter re-validation of `QC_RULE`** (§5.6 residual 1): rerun the two-implementation + judge evaluation on live data during the first sustained winter-smog episode; adjust `ratioThreshold`/`floorUgM3` only with equivalent evidence to the July run.
