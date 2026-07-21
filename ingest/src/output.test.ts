import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { R2_KEYS, type AreaSnapshot } from '@aerismap/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { buildArtifacts, loadPreviousStations, readLocalObject, readR2Config, writeLocal } from './output'
import { buildSnapshot } from './snapshot'
import type { SourceResult } from './types'

const NOW = new Date('2026-07-21T12:00:00Z')

const result: SourceResult = {
  status: { id: 'sensor-community', ok: true, fetchedAt: NOW.toISOString(), stations: 1 },
  stations: [
    {
      lon: 9.2,
      lat: 48.53,
      properties: {
        id: 'sensor-community:49',
        source: 'sensor-community',
        nativeId: '49',
        kind: 'community',
        country: 'DE',
        license: 'ODbL-1.0',
        exactLocation: false,
        values: { pm2_5: { v: 12, ts: '2026-07-21T11:50:00Z' } },
      },
    },
  ],
}
const snapshot = buildSnapshot([result], NOW)

describe('buildArtifacts', () => {
  const artifacts = buildArtifacts(snapshot)

  it('emits a gzipped GeoJSON that round-trips, and meta.json last as the atomic pointer', () => {
    expect(artifacts.map((a) => a.key)).toEqual([R2_KEYS.stations, R2_KEYS.meta])
    const stations = artifacts[0]!
    expect(stations.contentType).toBe('application/geo+json')
    expect(stations.contentEncoding).toBe('gzip')
    expect(JSON.parse(gunzipSync(stations.body).toString('utf8'))).toEqual(
      JSON.parse(JSON.stringify(snapshot.collection))
    )
    const meta = artifacts[1]!
    expect(meta.contentType).toBe('application/json')
    expect(meta.contentEncoding).toBeUndefined()
    expect(JSON.parse(meta.body.toString('utf8'))).toEqual(JSON.parse(JSON.stringify(snapshot.meta)))
  })

  it('inserts the areas artifact before meta.json and round-trips it through gzip', () => {
    const areas: AreaSnapshot = {
      generatedAt: NOW.toISOString(),
      areas: {
        DE11: { n: 4, nRef: 1, nCom: 3, eaqi: 2, pollutant: 'pm2_5', med: { pm2_5: 8.5 }, cnt: { pm2_5: 4 } },
        DE111: { n: 2, nRef: 0, nCom: 2, med: { pm2_5: 8.5 }, cnt: { pm2_5: 2 } },
      },
    }
    const withAreas = buildArtifacts(snapshot, areas)
    expect(withAreas.map((a) => a.key)).toEqual([R2_KEYS.stations, R2_KEYS.areas, R2_KEYS.meta])
    const artifact = withAreas[1]!
    expect(artifact.contentType).toBe('application/json')
    expect(artifact.contentEncoding).toBe('gzip')
    expect(JSON.parse(gunzipSync(artifact.body).toString('utf8'))).toEqual(
      JSON.parse(JSON.stringify(areas))
    )
  })
})

describe('writeLocal', () => {
  let dir: string | undefined
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('mirrors the R2 key layout on disk', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aerismap-ingest-test-'))
    const artifacts = buildArtifacts(snapshot)
    const paths = await writeLocal(artifacts, dir)
    expect(paths).toEqual([join(dir, R2_KEYS.stations), join(dir, R2_KEYS.meta)])
    const gz = await readFile(paths[0]!)
    expect(JSON.parse(gunzipSync(gz).toString('utf8')).type).toBe('FeatureCollection')
  })
})

describe('loadPreviousStations (local out dir)', () => {
  const dirs: string[] = []
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })
  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'aerismap-ingest-test-'))
    dirs.push(dir)
    return dir
  }

  it('round-trips the previously published artifact', async () => {
    const dir = await tempDir()
    await writeLocal(buildArtifacts(snapshot), dir)
    const previous = await loadPreviousStations(undefined, dir, () => {})
    expect(previous?.features.map((f) => f.properties.id)).toEqual(['sensor-community:49'])
  })

  it('tolerates absence', async () => {
    const dir = await tempDir()
    expect(await readLocalObject(R2_KEYS.stations, dir)).toBeUndefined()
    expect(await loadPreviousStations(undefined, dir, () => {})).toBeUndefined()
    expect(await loadPreviousStations(undefined, undefined, () => {})).toBeUndefined()
  })

  it('tolerates a corrupt artifact with a warning', async () => {
    const dir = await tempDir()
    const path = join(dir, R2_KEYS.stations)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'not gzip at all')
    const warnings: string[] = []
    expect(await loadPreviousStations(undefined, dir, (m) => warnings.push(m))).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })
})

describe('readR2Config', () => {
  it('returns undefined unless all three credentials are set', () => {
    expect(readR2Config({})).toBeUndefined()
    expect(readR2Config({ R2_ACCOUNT_ID: 'acc' })).toBeUndefined()
    expect(
      readR2Config({ R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'key' })
    ).toBeUndefined()
  })

  it('applies the default bucket and honours R2_BUCKET', () => {
    const base = {
      R2_ACCOUNT_ID: 'acc',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
    }
    expect(readR2Config(base)).toEqual({
      accountId: 'acc',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'aerismap-data',
    })
    expect(readR2Config({ ...base, R2_BUCKET: 'custom' })?.bucket).toBe('custom')
  })
})
