import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteInput, On, PromptSubmitInput, RenderElement, RenderSurface } from 'claude-code'
import type { DuoQuestion, DuoQuiz } from '../types'
import { spreadAnswers } from '../hooks/quiz'

const question: DuoQuestion = {
  id: 'q1', question: '상태(atom)의 역할은?', choices: ['상태 보관', '파일 삭제', '프로세스 종료', '네트워크 차단'],
  answer: 0, explanation: 'atom은 세션 상태를 보관합니다.', isRetry: false,
}
const second: DuoQuestion = { ...question, id: 'q2', question: '다음 구조의 역할은?', answer: 2 }
// What the pane shows after the choices are rotated; tests press by these positions.
const [shownFirst, shownSecond] = spreadAnswers([question, second]) as [DuoQuestion, DuoQuestion]
const [shownOnly] = spreadAnswers([question]) as [DuoQuestion]
const wrongOf = (q: DuoQuestion) => (q.answer + 1) % 4
const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const pane = {
  component: 'Pane', requestId: 'workbench',
  props: { title: 'Workbench', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: 120, rows: 60, isFullscreen: true },
} as const
const beneath: RenderElement = { type: 'Text', props: {}, children: ['WORKBENCH ORIGINAL'], part: { plugin: 'test' } }

function fixture(on: On, questions: DuoQuestion[] = [question]) {
  const clock = mock.clock(on)
  const state = {
    quiz: undefined as DuoQuiz | undefined, lastAnswer: '',
    calls: [] as ModelCompleteInput[], prompts: [] as PromptSubmitInput[],
    rows: [] as (number | undefined)[], writes: 0,
    mode: 'answer' as 'answer' | 'unanswered' | 'throw' | 'garbage' | 'empty', delay: 0,
  }
  on('state.set', ($, e, next) => {
    if (e.plugin === 'duo-quiz') {
      state.writes++
      if (e.key === 'quiz') state.quiz = e.value as DuoQuiz
      if (e.key === 'lastAnswer') state.lastAnswer = String(e.value)
    }
    return next(e)
  })
  on('prompt.submit', ($, e) => {
    state.prompts.push(e)
    return { text: e.text, context: e.context, origin: e.origin }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.complete', async ($, e) => {
    state.calls.push(e)
    if (state.delay) await clock.sleep(state.delay)
    if (state.mode === 'throw') throw new Error('model unavailable')
    if (state.mode === 'unanswered') return { value: { isAnswered: false, reason: 'empty-reply', usage } }
    return { value: { isAnswered: true, text: state.mode === 'garbage' ? 'bad JSON' : JSON.stringify(state.mode === 'empty' ? [] : questions), usage } }
  })
  on('ui.render', { component: 'Pane', requestId: 'workbench' }, ($, e) => {
    state.rows.push(e.viewport?.rows)
    return beneath
  })
  return { state, clock }
}

const submit = ($: Engine, text = '상태 관리를 구현해줘', agentId?: string) => {
  const event = { text, wait: false, origin: { kind: 'composer' as const }, ...(agentId === undefined ? {} : { agentId }) }
  return $.prompt.submit(event)
}
const mount = ($: Engine, surface: RenderSurface = 'terminal') => $.ui.mount({ plugin: 'duo-quiz', surface, ...pane })
const complete = ($: Engine, answer: string, agentId?: string, reason: 'answer' | 'error' = 'answer') =>
  $.turn.complete({ answer, agentId, reason, durationMs: 1, isAborted: false, turnId: 'turn-1' })

