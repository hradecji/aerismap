import { pathToFileURL } from 'node:url'
import type { SourceStatus } from '@aerismap/shared'
import { buildAreasForRun } from './areas'
import {
  buildArtifacts,
  getFromR2,
  loadPreviousStations,
  readLocalObject,
  readR2Config,
  uploadToR2,
  writeLocal,
  type Artifact,
  type R2Config,
} from './output'
import { buildSnapshot } from './snapshot'
import { fetchOpenaq, OPENAQ_REGISTRY_KEY, type RegistryStore } from './sources/openaq'
import { fetchSensorCommunity } from './sources/sensor-community'

function parseArgs(argv: readonly string[]): { outDir?: string } {
  const i = argv.indexOf('--out')
  if (i === -1) return {}
  const outDir = argv[i + 1]
  if (!outDir || outDir.startsWith('--')) {
    throw new Error('--out requires a directory argument')
  }
  return { outDir }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * In GitHub Actions a run without R2 credentials would go green while
 * uploading nothing (missing or misnamed secrets) — fail loudly instead.
 */
export function ciMissingR2Error(
  env: NodeJS.ProcessEnv,
  r2: R2Config | undefined
): string | undefined {
  if (env.GITHUB_ACTIONS && !r2) {
    return (
      'GITHUB_ACTIONS is set but R2 is not configured (need R2_ACCOUNT_ID, ' +
      'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) — a CI run that cannot upload ' +
      'is a misconfiguration; check the repository secrets'
    )
  }
  return undefined
}

/**
 * GitHub Actions warning annotations for configured-but-failed sources in a
 * run that still publishes. A missing OPENAQ_API_KEY is a deliberate quiet
 * skip, not a failure worth annotating.
 */
export function ciWarningAnnotations(sources: readonly SourceStatus[]): string[] {
  const lines: string[] = []
  for (const source of sources) {
    if (source.ok) continue
    if (source.detail?.startsWith('OPENAQ_API_KEY not set')) continue
    lines.push(`::warning::ingest source ${source.id} failed: ${source.detail ?? 'unknown error'}`)
  }
  return lines
}

/** Registry cache backing: R2 when configured, else the local out dir. */
function createRegistryStore(r2: R2Config | undefined, outDir: string | undefined): RegistryStore {
  return {
    load: async () => {
      const body = r2
        ? await getFromR2(OPENAQ_REGISTRY_KEY, r2)
        : outDir
          ? await readLocalObject(OPENAQ_REGISTRY_KEY, outDir)
          : undefined
      return body?.toString('utf8')
    },
    save: async (body) => {
      const artifact: Artifact = {
        key: OPENAQ_REGISTRY_KEY,
        body: Buffer.from(body),
        contentType: 'application/json',
      }
      if (r2) await uploadToR2([artifact], r2)
      else if (outDir) await writeLocal([artifact], outDir)
    },
  }
}

async function main(): Promise<number> {
  const startedAt = Date.now()
  const { outDir: outArg } = parseArgs(process.argv.slice(2))
  const r2 = readR2Config()

  const ciError = ciMissingR2Error(process.env, r2)
  if (ciError) {
    console.error(`[ingest] ${ciError}`)
    return 1
  }

  const outDir = outArg ?? (r2 ? undefined : '.artifacts')
  const registryStore = createRegistryStore(r2, outDir)

  const results = await Promise.all([fetchSensorCommunity(), fetchOpenaq({ registryStore })])

  for (const { status } of results) {
    console.log(
      status.ok
        ? `[ingest] ${status.id}: ok — ${status.stations} stations`
        : `[ingest] ${status.id}: skipped/failed — ${status.detail}`
    )
  }
  if (results.every((r) => !r.status.ok)) {
    console.error('[ingest] every source failed — not publishing artifacts')
    return 1
  }

  // A failed source's stations are carried forward from the previous snapshot
  // instead of silently shrinking the map.
  const previous = results.some((r) => !r.status.ok)
    ? await loadPreviousStations(r2, outDir)
    : undefined

  const now = new Date()
  const snapshot = buildSnapshot(results, now, previous)
  const { counts } = snapshot.meta
  const kinds = Object.entries(counts.byKind)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(', ')
  console.log(`[ingest] snapshot: ${counts.stations} stations (${kinds}); ${counts.withEaqi} with EAQI`)
  for (const line of ciWarningAnnotations(snapshot.meta.sources)) {
    console.log(line)
  }

  // Area mode: aggregate stations into NUTS regions. On failure this degrades
  // to a ::warning and no areas artifact — the previous one stays published.
  const areas = await buildAreasForRun(snapshot.collection, now)
  if (areas) {
    counts.areasColored = areas.areasColored
    counts.areasTotal = areas.areasTotal
    console.log(
      `[ingest] areas: ${areas.areasColored}/${areas.areasTotal} regions colored ` +
        `(${Object.keys(areas.snapshot.areas).length} with stations, ${areas.unassignedStations} stations unassigned)`
    )
  }

  const artifacts = buildArtifacts(snapshot, areas?.snapshot)

  if (outDir) {
    const paths = await writeLocal(artifacts, outDir)
    for (let i = 0; i < artifacts.length; i++) {
      console.log(`[ingest] wrote ${paths[i]} (${formatBytes(artifacts[i]!.body.byteLength)})`)
    }
  }
  if (r2) {
    await uploadToR2(artifacts, r2)
    for (const artifact of artifacts) {
      console.log(
        `[ingest] uploaded r2://${r2.bucket}/${artifact.key} (${formatBytes(artifact.body.byteLength)})`
      )
    }
  }

  console.log(`[ingest] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  return 0
}

// Run only as a script — importable from tests without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      console.error('[ingest] fatal:', err)
      process.exitCode = 1
    })
}
