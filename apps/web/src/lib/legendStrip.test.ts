import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EAQI_BAND_COLORS } from '@aerismap/shared'
import { EAQI_EXPLAINER, collapsedTitle, rampGradient, stripGradient } from './legendStrip'
import { NEUTRAL_DOT, VIEWS } from './views'

const viewOf = (id: string) => {
  const view = VIEWS.find((v) => v.id === id)
  assert.ok(view, `view ${id} exists`)
  return view
}

describe('EAQI_EXPLAINER', () => {
  it('names all five sub-index pollutants and the worst-of rule', () => {
    for (const label of ['PM2.5', 'PM10', 'NO₂', 'O₃', 'SO₂']) {
      assert.ok(EAQI_EXPLAINER.includes(label), `mentions ${label}`)
    }
    assert.match(EAQI_EXPLAINER, /^Worst of /)
  })
})

describe('stripGradient', () => {
  it('EAQI bands → six equal hard-stop segments, neutral “No index” excluded', () => {
    const g = stripGradient(viewOf('eaqi').legend)
    for (const color of EAQI_BAND_COLORS) assert.ok(g.includes(color), `has ${color}`)
    assert.ok(!g.includes(NEUTRAL_DOT), 'neutral dot color excluded')
    // Hard stops: each color spans start% end%, e.g. "… 16.7% 33.3%".
    assert.ok(g.includes('16.7% 33.3%'), 'equal segments')
    assert.ok(g.startsWith('linear-gradient(to right,'))
  })

  it('ramp legends reuse the continuous value-placed gradient', () => {
    const legend = viewOf('humidity').legend
    assert.equal(legend.kind, 'ramp')
    assert.equal(stripGradient(legend), rampGradient(legend))
  })
})

describe('rampGradient', () => {
  it('places stops proportionally to their values', () => {
    const legend = viewOf('humidity').legend
    assert.equal(legend.kind, 'ramp')
    const g = rampGradient(legend)
    assert.ok(g.includes(' 0.0%'))
    assert.ok(g.includes(' 25.0%'))
    assert.ok(g.includes(' 100.0%'))
  })
})

describe('collapsedTitle', () => {
  it('EAQI collapses to the plain-language index name', () => {
    assert.equal(collapsedTitle(viewOf('eaqi')), 'Air quality index')
  })

  it('other views collapse to their short label', () => {
    assert.equal(collapsedTitle(viewOf('pm2_5')), 'PM2.5')
    assert.equal(collapsedTitle(viewOf('temperature')), 'Temperature')
  })
})
