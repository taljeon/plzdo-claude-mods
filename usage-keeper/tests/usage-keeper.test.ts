import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, PromptSubmitInput, SessionUsage } from 'claude-code'

import { bandText, cacheHitPercent, formatDuration } from '../hooks/format'
import { GIT_STATE_SCRIPT, HANDOFF_INSTRUCTIONS, HANDOFF_SECTIONS, handoffDocument, MAX_FILES, parseGitState } from '../hooks/handoff'

const HOUR = 3_600_000
const START = Date.parse('2026-10-07T00:00:00Z')

function usage(tokens: number, resetsAt?: string): SessionUsage {
  return {
    startedAt: START,
    context: { tokens, window: 200_000, percent: Math.round((tokens / 200_000) * 100) },
    rateLimits: resetsAt ? [{ kind: 'five_hour', percentUsed: 40, resetsAt }] : [],
  }
}

// Stands in for the engine's own handling beneath the plugin.
function engine(on: On, prompts?: PromptSubmitInput[], drop?: string) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => {
    prompts?.push(e)
    return drop === undefined ? { text: e.text, origin: e.origin } : { drop }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: 'sid' }))
  on('session.cwd', () => ({ value: '/w' }))
}

const TURN = { answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const

describe('format', () => {
  test('durations and band text', async () => {
    expect(formatDuration(55 * 60_000)).toBe('55m')
    expect(formatDuration(2 * HOUR + 10 * 60_000)).toBe('2h10m')
    const text = bandText(
      { fiveHour: { percentUsed: 23, resetsAt: new Date(START + HOUR).toISOString() }, contextPercent: 34 },
      START + 30 * 60_000,
      START,
    )
    expect(text).toBe('5h 23% 리셋 1h0m · ctx 34% · 핸드오프 30m')
  })

  test('cache hit share', async () => {
    expect(cacheHitPercent({ input_tokens: 2_000, cache_read_input_tokens: 198_000, cache_creation_input_tokens: 0 })).toBe(99)
    expect(cacheHitPercent({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(undefined)
    expect(bandText({ contextPercent: 10, cacheHitPercent: 42 }, null, START)).toBe('ctx 10% · 캐시 42%')
  })

  test('the next keep-alive shows a maintenance countdown', async () => {
    expect(bandText(null, START + 55 * 60_000, START, true)).toBe('유지 55m')
    expect(bandText(null, START + 55 * 60_000, START, false)).toBe('핸드오프 55m')
  })
})

describe('idle handoff', () => {
  test('sends three keep-alives by default, then compacts at the fourth idle deadline', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.store(on)
    const prompts: PromptSubmitInput[] = []
    engine(on, prompts)
    mock.env(on, {})
    let compactions = 0
    on('session.usage', () => ({ value: usage(80_000) }))
    on('session.compact', () => {
      compactions += 1
      return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
    })

    await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
    await $.turn.complete(TURN)
    for (let count = 1; count <= 3; count += 1) {
      await clock.advance(55 * 60_000)
      expect(prompts).toHaveLength(count)
      expect(prompts[count - 1]?.text).toBe('Keep-alive. Reply "ok" only.')
      expect(prompts[count - 1]?.origin).toEqual({ kind: 'plugin', name: 'usage-keeper' })
      expect(compactions).toBe(0)
      await $.turn.complete(TURN)
    }
    await clock.advance(55 * 60_000)
    expect(prompts).toHaveLength(3)
    expect(compactions).toBe(1)
  })

  test('a user prompt resets the keep-alive count before the next handoff', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.store(on)
    const prompts: PromptSubmitInput[] = []
    engine(on, prompts)
    mock.env(on, {})
    let compactions = 0
    on('session.usage', () => ({ value: usage(80_000) }))
    on('session.compact', () => {
      compactions += 1
      return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
    })

    await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
    await $.turn.complete(TURN)
    for (let count = 1; count <= 2; count += 1) {
      await clock.advance(55 * 60_000)
      expect(prompts).toHaveLength(count)
      expect(compactions).toBe(0)
      await $.turn.complete(TURN)
    }
    await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    await $.turn.complete(TURN)
    for (let count = 1; count <= 3; count += 1) {
      await clock.advance(55 * 60_000)
      expect(prompts.filter(prompt => prompt.origin.kind === 'plugin')).toHaveLength(2 + count)
      expect(compactions).toBe(0)
      await $.turn.complete(TURN)
    }
    await clock.advance(55 * 60_000)
    expect(prompts.filter(prompt => prompt.origin.kind === 'plugin')).toHaveLength(5)
    expect(compactions).toBe(1)
  })

  test('a dropped keep-alive falls through to the handoff', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.store(on)
    const prompts: PromptSubmitInput[] = []
    engine(on, prompts, 'busy')
    mock.env(on, {})
    let compactions = 0
    on('session.usage', () => ({ value: usage(80_000) }))
    on('session.compact', () => {
      compactions += 1
      return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
    })

    await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
    await $.turn.complete(TURN)
    await clock.advance(55 * 60_000)
    expect(prompts).toHaveLength(1)
    expect(compactions).toBe(1)
  })

  test('compacts after 55 idle minutes and saves the summary', { options: { keepAlives: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.store(on)
    engine(on)
    mock.env(on, { HOME: '/home/u' })
    let compactions = 0
    const written: string[] = []
    const instructions: (string | undefined)[] = []
    const gitCwd: (string | undefined)[] = []
    on('session.usage', () => ({ value: usage(80_000) }))
    on('session.compact', (_$, e) => {
      compactions += 1
      instructions.push(e.instructions)
      return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
    })
    on('process.run', (_$, e) => {
      if (e.argv.at(-1) === GIT_STATE_SCRIPT) gitCwd.push(e.init?.cwd)
      return { value: { exitCode: 0, stdout: 'B main\nH abc123 fix x\nA 2\nS  M a.ts\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('fs.write', (_$, e) => {
      written.push(`${e.path}\n${e.text}`)
      return { value: undefined }
    })

    await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
    await $.turn.complete(TURN)
    await clock.advance(54 * 60_000)
    expect(compactions).toBe(0)
    await clock.advance(2 * 60_000)
    expect(compactions).toBe(1)
    expect(written[0]).toContain('/home/u/.claude/handoffs/')
    expect(written[0]).toContain('SUMMARY')
    expect(instructions[0]).toBe(HANDOFF_INSTRUCTIONS)
    expect(gitCwd).toEqual(['/w'])
    expect(written[0]).toContain('- branch: main\n- last commit: abc123 fix x\n- unpushed commits: 2\n- uncommitted files (1):\n  -  M a.ts')
  })

  test('a failed git read still saves the summary, without a git section', { options: { keepAlives: 0 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.store(on)
    engine(on)
    mock.env(on, { HOME: '/home/u' })
    const written: string[] = []
    on('session.usage', () => ({ value: usage(80_000) }))
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }))
    on('process.run', () => { throw new Error('no bash') })
    on('fs.write', (_$, e) => {
      written.push(e.text)
      return { value: undefined }
    })

    await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
    await $.turn.complete(TURN)
    await clock.advance(56 * 60_000)
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('SUMMARY')
    expect(written[0]).not.toContain('## Git')
  })

  test('a new prompt cancels the countdown', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.store(on)
    engine(on)
    let compactions = 0
    on('session.usage', () => ({ value: usage(80_000) }))
    on('session.compact', () => {
      compactions += 1
      return { messages: [] }
    })

    await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
    await $.turn.complete(TURN)
    await clock.advance(30 * 60_000)
    await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    await clock.advance(30 * 60_000)
    expect(compactions).toBe(0)
  })

  test('a small context is left alone', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.store(on)
    engine(on)
    let compactions = 0
    on('session.usage', () => ({ value: usage(5_000) }))
    on('session.compact', () => {
      compactions += 1
      return { messages: [] }
    })

    await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
    await $.turn.complete(TURN)
    await clock.advance(60 * 60_000)
    expect(compactions).toBe(0)
  })
})

