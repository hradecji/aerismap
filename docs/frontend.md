# Frontend

The web app (`apps/web/`) is a Next.js static export (`output: 'export'`) —
no SSR, no server runtime. It is served as static assets by the Worker; the
only dynamic surface is the [HTTP API](api.md) it fetches at runtime. MapLibre
GL JS v5.x (pinned; v6 has breaking changes in flight) renders everything on
an [OpenFreeMap](https://openfreemap.org/) `positron` basemap.

Related docs: [data-pipeline.md](data-pipeline.md) (where the data comes
from), [api.md](api.md) (what the app fetches), [operations.md](operations.md)
(local dev + deployment).

## View system

Views live in `src/lib/views.ts`; the switcher (`components/ViewSwitcher.tsx`)
renders **Air Quality [EAQI] | Temperature | More ▾** at every width — the
hierarchy is deliberate: EAQI *is* the integrated index (worst of the five
pollutant sub-indices), so the five pollutant views and Humidity are detail
views under **More** (popover on desktop, bottom-sheet card below 640 px).

- **Air Quality (`eaqi`)** — default. Stations and regions colored by the
  shared `eaqi-2025` band tables (`packages/shared/src/eaqi.ts`), verbatim EEA
  colors.
- **Pollutant views** (`pm2_5`, `pm10`, `no2`, `o3`, `so2`) — same band
  colors keyed to that pollutant alone. Region fills band the *published
  median* client-side and apply the shared `regionBandAllowed` gate (cnt ≥ 2,
  or a single station for bands ≤ 3). Note a documented divergence: the
  min-of-two banding rule protects only the overall Air Quality band (it is
  applied at ingest); per-pollutant views band the median directly.
- **Temperature / Humidity** — continuous ramps (diverging blue–red anchored
  at 0 °C; sequential blue), stations and region medians.

## Area mode (choropleth)

Boundary polygons are immutable static assets (`public/boundaries/nuts2.geojson`,
`nuts3.geojson`; see [data-pipeline.md](data-pipeline.md) for the UK/Bosnia
splices) loaded lazily as two GeoJSON sources with `promoteId: 'NUTS_ID'`.
Hourly per-region values arrive via `/api/v1/areas` and are joined with
`map.setFeatureState` onto **both** sources (`src/lib/areas.ts`); feature
state is wiped by style reloads and reapplied via a style-epoch counter.

- **Level handoff**: NUTS-2 fills below zoom 5.5 (`NUTS_SPLIT_ZOOM`), NUTS-3
  above.
- **Crossfade**: fills fade out and station circles fade in across zoom
  6.5 → 8 (`AREA_CROSSFADE_START/END`) — continent view is pure choropleth,
  city view pure dots. The Regions control offers `Auto` (default) and
  `Points only`.
- **Confidence encoding**: fill opacity interpolates on station count
  (n=1 → 0.30, n=2 → 0.40, 3 → 0.45, 10+ → 0.85), multiplied by the
  crossfade. No-data regions render `NO_DATA_FILL` gray, deliberately
  desaturated versus every band color (pinned by tests).
- Fills insert below the basemap's first symbol layer so labels stay on top;
  borders and hover emphasis are separate line layers (`fill-outline` is
  capped at 1 px by MapLibre).

## Hotspot rings

Stations promoted by ingest (`properties.hotspot`, see
[data-pipeline.md](data-pipeline.md)) render as ◉ ring markers (band-colored
disc + white core, `src/lib/hotspots.ts`) at every zoom — but only where they
carry information:

- **Contrast rule** (2026-07-21): a ring shows only when the station band
  *exceeds* the region color displayed under it — `_rb2`/`_rb3` (flattened
  from `properties.regionBands`) compared per displayed NUTS level via
  zoom-split layer pairs. Stations in uncolored regions always show.
- **View scoping**: rings (and their legend line) exist only in the Air
  Quality view — their color encoding is EAQI.
- Clicks on rings win over region clicks and open the standard station popup.

## Popups and data-quality surfaces

- **Station popup** (`components/StationPopup.tsx`): per-param values with
  relative timestamps, EAQI badge with driving pollutant, licence line, and
  notices: stale, approximate location, humidity-bias, and QC-flagged
  readings ("Implausible vs nearby sensors (>4× neighbourhood median)…").
  Popups render synchronously (`flushSync`) before MapLibre measures them so
  auto-anchoring can flip them inside the viewport.
- **Region popup** (`components/AreaPopup.tsx`): band badge or the honest
  refusals ("Not enough stations", "no pollutant measured by ≥2 stations"),
  station split (official/community), median table with per-param counts,
  confidence wording for 1–2-station regions, and the **PM-only disclosure**
  when no gas pollutant has coverage (see the ozone blind spot in
  [data-pipeline.md](data-pipeline.md)).
- **Legend** (`components/Legend.tsx`): collapsible — a slim band strip when
  collapsed (default below 640 px). The expanded EAQI legend carries the
  integrated-index explainer ("Worst of PM2.5 · PM10 · NO₂ · O₃ · SO₂
  decides") and the confidence note. The verbatim
  `© EuroGeographics for the administrative boundaries` notice is a licence
  obligation and stays visible whenever fills render — as a caption even in
  the collapsed state.

## Mobile adaptivity

Breakpoint 640 px (`src/lib/useMediaQuery.ts`, kept in sync with the
`@media` block in `globals.css` — comments on both sides). Below it: legend
collapses to the strip, the layers panel hides behind a 44×44 icon button
opening as an overlay (scrim/✕/Escape), the More menu becomes a bottom
sheet, and all touch targets are ≥ 44 px. Nothing is persisted; defaults
reassert when the breakpoint is crossed.

## Data loading

`src/lib/snapshot.ts` fetches stations + meta (gzip transparent), flattens
nested values into expression-friendly top-level props (`_b_<pollutant>`
bands, `_temperature`, `_humidity`, `_rb2`/`_rb3`), validates meta
defensively (malformed → shared `ATTRIBUTIONS` fallback), derives clock skew
from the response `Date` header for the >2 h freshness banner, and re-polls
every 3 minutes while in the "no data yet" state. A top-level error boundary
keeps the header/map shell rendered on unexpected failures. Area and
boundary fetches never block station rendering; a 404 on `/api/v1/areas`
degrades to points-only with a note in the layers panel.

## Tests

`pnpm --filter @aerismap/web test` — `node:test` + `tsx`, zero extra deps
(`src/lib/*.test.ts`): paint/filter expression structure, gating truth
tables, legend-strip and view-menu grouping, snapshot parsing. Anything
DOM/MapLibre-runtime is covered by the Playwright passes run at integration
time, not unit tests.
