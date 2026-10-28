// Blast Radius: holds risky commands and file access, showing what they would change.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Next, Register, ToolCallResult } from 'claude-code'

import type { HeldCommand, Highlight, PreviewItem, PreviewSection, WaitingCall } from '../types'
import { formatDeleteDetail, highlights, isSecretName, isWorthHolding, parseScan } from './importance'
import { CONTENT_SCRIPT, DELETE_SCRIPT, FILE_CAP, FILE_SCRIPT, MAX_LISTED, MIGRATION_SCRIPT, SAFE_ENV, SHELL_ARGV } from './script'

const PANE = 'blast-radius'
const DEFAULT_TIMEOUT_SECONDS = 60
const DEFAULT_TRUSTED_FOLDERS = '~/.claude, ~/.codex, ~/.agents'
const NOTHING = 'delete nothing that exists right now'
// `rm -rf build tmp/out`: one rm, flags only before the paths, each path letters, digits and . _ - / with no `..`.
// Spaces and tabs only, so it is always one line (zsh's `chdir` on a next line moves the shell
// unseen), and no path may start with `-` (macOS rm takes `-cache` after a path as a path).
const BARE_RECURSIVE_RM = /^[ \t]*rm[ \t]+-[rRf]+(?:[ \t]+-[rRf]+)*(?:[ \t]+(?!-)(?!\S*\.\.)[\w./-]+)+[ \t]*$/

// Held by the host, so the drawing redraws when a command is held or released.
const held = atom({ plugin: 'blast-radius', key: 'held' } as const, null as HeldCommand | null)
const waiting = atom({ plugin: 'blast-radius', key: 'waiting' } as const, [] as WaitingCall[])

const MIGRATION =
  /\b(prisma\s+(migrate|db\s+push)|supabase\s+(db\s+(reset|push)|migration\s+up)|drizzle-kit\s+(push|migrate)|knex\s+migrate|sequelize(-cli)?\s+db:migrate|rails\s+db:(migrate|reset|drop)|alembic\s+(upgrade|downgrade)|typeorm\s+migration:run)\b/

type Risk = {
  risk: HeldCommand['risk']
  root?: string
  action?: string
  cwd?: string
  targets?: string[]
  // Targets written with quotes or escapes: the shell does not expand ~ in these.
  quotedTargets?: string[]
  // Original shell words retain which HOME references and metacharacters were literal.
  shellTargets?: string[]
  shellCwd?: string
  // The targets as glob patterns: a quoted `[`, `*` or `?` is escaped, so it stays literal.
  patterns?: string[]
  isRecursive?: boolean
  // Outside targets first written with a `..` segment: the OS follows a symlink before `..`, and the
  // folded path cannot show where that lands, so these are never treated as trusted.
  dotted?: string[]
  unresolved?: boolean
  // An earlier part of the command moves, copies or re-globs files (`mv a.pdf .env && rm .env`),
  // so a preview taken now may not show what the rm will meet.
  isAfterChange?: boolean
  // Other risks in the same command, so one Proceed never hides a second one.
  also?: Risk[]
}
type Measured = Pick<HeldCommand, 'summary' | 'details' | 'highlights' | 'sections'>

export type ProjectContext = { root: string; cwd: string; home: string; logicalRoot?: string }
const PROJECT_SCRIPT = `${SAFE_ENV}git rev-parse --show-toplevel`

async function projectContext($: EngineInterface): Promise<ProjectContext | undefined> {
  try {
    const cwd = normalizePath(await $.session.cwd())
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    const git = await $.process.run([...SHELL_ARGV, PROJECT_SCRIPT], { cwd, timeoutMs: 2_000 }).catch(() => undefined)
    const root = normalizePath(git?.exitCode === 0 && git.stdout.trim().startsWith('/') ? git.stdout.trim() : cwd)
    let logicalRoot = root
    if (!under(cwd, root)) {
      const real = (await $.fs.stat(cwd, { resolve: true }).catch(() => undefined))?.realPath
      const suffix = real && under(normalizePath(real), root) ? normalizePath(real).slice(root.length) : ''
      logicalRoot = suffix && cwd.endsWith(suffix) ? cwd.slice(0, -suffix.length) : cwd
    }
    return { cwd, root, home, logicalRoot }
  } catch {
    // Context is optional: a failed cwd lookup must not disable secret/delete/push checks.
    return undefined
  }
}

const DOTDOT = /(?:^|\/)\.\.(?:\/|$)/

function normalizePath(path: string): string {
  const parts: string[] = []
  for (const p of path.split('/')) {
    if (p === '..') parts.pop()
    else if (p && p !== '.') parts.push(p)
  }
  return `/${parts.join('/')}`
}

export function resolvePath(path: string, context: ProjectContext): string {
  // Native tool paths are literal. Brackets, spaces, dollar signs and tildes are file names.
  return normalizePath(path.startsWith('/') ? path : `${context.cwd}/${path}`)
}

const under = (path: string, root: string) => root === '/' || path === root || path.startsWith(`${root}/`)

function trustedPath(path: string, context: ProjectContext): string | undefined {
  const expanded = path.replace(/^(?:~(?=\/|$)|\$HOME(?=\/|$)|\$\{HOME\}(?=\/|$))/, context.home)
  if (!context.home && /^(?:~(?=\/|$)|\$HOME(?=\/|$)|\$\{HOME\}(?=\/|$))/.test(path)) return undefined
  return resolvePath(expanded, context)
}

// Only a missing path permits trying its parent. Broken links or resolution refusals stay held.
async function existingRealPath($: EngineInterface, path: string, ancestors: boolean): Promise<string | undefined> {
  let current = path
  for (;;) {
    try {
      const stat = await $.fs.stat(current, { resolve: true })
      if (!stat.realPath?.startsWith('/') || (current !== path && stat.kind !== 'dir')) return undefined
      return normalizePath(stat.realPath)
    } catch (error) {
      const missing = error !== null && typeof error === 'object'
        && (('code' in error && error.code === 'ENOENT')
          || ('message' in error && typeof error.message === 'string' && /\bENOENT\b/.test(error.message)))
      if (!ancestors || !missing || current === '/') return undefined
      current = current.slice(0, current.lastIndexOf('/')) || '/'
    }
  }
}

async function relaxTrustedOutside(
  $: EngineInterface, found: Risk | null, folders: string[], context?: ProjectContext,
): Promise<Risk | null> {
  if (!found || !context) return found
  const risks = [found, ...(found.also ?? [])]
  if (!risks.some(risk => risk.risk === 'outside')) return found
  const roots = (await Promise.all(folders.map(async folder => {
    const path = trustedPath(folder, context)
    return path === undefined ? undefined : existingRealPath($, path, false)
  }))).filter((path): path is string => path !== undefined)
  if (roots.length === 0) return found
  const filtered = await Promise.all(risks.map(async ({ also, ...risk }) => {
    if (risk.risk !== 'outside') return risk
    const targets = await Promise.all((risk.targets ?? []).map(async target => {
      if (risk.dotted?.includes(target)) return target
      const path = trustedPath(target, context)
      const real = path === undefined ? undefined : await existingRealPath($, path, true)
      return real !== undefined && roots.some(root => under(real, root)) ? undefined : target
    }))
    const remaining = targets.filter((target): target is string => target !== undefined)
    return remaining.length > 0 ? { ...risk, targets: remaining } : null
  }))
  return combineRisks(filtered.filter((risk): risk is Risk => risk !== null))
}

