import { describe, expect, mock, test } from 'claude-code/testing'

import { callSummary, clipDiff, codexState, elapsed, fileLabel, lastMarker, lastResult, metaLabel, parseNumstat, parseStatus, STALL_MS } from '../hooks/parse'

describe('git output', () => {
  test('status keeps untracked, staged and renamed entries', async () => {
    const raw = ' M src/a.ts\0A  new file.ts\0?? scratch.md\0R  b.ts\0old b.ts\0'
    const files = parseStatus(raw)
    expect(files.map(f => f.path)).toEqual(['src/a.ts', 'new file.ts', 'scratch.md', 'b.ts'])
    expect(files[0]).toMatchObject({ index: ' ', worktree: 'M' })
    expect(files[2]).toMatchObject({ index: '?', worktree: '?' })
  })

  test('numstat reads counts, binary files and renames', async () => {
    const raw = ['3\t1\tsrc/a.ts', '-\t-\timg.png', '0\t0\t', 'old.ts', 'new.ts', ''].join('\0')
    const counts = parseNumstat(raw)
    expect(counts.get('src/a.ts')).toEqual({ added: 3, removed: 1 })
    expect(counts.get('img.png')).toEqual({ added: 0, removed: 0 })
    expect(counts.has('new.ts')).toBe(true)
  })

  test('labels show the status code and the delta', async () => {
    expect(fileLabel({ path: 'a.ts', index: ' ', worktree: 'M', added: 2, removed: 1 })).toBe('M  a.ts +2 -1')
    expect(fileLabel({ path: 'n.md', index: '?', worktree: '?', added: 0, removed: 0 })).toBe('?? n.md')
  })

  test('the git header is dropped so the pane reads hunks', async () => {
    const raw = 'diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n'
    expect(clipDiff(raw, 10)).toEqual({ text: '@@ -0,0 +1 @@\n+hi', hidden: 0 })
    expect(clipDiff('', 10)).toEqual({ text: '', hidden: 0 })
  })

  test('a cut hunk gets counts that match the lines kept', async () => {
    const raw = ['@@ -1,4 +1,5 @@', ' a', '-b', '+B', '+C', ' d', '@@ -20,1 +21,1 @@', '-x', '+y'].join('\n')
    expect(clipDiff(raw, 4)).toEqual({ text: '@@ -1,2 +1,2 @@\n a\n-b\n+B', hidden: 5 })
    // a cut that would leave a bare header drops it
    expect(clipDiff(raw, 7).text.endsWith(' d')).toBe(true)
  })
})

describe('codex rollout', () => {
  const started = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })
  const done = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
  const noise = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } })

  test('the last turn marker wins, noise and a cut first line are skipped', async () => {
    expect(lastMarker(`{"cut":\n${started}\n${noise}`)).toBe('started')
    expect(lastMarker(`${started}\n${done}\n${noise}`)).toBe('complete')
    expect(lastMarker(noise)).toBe(null)
  })

  test('the result is the first plain line of the last finished answer', () => {
    const answer = (text: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: text } })
    expect(lastResult(`${answer('old')}\n${answer('**→ No merge-blocking problems found.**\n\nAll 7 tests passed.')}\n${noise}`)).toBe('No merge-blocking problems found.')
    expect(lastResult(`${started}\n${noise}`)).toBe('')
    expect(lastResult(answer('x'.repeat(100)), 10)).toBe(`${'x'.repeat(9)}…`)
    expect(lastResult(answer('Block merge: keep user_id > 0.'))).toBe('Block merge: keep user_id > 0.')
    expect(lastResult(answer('<heartbeat>'))).toBe('')
  })

  test('a started turn that stops moving is stalled, not running', async () => {
    const now = 10_000_000
    expect(codexState('started', now - 1000, now)).toBe('running')
    expect(codexState('started', now - STALL_MS - 1, now)).toBe('stalled')
    expect(codexState('complete', now - STALL_MS * 4, now)).toBe('done')
    expect(codexState(null, now, now)).toBe('unknown')
  })

  test('the label is the last folder of the run directory', async () => {
    const line = JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/x/proj/app' } })
    expect(metaLabel(line)).toBe('app')
    expect(metaLabel('not json')).toBe('codex')
  })
})

