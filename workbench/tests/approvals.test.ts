import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

const PANE = {
  component: 'Pane', requestId: 'workbench',
  props: { title: 'Workbench', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
type Pending = { id: string; command: string; who: string; agentId?: string }
type Held = Pending & { secondsLeft: number | null; summary: string }
type Approval = { id: string; decision: 'proceed' | 'cancel'; at: number }

function fixture(on: On, held: Held | null, waiting: Pending[] = []) {
  const state = { held, waiting, agents: [] as { id: string; label: string; status: string; description: string }[], approvals: undefined as Approval[] | undefined }
  mock.clock(on, { now: 1_000 })
  on('state.get', ($, e, next) => e.plugin === 'blast-radius'
    ? { value: { value: e.key === 'held' ? state.held : state.waiting, version: 1 } }
    : e.plugin === 'workbench' && e.key === 'agents' ? { value: { value: state.agents, version: 1 } }
    : next(e))
  on('state.set', ($, e, next) => {
    if (e.plugin === 'workbench' && e.key === 'approvals') state.approvals = e.value as Approval[]
    return next(e)
  })
  return state
}

const mount = ($: Engine, surface: RenderSurface = 'terminal') => $.ui.mount({ plugin: 'workbench', surface, ...PANE })
const held = (agentId?: string): Held => ({ id: 'held', command: 'git push --force', who: '에이전트: Explore', agentId, secondsLeft: 42, summary: '강제 푸시 요약' })

describe('workbench blast-radius approvals', () => {
  test('the held approval is under the matching agent, with countdown and summary', async ($, on) => {
    const state = fixture(on, held('worker'))
    state.agents = [
      { id: 'other', label: 'Other', status: 'running', description: '' },
      { id: 'worker', label: 'Explore', status: 'running', description: 'inspect' },
    ]
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /^에이전트$/ })).toBeDefined()
    expect((await ui.find({ type: 'Box', key: 'agent-worker' }))?.text).toContain('승인 대기: git push --force')
    expect((await ui.find({ type: 'Box', key: 'agent-other' }))?.text).not.toContain('승인 대기:')
    expect(await ui.find({ type: 'Text', text: '42초 후 자동 취소' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '강제 푸시 요약' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^승인 대기:/ }))?.props).toMatchObject({ color: 'warning', wrap: 'wrap' })
    await ui.unmount()
  })

  test('main approvals come first and waiting calls get buttons', async ($, on) => {
    const state = fixture(on, held(), [{ id: 'waiting', command: 'Read .env', who: '메인' }])
    state.agents = [{ id: 'worker', label: 'Explore', status: 'running', description: '' }]
    const ui = await mount($)
    const main = await ui.find({ type: 'Box', key: 'approval-main' })
    expect(main?.text).toContain('메인승인 대기: git push --force')
    expect(main?.text).toContain('승인 대기: Read .env')
    const rows = await ui.findAll({ type: 'Text' })
    expect(rows.findIndex(row => row.text === '메인')).toBeLessThan(rows.findIndex(row => row.text.includes('Explore')))
    expect(await ui.find({ type: 'Button', key: 'approval-proceed-waiting', text: '진행' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'approval-cancel-waiting', text: '취소' })).toBeDefined()
    await ui.unmount()
  })

  test('an agent missing from the finished list is still shown with who', async ($, on) => {
    fixture(on, null, [{ id: 'waiting', command: 'Read .env', who: '에이전트: Finished', agentId: 'gone' }])
    const ui = await mount($)
    const row = await ui.find({ type: 'Box', key: 'approval-agent-gone' })
    expect(row?.text).toContain('에이전트: Finished')
    expect(row?.text).toContain('승인 대기: Read .env')
    expect(await ui.find({ type: 'Text', text: '실행 중인 에이전트 없음' })).toBeUndefined()
    await ui.unmount()
  })

  test('approval commands are single-line and capped at 100 characters', async ($, on) => {
    const command = `git push --force\n${'x'.repeat(120)}`
    fixture(on, { ...held(), command })
    const ui = await mount($)
    const row = await ui.find({ type: 'Text', text: /^승인 대기:/ })
    expect(row?.text).toBe(`승인 대기: ${command.replace(/\n/g, ' ⏎ ').slice(0, 99)}…`)
    await ui.unmount()
  })

  test('pressing proceed writes the decision to workbench approvals', async ($, on) => {
    const state = fixture(on, held())
    const ui = await mount($)
    await ui.press({ key: 'approval-proceed-held' })
    expect(state.approvals).toEqual([{ id: 'held', decision: 'proceed', at: 1_000 }])
    await ui.unmount()
  })

  test('waiting decisions keep only the newest 20, and a call that left both lists keeps its decision', async ($, on) => {
    const waiting = Array.from({ length: 21 }, (_, i) => ({ id: `waiting-${i}`, command: 'Read .env', who: '메인' }))
    const state = fixture(on, held(), waiting)
    const ui = await mount($)
    for (const call of waiting) await ui.press({ key: `approval-proceed-${call.id}` })
    const first = state.approvals!
    expect(first.length).toBe(20)
    expect(first[0]?.id).toBe('waiting-1')
    expect(first[19]?.id).toBe('waiting-20')
    state.waiting = [waiting[20]!]
    await ui.press({ key: 'approval-cancel-held' })
    expect(state.approvals?.length).toBe(20)
    expect(state.approvals?.some(entry => entry.id === 'waiting-5')).toBe(true)
    expect(state.approvals?.at(-1)).toEqual({ id: 'held', decision: 'cancel', at: 1_000 })
    await ui.unmount()
  })

  test('a later press replaces the decision for that id', async ($, on) => {
    const state = fixture(on, held())
    const ui = await mount($)
    await ui.press({ key: 'approval-proceed-held' })
    await ui.press({ key: 'approval-cancel-held' })
    expect(state.approvals).toEqual([{ id: 'held', decision: 'cancel', at: 1_000 }])
    await ui.unmount()
  })

  test('a stale drawn button cannot record a decision for a finished hold', async ($, on) => {
    const state = fixture(on, held())
    const ui = await mount($)
    await ui.press({ key: 'approval-proceed-held' })
    state.held = null
    await ui.press({ key: 'approval-cancel-held' })
    expect(state.approvals).toEqual([])
    await ui.unmount()
  })

  test('mobile shows the same approval facts without buttons', async ($, on) => {
    const state = fixture(on, held('worker'), [{ id: 'waiting', command: 'Read .env', who: '메인' }])
    state.agents = [{ id: 'worker', label: 'Explore', status: 'running', description: '' }]
    const ui = await mount($, 'mobile')
    expect((await ui.find({ type: 'Box', key: 'agent-worker' }))?.text).toContain('승인 대기: git push --force')
    expect((await ui.find({ type: 'Box', key: 'approval-main' }))?.text).toContain('승인 대기: Read .env')
    expect(await ui.find({ type: 'Text', text: '42초 후 자동 취소' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '강제 푸시 요약' })).toBeDefined()
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    expect(state.approvals).toBeUndefined()
    await ui.unmount()
  })
})