describe('handoff document', () => {
  test('instructions name every section in order and cap the length', () => {
    let at = -1
    for (const name of HANDOFF_SECTIONS) {
      const i = HANDOFF_INSTRUCTIONS.indexOf(`## ${name}`)
      expect(i, name).toBeGreaterThan(at)
      at = i
    }
    expect(HANDOFF_INSTRUCTIONS).toContain('at most 300 words')
  })

  test('git state: outside a repo, no upstream, unchecked status, long file lists', () => {
    expect(parseGitState('')).toBeUndefined()
    const noUpstream = parseGitState('B main\nH \nA ?\n')!
    expect(handoffDocument({ cwd: '/w', savedAt: 'T', git: noUpstream, summary: 'S' })).toBe(
      '# Handoff\n\ncwd: /w\nsaved: T\n\n## Git (read by usage-keeper, not by Claude)\n- branch: main\n- last commit: none\n- unpushed commits: unknown (no upstream)\n- uncommitted files: none\n\nS\n')
    expect(handoffDocument({ cwd: '/w', savedAt: 'T', git: parseGitState('B main\nA 0\nS?')!, summary: 'S' })).toContain('not checked')
    const many = parseGitState(['B main', 'A 0', ...Array.from({ length: MAX_FILES + 3 }, (_, i) => `S ?? f${i}`)].join('\n'))!
    const doc = handoffDocument({ cwd: '/w', savedAt: 'T', git: many, summary: 'S' })
    expect(doc).toContain(`uncommitted files (${MAX_FILES + 3})`)
    expect(doc).toContain('...and 3 more')
    expect(doc).not.toContain(`f${MAX_FILES}\n`)
    expect(handoffDocument({ cwd: '/w', savedAt: 'T', summary: 'S' })).toBe('# Handoff\n\ncwd: /w\nsaved: T\n\nS\n')
  })
})

