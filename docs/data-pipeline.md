# Data pipeline

The end-to-end story of a reading: fetched from an upstream source, filtered,
quality-checked, scored, aggregated into regions, and published as static
artifacts to Workers KV. Everything here runs in the hourly GitHub Actions job
(`.github/workflows/ingest.yml`, cron `7 * * * *`, ~2–3 min wall-clock), whose
entrypoint is [`ingest/src/run.ts`](../ingest/src/run.ts). The serving side
(Worker, KV keys, deployment) is covered in the [README](../README.md); the
architecture rationale lives in the
[plan](../aerismap-v2-plan.md) and the trade-offs in the
[decision log](decisions.md).

All sizes and counts below are as measured on **2026-07-21** (launch day)
unless dated otherwise.

## Sources

Two sources ship today; the model layers (CAMS AQ grid, ICON temperature) are
milestone M2 — see [plan §5.3](../aerismap-v2-plan.md#53-model-layers--open-meteos-open-data-s3-bucket-not-the-api).

Every upstream fetch sends the `User-Agent` from
[`ingest/src/http.ts`](../ingest/src/http.ts) (currently
`AerisMap/2.0 (+https://github.com/aerismap; hosted ingest)` — Sensor.Community
mandates an identifying UA; the string still needs the real repo URL
`github.com/hradecji/aerismap` and a contact email). Default retry policy
(`fetchJson`): 60 s timeout, 2 retries with exponential backoff; network
errors, 5xx and 429 are retried (`Retry-After` honoured, capped at 60 s);
other 4xx and over-size responses fail immediately. Bounded retries are
deliberate — they are the "no unbounded retries" mitigation for the KV write
cap ([plan §8.6](../aerismap-v2-plan.md#8-operational-risks-accepted-with-mitigations)).

### Sensor.Community (community layer)

Source: [`ingest/src/sources/sensor-community.ts`](../ingest/src/sources/sensor-community.ts).
Licence: **ODbL 1.0** (database) / DbCL 1.0 (contents) — the share-alike
obligation on our published artifacts follows from this, see
[README → Data licensing](../README.md#data-licensing).

Two static dumps, fetched **sequentially** (a donation-funded host — no
parallel hammering), each capped at 48 MB:

| Dump | Size (2026-07-21) | Content |
|---|---|---|
| `data.dust.min.json` | ~4.5 MB, uncompressed | PM only, 5-min averages, regenerated ~every 5 min |
| `data.temp.min.json` | ~4.1 MB, uncompressed | temperature / humidity / pressure |

Records are joined per `location.id` with a **per-param newest-wins** merge
(the feed contains back-to-back records where the newer one carries only
humidity and the older one the PM values — record-level dedupe would lose
data). Dropped outright: `indoor == 1`, and anything outside `EUROPE_BBOX`
`[-25, 34, 45, 72]`. Note the Europe filter is a **coordinate bbox test, not a
country-code test** — country codes are recorded but never used for filtering.
`exact_location == 0` stations are kept and flagged (`exactLocation: false`),
not dropped.

Contributes: `pm1`, `pm2_5`, `pm10`, `temperature`, `humidity`, `pressure`
from ~9.5k locations (9,671 on 2026-07-21; ~74% of PM locations have a
co-located BME280/DHT22). **No gas pollutants** — see
[Known blind spots](#known-blind-spots).

### OpenAQ v3 (official layer)

Source: [`ingest/src/sources/openaq.ts`](../ingest/src/sources/openaq.ts).
The EEA reference network re-published as poll-friendly JSON, ~1–2 h behind
measurement; expect ~4k+ registry locations of which ~2.5k report within the 6 h freshness window (observed 2026-07-21). Requires the free
`OPENAQ_API_KEY` (header `X-API-Key`); **a missing key is a deliberate quiet
skip** — the map goes community-only, no error. Requests are paced at 1.1 s
(the hard limit is 60 req/min) with `x-ratelimit-remaining`/`-reset` backoff;
pagination is capped at 40 pages with a truncation warning; pages are capped
at 8 MB.

The station registry comes from
`GET /v3/locations?bbox=-25,34,45,72&monitor=true`, cached for **24 h** under
the KV key `internal/openaq-registry.json` (or the same path in the local out
dir). A malformed cache is refetched; a failed refresh falls back to the stale
cache with a warning recorded in `meta.sources[].detail`. This is why the CI
API token needs KV **read** access, not just write (Edit implies read).

Hourly values come from `GET /v3/parameters/{id}/latest` with
`datetime_min = now − 6 h` — **load-bearing**: OpenAQ's "latest" includes the
final value of *dead* series, so without the filter the map renders long-dead
stations as live.

Parameter ids (the **µg/m³ mass-concentration series**):

| id | OpenAQ name | AerisMap param |
|---|---|---|
| 1 | pm10 | `pm10` |
| 2 | pm25 | `pm2_5` |
| 3 | o3 | `o3` |
| 4 | co | `co` |
| 5 | no2 | `no2` |
| 6 | so2 | `so2` |

> **Warning — the ppm trap.** Ids **7–10** are the same gases in **ppm** and
> must never be used; EAQI banding needs µg/m³. The original research pass
> even recommended the ppm ids. A once-per-run runtime guard
> (`verifyParameterIds`) re-checks every configured id against
> `/v3/parameters` (name **and** µg/m³ units, `µ`/`μ` both tolerated) and
> fails the whole source on any mismatch rather than publish a mislabeled
> series.

Contributes: reference-grade `pm2_5`, `pm10`, `no2`, `o3`, `so2`, `co` — the
only source of gas pollutants, and the `kind: 'reference'` pedigree that QC
and hotspot promotion treat as trustworthy.

## Parsing and plausibility filters

Per-value bounds for Sensor.Community (`normalizeScValue`; every case was
observed in the live feed):

| Param | Rule |
|---|---|
| `pm1` / `pm2_5` / `pm10` | keep 0–1000 µg/m³ (PPD42NS units report PM in the thousands) |
| `temperature` | keep −60…+60 °C (broken DHT22s report −142 °C and +436 °C) |
| `humidity` | keep (1, 100] — **excludes the DHT22 degenerate constant `1.00`** |
| `pressure` | feed mixes Pa (~100 000) and hPa (~1000): values > 2000 are divided by 100 (**Pa → hPa**), then keep 300–1100 hPa |

Timestamps: the feed's zone-less `YYYY-MM-DD HH:MM:SS` is parsed as UTC.
Readings more than **10 minutes in the future** are dropped in both sources —
a clock-skewed station would otherwise render permanently fresh.

OpenAQ value hygiene: values **≤ −10 are dropped as sentinels** (OpenAQ passes
through −999); **−10 < v < 0 clamps to 0** (instrument noise in clean air).

Above the per-value filters sit **source-level plausibility floors**: a fetch
that "worked" but yields fewer than **500** Sensor.Community stations or
**100** OpenAQ stations (normal ≈ 9.5k and ≈ 2.5k fresh) marks the whole source
failed (`meta.sources[].ok: false`) and its data is not published — the
[carry-forward ladder](#failure-degradation-carry-forward) takes over. This is
the first thing to check when a run went green but the map shrank.

## Freshness and staleness

`MAX_AGE_SEC` in [`packages/shared/src/contracts.ts`](../packages/shared/src/contracts.ts):

| Station kind | Horizon |
|---|---|
| `community` | 2700 s (45 min) |
| `reference` / `model` | 10 800 s (3 h) |

These two constants drive four things: the station `stale` flag (from the
newest reading), **per-reading** eligibility for the station's EAQI, the QC
neighbour pools, and inclusion in region medians. Staleness is per-reading,
not just per-station: a station with a fresh temperature but a 2-hour-old PM
value keeps the PM in `values` (popups show it) while the EAQI and all
aggregates ignore it.

## Station EAQI

`computeEaqi` scores the **fresh** readings only, bands each of
`pm2_5 / pm10 / no2 / o3 / so2` with the **eaqi-2025** tables
([`packages/shared/src/eaqi.ts`](../packages/shared/src/eaqi.ts); thresholds
listed in [plan §5.4](../aerismap-v2-plan.md#54-normalize-build-upload)), and
takes the worst band. After spatial QC, the EAQI is recomputed **minus flagged
readings** — a station whose only scoreable fresh reading is flagged loses its
EAQI (and its colour) entirely. Why eaqi-2025 and not a home-made composite:
see the [decision log](decisions.md#2026-07-21--eaqi-as-the-one-integrated-index-no-custom-composite).

## Spatial QC — the ratio rule

Constants in `QC_RULE`
([`packages/shared/src/contracts.ts`](../packages/shared/src/contracts.ts)),
implementation in [`ingest/src/qc.ts`](../ingest/src/qc.ts). Applied to
`pm2_5` and `pm10` only. The rule, verbatim:

> A reading *x* is flagged when *x* > **4 ×** median(same-pollutant fresh
> readings of *other* stations within **50 km**) **and** *x* > **25 µg/m³** —
> computable only with **≥ 3 neighbours**. With fewer, the station is
> *unflaggable* (no evidence either way, not a pass).

The floor is checked first: a reading ≤ 25 µg/m³ is never flagged regardless
of ratio. The neighbourhood median is deliberately **single-pass over the raw
pool** — a cluster of co-broken sensors cannot corroborate each other, because
the median stays anchored by the clean majority.

**Validation story (2026-07-21).** The trigger was a batch of railed SDS011
sensors stuck at ~1000 µg/m³ painting DE403, ITH2 and ITH20 "Extremely poor"
via two-station medians. Three candidate statistics were each implemented
**twice, independently**, run against live data, and reconciled by a judge
pass:

- **Band-distance** (flag when a station's band sits ≥ N bands above its
  neighbours') — **disqualified empirically**: co-broken sensors cluster
  geographically and mutually corroborate each other's bands, so it caught
  only **24/111** railed pm2_5 sensors.
- **Robust z-score** — tied the ratio rule on the numbers, but lost on
  auditability: the ratio rule is checkable with a calculator and four
  constants.
- **Ratio-to-neighbourhood-median** (candidate C, shipped) — caught
  **109/111** railed pm2_5 and **4/4** railed pm10 sensors, healed the
  DE403/ITH2/ITH20 false purples, ~2.8% overall flag rate, ~91% short-term
  flag stability, zero false hotspots.

Effect of a flag: the param is listed in `StationProperties.qc`; the reading
is **excluded from the station's EAQI and from region medians** but stays in
`values`, so the popup shows it with a warning. Flags are **recomputed from
scratch every run** (carried-forward stations arrive holding last run's flags,
which are wiped), and flagged neighbours cannot corroborate hotspots. A ~0.5°
grid-bucket index keeps the 9.6k-station × 50 km sweep at ~100 ms. Residual
risks (winter smog untested, ~10–14% flag churn at the 25 µg/m³ frontier, two
structurally unflaggable railed sensors, possible suppression of genuine
hyper-local plumes) are accepted and documented in
[plan §5.6](../aerismap-v2-plan.md#56-sensor-qc--graduated-confidence-validated--shipped-2026-07-21).

## Hotspots — promotion and the contrast rule

QC removes liars; hotspots keep real events visible. **Promotion** (ingest,
`HOTSPOT_MIN_BAND = 4`): a station whose worst **unflagged** pollutant band is
≥ 4 gets `properties.hotspot = true` when it is `kind: 'reference'` **or** at
least one neighbour within 50 km has a fresh, unflagged same-pollutant reading
within 1 EAQI band. The driving reading must itself be fresh — a fully-stale
carried-forward station keeps its old EAQI for display but cannot be promoted.

**Contrast rule** (added 2026-07-21 evening, commits `b46a41f` + `0ba8994`): a
ring that repeats the region colour under it is noise. Ingest stamps
`regionBands: { n2?, n3? }` (the station's region bands at both NUTS levels)
onto each hotspot station ([`ingest/src/areas.ts`](../ingest/src/areas.ts));
the client ([`apps/web/src/lib/hotspots.ts`](../apps/web/src/lib/hotspots.ts))
renders a ring **only where the station band exceeds the displayed region
band** — NUTS-2 below the z5.5 split, NUTS-3 above. Stations in uncoloured or
unassigned regions always show their rings. Rings render **only in the Air
Quality (EAQI) view** — their colour encoding is the EAQI band, which has no
meaning in the per-pollutant, temperature or humidity views — and ring clicks
win over region popups at all zooms. The `◉ hotspot above its region's level`
legend line appears only when the snapshot contains hotspots.

## pmHumidityBias

Low-cost optical PM sensors over-read in near-saturated air. A station with
any PM reading and relative humidity **≥ 95%** gets
`pmHumidityBias: true` ([`ingest/src/snapshot.ts`](../ingest/src/snapshot.ts)).
Unlike a QC flag, this does **not** remove the station's own EAQI — it only
excludes that station's PM values from region medians (the two exclusions
compose; either suffices). Philosophy: flag, don't silently correct; a full
humidity correction is a later refinement (plan §5.1).

## Failure degradation (carry-forward)

The ladder, from mildest to worst:

1. **One source fails** (fetch error, guard failure, or a plausibility floor):
   its stations are **carried forward from the previous published snapshot**
   ([`ingest/src/snapshot.ts`](../ingest/src/snapshot.ts) +
   `loadPreviousStations` in [`ingest/src/output.ts`](../ingest/src/output.ts)).
   Staleness is recomputed against the current time; `values` and EAQI are
   untouched. `meta.sources[]` records `ok: false`, `carriedForward: <n>` and
   an amended `detail`. A configured-but-failed source also emits a
   `::warning` annotation in the Actions log (a missing `OPENAQ_API_KEY` does
   not — that is a deliberate skip).
2. **Area aggregation fails** (boundary load or aggregation error): a
   `::warning`, and **no areas artifact this run** — the previously published
   `latest/areas.json.gz` stays in place while stations and meta still update,
   so `areas.generatedAt` may lag `meta.generatedAt`.
3. **Every source fails**: the run exits 1 and publishes **nothing** — the
   Worker keeps serving the last stored artifacts, and the frontend's
   freshness banner (driven by `meta.generatedAt`) surfaces the stall.
4. **CI misconfiguration**: `GITHUB_ACTIONS` set but KV credentials missing →
   exit 1 immediately (a green run that uploads nothing is worse than a red
   one).

`meta.json` is the primary debugging surface. Example (local community-only
run, 2026-07-21): `sources` shows
`{ "id": "openaq", "ok": false, "detail": "OPENAQ_API_KEY not set; official layer skipped" }`
with `counts.stations: 9671`, all `community` — read `sources[]` first, then
`counts`, whenever the map looks thin.

## NUTS assignment

Implementation and constants: [`ingest/src/areas.ts`](../ingest/src/areas.ts).

There are **three** vendored boundary artifacts, not two: the browser display
sets `apps/web/public/boundaries/nuts2.geojson` / `nuts3.geojson` (GISCO
NUTS-2024, 1:20M) and the higher-resolution **assignment set**
`ingest/data/nuts3-assign.geojson.gz` (1:3M NUTS-3) used for station →
region point-in-polygon. All three are regenerated by
[`ingest/scripts/prepare-boundaries.ts`](../ingest/scripts/prepare-boundaries.ts)
(byte-deterministic, commit-ready; pinned expected feature counts hard-fail on
GISCO drift — see the script header before re-vendoring). Two splices: the
**UK comes from NUTS-2021** (NUTS-2024 dropped it), and **Bosnia's NUTS-2
polygons are spliced into the NUTS-3 layer and the assignment set** (BA has no
NUTS-3 subdivision; the rollup dedupes ids that exist at both levels so
stations count once). Total region universe: **1,864**
(`meta.counts.areasTotal`).

Assignment is a hand-rolled even-odd ray cast with a per-feature bbox
prefilter (~100 ms for 14k stations × 1.3k polygons). A point outside every
polygon (coastal stations, generalization artefacts) falls back to the
candidate region — bbox expanded by 0.03° — whose nearest polygon vertex is
within **~2 km**; beyond that the station stays unassigned. RU/BY/AM/MD/GE and
country-only UA have no NUTS polygons by design: **≈ 320 stations render
dots-only** at every zoom. NUTS-2 aggregates run over that region's stations
**directly** — a single median, not a median of NUTS-3 medians.

## Region aggregation and graduated gating

Semantics (per region, per pollutant in
`AREA_PARAMS = pm2_5, pm10, no2, o3, so2, temperature, humidity`):
**median → band → worst pollutant**. Included readings are non-stale,
non-QC-flagged, non-`pmHumidityBias` (PM only); coarsened-coordinate stations
stay in (the median is robust to small offsets). Each pollutant median is
banded with eaqi-2025 and the worst *allowed* band colours the region.

Allowed means `regionBandAllowed(band, cnt)`
([`packages/shared/src/contracts.ts`](../packages/shared/src/contracts.ts)):

- `cnt ≥ 2` — always allowed;
- `cnt == 1` — allowed only for bands ≤ 3: **one sensor may say "fine", never
  "emergency"**;
- with **exactly two** stations, the band comes from the **min** of the pair
  (`AREA_TWO_STATION_RULE = 'min'`) — one liar can't paint a region; the
  published `med` stays the median.

Fill opacity encodes confidence (full at
`AREA_FULL_CONFIDENCE_STATIONS = 3`), so single-station regions render faint.
This graduated scheme replaced the original hard ≥3-station cliff on
2026-07-21 and lit ~385 previously blank regions — rationale in the
[decision log](decisions.md#2026-07-21--graduated-region-gating-replaces-the-3-station-cliff-commit-542954b).

One divergence to know about: the **per-pollutant area views band the
published median client-side** ([`apps/web/src/lib/areas.ts`](../apps/web/src/lib/areas.ts))
because raw station values are not published — so the min-of-two rule protects
only the overall Air Quality band, and a two-station region can show a severer
band in the PM2.5 view than in the Air Quality view.

## Artifacts

Built by `buildArtifacts` in [`ingest/src/output.ts`](../ingest/src/output.ts)
and uploaded **in order, `meta.json` last** — KV has no multi-key atomic swap,
so meta acts as the completion pointer: a mid-upload reader sees at worst the
previous hour's data with matching-or-older meta, never a torn artifact.

| KV key | Format | Size (2026-07-21, community-only run) |
|---|---|---|
| `latest/stations.geojson.gz` | gzipped GeoJSON `FeatureCollection` | 409 KB |
| `latest/areas.json.gz` | gzipped `AreaSnapshot` (flat map keyed by `NUTS_ID`, both levels) | 20.7 KB |
| `latest/meta.json` | plain JSON `SnapshotMeta` | 1.5 KB |

Each value is written with `StoreMetadata` (sha-256 etag, byte size, content
type/encoding) — KV has no native object metadata; the Worker serves
ETag/Content-Length from it. A normal run writes **3 keys**, plus
`internal/openaq-registry.json` roughly once per 24 h — **≈ 73 writes/day**
against the 1,000/day KV cap. (The "5 keys/run" figure quoted elsewhere is the
M2-complete artifact set, once `latest/temp-isobands.geojson.gz` and
`latest/aqi-grid.geojson.gz` have producers.) KV budget details:
[README → Deployment](../README.md#deployment).

Local runs without KV credentials write the same key layout under
`ingest/.artifacts/` (or `--out <dir>`); note a KV-configured run writes
nothing locally unless `--out` is passed.

## Known blind spots

- **Community sensors are PM-only.** A region coloured "Good" from PM medians
  alone can be sitting under a gas episode. Verified live on 2026-07-21:
  CAMS showed an **ozone episode over the Mediterranean that the PM-only
  community data could not see** (commit `2f3ff20`). Two mitigations shipped:
  region popups disclose it explicitly ("PM only — no station here measures
  gas pollutants (O₃, NO₂, SO₂)…",
  [`AreaPopup.tsx`](../apps/web/src/components/AreaPopup.tsx)), and OpenAQ
  reference stations contribute O₃/NO₂/SO₂ wherever the EEA network has them
  (requires `OPENAQ_API_KEY`). The structural answer is the **M2 model
  layers**: the CAMS 0.1° grid carries all EAQI gases everywhere, labelled as
  model forecast, not measurement.
- **QC residual risks** — winter-smog behaviour untested, flag churn at the
  25 µg/m³ frontier, structurally unflaggable isolated sensors, possible
  suppression of genuine hyper-local plumes:
  [plan §5.6](../aerismap-v2-plan.md#56-sensor-qc--graduated-confidence-validated--shipped-2026-07-21)
  and [§10](../aerismap-v2-plan.md#10-deferred--open-items).
- **No NUTS coverage** for RU/BY/AM/MD/GE and subnational UA — dots-only
  there, at every zoom (see [NUTS assignment](#nuts-assignment)).
- **Model-shaped gaps**: between stations there is simply no data until M2 —
  the map deliberately shows nothing rather than interpolating
  (see the [decision log](decisions.md#2026-07-21--nuts-choropleth-instead-of-a-v1-style-idw-raster)).
