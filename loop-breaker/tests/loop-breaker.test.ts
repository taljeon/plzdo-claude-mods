import { describe, expect, mock, test } from 'claude-code/testing'

// The note Claude reads on its next step, as stored in the session.
function notes(session: { appended: () => readonly unknown[] }) {
  return session.appended().filter(r => JSON.stringify(r).includes('<loop-breaker>'))
}

describe('loop-breaker', () => {
  test('the same command failing 3 times leaves Claude one note', async ($, on) => {
    const session = mock.session(on)
    on('ui.toast', () => ({ value: undefined }) as any)
    on('tool.call', () => ({ result: {}, text: 'boom', isError: true }) as any)
    for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
    expect(notes(session)).toHaveLength(1)
  })

  test('a success in between resets the count', async ($, on) => {
    const session = mock.session(on)
    on('ui.toast', () => ({ value: undefined }) as any)
    let n = 0
    on('tool.call', () => ({ result: {}, text: 'x', isError: ++n !== 2 }) as any)
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
    expect(notes(session)).toHaveLength(0)
  })
})
