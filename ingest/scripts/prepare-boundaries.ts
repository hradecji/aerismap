/**
 * One-shot NUTS boundary preparation — NOT part of the hourly ingest run.
 *
 * Regenerates the vendored boundary artifacts from Eurostat GISCO
 * (EPSG:4326 GeoJSON, NUTS-2024 plus the NUTS-2021 UK splice — NUTS-2024
 * dropped the UK, so its units are taken from the 2021 edition, which has
 * the same schema and licence):
 *
 *   apps/web/public/boundaries/nuts2.geojson   browser set, 1:20M, NUTS-2
 *   apps/web/public/boundaries/nuts3.geojson   browser set, 1:20M, NUTS-3
 *   ingest/data/nuts3-assign.geojson.gz        assignment set, 1:3M, NUTS-3
 *                                              (better border accuracy for
 *                                              station→region point-in-polygon)
 *
 * Feature properties are trimmed to exactly {NUTS_ID, LEVL_CODE, NAME_LATN,
 * CNTR_CODE}; coordinates are passed through untouched. Outputs are
 * commit-ready: deterministic (sorted by NUTS_ID) so re-runs against
 * unchanged upstream data produce identical bytes.
 *
 * Run from the repo root:
 *   pnpm --filter @aerismap/ingest exec tsx scripts/prepare-boundaries.ts
 * or from ingest/:
 *   pnpm exec tsx scripts/prepare-boundaries.ts
 *
 * Licence: © EuroGeographics for the administrative boundaries (mandatory
 * verbatim notice — see ATTRIBUTIONS in packages/shared/src/contracts.ts;
 * non-commercial use, attribution required).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { fetchJson } from '../src/http'

const GISCO_BASE = 'https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson'

/** Live-verified feature counts (2026-07-21) — fail loudly on upstream drift. */
const EXPECTED = {
  l2_2024: 299,
  l3_2024: 1345,
  ukL2_2021: 41,
} as const

interface NutsProperties {
  NUTS_ID: string
  LEVL_CODE: number
  NAME_LATN: string
  CNTR_CODE: string
}

interface NutsFeature {
  type: 'Feature'
  properties: NutsProperties
  geometry: {
    type: 'Polygon' | 'MultiPolygon'
    coordinates: unknown
  }
}