describe('generation', () => {
  test('uses Haiku and the last 4000 characters of prompt and main answer only', async ($, on) => {
    const { state, clock } = fixture(on)
    await complete($, `old-answer-${'a'.repeat(4000)}`)
    await complete($, 'subagent answer', 'agent-1')
    await complete($, 'failed answer', undefined, 'error')
    const text = `old-prompt-${'p'.repeat(4000)}`
    expect(await submit($, text)).toMatchObject({ text })
    await clock.settle()
    expect(state.lastAnswer).toBe('a'.repeat(4000))
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]?.model).toBe('claude-haiku-5-5')
    expect(JSON.parse(state.calls[0]?.prompt ?? '{}')).toEqual({ submittedPrompt: 'p'.repeat(4000), lastMainAnswer: 'a'.repeat(4000) })
    expect(state.quiz?.status).toBe('active')
  })

  test('does not wait for generation and skips new work while generating or active', async ($, on) => {
    const { state, clock } = fixture(on)
    state.delay = 100
    await submit($)
    await clock.settle()
    expect(state.prompts).toHaveLength(1)
    expect(state.quiz?.status).toBe('generating')
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: '퀴즈 만드는 중…' })).toBeDefined()
    await submit($, '추가 요청')
    await clock.settle()
    expect(state.calls).toHaveLength(1)
    await clock.advance(100)
    expect(state.quiz?.status).toBe('active')
    await submit($, '아직 퀴즈 중')
    await clock.settle()
    expect(state.calls).toHaveLength(1)
    await ui.unmount()
  })

  test('slash and subagent prompts pass through without generating', async ($, on) => {
    const { state, clock } = fixture(on)
    for (const text of ['/help', '  /clear']) expect(await submit($, text)).toMatchObject({ text })
    await submit($, 'agent request', 'agent-1')
    await clock.settle()
    expect(state.calls).toHaveLength(0)
    expect(state.writes).toBe(0)
    expect(state.prompts).toHaveLength(3)
  })

  for (const mode of ['unanswered', 'throw', 'garbage', 'empty'] as const) {
    test(`${mode} ends the set with a reason line and no toast`, async ($, on) => {
      const { state, clock } = fixture(on)
      let toasts = 0
      on('ui.toast', () => { toasts++; return { value: undefined } })
      state.mode = mode
      await submit($)
      await clock.settle()
      expect(state.quiz?.status).toBe('done')
      expect(state.quiz?.error).toBeTruthy()
      const ui = await mount($)
      expect(await ui.find({ type: 'Text', text: /^퀴즈를 만들지 못했어요: / })).toBeDefined()
      expect(toasts).toBe(0)
      await ui.unmount()
    })
  }
})