function resolveShellPath(target: Where, context: ProjectContext): string | undefined {
  const token = split(target.raw, [], context.home)[0]
  // Known gap: active unknown variables, substitutions and globs need shell evaluation.
  // Skip those Bash words to avoid false alarms; native tool paths never use this exclusion.
  if (!token || token.unresolved || token.opaque || /[*?\[]/.test(token.glob.replace(/\[\*\]|\[\?\]|\[\[\]/g, ''))) return undefined
  return resolvePath(token.text, context)
}

// /dev/ is devices, not files: `2>/dev/null`, `> /dev/stderr` write nothing to disk.
function outside(path: string, context: ProjectContext): boolean {
  const logical = context.logicalRoot ?? (under(context.cwd, context.root) ? context.root : context.cwd)
  const memory = context.home && path.startsWith(`${normalizePath(context.home)}/.claude/projects/`)
    && /\/\.claude\/projects\/.+\/memory(?:\/|$)/.test(path.slice(normalizePath(context.home).length))
  // Plan mode writes its plan file here on every plan; holding it would stop each one.
  const plans = context.home && under(path, `${normalizePath(context.home)}/.claude/plans`)
  return !under(path, context.root) && !under(path, logical) && !memory && !plans && !/^\/(tmp|private\/tmp|var\/folders|private\/var\/folders|dev)\//.test(path)
}

type FileTarget = { tool: string; path: string; glob?: string }
export function fileTarget(input: unknown): FileTarget | undefined {
  if (!input || typeof input !== 'object' || !('tool' in input)) return undefined
  const tool = input.tool
  if (typeof tool !== 'string' || !['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep'].includes(tool)) return undefined
  const path = tool === 'NotebookEdit' && 'notebook_path' in input ? input.notebook_path
    : tool === 'Grep' && 'path' in input ? input.path
    : 'file_path' in input ? input.file_path : undefined
  const glob = tool === 'Grep' && 'glob' in input && typeof input.glob === 'string' ? input.glob : undefined
  if (typeof path === 'string' && path) return { tool, path, ...(glob ? { glob } : {}) }
  return tool === 'Grep' && glob ? { tool, path: '', glob } : undefined
}

export function classifyFileTool(file: FileTarget, context?: ProjectContext): Risk | null {
  const risks: Risk[] = []
  const secrets = [
    ...(isSecretName(file.path.slice(file.path.lastIndexOf('/') + 1), true) ? [file.path] : []),
    ...(file.glob && secretWord(file.glob) ? [file.glob] : []),
  ]
  if (secrets.length > 0) {
    risks.push({ risk: 'secret', targets: secrets, action: ['Read', 'Grep'].includes(file.tool) ? 'read' : 'edit' })
  }
  if (context && !['Read', 'Grep'].includes(file.tool)) {
    const path = resolvePath(file.path, context)
    if (outside(path, context)) risks.push({ risk: 'outside', root: context.root, targets: [path], ...(DOTDOT.test(file.path) ? { dotted: [path] } : {}) })
  }
  return combineRisks(risks)
}

async function realFileTarget($: EngineInterface, abs: string): Promise<string | undefined> {
  let current = abs
  const tail: string[] = []
  for (;;) {
    try {
      const stat = await $.fs.stat(current, { resolve: true })
      // The host folds stat request paths; a link before .. cannot be verified through it.
      if (DOTDOT.test(abs)) return undefined
      if (!stat.realPath?.startsWith('/') || (tail.length > 0 && stat.kind !== 'dir')) return undefined
      return [stat.realPath.replace(/\/$/, ''), ...tail].join('/') || '/'
    } catch (error) {
      const missing = error !== null && typeof error === 'object'
        && (('code' in error && error.code === 'ENOENT')
          || ('message' in error && typeof error.message === 'string' && /\bENOENT\b/.test(error.message)))
      // Folding .. before following a link would describe a different OS target.
      if (!missing || DOTDOT.test(abs) || current === '/') return undefined
      const slash = current.lastIndexOf('/')
      tail.unshift(current.slice(slash + 1))
      current = current.slice(0, slash) || '/'
    }
  }
}

async function classifyResolvedFile($: EngineInterface, file: FileTarget, context?: ProjectContext): Promise<Risk | null> {
  const typed = classifyFileTool(file, context)
  const risks = typed ? [typed, ...(typed.also ?? [])].map(({ also, ...risk }) => risk) : []
  const abs = file.path.startsWith('/') ? file.path : context ? `${context.cwd}/${file.path}` : undefined
  const real = abs === undefined ? undefined : await realFileTarget($, abs)
  const reading = ['Read', 'Grep'].includes(file.tool)
  if (real === undefined || (!reading && !context)) {
    const target = abs ?? (file.path || file.glob || '(cwd)')
    risks.push(reading
      ? { risk: 'secret', targets: [target], action: '대상을 확인할 수 없음: read', unresolved: true }
      : { risk: 'outside', root: context?.root, targets: [target], dotted: [target], unresolved: true })
  } else {
    const path = normalizePath(real)
    if (isSecretName(path.slice(path.lastIndexOf('/') + 1), true) && !risks.some(risk => risk.targets?.includes(real))) {
      risks.unshift({ risk: 'secret', targets: [real], action: reading ? 'read' : 'edit' })
    }
    if (!reading && context && outside(path, context) && !risks.some(risk => risk.risk === 'outside' && risk.targets?.includes(real))) {
      risks.push({ risk: 'outside', root: context.root, targets: [real], ...(DOTDOT.test(file.path) ? { dotted: [real] } : {}) })
    }
    // Show the resolved target even when only the typed name caused the hold.
    if (risks.length > 0 && abs !== real) {
      for (const risk of risks) {
        if (!risk.targets?.includes(real)) risk.targets = [...(risk.targets ?? []), real]
        if (DOTDOT.test(file.path) && risk.risk === 'outside') risk.dotted = risk.targets
      }
    }
  }
  return combineRisks(risks)
}

type GlobChar = { star: boolean; literal?: string; test: (c: string) => boolean }
function globChars(pattern: string): GlobChar[] {
  const chars: GlobChar[] = []
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*' || c === '?') chars.push({ star: c === '*', test: () => true })
    else if (c === '[' && pattern.indexOf(']', i + 1) > i + 1) {
      const end = pattern.indexOf(']', i + 1)
      const body = pattern.slice(i + 1, end)
      const match = new RegExp(`^[${body.startsWith('!') ? '^' + body.slice(1) : body.replace(/^\^/, '\\^')}]$`, 'i')
      chars.push({ star: false, test: value => match.test(value) })
      i = end
    } else chars.push({ star: false, literal: c, test: value => value.toLowerCase() === c.toLowerCase() })
  }
  return chars
}

// Intersect a glob with a secret-name shape. Shapes use only literal characters, * and ?.
// This covers arbitrary .env suffixes and key basenames without a finite list of example files.
function intersects(glob: GlobChar[], shape: string): boolean {
  const secret = globChars(shape)
  const pending: [number, number][] = [[0, 0]]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const [i, j] = pending.pop()!
    const key = `${i}:${j}`
    if (visited.has(key)) continue
    visited.add(key)
    if (i === glob.length && j === secret.length) return true
    const a = glob[i], b = secret[j]
    if (a?.star) pending.push([i + 1, j])
    if (b?.star) pending.push([i, j + 1])
    // A glob `*` never stands in for a shape's literal characters: otherwise `*.ts*` "could be"
    // `a.ts.pem` and every trailing-star glob would be held. `?` and `[...]` still may.
    if (a && b && !(a.star && b.literal !== undefined) && (b.literal !== undefined ? a.test(b.literal) : a.literal !== undefined ? b.test(a.literal) : true)) {
      pending.push([a.star ? i : i + 1, b.star ? j : j + 1])
    }
  }
  return false
}

const SECRET_SHAPES = [
  '.env', '.env.?*', '.npmrc', '.netrc', '.pgpass', '.htpasswd',
  'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub', 'id_ecdsa', 'id_ecdsa.pub',
  'credentials', 'credentials.json',
  ...['pem', 'key', 'p8', 'p12', 'pfx', 'jks', 'keystore', 'kdbx', 'gpg', 'tfstate'].map(ext => `?*.${ext}`),
]

// Option/ref operands can name files after '=' or ':'. Quoted glob characters stay literal.
function secretWord(word: string): boolean {
  const names = [word, word.slice(word.lastIndexOf('=') + 1), word.slice(word.lastIndexOf(':') + 1)]
    .map(p => p.slice(p.lastIndexOf('/') + 1))
  return names.some(name => {
    if (/\.(example|sample|template|dist)$/i.test(name)) return false
    // Text, not a file name: spaces, pipes, parentheses, backslashes, or brackets that are no glob class
    // (`Rotate server.key`, `.[].key`, `\.key`).
    if (/[\s|()\\{}]/.test(name) || /[[\]]/.test(name.replace(/\[!?[^\]]+\]/g, ''))) return false
    if (isSecretName(name)) return true
    if (!/[*?\[]/.test(name)) return false
    try {
      const glob = globChars(name)
      return SECRET_SHAPES.some(shape => intersects(glob, shape))
    } catch { return false }
  })
}

function combineRisks(risks: Risk[]): Risk | null {
  const [first, ...rest] = risks
  if (!first) return null
  return rest.length > 0 ? { ...first, also: rest } : first
}

type HoldQueue = { holder: string | null; holdId?: string; decisions: Map<string, 'proceed' | 'cancel'>; timeoutSeconds: number }
type WorkbenchApproval = { id: string; decision: 'proceed' | 'cancel'; at: number; holdId?: string; command?: string }
let holdCounter = 0

async function workbenchDecision($: EngineInterface, one: HeldCommand): Promise<'proceed' | 'cancel' | undefined> {
  try {
    // Workbench is optional: a local read type avoids a dependency back to its pane.
    const { value } = await ($.state as {
      get(ref: { plugin: 'workbench'; key: 'approvals' }): Promise<{ value?: unknown }>
    }).get({ plugin: 'workbench', key: 'approvals' })
    if (!Array.isArray(value)) return undefined
    const entries: unknown[] = value
    if (!entries.every((entry): entry is WorkbenchApproval => entry !== null && typeof entry === 'object'
      && 'id' in entry && typeof entry.id === 'string'
      && 'decision' in entry && (entry.decision === 'proceed' || entry.decision === 'cancel')
      && 'at' in entry && typeof entry.at === 'number' && Number.isFinite(entry.at))) return undefined
    const entry = entries.findLast(entry => entry.id === one.id)
    if (entry?.decision === 'cancel') return 'cancel'
    if (one.holdId && entry?.holdId === one.holdId && entry.command === one.command) return entry.decision
  } catch {
    // An absent or unreadable workbench must leave the existing hold controls working.
  }
  return undefined
}

