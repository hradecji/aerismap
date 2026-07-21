# Decision log

Dated record of the choices that shaped AerisMap v2, one entry each:
context → decision → why → revisit-when. The project went from plan to
production on **2026-07-21**, so most entries carry the same date; where a
git commit anchors the moment, it is named. Deeper technical detail lives in
the [plan](../aerismap-v2-plan.md) and the
[data pipeline doc](data-pipeline.md); deployment mechanics in the
[README](../README.md).

### 2026-07-21 — $0 budget: GitHub Actions ingestion, not a Cloudflare cron

**Context.** Hourly ingestion needs ~15 MB of fetches, multi-MB JSON parsing
and geometry work. A free-plan cron Worker gets 10 ms CPU and 50 subrequests —
unusable; the paid Workers plan would fix that but the project mandate is
$0/month with **no payment card on any account**.

**Decision.** Cloudflare only *serves* (Worker + KV, free plan); all fetching
and normalizing runs in an hourly GitHub Actions job in a **public** repo
(plan §1 D1).

**Why.** Public-repo Actions minutes are unlimited (the hourly ~3-min job
would eat ~2,200 of a private repo's 2,000 free min/month); an Actions runner
has 7 GB RAM and any runtime. Accepted costs: cron jitter and the 60-day
schedule auto-disable ([plan §8.1](../aerismap-v2-plan.md#8-operational-risks-accepted-with-mitigations)).

**Revisit when.** Traffic nears the Worker's 100k req/day, or the ingest job
outgrows its 12-min timeout.

### 2026-07-21 — Workers KV over R2 for artifact storage (commit `3b70207`)

**Context.** The original scaffold used R2. Activating R2 requires putting a
payment card on the Cloudflare account, and Cloudflare offers no hard spend
cap — a billing surface this project deliberately refuses.

**Decision.** Store all artifacts in Workers KV (namespace `DATA`), written
via the KV REST API with sha-256 `StoreMetadata` (KV has no native object
metadata); the Worker serves from the KV binding with in-Worker
conditional-request handling.

**Why.** KV is included in the card-free Free plan and the artifacts are tiny
against its caps: ~0.43 MB gz total vs 25 MiB/value and 1 GB/namespace,
**≈ 73 writes/day** vs 1,000/day (see
[data-pipeline → Artifacts](data-pipeline.md#artifacts)). Over-cap behaviour
is failed requests and a stale-but-visible map — never a bill.

**Revisit when.** The card-free stance changes, or a feature genuinely needs
R2 (LAU PMTiles, self-hosted basemap — see the LAU entry below).

### 2026-07-21 — Next.js static export, no SSR

**Context.** v1 was Vue/Nuxt; the v2 stack was rebuilt from scratch
(plan §1 D3).

**Decision.** Next.js with `output: 'export'` — a plain static site, fully
client-rendered MapLibre, no OpenNext adapter, no Node server.

**Why.** Nothing in a map SPA needs SSR; static assets are served free and
unlimited on the Workers plan (asset requests don't count as Worker
requests). Next is used for DX/TS/routing, not its server.

**Revisit when.** A real SSR need appears — OpenNext-on-Workers exists as the
path, nothing needs redesigning.

### 2026-07-21 — No clustering

**Context.** ~10–14k points at low zoom invite the default answer:
cluster bubbles.

**Decision.** Clustering stays off (plan §6). Low-zoom legibility is solved by
area mode instead.

**Why.** Count-bubbles hide per-station EAQI, which is the whole point of the
map. If clutter ever demands it, the documented fallback is clustering by
`max` EAQI of members — colour by worst member, never by count.

**Revisit when.** A zoom range remains illegible even with the NUTS
choropleth handoff.

### 2026-07-21 — NUTS choropleth instead of a v1-style IDW raster

**Context.** Low zoom must read as a picture, not 10k overlapping dots. The
v1-style answer was an interpolated (IDW) raster surface over the stations.

**Decision.** Aggregate stations into Eurostat NUTS-2/NUTS-3 regions
(median → band → worst pollutant), rendered as a choropleth with a ~z5.5
level handoff and an auto crossfade into dots. Boundaries are vendored static
assets; the hourly values are a ~20 KB `areas.json.gz` joined client-side via
MapLibre feature-state
([data-pipeline → NUTS assignment](data-pipeline.md#nuts-assignment)).

**Why.** Interpolation invents values between sparse, unevenly trusted
sensors and cannot express "no data" or confidence. Region medians are
auditable (the popup lists every median and its station count), carry
graduated confidence (opacity, gating), and cost ~20 KB/hour instead of
raster tiles. Honest gap-fill between stations is the M2 CAMS **model** layer,
explicitly labelled as forecast.

**Revisit when.** LAU-level areas ship (see below), or M2 makes a modelled
surface available for comparison.

### 2026-07-21 — Region semantics: median, then band, then worst-of

**Context.** How does a region get one colour from many stations?

**Decision.** Per pollutant: take the **median** across included stations,
band the median with eaqi-2025, and colour the region by the **worst** banded
pollutant (plan §5.5).

**Why.** The median is robust to outliers and coarsened coordinates — a mean
would let one railed sensor drag any region, not just two-station ones;
banding *after* aggregation keeps the region value physically meaningful;
worst-of mirrors EAQI's own worst-pollutant semantics, so a region band reads
the same way a station band does. The residual two-station weakness (the
median of a pair is its midpoint) was closed the same day by QC and the
min-of-two rule.

**Revisit when.** Large regions mask real intra-region variation — hotspot
rings are the current counterweight.

### 2026-07-21 — Ratio-to-median QC rule over band-distance and robust-z

**Context.** Railed SDS011 sensors stuck at ~1000 µg/m³ painted DE403, ITH2
and ITH20 "Extremely poor" through two-station medians. A quality gate was
needed the same day.

**Decision.** Flag a PM reading > **4×** the 50 km neighbourhood median with
**≥ 3 neighbours** and > **25 µg/m³** (`QC_RULE`; the rule and its full
validation story:
[data-pipeline → Spatial QC](data-pipeline.md#spatial-qc--the-ratio-rule)).

**Why.** Three candidates were implemented twice each, independently, and
reconciled by a judge. Band-distance was disqualified empirically — co-broken
sensor clusters mutually corroborate, catching only 24/111 railed sensors.
Robust-z tied the ratio rule's numbers (109/111 pm2_5, 4/4 pm10) but the
ratio rule is simpler to audit: four constants and a median, checkable by
hand.

**Revisit when.** The first sustained winter-smog episode (re-run the
two-implementation + judge evaluation before touching the constants), or if
the ~10–14% flag churn at the 25 µg/m³ frontier becomes user-visible
(hysteresis is scoped in [plan §10](../aerismap-v2-plan.md#10-deferred--open-items)).

### 2026-07-21 — Graduated region gating replaces the ≥3-station cliff (commit `542954b`)

**Context.** The original honesty gate (`AREA_MIN_STATIONS = 3`) left large
rural areas permanently blank while QC now handled the *wrong-data* problem
the cliff was overcompensating for.

**Decision.** `regionBandAllowed`: any count ≥ 2 may colour a region; a
single station only for bands ≤ 3 — **one sensor may say "fine", never
"emergency"**. With exactly two stations the band comes from the min of the
pair. Opacity still encodes confidence (full at 3 stations).

**Why.** Sparse honest data deserves a faint colour, not a blank; the
severe-band risk is carried by corroboration requirements, not by hiding
data. Lit ~385 previously blank regions.

**Revisit when.** Single-station low-band colouring proves misleading in
practice, or per-pollutant client-side banding (which can't apply min-of-two)
causes user confusion.

### 2026-07-21 — Hotspot contrast rule and view scoping (commits `b46a41f`, `0ba8994`)

**Context.** Corroborated band ≥ 4 stations render as ring markers so real
epicenters survive the choropleth. First implementation showed rings
unconditionally — atop an already-red region a ring is noise.

**Decision.** Ingest stamps each hotspot with its region bands
(`regionBands {n2, n3}`); the client shows a ring only where the station band
**exceeds** the displayed region band (per the z5.5 NUTS split; uncoloured
regions always show rings), and only in the **Air Quality view**.

**Why.** A ring should mean "worse than its surroundings", not repeat the
fill. The ring's colour encoding is the EAQI band, which is meaningless in
temperature/humidity/per-pollutant views — so the rings (and their legend
line) are scoped to the EAQI view.

**Revisit when.** Users need epicentre markers inside per-pollutant views —
that would need a per-pollutant contrast computation, not a re-scope.

### 2026-07-21 — EAQI as the one integrated index (no custom composite)

**Context.** With PM, gases, temperature and humidity on one map, the
tempting move is a home-made "air score" blending them.

**Decision.** The European Air Quality Index — the verified **eaqi-2025**
band tables carried over from v1's contract — is the only integrated index.
Everything else is shown as what it is: raw per-pollutant values, temperature,
humidity.

**Why.** Credibility. EAQI values are comparable against the EEA's own maps
and press reporting; a custom composite would be unverifiable and would put
the project's judgement where an institution's belongs. One consequence
honestly disclosed rather than papered over: PM-only regions say so in the
popup ([data-pipeline → Known blind spots](data-pipeline.md#known-blind-spots)).

**Revisit when.** The EEA revises the index — the band tables live in one
shared module (`packages/shared/src/eaqi.ts`).

### 2026-07-21 — LAU/municipality areas deferred to the custom-domain milestone

**Context.** NUTS-3 is the finest area level shipped; municipal (LAU)
resolution was evaluated.

**Decision.** Deferred (plan §5.5, §10). ~98k polygons are far beyond inline
GeoJSON: measured **48.5 MB of PMTiles at z4–z10**, which needs R2 (payment
card — see the KV-over-R2 entry) and only pays off once a custom domain
enables edge caching (workers.dev has no functional Cache API).

**Why.** Every prerequisite is a separate rejected cost today; the NUTS
handoff already reads well at the zooms where LAU would matter.

**Revisit when.** A custom domain lands *and* the card-free stance changes —
both, not either.

### 2026-07-21 — GPL `.om`-reader question gates M2 (open)

**Context.** M2's model layers decode Open-Meteo `.om` grid files. The
official readers (`@openmeteo/file-reader`, and the Python reader) are
**GPL-2.0-only**; this repo's code licence is still TBD.

**Decision.** Deferred to M2 kickoff (plan §7): either licence `ingest/` (or
the repo) GPL-compatible, isolate the decode step, or write a minimal `.om`
range-reader in-house. No M2 code lands before this is settled.

**Why.** Running GPL code server-side in Actions is fine; *vendoring it into
a public repo* makes GPL compatibility a repo-licence question — cheaper to
decide before the first `.om` import than to unwind after.

**Revisit when.** M2 kickoff — this entry should then be replaced by the
outcome.
