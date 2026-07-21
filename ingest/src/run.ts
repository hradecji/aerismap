import { pathToFileURL } from 'node:url'
import type { SourceStatus } from '@aerismap/shared'
import { buildAreasForRun } from './areas'
import {
  buildArtifacts,
  getFromKv,
  loadPreviousStations,
  readKvConfig,
  readLocalObject,
  uploadToKv,
  writeLocal,
  type Artifact,
  type KvConfig,
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
 * In GitHub Actions a run without Cloudflare KV credentials would go green
 * while uploading nothing (missing or misnamed secrets) — fail loudly instead.
 */
export function ciMissingKvError(
  env: NodeJS.ProcessEnv,
  kv: KvConfig | undefined
): string | undefined {
  if (env.GITHUB_ACTIONS && !kv) {
    return (
      'GITHUB_ACTIONS is set but Cloudflare KV is not configured (need ' +
      'CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID) ' +
      '— a CI run that cannot upload is a misconfiguration; check the repository secrets'
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

/** Registry cache backing: KV when configured, else the local out dir. */
function createRegistryStore(kv: KvConfig | undefined, outDir: string | undefined): RegistryStore {
  return {
    load: async () => {
      const body = kv
        ? await getFromKv(OPENAQ_REGISTRY_KEY, kv)
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
      if (kv) await uploadToKv([artifact], kv)
      else if (outDir) await writeLocal([artifact], outDir)
    },
  }
}

async function main(): Promise<number> {
  const startedAt = Date.now()
  const { outDir: outArg } = parseArgs(process.argv.slice(2))
  const kv = readKvConfig()

  const ciError = ciMissingKvError(process.env, kv)
  if (ciError) {
    console.error(`[ingest] ${ciError}`)
    return 1
  }

  const outDir = outArg ?? (kv ? undefined : '.artifacts')
  const registryStore = createRegistryStore(kv, outDir)

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
    ? await loadPreviousStations(kv, outDir)
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
  if (kv) {
    await uploadToKv(artifacts, kv)
    for (const artifact of artifacts) {
      console.log(
        `[ingest] uploaded kv:${artifact.key} (${formatBytes(artifact.body.byteLength)})`
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
