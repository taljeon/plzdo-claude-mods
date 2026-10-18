import { expect, test } from 'claude-code/testing'

test('this build refuses a viewport row reduction, requiring unchanged next(e)', async ($, on) => {
  let failure = ''
  on('ui.render', { component: 'Pane', requestId: 'workbench' }, async ($, e, next) => {
    try {
      return await next({ ...e, viewport: { columns: 120, rows: 40 } })
    } catch (error) {
      failure = String(error)
      return { type: 'Text', props: {}, children: ['workbench'] }
    }
  })
  const ui = await $.ui.mount({
    plugin: 'duo-quiz', surface: 'terminal', component: 'Pane', requestId: 'workbench',
    viewport: { columns: 120, rows: 60 },
    props: { title: 'Workbench', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  expect(failure).toContain('changed viewport')
  expect(await ui.find({ type: 'Text', text: 'workbench' })).toBeDefined()
  await ui.unmount()
})