interface NutsCollection {
  type: 'FeatureCollection'
  features: NutsFeature[]
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BROWSER_OUT_DIR = resolve(REPO_ROOT, 'apps/web/public/boundaries')
const ASSIGN_OUT_PATH = resolve(REPO_ROOT, 'ingest/data/nuts3-assign.geojson.gz')

async function download(file: string): Promise<NutsCollection> {
  const url = `${GISCO_BASE}/${file}`
  console.log(`[boundaries] downloading ${url}`)
  const doc = (await fetchJson(url, { timeoutMs: 300_000, retries: 2 })) as NutsCollection
  if (doc?.type !== 'FeatureCollection' || !Array.isArray(doc.features)) {
    throw new Error(`${file}: not a FeatureCollection`)
  }
  return doc
}

/** Trim properties to the published contract; validate the fields we rely on. */
function trim(features: readonly NutsFeature[], file: string): NutsFeature[] {
  return features.map((f) => {
    const { NUTS_ID, LEVL_CODE, NAME_LATN, CNTR_CODE } = f.properties
    if (typeof NUTS_ID !== 'string' || NUTS_ID.length < 4) {
      throw new Error(`${file}: feature with missing/short NUTS_ID: ${JSON.stringify(NUTS_ID)}`)
    }
    if (f.geometry?.type !== 'Polygon' && f.geometry?.type !== 'MultiPolygon') {
      throw new Error(`${file}: ${NUTS_ID} has unexpected geometry type ${f.geometry?.type}`)
    }
    return {
      type: 'Feature' as const,
      properties: { NUTS_ID, LEVL_CODE, NAME_LATN, CNTR_CODE },
      geometry: f.geometry,
    }
  })
}

/** 2024 set + NUTS-2021 UK splice, sorted by NUTS_ID, with uniqueness enforced. */
function merge(main: NutsFeature[], ukSplice: NutsFeature[], label: string): NutsCollection {
  const features = [...main, ...ukSplice].sort((a, b) =>
    a.properties.NUTS_ID < b.properties.NUTS_ID ? -1 : a.properties.NUTS_ID > b.properties.NUTS_ID ? 1 : 0
  )
  const ids = new Set(features.map((f) => f.properties.NUTS_ID))
  if (ids.size !== features.length) {
    throw new Error(`${label}: duplicate NUTS_ID after UK splice — upstream sets overlap`)
  }
  return { type: 'FeatureCollection', features }
}

const onlyUk = (doc: NutsCollection): NutsFeature[] =>
  doc.features.filter((f) => f.properties.CNTR_CODE === 'UK')

function formatBytes(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / (1024 * 1024)).toFixed(2)} MB`
}

async function writeOut(path: string, body: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
  console.log(`[boundaries] wrote ${path} (${formatBytes(body.byteLength)})`)
}

async function main(): Promise<void> {
  // Browser set (1:20M) + assignment set (1:3M), sequential to be polite to GISCO.
  const l2_2024 = await download('NUTS_RG_20M_2024_4326_LEVL_2.geojson')
  const l3_2024 = await download('NUTS_RG_20M_2024_4326_LEVL_3.geojson')
  const l2_2021 = await download('NUTS_RG_20M_2021_4326_LEVL_2.geojson')
  const l3_2021 = await download('NUTS_RG_20M_2021_4326_LEVL_3.geojson')
  const l3_2024_03m = await download('NUTS_RG_03M_2024_4326_LEVL_3.geojson')
  const l3_2021_03m = await download('NUTS_RG_03M_2021_4326_LEVL_3.geojson')

  if (l2_2024.features.length !== EXPECTED.l2_2024)
    throw new Error(`2024 L2: expected ${EXPECTED.l2_2024} features, got ${l2_2024.features.length}`)
  if (l3_2024.features.length !== EXPECTED.l3_2024)
    throw new Error(`2024 L3: expected ${EXPECTED.l3_2024} features, got ${l3_2024.features.length}`)
  if (l3_2024_03m.features.length !== EXPECTED.l3_2024)
    throw new Error(`2024 L3 1:3M: expected ${EXPECTED.l3_2024} features, got ${l3_2024_03m.features.length}`)

  const ukL2 = trim(onlyUk(l2_2021), 'NUTS_RG_20M_2021_4326_LEVL_2.geojson')
  const ukL3 = trim(onlyUk(l3_2021), 'NUTS_RG_20M_2021_4326_LEVL_3.geojson')
  const ukL3_03m = trim(onlyUk(l3_2021_03m), 'NUTS_RG_03M_2021_4326_LEVL_3.geojson')

  if (ukL2.length !== EXPECTED.ukL2_2021)
    throw new Error(`2021 UK L2: expected ${EXPECTED.ukL2_2021} features, got ${ukL2.length}`)
  if (ukL3.length === 0) throw new Error('2021 UK L3: no features after CNTR_CODE filter')
  if (ukL3.length !== ukL3_03m.length)
    throw new Error(`UK L3 unit mismatch across scales: 20M has ${ukL3.length}, 03M has ${ukL3_03m.length}`)

  const nuts2 = merge(trim(l2_2024.features, 'NUTS_RG_20M_2024_4326_LEVL_2.geojson'), ukL2, 'nuts2')
  const nuts3 = merge(trim(l3_2024.features, 'NUTS_RG_20M_2024_4326_LEVL_3.geojson'), ukL3, 'nuts3')
  const assign = merge(
    trim(l3_2024_03m.features, 'NUTS_RG_03M_2024_4326_LEVL_3.geojson'),
    ukL3_03m,
    'nuts3-assign'
  )

  await writeOut(resolve(BROWSER_OUT_DIR, 'nuts2.geojson'), Buffer.from(JSON.stringify(nuts2)))
  await writeOut(resolve(BROWSER_OUT_DIR, 'nuts3.geojson'), Buffer.from(JSON.stringify(nuts3)))
  await writeOut(ASSIGN_OUT_PATH, gzipSync(Buffer.from(JSON.stringify(assign)), { level: 9 }))

  console.log(
    `[boundaries] nuts2: ${nuts2.features.length} features (${l2_2024.features.length} × 2024 + ${ukL2.length} × UK 2021)`
  )
  console.log(
    `[boundaries] nuts3: ${nuts3.features.length} features (${l3_2024.features.length} × 2024 + ${ukL3.length} × UK 2021)`
  )
  console.log(`[boundaries] nuts3-assign (1:3M): ${assign.features.length} features`)
}

main().catch((err) => {
  console.error('[boundaries] fatal:', err)
  process.exitCode = 1
})