describe('reset ping', () => {
  test('pings haiku once, a minute after the 5-hour window resets', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.store(on)
    engine(on)
    const resetsAt = new Date(START + HOUR).toISOString()
    const models: string[] = []
    on('session.usage', () => ({ value: usage(1_000, resetsAt) }))
    on('model.complete', (_$, e) => {
      models.push(e.model)
      return {
        value: {
          isAnswered: true,
          text: 'pong',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }
    })

    await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
    await clock.advance(HOUR)
    expect(models).toEqual([])
    await clock.advance(2 * 60_000)
    expect(models).toEqual(['haiku'])
    await $.session.measure({ context: { window: 200_000 }, rateLimits: usage(1_000, resetsAt).rateLimits, changed: ['rateLimits'] })
    await clock.advance(HOUR)
    expect(models).toEqual(['haiku'])
  })
})

describe('reset ping edge cases', () => {
  test('a failed ping is not retried for the same reset', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.store(on)
    engine(on)
    const resetsAt = new Date(START + HOUR).toISOString()
    let calls = 0
    on('session.usage', () => ({ value: usage(1_000, resetsAt) }))
    on('model.complete', () => {
      calls += 1
      return {
        value: {
          isAnswered: false,
          reason: 'api-error',
          status: 529,
          error: 'overloaded',
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }
    })

    await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
    await clock.advance(HOUR + 2 * 60_000)
    await $.session.measure({ context: { window: 200_000 }, rateLimits: usage(1_000, resetsAt).rateLimits, changed: ['rateLimits'] })
    await clock.advance(HOUR)
    expect(calls).toBe(1)
  })

  test('an older reading does not pull the ping back to a passed window', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const newer = new Date(START + HOUR).toISOString()
    const older = new Date(START - 2 * HOUR).toISOString()
    mock.store(on, { pingedResets: [older], fiveHourResetsAt: newer })
    engine(on)
    let calls = 0
    on('session.usage', () => ({ value: usage(1_000, older) }))
    on('model.complete', () => {
      calls += 1
      return {
        value: {
          isAnswered: true,
          text: 'pong',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }
    })

    await $.session.start({ cwd: '/w', surface: null, isInteractive: true })
    await clock.advance(30 * 60_000)
    expect(calls).toBe(0)
    await clock.advance(HOUR)
    expect(calls).toBe(1)
  })
})