describe('activity and pins', () => {
  test('a running call reads as the tool and its first line, with elapsed time', async () => {
    expect(callSummary('Bash', { command: 'npm test\n--watch' })).toBe('Bash npm test')
    expect(callSummary('Read', { file_path: '/a/b.ts' })).toBe('Read /a/b.ts')
    expect(callSummary('Agent', {})).toBe('Agent')
    expect(elapsed(4_200)).toBe('4s')
    expect(elapsed(125_000)).toBe('2m05s')
  })

  test('/pin stores one key per pin, the approval verdict passes through unchanged', async ($, on) => {
    const saved = new Map<string, unknown>([['pins:/w', [{ id: 'old', text: 'from 0.2.0', at: 1 }]]])
    on('store.get', (_$: any, e: any) => ({ value: saved.get(e.key) }))
    on('store.set', (_$: any, e: any) => {
      saved.set(e.key, e.value)
      return { value: undefined }
    })
    on('store.delete', (_$: any, e: any) => {
      saved.delete(e.key)
      return { value: undefined }
    })
    on('store.keys', () => ({ value: [...saved.keys()] }))
    mock.clock(on)
    on('session.cwd', () => ({ value: '/w' }))
    on('session.id', () => ({ value: 'sid' }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('command.run', () => ({ text: 'core' }))
    on('tool.check', () => ({ decision: 'ask', reason: 'rule' }))

    await $.command.run({ command: 'pin', args: 'pick a db', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as any)
    // Each pin has its own key, and the 0.2.0 array was moved over.
    const pinned = [...saved.entries()].filter(([k]) => k.startsWith('pin:/w\u0000')).map(([, v]) => (v as { text: string }).text)
    expect(pinned.sort()).toEqual(['from 0.2.0', 'pick a db'])
    expect(saved.has('pins:/w')).toBe(false)
    expect(await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).toMatchObject({ decision: 'ask', reason: 'rule' })
  })
})

describe('approval marks', () => {
  test('only a real permission dialog marks the running call', async ($, on) => {
    mock.clock(on)
    // The test engine keeps no state of its own: hold workbench's keys here, versioned as the host does.
    const cells = new Map<string, { value: unknown; version: number }>()
    on('state.get', ($, e: any, next) => (e.plugin === 'workbench' ? { value: cells.get(e.key) ?? { value: undefined, version: 0 } } : next(e)))
    on('state.set', ($, e: any, next) => {
      if (e.plugin !== 'workbench') return next(e)
      const version = (cells.get(e.key)?.version ?? 0) + 1
      cells.set(e.key, { value: e.value, version })
      return { value: { isSet: true as const, version } }
    })
    // The call is held beneath workbench's hook, which has listed it by then, until the test lets it finish.
    let finish = () => {}
    let reached = () => {}
    const isReached = new Promise<void>(resolve => { reached = resolve })
    on('tool.check', () => ({ decision: 'allow' }))
    on('tool.call', () => new Promise(resolve => {
      finish = () => resolve({ result: '' } as any)
      reached()
    }))
    on('classic.PermissionRequest', () => ({}))

    const running = $.tool.call({ tool: 'Bash', command: 'npm test' } as any).catch(() => {})
    const asked = () => ((cells.get('activity')?.value ?? []) as { asked: boolean }[]).map(a => a.asked)
    await isReached
    expect((cells.get('activity')?.value as { summary: string }[])[0]?.summary).toBe('Bash npm test')
    expect(asked()).toEqual([false])

    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } } as any)
    expect(asked()).toEqual([false])
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } } as any)
    expect(asked()).toEqual([true])

    finish()
    await running
  })
})
