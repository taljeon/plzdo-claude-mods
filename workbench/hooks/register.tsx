// Workbench: a side pane with the changed files (diff, stage, open in VS Code, a note to Claude),
// tool calls still running, pinned open decisions, and the status of agents and recent Codex runs.
// Rule asks are answered in the pane first (30 s, then the chat dialog).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Activity, AgentRow, Approval, ChangedFile, CodexRun, PermissionAsk, Pin } from '../types'
import type { HeldCommand, WaitingCall } from '../../blast-radius/types'
import type {} from '../../duo-quiz/types'
import { callSummary, callText, clipDiff, codexState, elapsed, fileLabel, lastMarker, lastResult, metaLabel, parseNumstat, parseStatus } from './parse'
import type { Marker } from './parse'
import { DIFF_SCRIPT, NUMSTAT_SCRIPT, SHELL_ARGV, STAGE_SCRIPT, STATUS_SCRIPT, TOP_SCRIPT, UNCHECKED, UNCHECKED_TEXT, UNSTAGE_SCRIPT, UNTRACKED_SCRIPT } from './git'

const PANE = 'workbench'
const POLL_MS = 4000
const CODEX_WINDOW_MIN = 180
const CODEX_MAX_RUNS = 5
const MAX_FILES = 12
// Shorter calls come and go between polls; listing them would only flicker.
const ACTIVITY_MIN_MS = 3000
// A call this old is likely a background process or stuck; let the person drop its row.
const HIDE_AFTER_MS = 120_000
// Rows kept free under the diff for what a plugin beneath draws (duo-quiz).
const BELOW_ROWS = 16
const RULE_WAIT_MS = 30_000

const files = atom({ plugin: 'workbench', key: 'files' } as const, [] as ChangedFile[])
const selected = atom({ plugin: 'workbench', key: 'selected' } as const, null as string | null)
const diff = atom({ plugin: 'workbench', key: 'diff' } as const, '')
const unchecked = atom({ plugin: 'workbench', key: 'unchecked' } as const, false)
const repo = atom({ plugin: 'workbench', key: 'repo' } as const, null as string | null)
const agents = atom({ plugin: 'workbench', key: 'agents' } as const, [] as AgentRow[])
const codex = atom({ plugin: 'workbench', key: 'codex' } as const, [] as CodexRun[])
const activity = atom({ plugin: 'workbench', key: 'activity' } as const, [] as Activity[])
const pins = atom({ plugin: 'workbench', key: 'pins' } as const, [] as Pin[])
const approvals = atom({ plugin: 'workbench', key: 'approvals' } as const, [] as Approval[])
const permissions = atom({ plugin: 'workbench', key: 'permissions' } as const, [] as PermissionAsk[])
const radiusHeld = { plugin: 'blast-radius', key: 'held' } as const
const radiusWaiting = { plugin: 'blast-radius', key: 'waiting' } as const
const duoQuiz = { plugin: 'duo-quiz', key: 'quiz' } as const

const singleLine = (text: string) => text.replace(/\r\n|[\r\n]/g, ' ⏎ ')
const approvalCommand = (text: string) => {
  const line = singleLine(text)
  return line.length <= 100 ? line : `${line.slice(0, 99)}…`
}

type Engine = EngineInterface

let timer: { cancel: () => void } | undefined
let isBusy = false
let pinnedGit: string | undefined
let mainTurnId: string | undefined
let mainMode: string | undefined
// Per rollout file: re-read only when its mtime moved; the state is recomputed from the clock each poll.
const seen = new Map<string, { mtimeMs: number; marker: Marker; result: string; label: string }>()
// Pane presses by ask id. Module memory, not $.state: the holding tool.check hook kept reading the state it
// started with and never saw a press (seen live), while the button and the hook share this module.
const pressed = new Map<string, 'allow' | 'deny'>()

const runGit = (e: Engine, cwd: string, script: string, ...args: string[]) =>
  e.process.run([...SHELL_ARGV, script, 'workbench-git', ...args], { cwd })

