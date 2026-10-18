import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptFillInput, RenderElement } from 'claude-code'

type Node = { type: string; props?: Record<string, unknown>; children?: (Node | string)[] }
const labels = (n: Node | string, out: string[] = []): string[] => {
  if (typeof n === 'string') return out
  if (n.type === 'Button' && typeof n.props?.label === 'string') out.push(n.props.label)
  n.children?.forEach(c => labels(c, out))
  return out
}
const beneath: RenderElement = { type: 'Text', props: {}, children: ['ENGINE'], part: { plugin: 'test' } }

const ANSWER = `done.

<next-steps>
- push | push commit abc to origin
- tests | run the tests in duo-quiz
- docs | update the README
</next-steps>`

function fixture(on: On, isFilled = true) {
  const fills: PromptFillInput[] = []
  let toasts = 0
  on('prompt.fill', ($, e) => {
    fills.push(e)
    return { isFilled }
  })
  on('ui.toast', () => { toasts++; return { value: undefined } })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // The engine's own drawing: an answer is drawn as the text it was handed.
  on('ui.render', ($, e) => e.component === 'AssistantMessage'
    ? { type: 'Text', props: {}, children: [String((e.props as { text: unknown }).text)], part: { plugin: 'test' } }
    : beneath)
  return { fills, toasts: () => toasts }
}

const complete = ($: Engine, answer = ANSWER) =>
  $.turn.complete({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 'turn-1' })
const mount = ($: Engine) => $.ui.mount({
  plugin: 'next-steps-pick', surface: 'terminal', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
})

describe('next-steps-pick', () => {
  test('one press puts that request in the prompt box and ticks it alone', async ($, on) => {
    const { fills } = fixture(on)
    await complete($)
    const ui = await mount($)
    expect(labels(await ui.drawn() as Node)).toContain('☐ tests')
    await ui.press({ key: 'step-1' })
    expect(fills.map(f => f.text)).toEqual(['run the tests in duo-quiz'])
    expect(labels(await ui.drawn() as Node)).toContain('☑ tests')
    await ui.press({ key: 'step-0' })
    expect(fills.at(-1)?.text).toBe('push commit abc to origin')
    expect(fills.at(-1)?.mode ?? 'replace').toBe('replace')
    expect(labels(await ui.drawn() as Node)).toContain('☑ push')
    expect(labels(await ui.drawn() as Node)).toContain('☐ tests')
    await ui.unmount()
  })

  test('a refused fill toasts and ticks nothing', async ($, on) => {
    const f = fixture(on, false)
    await complete($)
    const ui = await mount($)
    await ui.press({ key: 'step-2' })
    expect(f.toasts()).toBe(1)
    expect(labels(await ui.drawn() as Node)).toContain('☐ docs')
    await ui.unmount()
  })

  test('the block is hidden from the drawn answer', async ($, on) => {
    fixture(on)
    const ui = await $.ui.mount({
      plugin: 'next-steps-pick', surface: 'terminal', component: 'AssistantMessage',
      props: { text: ANSWER, isFirstOfReply: false },
    })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('done.')
    expect(drawn).not.toContain('next-steps')
    await ui.unmount()
  })
})
