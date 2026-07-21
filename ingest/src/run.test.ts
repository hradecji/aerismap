import { describe, expect, it } from 'vitest'
import type { KvConfig } from './output'
import { ciMissingKvError, ciWarningAnnotations } from './run'

const KV: KvConfig = { accountId: 'acct', namespaceId: 'ns', apiToken: 'tok' }

describe('ciMissingKvError', () => {
  it('errors when GITHUB_ACTIONS is set without KV configuration', () => {
    const message = ciMissingKvError({ GITHUB_ACTIONS: 'true' }, undefined)
    expect(message).toContain('Cloudflare KV is not configured')
    expect(message).toContain('CLOUDFLARE_API_TOKEN')
    expect(message).toContain('CLOUDFLARE_ACCOUNT_ID')
    expect(message).toContain('CLOUDFLARE_KV_NAMESPACE_ID')
  })

  it('passes when KV is configured or outside CI', () => {
    expect(ciMissingKvError({ GITHUB_ACTIONS: 'true' }, KV)).toBeUndefined()
    expect(ciMissingKvError({}, undefined)).toBeUndefined()
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