async function refreshFiles($: Engine) {
  pinnedGit = undefined
  const top = await runGit($, await $.session.cwd(), TOP_SCRIPT)
  if (top.exitCode !== 0) {
    await update($, unchecked, () => top.exitCode === UNCHECKED)
    await update($, repo, () => null)
    await update($, files, () => [])
    await update($, selected, () => null)
    await update($, diff, () => '')
    await loadPins($, await $.session.cwd())
    return
  }
  const [root, binary, ...extra] = top.stdout.trimEnd().split('\n')
  if (extra.length > 0 || !root?.startsWith('/') || !binary?.startsWith('/')) {
    await update($, unchecked, () => true)
    await update($, repo, () => null)
    await update($, files, () => [])
    await update($, selected, () => null)
    await update($, diff, () => '')
    return
  }
  pinnedGit = binary
  const [status, numstat] = await Promise.all([
    runGit($, root, STATUS_SCRIPT, binary),
    runGit($, root, NUMSTAT_SCRIPT, binary),
  ])
  const unsafe = status.exitCode !== 0 || numstat.exitCode !== 0
  await update($, unchecked, () => unsafe)
  const counts = parseNumstat(unsafe ? '' : numstat.stdout)
  const list = parseStatus(unsafe ? '' : status.stdout).map(f => ({ ...f, ...(counts.get(f.path) ?? {}) }))
  await update($, repo, () => root)
  await update($, files, () => list)
  await loadPins($, root)
  const current = await read($, selected)
  if (current && !list.some(f => f.path === current)) {
    await update($, selected, () => null)
    await update($, diff, () => '')
  } else if (current) {
    await loadDiff($, current, root, list)
  }
}

async function loadDiff($: Engine, path: string, root: string, list: ChangedFile[]) {
  if (!pinnedGit) {
    await update($, unchecked, () => true)
    await update($, diff, () => '')
    return
  }
  const file = list.find(f => f.path === path)
  const out = await runGit($, root, file?.index === '?' ? UNTRACKED_SCRIPT : DIFF_SCRIPT, pinnedGit, path)
  const unsafe = out.exitCode === UNCHECKED || (out.exitCode !== 0 && !(file?.index === '?' && out.exitCode === 1))
  await update($, unchecked, () => unsafe)
  await update($, diff, () => unsafe ? '' : out.stdout)
}

// Pins live in the store per repo, so they outlast the session; outside a repo, per working folder.
// One key per pin: adding or clearing never rewrites a shared list, so two sessions cannot drop each
// other's pins.
const pinPrefix = (root: string) => `pin:${root}\u0000`
const legacyKey = (root: string) => `pins:${root}`

async function loadPins($: Engine, root: string) {
  // 0.2.0 kept one array per repo: move it to per-pin keys once.
  const legacy = await $.store.get(legacyKey(root))
  if (Array.isArray(legacy)) {
    for (const p of legacy as Pin[]) await $.store.set(`${pinPrefix(root)}${p.id}`, { text: p.text, at: p.at })
    await $.store.delete(legacyKey(root))
  }
  const prefix = pinPrefix(root)
  const list: Pin[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(prefix)) continue
    const value = (await $.store.get(key)) as { text?: unknown; at?: unknown } | undefined
    if (typeof value?.text === 'string') list.push({ id: key.slice(prefix.length), text: value.text, at: Number(value.at) || 0 })
  }
  list.sort((x, y) => x.at - y.at)
  await update($, pins, () => list)
}

async function pinRoot($: Engine) {
  return (await read($, repo)) ?? (await $.session.cwd())
}

async function addPin($: Engine, text: string) {
  if (!text.trim()) return
  const root = await pinRoot($)
  const at = await $.clock.now()
  await $.store.set(`${pinPrefix(root)}${at}-${await $.session.id()}`, { text: text.trim(), at })
  await loadPins($, root)
}

async function removePin($: Engine, id: string) {
  const root = await pinRoot($)
  await $.store.delete(`${pinPrefix(root)}${id}`)
  await loadPins($, root)
}

async function refreshAgents($: Engine) {
  const list = await $.agent.list()
  const rows = list.map(a => ({
    id: a.id,
    label: a.name ?? a.type,
    status: a.status,
    description: a.description,
  }))
  await update($, agents, () => rows)
}

