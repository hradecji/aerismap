import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  STORE_KEYS,
  type AreaSnapshot,
  type StationCollection,
  type StoreMetadata,
} from '@aerismap/shared'
import { sleep } from './http'
import type { Snapshot } from './snapshot'

export interface Artifact {
  key: string
  body: Buffer
  contentType: string
  contentEncoding?: 'gzip'
}

/**
 * Serialize the snapshot into upload-ready artifacts. Order matters: meta.json
 * is last because it is the pointer readers use to detect a completed snapshot
 * — uploading it after the payload keeps the publish effectively atomic.
 *
 * `areas` is optional: when area aggregation failed this run, no areas
 * artifact is emitted and the previously published latest/areas.json.gz
 * stays in place (see buildAreasForRun in areas.ts).
 */
export function buildArtifacts(snapshot: Snapshot, areas?: AreaSnapshot): Artifact[] {
  const artifacts: Artifact[] = [
    {
      key: STORE_KEYS.stations,
      body: gzipSync(Buffer.from(JSON.stringify(snapshot.collection)), { level: 9 }),
      contentType: 'application/geo+json',
      contentEncoding: 'gzip',
    },
  ]
  if (areas) {
    artifacts.push({
      key: STORE_KEYS.areas,
      body: gzipSync(Buffer.from(JSON.stringify(areas)), { level: 9 }),
      contentType: 'application/json',
      contentEncoding: 'gzip',
    })
  }
  artifacts.push({
    key: STORE_KEYS.meta,
    body: Buffer.from(JSON.stringify(snapshot.meta, null, 2) + '\n'),
    contentType: 'application/json',
  })
  return artifacts
}

/** Write artifacts under outDir mirroring the KV key layout; returns absolute paths. */
export async function writeLocal(artifacts: readonly Artifact[], outDir: string): Promise<string[]> {
  const paths: string[] = []
  for (const artifact of artifacts) {
    const path = resolve(outDir, artifact.key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, artifact.body)
    paths.push(path)
  }
  return paths
}

export interface KvConfig {
  accountId: string
  namespaceId: string
  apiToken: string
}

/** KV upload is enabled only when all three Cloudflare settings are present. */
export function readKvConfig(env: NodeJS.ProcessEnv = process.env): KvConfig | undefined {
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID } = env
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_KV_NAMESPACE_ID) {
    return undefined
  }
  return {
    accountId: CLOUDFLARE_ACCOUNT_ID,
    namespaceId: CLOUDFLARE_KV_NAMESPACE_ID,
    apiToken: CLOUDFLARE_API_TOKEN,
  }
}

const KV_API_BASE = 'https://api.cloudflare.com/client/v4'
/** Per-attempt timeout — artifacts are ≤ ~0.5 MB, so 30 s is generous. */
const KV_TIMEOUT_MS = 30_000
/** Retries after the first attempt (network errors/timeouts, 5xx, 429). */
const KV_RETRIES = 2
const KV_BACKOFF_MS = 1_000

export interface KvRequestOptions {
  fetchImpl?: typeof fetch
  /** Overridable for tests; production default 1000 ms. */
  backoffMs?: number
}

function kvValueUrl(config: KvConfig, key: string): string {
  return (
    `${KV_API_BASE}/accounts/${config.accountId}/storage/kv/namespaces/` +
    `${config.namespaceId}/values/${encodeURIComponent(key)}`
  )
}

/**
 * One KV REST request with timeout, KV_RETRIES retries and exponential
 * backoff. Network errors/timeouts, 5xx and 429 are retried; every other
 * status — and the final over-retry 5xx/429 — is returned for the caller
 * to interpret (404 means absent on reads).
 */
async function kvFetch(
  url: string,
  makeInit: () => RequestInit,
  options: KvRequestOptions
): Promise<Response> {
  const { fetchImpl = fetch, backoffMs = KV_BACKOFF_MS } = options
  let lastError: unknown
  for (let attempt = 0; attempt <= KV_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1))
    let res: Response
    try {
      res = await fetchImpl(url, { ...makeInit(), signal: AbortSignal.timeout(KV_TIMEOUT_MS) })
    } catch (err) {
      lastError = err // network failure or timeout — retryable
      continue
    }
    if ((res.status >= 500 || res.status === 429) && attempt < KV_RETRIES) continue
    return res
  }
  throw lastError
}