describe('answers', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: correct answer shows feedback, then next and summary`, async ($, on) => {
      const { state, clock } = fixture(on, [question, second])
      await submit($)
      await clock.settle()
      const ui = await mount($, surface)
      expect((await ui.find({ key: 'duo-choice-0' }))?.props).toMatchObject({ hotkey: '1' })
      await ui.press({ key: `duo-choice-${shownFirst.answer}` })
      expect(state.quiz).toMatchObject({ correct: 1, wrong: 0, index: 0, phase: { kind: 'answered', chosen: shownFirst.answer } })
      expect(await ui.find({ type: 'Text', text: /^정답$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '(정답)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: question.explanation })).toBeDefined()
      expect((await ui.find({ key: 'duo-next' }))?.props).toMatchObject({ hotkey: 'n' })
      expect(await ui.find({ key: 'duo-skip' })).toBeUndefined()
      await ui.press({ key: 'duo-next' })
      expect(state.quiz).toMatchObject({ index: 1, phase: { kind: 'asking' } })
      expect(await ui.find({ type: 'Text', text: 'Duo 2/2' })).toBeDefined()
      await ui.press({ key: `duo-choice-${shownSecond.answer}` })
      await ui.press({ key: 'duo-next' })
      expect(state.quiz?.status).toBe('done')
      expect(await ui.find({ type: 'Text', text: '정답 2 / 오답 0 / 건너뜀 0' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('a wrong answer appends one retry, and a wrong retry appends nothing', async ($, on) => {
    const { state, clock } = fixture(on)
    await submit($)
    await clock.settle()
    const ui = await mount($)
    await ui.press({ key: `duo-choice-${wrongOf(shownOnly)}` })
    expect(state.quiz).toMatchObject({ wrong: 1, phase: { kind: 'answered', chosen: wrongOf(shownOnly) } })
    expect(state.quiz?.queue).toEqual([shownOnly, { ...shownOnly, isRetry: true }])
    expect(await ui.find({ type: 'Text', text: /^오답$/ })).toBeDefined()
    await ui.press({ key: 'duo-next' })
    expect(await ui.find({ type: 'Text', text: /^다시$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Duo 2/2' })).toBeDefined()
    await ui.press({ key: `duo-choice-${wrongOf(shownOnly)}` })
    expect(state.quiz?.queue).toHaveLength(2)
    expect(state.quiz?.wrong).toBe(2)
    await ui.press({ key: 'duo-next' })
    expect(state.quiz?.status).toBe('done')
    await ui.unmount()
  })

  test('skip counts once without a retry', async ($, on) => {
    const { state, clock } = fixture(on)
    await submit($)
    await clock.settle()
    const ui = await mount($)
    expect((await ui.find({ key: 'duo-skip' }))?.props).toMatchObject({ hotkey: 'x' })
    await ui.press({ key: 'duo-skip' })
    expect(state.quiz).toMatchObject({ skipped: 1, wrong: 0, correct: 0, status: 'done' })
    expect(state.quiz?.queue).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: '정답 0 / 오답 0 / 건너뜀 1' })).toBeDefined()
    await ui.unmount()
  })

  test('stop ends the set; the next prompt resets the score and starts anew', async ($, on) => {
    const { state, clock } = fixture(on, [question, second])
    await submit($)
    await clock.settle()
    const ui = await mount($)
    await ui.press({ key: `duo-choice-${wrongOf(shownFirst)}` })
    expect((await ui.find({ key: 'duo-stop' }))?.props).toMatchObject({ hotkey: 'q' })
    await ui.press({ key: 'duo-stop' })
    expect(state.quiz?.status).toBe('done')
    expect(await ui.find({ type: 'Text', text: '정답 0 / 오답 1 / 건너뜀 0' })).toBeDefined()
    await submit($, '새 작업')
    await clock.settle()
    expect(state.calls).toHaveLength(2)
    expect(state.quiz).toMatchObject({ status: 'active', index: 0, correct: 0, wrong: 0, skipped: 0, setId: 2 })
    expect(state.quiz?.queue).toHaveLength(2)
    await ui.unmount()
  })

  test('stop before answering shows the zero summary', async ($, on) => {
    const { state, clock } = fixture(on)
    await submit($)
    await clock.settle()
    const ui = await mount($)
    await ui.press({ key: 'duo-stop' })
    expect(state.quiz?.status).toBe('done')
    expect(await ui.find({ type: 'Text', text: '정답 0 / 오답 0 / 건너뜀 0' })).toBeDefined()
    await ui.unmount()
  })
})

describe('workbench composition', () => {
  test('no quiz returns the beneath tree and viewport unchanged without state writes', async ($, on) => {
    const { state } = fixture(on)
    const ui = await mount($)
    expect(await ui.drawn()).toEqual(beneath)
    expect(state.rows).toEqual([60])
    expect(state.writes).toBe(0)
    await ui.unmount()
  })

  test('quiz follows workbench, wraps to body width and preserves the pinned viewport', async ($, on) => {
    const { state, clock } = fixture(on)
    await submit($)
    await clock.settle()
    const writes = state.writes
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: 'WORKBENCH ORIGINAL' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: question.question }))?.props).toMatchObject({ wrap: 'wrap' })
    expect((await ui.find({ type: 'Box', text: question.question }))?.text).toContain('WORKBENCH ORIGINAL')
    const tree = await ui.drawn()
    expect('children' in tree && tree.children?.[0]).toEqual(beneath)
    expect(state.rows.at(-1)).toBe(60)
    expect((await ui.findAll({ type: 'Box' })).some(box => box.props.width === 40)).toBe(true)
    expect(state.writes).toBe(writes)
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(button => button.props.hotkey)).toEqual(['1', '2', '3', '4', 'x', 'q'])
    await ui.unmount()
  })

  test('an absent viewport stays absent while the quiz still draws', async ($, on) => {
    const { state, clock } = fixture(on)
    await submit($)
    await clock.settle()
    const { viewport, ...withoutViewport } = pane
    const ui = await $.ui.mount({ plugin: 'duo-quiz', surface: 'terminal', ...withoutViewport })
    expect(state.rows.at(-1)).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: question.question })).toBeDefined()
    await ui.unmount()
  })

  test('a state read error leaves workbench intact', async ($, on) => {
    fixture(on)
    on('state.get', { plugin: 'duo-quiz', key: 'quiz' }, () => ({ deny: 'state unavailable' }))
    const ui = await mount($)
    expect(await ui.drawn()).toEqual(beneath)
    await ui.unmount()
  })
})
