# Operations runbook

How to run, watch, debug, and recover AerisMap v2 in production
(https://aerismap.jiri-hradec-jr.workers.dev). For what the system *is*, see
the [README](../README.md); for how a reading becomes a published artifact,
see [data-pipeline.md](data-pipeline.md); for the web app's rendering rules,
see [frontend.md](frontend.md); for the decision history, see the
[plan](../aerismap-v2-plan.md). All measured numbers below are from
2026-07-21 (launch day) unless dated otherwise.

## The two workflows

### Ingest — `.github/workflows/ingest.yml`

- **Schedule:** `cron: '7 * * * *'` — minute 7, hourly. The offset minute is
  deliberate: top-of-hour crons queue behind scheduler congestion. Even so,
  expect the actual start to slip by minutes (occasionally tens of minutes)
  at busy hours; this is GitHub jitter, not a fault.
- Also runs on `workflow_dispatch` (Actions → Ingest → Run workflow).
- **Concurrency:** group `ingest`, `cancel-in-progress: false` — runs are
  serialized, never parallel. This is part of the KV write-cap defence: a
  pile-up of delayed runs drains one at a time instead of writing
  concurrently.
- **Timeout:** 12 minutes per job (normal wall-clock is ~2–3 min).
- Steps: checkout → pnpm (version read from the root `packageManager` field)
  → Node 24 → `pnpm install --frozen-lockfile` → **secrets assertion** →
  `pnpm --filter @aerismap/ingest ingest`.

### Deploy — `.github/workflows/deploy.yml`

- Runs on every push to `main` and on `workflow_dispatch`.
- **Concurrency:** group `deploy`, `cancel-in-progress: true` — a newer push
  cancels an in-flight deploy.
- Steps: `pnpm typecheck` → `pnpm test` → `pnpm --filter @aerismap/web build`
  → `cloudflare/wrangler-action` running `deploy` in `worker/`.
- Both workflows pin their actions by commit SHA and use Node 24.

### Secrets

Set under the GitHub repo → Settings → Secrets and variables → Actions.

| Secret | Used by | Where it comes from | Scope / notes |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | **both** workflows | Cloudflare dashboard → My Profile → API Tokens → Create Custom Token | Needs **Account → Workers Scripts → Edit** (deploy) **and** **Account → Workers KV Storage → Edit** (ingest). One token serves both. KV *Edit implies read* — the ingest run also **reads** KV, for carry-forward of a failed source and for the OpenAQ registry cache, so a write-only scheme would not work |
| `CLOUDFLARE_ACCOUNT_ID` | both workflows | Cloudflare dashboard (Workers overview, right sidebar) | Not sensitive, kept as a secret for convenience |
| `CLOUDFLARE_KV_NAMESPACE_ID` | ingest only | `wrangler kv namespace create DATA` output, or dashboard | This deployment: `20dedaab5bfb468c900b4346669eb41e` — must match the `kv_namespaces` id in `worker/wrangler.jsonc` |
| `OPENAQ_API_KEY` | ingest only, **optional** | Free registration at https://explore.openaq.org/register | When missing, the official/reference layer is deliberately skipped without a warning annotation; `meta.sources` records `ok: false, detail: "OPENAQ_API_KEY not set; official layer skipped"` |

The same variables drive local runs — see
[`ingest/.env.example`](../ingest/.env.example).

## Reading a failed or degraded ingest run

Failures degrade in a specific ladder. From hard to soft:

1. **Missing KV secrets.** The workflow's "Assert KV secrets are configured"
   step fails first, with
   `::error::Repository secret <NAME> is missing or empty — the ingest job
   cannot upload to Workers KV. See README → Deployment step 4.`
   Defence in depth: even if that step were removed, the entrypoint itself
   exits 1 in CI (`GITHUB_ACTIONS is set but Cloudflare KV is not
   configured…`) — because a run without credentials would otherwise go
   green while uploading nothing.

2. **Every source failed.** Log line
   `[ingest] every source failed — not publishing artifacts`, exit 1. Nothing
   is written; the Worker keeps serving the previous artifacts, and the map's
   freshness banner appears once `meta.generatedAt` is over 2 h old.

3. **One source failed, the run still publishes.** A configured-but-failed
   source emits a GitHub annotation:
   `::warning::ingest source <id> failed: <detail>`. (A missing
   `OPENAQ_API_KEY` is a quiet skip, not a warning.) Two things to know:

   - **Plausibility floors can fail a "successful" fetch.** A source that
     returns HTTP 200 but implausibly few stations is treated as failed:
     Sensor.Community below **500** stations (normal ≈ 9.5k), OpenAQ below
     **100** (registry ≈ 4k+ locations; ≈ 2.5k report within the 6 h freshness window on a typical run). The detail reads
     `implausibly low yield: N stations < floor …— not publishing this
     source`. This is the tripwire for upstream format drift.
   - **Carry-forward.** The failed source's stations are copied from the
     previously *published* snapshot into the new one: staleness is
     recomputed against the current time (so they fade honestly), readings
     and EAQI are untouched, and spatial QC re-runs from scratch over the
     merged set. `meta.sources[]` gains `carriedForward: N` and the detail is
     amended with `; carried forward N stations from previous snapshot`.
     **On the map** this means the source's stations do not vanish — they go
     grey as they age past their freshness horizon (community 45 min,
     reference 3 h — `MAX_AGE_SEC` in `packages/shared/src/contracts.ts`),
     and as they do they drop out of station EAQI colouring and region
     medians. One missed OpenAQ hour is invisible; a day-long outage leaves
     ~4k grey reference dots.

4. **Area aggregation failed independently.** Boundary load or aggregation
   errors degrade to a `::warning` and **no areas artifact this run** — the
   previous `latest/areas.json.gz` stays published while stations and meta
   still update. Symptom: the areas payload's `generatedAt` lags
   `meta.generatedAt`.

Publish order is stations → areas → `meta.json` **last**, so a reader never
sees a torn snapshot: meta is the pointer that a complete set exists.

## GitHub's 60-day schedule auto-disable

GitHub disables `schedule:` triggers after **60 days without repository
activity**. Symptom: the map shows the freshness banner, the Actions tab
shows no recent Ingest runs, and the workflow page shows an "Enable workflow"
button — click it (Actions → Ingest → Enable workflow). **Any commit resets
the 60-day clock**, so a repo under even light development never hits this.
Keep the repo public: Actions minutes are unlimited for public repos, and the
hourly job would exhaust a private repo's free tier (plan §3).

## KV free-plan caps vs actual usage

Limits per [Cloudflare's KV docs](https://developers.cloudflare.com/kv/platform/limits/);
usage measured 2026-07-21:

| Cap (Workers Free) | Limit | Actual usage |
|---|---|---|
| Writes/day | 1,000 | **~73/day**: 3 keys/run (`latest/stations.geojson.gz`, `latest/areas.json.gz`, `latest/meta.json`) × 24 runs + ~1/day for `internal/openaq-registry.json` (24 h TTL). Grows to ~120/day when the two M2 layer keys ship |
| Reads/day | 100,000 | One KV read per API hit; aligned with the Worker's own 100k req/day cap |
| Storage/namespace | 1 GB | ~0.43 MB community-only / ~0.54 MB keyed (2026-07-21: stations 409→505 KB gz, areas 21→33 KB gz, meta ~1.5 KB) |
| Value size | 25 MiB | Largest value ~505 KB (keyed run) |

**Over-cap behaviour:** further operations of that type fail for the rest of
the UTC day. Over-cap *writes* mean the ingest upload fails (the run goes
red) while the Worker keeps serving the last stored artifacts —
stale-but-visible, surfaced by the freshness banner. There is never a
surprise bill: the account has no payment card and no billing surface. The
realistic way to approach the write cap is manual re-running (each manual run
costs 3–4 writes; the budget tolerates hundreds) or a retry loop — which is
why ingest's KV client caps at 2 retries and the workflow serializes runs.

## Rotating credentials

### Cloudflare API token

One custom token serves **both** workflows. To rotate:

1. Cloudflare dashboard → My Profile → API Tokens → Create Custom Token with
   **Account → Workers Scripts → Edit** and **Account → Workers KV Storage →
   Edit**.
2. Replace the `CLOUDFLARE_API_TOKEN` repo secret with the new value.
3. Verify: manually dispatch **Ingest** (proves KV write + read) and
   **Deploy** (proves Workers Scripts edit); both must go green.
4. Revoke the old token in the dashboard.

A revoked/expired token shows up as the ingest KV upload failing with
`KV PUT latest/... failed: HTTP 403` (the Cloudflare error envelope is
included in the message) and the deploy step failing authentication.

### OpenAQ API key

Generate a new key at https://explore.openaq.org/register and replace the
`OPENAQ_API_KEY` secret. A dead key fails the OpenAQ source with an HTTP
401/403 (non-retryable — only 429 and 5xx are retried); the run continues
community-only with carry-forward, and `meta.sources` shows the failure. No
other system holds this key.

## Local development

The canonical five-command sequence (install → ingest → seed → build →
`wrangler dev`) is in the [README → Local development](../README.md#local-development),
and the mock-API frontend flow is in [apps/web/README.md](../apps/web/README.md).
Operational fine print that is easy to trip over:

- **Where artifacts go.** With no Cloudflare env vars set, ingest writes to
  `ingest/.artifacts/` mirroring the KV key layout. With KV configured it
  uploads and writes **nothing** locally — pass `--out <dir>` to also keep a
  local copy. A `.env` file can be loaded with
  `pnpm --filter @aerismap/ingest exec tsx --env-file=.env src/run.ts`.
- **`seed:local` caveats.** It seeds only the artifact files that exist under
  `ingest/.artifacts/latest/` (so a community-only local run seeds three
  keys, and the M2 keys are skipped until they exist), and it stores values
  **without** `StoreMetadata` — the local Worker therefore serves them with
  no `ETag`/`Content-Length`. That degradation is by design in
  `worker/src/api.ts`; do not chase it as a bug locally.
- **Mock API.** `node apps/web/dev/mock-api.mjs` serves 8 stations and 7
  NUTS-2 regions covering QC-flag, hotspot, stale and no-data states; it
  honours `PORT` (default 8787) and `--stale` (3-h-old meta, to exercise the
  freshness banner). Point the app at it with
  `NEXT_PUBLIC_API_BASE=http://localhost:8787 pnpm --filter @aerismap/web dev`.
- **Checks.** `pnpm typecheck` and `pnpm test` run across all packages —
  the same two gates deploy.yml runs before shipping.

## Re-vendoring the NUTS boundaries

Needed only when a NUTS revision lands (they arrive roughly every three
years; the current set is NUTS-2024 plus the NUTS-2021 UK splice) or GISCO
republishes. The vendored set is **three** artifacts, produced by one script:

- `apps/web/public/boundaries/nuts2.geojson` — browser set, 1:20M, NUTS-2
- `apps/web/public/boundaries/nuts3.geojson` — browser set, 1:20M, NUTS-3
- `ingest/data/nuts3-assign.geojson.gz` — **assignment set**, 1:3M, NUTS-3
  (higher-accuracy borders for station→region point-in-polygon; Bosnia's
  NUTS-2 polygons are spliced into the NUTS-3 layer and this set, because BA
  has no NUTS-3)

Procedure:

1. `pnpm --filter @aerismap/ingest exec tsx scripts/prepare-boundaries.ts`
2. The script asserts pinned feature counts (`EXPECTED` in the script:
   NUTS-2024 level-2 **299**, level-3 **1,345**, NUTS-2021 UK level-2 **41**
   — live-verified 2026-07-21) and **fails loudly on upstream drift**. On a
   genuine new release: verify the new counts against the GISCO release
   notes, update `EXPECTED`, re-run.
3. Update the region-universe test — `ingest/src/areas.test.ts` expects
   `index.totalRegions` to be **1,864** — and run `pnpm test`.
4. Commit the regenerated files (outputs are byte-deterministic, sorted by
   `NUTS_ID`, so an unchanged upstream produces an empty diff) and push —
   deploy.yml ships the new browser sets as static assets.

The notice **"© EuroGeographics for the administrative boundaries"** is a
mandatory condition of the GISCO download agreement and must stay visible in
the app wherever the area layer renders.

## Verifying the live deployment

```sh
BASE=https://aerismap.jiri-hradec-jr.workers.dev

# Snapshot freshness + counts at a glance
curl -s $BASE/api/v1/meta | jq '{generatedAt, counts, sources}'

# 200 with the full header contract (curl -I sends HEAD — the Worker
# supports it even though KV has no HEAD primitive):
# expect ETag, Content-Length, Content-Encoding: gzip,
# Cache-Control: public, max-age=300, Access-Control-Allow-Origin: *
curl -sI --compressed $BASE/api/v1/stations   # --compressed is load-bearing: without an Accept-Encoding: gzip the edge re-encodes and strips ETag/Content-Length/Content-Encoding

# Conditional requests: 304 on a matching If-None-Match…
ET=$(curl -sI --compressed $BASE/api/v1/stations | tr -d '\r' | sed -n 's/^etag: //Ip')
curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: $ET" $BASE/api/v1/stations   # → 304

# …and 412 on a failing If-Match
curl -s -o /dev/null -w '%{http_code}\n' -H 'If-Match: "bogus"' $BASE/api/v1/stations    # → 412

# Method guard: anything but GET/HEAD → 405 with Allow: GET, HEAD
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/api/v1/meta                       # → 405

# M2 routes intentionally 404 (problem+json, "planned (milestone M2)")
curl -s $BASE/api/v1/layers/temperature | jq .                                           # → 404 body
```

Timing note: the Worker reads KV with `cacheTtl` 300 s, so a PoP can serve a
value up to 5 minutes old *after* an ingest write. `generatedAt` lagging by
"hourly cadence + a few minutes of cron jitter + up to 5 min of KV cache" is
normal; anything beyond ~75 minutes means a missed run.

## Monitoring via `/api/v1/meta`

`meta.json` is the primary observability surface. How to read it (schema:
`SnapshotMeta` in `packages/shared/src/contracts.ts`; reference values from
the 2026-07-21 community-only run):

| Field | Normal | What a change means |
|---|---|---|
| `generatedAt` | < 75 min old | > 2 h triggers the frontend stale banner; check Actions → Ingest (failed runs, or the 60-day auto-disable) |
| `counts.stations`, `counts.byKind` | ≈ 9.5k community, plus ≈ 2.5k fresh reference stations when OpenAQ is keyed (12,191 total on the 2026-07-21 keyed launch run) | A sharp drop in one kind → that source failed *and* carry-forward found nothing, or a plausibility floor tripped — read `sources[]` |
| `counts.withEaqi` | ~92% of stations | Collapse with normal station counts → readings arriving without banded pollutants (format drift) |
| `counts.qcFlaggedStations` | ~2.8% of community stations (309 on 2026-07-21) | Large jump → a new railed-sensor batch (expected behaviour); zero → suspect QC stopped running |
| `counts.hotspots` | 0 in clean conditions; 114 during the 2026-07-21 evening ozone episode — episode-driven, not an error signal | Non-zero = corroborated band ≥ 4 stations; a sudden burst is either a real episode or a QC regression — check the dots on the map |
| `counts.areasColored` / `areasTotal` | 1,204 / 1,864 community-only | `areasColored` collapse with normal station counts → area aggregation failed (look for the `::warning`; compare the areas payload's `generatedAt`) |
| `sources[].ok`, `.fetchedAt`, `.stations`, `.detail` | both ok | `detail` carries the failure reason verbatim; `carriedForward: N` means this run is serving N aging stations from the previous snapshot |

Worker-side: `worker/wrangler.jsonc` enables observability with
`head_sampling_rate: 1`, so **every** request appears in the Cloudflare
dashboard under Workers → aerismap → Logs. Unexpected API errors are logged
as structured JSON `{event: "api_error", pathname, error}` before the 500 is
returned — filter on `api_error`.

## Failure modes, honestly

- **Sensor.Community format drift or outage.** History of unannounced
  changes (UA mandate 2022; wiki-documented API). A shape change that
  parses to nothing trips the 500-station floor → source failed →
  carry-forward → community dots fade grey within 45 min. Detection:
  `::warning` annotation + `sources[]`. Fix: adapt
  `ingest/src/sources/sensor-community.ts` to the new shape.
- **OpenAQ rate-limiting or ban.** Requests are paced at 1.1 s (their cap is
  60 req/min) and 429s are retried honouring `Retry-After` (capped at 60 s,
  2 retries); a persistent 429/403 fails the source → carry-forward →
  reference dots fade over 3 h. A key revocation looks identical with a
  401/403 detail.
- **workers.dev 100k requests/day.** Past the cap, `/api/*` (worker-first
  routes) answer 429 with no graceful fallback; static assets keep serving,
  so users see the app shell with the "no data" state. A map session costs
  3–4 API hits → comfortable to ~25k sessions/day. The fix is the planned
  custom domain + edge caching (plan §8.5) — an additive upgrade, not a
  redesign.
- **KV cap exceeded.** See [KV caps](#kv-free-plan-caps-vs-actual-usage):
  writes fail for the rest of the UTC day, the map serves stale, no bill is
  possible.
- **OpenFreeMap outage.** The basemap (donation-funded, no SLA) goes blank;
  the data layers still render on whatever tiles are cached. Documented
  fallback: self-hosted Protomaps PMTiles on R2 (plan §6) — note that
  enabling R2 requires putting a payment card on the account, which the
  project currently refuses (plan §1 D1), so this fallback is a decision,
  not a switch-flip.
- **GitHub Actions incident.** Runs queue or skip; the stale banner appears
  after 2 h; nothing to do but wait or dispatch manually once the incident
  clears.