async function callerName($: EngineInterface, agentId?: string): Promise<string> {
  if (agentId === undefined) return '메인'
  const agent = (await $.agent.list().catch(() => [])).find(agent => agent.id === agentId)
  const name = agent?.type || agent?.name
  return name ? `에이전트: ${singleLine(name)}` : '에이전트'
}

async function hold(
  $: EngineInterface,
  queue: HoldQueue,
  call: { id: string; command: string; risk: HeldCommand['risk']; agentId?: string },
  next: Pick<Next<'tool.call'>, 'signal'>,
  proceed: () => Promise<ToolCallResult>,
  preview: () => Promise<Measured>,
  decide: (id: string, decision: 'proceed' | 'cancel', holdId?: string) => void,
): Promise<ToolCallResult> {
  // Nothing draws the session (a plain `claude -p` run): nobody can see the buttons, so refuse now.
  if ((await $.session.surfaces()).length === 0) {
    const measured = await preview()
    return {
      deny:
        `blast-radius: cancelled this command because this session has no screen, so nobody can answer. ` +
        `It would have: ${spoken(measured)}. Ask the user to run it themselves.`,
    }
  }

  const who = await callerName($, call.agentId)
  const removeWaiting = () => update($, waiting, calls => calls.filter(one => one.id !== call.id))
  try {
    // One command is held at a time; every other caller stays visible while it waits.
    for (;;) {
      if (next.signal.aborted) return { deny: 'blast-radius: held this command, but the call was stopped before it was shown.' }
      await update($, waiting, calls => calls.some(one => one.id === call.id)
        ? calls : [...calls, { id: call.id, command: call.command, who, agentId: call.agentId }])
      if (queue.holder === null && (await read($, held)) === null && queue.holder === null) break
      await $.process.run(['sleep', '0.25'])
    }
    queue.holder = call.id
    queue.decisions.delete(call.id)
  } finally {
    if (queue.holder !== call.id) await removeWaiting().catch(() => {})
  }
  let closed = false
  try {
    const measured = await preview()
    const one: HeldCommand = {
      ...call,
      holdId: `${call.id}:${++holdCounter}`,
      who,
      ...measured,
      where: 'pane',
      secondsLeft: queue.timeoutSeconds > 0 ? queue.timeoutSeconds : null,
    }
    queue.holdId = one.holdId
    await update($, held, () => one)
    await removeWaiting()
    const checkApproval = async () => {
      if (queue.decisions.has(one.id)) return
      const decision = await workbenchDecision($, one)
      // A band press made while this read was in flight wins: it is the newer press.
      if (decision && !queue.decisions.has(one.id)) decide(one.id, decision, one.holdId)
    }
    await checkApproval() // A waiting cancellation applies before the first sleep.

    const opened = await $.ui.open({ id: PANE, title: 'Blast Radius', focus: true })
    if (!opened.isPlaced) {
      await update($, held, h => (h ? { ...h, where: 'band' as const } : h)) // too narrow for a pane: draw above the prompt
    }

    // Time spent inside $ calls doesn't count against the hook's time limit.
    // Nobody pressing within the timeout counts as Cancel, so an unattended session never stalls.
    const deadline = queue.timeoutSeconds > 0 ? (await $.clock.now()) + queue.timeoutSeconds * 1000 : null
    let isTimedOut = false
    while (!queue.decisions.has(one.id) && !next.signal.aborted) {
      await checkApproval()
      if (queue.decisions.has(one.id)) break
      if (deadline !== null) {
        const left = Math.ceil((deadline - (await $.clock.now())) / 1000)
        if (left <= 0) {
          isTimedOut = !queue.decisions.has(one.id) // a press that landed at the deadline still counts
          break
        }
        if (left !== one.secondsLeft) {
          one.secondsLeft = left
          await update($, held, h => (h && h.id === one.id ? { ...h, secondsLeft: left } : h))
        }
      }
      await $.process.run(['sleep', '0.25'])
    }
    const decision = isTimedOut ? 'cancel' : (queue.decisions.get(one.id) ?? 'cancel')
    queue.decisions.delete(one.id)
    await update($, held, () => null)
    await $.ui.close({ id: PANE })
    closed = true

    if (decision === 'proceed') return proceed() // runs as written
    if (isTimedOut) {
      return {
        deny:
          `blast-radius: held this command and nobody answered within ${queue.timeoutSeconds} s, so it was cancelled. ` +
          `It would have: ${spoken(one)}. Don't retry it on your own: ask the user to run it, or run it again once they're back.`,
      }
    }
    return {
      deny: `blast-radius: the user pressed Cancel on this command. It would have: ${spoken(one)}.`,
    }
  } finally {
    queue.decisions.delete(call.id)
    await removeWaiting().catch(() => {})
    // If the hold failed partway, don't leave its command blocking the next call.
    await update($, held, h => (h && h.id === call.id ? null : h)).catch(() => {})
    if (!closed) await $.ui.close({ id: PANE }).catch(() => {})
    queue.holdId = undefined
    queue.holder = null
    await removeWaiting().catch(() => {})
  }
}

export const register: Register = (on, options) => {
  // How long a held command waits for a press before it is cancelled; 0 waits forever.
  const timeoutSeconds = timeoutFrom(options.timeoutSeconds)
  const trustedFolders = trustedFoldersFrom(options.trustedFolders)
  // Bash and file tools share one queue and decisions keyed by held call id.
  const queue: HoldQueue = { timeoutSeconds, decisions: new Map(), holder: null }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let needsContext = false
    let deleteHadOutsideRisk = false
    let found = safeClassify(e.command, undefined, () => { needsContext = true })
    if (needsContext) {
      const context = await projectContext($)
      found = safeClassify(e.command, context)
      deleteHadOutsideRisk = found?.risk === 'delete' && (found.also ?? []).some(risk => risk.risk === 'outside')
      found = await relaxTrustedOutside($, found, trustedFolders, context)
    }
    if (!found) return next(e)
    // A plain rm is held only when it would delete something that matters. `rm -rf` is let through
    // only when it is the whole command, names plain literal paths, and none of them exists: any
    // quoting, escape, `..` or earlier command can make the preview look at a different path.
    const isBareRecursive = found.isRecursive === true && BARE_RECURSIVE_RM.test(e.command)
    // Removing an outside note must not make a previously held delete eligible to skip its hold.
    const early = found.risk === 'delete' && !found.also && !deleteHadOutsideRisk && (!found.isRecursive || isBareRecursive) ? await measure($, found) : undefined
    if (early && !found.isRecursive && !isWorthHolding(early.highlights)) return next(e)
    if (early && isBareRecursive && early.summary === NOTHING && early.highlights.length === 0) return next(e)
    return hold($, queue, { id: e.tool_use_id, command: e.command, risk: found.risk, agentId: e.agentId }, next, () => next(e), () => early ? Promise.resolve(early) : measure($, found), decide)
  })

  // Grep is absent from this build's generated tool table; validate its path at the boundary.
  // MultiEdit is absent too, so it has no registration in this build.
  on('tool.call', { tool: ['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep'] }, async ($, e, next) => {
    const file = fileTarget(e)
    if (!file) return next(e)
    const context = await projectContext($)
    const found = await relaxTrustedOutside($, await classifyResolvedFile($, file, context), trustedFolders, context)
    if (!found) return next(e)
    return hold($, queue, { id: e.tool_use_id, command: `${file.tool} ${file.path || file.glob}`, risk: found.risk, agentId: e.agentId }, next, () => next(e), () => measure($, found), decide)
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'blast-radius: cancelled this command because the file protection failed. Ask the user to run it themselves.' })

  // The hook's loop picks the press up.
  const decide = (id: string, decision: 'proceed' | 'cancel', holdId?: string) => {
    // Call ids can be reused; only the preview that owns this hold may proceed.
    if (queue.holder === id && (decision === 'cancel' || (holdId !== undefined && holdId === queue.holdId))) queue.decisions.set(id, decision)
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const one = await read($, held)
    const { Text } = $.ui.resolve(e)
    if (!one) return <Text dimColor>보류 중인 명령 없음</Text>
    return report($, e, one, await read($, waiting), decide, false)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const one = await read($, held)
    if (!one || e.props.hasSurvey) return next(e)
    // Drawn above the prompt even when the pane is open: a pane can sit where nobody is looking,
    // and a hold nobody sees just times out. A held command takes the whole band until answered.
    return report($, e, one, await read($, waiting), decide, true)
  })
}

