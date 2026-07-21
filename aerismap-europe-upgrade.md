# AerisMap — Europe-wide Upgrade: Project Brief & Data-Source Reference

*Working document · air quality + temperature correlation map · no implementation yet — sources, structure, and design decisions.*

---

## 1. Summary

**What exists (v1):** an open-source air-quality map for Central Europe (reference: https://aeris-map.vercel.app/) combining community low-cost sensors and official reference stations on one map, scored with the European Air Quality Index (EAQI). It currently shows on the order of a few hundred points, which is essentially the official reference network plus a partial community feed.

**The upgrade (v2), three goals:**
1. **Extend coverage from Central Europe to the whole of Europe.**
2. **Increase point density** well beyond the ~500 official probes by leaning harder on community sensor networks.
3. **Add a temperature layer** as a second map layer, to explore whether temperature and air quality correlate.

**Key realisation up front:** most of the recommended data sources are already Europe-wide or global, so "whole Europe" is largely a matter of *dropping the country-specific portals and using the pan-European aggregate feeds*, not finding new data. Density is a separate axis, solved by adding citizen-science networks. Temperature is a third axis, best sourced from the same provider family already used for air quality so coordinates and timestamps line up.

---

## 2. Architecture concept (the layered data model)

Think of it as four stacked sources, from most-trusted/sparse to least-trusted/dense, plus a meteorology layer:

| Layer | Role | Density | Trust |
|---|---|---|---|
| Official reference stations (EEA / national) | Ground truth, regulatory-grade | Sparse (~hundreds EU-wide) | High |
| Community sensors (Sensor.Community, openSenseMap, Airly) | Spatial detail / hyperlocal | High (thousands) | Low–medium, needs correction |
| Gridded model (CAMS) | Continuous fill where no sensors exist | Every 0.1° cell | Modelled, not measured |
| Aggregator (OpenAQ) | One harmonised API over official networks | Follows official | High |
| **Meteorology (temperature)** | Second map layer + correlation input | Model grid or stations | High |

Recommended recipe: **reference stations as anchors → community sensors for spatial detail → CAMS to fill gaps → temperature layer alongside.** This is the standard hybrid pattern for a hyperlocal map.

**Freshness / ingestion note:** none of these push updates. Air-quality data is pull-based, so the backend polls on a schedule. An hourly cron matches how most sources refresh (official stations and CAMS/Open-Meteo are hourly; CAMS forecast reruns roughly daily). "As released" means "poll hourly."

---

## 3. Air-quality data sources

### 3.1 Primary — one API, all of Europe

**Open-Meteo Air Quality API** — easiest starting point. Free for non-commercial use, open-source, JSON, no key for normal use. Pass coordinates, get hourly values. European data is the 11 km CAMS European model; outside Europe it falls back to the 45 km CAMS global model.
- Docs: https://open-meteo.com/en/docs/air-quality-api
- Endpoint: `https://air-quality-api.open-meteo.com/v1/air-quality`
- Coverage: global (Europe at 11 km). Up to 7-day forecast, plus past days.
- Attribution required: CAMS ENSEMBLE data provider **and** Open-Meteo.

**OpenAQ** — the world's largest open-source, open-access platform for ground-level ambient air quality data; harmonises official station measurements into one REST/JSON API. Gives raw physical measurements (µg/m³), not aggregated index values. Free API key required. Global.
- Docs: https://docs.openaq.org/
- Org / code: https://github.com/openaq
- Note: data is public, but you are responsible for complying with each underlying source's third-party terms.

### 3.2 High-resolution gridded model (authoritative, uniform)

**CAMS European air quality forecasts** (Copernicus Atmosphere Data Store). European domain at 0.1° (~10–11 km), hourly, from an ensemble of eleven European forecasting systems, 4-day forecast plus analysis. GRIB or NetCDF via the `cdsapi` Python client. This is the gridded backbone if you want a value at every cell / to interpolate yourself.
- Dataset: https://ads.atmosphere.copernicus.eu/datasets/cams-europe-air-quality-forecasts
- Reanalysis (2013 onwards, same grid): https://ads.atmosphere.copernicus.eu/datasets/cams-europe-air-quality-reanalyses
- Domain: 25°W–45°E, 30°N–72°N. Open licence, attribution required.
- Docs: https://confluence.ecmwf.int/display/CKB/CAMS+Regional:+European+air+quality+analysis+and+forecast+data+documentation

### 3.3 Pan-European official (regulatory backbone)

**EEA up-to-date air quality data + Air Quality Download Service** — the source all European countries report into (near-real-time flow E1a, validated flow E2a). Use this instead of the individual national portals for whole-Europe coverage.
- Portal: https://www.eea.europa.eu/en/analysis/maps-and-charts/up-to-date-air-quality-data
- Open-source R wrapper (reference implementation of the request pattern): https://github.com/openair-project/euroaq

### 3.4 National portals (only if you want a country's native feed)

For a Europe-wide map these are largely superseded by EEA/OpenAQ, but kept here for reference:
- **Czechia — ČHMÚ:** https://opendata.chmi.cz (live `air_quality/now` tree). Hourly operational (unverified) AQI. Licence **CC-BY 4.0**. ArcGIS hub: https://open-data-chmi.hub.arcgis.com/
- **Austria — Umweltbundesamt:** OGC SensorThings API (INSPIRE) at http://datacove.eu/ad-hoc-air-quality/oesterreichische-luftguete/ ; reverse-engineered OpenAPI of the Luftdaten frontend at https://luftqualitaet.api.bund.dev/ (repo https://github.com/bundesAPI/luftqualitaet-api). Hourly. Open-data landing: https://www.umweltbundesamt.at/umweltinformation/opendata
- **Slovakia — SHMÚ:** hourly values published at https://www.shmu.sk/sk/?page=1799 but **no documented open REST API** — rely on OpenAQ/EEA for Slovakia rather than scraping.

### 3.5 Density boosters — community / citizen-science networks

This is what takes you from hundreds of points into the thousands, across all of Europe.

**Sensor.Community** (formerly luftdaten.info) — the big one. Thousands of DIY stations, dense across Europe. Fully open data, plain GET JSON API, **no credentials**.
- API docs: https://github.com/opendata-stuttgart/meta/wiki/EN-APIs
- Live map (eyeball coverage): https://maps.sensor.community/
- Data typically ODbL-style open data — verify current licence terms.

**openSenseMap** — open-source, open-data platform with a documented REST API; overlaps partly with Sensor.Community but adds its own registered boxes.
- Site: https://opensensemap.org
- API docs: https://docs.opensensemap.org

**Airly** — dense low-cost **commercial** network, strong through Central/Eastern Europe. RESTful API (PM1/PM2.5/PM10 + some gases + weather). Free tier ~100 calls/day, paid above. Better calibrated than raw DIY, but not fully open.
- Developer docs: https://developer.airly.org/en/docs

---

## 4. Temperature / meteorology data sources

Prefer sourcing temperature from the **same provider family** as the air quality so grids/timestamps align without reprojection.

**Open-Meteo Weather Forecast API** — same provider and query style as the AQ endpoint; global, hourly, free; just add `temperature_2m` (and humidity, wind, etc.). Its national weather models include **GeoSphere Austria**, DWD, Météo-France, ECMWF and others.
- Docs: https://open-meteo.com/en/docs
- Endpoint: `https://api.open-meteo.com/v1/forecast`
- Historical arm (ERA5-backed, i.e. a friendly wrapper over the reanalysis below): https://open-meteo.com/en/docs/historical-weather-api

**ERA5-Land / ERA5 reanalysis** (Copernicus Climate Data Store) — the gridded gold standard and the natural partner to CAMS (same Copernicus ecosystem, same `cdsapi` tooling).
- ERA5-Land: hourly, **0.1°** (~9–11 km), 1950–present, ~5 days behind real time. https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land
- ERA5 (single levels): hourly, **0.25°** (~31 km), 1940–present. https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels
- **Current API endpoint:** `https://cds.climate.copernicus.eu/api` (the store migrated — do not use the old legacy CDS URL).
- Licence: C3S / Copernicus, attribution required.

**Meteostat** — station-based weather if you'd rather pair station temperature with station AQ; open data, JSON API + Python library, good historical depth.
- Docs: https://dev.meteostat.net

**Free co-located bonus:** Sensor.Community DIY boxes usually carry a BME280 (or similar), so many report **temperature + humidity at the exact same point** as their PM reading. If you already ingest that network, you get co-located temperature at zero extra cost — the ideal input for correlation (no spatial/temporal mismatch). It also gives you the humidity needed to de-bias the PM sensors (see §6).

---

## 5. Field / variable reference (what to query)

### 5.1 Open-Meteo Air Quality API — `hourly=` values (units µg/m³ unless noted)

- **Particulates:** `pm10`, `pm2_5`, `dust` (Saharan), `aerosol_optical_depth` (dimensionless, haze)
- **Gases:** `carbon_monoxide`, `nitrogen_dioxide`, `sulphur_dioxide`, `ozone`, `ammonia` (Europe only), `nitrogen_monoxide`, `carbon_dioxide` (ppm), `methane`
- **Indices:** `european_aqi`, `european_aqi_pm2_5`, `european_aqi_pm10`, `european_aqi_nitrogen_dioxide`, `european_aqi_ozone`, `european_aqi_sulphur_dioxide` (consolidated `european_aqi` = max of the individual indices; 0–20 good … >100 extremely poor). US equivalents: `us_aqi*`.
- **Other:** `uv_index`, `uv_index_clear_sky`, European pollens (`birch_pollen`, `grass_pollen`, `ragweed_pollen`, etc., Europe only, in season)
- Useful params: `domains=auto|cams_europe|cams_global`, `past_days`, `forecast_days` (≤7), `timezone=auto`, multi-coordinate via comma-separated `latitude`/`longitude`.

### 5.2 Open-Meteo Weather Forecast API — `hourly=` values

- **Temperature:** `temperature_2m` (°C), `apparent_temperature`, `dew_point_2m`
- **Humidity:** `relative_humidity_2m` (%) — **needed to correct community PM readings**
- **Wind (dispersion):** `wind_speed_10m`, `wind_direction_10m`, `wind_gusts_10m`
- **Other drivers:** `surface_pressure`, `precipitation`, `cloud_cover`, `shortwave_radiation` (proxy for photochemistry / ozone)

### 5.3 ERA5 / ERA5-Land (CDS variable names)

- `2m_temperature`, `2m_dewpoint_temperature`, `10m_u_component_of_wind`, `10m_v_component_of_wind`, `surface_pressure`, `total_precipitation`
- **`boundary_layer_height`** (ERA5 single-levels) — the variable that actually governs how much pollution is trapped near the surface; not exposed by Open-Meteo's standard forecast API, so pull it from ERA5 if you want it.

### 5.4 Recommended pairings per pollutant (for the correlation study)

| Pollutant | Pair primarily with | Why |
|---|---|---|
| PM2.5 / PM10 | temperature, **humidity**, boundary-layer height, wind speed | Winter inversions + heating; humidity confounds low-cost sensors |
| Ozone (O3) | temperature, **shortwave radiation**, wind | Photochemically produced — hot, sunny, stagnant days |
| NO2 | wind speed, boundary-layer height | Traffic source; dispersion-limited more than temperature-driven |

---

## 6. Density strategy & data-quality caveats

Denser ≠ more accurate. The community layer buys spatial detail at the cost of calibration:

- **Uncalibrated optical PM sensors** (typically SDS011) sit behind Sensor.Community. They read PM only — **no NO2/O3/SO2** from the DIY units.
- **Humidity bias:** these sensors over-read in damp air. This matters directly for the correlation study (see §7).
- **Mitigation:** flag every point by source class (reference / community / model); apply a humidity correction to community PM; cross-check against the nearest reference station; consider down-weighting community points when computing any blended field.
- Why v1 caps near 500: that's the official network — regulatory stations cost roughly €5–30k each plus annual upkeep, so the count is inherently small and won't grow. All additional density must come from the community layer.

---

## 7. Correlation layer — design notes (read before building)

A naïve "overlay temperature, compute one correlation" will mislead. Three specific traps:

1. **The relationship flips sign by pollutant and season**, so a single global correlation number is close to meaningless.
   - **PM** ↔ temperature is typically **negative** in winter: cold triggers heating emissions, and cold stable air forms temperature inversions that cap the boundary layer and trap particulates (the classic Ostrava / Silesia winter-smog pattern).
   - **Ozone** ↔ temperature is **positive** in summer: it's photochemically produced, so hot sunny days push O3 up.
   - Lumping pollutants together makes these cancel → a false "no correlation." **Split by pollutant, and by season.**

2. **Humidity confound (source-specific).** Low-cost PM sensors over-read in humid air, and humidity correlates with temperature — so you can manufacture a PM–temperature correlation that is really a sensor artefact riding on humidity. Since you can pull temperature *and* humidity from the same Sensor.Community boxes, you have what's needed to control for it — but you must actually do it (partial correlation holding humidity fixed, or humidity-correct the PM first).

3. **Confounding by the synoptic situation.** Temperature usually isn't *causing* air quality; both are downstream of the same weather pattern (a stagnant high → cold nights, calm winds, trapped pollution). Even a clean correlation is more "shared driver" than "temperature causes pollution." To get closer to a mechanism, **boundary-layer height and wind speed** are the variables that actually move concentrations. Frame the temperature layer as "here's how they move together," not "here's the cause."

**UX for the correlation view:**
- Simple version: a toggle between an EAQI/PM layer and a temperature layer over the same base map.
- Better version: correlation is genuinely hard to read from two overlaid colour fields. Prefer a **bivariate / two-variable choropleth**, or a **scatter of AQI vs temperature per station, coloured by season**, or a difference view — rather than two heatmaps the user eyeballs back and forth.

---

## 8. Licensing & attribution obligations

Because this is a public, open-source map, attribution matters. Summary (verify current terms per source):

- **CAMS / Copernicus (AQ + ERA5):** attribution required — credit the Copernicus Atmosphere / Climate Change Service and CAMS ENSEMBLE data providers.
- **Open-Meteo:** must attribute both CAMS ENSEMBLE **and** Open-Meteo; free tier is non-commercial.
- **EEA:** reusable European AQ data; follow EEA reuse terms.
- **ČHMÚ:** CC-BY 4.0.
- **OpenAQ:** data public, but you must comply with each underlying source's third-party terms.
- **Sensor.Community / openSenseMap:** open data (ODbL-style, attribution/share-alike typical) — confirm.
- **Airly:** commercial terms; free tier limited (~100 calls/day).

---

## 9. Open questions / next steps

- Confirm live sensor counts for target countries on Sensor.Community to quantify the density gain over v1.
- Decide the blend policy: show layers separately, or compute a single bias-corrected field? (Affects how heavily community data is trusted.)
- Choose the correlation deliverable: live interactive layer vs offline analysis notebook first.
- Decide historical depth: live-only, or backfill via ERA5 (temperature) + CAMS reanalysis / EEA validated data (AQ) for seasonal correlation?
- Verify each source's rate limits before settling the polling schedule.
- Confirm whether boundary-layer height / wind are worth ingesting now or later (they materially improve the "why" behind any correlation).

---

*Sources compiled from official documentation as of July 2026. Endpoints and licences can change — re-verify before implementation.*
