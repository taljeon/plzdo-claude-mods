import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, Args, On, PluginState, RenderSurface, ResultOf, UiPane } from 'claude-code'
import { callText } from '../hooks/parse'

const mount = ($: Engine, surface: RenderSurface = 'terminal') => $.ui.mount({
  plugin: 'workbench', surface, component: 'Pane', requestId: 'workbench',
  props: { title: 'Workbench', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
})
const placedPane: UiPane = { id: 'workbench', title: 'Workbench', isPlaced: true, isShown: true, isFocused: true }
const ruleVerdict: ResultOf['tool.check'] = { decision: 'ask', reason: 'Settings ask rule', rule: 'Bash(rm -rf:*)' }
const ruleCall = { tool: 'Bash', input: { command: 'rm -rf ./build' }, tool_use_id: 'rule-call' }
const answer = (decision: 'allow' | 'deny') => ({ decision, reason: decision === 'allow'
  ? 'Allowed from the workbench pane.' : 'The user pressed 거절 in the workbench pane.' })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

function fixture(on: On, verdict = ruleVerdict) {
  type State = PluginState['workbench']
  const cells = new Map<string, { value: unknown; version: number }>()
  let sleeping = deferred()
  const state = {
    get: <K extends keyof State>(key: K) => cells.get(key)?.value as State[K] | undefined,
    set: <K extends keyof State>(key: K, value: State[K]) => {
      cells.set(key, { value, version: (cells.get(key)?.version ?? 0) + 1 })
    },
    sleeps: [] as ReturnType<typeof deferred>[], opened: [] as Args<'ui.open'>[], aborted: [] as string[],
    surfaces: ['terminal'] as RenderSurface[], panes: [placedPane], agentList: [] as AgentInfo[],
    clock: mock.clock(on, { now: 1_000 }),
    async waitForSleeps(count = 1) {
      while (state.sleeps.length < count) await sleeping.promise
    },
  }
  on('session.surfaces', () => ({ value: state.surfaces }))
  on('ui.panes', () => ({ value: state.panes }))
  on('agent.list', () => ({ value: state.agentList }))
  on('state.get', ($, e, next) => e.plugin === 'workbench'
    ? { value: cells.get(e.key) ?? { value: undefined, version: 0 } } : next(e))
  on('state.set', ($, e, next) => {
    if (e.plugin !== 'workbench') return next(e)
    const version = cells.get(e.key)?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    cells.set(e.key, { value: e.value, version: version + 1 })
    return { value: { isSet: true, version: version + 1 } }
  })
  on('process.run', async ($, e) => {
    if (e.argv[0] === 'sleep') {
      expect(e.argv).toEqual(['sleep', '0.25'])
      const pause = deferred()
      state.sleeps.push(pause)
      sleeping.resolve()
      sleeping = deferred()
      await pause.promise
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.check', () => verdict)
  on('ui.open', ($, e) => { state.opened.push(e); return { value: { isPlaced: true } } })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.abort', ($, e) => { state.aborted.push(e.turnId); return { value: undefined } })
  return state
}

describe('workbench pane-only rule asks', () => {
  test('holds and draws a rule ask without focus; a press answers it and hides its buttons', async ($, on) => {
    const state = fixture(on)
    const full = `rm -rf ./${'x'.repeat(300)}\nsecond line`
    const result = $.tool.check({ ...ruleCall, input: { command: full } })
    await state.waitForSleeps()
    const ask = state.get('permissions')![0]!
    expect(ask).toEqual({ id: ask.id, tool: 'Bash', rule: ruleVerdict.rule, text: `Bash ${full}`, at: 1_000 })
    expect(state.opened).toEqual([])
    const ui = await mount($)
    expect((await ui.find({ key: 'approval-main' }))?.text).toContain(`메인승인 요청: Bash ${full}`)
    expect((await ui.find({ type: 'Text', text: `승인 요청: Bash ${full}` }))?.props).toMatchObject({ color: 'warning', wrap: 'wrap' })
    expect((await ui.find({ type: 'Text', text: '규칙 Bash(rm -rf:*) · 30초 후 채팅 창으로' }))?.props).toMatchObject({ dimColor: true })
    expect((await ui.find({ key: `permission-allow-${ask.id}` }))?.props).toMatchObject({ plain: true })
    expect((await ui.find({ key: `permission-deny-${ask.id}` }))?.props).toMatchObject({ variant: 'primary', autoFocus: true })
    await state.clock.advance(4_000)
    // The fixture owns state.set, so redraw as the real poll does.
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: '규칙 Bash(rm -rf:*) · 26초 후 채팅 창으로' })).toBeDefined()
    expect(state.get('permissions')).toEqual([ask])
    await ui.press({ key: `permission-allow-${ask.id}` })
    // The press reaches the hook through module memory, and the answered row goes at once, so no second press.
    await ui.redraw()
    expect(await ui.find({ key: `permission-deny-${ask.id}` })).toBeUndefined()
    state.sleeps[0]!.resolve()
    expect(await result).toEqual(answer('allow'))
    expect(state.get('permissions')).toEqual([])
    await ui.unmount()
  })

  test('main refusal aborts the tracked main turn, ignoring subagent starts', async ($, on) => {
    const state = fixture(on)
    await $.turn.start({ text: 'old', turnId: 'old-turn' })
    await $.turn.start({ text: 'main', turnId: 'main-turn' })
    await $.turn.start({ text: 'agent', turnId: 'agent-turn', agentId: 'worker' })
    const result = $.tool.check(ruleCall)
    await state.waitForSleeps()
    const ui = await mount($)
    await ui.press({ key: `permission-deny-${state.get('permissions')![0]!.id}` })
    state.sleeps[0]!.resolve()
    expect(await result).toEqual(answer('deny'))
    expect(state.aborted).toEqual(['main-turn'])
    expect(state.get('permissions')).toEqual([])
    await ui.unmount()
  })

  for (const known of [true, false]) {
    test(`subagent refusal stays in its ${known ? 'agent' : 'missing agent'} group and never aborts main`, async ($, on) => {
      const state = fixture(on)
      if (known) {
        state.agentList = [{ id: 'worker', type: 'Explore', name: 'A', status: 'running', description: '' }]
        state.set('agents', [{ id: 'worker', label: 'A', status: 'running', description: '' }])
      }
      await $.turn.start({ text: 'main', turnId: 'main-turn' })
      const result = $.tool.check({ ...ruleCall, agentId: 'worker' })
      await state.waitForSleeps()
      const ask = state.get('permissions')![0]!
      expect(ask.text).toBe(`Bash [${known ? '에이전트: Explore' : '에이전트'}] rm -rf ./build`)
      const ui = await mount($)
      expect((await ui.find({ key: known ? 'agent-worker' : 'approval-agent-worker' }))?.text).toContain(ask.text)
      expect(await ui.find({ key: 'approval-main' })).toBeUndefined()
      await ui.press({ key: `permission-deny-${ask.id}` })
      state.sleeps[0]!.resolve()
      expect(await result).toEqual(answer('deny'))
      expect(state.aborted).toEqual([])
      await ui.unmount()
    })
  }

  test('30 s timeout returns the original verdict and removes the entry', async ($, on) => {
    const state = fixture(on)
    const result = $.tool.check(ruleCall)
    await state.waitForSleeps()
    await state.clock.advance(30_000)
    state.sleeps[0]!.resolve()
    expect(await result).toEqual(ruleVerdict)
    expect(state.get('permissions')).toEqual([])
  })

  for (const decision of ['allow', 'deny'] as const) {
    test(`${decision} recorded before the deadline counts when read after it`, async ($, on) => {
      const state = fixture(on)
      await $.turn.start({ text: 'main', turnId: 'main-turn' })
      const result = $.tool.check(ruleCall)
      await state.waitForSleeps()
      const ui = await mount($)
      await state.clock.advance(29_999)
      await ui.press({ key: `permission-${decision}-${state.get('permissions')![0]!.id}` })
      await state.clock.advance(2)
      state.sleeps[0]!.resolve()
      expect(await result).toEqual(answer(decision))
      expect(state.aborted).toEqual(decision === 'deny' ? ['main-turn'] : [])
      expect(state.get('permissions')).toEqual([])
      await ui.unmount()
    })
  }

  for (const elapsed of [30_000, 30_001]) {
    test(`a stale button at ${elapsed} ms records no decision`, async ($, on) => {
      const state = fixture(on)
      const result = $.tool.check(ruleCall)
      await state.waitForSleeps()
      const ask = state.get('permissions')![0]!
      const ui = await mount($)
      await state.clock.advance(elapsed)
      await ui.press({ key: `permission-allow-${ask.id}` })
      await ui.press({ key: `permission-deny-${ask.id}` })
      expect(state.get('permissions')).toEqual([ask])
      state.sleeps[0]!.resolve()
      expect(await result).toEqual(ruleVerdict)
      expect(state.get('permissions')).toEqual([])
      await ui.unmount()
    })
  }

  const passThrough: { name: string; verdict?: ResultOf['tool.check']; call?: Args<'tool.check'> }[] = [
    { name: 'no rule', verdict: { decision: 'ask', reason: 'mode ask' } },
    { name: 'blank rule', verdict: { ...ruleVerdict, rule: '  ' } },
    { name: 'allow', verdict: { ...ruleVerdict, decision: 'allow' } },
    { name: 'deny', verdict: { ...ruleVerdict, decision: 'deny' } },
    { name: 'decider', verdict: { ...ruleVerdict, decider: 'host' } },
    { name: 'hook', verdict: { ...ruleVerdict, hook: 'PreToolUse' } },
    { name: 'ceiling', call: { ...ruleCall, ceiling: 'ask' }, verdict: { ...ruleVerdict, ceiling: 'ask' } },
    { name: 'setting', verdict: { ...ruleVerdict, setting: 'additionalDirectories' } },
    { name: 'dontAsk mode' },
    { name: 'no tool_use_id', call: { tool: ruleCall.tool, input: ruleCall.input } },
    { name: 'pane not placed' }, { name: 'no surface' },
  ]
  for (const { name, verdict = ruleVerdict, call = ruleCall } of passThrough) {
    test(`${name} leaves the verdict untouched and draws nothing`, async ($, on) => {
      const state = fixture(on, verdict)
      if (name === 'pane not placed') state.panes = [{ ...placedPane, isPlaced: false }]
      if (name === 'no surface') state.surfaces = []
      if (name === 'dontAsk mode') {
        on('classic.UserPromptSubmit', () => ({}))
        await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'dontAsk' })
      }
      expect(await $.tool.check(call)).toEqual(verdict)
      expect(state.get('permissions') ?? []).toEqual([])
      expect(state.sleeps).toEqual([])
      expect(state.opened).toEqual([])
      const ui = await mount($)
      expect(await ui.find({ key: 'approval-main' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', text: '승인' })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('signal abort returns the original verdict even with a recorded press', {
    plugins: [{ name: 'abort-rule', tier: 'prepend', register(on) {
      on('tool.check', async ($, e, next) => {
        void next(e).then(result => $.store.set('aborted-rule-result', result))
        await $.clock.sleep(1_000)
        return { decision: 'ask', reason: 'Settings ask rule', rule: 'Bash(rm -rf:*)' }
      })
    } }],
  }, async ($, on) => {
    const state = fixture(on)
    const returned = deferred()
    let observed: unknown
    on('store.set', ($, e) => { observed = e.value; returned.resolve(); return { value: undefined } })
    const result = $.tool.check(ruleCall)
    await state.waitForSleeps()
    const ui = await mount($)
    await ui.press({ key: `permission-allow-${state.get('permissions')![0]!.id}` })
    await state.clock.advance(1_000)
    expect(await result).toEqual(ruleVerdict)
    state.sleeps[0]!.resolve()
    await returned.promise
    expect(observed).toEqual(ruleVerdict)
    expect(state.get('permissions')).toEqual([])
    await ui.unmount()
  })

  test('mobile is read-only; expired leftover entries disappear on redraw', async ($, on) => {
    const state = fixture(on)
    const entry = { id: 'leftover', tool: 'Bash', text: 'Bash rm -rf ./build', rule: ruleVerdict.rule!, at: 1_000 }
    state.set('permissions', [entry])
    const mobile = await mount($, 'mobile')
    expect(await mobile.find({ key: 'permission-leftover' })).toBeDefined()
    expect(await mobile.find({ type: 'Button' })).toBeUndefined()
    await state.clock.advance(30_000)
    await mobile.redraw()
    expect(await mobile.find({ key: 'approval-main' })).toBeUndefined()
    const terminal = await mount($)
    expect(await terminal.find({ key: 'permission-leftover' })).toBeUndefined()
    await mobile.unmount()
    await terminal.unmount()
  })

  test('session.start clears permissions and resets the tracked turn', async ($, on) => {
    const state = fixture(on)
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.turn.start({ text: 'old', turnId: 'old-turn' })
    state.set('permissions', [{ id: 'old', tool: 'Bash', text: 'old', rule: 'Bash(*)', at: 1_000 }])
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    expect(state.get('permissions')).toEqual([])
    const result = $.tool.check(ruleCall)
    await state.waitForSleeps()
    const ui = await mount($)
    await ui.press({ key: `permission-deny-${state.get('permissions')![0]!.id}` })
    state.sleeps[0]!.resolve()
    expect(await result).toEqual(answer('deny'))
    expect(state.aborted).toEqual([])
    await ui.unmount()
  })

  test('permission text keeps primary inputs and flags, shortening only extra JSON strings', () => {
    const long = 'x'.repeat(207)
    expect(callText('Bash', { command: `${long}\nsecond line`, dangerouslyDisableSandbox: true, run_in_background: true }))
      .toBe(`Bash [샌드박스 해제] [백그라운드] ${long}\nsecond line`)
    expect(callText('Read', { file_path: long, offset: 2 })).toBe(`Read ${long} {"offset":2}`)
    expect(callText('Custom', { query: long, active: false, count: 0, cursor: null }))
      .toBe(`Custom {"query":"${long.slice(0, 200)}…(+7자)","active":false,"count":0,"cursor":null}`)
  })
})