function report(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  one: HeldCommand,
  pending: WaitingCall[],
  decide: (id: string, d: 'proceed' | 'cancel', holdId?: string) => void,
  isCompact: boolean,
) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const label = { delete: '파일 삭제', 'force-push': '강제 푸시', migration: 'DB 마이그레이션', secret: '비밀 파일 접근', outside: '프로젝트 밖 쓰기' }[one.risk]
  const go = { delete: '삭제하기', 'force-push': '푸시하기', migration: '실행하기', secret: '진행하기', outside: '진행하기' }[one.risk]
  const sections: PreviewSection[] = one.sections ?? [{ summary: one.summary, items: one.details.map(text => ({ text })) }]
  let remaining = isCompact ? 3 : Infinity
  const shown = sections.map(section => {
    const items = section.items.slice(0, remaining)
    remaining -= items.length
    return { ...section, items }
  })
  const omitted = sections.reduce((n, section) => n + section.items.length, 0) - shown.reduce((n, section) => n + section.items.length, 0)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="wrap">
        <Text color="red" bold>{'⚠ Blast Radius가 명령을 멈춤 '}</Text>
        <Text dimColor>{`(${label})`}</Text>
        <Text bold>{` · ${singleLine(one.who ?? '메인')}`}</Text>
      </Text>
      <Text color="yellow" wrap="wrap">{`$ ${singleLine(one.command)}`}</Text>
      {one.highlights.map(item => (
        <Text color={item.level === 'high' ? 'red' : item.level === 'mid' ? 'yellow' : undefined} dimColor={item.level === 'low'} bold={item.level === 'high'} wrap="wrap">
          {`${item.level === 'high' ? '!! ' : item.level === 'mid' ? ' ! ' : '   '}${singleLine(item.uiText ?? item.text)}`}
        </Text>
      ))}
      {shown.map(section => (
        <Box flexDirection="column">
          <Text bold wrap="wrap">{singleLine(section.summary)}</Text>
          {section.items.map(item => (
            <Box flexDirection="column">
              <Text dimColor wrap="wrap">{`  ${singleLine(item.text)}`}</Text>
              {item.content !== undefined && <Text dimColor wrap="wrap">{`    내용: ${singleLine(item.content)}`}</Text>}
            </Box>
          ))}
        </Box>
      ))}
      {omitted > 0 && <Text dimColor wrap="wrap">{`  … ${omitted}개 더`}</Text>}
      <Text color="cyan" wrap="wrap">버튼을 클릭해서 고르세요. workbench 에이전트 탭에서도 고를 수 있어요.</Text>
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {/* No hotkeys: a key typed into the prompt must never answer a hold. A click or Tab and Enter presses. */}
        <Button key="proceed" label={go} onPress={() => decide(one.id, 'proceed', one.holdId)} />
        <Button key="cancel" label="취소" variant="primary" autoFocus onPress={() => decide(one.id, 'cancel', one.holdId)} />
        {one.secondsLeft != null && (
          <Text key="countdown" wrap="wrap" color={one.secondsLeft <= 10 ? 'yellow' : undefined} dimColor={one.secondsLeft > 10}>
            {`${one.secondsLeft}초 후 자동 취소`}
          </Text>
        )}
      </Box>
      {pending.length > 0 && (
        <Box flexDirection="column">
          <Text bold wrap="wrap">{`대기 ${pending.length}개`}</Text>
          {pending.map(call => <Text key={call.id} dimColor wrap="wrap">{`${singleLine(call.who)} · ${fit(singleLine(call.command))}`}</Text>)}
        </Box>
      )}
    </Box>
  )
}

const singleLine = (text: string) => text.replace(/\r\n|[\r\n]/g, ' ⏎ ')
// Waiting calls only: the held command itself is always shown whole, wrapped, since it is what gets approved.
const fit = (text: string, max = 100) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

// What the model is told it would have done: the important parts first, so it knows why it was stopped.
function spoken(m: Pick<Measured, 'summary' | 'highlights'>): string {
  const key = m.highlights.filter(item => item.level !== 'low').map(item => item.text)
  return key.length > 0 ? `${m.summary}, including ${key.join('; ')}` : m.summary
}

// The timeoutSeconds option as whole seconds: a number or a numeric string, 0 to wait forever.
export function timeoutFrom(value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return DEFAULT_TIMEOUT_SECONDS
  return Math.ceil(n) // a positive fraction stays a timeout, never 0 (wait forever)
}

export function trustedFoldersFrom(value: unknown): string[] {
  const folders = typeof value === 'string' ? value.split(',').map(folder => folder.trim()) : []
  // Each must name a folder below home or below /: `/`, `~`, relative paths and `..` would trust far too much.
  const isNarrow = (folder: string) => /^(?:~|\$HOME|\$\{HOME\}|)\/[^/]/.test(folder) && !DOTDOT.test(folder)
  return folders.length > 0 && folders.every(folder => folder !== '' && !/[\u0000\r\n]/.test(folder) && isNarrow(folder))
    ? folders : DEFAULT_TRUSTED_FOLDERS.split(',').map(folder => folder.trim())
}

// Which risky kinds a command holds, looking at every part of a compound command:
// `rm tmp.log && rm -rf ~/project` must be judged by its worst part, not its first.
type Tok = { text: string; glob: string; raw: string; isQuoted: boolean; unresolved: boolean; opaque: boolean }
type Where = { text: string; glob: string; raw: string; quoted: boolean }

