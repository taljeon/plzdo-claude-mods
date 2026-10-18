import { describe, expect, mock, test } from 'claude-code/testing'
import type { FoundElement } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { HeldCommand, WaitingCall } from '../types'

import { formatDeleteDetail, highlights, isWorthHolding, parseScan } from '../hooks/importance'
import { classify, classifyFileTool, fileTarget, safeClassify, split, timeoutFrom, trustedFoldersFrom } from '../hooks/register'
import { CONTENT_SCRIPT, DELETE_SCRIPT, FILE_SCRIPT, MAX_LISTED, SHELL_ARGV } from '../hooks/script'

// The targets a preview looks at: argv is the shell, its script, the script name and the recursive flag, then the paths.
const AFTER_FLAG = SHELL_ARGV.length + 3

const PANE = { component: 'Pane', requestId: 'blast-radius', props: { title: 'Blast Radius', isFocused: true, bodyColumns: 100, placement: 'dock' } }

// Stands for the engine beneath the mod: tools run, a 9-file build folder, panes that open, a terminal that draws.
// Its clock is the test's: pass one from mock.clock to move it, or the engine makes its own.
function engine(on: any, ran: string[], {
  surfaces = ['terminal'], opened = [] as unknown[], clock = undefined as unknown,
  isPlaced = true, previews = [] as string[][], cwd = '/project', root = '/project',
  previewOutput = undefined as string | undefined, rootExitCode = 0, previewExitCode = 0, queried = [] as string[],
  failOpen = undefined as (() => boolean) | undefined, failContext = false, realCwd = undefined as string | undefined,
  fileMetadata = {} as Record<string, string>, contents = {} as Record<string, string>, contentReads = [] as string[],
  statPaths = {} as Record<string, string | undefined>, statErrors = {} as Record<string, string>,
  agents = [] as { id: string; type: string; name?: string }[], failAgents = false,
} = {}) {
  if (!clock) mock.clock(on)
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.cwd', () => { if (failContext) throw new Error('cwd unavailable'); return { value: cwd } })
  on('fs.stat', (_$: any, e: any) => {
    if (e.path in statErrors) return { deny: statErrors[e.path] }
    const known = { '/': '/', '/home/me/.claude': '/home/me/.claude', '/home/me/.codex': '/home/me/.codex', '/home/me/.agents': '/home/me/.agents',
      ...(realCwd ? { [cwd]: realCwd } : {}), ...statPaths }
    if (!(e.path in known)) return { deny: `ENOENT: ${e.path}` }
    const realPath = known[e.path as keyof typeof known]
    return { value: { kind: realPath === undefined ? 'other' : 'dir', size: 0, mtimeMs: 0, isLink: realPath !== e.path, realPath } }
  })
  on('agent.list', () => {
    if (failAgents) return { deny: 'agents unavailable' }
    return { value: agents.map(agent => ({ description: '', status: 'running', ...agent })) }
  })
  on('session.surfaces', () => ({ value: surfaces }))
  on('tool.call', (_$: any, e: any) => {
    ran.push(e.command ?? e.tool)
    return { result: {}, text: 'ok' }
  })
  on('process.run', async (_$: any, e: any) => {
    const argv: string[] = e.argv
    const isProject = argv[SHELL_ARGV.length]?.includes('git rev-parse --show-toplevel')
    if (isProject) queried.push(e.init?.cwd)
    if (argv[SHELL_ARGV.length] === DELETE_SCRIPT) previews.push(argv.slice(AFTER_FLAG))
    const isMetadata = argv[SHELL_ARGV.length] === FILE_SCRIPT
    const isContent = argv[SHELL_ARGV.length] === CONTENT_SCRIPT
    const path = argv[SHELL_ARGV.length + 2]!
    if (isContent) contentReads.push(path)
    if (argv[0] === 'sleep') await new Promise(done => (globalThis as any).setTimeout(done, 5)) // a real wait, so the hold loop yields
    const stdout = isProject ? root
      : isMetadata ? fileMetadata[path] ?? 'missing'
      : isContent ? path in contents ? Array.from(new TextEncoder().encode(contents[path]!).slice(0, 512)).join(' ') : 'SKIP'
      : argv[0] === SHELL_ARGV[0]
      ? previewOutput ?? ['S 1126', ...Array.from({ length: 9 }, (_, i) => `F build/chunk-${i}.js`)].join('\n')
      : ''
    return { value: { exitCode: isProject ? rootExitCode : argv[0] === SHELL_ARGV[0] ? previewExitCode : 0, stdout, stderr: '' } }
  })
  on('ui.open', (_$: any, e: any) => {
    if (failOpen?.()) throw new Error('cannot open')
    opened.push(e)
    return { value: { isPlaced } }
  })
  on('ui.close', () => ({ value: undefined }))
}

// Mounts the pane until it shows text matching `text` (the hold loop runs on its own).
async function paneShowing($: any, text: RegExp) {
  for (let i = 0; i < 50; i++) {
    const ui = await $.ui.mount({ plugin: 'blast-radius', surface: 'terminal', ...PANE })
    if (await ui.find({ type: 'Text', text })) return ui
    await ui.unmount()
    await new Promise(done => (globalThis as any).setTimeout(done, 5))
  }
  const last = await $.ui.mount({ plugin: 'blast-radius', surface: 'terminal', ...PANE })
  const rows = (await last.findAll({ type: 'Text' })).map((row: FoundElement) => row.text)
  await last.unmount()
  throw new Error(`the pane never showed ${text}: ${JSON.stringify(rows)}`)
}

async function heldPane($: any) {
  for (let i = 0; i < 50; i++) {
    const ui = await $.ui.mount({ plugin: 'blast-radius', surface: 'terminal', ...PANE })
    if (await ui.find({ type: 'Text', text: /명령을 멈춤/ })) return ui
    await ui.unmount()
  }
  throw new Error('nothing was held')
}

const isWorkbenchApprovalRef = (ref: { plugin: string; key: string }) => ref.plugin === 'workbench' && ref.key === 'approvals'

function workbenchApprovals(on: On) {
  const state = { approvals: [] as unknown, held: null as HeldCommand | null, waiting: [] as WaitingCall[] }
  on('state.get', ($, e, next) => isWorkbenchApprovalRef(e)
    ? { value: { value: state.approvals, version: 1 } } : next(e))
  on('state.set', ($, e, next) => {
    if (e.plugin === 'blast-radius' && e.key === 'held') state.held = e.value as HeldCommand | null
    if (e.plugin === 'blast-radius' && e.key === 'waiting') state.waiting = e.value as WaitingCall[]
    return next(e)
  })
  return state
}

