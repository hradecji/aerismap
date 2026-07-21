/**
 * Tests for the queryRenderedFeatures property re-parsing; run via
 * `pnpm --filter @aerismap/web test`. Through that pipeline, nested objects
 * (`values`) and arrays (`qc`) arrive JSON-stringified while scalars
 * (`hotspot`, `stale`, …) arrive as-is.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseStationProps } from './stationProps'

const base = {
  id: 'sensor-community:1',
  source: 'sensor-community',
  nativeId: '1',
  kind: 'community',
  license: 'ODbL-1.0',
  exactLocation: true,
  observedAt: '2026-07-21T10:00:00Z',
  stale: false,
}

const reading = { v: 42.1, ts: '2026-07-21T10:00:00Z' }

describe('parseStationProps: values', () => {
  it('parses a JSON-stringified values blob', () => {
    const props = parseStationProps({ ...base, values: JSON.stringify({ pm2_5: reading }) })
    assert.deepEqual(props.values, { pm2_5: reading })
  })

  it('passes an already-object values blob through', () => {
    const props = parseStationProps({ ...base, values: { pm10: reading } })
    assert.deepEqual(props.values, { pm10: reading })
  })

  it('degrades corrupt or missing values to an empty object', () => {
    assert.deepEqual(parseStationProps({ ...base, values: '{oops' }).values, {})
    assert.deepEqual(parseStationProps({ ...base }).values, {})
    assert.deepEqual(parseStationProps({ ...base, values: '[1,2]' }).values, {})
  })
})

describe('parseStationProps: qc', () => {
  it('parses a JSON-stringified qc array', () => {
    const props = parseStationProps({
      ...base,
      values: JSON.stringify({ pm2_5: reading }),
      qc: JSON.stringify(['pm2_5', 'pm10']),
    })
    assert.deepEqual(props.qc, ['pm2_5', 'pm10'])
  })

  it('passes an already-array qc through', () => {
    const props = parseStationProps({ ...base, qc: ['pm10'] })
    assert.deepEqual(props.qc, ['pm10'])
  })

  it('filters unknown params out of qc', () => {
    const props = parseStationProps({ ...base, qc: JSON.stringify(['pm2_5', 'plutonium', 7]) })
    assert.deepEqual(props.qc, ['pm2_5'])
  })

  it('drops corrupt / non-array / effectively-empty qc entirely', () => {
    assert.equal('qc' in parseStationProps({ ...base, qc: '[oops' }), false)
    assert.equal('qc' in parseStationProps({ ...base, qc: '"pm2_5"' }), false)
    assert.equal('qc' in parseStationProps({ ...base, qc: JSON.stringify(['bogus']) }), false)
    assert.equal('qc' in parseStationProps({ ...base }), false)
  })

  it('a corrupt values blob does not take qc down with it', () => {
    const props = parseStationProps({ ...base, values: '{oops', qc: JSON.stringify(['pm2_5']) })
    assert.deepEqual(props.values, {})
    assert.deepEqual(props.qc, ['pm2_5'])
  })
})

describe('parseStationProps: scalars', () => {
  it('keeps scalar properties like hotspot and stale untouched', () => {
    const props = parseStationProps({ ...base, stale: true, hotspot: true, eaqi: 5 })
    assert.equal(props.hotspot, true)
    assert.equal(props.stale, true)
    assert.equal(props.eaqi, 5)
  })
})
