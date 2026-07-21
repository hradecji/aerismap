import { describe, expect, it } from 'vitest'
import type { R2Config } from './output'
import { ciMissingR2Error, ciWarningAnnotations } from './run'

const R2: R2Config = { accountId: 'acc', accessKeyId: 'key', secretAccessKey: 'secret', bucket: 'b' }

describe('ciMissingR2Error', () => {
  it('errors when GITHUB_ACTIONS is set without R2 configuration', () => {
    expect(ciMissingR2Error({ GITHUB_ACTIONS: 'true' }, undefined)).toContain('R2 is not configured')
  })

  it('passes when R2 is configured or outside CI', () => {
    expect(ciMissingR2Error({ GITHUB_ACTIONS: 'true' }, R2)).toBeUndefined()
    expect(ciMissingR2Error({}, undefined)).toBeUndefined()
  })
})

describe('ciWarningAnnotations', () => {
  it('annotates configured-but-failed sources, carrying the carry-forward info in the detail', () => {
    const lines = ciWarningAnnotations([
      { id: 'sensor-community', ok: true, stations: 9500 },
      {
        id: 'openaq',
        ok: false,
        detail:
          'implausibly low yield: 3 stations < floor 100 (normal ≈ 3.5–4.5k) — not publishing this source; carried forward 3200 stations from previous snapshot',
      },
    ])
    expect(lines).toEqual([
      '::warning::ingest source openaq failed: implausibly low yield: 3 stations < floor 100 (normal ≈ 3.5–4.5k) — not publishing this source; carried forward 3200 stations from previous snapshot',
    ])
  })

  it('stays quiet for ok sources and the deliberate no-key skip', () => {
    expect(
      ciWarningAnnotations([
        { id: 'sensor-community', ok: true, stations: 9500 },
        { id: 'openaq', ok: false, detail: 'OPENAQ_API_KEY not set; official layer skipped' },
      ])
    ).toEqual([])
  })
})
