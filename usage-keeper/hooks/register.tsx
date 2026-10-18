import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { Snapshot } from '../types'
import { bandColor, bandText, cacheHitPercent } from './format'
import { GIT_STATE_SCRIPT, HANDOFF_INSTRUCTIONS, handoffDocument, parseGitState, SHELL_ARGV } from './handoff'

// A keep-alive at 55 minutes idle is a cache read (~0.1x context) that refreshes
// the 1-hour TTL; after N keep-alives the handoff compacts while the cache is warm.
const IDLE_MS = 55 * 60_000
const KEEP_ALIVE_TEXT = 'Keep-alive. Reply "ok" only.'
// Below this the cache rewrite is too small to be worth a compaction.
const MIN_CONTEXT_TOKENS = 20_000
// Ping a little after the reset so the new window has surely opened.
const PING_DELAY_MS = 60_000
// Store keys shared by every open session of this mod.
const PINGED_KEY = 'pingedResets'
const CLAIM_KEY = 'pingClaim'
const LAST_RESET_KEY = 'fiveHourResetsAt'
// $.store has no compare-and-set: claim, wait, and re-read so two sessions
// racing on one reset almost always settle on a single pinger.
const CLAIM_SETTLE_MS = 3_000

const snapshotAtom = atom({ plugin: 'usage-keeper', key: 'snapshot' } as const, null)
const deadlineAtom = atom({ plugin: 'usage-keeper', key: 'idleDeadline' } as const, null)
const keepAlivesAtom = atom({ plugin: 'usage-keeper', key: 'keepAlives' } as const, 0)
const tickAtom = atom({ plugin: 'usage-keeper', key: 'tick' } as const, 0)

function toSnapshot(rateLimits: readonly SessionRateLimit[], contextPercent?: number): Snapshot {
  const pick = (kind: string) => {
    const found = rateLimits.find(one => one.kind === kind)
    return found ? { percentUsed: found.percentUsed, resetsAt: found.resetsAt } : undefined
  }

  return { fiveHour: pick('five_hour'), sevenDay: pick('seven_day'), contextPercent }
}

// Module state: a hot reload starts it over, and session.start re-arms it.
// Each arm bumps a generation, so a call that awaited past a newer one stands down.
let idleTimer: Timer | undefined
let idleGen = 0
let pingTimer: Timer | undefined
let pingGen = 0
let tickTimer: Timer | undefined

// Timer callbacks run outside any hook, so their failures would go unhandled.
function guard($: EngineInterface, label: string, work: Promise<unknown>) {
  work.catch(error => $.ui.log(`usage-keeper: ${label} failed: ${String(error)}`, { to: 'debug' }))
}

async function refresh($: EngineInterface) {
  const usage = await $.session.usage()
  const snapshot = toSnapshot(usage.rateLimits, usage.context.percent)
  await update($, snapshotAtom, old => ({ ...snapshot, cacheHitPercent: old?.cacheHitPercent }))
  await schedulePing($, snapshot)
}

async function armIdle($: EngineInterface, deadline: number, keepAliveLimit: number) {
  const gen = ++idleGen
  const wait = Math.max(0, deadline - (await $.clock.now()))
  if (gen !== idleGen) return
  idleTimer?.cancel()
  idleTimer = $.clock.after(wait, () => guard($, 'handoff', handoff($, gen, keepAliveLimit)))
  // Written after the timer, so a disarm that lands meanwhile clears it last.
  await update($, deadlineAtom, () => deadline)
}

async function disarmIdle($: EngineInterface) {
  idleGen += 1
  idleTimer?.cancel()
  idleTimer = undefined
  await update($, deadlineAtom, () => null)
}

async function handoff($: EngineInterface, gen: number, keepAliveLimit: number) {
  if (gen !== idleGen || (await read($, deadlineAtom)) === null) return
  await disarmIdle($)
  const { context } = await $.session.usage()
  if ((context.tokens ?? 0) < MIN_CONTEXT_TOKENS) return

  if ((await read($, keepAlivesAtom)) < keepAliveLimit) {
    const count = await update($, keepAlivesAtom, n => n + 1)
    try {
      const submitted = await $.prompt.submit({ text: KEEP_ALIVE_TEXT })
      if (submitted.drop === undefined) {
        $.ui.toast(`55분 대기: 캐시 유지 메시지를 보냈어요 (${count}/${keepAliveLimit})`)
        return
      }
      $.ui.log(`usage-keeper: keep-alive dropped: ${submitted.drop}`, { to: 'debug' })
    } catch (error) {
      $.ui.log(`usage-keeper: keep-alive failed: ${String(error)}`, { to: 'debug' })
    }
  }

  let result
  try {
    result = await $.session.compact({ instructions: HANDOFF_INSTRUCTIONS })
  } catch {
    // A turn is running, so the session is not idle after all.
    return
  }
  if (result.skip !== undefined) {
    $.ui.log(`usage-keeper: handoff skipped: ${result.skip}`, { to: 'debug' })
    return
  }
  await update($, keepAlivesAtom, () => 0)

  // The compaction already stands; a failed save only loses the copy on disk.
  try {
    const home = await $.env.get('HOME')
    if (home !== undefined) {
      const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
      const path = `${home}/.claude/handoffs/${stamp}-${await $.session.id()}.md`
      const cwd = await $.session.cwd()
      const summary = result.messages.map(message => message.text).join('\n\n')
      // Git facts are optional: a failed or slow read leaves them out, never the summary.
      const run = await $.process.run([...SHELL_ARGV, GIT_STATE_SCRIPT], { cwd, timeoutMs: 5_000 }).catch(() => undefined)
      const git = run?.exitCode === 0 ? parseGitState(run.stdout) : undefined
      await $.fs.write(path, handoffDocument({ cwd, savedAt: new Date(await $.clock.now()).toISOString(), git, summary }))
    }
  } catch (error) {
    $.ui.log(`usage-keeper: handoff file not saved: ${String(error)}`, { to: 'debug' })
  }
  $.ui.toast('55분 대기: 맥락을 핸드오프 요약으로 압축했어요')
  await refresh($)
}