async function refreshCodex($: Engine) {
  const home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
  if (!home) return
  const found = await $.process.run([
    'find', `${home}/.codex/sessions`, '-name', 'rollout-*.jsonl', '-mmin', `-${CODEX_WINDOW_MIN}`,
  ])
  const paths = found.stdout.split('\n').filter(Boolean).sort().reverse().slice(0, CODEX_MAX_RUNS)
  const now = await $.clock.now()
  const runs: CodexRun[] = []
  for (const path of paths) {
    const { mtimeMs } = await $.fs.stat(path)
    let entry = seen.get(path)
    if (!entry || entry.mtimeMs !== mtimeMs) {
      const tail = await $.process.run(['tail', '-n', '200', path])
      // The whole file, not the tail: a long follow-up turn pushes the last answer out of it.
      const completions = await $.process.run(['grep', '"task_complete"', path])
      const head = entry?.label ? undefined : await $.process.run(['head', '-n', '1', path])
      entry = {
        mtimeMs,
        marker: lastMarker(tail.stdout),
        result: lastResult(completions.stdout),
        label: entry?.label ?? metaLabel(head?.stdout ?? ''),
      }
      seen.set(path, entry)
    }
    runs.push({
      id: path,
      label: entry.label,
      state: codexState(entry.marker, entry.mtimeMs, now),
      updatedAt: entry.mtimeMs,
      result: entry.result,
    })
  }
  await update($, codex, () => runs)
}

async function refresh($: Engine) {
  if (isBusy) return
  isBusy = true
  try {
    await Promise.all([
      refreshFiles($).catch(async () => {
        await update($, unchecked, () => true)
        await update($, files, () => [])
        await update($, diff, () => '')
      }),
      refreshAgents($).catch(() => {}),
      refreshCodex($).catch(() => {}),
      // Elapsed times are drawn from the clock: a fresh array redraws them each poll.
      update($, activity, list => (list.length ? [...list] : list)).catch(() => {}),
    ])
  } catch {
    // a poll that fails is skipped; the next one tries again
  } finally {
    isBusy = false
  }
}

async function openInEditor($: Engine, root: string, path: string) {
  const abs = `${root}/${path}`
  const viaCode = await $.process.run(['code', '-g', abs]).catch(() => null)
  if (viaCode && viaCode.exitCode === 0) return
  const viaOpen = await $.process.run(['open', '-a', 'Visual Studio Code', abs]).catch(() => null)
  if (!viaOpen || viaOpen.exitCode !== 0) await $.ui.toast('VS Code를 열지 못했습니다')
}

async function callerName($: Engine, agentId: string): Promise<string> {
  const agent = (await $.agent.list().catch(() => [])).find(agent => agent.id === agentId)
  const name = agent?.type || agent?.name
  return name ? `에이전트: ${singleLine(name)}` : '에이전트'
}