// Keep classifier failures local to classification, without a blanket Bash hook .catch.
export function safeClassify(command: string, context?: ProjectContext, onWrite?: () => void): Risk | null {
  try { return classify(command, context, onWrite) } catch {
    // The old delete protection remains possible even when parsing a deeply nested body fails.
    return /(^|[\s;'"(])(?:\/[^\s;'"()]+\/)?rm(?=\s|$)/.test(command)
      ? { risk: 'delete', isRecursive: true, targets: ['$UNPARSED'], patterns: ['$UNPARSED'] } : null
  }
}

export function classify(command: string, context?: ProjectContext, onWrite?: () => void): Risk | null {
  let cwd: Where | undefined
  const risks: Risk[] = []
  let sawRm = false
  let isRecursive = false
  let hasChanged = false
  let isAfterChange = false
  const targets: string[] = []
  const patterns: string[] = []
  const quotedTargets: string[] = []
  const shellTargets: string[] = []
  const secrets = new Set<string>()
  const external = new Set<string>()
  const dotted = new Set<string>()
  // A relative path is read from the folder the earlier `cd`s lead to, as the shell would.
  const from = (base: Where | undefined, t: Tok): Where => {
    if (!base || t.text.startsWith('/') || /^[~$]/.test(t.raw)) return { text: t.text, glob: t.glob, raw: t.raw, quoted: t.isQuoted }
    return { text: `${base.text}/${t.text}`, glob: `${base.glob}/${t.glob}`, raw: `${base.raw}/${t.raw}`, quoted: base.quoted || t.isQuoted }
  }
  const unknown: Where = { text: '$OLDPWD', glob: '$OLDPWD', raw: '$OLDPWD', quoted: false }

  const run = (text: string, nesting = 0) => {
    if (nesting > 128) throw new Error('command nesting limit')
    const { parts, subs, isUnterminated } = splitParts(text)
    // Quotes that never close: nothing after them can be read, so the whole command is held.
    if (isUnterminated) {
      sawRm = true
      isRecursive = true
      targets.push('$UNPARSED')
      patterns.push('$UNPARSED')
      shellTargets.push('$UNPARSED')
    }
    // A substitution that changes files makes this level's delete preview provisional.
    if (subs.some(sub => textChangesFiles(sub.text))) hasChanged = true
    // `cd` inside ( ), a pipeline side or a background job does not move the shell that runs the next command.
    const stack: (Where | undefined)[] = []
    let depth = 0
    for (const [partIndex, part] of parts.entries()) {
      while (part.depth > depth) {
        stack.push(cwd)
        depth++
      }
      while (part.depth < depth) {
        cwd = stack.pop()
        depth--
      }
      const before = cwd
      // Substitutions run in this part's folder, before its cd/wrapper changes the command's cwd.
      for (const sub of subs.filter(sub => sub.part === partIndex)) {
        run(sub.text, nesting + 1)
        cwd = before
      }
      const redirects: Redirect[] = []
      const all = split(part.text.trim(), redirects, context?.home)
      const { at, dir } = commandAt(all)
      const toks = all.slice(at)
      const words = toks.map(t => t.text)
      const head = words[0] ?? ''
      const here = dir ? from(cwd, dir) : cwd
      const isRm = /(^|\/)rm$/.test(head)
      const body = commandBody(toks)
      if (body !== undefined) {
        const previous = cwd
        cwd = here
        run(body, nesting + 1)
        if (head !== 'eval') cwd = previous
      }
      // rm operands already get the full secret-aware delete preview; redirects still count.
      // A jq-style filter (`jq '.data.key' x.json`) is a program, not a file name.
      const filter = /(^|\/)(jq|gojq|jaq|yq)$/.test(head) ? toks.slice(1).find(t => !t.text.startsWith('-')) : undefined
      const access = [...(isRm ? [] : all.filter(t => t !== filter)), ...redirects.filter(r => r.isFile).map(r => r.target)]
      for (const t of access) {
        if (secretWord(t.glob)) secrets.add(from(here, t).text)
      }
      const writes = writeTargets(toks)
      if (writes.length > 0) onWrite?.()
      if (context) {
        for (const t of writes) {
          const target = from(here, t)
          const resolved = resolveShellPath(target, context)
          if (resolved && outside(resolved, context)) {
            external.add(resolved)
            if (DOTDOT.test(target.text) || DOTDOT.test(t.text)) dotted.add(resolved)
          }
        }
      }
      if (head === 'cd' || head === 'pushd') {
        const arg = toks.slice(1).find(t => !t.text.startsWith('-') || t.text === '-')
        cwd = !arg ? { text: '~', glob: '~', raw: '~', quoted: false } : arg.text === '-' ? unknown : from(cwd, arg)
      } else if (head === 'popd') cwd = unknown
      if (isRm) {
        sawRm = true
        if (hasChanged) isAfterChange = true
        let isPastFlags = false
        for (const token of toks.slice(1)) {
          const word = token.text
          if (!isPastFlags && word === '--') {
            isPastFlags = true
            continue
          }
          if (!isPastFlags && word.startsWith('-')) {
            // GNU rm accepts any unambiguous prefix of a long option (`--recur`).
            if (word.startsWith('--') ? word.length > 2 && 'recursive'.startsWith(word.slice(2)) : /^-[a-zA-Z]+$/.test(word) && /[rR]/.test(word)) isRecursive = true
            continue
          }
          const target = from(here, token)
          targets.push(target.text)
          patterns.push(target.glob)
          shellTargets.push(target.raw)
          if (target.quoted) quotedTargets.push(target.text)
        }
      }
      if (/(^|\/)git$/.test(head)) {
        const git = gitCall(toks)
        if (git.sub === 'push' && isForcePush(words.slice(git.subAt + 1))) {
          const where = git.dir ? from(here, git.dir) : here
          risks.push({ risk: 'force-push', cwd: where?.text, ...(where ? { shellCwd: where.raw } : {}) })
        }
      }
      if (body === undefined && MIGRATION.test(part.text)) risks.push({ risk: 'migration', cwd: here?.text, ...(here ? { shellCwd: here.raw } : {}) })
      if (changesFiles(head, words, toks)) hasChanged = true
      if (part.isSideBranch) cwd = before
    }
    while (depth > 0) {
      cwd = stack.pop()
      depth--
    }
  }
  run(command)

  // A recursive rm with no target left (`rm -rf -- -dir` aside) is still held.
  if (sawRm && (isRecursive || targets.length > 0)) {
    risks.push({
      risk: 'delete',
      targets,
      patterns,
      isRecursive,
      ...(quotedTargets.length > 0 ? { quotedTargets } : {}),
      ...(shellTargets.some(t => /[$~]/.test(t)) ? { shellTargets } : {}),
      ...(isAfterChange ? { isAfterChange } : {}),
    })
  }
  // Other risks lead (their preview is the point); the delete rides along so one Proceed never hides it.
  const ordered = [...risks.filter(r => r.risk !== 'delete'), ...risks.filter(r => r.risk === 'delete')]
  const extra: Risk[] = []
  if (secrets.size > 0) extra.push({ risk: 'secret', targets: [...secrets], action: 'read/edit' })
  if (context && external.size > 0) extra.push({ risk: 'outside', targets: [...external], root: context.root, ...(dotted.size > 0 ? { dotted: [...dotted] } : {}) })
  return combineRisks([...ordered, ...extra])
}

// The outside rule is deliberately limited to rm and every mv operand (including its sources).
function writeTargets(toks: Tok[]): Tok[] {
  const name = toks[0]?.text.split('/').pop() ?? ''
  if (name !== 'rm' && name !== 'mv') return []
  const targets: Tok[] = []
  let flags = true
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i]!
    if (flags && t.text === '--') { flags = false; continue }
    if (flags && t.text.startsWith('-')) {
      if (name === 'mv') {
        if (t.text === '--target-directory') {
          if (toks[i + 1]) targets.push(toks[++i]!)
        } else if (t.text.startsWith('--target-directory=')) {
          targets.push(...split(t.raw.replace(/^(['"]?)--target-directory=/, '$1')))
        } else if (t.text === '--suffix') i++
        else if (!t.text.startsWith('--')) {
          // -ft /etc and -ft/etc: t consumes the rest of its cluster, or the next word.
          const option = /^-[^tS]*([tS])(.*)$/.exec(t.text)
          if (option?.[1] === 't') {
            if (option[2]) targets.push(...split(t.raw.replace(/^(['"]?)-[^tS]*t/, '$1')))
            else if (toks[i + 1]) targets.push(toks[++i]!)
          } else if (option?.[1] === 'S' && !option[2]) i++
        }
      }
      continue
    }
    targets.push(t)
  }
  return targets
}

function commandBody(toks: Tok[]): string | undefined {
  const head = toks[0]?.text.split('/').pop()
  if (head === 'eval') return toks.slice(1).map(t => t.text).join(' ')
  if (!['sh', 'bash', 'zsh'].includes(head ?? '')) return undefined
  for (let i = 1; i < toks.length; i++) {
    const flag = toks[i]!.text
    if (!flag.startsWith('-') || flag === '--') break
    // -n reads the body for syntax only and runs none of it.
    if (/^-[^-]*n/.test(flag)) return undefined
    if (/^-[^-]*c/.test(flag)) return toks[i + 1]?.text
    if (['-o', '-O', '--rcfile', '--init-file'].includes(flag)) i++
  }
  return undefined
}

// Commands that create, move or re-glob files, so what a later rm meets is not what exists now.
const STATE_CHANGERS = /(^|\/)(mv|cp|ln|rsync|ditto|install|tar|unzip|7z|shopt|setopt|unsetopt)$/
const GIT_STATE_CHANGERS = new Set([
  'mv', 'rm', 'checkout', 'restore', 'switch', 'stash', 'reset', 'pull', 'merge', 'rebase',
  'cherry-pick', 'revert', 'apply', 'am', 'clean', 'worktree', 'sparse-checkout',
])
// Shell options that change what a glob matches (`set -o noglob`, zsh `set -o globdots`).
const GLOB_OPTIONS = /^(noglob|globdots|nullglob|dotglob|extendedglob|globstar|nocaseglob|globsubst|rcexpandparam|glob)$/

// The text of a command (a `$( )` body) holds a command that changes files.
function textChangesFiles(text: string): boolean {
  const { parts, subs } = splitParts(text)
  const inParts = parts.some(part => {
    const all = split(part.text.trim())
    const toks = all.slice(commandAt(all).at)
    return changesFiles(toks[0]?.text ?? '', toks.map(t => t.text), toks)
  })
  return inParts || subs.some(sub => textChangesFiles(sub.text))
}

// A state changer used only to look (`shopt -q`, `tar -tf`, `unzip -l`, `git stash list`) changes nothing.
function changesFiles(head: string, words: string[], toks: Tok[]): boolean {
  const args = words.slice(1)
  const flag = (re: RegExp) => args.some(w => re.test(w))
  const name = head.slice(head.lastIndexOf('/') + 1)
  if (/(^|\/)git$/.test(head)) {
    const { sub, subAt } = gitCall(toks)
    if (!GIT_STATE_CHANGERS.has(sub ?? '')) return false
    return !(sub === 'stash' && ['list', 'show'].includes(words[subAt + 1] ?? ''))
  }
  // `xargs mv {} dir`, `find . -exec mv {} dir \;`: the command they run is the one that counts.
  if (name === 'xargs' || name === 'find' || name === 'parallel') {
    return toks.some((_, i) => {
      if (i === 0) return false
      const inner = toks.slice(i)
      const w = inner[0]!.text
      return (/(^|\/)git$/.test(w) || STATE_CHANGERS.test(w) || w === 'set') && changesFiles(w, inner.map(t => t.text), inner)
    })
  }
  // `set -f` / `set -o noglob` / `set +o globdots` re-glob; `set -e`, `set -o pipefail` do not.
  if (name === 'set') {
    return args.some((w, i) => (/^[-+][a-zA-Z]*f[a-zA-Z]*$/.test(w) && !/^[-+]o/.test(w)) || (/^[-+]o$/.test(w) && GLOB_OPTIONS.test(args[i + 1] ?? '')) || /^[-+]o(noglob|globdots|nullglob)$/.test(w))
  }
  if (!STATE_CHANGERS.test(head)) return false
  // shopt only changes anything with -s / -u; -q, -p and a bare name just report.
  if (name === 'shopt') return flag(/^-[a-zA-Z]*[su][a-zA-Z]*$/)
  // tar: -t / -d (--list, --diff) only read the archive; the old style `tar tf x` counts too.
  if (name === 'tar') {
    const clusters = args.filter((w, i) => /^-[a-zA-Z]+$/.test(w) || (i === 0 && /^[a-zA-Z]+$/.test(w)))
    const lists = flag(/^--(list|diff|compare)$/) || clusters.some(w => /[td]/.test(w))
    const writes = flag(/^--(create|extract|get|append|update)$/) || clusters.some(w => /[xcruA]/.test(w))
    return writes || !lists
  }
  // unzip: list (-l, -v), test (-t), zipinfo (-Z) and pipe to stdout (-p, -c) write no file.
  if (name === 'unzip') return !flag(/^-[a-zA-Z]*[lvtZpc][a-zA-Z]*$/)
  return true
}

type Part = { text: string; depth: number; isSideBranch: boolean }

// Splits at the shell's command separators outside quotes: ; && || | & newline, and a ( ) subshell.
// `rm a & rm -rf b` and `true | rm -rf b` run both sides, so both are looked at.
// Comments and literal heredoc text are skipped (an apostrophe there is not a quote), and the text of
// $( ), backticks and <( ) comes back in `subs` to be read as commands of their own.
function splitParts(command: string): { parts: Part[]; subs: { text: string; part: number }[]; isUnterminated: boolean } {
  const text = command
  const parts: Part[] = []
  const subs: { text: string; part: number }[] = []
  const heredocs: { delimiter: string; literal: boolean; stripTabs: boolean }[] = []
  let cur = ''
  let quote: string | null = null
  let isAnsi = false
  let depth = 0
  let before = ''
  let skipTick = -1
  // A backslash line break joins the lines, even mid-word, but not inside a comment (a comment ends at
  // its newline, so `# note \` + `rm .env` still runs the rm). The lexer skips the pair where it meets
  // one and records the newline's index in `joined`; `lastChar` looks past recorded pairs only, so
  // `a\` + `#b` stays one word while `# note\` + `(rm x)` still opens a subshell.
  const joined = new Set<number>()
  const lastChar = (k: number): string | undefined => {
    let j = k - 1
    while (j >= 1 && joined.has(j)) j -= 2
    return text[j]
  }
  const push = (after: string) => {
    parts.push({ text: cur, depth, isSideBranch: before === '|' || after === '|' || after === '&' })
    cur = ''
    before = after
  }
  // The text between `$(` / `<(` and its closing paren, or between two backticks.
  const substitution = (i: number): string | undefined => {
    const c = text[i]
    const next = text[i + 1]
    if ((c === '$' || c === '<' || c === '>') && next === '(' && text[i + 2] !== '(') {
      // Parentheses inside quotes or after a backslash do not count: `$(printf "a)b")` ends at the last one.
      let level = 1
      let q: string | null = null
      for (let j = i + 2; j < text.length; j++) {
        const ch = text[j]
        if (q) {
          if (ch === '\\' && q === '"') j++
          else if (ch === q) q = null
        } else if (ch === '\\') j++
        else if (ch === "'" || ch === '"') q = ch
        else if (ch === '(') level++
        else if (ch === ')' && --level === 0) return text.slice(i + 2, j)
      }
      return text.slice(i + 2)
    }
    if (c === '`' && i !== skipTick) {
      let j = i + 1
      while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1
      skipTick = j
      return text.slice(i + 1, j)
    }
    return undefined
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const prev = lastChar(i)
    const next = text[i + 1]
    if (quote) {
      if (quote === '"') {
        if (c === '\\' && next === '\n') {
          joined.add(++i) // inside double quotes a backslash line break is dropped
          continue
        }
        const inner = substitution(i)
        if (inner !== undefined) subs.push({ text: inner, part: parts.length })
      }
      cur += c
      if (c === '\\' && (quote === '"' || isAnsi) && i + 1 < text.length) cur += text[++i]
      else if (c === quote) {
        quote = null
        isAnsi = false
      }
      continue
    }
    if (c === '#' && (prev === undefined || /[\s;&|(]/.test(prev))) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++ // a comment runs to the end of the line
      continue
    }
    if (c === '\\' && next === '\n') {
      joined.add(++i)
      continue
    }
    if (c === '\\' && i + 1 < text.length) {
      cur += c + text[++i]
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      isAnsi = c === "'" && prev === '$'
      cur += c
      continue
    }
    const inner = substitution(i)
    if (inner !== undefined) subs.push({ text: inner, part: parts.length })
    if (c === '<' && next === '<' && text[i + 2] !== '<') {
      // The delimiter is one shell word: quotes and backslashes are removed, so `\EOF`, 'EOF' and E"O"F all mean EOF.
      const m = /^<<-?\s*((?:\\.|'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"\\<>|&;()])+)/.exec(text.slice(i))
      if (m) heredocs.push({
        delimiter: m[1]!.replace(/\\(.)|'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_, a, b, c) => a ?? b ?? c!.replace(/\\(.)/g, '$1')),
        literal: /['"\\]/.test(m[1]!), stripTabs: text[i + 2] === '-',
      })
    }
    if (c === '\n') {
      push('\n')
      // Unquoted bodies expand substitutions; quotes in the body are ordinary text.
      const owner = parts.length - 1
      let j = i + 1
      for (const doc of heredocs.splice(0)) {
        const start = j
        let bodyEnd = j
        while (j < text.length) {
          const end = text.indexOf('\n', j)
          const line = text.slice(j, end === -1 ? text.length : end)
          bodyEnd = j
          j = end === -1 ? text.length : end + 1
          if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
          bodyEnd = j
        }
        if (!doc.literal) {
          for (let k = start; k < bodyEnd; k++) {
            if (text[k] === '\\' && /[$`\\\n]/.test(text[k + 1] ?? '')) { k++; continue }
            if (text[k] !== '$' && text[k] !== '`') continue
            const inner = substitution(k)
            if (inner !== undefined) {
              subs.push({ text: inner, part: owner })
              k += inner.length + (text[k] === '`' ? 1 : 2)
            }
          }
        }
      }
      i = j - 1
      continue
    }
    // `(` after a space or operator opens a subshell; `*(.)`, `$(…)` and `<(…)` stay inside their word.
    const isOpen = c === '(' && (prev === undefined || /[\s;&|(]/.test(prev))
    const isClose = c === ')' && depth > 0
    if (isOpen || isClose) {
      push('')
      depth += isOpen ? 1 : -1
      continue
    }
    if (c === ';') push(';')
    else if (c === '&' && next === '&') {
      push('&&')
      i++
    } else if (c === '|' && next === '|') {
      push('||')
      i++
    } else if (c === '|' && prev !== '>') {
      push('|')
      if (next === '&') i++
    } else if (c === '&' && prev !== '>' && prev !== '<' && next !== '>') push('&')
    else cur += c
  }
  push('')
  return { parts, subs, isUnterminated: quote !== null }
}

// Words that sit in front of the real command: `time rm`, `sudo -u me rm`, `X=1 rm`, `then rm`, `{ rm`.
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'noglob', 'coproc', 'caffeinate'])
// Wrapper commands: the options that take a value of their own, how many plain arguments come before
// the command, and the options that name a folder to run in.
const WRAPPERS: Record<string, { args: string[]; positional?: number; dirs?: string[] }> = {
  sudo: { args: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type'], dirs: ['-D', '--chdir'] },
  doas: { args: ['-u', '-C'] },
  env: { args: ['-u', '-C', '-S', '--chdir', '--unset'], dirs: ['-C', '--chdir'] },
  nice: { args: ['-n'] },
  time: { args: [] },
  command: { args: [] },
  nohup: { args: [] },
  exec: { args: ['-a'] },
  builtin: { args: [] },
  stdbuf: { args: ['-i', '-o', '-e'] },
  timeout: { args: ['-s', '-k', '--signal', '--kill-after'], positional: 1 },
  chroot: { args: [], positional: 1 },
}
// Where the real command starts, and the folder a wrapper (`env -C dir`) moves it to.
function commandAt(tokens: Tok[]): { at: number; dir?: Tok } {
  let i = 0
  let dir: Tok | undefined
  for (;;) {
    const w = tokens[i]?.text
    if (w === undefined) return { at: i, dir }
    if (KEYWORDS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^[A-Za-z_][\w-]*\(\)$/.test(w) || (i === 0 && /^[^\s]*\)$/.test(w))) {
      i++
      continue
    }
    if (w === 'function') {
      i += 2 // `function name {`
      continue
    }
    if (w === 'case') {
      // `case x in a) rm …`: the command starts after the first pattern's `)`.
      const close = tokens.findIndex((t, k) => k > i && t.text.endsWith(')'))
      i = close === -1 ? i + 1 : close + 1
      continue
    }
    const wrapper = WRAPPERS[w]
    if (wrapper) {
      i++
      while (tokens[i]?.text.startsWith('-')) {
        const flag = tokens[i]!.text
        i++
        if (wrapper.args.includes(flag)) {
          if (wrapper.dirs?.includes(flag) && tokens[i]) dir = tokens[i]
          i++
        }
      }
      i += wrapper.positional ?? 0
      continue
    }
    return { at: i, dir }
  }
}

// The `git` subcommand and the folder of `git -C dir`, past git's own options.
function gitCall(toks: Tok[]): { sub: string | undefined; subAt: number; dir?: Tok } {
  let i = 1
  let dir: Tok | undefined
  while (toks[i]?.text.startsWith('-')) {
    const flag = toks[i]!.text
    if (flag === '-C') dir = toks[i + 1]
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(flag) ? 2 : 1
  }
  return { sub: toks[i]?.text, subAt: i, dir }
}

// Pushes that rewrite or delete what the remote has: -f (also in a cluster like -fu), --force*, --mirror,
// --prune, --delete / -d, a +refspec, and a :ref that deletes a remote branch.
function isForcePush(args: string[]): boolean {
  return args.some(
    w => /^-[a-zA-Z]*[fd][a-zA-Z]*$/.test(w) || w.startsWith('--force') || w === '--mirror' || w === '--prune' || w === '--delete' || w.startsWith('+') || (w.startsWith(':') && w.length > 1),
  )
}

// What the command would touch, from the tools' own commands.
// Paths the preview can't resolve without running the command: shell variables, command substitution, ~user.
const UNRESOLVED = /[$`]|^~[^/]/
// Syntax the preview's bash globbing does not expand the way the user's shell (zsh) would:
// command substitution, brace expansion, zsh recursive globs and qualifiers. Never guess these.
const OPAQUE = /\$\(|`|[{}()]|\*\*/
// Home written inside quotes: the shell keeps ~ literal there, so we cannot tell what is meant.

// Every risk in the command is measured, so a delete behind a force push is still shown.
async function measure($: EngineInterface, found: Risk): Promise<Measured> {
  const all = await Promise.all([found, ...(found.also ?? [])].map(one => measureOne($, one)))
  if (all.length === 1) return all[0]!
  return {
    summary: all.map(m => m.summary).join(' + '),
    details: all.flatMap(m => m.details),
    highlights: all.flatMap(m => m.highlights),
    sections: all.flatMap(m => m.sections ?? []),
  }
}

function measurement(summary: string, uiSummary: string, items: PreviewItem[], highlights: Highlight[]): Measured {
  return { summary, details: items.map(item => item.text), highlights, sections: [{ summary: uiSummary, items }] }
}

async function previewContent($: EngineInterface, path: string, init: Parameters<EngineInterface['process']['run']>[1]): Promise<string | undefined> {
  if (isSecretName(path.slice(path.lastIndexOf('/') + 1), true)) return '(비밀 파일이라 안 보여줌)'
  try {
    const r = await $.process.run([...SHELL_ARGV, CONTENT_SCRIPT, 'blast-radius', path], init)
    if (r.exitCode !== 0) return '(미리보기 불가)'
    if (r.stdout.trim() === 'SKIP') return undefined
    const words = r.stdout.trim() ? r.stdout.trim().split(/\s+/) : []
    if (words.length > 512 || words.some(word => !/^\d+$/.test(word) || Number(word) > 255)) return '(미리보기 불가)'
    const bytes = words.map(Number)
    if (bytes.includes(0)) return '(바이너리)'
    const lines = new TextDecoder().decode(new Uint8Array(bytes)).split(/\r\n|[\r\n]/)
      .map(line => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim())
    const line = lines.find(Boolean)
    return line ? Array.from(line).slice(0, 60).join('') : bytes.length === 0 ? '(비어 있음)' : '(첫 512바이트에 내용 없음)'
  } catch {
    return '(미리보기 불가)'
  }
}

async function previewPath($: EngineInterface, path: string): Promise<PreviewItem> {
  const init = { timeoutMs: 10_000 }
  try {
    const r = await $.process.run([...SHELL_ARGV, FILE_SCRIPT, 'blast-radius', path], init)
    if (r.exitCode !== 0) return { text: `확인 못 함  ${path}` }
    const metadata = r.stdout.trim()
    if (metadata === 'missing') return { text: `새로 만듦  ${path}` }
    if (metadata === 'directory') return { text: `폴더  ${path}` }
    const stat = /^file (\?|-?\d+) (\?|-?\d+) (\?|\d+)$/.exec(metadata)
    if (!stat) return { text: `확인 못 함  ${path}` }
    const time = (word: string) => word === '?' ? undefined : Number(word)
    const bytes = time(stat[3]!)
    const content = await previewContent($, path, init)
    return {
      text: `덮어씀  ${formatDeleteDetail(path, time(stat[1]!), time(stat[2]!))} · ${bytes !== undefined ? size(bytes / 1024) : '크기 ?'}`,
      ...(content !== undefined ? { content } : {}),
    }
  } catch {
    return { text: `확인 못 함  ${path}` }
  }
}

async function measureOne($: EngineInterface, found: Risk): Promise<Measured> {
  if (found.risk === 'secret' || found.risk === 'outside') {
    const paths = found.targets ?? []
    const names = [...new Set(paths.map(p => p.slice(p.lastIndexOf('/') + 1)))]
    return measurement(
      found.risk === 'secret' ? `${found.action ?? 'read/edit'} secret file: ${paths.join(', ')}` : `write outside the project (${found.root}): ${paths.join(', ')}`,
      found.unresolved ? '대상을 확인할 수 없어 보류함' : found.risk === 'secret' ? `비밀 파일 ${paths.length}개 접근` : `프로젝트 밖에 쓰기 ${paths.length}곳`,
      found.unresolved ? paths.map(path => ({ text: `확인 못 함  ${path}` })) : await Promise.all(paths.map(path => previewPath($, path))),
      [{ level: found.risk === 'secret' ? 'high' : 'mid', text: found.unresolved ? `대상을 확인할 수 없음: ${paths.join(', ')}` : found.risk === 'secret' ? `비밀키·환경변수 파일 접근: ${names.join(', ')}` : `프로젝트 밖: ${paths.join(', ')}`,
        ...(paths.length > 1 ? { uiText: found.risk === 'secret' ? '비밀키·환경변수 파일 접근' : '프로젝트 밖 쓰기' } : {}) }],
    )
  }
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const quoted = new Set(found.quotedTargets ?? [])
  // Older risks have only paths; parsed risks retain their original quote/escape spelling.
  const expand = (p: string) => (home && !quoted.has(p) ? p.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home) : p)
  const cwdWord = found.shellCwd ? split(found.shellCwd, [], home)[0] : undefined
  const cwd = cwdWord?.text ?? (found.cwd ? expand(found.cwd) : undefined)
  const init = cwd && !UNRESOLVED.test(cwd) ? { cwd, timeoutMs: 10_000 } : { timeoutMs: 10_000 }
  try {
    if (found.risk === 'delete') {
      const raw = found.targets ?? []
      const shellWords = found.shellTargets?.map(t => split(t, [], home)[0])
      const opaque = raw.filter((t, i) => shellWords?.[i] ? shellWords[i]!.opaque : OPAQUE.test(t))
      const targets = raw.map((t, i) => shellWords?.[i]?.text ?? expand(t))
      // The shell sees the pattern form: quoted [ * ? are escaped, so "Thesis [v2].pdf" is one literal name.
      const patterns = (found.patterns ?? raw).map((pat, i) => shellWords?.[i]?.glob ?? (quoted.has(raw[i]!) ? pat : expand(pat)))
      const unknown = targets.filter((t, i) => shellWords?.[i] ? shellWords[i]!.unresolved : UNRESOLVED.test(t))
      // A plain `rm "$tmp"` is everyday cleanup; command substitution and braces are not.
      // A secret by name (`$REPO/.env`) is held even though its folder is unknown.
      const isBlind = Boolean(found.isRecursive) || opaque.length > 0 || unknown.some(t => isSecretName(t.slice(t.lastIndexOf('/') + 1)))
      const isCwdUnknown = cwd !== undefined && UNRESOLVED.test(cwd)
      const blind: Measured | undefined =
        opaque.length > 0 || unknown.length > 0 || isCwdUnknown
          ? (() => {
              const list = opaque.length > 0 ? opaque : unknown.length > 0 ? unknown : [`cd ${found.cwd}`]
              return measurement(
                `can't preview: ${list.length === 1 ? 'a path uses' : `${list.length} paths use`} shell syntax, check by hand`,
                `미리보기 불가: 경로 ${list.length}개가 셸 문법을 써요. 직접 확인해 주세요`,
                list.slice(0, MAX_LISTED).map(text => ({ text })),
                [{ level: isBlind ? 'high' : 'low', text: '미리보기 불가: 경로를 셸이 어떻게 풀지 알 수 없음' }],
              )
            })()
          : undefined
      // Held anyway, or the folder itself is unknown: nothing more to look at.
      if (blind && (isBlind || isCwdUnknown)) return blind
      // An unknown path must not hide the known ones next to it (`rm .env "$tmp"`): preview those.
      const known = patterns.filter((_, i) => !(shellWords?.[i]?.unresolved ?? UNRESOLVED.test(targets[i]!)) && !opaque.includes(raw[i]!))
      const afterChange: Measured['highlights'] = found.isAfterChange
        ? [{ level: 'mid', text: '앞 명령(mv·cp·shopt 등)이 파일을 바꿔 미리보기를 믿을 수 없음' }]
        : []
      if (known.length === 0) {
        return blind ? { ...blind, highlights: [...blind.highlights, ...afterChange] }
          : measurement(NOTHING, '삭제할 파일 없음: 경로가 아직 없어요', targets.map(path => ({ text: `없음  ${path}` })), afterChange)
      }
      const r = await $.process.run([...SHELL_ARGV, DELETE_SCRIPT, 'blast-radius', found.isRecursive ? '1' : '0', ...known], init)
      const scan = parseScan(r.stdout, FILE_CAP)
      const files = scan.files.map(path => short(path, targets))
      const dates = new Map(scan.dates.map(d => [d.path, d]))
      const items = await Promise.all(scan.files.slice(0, MAX_LISTED).map(async (path, i): Promise<PreviewItem> => {
        const content = i < 5 ? await previewContent($, path, init) : undefined
        return { text: formatDeleteDetail(short(path, targets), dates.get(path)?.birth, dates.get(path)?.modified), ...(content !== undefined ? { content } : {}) }
      }))
      const found2 = [...(blind?.highlights ?? []), ...afterChange, ...highlights(scan, await $.clock.now())]
      if (files.length === 0 && scan.kb === 0) {
        return blind ? { ...blind, highlights: found2 }
          : measurement(NOTHING, '삭제할 파일 없음: 경로가 아직 없어요', targets.map(path => ({ text: `없음  ${path}` })), found2)
      }
      return measurement(
        `delete ${scan.isCapped ? `${FILE_CAP}+` : files.length} file${files.length === 1 ? '' : 's'} (${size(scan.kb)})${blind ? ' + paths it cannot preview' : ''}`,
        `파일 ${scan.isCapped ? `${FILE_CAP}+` : files.length}개 삭제 (${size(scan.kb)})${blind ? ' · 미리보기 불가 경로 있음' : ''}`,
        [...(blind?.details.map(text => ({ text })) ?? []), ...items].slice(0, MAX_LISTED), found2,
      )
    }
    if (found.risk === 'force-push') {
      // --no-show-signature: a repo can name a gpg program that `log` would otherwise run to verify commits.
      const log = `${SAFE_ENV}git -c log.showSignature=false log --no-show-signature --oneline "$1"`
      const lost = await $.process.run([...SHELL_ARGV, log, 'blast-radius', 'HEAD..@{u}'], init)
      const ahead = await $.process.run([...SHELL_ARGV, log, 'blast-radius', '@{u}..HEAD'], init)
      // No upstream, not a repo, a bad ref: an empty list here would read as "0 lost", which is a guess.
      if (lost.exitCode !== 0 || ahead.exitCode !== 0) {
        return measurement('overwrite the remote branch (could not compare with it)', '원격 브랜치 덮어쓰기 (원격과 비교하지 못했어요)', [],
          [{ level: 'high', text: '원격 브랜치와 비교 못 함: 사라질 커밋을 직접 확인' }])
      }
      const gone = lost.stdout.split('\n').filter(Boolean)
      const added = ahead.stdout.split('\n').filter(Boolean)
      return measurement(
        `overwrite the remote branch: ${gone.length} remote commit${gone.length === 1 ? '' : 's'} lost, ${added.length} pushed (as of the last fetch)`,
        `원격 브랜치 덮어쓰기: 커밋 ${gone.length}개 사라짐 · ${added.length}개 푸시 (마지막 fetch 기준)`,
        [...gone.map(c => ({ text: `사라짐  ${c}` })), ...added.map(c => ({ text: `푸시  ${c}` }))].slice(0, MAX_LISTED),
        gone.length > 0 ? [{ level: 'high', text: `원격 커밋 ${gone.length}개가 사라짐` }] : [],
      )
    }
    const status = await $.process.run([...SHELL_ARGV, MIGRATION_SCRIPT], init)
    const isUnchecked = status.stdout.trim() === 'X'
    const touched = isUnchecked || status.stdout.trim() === 'O' ? [] : status.stdout.split('\n').filter(l => /migrat|schema|prisma|supabase|drizzle/i.test(l))
    return measurement(
      'change the database schema (not previewable here)', 'DB 스키마 변경 (여기서는 미리 볼 수 없어요)',
      touched.map(l => ({ text: `커밋 안 됨  ${l.trim()}` })).slice(0, MAX_LISTED),
      [
        { level: 'high', text: 'DB 스키마 변경: 데이터가 바뀌거나 지워질 수 있음' },
        ...(isUnchecked ? [{ level: 'high' as const, text: '변경 사항 확인 안 함(저장소가 자체 실행 설정을 가짐)' }] : []),
      ],
    )
  } catch {
    return measurement(`run a risky ${found.risk} command (could not measure it)`, '미리보기 불가: 명령의 영향 범위를 확인하지 못했어요', [],
      [{ level: 'high', text: '영향 범위를 확인하지 못함: 직접 확인 필요' }])
  }
}

// Shell-like words: quotes and backslash escapes joined into one word, the quoting dropped.
// `Important\ Report.pdf` is one word, as the shell reads it.
// `glob` is the same word as a pattern: a quoted or escaped [ * ? becomes [[] [*] [?], so it stays literal.
// (A backslash would not work: with IFS empty bash then skips globbing.)
// Redirects stay out of the argument list, with targets optionally collected separately.
type Redirect = { target: Tok; writes: boolean; isFile: boolean }
export function split(text: string, redirects: Redirect[] = [], home?: string): Tok[] {
  const words: Tok[] = []
  let word = ''
  let glob = ''
  let raw = ''
  let isQuoted = false
  let isOpen = false
  let unresolved = false
  let opaque = false
  let quote: '"' | "'" | null = null
  let isAnsi = false
  const literal = (c: string) => {
    word += c
    glob += c === '[' || c === '*' || c === '?' ? `[${c}]` : c
  }
  const flush = () => {
    if (isOpen) {
      if (/^~(?=\/|$)/.test(raw)) {
        if (home) { word = word.replace(/^~/, home); glob = glob.replace(/^~/, home) }
        else unresolved = true
      } else if (raw.startsWith('~')) unresolved = true
      words.push({ text: word, glob, raw, isQuoted, unresolved, opaque })
    }
    word = ''; glob = ''; raw = ''
    isQuoted = false; isOpen = false; unresolved = false; opaque = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote && c === quote) {
      raw += c
      quote = null
      isAnsi = false
      continue
    }
    if (quote && c === '\\' && (isAnsi || (quote === '"' && /[$`"\\]/.test(text[i + 1] ?? ''))) && i + 1 < text.length) {
      raw += c + text[i + 1]
      literal(text[++i]!)
      continue
    }
    // HOME expands unquoted and in double quotes. Single quotes and escaped dollars stay literal.
    if (c === '$' && quote !== "'") {
      const ref = /^(?:\$\{HOME\}|\$HOME(?![\w]))/.exec(text.slice(i))
      if (ref && home) {
        raw += ref[0]
        for (const h of home) literal(h)
        i += ref[0].length - 1
        isOpen = true
        continue
      }
      // ANSI-C quotes are literal, not a variable reference.
      if (!(text[i + 1] === "'" && !quote)) unresolved = true
    }
    if (quote) {
      raw += c
      if (quote === '"' && c === '`') unresolved = true
      literal(c)
      continue
    }
    if (c === "'" || c === '"') {
      isAnsi = c === "'" && text[i - 1] === '$' && word.endsWith('$')
      if (isAnsi) {
        word = word.slice(0, -1)
        glob = glob.slice(0, -1)
      }
      raw += c
      quote = c
      isQuoted = true
      isOpen = true
    } else if (c === '\\' && i + 1 < text.length) {
      raw += c + text[i + 1]
      literal(text[++i]!)
      isQuoted = true
      isOpen = true
    } else if (c === '>' || c === '<' || (c === '&' && text[i + 1] === '>')) {
      if (isOpen && !isQuoted && /^\d+$/.test(word)) {
        word = ''; glob = ''; raw = ''; isOpen = false
      } else flush()
      const operator = /^(?:&>>?|<<<|<<-?|>>|>\||[<>]&|<>|[<>])/.exec(text.slice(i))![0]
      i += operator.length - 1
      while (i + 1 < text.length && /\s/.test(text[i + 1]!)) i++
      let q: string | null = null
      const start = i + 1
      while (i + 1 < text.length) {
        const d = text[i + 1]!
        if (d === '\\' && q !== "'" && (!q || /[$`"\\]/.test(text[i + 2] ?? ''))) { i += 2; continue }
        if (q) {
          if (d === q) q = null
        } else if (d === "'" || d === '"') q = d
        else if (/[\s<>&|;]/.test(d)) break
        i++
      }
      const target = split(text.slice(start, i + 1), [], home)[0]
      if (target) redirects.push({ target, writes: operator.includes('>'), isFile: !operator.includes('<<') && !(/[<>]&/.test(operator) && /^(\d+|-)$/.test(target.text)) })
    } else if (/\s/.test(c)) flush()
    else {
      raw += c
      word += c
      glob += c
      if (c === '`') unresolved = true
      if (/[{}()]/.test(c)) opaque = true
      isOpen = true
    }
  }
  flush()
  return words
}

// A path from the folder being deleted (build/chunk-1.js), not the whole path.
function short(file: string, targets: string[]) {
  for (const t of targets) {
    const base = t.replace(/\/+$/, '')
    const parent = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : ''
    if (parent && file.startsWith(parent)) return file.slice(parent.length)
  }
  return file
}

function size(kb: number) {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${kb} KB`
}