async function pingedResets($: EngineInterface): Promise<string[]> {
  const stored = await $.store.get(PINGED_KEY)
  return Array.isArray(stored) ? stored.filter((one): one is string => typeof one === 'string') : []
}

async function schedulePing($: EngineInterface, snapshot: Snapshot) {
  const gen = ++pingGen
  // Keep only the newest reset seen, so a session with a stale reading cannot
  // pull the fallback back to a window that already passed.
  const stored = await $.store.get(LAST_RESET_KEY)
  const known = typeof stored === 'string' ? stored : undefined
  const live = snapshot.fiveHour?.resetsAt
  const newest = [live, known]
    .filter((one): one is string => one !== undefined && Number.isFinite(Date.parse(one)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
  if (newest !== undefined && newest !== known) await $.store.set(LAST_RESET_KEY, newest)

  const isDone = newest === undefined || (await pingedResets($)).includes(newest)
  const wait = isDone ? 0 : Math.max(0, Date.parse(newest) + PING_DELAY_MS - (await $.clock.now()))
  if (gen !== pingGen) return
  pingTimer?.cancel()
  pingTimer = isDone ? undefined : $.clock.after(wait, () => guard($, 'reset ping', ping($, newest)))
}

async function ping($: EngineInterface, resetsAt: string) {
  if ((await pingedResets($)).includes(resetsAt)) return
  const claim = `${resetsAt}|${await $.session.id()}`
  await $.store.set(CLAIM_KEY, claim)
  await $.clock.sleep(CLAIM_SETTLE_MS)
  if ((await $.store.get(CLAIM_KEY)) !== claim) return

  // One attempt per reset, success or not: a missed ping only means the window
  // starts at the next real request, as it would without this mod.
  const pinged = await pingedResets($)
  if (pinged.includes(resetsAt)) return
  await $.store.set(PINGED_KEY, [...pinged, resetsAt].slice(-20))

  try {
    const reply = await $.model.complete({ model: 'haiku', prompt: 'ping', maxTokens: 8, timeoutMs: 30_000 })
    if (!reply.isAnswered) {
      $.ui.log(`usage-keeper: reset ping unanswered (${reply.reason})`, { to: 'debug' })
      return
    }
  } catch (error) {
    $.ui.log(`usage-keeper: reset ping refused: ${String(error)}`, { to: 'debug' })
    return
  }
  $.ui.toast('5시간 창 리셋: 핑으로 새 창을 시작했어요')
  await refresh($)
}

export const register: Register = (on, options) => {
  const keepAliveLimit = typeof options.keepAlives === 'number' && Number.isFinite(options.keepAlives) && options.keepAlives >= 0
    ? Math.floor(options.keepAlives)
    : 3

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    tickTimer?.cancel()
    tickTimer = $.clock.every(60_000, () => guard($, 'tick', update($, tickAtom, n => n + 1)))
    const deadline = await read($, deadlineAtom)
    if (deadline !== null) await armIdle($, deadline, keepAliveLimit)
    await refresh($)

    return result
  })

  // A failed disarm must never hold up the prompt itself.
  on('prompt.submit', async ($, e, next) => {
    await disarmIdle($)
    if (e.origin.kind !== 'plugin' || e.origin.name !== 'usage-keeper') await update($, keepAlivesAtom, () => 0)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Subagent turns end inside the main turn; only the main thread's last answer counts.
    if (e.agentId === undefined) {
      const hit = e.usage ? cacheHitPercent(e.usage) : undefined
      if (hit !== undefined) await update($, snapshotAtom, old => ({ ...old, cacheHitPercent: hit }))
      await armIdle($, (await $.clock.now()) + IDLE_MS, keepAliveLimit)
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    const snapshot = toSnapshot(e.rateLimits, e.context.percent)
    await update($, snapshotAtom, old => ({ ...snapshot, cacheHitPercent: old?.cacheHitPercent }))
    await schedulePing($, snapshot)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods and Claude Code draw here too: keep what the rest of the chain drew.
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    await read($, tickAtom)
    const snapshot = await read($, snapshotAtom)
    const text = bandText(snapshot, await read($, deadlineAtom), await $.clock.now(), (await read($, keepAlivesAtom)) < keepAliveLimit)
    if (text === '') return rest

    const { Box, Text } = $.ui.resolve(e)
    const color = bandColor(snapshot)

    return (
      <Box flexDirection="column">
        <Text color={color} dimColor={color === undefined} wrap="wrap">
          {text}
        </Text>
        {rest}
      </Box>
    )
  })
}
