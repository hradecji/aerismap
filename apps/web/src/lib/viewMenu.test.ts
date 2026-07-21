import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MORE_VIEW_IDS, PRIMARY_VIEW_IDS, isMoreView, moreButtonLabel, viewById } from './viewMenu'
import { VIEWS } from './views'

describe('view menu grouping', () => {
  it('primary + more together cover every view exactly once', () => {
    const combined = [...PRIMARY_VIEW_IDS, ...MORE_VIEW_IDS]
    assert.equal(combined.length, VIEWS.length)
    assert.deepEqual(new Set(combined), new Set(VIEWS.map((v) => v.id)))
  })

  it('the integrated index and temperature are the primaries', () => {
    assert.deepEqual([...PRIMARY_VIEW_IDS], ['eaqi', 'temperature'])
  })

  it('isMoreView splits along the primary/more line', () => {
    for (const id of PRIMARY_VIEW_IDS) assert.equal(isMoreView(id), false)
    for (const id of MORE_VIEW_IDS) assert.equal(isMoreView(id), true)
  })
})

describe('moreButtonLabel', () => {
  it('reads “More” while a primary view is active', () => {
    assert.equal(moreButtonLabel('eaqi'), 'More')
    assert.equal(moreButtonLabel('temperature'), 'More')
  })

  it('wears the active More-view’s short name', () => {
    assert.equal(moreButtonLabel('pm2_5'), 'PM2.5')
    assert.equal(moreButtonLabel('no2'), 'NO₂')
    assert.equal(moreButtonLabel('humidity'), 'Humidity')
  })
})

describe('viewById', () => {
  it('resolves every id in the menu', () => {
    for (const id of [...PRIMARY_VIEW_IDS, ...MORE_VIEW_IDS]) {
      assert.equal(viewById(id).id, id)
    }
  })
})