async function canAnswerPermission($: Engine): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
    && (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    mainTurnId = undefined
    mainMode = undefined
    await update($, permissions, () => [])
    pressed.clear()
    await $.command.register({ name: 'workbench', description: 'Show changed files and agent status in a pane' }).catch(() => {})
    await $.command.register({ name: 'pin', description: 'Pin an open decision to the workbench pane' }).catch(() => {})
    void $.ui.open({ id: PANE, title: 'Workbench' })
    timer?.cancel()
    timer = $.clock.every(POLL_MS, () => void refresh($))
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'workbench' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Workbench', focus: true })
    void refresh($)
    return { text: 'Workbench pane opened.' }
  })

  on('command.run', { command: 'pin' }, async ($, e) => {
    if (!e.args?.trim()) return { text: 'Usage: /pin <decision to keep in view>' }
    await addPin($, e.args)
    return { text: 'Pinned to the workbench pane.' }
  })

  // Lists the call while it runs; a tool call may have changed files, so look again as soon as it ends.
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id ?? `${e.tool}:${await $.clock.now()}`
    const entry = { id, summary: callSummary(e.tool, e), startedAt: await $.clock.now(), asked: false, hidden: false }
    await update($, activity, list => [...list.filter(a => a.id !== id), entry]).catch(() => {})
    try {
      return await next(e)
    } finally {
      await update($, activity, list => list.filter(a => a.id !== id)).catch(() => {})
      void refresh($)
    }
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) mainTurnId = e.turnId
    return next(e)
  })

  // tool.check carries no permission mode, so keep the one each prompt was sent under.
  // ponytail: a mode switched mid-turn is seen at the next prompt.
  on('classic.UserPromptSubmit', ($, e, next) => {
    mainMode = e.permission_mode
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    // Only a settings ask rule, on a real call, with nobody else deciding: auto mode settles rule-less asks unseen,
    // and a host decider, another hook's ask or a setting's warning (either would be hidden), a policy ceiling
    // or dontAsk (which refuses what nobody approved) keep the engine's own handling.
    if (verdict.decision !== 'ask' || !verdict.rule?.trim() || e.tool_use_id === undefined
      || verdict.decider !== undefined || verdict.hook !== undefined || verdict.setting !== undefined
      || e.ceiling !== undefined || mainMode === 'dontAsk') return verdict
    if (next.signal.aborted || !(await canAnswerPermission($).catch(() => false))) return verdict
    const id = crypto.randomUUID()
    const turnId = mainTurnId
    try {
      const at = await $.clock.now()
      const text = callText(e.tool, e.input, e.agentId === undefined ? undefined : await callerName($, e.agentId))
      await update($, permissions, list => [...list, {
        id, tool: e.tool, rule: verdict.rule!, at, text, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
      }])
      let shownLeft = -1
      for (;;) {
        const now = await $.clock.now()
        const isOver = now >= at + RULE_WAIT_MS || !(await canAnswerPermission($))
        // Read after the deadline check: a press recorded before the deadline still counts.
        const decision = pressed.get(id)
        if (next.signal.aborted) return verdict
        if (decision === 'allow') return { decision: 'allow', reason: 'Allowed from the workbench pane.' }
        if (decision === 'deny') {
          if (e.agentId === undefined && turnId !== undefined) await $.turn.abort({ turnId }).catch(() => {})
          return { decision: 'deny', reason: 'The user pressed 거절 in the workbench pane.' }
        }
        if (isOver) return verdict
        // Redraw once per second so the countdown ticks without waiting for the 4 s poll.
        const left = Math.ceil((at + RULE_WAIT_MS - now) / 1000)
        if (left !== shownLeft) {
          shownLeft = left
          $.ui.invalidate('ui.render')
        }
        // Process time is outside the hook's own budget; clock sleeps are not.
        await $.process.run(['sleep', '0.25'])
      }
    } catch { return verdict }
    finally {
      await update($, permissions, list => list.filter(p => p.id !== id)).catch(() => {})
      pressed.delete(id)
    }
  })

  // Marks a call only once a dialog is really put to the person. tool.check's `ask` also covers calls the
  // auto-mode classifier approves unseen. This event carries no tool_use_id, so match the newest unmarked
  // call with the same summary. It only observes: the request passes through as is.
  on('classic.PermissionRequest', async ($, e, next) => {
    const summary = callSummary(e.tool_name, e.tool_input)
    await update($, activity, list => {
      const hit = list.filter(a => !a.asked && a.summary === summary).at(-1)
      return hit ? list.map(a => (a === hit ? { ...a, asked: true } : a)) : list
    }).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const ui = $.ui.resolve(e)
    // While duo-quiz has a quiz, keep rows free for it and draw what it adds beneath this hook last.
    // Whichever of the two runs first, the quiz ends up below and the diff leaves it room.
    // A read of a plugin that is not loaded can throw before it returns a promise.
    const hasQuiz = await (async () => {
      try {
        return ((await read($, duoQuiz))?.status ?? 'idle') !== 'idle'
      } catch {
        return false
      }
    })()
    let below: RenderElement | null = null
    if (hasQuiz) {
      try {
        const drawn: unknown = await next(e)
        below = drawn !== null && typeof drawn === 'object' ? drawn as RenderElement : null
      } catch {
        below = null
      }
    }
    const { Box, Text, Button } = ui
    const [list, current, patch, root, agentRows, codexRows, calls, pinned, now, heldCall, waitingCalls, permissionEntries, isUnchecked] = await Promise.all([
      read($, files),
      read($, selected),
      read($, diff),
      read($, repo),
      read($, agents),
      read($, codex),
      read($, activity),
      read($, pins),
      $.clock.now(),
      read($, radiusHeld).catch(() => null),
      read($, radiusWaiting).then(value => value ?? []).catch(() => []),
      read($, permissions),
      read($, unchecked),
    ])
    // ponytail: time expiry also hides leftovers from a reloaded module.
    const permissionCalls = permissionEntries.filter(call => !pressed.has(call.id) && now < call.at + RULE_WAIT_MS)
    const running = calls.filter(a => !a.hidden && (a.asked || now - a.startedAt >= ACTIVITY_MIN_MS))
    const rows = e.viewport?.rows ?? 30
    const chosen = list.find(f => f.path === current)
    const shown = list.slice(0, MAX_FILES)
    const isFocused = e.props?.isFocused ?? false
    // While a quiz is below, the diff may shrink to 3 lines so the quiz keeps its rows.
    const diffRoom = Math.max(hasQuiz ? 3 : 8, rows - shown.length - agentRows.length - codexRows.length - codexRows.filter(c => c.result).length * 2 - running.length * 2 - pinned.length * 2 - 19 - (hasQuiz ? BELOW_ROWS : 0)) // wrapped rows take up to 2 lines
    const clipped = clipDiff(patch, diffRoom)

    const pick = async (path: string) => {
      await update($, selected, () => path)
      if (root) await loadDiff($, path, root, list)
    }
    const toggleStage = async () => {
      if (!chosen || !root) return
      if (!pinnedGit) {
        await update($, unchecked, () => true)
        return
      }
      const isStaged = chosen.index !== ' ' && chosen.index !== '?'
      await runGit($, root, isStaged ? UNSTAGE_SCRIPT : STAGE_SCRIPT, pinnedGit, chosen.path)
      await refresh($)
    }
    const send = async (text: string) => {
      if (!chosen || !text.trim()) return
      await $.prompt.submit({ text: `${chosen.path}: ${text.trim()}`, asUser: true })
    }
    const callRow = (a: Activity) => `${elapsed(now - a.startedAt).padStart(6)} ${a.asked ? '승인 요청 ' : ''}${a.summary}`
    const pending: (HeldCommand | WaitingCall)[] = [
      ...(heldCall ? [heldCall] : []),
      ...waitingCalls.filter(call => call.id !== heldCall?.id),
    ]
    const allPending = [...pending, ...permissionCalls]
    const missingAgents = allPending.filter((call, index) => call.agentId !== undefined
      && !agentRows.some(agent => agent.id === call.agentId)
      && allPending.findIndex(other => other.agentId === call.agentId) === index)
    const approve = async (call: HeldCommand | WaitingCall, decision: Approval['decision']) => {
      const id = call.id
      const [currentHeld, currentWaiting, at] = await Promise.all([
        read($, radiusHeld).catch(() => null),
        read($, radiusWaiting).then(value => value ?? []).catch(() => []),
        $.clock.now(),
      ])
      const activeIds = new Set(currentWaiting.map(call => call.id))
      if (currentHeld) activeIds.add(currentHeld.id)
      // Bind the press to the preview that rendered this button, not a newer hold with the same id.
      const binding = decision === 'proceed' && 'holdId' in call && call.holdId
        && currentHeld?.id === id && currentHeld.holdId === call.holdId && currentHeld.command === call.command
        ? { holdId: call.holdId, command: call.command } : undefined
      if (decision === 'proceed' && !binding) return
      await update($, approvals, entries => [
        // Waiting stays listed until held is published; finished decisions need no grace period.
        ...entries.filter(entry => entry.id !== id && activeIds.has(entry.id)
          && (entry.decision === 'cancel' || (entry.holdId === currentHeld?.holdId && entry.command === currentHeld?.command))),
        ...(activeIds.has(id) ? [{ id, decision, at, ...binding }] : []),
      ].slice(-20))
    }
    const approvalRows = (agentId: string | undefined, readOnly: boolean) => pending
      .filter(call => call.agentId === agentId)
      .map(call => (
        <Box key={`approval-${call.id}`} flexDirection="column" paddingLeft={1}>
          <Box flexDirection="row">
            <Box flexShrink={1}>
              <Text color="warning" wrap="wrap">{`승인 대기: ${heldCall?.id === call.id ? singleLine(call.command) : approvalCommand(call.command)}`}</Text>
            </Box>
          </Box>
          {heldCall?.id === call.id && (
            <Box flexDirection="column">
              {(heldCall.highlights ?? []).map((highlight, index) => (
                <Text key={`highlight-${index}`} color="warning" wrap="wrap">{singleLine(highlight.uiText ?? highlight.text)}</Text>
              ))}
              {heldCall.secondsLeft !== null && <Text color="warning" wrap="wrap">{`${heldCall.secondsLeft}초 후 자동 취소`}</Text>}
              <Box flexDirection="row">
                <Box flexShrink={1}>
                  <Text wrap="wrap">{singleLine(heldCall.summary)}</Text>
                </Box>
              </Box>
            </Box>
          )}
          {!readOnly && (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {heldCall?.id === call.id && heldCall.holdId && <Button key={`approval-proceed-${call.id}`} label="진행" onPress={() => approve(call, 'proceed')} />}
              <Button key={`approval-cancel-${call.id}`} label="취소" onPress={() => approve(call, 'cancel')} />
            </Box>
          )}
        </Box>
      ))
    const answerPermission = async (id: string, decision: 'allow' | 'deny') => {
      const now = await $.clock.now()
      const ask = (await read($, permissions)).find(p => p.id === id)
      if (!ask || now >= ask.at + RULE_WAIT_MS || pressed.has(id)) return
      pressed.set(id, decision)
      await $.ui.invalidate('ui.render') // drop the row now, not at the next poll
    }
    const permissionRows = (agentId: string | undefined, readOnly: boolean) => permissionCalls
      .filter(call => call.agentId === agentId)
      .map(call => (
        <Box key={`permission-${call.id}`} flexDirection="column" paddingLeft={1}>
          <Text color="warning" wrap="wrap">{`승인 요청: ${call.text}`}</Text>
          <Text dimColor wrap="wrap">{`규칙 ${call.rule} · ${Math.ceil((call.at + RULE_WAIT_MS - now) / 1000)}초 후 채팅 창으로`}</Text>
          {!readOnly && (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Button key={`permission-allow-${call.id}`} label="승인" plain onPress={() => answerPermission(call.id, 'allow')} />
              <Button key={`permission-deny-${call.id}`} label="거절" variant="primary" autoFocus onPress={() => answerPermission(call.id, 'deny')} />
            </Box>
          )}
        </Box>
      ))
    const agentSection = (readOnly: boolean) => (
      <Box flexDirection="column">
        <Text bold>에이전트</Text>
        {agentRows.length + codexRows.length + allPending.length === 0 && !readOnly && <Text dimColor>실행 중인 에이전트 없음</Text>}
        {allPending.some(call => call.agentId === undefined) && (
          <Box key="approval-main" flexDirection="column">
            <Text bold>메인</Text>
            {approvalRows(undefined, readOnly)}
            {permissionRows(undefined, readOnly)}
          </Box>
        )}
        {agentRows.map(a => (
          <Box key={`agent-${a.id}`} flexDirection="column">
            {readOnly ? <Text>{a.status} {a.label}</Text> : (
              <Text dimColor={a.status === 'completed'} color={a.status === 'running' ? 'warning' : a.status === 'failed' ? 'error' : undefined}>
                {a.status.padEnd(9)} {a.label} {a.description}
              </Text>
            )}
            {approvalRows(a.id, readOnly)}
            {permissionRows(a.id, readOnly)}
          </Box>
        ))}
        {missingAgents.map(call => (
          <Box key={`approval-agent-${call.agentId}`} flexDirection="column">
            <Text>{singleLine(('who' in call ? call.who : undefined) ?? '에이전트')}</Text>
            {approvalRows(call.agentId, readOnly)}
            {permissionRows(call.agentId, readOnly)}
          </Box>
        ))}
      </Box>
    )

    // The phone has no Input or Select: it gets the same facts as a read-only list.
    if (e.surface === 'mobile' || !('Input' in ui) || !('Select' in ui)) {
      return (
        <Box flexDirection="column">
          <Text bold>{isUnchecked ? '변경 확인 보류' : `변경 ${list.length}개`}</Text>
          {isUnchecked && <Text color="warning" wrap="wrap">{UNCHECKED_TEXT}</Text>}
          {!isUnchecked && shown.map(f => (
            <Text>{fileLabel(f)}</Text>
          ))}
          {running.map(a => (
            <Text>{callRow(a)}</Text>
          ))}
          {pinned.map(p => (
            <Text>· {p.text}</Text>
          ))}
          {agentSection(true)}
          {codexRows.map(c => (
            <Text>
              {c.state} codex {c.label}
            </Text>
          ))}
          {codexRows.filter(c => c.result).map(c => (
            <Text dimColor wrap="wrap">  {c.label}: {c.result}</Text>
          ))}
          {below}
        </Box>
      )
    }
    const { Select, Input, Code } = ui

    return (
      <Box flexDirection="column">
        <Text bold>{isUnchecked ? '변경 확인 보류' : `변경 ${list.length}개`}</Text>
        {!isFocused && <Text color="suggestion">조작하려면 패널을 클릭하거나 ctrl+x 후 tab</Text>}
        {root === null && !isUnchecked && <Text dimColor>git 저장소가 아닙니다.</Text>}
        {isUnchecked && <Text color="warning" wrap="wrap">{UNCHECKED_TEXT}</Text>}
        {root !== null && !isUnchecked && list.length === 0 && <Text dimColor>변경된 파일 없음</Text>}
        {!isUnchecked && shown.length > 0 && (
          <Select
            key="files"
            options={shown.map(f => ({ value: f.path, label: fileLabel(f) }))}
            value={current ?? undefined}
            onSelect={(value: string) => void pick(value)}
          />
        )}
        {list.length > MAX_FILES && <Text dimColor>외 {list.length - MAX_FILES}개</Text>}
        {!isUnchecked && chosen && (
          <Box flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap">
              <Button key="open" hotkey="o" variant="primary" onPress={() => root && void openInEditor($, root, chosen.path)}>
                VS Code로 열기
              </Button>
              <Button key="stage" hotkey="s" onPress={() => void toggleStage()}>
                {chosen.index !== ' ' && chosen.index !== '?' ? '커밋에서 빼기' : '커밋에 넣기'}
              </Button>
              <Button key="why" hotkey="w" onPress={() => void send('왜 이렇게 바꿨는지 짧게 설명해줘')}>
                왜 바꿨어?
              </Button>
              <Button key="review" hotkey="r" onPress={() => void send('이 변경을 셀프 리뷰해줘: 버그, 빠진 경우, 더 단순한 방법')}>
                셀프 리뷰
              </Button>
            </Box>
            {clipped.text ? (
              <Code source={clipped.text} format="diff" path={chosen.path} wrap="wrap" />
            ) : (
              <Text dimColor>(diff 없음)</Text>
            )}
            {clipped.hidden > 0 && <Text dimColor>… {clipped.hidden}줄 더 (VS Code에서 전체 보기)</Text>}
            <Input key="note" label="Claude에게" placeholder="이 파일에 대해 지시" onSubmit={(value: string) => void send(value)} />
          </Box>
        )}
        {running.length > 0 && <Text bold>실행 중</Text>}
        {running.map(a => (
          <Box flexDirection="row">
            <Text color={a.asked ? 'warning' : undefined}>{`${elapsed(now - a.startedAt).padStart(6)} ${a.asked ? '승인 요청 ' : ''}`}</Text>
            <Box flexShrink={1}>
              <Text color={a.asked ? 'warning' : undefined} wrap="wrap">{a.summary}</Text>
            </Box>
            {now - a.startedAt >= HIDE_AFTER_MS && (
              <Button key={`hide-${a.id}`} onPress={() => void update($, activity, list => list.map(c => (c.id === a.id ? { ...c, hidden: true } : c))).catch(() => {})}>
                숨기기
              </Button>
            )}
          </Box>
        ))}
        <Text bold>고정한 결정</Text>
        {pinned.map(p => (
          <Box key={p.id}>
            <Button key={`done-${p.id}`} onPress={() => void removePin($, p.id)}>
              완료
            </Button>
            <Box flexShrink={1}>
              <Text wrap="wrap"> {p.text.length <= 100 ? p.text : `${p.text.slice(0, 99)}…`}</Text>
            </Box>
          </Box>
        ))}
        <Input key="pin" label="고정" placeholder="결정할 거리 (/pin 으로도 추가)" onSubmit={(value: string) => void addPin($, value)} />
        {agentSection(false)}
        {codexRows.map(c => (
          <Box flexDirection="column">
            <Text dimColor={c.state === 'done'} color={c.state === 'running' ? 'warning' : c.state === 'stalled' ? 'error' : undefined}>
              {c.state.padEnd(9)} codex {c.label}
            </Text>
            {c.result !== '' && (
              <Box paddingLeft={10}>
                <Text wrap="wrap">{c.result}</Text>
              </Box>
            )}
          </Box>
        ))}
        {below}
      </Box>
    )
  })
}
