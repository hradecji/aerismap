import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { R2_KEYS, type AreaSnapshot, type StationCollection } from '@aerismap/shared'
import type { Snapshot } from './snapshot'

export interface Artifact {
  key: string
  body: Buffer
  contentType: string
  contentEncoding?: string
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
      key: R2_KEYS.stations,
      body: gzipSync(Buffer.from(JSON.stringify(snapshot.collection)), { level: 9 }),
      contentType: 'application/geo+json',
      contentEncoding: 'gzip',
    },
  ]
  if (areas) {
    artifacts.push({
      key: R2_KEYS.areas,
      body: gzipSync(Buffer.from(JSON.stringify(areas)), { level: 9 }),
      contentType: 'application/json',
      contentEncoding: 'gzip',
    })
  }
  artifacts.push({
    key: R2_KEYS.meta,
    body: Buffer.from(JSON.stringify(snapshot.meta, null, 2) + '\n'),
    contentType: 'application/json',
  })
  return artifacts
}

/** Write artifacts under outDir mirroring the R2 key layout; returns absolute paths. */
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

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

/** R2 upload is enabled only when all three credentials are present. */
export function readR2Config(env: NodeJS.ProcessEnv = process.env): R2Config | undefined {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return undefined
  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET || 'aerismap-data',
  }
}

function createS3Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

/** Upload artifacts to R2 in order (meta.json last — see buildArtifacts). */
export async function uploadToR2(artifacts: readonly Artifact[], config: R2Config): Promise<void> {
  const client = createS3Client(config)
  try {
    for (const artifact of artifacts) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: artifact.key,
          Body: artifact.body,
          ContentType: artifact.contentType,
          ...(artifact.contentEncoding ? { ContentEncoding: artifact.contentEncoding } : {}),
        })
      )
    }
  } finally {
    client.destroy()
  }
}

/** GET one object from R2; undefined when the key does not exist. */
export async function getFromR2(key: string, config: R2Config): Promise<Buffer | undefined> {
  const client = createS3Client(config)
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
    const bytes = await res.Body?.transformToByteArray()
    return bytes === undefined ? undefined : Buffer.from(bytes)
  } catch (err) {
    if (err instanceof Error && err.name === 'NoSuchKey') return undefined
    throw err
  } finally {
    client.destroy()
  }
}

/** Read one object from the local out-dir mirror of the R2 layout; undefined when absent. */
export async function readLocalObject(key: string, outDir: string): Promise<Buffer | undefined> {
  try {
    return await readFile(resolve(outDir, key))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/**
 * Load the previously published stations GeoJSON (R2 when configured, else the
 * local out dir) for carry-forward when a source fails. Best-effort: absence or
 * any failure degrades to undefined with a warning, never a crash.
 */
export async function loadPreviousStations(
  r2: R2Config | undefined,
  outDir: string | undefined,
  warn: (message: string) => void = (m) => console.warn(`[ingest] ${m}`)
): Promise<StationCollection | undefined> {
  try {
    const body = r2
      ? await getFromR2(R2_KEYS.stations, r2)
      : outDir
        ? await readLocalObject(R2_KEYS.stations, outDir)
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