/** Failure message carrying the Cloudflare envelope's errors[] when present. */
async function kvFailureMessage(action: string, key: string, res: Response): Promise<string> {
  let detail = ''
  try {
    const body = (await res.json()) as { errors?: Array<{ code?: number; message?: string }> }
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      detail = ` — ${body.errors.map((e) => `${e.code ?? '?'} ${e.message ?? '(no message)'}`).join('; ')}`
    }
  } catch {
    // non-JSON error body; the status alone will have to do
  }
  return `KV ${action} ${key} failed: HTTP ${res.status}${detail}`
}

/**
 * Per-key KV metadata for one artifact — the worker serves ETag and
 * Content-Length from it because KV has no native object metadata.
 */
export function artifactMetadata(artifact: Artifact): StoreMetadata {
  return {
    etag: createHash('sha256').update(artifact.body).digest('hex'),
    size: artifact.body.byteLength,
    contentType: artifact.contentType,
    ...(artifact.contentEncoding ? { contentEncoding: artifact.contentEncoding } : {}),
  }
}

/**
 * Upload artifacts to Cloudflare KV in order (meta.json last — see
 * buildArtifacts) via the REST API: PUT multipart/form-data with a `value`
 * part (the raw bytes) and a `metadata` part (StoreMetadata JSON).
 */
export async function uploadToKv(
  artifacts: readonly Artifact[],
  config: KvConfig,
  options: KvRequestOptions = {}
): Promise<void> {
  for (const artifact of artifacts) {
    const metadata = JSON.stringify(artifactMetadata(artifact))
    const res = await kvFetch(
      kvValueUrl(config, artifact.key),
      () => {
        const form = new FormData()
        form.set('value', new Blob([new Uint8Array(artifact.body)]))
        form.set('metadata', metadata)
        return {
          method: 'PUT',
          headers: { Authorization: `Bearer ${config.apiToken}` },
          body: form,
        }
      },
      options
    )
    if (!res.ok) throw new Error(await kvFailureMessage('PUT', artifact.key, res))
  }
}

/** GET one value from KV; undefined when the key does not exist (404). */
export async function getFromKv(
  key: string,
  config: KvConfig,
  options: KvRequestOptions = {}
): Promise<Buffer | undefined> {
  const res = await kvFetch(
    kvValueUrl(config, key),
    () => ({ method: 'GET', headers: { Authorization: `Bearer ${config.apiToken}` } }),
    options
  )
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(await kvFailureMessage('GET', key, res))
  return Buffer.from(await res.arrayBuffer())
}

/** Read one object from the local out-dir mirror of the KV layout; undefined when absent. */
export async function readLocalObject(key: string, outDir: string): Promise<Buffer | undefined> {
  try {
    return await readFile(resolve(outDir, key))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/**
 * Load the previously published stations GeoJSON (KV when configured, else the
 * local out dir) for carry-forward when a source fails. Best-effort: absence or
 * any failure degrades to undefined with a warning, never a crash.
 */
export async function loadPreviousStations(
  kv: KvConfig | undefined,
  outDir: string | undefined,
  warn: (message: string) => void = (m) => console.warn(`[ingest] ${m}`)
): Promise<StationCollection | undefined> {
  try {
    const body = kv
      ? await getFromKv(STORE_KEYS.stations, kv)
      : outDir
        ? await readLocalObject(STORE_KEYS.stations, outDir)
        : undefined
    if (!body) return undefined
    const parsed = JSON.parse(gunzipSync(body).toString('utf8')) as StationCollection
    if (parsed?.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
      warn('previous stations artifact has an unexpected shape; ignoring it')
      return undefined
    }
    return parsed
  } catch (err) {
    warn(`could not load previous stations artifact: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}