describe('blast-radius', () => {
  for (const decision of ['proceed', 'cancel'] as const) {
    test(`workbench approvals ${decision} the current held call`, async ($, on) => {
      const clock = mock.clock(on)
      const ran: string[] = []
      engine(on, ran, { clock })
      const state = workbenchApprovals(on)
      let settled = false
      const call = $.tool.call({ tool: 'Bash', command: 'git push --force' }).then(result => {
        settled = true
        return result
      })
      const ui = await heldPane($)
      state.approvals = [{ id: state.held!.id, decision, at: 1 }]
      for (let i = 0; i < 50 && !settled; i++) {
        await new Promise(done => (globalThis as any).setTimeout(done, 5))
      }
      await clock.advance(60_000)
      const result = await call
      if (decision === 'proceed') {
        expect(ran).toEqual(['git push --force'])
      } else {
        expect(result).toMatchObject({ deny: expect.stringMatching(/the user pressed Cancel/) })
        expect(ran).toEqual([])
      }
      await ui.unmount()
    })
  }

  test('workbench approvals ignore a stale id', async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[] = []
    engine(on, ran, { clock })
    on('state.get', ($, e, next) => isWorkbenchApprovalRef(e)
      ? { value: { value: [{ id: 'finished', decision: 'proceed', at: 1 }], version: 1 } } : next(e))
    const call = $.tool.call({ tool: 'Bash', command: 'git push --force' })
    const ui = await heldPane($)
    await clock.advance(60_000)
    expect(await call).toMatchObject({ deny: expect.stringMatching(/nobody answered within 60 s/) })
    expect(ran).toEqual([])
    await ui.unmount()
  })

  for (const [label, value] of [
    ['non-array', (id: string) => ({ id, decision: 'proceed', at: 1 })],
    ['unknown decision', (id: string) => [{ id, decision: 'yes', at: 1 }]],
    ['invalid timestamp', (id: string) => [{ id, decision: 'proceed', at: '1' }]],
    ['null entry', () => [null]],
    ['mixed invalid entries', (id: string) => [{ id, decision: 'proceed', at: 1 }, null]],
  ] as const) {
    test(`malformed workbench approvals (${label}) leave the hold undecided`, async ($, on) => {
      const clock = mock.clock(on)
      const ran: string[] = []
      engine(on, ran, { clock })
      const state = workbenchApprovals(on)
      const call = $.tool.call({ tool: 'Bash', command: 'git push --force' })
      const ui = await heldPane($)
      state.approvals = value(state.held!.id)
      await clock.advance(60_000)
      expect(await call).toMatchObject({ deny: expect.stringMatching(/nobody answered within 60 s/) })
      expect(ran).toEqual([])
      await ui.unmount()
    })
  }

  test('unreadable workbench approvals leave the original buttons working', async ($, on) => {
    const ran: string[] = []
    engine(on, ran)
    on('state.get', ($, e, next) => {
      if (isWorkbenchApprovalRef(e)) throw new Error('unavailable')
      return next(e)
    })
    const call = $.tool.call({ tool: 'Bash', command: 'git push --force' })
    const ui = await heldPane($)
    await ui.press({ key: 'proceed' })
    await call
    expect(ran).toEqual(['git push --force'])
    await ui.unmount()
  })

  test('a workbench decision made while waiting resolves as soon as the call is held', async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[] = []
    engine(on, ran, { clock, agents: [{ id: 'worker', type: 'Explore' }] })
    const state = workbenchApprovals(on)
    const first = $.tool.call({ tool: 'Read', file_path: '/project/.env' })
    const initial = await heldPane($)
    expect(state.held?.agentId).toBeUndefined()
    await initial.unmount()
    let settled = false
    const input = { tool: 'Bash' as const, command: 'git push --force', agentId: 'worker' }
    const second = $.tool.call(input).then(result => {
      settled = true
      return result
    })
    const ui = await paneShowing($, /^대기 1개$/)
    const pending = state.waiting[0]!
    expect(pending.agentId).toBe('worker')
    state.approvals = [{ id: pending.id, decision: 'proceed', at: 1 }]
    await ui.press({ key: 'cancel' })
    await first
    for (let i = 0; i < 50 && !settled; i++) {
      await new Promise(done => (globalThis as any).setTimeout(done, 5))
    }
    const immediately = settled
    await clock.advance(60_000)
    await second
    expect(immediately).toBe(true)
    expect(ran).toEqual(['git push --force'])
    await ui.unmount()
  })

  const context = { root: '/project', cwd: '/project', home: '/home/me' }
  const fileRisk = (input: unknown) => {
    const file = fileTarget(input)
    return file ? classifyFileTool(file, context) : null
  }

  test('trusted folder writes run for file tools and shell cp and mv without a hold', async ($, on) => {
    const ran: string[] = []
    const opened: unknown[] = []
    engine(on, ran, { surfaces: [], opened })
    for (const path of ['/home/me/.claude/settings.json', '/home/me/.codex/x', '/home/me/.agents/new/x']) {
      expect(((await $.tool.call({ tool: 'Write', file_path: path, content: 'x' } as any)) as any).deny).toBeUndefined()
    }
    for (const command of ['cp source ~/.codex/x', 'mv source ~/.codex/x', 'mv source "$HOME/.agents/new/x"']) {
      expect(((await $.tool.call({ tool: 'Bash', command } as any)) as any).deny).toBeUndefined()
    }
    expect(ran).toEqual(['Write', 'Write', 'Write', 'cp source ~/.codex/x', 'mv source ~/.codex/x', 'mv source "$HOME/.agents/new/x"'])
    expect(opened).toEqual([])
  })

  test('a path spelled with .. is never trusted: a symlink before it can lead anywhere', () => {
    expect(fileRisk({ tool: 'Write', file_path: '/home/me/.agents/link/../x', content: 'x' })).toMatchObject({ risk: 'outside', dotted: ['/home/me/.agents/x'] })
    expect(classify('mv source ~/.agents/skills/link/../package.json', context)).toMatchObject({ risk: 'outside', dotted: ['/home/me/.agents/skills/package.json'] })
    expect(trustedFoldersFrom('/')).toEqual(['~/.claude', '~/.codex', '~/.agents'])
    expect(trustedFoldersFrom('~')).toEqual(['~/.claude', '~/.codex', '~/.agents'])
    expect(trustedFoldersFrom('.claude')).toEqual(['~/.claude', '~/.codex', '~/.agents'])
    expect(trustedFoldersFrom('~/a/../b')).toEqual(['~/.claude', '~/.codex', '~/.agents'])
  })

  test('trusted folder links pointing outside stay held for existing and new targets', async ($, on) => {
    const ran: string[] = []
    engine(on, ran, { surfaces: [], statPaths: {
      '/home/me/.codex/link': '/outside', '/home/me/.codex/existing': '/outside/file',
    } })
    for (const path of ['/home/me/.codex/link/new/deep/x', '/home/me/.codex/existing']) {
      expect(((await $.tool.call({ tool: 'Write', file_path: path, content: 'x' } as any)) as any).deny).toContain('write outside')
      expect(((await $.tool.call({ tool: 'Bash', command: `mv source ${path}` } as any)) as any).deny).toContain('write outside')
    }
    expect(ran).toEqual([])
  })

  test('unresolvable paths and missing or unresolvable trusted roots stay held', async ($, on) => {
    const ran: string[] = []
    engine(on, ran, { surfaces: [], statPaths: { '/home/me/.codex/dangling': undefined, '/home/me/.agents': undefined },
      statErrors: { '/home/me/.codex/denied': 'EACCES', '/home/me/.claude': 'ENOENT' } })
    for (const path of ['/home/me/.codex/dangling/x', '/home/me/.codex/denied', '/home/me/.agents/x', '/home/me/.claude/x']) {
      expect(((await $.tool.call({ tool: 'Write', file_path: path, content: 'x' } as any)) as any).deny).toContain('write outside')
    }
    expect(ran).toEqual([])
  })

  test('trusted folder deletes and secrets are still held without the outside risk', async ($, on) => {
    const ran: string[] = []
    engine(on, ran, { surfaces: [], previewOutput: 'T /home/me/.codex/notes.txt\nS 4\nF /home/me/.codex/notes.txt' })
    for (const command of ['rm -rf ~/.codex/notes.txt', 'rm ~/.codex/notes.txt', 'cat ~/.codex/.env', 'cp source ~/.codex/.env']) {
      const denied = ((await $.tool.call({ tool: 'Bash', command } as any)) as any).deny
      expect(denied).toMatch(/delete|secret/)
      expect(denied).not.toContain('write outside')
    }
    const secret = ((await $.tool.call({ tool: 'Write', file_path: '/home/me/.codex/.env', content: 'x' } as any)) as any).deny
    expect(secret).toContain('secret file')
    expect(secret).not.toContain('write outside')
    expect(ran).toEqual([])
  })

  test('trust exemptions never let outside deletes skip their existing hold', async ($, on) => {
    const ran: string[] = []
    engine(on, ran, { surfaces: [], previewOutput: '' })
    for (const command of ['rm ~/.codex/scratch.log', 'rm -rf /home/me/.codex/missing']) {
      const denied = ((await $.tool.call({ tool: 'Bash', command } as any)) as any).deny
      expect(denied).toContain('no screen')
      expect(denied).not.toContain('write outside')
    }
    expect(ran).toEqual([])
  })

  test('custom trustedFolders replace defaults, expand HOME and resolve the folder itself',
    { options: { trustedFolders: ' $HOME/custom/./ , ~/shared ' } }, async ($, on) => {
      const ran: string[] = []
      engine(on, ran, { surfaces: [], statPaths: { '/home/me/custom': '/real/custom', '/real/custom': '/real/custom', '/home/me/shared': '/home/me/shared' } })
      for (const path of ['/home/me/custom', '/real/custom/new/x', '/home/me/shared/new/x']) {
        expect(((await $.tool.call({ tool: 'Write', file_path: path, content: 'x' } as any)) as any).deny).toBeUndefined()
      }
      expect(((await $.tool.call({ tool: 'Write', file_path: '/home/me/.codex/x', content: 'x' } as any)) as any).deny).toContain('write outside')
      expect(ran).toEqual(['Write', 'Write', 'Write'])
    })

  test('partially trusted shell targets keep only the untrusted outside paths', async ($, on) => {
    engine(on, [], { surfaces: [] })
    const denied = ((await $.tool.call({ tool: 'Bash', command: 'mv source ~/.codex/x /etc/x /home/me/.codex-other/x' } as any)) as any).deny
    expect(denied).toContain('write outside the project (/project): /etc/x, /home/me/.codex-other/x')
    expect(denied).not.toContain('/home/me/.codex/x')
  })

  for (const trustedFolders of ['', ' , ', 'not\u0000a-folder']) {
    test(`malformed trustedFolders ${JSON.stringify(trustedFolders)} fall back to the default list`, { options: { trustedFolders } }, async ($, on) => {
      const ran: string[] = []
      engine(on, ran, { surfaces: [] })
      expect(((await $.tool.call({ tool: 'Write', file_path: '/home/me/.codex/x', content: 'x' } as any)) as any).deny).toBeUndefined()
      expect(ran).toEqual(['Write'])
    })
  }

  test('trustedFolders parsing tolerates missing and non-string values', () => {
    for (const value of [undefined, null, 4, true, {}, [], '/a,', 'a\nb']) {
      expect(trustedFoldersFrom(value)).toEqual(['~/.claude', '~/.codex', '~/.agents'])
    }
    expect(trustedFoldersFrom(' /a , $HOME/b ')).toEqual(['/a', '$HOME/b'])
  })

  test('agent holds name their type in the pane and band', async ($, on) => {
    engine(on, [], { agents: [{ id: 'worker', type: 'Explore' }] })
    const call = $.tool.call({ tool: 'Bash', command: 'git push --force', agentId: 'worker' } as any)
    const pane = await paneShowing($, /명령을 멈춤/)
    const band = await $.ui.mount({ plugin: 'blast-radius', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100 } } as any)
    for (const ui of [pane, band]) {
      expect(await ui.find({ type: 'Text', text: /에이전트: Explore/ })).toBeDefined()
    }
    await pane.press({ key: 'cancel' })
    await call
    await pane.unmount()
    await band.unmount()
  })

  for (const [agents, failAgents, expected] of [
    [[{ id: 'worker', type: '', name: 'helper' }], false, '에이전트: helper'],
    [[], false, '에이전트'],
    [[], true, '에이전트'],
  ] as const) {
    test(`agent label falls back to ${expected}, list failure ${failAgents}`, async ($, on) => {
      engine(on, [], { agents: [...agents], failAgents })
      const call = $.tool.call({ tool: 'Write', file_path: '/etc/x', content: 'x', agentId: 'worker' } as any)
      const ui = await paneShowing($, /명령을 멈춤/)
      expect(await ui.find({ type: 'Text', text: new RegExp(` · ${expected}$`) })).toBeDefined()
      await ui.press({ key: 'cancel' })
      await call
      await ui.unmount()
    })
  }

  test('an aborted waiting call disappears while the current hold stays active', {
    options: { timeoutSeconds: 0 },
    plugins: [{ name: 'abort-waiting', tier: 'prepend', register(on) {
      on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
        void next(e)
        await $.clock.sleep(1_000)
        return { deny: 'test stopped the waiting call' }
      })
    } }],
  }, async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[] = []
    engine(on, ran, { clock })
    const first = $.tool.call({ tool: 'Read', file_path: '/project/.env' } as any)
    const initial = await paneShowing($, /Read \/project\/\.env/)
    await initial.unmount()
    const second = $.tool.call({ tool: 'Bash', command: 'git push --force' } as any)
    const ui = await paneShowing($, /^대기 1개$/)
    await clock.advance(1_000)
    expect(((await second) as any).deny).toBe('test stopped the waiting call')
    for (let i = 0; i < 50 && await ui.find({ type: 'Text', text: /^대기 / }); i++) {
      await new Promise(done => (globalThis as any).setTimeout(done, 5))
    }
    expect(await ui.find({ type: 'Text', text: /^대기 / })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Read \/project\/\.env/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    await first
    expect(ran).toEqual([])
    await ui.unmount()
  })

  test('concurrent holds list the waiting agent and one-line command on both surfaces then remove it', async ($, on) => {
    const ran: string[] = []
    engine(on, ran, { agents: [{ id: 'worker', type: 'worker' }] })
    const first = $.tool.call({ tool: 'Read', file_path: '/project/.env' } as any)
    const initial = await paneShowing($, /Read \/project\/\.env/)
    expect(await initial.find({ type: 'Text', text: /메인/ })).toBeDefined()
    expect(await initial.find({ type: 'Text', text: /^대기 / })).toBeUndefined()
    await initial.unmount()
    const command = 'git push --force\nprintf done'
    const second = $.tool.call({ tool: 'Bash', command, agentId: 'worker' } as any)
    const pane = await paneShowing($, /^대기 1개$/)
    const band = await $.ui.mount({ plugin: 'blast-radius', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100 } } as any)
    for (const ui of [pane, band]) {
      const row = await ui.find({ type: 'Text', text: /^에이전트: worker · git push --force ⏎ printf done$/ })
      expect(row).toBeDefined()
      expect(row.props.wrap).toBe('wrap')
    }
    await pane.press({ key: 'cancel' })
    await first
    await pane.unmount()
    await band.unmount()
    const later = await paneShowing($, /^\$ git push --force ⏎ printf done$/)
    expect(await later.find({ type: 'Text', text: /^대기 / })).toBeUndefined()
    expect(await later.find({ type: 'Text', text: /^에이전트: worker · / })).toBeUndefined()
    await later.press({ key: 'proceed' })
    await second
    expect(ran).toEqual([command])
    await later.unmount()
  })

  test('delete dates format known and unknown birth times with a fixed offset', () => {
    const birth = Date.parse('2026-10-10T23:30:00Z') / 1000
    const modified = Date.parse('2026-10-11T01:05:00Z') / 1000
    expect(formatDeleteDetail('a file.txt', birth, modified, 540)).toBe('a file.txt  생성 10/11 08:30 · 수정 10/11 10:05')
    expect(formatDeleteDetail('a', 0, modified, 0)).toBe('a  생성 ? · 수정 10/11 01:05')
    expect(formatDeleteDetail('a', undefined, undefined, 0)).toBe('a  생성 ? · 수정 ?')
    expect(formatDeleteDetail('a', -1, modified, -120)).toBe('a  생성 ? · 수정 10/10 23:05')
  })

  test('today-created highlight uses the supplied clock and only known listed dates', () => {
    const birth = Date.parse('2026-10-10T23:30:00Z') / 1000
    const scan = parseScan(`F a\nF b\nF c\nD ${birth} ${birth} a\nD 0 ${birth} b\nD ? ? c\nD ${birth} ${birth} unlisted`, 5000)
    expect(highlights(scan, Date.parse('2026-10-11T02:00:00Z'), 540)).toContainEqual({ level: 'low', text: '오늘 생성된 파일 1개' })
    expect(highlights(scan, Date.parse('2026-10-12T02:00:00Z'), 540)).toEqual([])
    expect(scan.dates[1]?.birth).toBeUndefined()
    expect(scan.dates[2]?.birth).toBeUndefined()
  })

  test('dates are capped to the first 200 listed files and preserve spaces', () => {
    const lines = Array.from({ length: 201 }, (_, i) => `F file ${i}\nD 1 2 file ${i}`)
    const scan = parseScan(lines.join('\n'), 5000)
    expect(scan.dates).toHaveLength(MAX_LISTED)
    expect(scan.dates[0]).toEqual({ path: 'file 0', birth: 1, modified: 2 })
  })

  test('the delete pane uses engine time for today-created files', async ($, on) => {
    const now = Date.parse('2026-10-11T12:00:00Z')
    const clock = mock.clock(on, { now })
    engine(on, [], { clock, previewOutput: `S 4\nF notes.txt\nD ${now / 1000} ${now / 1000} notes.txt` })
    const call = $.tool.call({ tool: 'Bash', command: 'rm notes.txt' } as any)
    const ui = await paneShowing($, /오늘 생성된 파일 1개/)
    expect(await ui.find({ type: 'Text', text: /notes\.txt  생성 10\/11 .* · 수정 10\/11/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test('a held delete with no existing files lists every missing target separately', async ($, on) => {
    engine(on, [], { previewOutput: '' })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf "missing a" "missing b"' } as any)
    const ui = await paneShowing($, /^삭제할 파일 없음: 경로가 아직 없어요$/)
    expect((await ui.findAll({ type: 'Text', text: /^  없음  / })).map((row: FoundElement) => row.text)).toEqual(['  없음  missing a', '  없음  missing b'])
    await ui.press({ key: 'cancel' })
    expect(((await call) as any).deny).toContain('delete nothing that exists right now')
    await ui.unmount()
  })

  test('delete text previews use the first nonempty line, strip controls and stop at 60 characters', async ($, on) => {
    const contentReads: string[] = []
    engine(on, [], { previewOutput: 'S 4\nF notes.txt\nD 10 20 notes.txt', contentReads,
      contents: { 'notes.txt': '\n\t\nHello\u0001\t' + '한'.repeat(65) + '\nignored line' } })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf notes.txt' } as any)
    const ui = await paneShowing($, /^파일 1개 삭제 \(4 KB\)$/)
    expect((await ui.find({ type: 'Text', text: /^    내용: / }))?.text).toBe('    내용: Hello' + '한'.repeat(55))
    expect((await ui.find({ type: 'Text', text: /^    내용: / }))?.props.dimColor).toBe(true)
    expect(contentReads).toEqual(['notes.txt'])
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test('delete binary previews detect a NUL anywhere in the first 512 bytes', async ($, on) => {
    engine(on, [], { previewOutput: 'S 4\nF data.bin', contents: { 'data.bin': 'text first\n' + 'x'.repeat(480) + '\u0000hidden' } })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf data.bin' } as any)
    const ui = await paneShowing($, /^    내용: \(바이너리\)$/)
    expect(await ui.find({ type: 'Text', text: /내용: text first/ })).toBeUndefined()
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test('delete secret files get a suppression row without a content read, including literal dollar names', async ($, on) => {
    const contentReads: string[] = []
    engine(on, [], { previewOutput: 'S 4\nF .env\nF literal$secret.pem', contentReads,
      contents: { '.env': 'private fixture', 'literal$secret.pem': 'private fixture' } })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf secrets' } as any)
    const ui = await paneShowing($, /^파일 2개 삭제/)
    expect(await ui.findAll({ type: 'Text', text: /^    내용: \(비밀 파일이라 안 보여줌\)$/ })).toHaveLength(2)
    expect(contentReads).toEqual([])
    expect(await ui.find({ type: 'Text', text: /private fixture/ })).toBeUndefined()
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test('the pane lists all files but only the first five get content rows', async ($, on) => {
    const paths = ['.env', ...Array.from({ length: 6 }, (_, i) => `notes${i}.txt`)]
    const contentReads: string[] = []
    engine(on, [], { previewOutput: ['S 28', ...paths.map(path => `F ${path}`)].join('\n'), contentReads,
      contents: Object.fromEntries(paths.map(path => [path, `sample ${path}`])) })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf folder' } as any)
    const ui = await paneShowing($, /^파일 7개 삭제/)
    expect(await ui.findAll({ type: 'Text', text: /^  .*  생성 / })).toHaveLength(7)
    expect(await ui.findAll({ type: 'Text', text: /^    내용: / })).toHaveLength(5)
    expect(contentReads).toEqual(paths.slice(1, 5))
    expect(await ui.find({ type: 'Text', text: /내용: sample notes4/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /비밀키·환경변수.*,/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /문서.*,/ })).toBeUndefined()
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test('outside writes list existing files with dates, missing paths and directories in separate rows', async ($, on) => {
    const birth = Date.parse('2026-10-11T00:00:00Z') / 1000
    const contentReads: string[] = []
    engine(on, [], { contentReads, fileMetadata: { '/etc/old.txt': `file ${birth} ${birth} 4096`, '/etc/new.txt': 'missing', '/etc/dir': 'directory' },
      contents: { '/etc/old.txt': '\nold content\nsecond line' } })
    const call = $.tool.call({ tool: 'Bash', command: 'mv source /etc/old.txt /etc/new.txt /etc/dir' } as any)
    const ui = await paneShowing($, /^프로젝트 밖에 쓰기 3곳$/)
    expect((await ui.find({ type: 'Text', text: /^  덮어씀  / }))?.text).toBe(`  덮어씀  ${formatDeleteDetail('/etc/old.txt', birth, birth)} · 4 KB`)
    expect(await ui.find({ type: 'Text', text: /^    내용: old content$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^  새로 만듦  \/etc\/new.txt$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^  폴더  \/etc\/dir$/ })).toBeDefined()
    expect(contentReads).toEqual(['/etc/old.txt'])
    expect((await ui.findAll({ type: 'Text' })).some((row: FoundElement) => row.text.includes(', '))).toBe(false)
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test('secret access lists existing, missing and directory paths without reading their contents', async ($, on) => {
    const contentReads: string[] = []
    engine(on, [], { contentReads, fileMetadata: { '.env': 'file 10 20 1024', 'credentials.json': 'missing', 'folder/.env': 'directory' },
      contents: { '.env': 'private fixture' } })
    const call = $.tool.call({ tool: 'Bash', command: 'cat .env credentials.json folder/.env' } as any)
    const ui = await paneShowing($, /^비밀 파일 3개 접근$/)
    expect((await ui.find({ type: 'Text', text: /^  덮어씀  / }))?.text).toBe(`  덮어씀  ${formatDeleteDetail('.env', 10, 20)} · 1 KB`)
    expect(await ui.find({ type: 'Text', text: /^    내용: \(비밀 파일이라 안 보여줌\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^  새로 만듦  credentials.json$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^  폴더  folder\/\.env$/ })).toBeDefined()
    expect(contentReads).toEqual([])
    expect((await ui.findAll({ type: 'Text' })).some((row: FoundElement) => row.text.includes(', '))).toBe(false)
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test('two risks render two bold summaries followed by their own detail rows', async ($, on) => {
    engine(on, [], { fileMetadata: { '.env': 'file 10 20 0', '/etc/new.txt': 'missing' } })
    const call = $.tool.call({ tool: 'Bash', command: 'cat .env && mv source /etc/new.txt' } as any)
    const ui = await paneShowing($, /^프로젝트 밖에 쓰기 1곳$/)
    const rows: FoundElement[] = await ui.findAll({ type: 'Text' })
    const summaries = rows.filter(row => /^(비밀 파일 1개 접근|프로젝트 밖에 쓰기 1곳)$/.test(row.text))
    expect(summaries.map(row => [row.text, row.props.bold])).toEqual([['비밀 파일 1개 접근', true], ['프로젝트 밖에 쓰기 1곳', true]])
    const secretAt = rows.findIndex(row => row.text === '비밀 파일 1개 접근')
    const outsideAt = rows.findIndex(row => row.text === '프로젝트 밖에 쓰기 1곳')
    expect(rows[secretAt + 1]?.text).toMatch(/^  덮어씀  \.env /)
    expect(rows[outsideAt + 1]?.text).toBe('  새로 만듦  /etc/new.txt')
    expect(rows.some(row => row.text.includes(' + '))).toBe(false)
    await ui.press({ key: 'cancel' })
    const denied = ((await call) as any).deny
    expect(denied).toContain('secret file: .env')
    expect(denied).toContain('write outside the project (/project): /etc/new.txt')
    await ui.unmount()
  })

  test('the band shows three delete items with their content rows and counts omitted items', async ($, on) => {
    const paths = Array.from({ length: 7 }, (_, i) => `notes${i}.txt`)
    engine(on, [], { isPlaced: false, previewOutput: ['S 28', ...paths.map(path => `F ${path}`)].join('\n'),
      contents: Object.fromEntries(paths.map(path => [path, `sample ${path}`])) })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf folder' } as any)
    const pane = await paneShowing($, /^파일 7개 삭제/)
    await pane.unmount()
    const band = await $.ui.mount({ plugin: 'blast-radius', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100 } } as any)
    expect(await band.findAll({ type: 'Text', text: /^  .*  생성 / })).toHaveLength(3)
    expect(await band.findAll({ type: 'Text', text: /^    내용: / })).toHaveLength(3)
    expect(await band.find({ type: 'Text', text: /^  … 4개 더$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /notes3/ })).toBeUndefined()
    await band.press({ key: 'cancel' })
    await call
    await band.unmount()
  })

  test('the band shares its three-item limit across risks and keeps both summaries', async ($, on) => {
    engine(on, [], { isPlaced: false, fileMetadata: { '.env': 'file 10 20 0', '.npmrc': 'file 10 20 0', '/etc/a': 'file 10 20 1', '/etc/b': 'file 10 20 1' },
      contents: { '/etc/a': 'a', '/etc/b': 'b' } })
    const call = $.tool.call({ tool: 'Bash', command: 'cat .env .npmrc && mv source /etc/a /etc/b' } as any)
    const pane = await paneShowing($, /^프로젝트 밖에 쓰기 2곳$/)
    await pane.unmount()
    const band = await $.ui.mount({ plugin: 'blast-radius', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100 } } as any)
    expect(await band.find({ type: 'Text', text: /^비밀 파일 2개 접근$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^프로젝트 밖에 쓰기 2곳$/ })).toBeDefined()
    expect(await band.findAll({ type: 'Text', text: /^  덮어씀  / })).toHaveLength(3)
    expect(await band.findAll({ type: 'Text', text: /^    내용: / })).toHaveLength(3)
    expect(await band.find({ type: 'Text', text: /^  … 1개 더$/ })).toBeDefined()
    await band.press({ key: 'cancel' })
    await call
    await band.unmount()
  })

  test('file tool inputs detect secrets by basename and exempt templates', () => {
    for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'NotebookEdit']) {
      const key = tool === 'Grep' ? 'path' : tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
      expect(fileRisk({ tool, [key]: '/project/keys/.env' })?.risk, tool).toBe('secret')
      expect(fileRisk({ tool, [key]: '/project/.env.example' }), tool).toBeNull()
    }
    expect(fileRisk({ tool: 'Grep', path: '/project/.env/folder' })).toBeNull()
    expect(fileTarget({ tool: 'Read', file_path: 42 })).toBeUndefined()
  })

  test('Bash words, redirect targets and substitution bodies detect secrets', () => {
    for (const command of [
      'cat .env', 'less .env', 'head .env', 'tail .env', 'cp .env copy', 'mv .env copy',
      'source .env', '. .env', 'sed -n 1p .env', 'grep x .env', 'tee .env',
      'echo hi > .env', 'echo hi >> .env', 'cat < .env', 'echo hi 2> key.pem',
      'echo hi >"folder/.env"', 'cat<.env', 'echo $(cat .env)', 'echo "$(cat .env)"',
    ]) expect(classify(command)?.risk, command).toBe('secret')
    for (const name of ['.env.example', '.env.sample', '.env.template', '.env.dist']) {
      expect(classify(`cat ${name}`)).toBeNull()
      expect(classify(`echo hi > ${name}`)).toBeNull()
    }
    expect(split('rm notes.txt 2> key.pem')).toMatchObject([{ text: 'rm' }, { text: 'notes.txt' }])
    expect(classify('cat <<.env\nhello\n.env')).toBeNull() // the delimiter is not a file
  })

  test('secret access combines with other risks and plain rm keeps its delete preview', () => {
    expect(classify('rm .env')).toEqual({ risk: 'delete', targets: ['.env'], patterns: ['.env'], isRecursive: false })
    expect(classify('git push -f && cat .env')).toMatchObject({ risk: 'force-push', also: [{ risk: 'secret' }] })
    expect(classify('cat .env && rm -rf app')).toMatchObject({ risk: 'delete', also: [{ risk: 'secret' }] })
    expect(classify('rm notes.txt > .env')).toMatchObject({ risk: 'delete', also: [{ risk: 'secret' }] })
  })

  // `dotted` only marks paths that are never trusted; these checks are about where the path lands.
  const plain = (risks?: { dotted?: string[] }[]) => risks?.map(({ dotted, ...risk }) => risk)

  test('outside rm paths resolve absolute, relative, home and cd', () => {
    for (const [command, path] of [
      ['rm /etc/a', '/etc/a'], ['rm ../x', '/x'], ['rm ~/x', '/home/me/x'],
      ['rm $HOME/x', '/home/me/x'], ['cd /etc && rm a', '/etc/a'],
      ['cd .. && rm x', '/x'], ['env -C /etc rm a', '/etc/a'],
    ]) expect(plain(classify(command!, context)?.also), command).toContainEqual({ risk: 'outside', root: '/project', targets: [path] })
    expect(plain(classify('rm ../../x', { ...context, cwd: '/project/sub' })?.also)).toContainEqual({ risk: 'outside', root: '/project', targets: ['/x'] })
    expect(classify('rm x', { ...context, cwd: '/project/sub' })?.also).toBeUndefined()
    expect(classify('echo $(rm a); cd /etc', context)?.also).toBeUndefined()
    expect(classify('cd /etc; echo $(rm a); cd /project', context)?.also).toContainEqual({ risk: 'outside', root: '/project', targets: ['/etc/a'] })
  })

  test('outside detection covers the specified mutation commands and their destinations', () => {
    for (const command of [
      'mv a /etc/x', 'mv /etc/x a', 'mv -t /etc a',
    ]) expect(classify(command, context)?.risk, command).toBe('outside')
    expect(classify('rm /etc/x', context)).toMatchObject({ risk: 'delete', also: [{ risk: 'outside' }] })
    for (const command of [
      'cp a /etc/x', 'ln a /etc/x', 'touch /etc/x', 'mkdir -p ~/x',
      'mkdir /etc/x', 'rmdir /etc/x', 'tee /etc/x', 'install a /etc/x',
      'rsync a /etc/x', 'truncate -s 0 /etc/x', 'chmod 600 /etc/x', 'chown me /etc/x',
      'cp -t /etc a', 'install -d /etc/x', 'touch -r a /etc/x', 'chmod --reference=a /etc/x', 'chmod -w /etc/x',
      'echo hi > ~/x', 'echo hi >> /etc/x', 'sed -i x /etc/x', 'curl -o /etc/x https://example.invalid',
    ]) expect(classify(command, context), command).toBeNull()
    expect(classify('cp /etc/x inside', context)).toBeNull()
    expect(classify('ln /etc/x inside', context)).toBeNull()
    expect(classify('cat /etc/x', context)).toBeNull()
    expect(classify('cat < /etc/x', context)).toBeNull()
    expect(classify('echo hi 2>&1', context)).toBeNull()
    expect(classify('ls missing 2>/dev/null', context)).toBeNull()
    expect(classify('echo hi > /dev/stderr', context)).toBeNull()
  })

  test('inside, exempt and unresolvable paths do not trigger outside holds', () => {
    for (const path of ['/project/a', '/project/sub/../a', 'sub/a', '/tmp/x', '/private/tmp/x', '/var/folders/x', '/private/var/folders/x', '/dev/null', '/dev/stderr', '$VAR/x', '$(pwd)/x', '/unknown/*']) {
      const risk = classify(`rm ${path}`, context)
      expect(risk?.risk, path).toBe('delete')
      expect(risk?.also, path).toBeUndefined()
    }
    expect(classify('mv a /project-other/a', context)?.risk).toBe('outside')
    expect(classify('mv a /tmp/../etc/a', context)?.risk).toBe('outside')
  })

  test('file writes outside are held, reads stay exempt, and combined secrets retain both risks', () => {
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
      expect(fileRisk({ tool, [key]: '/etc/x' })?.risk).toBe('outside')
      expect(fileRisk({ tool, [key]: '../x' })?.risk).toBe('outside')
      expect(fileRisk({ tool, [key]: '/private/var/folders/x' })).toBeNull()
      expect(fileRisk({ tool, [key]: '/project/x' })).toBeNull()
    }
    expect(fileRisk({ tool: 'Read', file_path: '/etc/x' })).toBeNull()
    expect(fileRisk({ tool: 'Grep', path: '/etc/x' })).toBeNull()
    expect(fileRisk({ tool: 'Write', file_path: '/etc/.env' })).toMatchObject({ risk: 'secret', also: [{ risk: 'outside', targets: ['/etc/.env'] }] })
  })

  test('native tool paths are literal, including brackets, parentheses and dollars', () => {
    const native = { ...context, root: '/home/me/app', cwd: '/home/me/app' }
    expect(classifyFileTool(fileTarget({ tool: 'Write', file_path: '/home/me/app/[locale]/page.tsx' })!, native)).toBeNull()
    for (const path of ['/home/me/report (copy).txt', '/x/$weird.txt', '../[locale]/page.tsx', '../$weird/.env']) {
      const risk = classifyFileTool(fileTarget({ tool: 'Write', file_path: path })!, native)
      expect(risk?.risk === 'outside' || risk?.also?.some(r => r.risk === 'outside'), path).toBe(true)
    }
    expect(fileRisk({ tool: 'Write', file_path: '/x/$weird/.env' })).toMatchObject({ risk: 'secret', also: [{ risk: 'outside' }] })
    expect(fileRisk({ tool: 'Read', file_path: '/project/$weird.pem' })?.risk).toBe('secret')
  })

  test('Claude project memory is exempt but other Claude files remain outside', () => {
    for (const path of ['/home/me/.claude/projects/-Users-me-app/memory/a.md', '/home/me/.claude/projects/a/b/memory/deep/a.md', '/home/me/.claude/plans/p.md']) {
      expect(fileRisk({ tool: 'Write', file_path: path })).toBeNull()
      expect(classify(`mv a ${path}`, context)).toBeNull()
    }
    for (const path of ['/home/me/.claude/settings.json', '/home/me/.claude/projects/a/memory/../settings.json', '/home/me/.claude/projects/a/memory-other/a.md']) {
      expect(fileRisk({ tool: 'Write', file_path: path })?.risk, path).toBe('outside')
    }
    expect(fileRisk({ tool: 'Write', file_path: '/home/me/.claude/projects/a/memory/.env' })?.risk).toBe('secret')
  })

  test('HOME expands in double quotes, while single quotes, escapes and quoted tildes stay literal', () => {
    for (const command of ['rm "$HOME/x"', 'rm "${HOME}/x"', 'cd "$HOME" && rm x', 'cd "${HOME}" && rm x', 'rm $HOME/"x"']) {
      expect(classify(command, context)?.also, command).toContainEqual({ risk: 'outside', root: '/project', targets: ['/home/me/x'] })
    }
    for (const command of ["rm '$HOME/x'", 'rm "\\$HOME/x"', 'rm \\$HOME/x', "rm '~/x'", 'rm "~/x"']) {
      expect(classify(command, context)?.also, command).toBeUndefined()
    }
  })

  test('only unquoted heredoc bodies execute substitutions', () => {
    expect(classify('cat <<EOF\n$(cat .env)\nEOF')?.risk).toBe('secret')
    expect(classify('cat <<EOF\n$(rm /etc/x)\nEOF', context)).toMatchObject({ risk: 'delete', also: [{ risk: 'outside' }] })
    expect(classify('cat <<EOF\n`cat .env`\nEOF')?.risk).toBe('secret')
    expect(classify('cat <<EOF\n"$(cat .env)"\nEOF')?.risk).toBe('secret')
    expect(classify('cat <<EOF\n\\$(cat .env)\nEOF')).toBeNull()
    for (const open of ["<<'EOF'", '<<"EOF"', '<<\\EOF', '<<E"O"F']) {
      expect(classify(`cat ${open}\n$(cat .env) $(rm /etc/x)\nEOF`, context), open).toBeNull()
    }
    expect(classify('cd /etc; cat <<EOF\n$(rm x)\nEOF', context)?.also).toContainEqual({ risk: 'outside', root: '/project', targets: ['/etc/x'] })
  })

  test('adjacent redirects collect every target without swallowing quoted operators', () => {
    for (const command of ['printf hi >out.txt>.env', 'cat<in.txt<.env', 'printf hi >"out>file">.env', 'printf hi >out\\>file>.env']) {
      expect(classify(command)?.risk, command).toBe('secret')
    }
  })

  test('both real and logical project roots count as inside', () => {
    const linked = { ...context, cwd: '/link/proj', root: '/real/proj' }
    for (const path of ['a.ts', '/link/proj/[locale]/a.ts', '/real/proj/a.ts']) {
      expect(classifyFileTool({ tool: 'Write', path }, linked), path).toBeNull()
      expect(classify(`mv a ${path}`, linked), path).toBeNull()
    }
    expect(classify('mv a /link/other/a', linked)?.risk).toBe('outside')
  })

  test('shell -c and eval bodies apply every risk and preserve cwd scope', () => {
    for (const shell of ['sh', 'bash', 'zsh', '/bin/bash']) {
      expect(classify(`${shell} -c 'cat .env'`)?.risk, shell).toBe('secret')
      expect(classify(`${shell} -c 'rm -rf ~/x'`)?.risk, shell).toBe('delete')
      expect(classify(`${shell} -c 'git push -f'`)?.risk, shell).toBe('force-push')
      expect(classify(`${shell} -c 'prisma migrate deploy'`)?.risk, shell).toBe('migration')
      expect(classify(`${shell} -c 'mv a /etc/x'`, context)?.risk, shell).toBe('outside')
    }
    expect(classify('sh -c "rm -rf ~/x"', context)).toMatchObject({ risk: 'delete', also: [{ risk: 'outside' }] })
    expect(classify('bash -lc "cat .env"')?.risk).toBe('secret')
    expect(classify('eval rm /etc/a', context)).toMatchObject({ risk: 'delete', also: [{ risk: 'outside' }] })
    for (const body of ['cat .env', 'rm -rf x', 'git push -f', 'prisma migrate deploy', 'mv a /etc/x']) expect(classify(`eval '${body}'`, context)).toBeDefined()
    expect(classify('bash -c "cd /etc"; mv a b', context)).toBeNull()
    expect(classify('eval cd /etc; mv a b', context)).toMatchObject({ risk: 'outside', targets: ['/etc/a', '/etc/b'] })
  })

  test('secret operands include equals and colon suffixes and matching globs', () => {
    for (const command of ['docker run --env-file=.env app', 'git show HEAD:.env', 'cat .env*', 'cat .en?', 'cat .[e]nv', 'cat *.pem', 'cat .en?.production', 'cat backup.[p]em', 'cat .env.*.local', 'echo .env >> .gitignore', 'test -f .env']) {
      expect(classify(command)?.risk, command).toBe('secret')
    }
    for (const command of ['cat .enx?.txt', 'cat .[x]nv', 'cat .en??', 'cat ".en?"', 'cat .env.local.example', 'cat .env.local.sample', 'cat .env.local.template', 'cat .env.local.dist', 'wc -l hooks/*.ts*', 'ls *', 'cat src/*.js*', 'cat .e*', "jq -r '.[].key' package.json", 'jq .data.key x.json', "gh api x --jq '.[].key'", 'git commit -m "Rotate server.key"', 'rg "\\.key" src', "bash -n -c 'rm -rf build'", `bash -c 'printf "%s" "$(printf "%s" "a)b")"'`]) expect(classify(command), command).toBeNull()
    expect(fileRisk({ tool: 'Write', file_path: '/project/.env.local.example' })).toBeNull()
    expect(highlights(parseScan('F .env.local.example', 5000))).toEqual([])
  })

  test('a force-push preview whose git fails says it could not compare, never "0 lost"', async ($, on) => {
    engine(on, [], { previewOutput: '', previewExitCode: 128 })
    const call = $.tool.call({ tool: 'Bash', command: 'git push --force' } as any)
    const ui = await paneShowing($, /원격 브랜치와 비교 못 함/)
    expect(await ui.find({ type: 'Text', text: /0 remote commits lost/ })).toBeUndefined()
    await ui.press({ key: 'cancel' })
    await call
  })

  for (const [out, warned] of [['O', false], ['X', true]] as const) {
    test(`a migration preview printing ${out} ${warned ? 'warns' : 'does not warn'} that changes were not checked`, async ($, on) => {
      engine(on, [], { previewOutput: out })
      const call = $.tool.call({ tool: 'Bash', command: 'npx prisma migrate deploy' } as any)
      const ui = await paneShowing($, /DB 스키마 변경/)
      expect(Boolean(await ui.find({ type: 'Text', text: /변경 사항 확인 안 함/ }))).toBe(warned)
      await ui.press({ key: 'cancel' })
      await call
    })
  }

  test('more than 50 repos under a delete is said, not skipped silently', () => {
    const found = highlights(parseScan('T a\nG a/r1/.git\nM a', 5000)).map(h => h.text)
    expect(found).toContain('저장소가 50개를 넘어 나머지는 커밋 안 된 변경을 확인 안 함')
    expect(found.some(t => t.startsWith('git 저장소 1+개'))).toBe(true)
    expect(highlights(parseScan('T a\nG a/r1/.git', 5000)).map(h => h.text).some(t => t.includes('50개'))).toBe(false)
  })

  test('mv target-directory flags accept attached and clustered forms', () => {
    for (const command of ['mv -t/etc a', 'mv -ft /etc a', 'mv -ft/etc a', 'mv --target-directory=/etc a']) expect(classify(command, context), command).toMatchObject({ risk: 'outside', targets: ['/etc'] })
    expect(classify('mv -S /etc a b', context)).toBeNull()
    expect(classify('mv -- -t/etc a', context)).toBeNull()
    expect(classify('mv "-t$HOME" a', context)).toMatchObject({ risk: 'outside', targets: ['/home/me'] })
    expect(classify("mv '-t$HOME' a", context)).toBeNull()
  })

  test('Grep glob is checked even with no path, using the secret matching rules', () => {
    for (const glob of ['.env', '*.pem', '.env*', '.[e]nv']) expect(fileRisk({ tool: 'Grep', glob })?.risk, glob).toBe('secret')
    expect(fileRisk({ tool: 'Grep', path: '/project', glob: '.env' })?.risk).toBe('secret')
    expect(fileRisk({ tool: 'Grep', glob: '.env.local.example' })).toBeNull()
  })

  test('context failures preserve context-free protections and never deny ordinary reads', async ($, on) => {
    const ran: string[] = []
    engine(on, ran, { surfaces: [], failContext: true })
    for (const input of [{ tool: 'Read', file_path: '/etc/x' }, { tool: 'Grep', path: '/etc', pattern: 'x' }, { tool: 'Write', file_path: '/etc/x', content: 'x' }, { tool: 'Bash', command: 'ls' }]) await $.tool.call(input as any)
    for (const input of [{ tool: 'Read', file_path: '/project/.env' }, { tool: 'Grep', glob: '.env*', pattern: 'x' }, { tool: 'Write', file_path: '/etc/.env', content: 'x' }, { tool: 'Bash', command: 'rm -rf build' }, { tool: 'Bash', command: 'cat .env' }, { tool: 'Bash', command: 'git push -f' }, { tool: 'Bash', command: 'prisma migrate deploy' }]) {
      expect(((await $.tool.call(input as any)) as any).deny).toMatch(/no screen/)
    }
    expect(ran).toEqual(['Read', 'Grep', 'Write', 'ls'])
  })

  test('read tools and Bash without rm or mv never query project context', async ($, on) => {
    const queried: string[] = []
    engine(on, [], { surfaces: [], queried })
    for (const input of [{ tool: 'Read', file_path: '/etc/x' }, { tool: 'Grep', glob: '.env', pattern: 'x' }, { tool: 'Bash', command: 'cat .env' }, { tool: 'Bash', command: 'touch /etc/x' }]) await $.tool.call(input as any)
    expect(queried).toEqual([])
    await $.tool.call({ tool: 'Bash', command: 'mv a /etc/x' } as any)
    expect(queried).toEqual(['/project'])
  })

  test('a symlinked session subfolder accepts writes under either spelling of its project', async ($, on) => {
    const ran: string[] = []
    engine(on, ran, { surfaces: [], cwd: '/link/proj/sub', root: '/real/proj', realCwd: '/real/proj/sub' })
    for (const path of ['/link/proj/new/a.ts', '/real/proj/new/a.ts', 'a.ts']) await $.tool.call({ tool: 'Write', file_path: path, content: 'x' } as any)
    expect(((await $.tool.call({ tool: 'Write', file_path: '/link/elsewhere/a.ts', content: 'x' } as any)) as any).deny).toContain('write outside')
    expect(ran).toEqual(['Write', 'Write', 'Write'])
  })

  for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'NotebookEdit']) {
    test(`${tool} secret access uses the shared pane and Cancel`, async ($, on) => {
      const ran: string[] = []
      engine(on, ran)
      const args = tool === 'NotebookEdit' ? { notebook_path: '/project/.env', new_source: '' }
        : tool === 'Grep' ? { path: '/project/.env', pattern: 'a' }
        : { file_path: '/project/.env', old_string: 'a', new_string: 'b', content: 'a' }
      const call = $.tool.call({ tool, ...args } as any)
      const ui = await paneShowing($, /비밀 파일 접근/)
      expect(await ui.find({ type: 'Text', text: new RegExp(`${tool} /project/\\.env`) })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /비밀키·환경변수 파일 접근: \.env/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'proceed', label: '진행하기' })).toBeDefined()
      await ui.press({ key: 'cancel' })
      expect(((await call) as any).deny).toMatch(/the user pressed Cancel.*secret file/)
      expect(ran).toEqual([])
      await ui.unmount()
    })
  }

  test('file-tool Proceed runs once and templates are allowed', async ($, on) => {
    const ran: string[] = []
    engine(on, ran)
    const call = $.tool.call({ tool: 'Read', file_path: '/project/.env' } as any)
    const ui = await heldPane($)
    await ui.press({ key: 'proceed' })
    await call
    await ui.unmount()
    await $.tool.call({ tool: 'Write', file_path: '/project/.env.example', content: 'sample' } as any)
    expect(ran).toEqual(['Read', 'Write'])
  })

  test('file tools deny without a screen using the same message', async ($, on) => {
    const ran: string[] = []
    engine(on, ran, { surfaces: [] })
    const secret: any = await $.tool.call({ tool: 'Read', file_path: '/project/.env' } as any)
    const outside: any = await $.tool.call({ tool: 'Write', file_path: '/etc/x', content: 'x' } as any)
    expect(secret.deny).toMatch(/no screen, so nobody can answer.*read secret file/)
    expect(outside.deny).toMatch(/no screen, so nobody can answer.*write outside the project \(\/project\): \/etc\/x/)
    expect(ran).toEqual([])
  })

  test('file tools share timeout and band fallback', async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[] = []
    engine(on, ran, { clock, isPlaced: false })
    const call = $.tool.call({ tool: 'Write', file_path: '/etc/x', content: 'x' } as any)
    const ui = await paneShowing($, /60초 후 자동 취소/)
    await ui.unmount()
    const band = await $.ui.mount({ plugin: 'blast-radius', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100 } } as any)
    expect(await band.find({ type: 'Text', text: /프로젝트 밖 쓰기/ })).toBeDefined()
    await band.unmount()
    await clock.advance(60_000)
    expect(((await call) as any).deny).toMatch(/nobody answered within 60 s/)
    expect(ran).toEqual([])
  })

  test('rm -rf of a path that does not exist runs without a hold', async ($, on) => {
    const ran: string[] = []
    engine(on, ran, { previewOutput: '' })
    await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    expect(ran).toEqual(['rm -rf build'])
  })

  test('rm -rf with escapes, .. or an earlier command is held even when the preview finds nothing', async ($, on) => {
    const ran: string[] = []
    engine(on, ran, { previewOutput: '' })
    for (const command of [`rm -rf $'buil\\x64'`, 'cd alias/.. && rm -rf victim', 'rm -rf a/../victim', 'rm -rf tmp\nchdir /Users/x\nrm -rf Documents', 'rm -rf tmp -cache', `python3 -c 'import os; os.rename("notes", "build")' && rm -rf build`]) {
      void $.tool.call({ tool: 'Bash', command } as any)
      await new Promise(done => (globalThis as any).setTimeout(done, 20))
      expect(ran, command).toEqual([])
    }
  })

  test('rm outside the root gets one hold with dates, git details and the outside note', async ($, on) => {
    const ran: string[] = []
    const opened: unknown[] = []
    const now = Date.parse('2026-10-11T12:00:00Z')
    engine(on, ran, { opened, previewOutput: `T /etc/app\nS 4\nF /etc/app/notes.txt\nD ${now / 1000} ${now / 1000} /etc/app/notes.txt\nG /etc/app/.git\nU 1` })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf /etc/app' } as any)
    const ui = await paneShowing($, /프로젝트 밖: \/etc\/app/)
    expect(await ui.find({ type: 'Text', text: /notes\.txt  생성/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /git 저장소 1개/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /커밋 안 된 수정 1개/ })).toBeDefined()
    await ui.press({ key: 'proceed' })
    await call
    expect(opened).toHaveLength(1)
    expect(ran).toEqual(['rm -rf /etc/app'])
    await ui.unmount()
  })

  test('Bash and file tools queue one held call at a time', async ($, on) => {
    const ran: string[] = []
    const opened: unknown[] = []
    engine(on, ran, { opened })
    const first = $.tool.call({ tool: 'Bash', command: 'rm -rf build', tool_use_id: 'bash' } as any)
    const ui = await paneShowing($, /rm -rf build/)
    const second = $.tool.call({ tool: 'Read', file_path: '/project/.env', tool_use_id: 'read' } as any)
    await ui.press({ key: 'cancel' })
    await first
    await ui.unmount()
    const later = await paneShowing($, /Read \/project\/\.env/)
    await later.press({ key: 'proceed' })
    await second
    expect(opened).toHaveLength(2)
    expect(ran).toEqual(['Read'])
    await later.unmount()
  })

  test('a failed file guard denies and cleans up for the next held call', async ($, on) => {
    const ran: string[] = []
    let fail = true
    engine(on, ran, { failOpen: () => fail })
    const refused: any = await $.tool.call({ tool: 'Read', file_path: '/project/.env' } as any)
    expect(refused.deny).toMatch(/file protection failed/)
    fail = false
    const call = $.tool.call({ tool: 'Write', file_path: '/etc/x', content: 'x' } as any)
    const ui = await heldPane($)
    await ui.press({ key: 'cancel' })
    await call
    expect(ran).toEqual([])
    await ui.unmount()
  })

  test('root is queried per call in the session cwd, and failed git falls back to cwd', async ($, on) => {
    const ran: string[] = []
    const queried: string[] = []
    engine(on, ran, { surfaces: [], cwd: '/project/sub', rootExitCode: 1, queried })
    await $.tool.call({ tool: 'Write', file_path: '/project/sub/a', content: 'x' } as any)
    const denied: any = await $.tool.call({ tool: 'Write', file_path: '/project/a', content: 'x' } as any)
    expect(denied.deny).toContain('write outside the project (/project/sub): /project/a')
    expect(queried).toEqual(['/project/sub', '/project/sub'])
    expect(ran).toEqual(['Write'])
  })

  test('classifies only the risky commands', () => {
    expect(classify('rm -rf build')?.risk).toBe('delete')
    expect(classify('cd web && rm -r dist')).toEqual({ risk: 'delete', targets: ['web/dist'], patterns: ['web/dist'], isRecursive: true })
    expect(classify('git push --force origin main')?.risk).toBe('force-push')
    expect(classify('git push -f')?.risk).toBe('force-push')
    expect(classify('npx prisma migrate deploy')?.risk).toBe('migration')
    expect(classify('rm file.txt')).toEqual({ risk: 'delete', targets: ['file.txt'], patterns: ['file.txt'], isRecursive: false })
    expect(classify('git push origin main')).toBeNull()
    expect(classify('ls -la && echo rm -rf')).toBeNull()
  })

  test('Cancel refuses the command with the reason', async ($, on) => {
    const ran: string[] = []
    engine(on, ran)
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    const ui = await heldPane($)
    expect(await ui.find({ type: 'Text', text: /파일 9개 삭제 \(1\.1 MB\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /build\/chunk-0\.js/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    const r: any = await call
    expect(r.deny).toMatch(/^blast-radius: the user pressed Cancel on this command\. It would have: delete 9 files/)
    expect(ran).toEqual([])
    await ui.unmount()
  })

  test('Proceed runs the command as written', async ($, on) => {
    const ran: string[] = []
    engine(on, ran)
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    const ui = await heldPane($)
    await ui.press({ key: 'proceed' })
    await call
    expect(ran).toEqual(['rm -rf build'])
    await ui.unmount()
  })

  test('lists files from the folder being deleted', async ($, on) => {
    on('tool.call', () => ({ result: {}, text: 'ok' }) as any)
    on('process.run', async (_$: any, e: any) => {
      if (e.argv[0] === 'sleep') await new Promise(done => (globalThis as any).setTimeout(done, 5))
      const stdout = e.argv[0] === SHELL_ARGV[0] ? 'S 4\nF /tmp/deep/demo/build/chunk-1.js' : ''
      return { value: { exitCode: 0, stdout, stderr: '' } } as any
    })
    on('ui.open', () => ({ value: { isPlaced: true } }) as any)
    on('ui.close', () => ({ value: undefined }) as any)
    on('session.cwd', () => ({ value: '/project' }) as any)
    on('session.surfaces', () => ({ value: ['terminal'] }) as any)
    mock.clock(on)
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/deep/demo/build' } as any)
    const ui = await heldPane($)
    expect(await ui.find({ type: 'Text', text: /^  build\/chunk-1\.js  생성 \? · 수정 \?$/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test('a path with a shell variable says it cannot preview, never "nothing"', async ($, on) => {
    const ran: string[] = []
    const previews: string[][] = []
    engine(on, ran, { previews })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf $S/build' } as any)
    const ui = await heldPane($)
    expect(await ui.find({ type: 'Text', text: /미리보기 불가: 경로 1개가 셸 문법을 써요/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$S\/build/ })).toBeDefined()
    expect(previews).toEqual([]) // nothing measured, so no false "nothing"
    await ui.press({ key: 'cancel' })
    const r: any = await call
    expect(r.deny).toMatch(/can't preview/)
    await ui.unmount()
  })

  test('~ and $HOME are expanded before the preview', async ($, on) => {
    const ran: string[] = []
    const previews: string[][] = []
    engine(on, ran, { previews })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf ~/build $HOME/cache' } as any)
    const ui = await heldPane($)
    expect(previews[0]).toEqual(['/home/me/build', '/home/me/cache'])
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test("a quoted '~' stays literal while double-quoted HOME expands in the preview", async ($, on) => {
    const ran: string[] = []
    const previews: string[][] = []
    engine(on, ran, { previews })
    const call = $.tool.call({ tool: 'Bash', command: "rm -rf '~' \"$HOME/x\"" } as any)
    const ui = await heldPane($)
    expect(previews).toEqual([['~', '/home/me/x']])
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test('a safe command is never held', async ($, on) => {
    const ran: string[] = []
    engine(on, ran)
    await $.tool.call({ tool: 'Bash', command: 'ls -la' } as any)
    expect(ran).toEqual(['ls -la'])
  })

  test('reads timeoutSeconds as whole seconds, 60 when unset or wrong', () => {
    expect(timeoutFrom(undefined)).toBe(60)
    expect(timeoutFrom(30)).toBe(30)
    expect(timeoutFrom('120')).toBe(120)
    expect(timeoutFrom(0)).toBe(0)
    expect(timeoutFrom(0.4)).toBe(1)
    expect(timeoutFrom(-5)).toBe(60)
    expect(timeoutFrom('soon')).toBe(60)
  })

  test('nobody pressing within 60 s cancels with the reason', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const ran: string[] = []
    engine(on, ran, { clock })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    const ui = await paneShowing($, /60초 후 자동 취소/)
    await ui.unmount()
    await clock.advance(18_000)
    const later = await paneShowing($, /42초 후 자동 취소/)
    await later.unmount()
    await clock.advance(42_000)
    const r: any = await call
    expect(r.deny).toMatch(/nobody answered within 60 s, so it was cancelled\. It would have: delete 9 files \(1\.1 MB\)\. Don't retry it on your own: ask the user to run it/)
    expect(ran).toEqual([])
  })

  test('a shorter timeoutSeconds cancels sooner', { options: { timeoutSeconds: 30 } }, async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[] = []
    engine(on, ran, { clock })
    const call = $.tool.call({ tool: 'Bash', command: 'git push --force' } as any)
    const ui = await paneShowing($, /30초 후 자동 취소/)
    await ui.unmount()
    await clock.advance(30_000)
    const r: any = await call
    expect(r.deny).toMatch(/nobody answered within 30 s/)
    expect(ran).toEqual([])
  })

  for (const key of ['cancel', 'proceed'] as const) {
    test(`pressing ${key} before the timeout still decides`, async ($, on) => {
      const clock = mock.clock(on)
      const ran: string[] = []
      engine(on, ran, { clock })
      const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
      const first = await paneShowing($, /60초 후 자동 취소/)
      await first.unmount()
      await clock.advance(50_000)
      const ui = await paneShowing($, /10초 후 자동 취소/)
      await ui.press({ key })
      const r: any = await call
      if (key === 'cancel') {
        expect(r.deny).toMatch(/the user pressed Cancel/)
        expect(ran).toEqual([])
      } else {
        expect(ran).toEqual(['rm -rf build'])
      }
      await ui.unmount()
    })
  }

  test('timeoutSeconds 0 waits for a press, with no countdown', { options: { timeoutSeconds: 0 } }, async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[] = []
    engine(on, ran, { clock })
    let isSettled = false
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any).then((r: any) => {
      isSettled = true
      return r
    })
    const ui = await heldPane($)
    expect(await ui.find({ type: 'Text', text: /자동 취소/ })).toBeUndefined()
    await ui.unmount()
    await clock.advance(10 * 60_000)
    await new Promise(done => (globalThis as any).setTimeout(done, 50))
    expect(isSettled).toBe(false)
    const again = await heldPane($)
    await again.press({ key: 'proceed' })
    await call
    expect(ran).toEqual(['rm -rf build'])
    await again.unmount()
  })

  test('a session with no screen cancels at once', async ($, on) => {
    const ran: string[] = []
    const opened: unknown[] = []
    engine(on, ran, { surfaces: [], opened })
    const r: any = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    expect(r.deny).toMatch(/no screen, so nobody can answer\. It would have: delete 9 files/)
    expect(ran).toEqual([])
    expect(opened).toEqual([])
  })

  test('the countdown shows in the band when the pane cannot open', async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[] = []
    engine(on, ran, { clock, isPlaced: false })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    await clock.advance(52_000)
    let band: any
    for (let i = 0; i < 50 && !band; i++) {
      const ui = await $.ui.mount({ plugin: 'blast-radius', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100 } } as any)
      if (await ui.find({ type: 'Text', text: /8초 후 자동 취소/ })) band = ui
      else {
        await ui.unmount()
        await new Promise(done => (globalThis as any).setTimeout(done, 5))
      }
    }
    expect(band).toBeDefined()
    await clock.advance(8_000)
    const r: any = await call
    expect(r.deny).toMatch(/nobody answered within 60 s/)
    expect(ran).toEqual([])
    await band.unmount()
  })

  test('a second held command gets its own full wait', async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[] = []
    engine(on, ran, { clock })
    const first = $.tool.call({ tool: 'Bash', command: 'rm -rf build', tool_use_id: 'one' } as any)
    const ui = await paneShowing($, /rm -rf build/)
    const second = $.tool.call({ tool: 'Bash', command: 'git push --force', tool_use_id: 'two' } as any)
    await ui.unmount()
    await clock.advance(60_000)
    expect(((await first) as any).deny).toMatch(/nobody answered within 60 s/)
    const next = await paneShowing($, /60초 후 자동 취소/)
    expect(await next.find({ type: 'Text', text: /git push --force/ })).toBeDefined()
    await next.press({ key: 'proceed' })
    await second
    expect(ran).toEqual(['git push --force'])
    await next.unmount()
  })

  test('highlights put what hurts to lose first and skip what rebuilds', () => {
    const scan = parseScan(
      ['T app', 'S 900', 'F app/.env', 'F app/report.pdf', 'F app/src/main.ts', 'F app/node_modules/x/index.js', 'R app/report.pdf', 'G app/.git', 'U 3'].join('\n'),
      5000,
    )
    const lines = highlights(scan).map(h => `${h.level} ${h.text}`)
    expect(lines).toEqual([
      'high git 저장소 1개가 통째로 삭제됨: app',
      'high 커밋 안 된 수정 3개: git으로도 복구 불가',
      'high 비밀키·환경변수 1개: .env',
      'mid 문서 1개: report.pdf',
      'low 소스코드 1개: main.ts',
      'low 24시간 안에 수정한 파일 1개: report.pdf',
      'low 재생성 가능(node_modules, build 등) 1개',
    ])
    expect(isWorthHolding(highlights(scan))).toBe(true)
    const gitOnly = highlights(parseScan('S 8\nF a/.git/config\nR a/.git/HEAD\nG a/.git', 5000)).map(h => h.text)
    expect(gitOnly).toEqual(['git 저장소 1개가 통째로 삭제됨: a'])
    expect(isWorthHolding(highlights(parseScan('T tmp\nS 4\nF tmp/build/a.js', 5000)))).toBe(false)
  })

  test('a compound command is judged by its worst part', () => {
    expect(classify('rm tmp.log && rm -rf ~/project')).toMatchObject({ risk: 'delete', isRecursive: true, targets: ['tmp.log', '~/project'] })
    expect(classify('rm a.txt && git push --force')?.risk).toBe('force-push')
    expect(classify('rm x; npx prisma migrate reset')?.risk).toBe('migration')
    expect(classify('rm -rf -- -dir')).toMatchObject({ risk: 'delete', isRecursive: true, targets: ['-dir'] })
    expect(classify('rm -f')).toBeNull()
  })

  test('a delete inside a wrapper, subshell, pipe or loop is still found', () => {
    for (const cmd of [
      '(rm -rf ~/proj)',
      '{ rm -rf ~/proj; }',
      'if [ -d x ]; then rm -rf ~/proj; fi',
      'for d in a b; do rm -rf ~/proj; done',
      'true | rm -rf ~/proj',
      'sleep 1 & rm -rf ~/proj',
      'time rm -rf ~/proj',
      'command rm -rf ~/proj',
      'env rm -rf ~/proj',
      'X=1 rm -rf ~/proj',
      'sudo -u me rm -rf ~/proj',
      '/bin/rm -rf ~/proj',
      'rm --recur ~/proj',
    ]) {
      expect(classify(cmd), cmd).toMatchObject({ risk: 'delete', isRecursive: true, targets: ['~/proj'] })
    }
    expect(classify('echo "rm -rf x"')).toBeNull()
    expect(classify('rm "a;b.pdf"')).toMatchObject({ targets: ['a;b.pdf'] })
  })

  test('a force push or migration never hides a delete in the same command', () => {
    expect(classify('git push -f && rm -rf ~/proj')).toMatchObject({ risk: 'force-push', also: [{ risk: 'delete', targets: ['~/proj'] }] })
    expect(classify('npx prisma migrate dev && rm -rf ~/proj')).toMatchObject({ risk: 'migration', also: [{ risk: 'delete' }] })
    expect(classify('git push -f && npx prisma migrate deploy')).toMatchObject({ risk: 'force-push', also: [{ risk: 'migration' }] })
  })

  test('force pushes in short clusters, deletes and mirrors are found', () => {
    for (const cmd of ['git push -fu origin main', 'git push -uf origin main', 'git push origin :main', 'git push --mirror', 'git push --delete origin main', 'git push origin +main', 'git -C x push -f']) {
      expect(classify(cmd)?.risk, cmd).toBe('force-push')
    }
    expect(classify('git push -u origin main')).toBeNull()
  })

  test('cd is followed per command, and redirects or line breaks do not eat the target', () => {
    expect(classify('rm thesis.pdf; cd /tmp')).toMatchObject({ targets: ['thesis.pdf'] })
    expect(classify('cd docs && cd final && rm thesis.pdf')).toMatchObject({ targets: ['docs/final/thesis.pdf'] })
    expect(classify('cd docs && rm /abs/x.pdf')).toMatchObject({ targets: ['/abs/x.pdf'] })
    expect(classify('rm -f \\\n  ~/Documents/thesis.pdf')).toMatchObject({ targets: ['~/Documents/thesis.pdf'] })
    expect(classify('rm thesis.pdf>/dev/null')).toMatchObject({ targets: ['thesis.pdf'] })
    expect(classify('rm thesis.pdf 2>&1')).toMatchObject({ targets: ['thesis.pdf'] })
    expect(classify('rm thesis.pdf&')).toMatchObject({ targets: ['thesis.pdf'] })
  })

  test('a quoted [ stays literal for the preview, an unquoted * stays a glob', () => {
    expect(classify('rm "Thesis [v2].pdf"')).toMatchObject({ targets: ['Thesis [v2].pdf'], patterns: ['Thesis [[]v2].pdf'] })
    expect(classify('rm "my dir"/*.pdf')).toMatchObject({ patterns: ['my dir/*.pdf'] })
  })

  test('a folder above the target does not make it regenerable; ssh and shell config count', () => {
    const held = (out: string) => isWorthHolding(highlights(parseScan(out, 5000)))
    expect(held('T /Users/me/Documents/out/thesis.pdf\nS 4\nF /Users/me/Documents/out/thesis.pdf')).toBe(true)
    expect(held('T /Users/me/work/build/.env\nS 1\nF /Users/me/work/build/.env')).toBe(true)
    expect(held('T /Users/me/.ssh/config\nS 1\nF /Users/me/.ssh/config')).toBe(true)
    expect(held('T /Users/me/.zshrc\nS 1\nF /Users/me/.zshrc')).toBe(true)
    expect(held('T /Users/me/a.ipynb\nS 1\nF /Users/me/a.ipynb')).toBe(true)
    expect(held('T node_modules\nS 40\nF node_modules/x/index.js')).toBe(false)
    expect(held('T tmp\nS 4\nF tmp/build/a.js')).toBe(false)
  })

  test('an apostrophe in a comment or heredoc does not hide a later delete', () => {
    for (const cmd of ["# don't need these\nrm -rf ~/proj", "ls # it's\nrm -rf ~/proj", "cat > n.txt <<EOF\ndon't do this\nEOF\nrm -rf ~/proj", "echo $'it\\'s' ; rm -rf ~/proj"]) {
      expect(classify(cmd), cmd).toMatchObject({ risk: 'delete', targets: ['~/proj'] })
    }
    expect(classify("echo 'unclosed ; rm -rf x")).toMatchObject({ risk: 'delete', isRecursive: true, targets: ['$UNPARSED'] })
    expect(classify("cat <<EOF\nrm -rf ~/proj\nEOF")).toBeNull() // heredoc text is data
  })

  test('a delete inside $( ), backticks or <( ) is found', () => {
    for (const cmd of ['echo $(rm -rf ~/proj)', 'x=$(rm -rf ~/proj)', 'echo `rm -rf ~/proj`', 'cat <(rm -rf ~/proj)', 'echo "$(rm -rf ~/proj)"']) {
      expect(classify(cmd), cmd).toMatchObject({ risk: 'delete', targets: expect.arrayContaining(['~/proj']) })
    }
    expect(classify("echo '$(rm -rf x)'")).toBeNull()
    expect(classify('rm $(git ls-files -o) b.txt')).toMatchObject({ targets: expect.arrayContaining(['b.txt']) })
  })

  test('cd stays inside its subshell or pipeline, and pushd, cd flags and env -C are followed', () => {
    expect(classify('(cd sub && make); rm .env')).toMatchObject({ targets: ['.env'] })
    expect(classify('cd sub | true; rm .env')).toMatchObject({ targets: ['.env'] })
    expect(classify('cd sub & rm .env')).toMatchObject({ targets: ['.env'] })
    expect(classify('cd -P ~/.ssh && rm id_rsa')).toMatchObject({ targets: ['~/.ssh/id_rsa'] })
    expect(classify('pushd ~/.ssh && rm id_rsa')).toMatchObject({ targets: ['~/.ssh/id_rsa'] })
    expect(classify('env -C /x rm .env')).toMatchObject({ targets: ['/x/.env'] })
    expect(classify('cd - && rm .env')).toMatchObject({ targets: ['$OLDPWD/.env'] })
    expect(classify('git -C /x push -f')).toMatchObject({ risk: 'force-push', cwd: '/x' })
  })

  test('more wrappers and shapes: timeout, noglob, function, case, long sudo options', () => {
    for (const cmd of ['timeout 5 rm -rf ~/proj', 'noglob rm -rf ~/proj', 'sudo --user root rm -rf ~/proj', 'exec -a foo rm -rf ~/proj', 'stdbuf -o0 rm -rf ~/proj', 'f() { rm -rf ~/proj; }; f', 'function f { rm -rf ~/proj; }', 'case x in x) rm -rf ~/proj;; esac']) {
      expect(classify(cmd), cmd).toMatchObject({ risk: 'delete', targets: ['~/proj'] })
    }
  })

  test('redirect targets with quotes or | do not eat the real targets', () => {
    expect(classify('rm a >"out file" .env')).toMatchObject({ targets: ['a', '.env'] })
    expect(classify('rm -rf a>|log b')).toMatchObject({ targets: ['a', 'b'] })
    expect(classify('rm -rf build &>/dev/null')).toMatchObject({ targets: ['build'] })
  })

  test('ordinary commands are not held', () => {
    for (const cmd of ['ls -la', 'git status', 'docker rm web', 'git rm old.ts', 'npm test', 'git commit -m "it\'s a fix # not a comment"', 'echo "# hi" && cat a.txt', 'cd web && npm run build', 'git push origin main', 'git push -u origin main', 'grep -rn "rm -rf" docs']) {
      expect(classify(cmd), cmd).toBeNull()
    }
  })

  test('push is the subcommand, and --prune counts', () => {
    expect(classify('git log --grep push -d')).toBeNull()
    expect(classify("git push --prune origin 'refs/heads/*:refs/heads/*'")?.risk).toBe('force-push')
  })

  test('escaped spaces and quotes stay one path', () => {
    expect(classify('rm Important\\ Report.pdf')).toMatchObject({ targets: ['Important Report.pdf'], quotedTargets: ['Important Report.pdf'] })
    expect(classify('rm "my app/a.pdf" b.txt')).toMatchObject({ targets: ['my app/a.pdf', 'b.txt'], quotedTargets: ['my app/a.pdf'] })
  })

  test('the .env lookalikes and new secrets', () => {
    const secrets = (path: string) => highlights(parseScan(`S 1\nF ${path}`, 5000)).some(h => h.level === 'high')
    expect(secrets('app/.env.example')).toBe(false)
    expect(secrets('app/.env.local')).toBe(true)
    expect(secrets('home/.npmrc')).toBe(true)
    expect(secrets('infra/terraform.tfstate')).toBe(true)
    expect(isWorthHolding(highlights(parseScan('S 1\nF out.json\nR out.json\nN 1', 5000)))).toBe(false)
    expect(isWorthHolding(highlights(parseScan('S 1\nX some/repo', 5000)))).toBe(true)
  })

  for (const command of ['rm x.{txt,env}', 'rm $(git ls-files -o)', 'rm **/*.env']) {
    test(`a plain ${command} is held because it cannot be previewed`, async ($, on) => {
      const ran: string[] = []
      const opened: unknown[] = []
      engine(on, ran, { opened })
      const call = $.tool.call({ tool: 'Bash', command } as any)
      const ui = await heldPane($)
      expect(await ui.find({ type: 'Text', text: /미리보기 불가/ })).toBeDefined()
      await ui.press({ key: 'cancel' })
      await call
      expect(ran).toEqual([])
      await ui.unmount()
    })
  }

  test('double-quoted HOME secrets are previewed at the expanded path', async ($, on) => {
    const previews: string[][] = []
    engine(on, [], { previews, previewOutput: 'T /home/me/.ssh/id_rsa\nS 4\nF /home/me/.ssh/id_rsa' })
    const call = $.tool.call({ tool: 'Bash', command: 'rm "$HOME/.ssh/id_rsa"' } as any)
    const ui = await paneShowing($, /비밀키·환경변수/)
    expect(previews).toEqual([['/home/me/.ssh/id_rsa']])
    expect(await ui.find({ type: 'Text', text: /미리보기 불가/ })).toBeUndefined()
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test('classifier errors fall back to delete-only checks without blanket Bash denial', async ($, on) => {
    const nestedDelete = 'eval '.repeat(130) + 'rm -rf build'
    expect(() => classify(nestedDelete)).toThrow(/nesting limit/)
    expect(safeClassify(nestedDelete)).toMatchObject({ risk: 'delete', isRecursive: true, targets: ['$UNPARSED'] })
    const ran: string[] = []
    engine(on, ran, { surfaces: [] })
    expect(((await $.tool.call({ tool: 'Bash', command: nestedDelete } as any)) as any).deny).toMatch(/no screen/)
    await $.tool.call({ tool: 'Bash', command: 'eval '.repeat(130) + 'echo hi' } as any)
    expect(ran).toEqual(['eval '.repeat(130) + 'echo hi'])
  })

  test('a plain rm "$tmp" of a temp file still runs untouched', async ($, on) => {
    const ran: string[] = []
    engine(on, ran)
    await $.tool.call({ tool: 'Bash', command: 'rm -f "$tmp"' } as any)
    expect(ran).toEqual(['rm -f "$tmp"'])
  })

  test('a plain rm of an unimportant file runs without a hold', async ($, on) => {
    const ran: string[] = []
    const opened: unknown[] = []
    engine(on, ran, { opened })
    await $.tool.call({ tool: 'Bash', command: 'rm build/chunk-0.js' } as any)
    expect(ran).toEqual(['rm build/chunk-0.js'])
    expect(opened).toEqual([])
  })

  test('a plain rm of a .env is held and named in the pane', async ($, on) => {
    const ran: string[] = []
    on('tool.call', (_$: any, e: any) => {
      ran.push(e.command ?? e.tool)
      return { result: {}, text: 'ok' }
    })
    on('process.run', async (_$: any, e: any) => {
      if (e.argv[0] === 'sleep') await new Promise(done => (globalThis as any).setTimeout(done, 5))
      const stdout = e.argv[0] === SHELL_ARGV[0] ? 'S 4\nF app/.env' : ''
      return { value: { exitCode: 0, stdout, stderr: '' } } as any
    })
    on('ui.open', () => ({ value: { isPlaced: true } }) as any)
    on('ui.close', () => ({ value: undefined }) as any)
    on('session.cwd', () => ({ value: '/project' }) as any)
    on('session.surfaces', () => ({ value: ['terminal'] }) as any)
    on('env.get', () => ({ value: '/home/me' }) as any)
    mock.clock(on)
    const call = $.tool.call({ tool: 'Bash', command: 'rm app/.env' } as any)
    const ui = await heldPane($)
    expect(await ui.find({ type: 'Text', text: /비밀키·환경변수 1개: \.env/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    const result: any = await call
    expect(String(result.text ?? result.deny)).toContain('비밀키')
    expect(ran).toEqual([])
    await ui.unmount()
  })

  test('shell quoting is read as the shell reads it (finding 5)', () => {
    // Inside "…" a backslash before a space stays: the file really has a backslash in its name.
    expect(classify('rm "Important\\ Report.pdf"')?.targets).toEqual(['Important\\ Report.pdf'])
    expect(classify('rm "a\\"b"')?.targets).toEqual(['a"b'])
    // A backslash line break joins the word: this deletes .env.
    expect(classify('rm .e\\\nnv')?.targets).toEqual(['.env'])
    // A comment ends at its newline even when it ends in a backslash: the next line is a real command.
    expect(classify('echo hi # note \\\nrm .env')?.targets).toEqual(['.env'])
    expect(classify('# note \\\nrm -rf build')).toMatchObject({ risk: 'delete', isRecursive: true })
    // Mid-word the join happens first, so the # is not a comment: `ab#c` is one word and the rm still runs.
    expect(classify('echo ab\\\n#c; rm .env')?.targets).toEqual(['.env'])
    // A comment's own trailing backslash joins nothing, so a subshell on the next line still opens.
    expect(classify('true # note\\\n(rm -rf x)')).toMatchObject({ risk: 'delete', isRecursive: true })
    // bash reads `\<CR>` as an escaped CR (not a line join), so the next line is its own command.
    expect(classify('echo x\\\r\nrm -rf x')).toMatchObject({ risk: 'delete', isRecursive: true })
    // Inside double quotes the line break is dropped, in single quotes it stays.
    expect(classify('rm "a\\\nb"')?.targets).toEqual(['ab'])
  })

  test('a quoted or escaped heredoc delimiter still ends the body', () => {
    for (const open of ['<<EOF', "<<'EOF'", '<<"EOF"', '<<\\EOF', '<<E"O"F', "<<E'O'F", '<<-EOF']) {
      expect(classify(`cat ${open}\nhi\nEOF\nrm -rf x`)).toMatchObject({ risk: 'delete', isRecursive: true })
    }
    // Text inside the body is data, not a command.
    expect(classify('cat <<\\EOF\nrm -rf x\nEOF')).toBeNull()
    expect(classify('cat <<E"O"F\nrm -rf x\nEOF')).toBeNull()
  })

  test('the preview shell skips BASH_ENV and starts clean (finding 3)', () => {
    expect(SHELL_ARGV).toEqual(['/bin/bash', '--noprofile', '--norc', '-p', '-c'])
  })

  test('an rm after a command that moves or re-globs files is flagged (finding 6)', () => {
    expect(classify('mv thesis.pdf .env && rm .env')).toMatchObject({ isAfterChange: true })
    expect(classify('shopt -s dotglob; rm *')).toMatchObject({ isAfterChange: true })
    expect(classify('git checkout old -- . && rm notes.md')).toMatchObject({ isAfterChange: true })
    expect(classify('npm test && rm out.log')?.isAfterChange).toBeUndefined()
    expect(classify('rm a.txt && mv b c')?.isAfterChange).toBeUndefined()
  })

  test('read-only uses of those commands change nothing (finding 6)', () => {
    for (const before of ['shopt -q dotglob', 'shopt -p', 'shopt dotglob', 'tar -tf a.tar', 'tar tf a.tar', 'tar --list -f a.tar', 'tar -tzvf a.tgz', 'unzip -l a.zip', 'unzip -t a.zip', 'git stash list', 'git stash show -p']) {
      expect(classify(`${before} && rm out.log`)?.isAfterChange).toBeUndefined()
    }
    for (const before of ['shopt -s dotglob', 'shopt -u nullglob', 'tar -xf a.tar', 'tar xf a.tar', 'tar -czf b.tgz d', 'unzip a.zip', 'git stash', 'git stash pop', 'git stash push -m x']) {
      expect(classify(`${before} && rm out.log`)).toMatchObject({ isAfterChange: true })
    }
  })

  test('moves hidden in $( ), xargs, find -exec, more git commands and glob options are flagged too', () => {
    for (const before of [
      'true "$(mv thesis.pdf junk)"',
      'ls *.pdf | xargs -I{} mv {} junk',
      'find . -name "*.pdf" -exec mv {} junk \\;',
      'git cherry-pick abc', 'git apply fix.patch', 'git am p.mbox', 'git revert HEAD', 'git clean -fd', 'git worktree add ../w', 'git sparse-checkout set src', 'git rm old.txt',
      'set -o globdots', 'set -f', 'set +o noglob', 'setopt globdots',
    ]) {
      expect(classify(`${before}; rm junk`)).toMatchObject({ isAfterChange: true })
    }
    // Everyday forms stay quiet.
    for (const before of ['set -euo pipefail', 'set -o pipefail', 'xargs echo', 'find . -name x -print', 'git status', 'git log -1']) {
      expect(classify(`${before}; rm junk`)?.isAfterChange).toBeUndefined()
    }
  })

  test('git internals targeted directly, and the missing file types (findings 9, 10)', () => {
    const worth = (path: string) => isWorthHolding(highlights(parseScan(`T ${path}\nS 1\nF ${path}`, 5000)))
    expect(worth('.git/index')).toBe(true)
    expect(worth('repo/.git')).toBe(true)
    for (const path of ['a.xlsm', 'b.ods', 'c.odt', 'd.sqlite-wal', 'e.db-journal', 'f.sqlite3-shm']) expect(worth(path)).toBe(true)
    // A whole repo already says so once; its .git files are not listed again.
    const repo = highlights(parseScan('T app\nS 9\nF app/.git/index\nG app/.git', 5000)).map(h => h.text)
    expect(repo.filter(t => t.includes('git 내부'))).toEqual([])
  })

  test('an unknown path does not hide a known secret next to it (finding 3)', async ($, on) => {
    const ran: string[] = []
    const previews: string[][] = []
    on('tool.call', (_$: any, e: any) => {
      ran.push(e.command ?? e.tool)
      return { result: {}, text: 'ok' }
    })
    on('process.run', async (_$: any, e: any) => {
      if (e.argv[0] === 'sleep') await new Promise(done => (globalThis as any).setTimeout(done, 5))
      if (e.argv[SHELL_ARGV.length] === DELETE_SCRIPT) previews.push(e.argv.slice(AFTER_FLAG))
      const stdout = e.argv[0] === SHELL_ARGV[0] ? 'T .env\nS 4\nF .env' : ''
      return { value: { exitCode: 0, stdout, stderr: '' } } as any
    })
    on('ui.open', () => ({ value: { isPlaced: true } }) as any)
    on('ui.close', () => ({ value: undefined }) as any)
    on('session.cwd', () => ({ value: '/project' }) as any)
    on('session.surfaces', () => ({ value: ['terminal'] }) as any)
    on('env.get', () => ({ value: '/home/me' }) as any)
    mock.clock(on)
    const call = $.tool.call({ tool: 'Bash', command: 'rm .env "$tmp"' } as any)
    const ui = await heldPane($)
    expect(previews).toEqual([['.env']])
    expect(await ui.find({ type: 'Text', text: /비밀키·환경변수 1개: \.env/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    await call
    expect(ran).toEqual([])
    await ui.unmount()
  })
})

