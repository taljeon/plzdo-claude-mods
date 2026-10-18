import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  component: 'Pane', requestId: 'workbench',
  props: { title: 'Workbench', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const mount = ($: Engine) => $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...PANE })

// Workbench always reads blast-radius (its dependency); duo-quiz only when the test gives a quiz.
function fixture(on: On, quiz?: { status: string }) {
  mock.clock(on, { now: 1_000 })
  on('state.get', ($, e, next) => e.plugin === 'blast-radius'
    ? { value: { value: e.key === 'held' ? null : [], version: 1 } }
    : e.plugin === 'duo-quiz' && quiz ? { value: { value: quiz, version: 1 } }
    : next(e))
}

describe('workbench section from a plugin beneath', () => {
  test('a tree drawn beneath is shown last, below the agents', async ($, on) => {
    fixture(on, { status: 'active' })
    on('ui.render', { component: 'Pane', requestId: 'workbench' }, () =>
      ({ type: 'Text', props: {}, children: ['DUO BELOW'], part: { plugin: 'test' } }))
    const ui = await mount($)
    const rows = await ui.findAll({ type: 'Text' })
    const duo = rows.findIndex(row => row.text === 'DUO BELOW')
    expect(rows.findIndex(row => row.text === '변경 0개')).toBe(0)
    expect(duo).toBeGreaterThan(rows.findIndex(row => row.text === '에이전트'))
    expect(duo).toBe(rows.length - 1)
    await ui.unmount()
  })

  test('no quiz: the hook beneath is not even asked', async ($, on) => {
    fixture(on)
    let asked = 0
    on('ui.render', { component: 'Pane', requestId: 'workbench' }, () => {
      asked++
      return { type: 'Text', props: {}, children: ['DUO BELOW'], part: { plugin: 'test' } }
    })
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: 'DUO BELOW' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '변경 0개' })).toBeDefined()
    expect(asked).toBe(0)
    await ui.unmount()
  })
})
