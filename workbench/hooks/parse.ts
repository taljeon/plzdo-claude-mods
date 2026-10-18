import type { ChangedFile, CodexState } from '../types'

// `git status --porcelain=v1 -z`: "XY path\0", and a rename or copy adds "orig\0" after it.
export function parseStatus(raw: string): ChangedFile[] {
  const parts = raw.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    if (entry.length < 4) continue
    const index = entry[0] ?? ' '
    const worktree = entry[1] ?? ' '
    files.push({ path: entry.slice(3), index, worktree, added: 0, removed: 0 })
    if (index === 'R' || index === 'C') i++
  }
  return files
}

// `git diff HEAD --numstat -z`: "added\tremoved\tpath\0"; a rename is "a\tr\t\0old\0new\0".
export function parseNumstat(raw: string): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>()
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i] ?? '')
    if (!m) continue
    let path = m[3] ?? ''
    if (path === '') {
      path = parts[i + 2] ?? ''
      i += 2
    }
    out.set(path, { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) })
  }
  return out
}

export const STALL_MS = 5 * 60_000

export type Marker = 'started' | 'complete' | null

// The last turn marker in the tail of a Codex rollout: the file is JSON lines, and the first
// line of a `tail` may be cut, so a line that does not parse is skipped.
export function lastMarker(tail: string): Marker {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim()
    if (!line) continue
    try {
      const row = JSON.parse(line) as { type?: string; payload?: { type?: string } }
      if (row.type !== 'event_msg') continue
      if (row.payload?.type === 'task_complete') return 'complete'
      if (row.payload?.type === 'task_started') return 'started'
    } catch {
      continue
    }
  }
  return null
}

// The first line of what the run's last finished turn answered, in plain text: a review's verdict.
export function lastResult(tail: string, max = 100): string {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i] ?? '') as { type?: string; payload?: { type?: string; last_agent_message?: unknown } }
      if (row.type !== 'event_msg' || row.payload?.type !== 'task_complete') continue
      const text = typeof row.payload.last_agent_message === 'string' ? row.payload.last_agent_message : ''
      // Markdown bold and code marks, and a leading heading, quote, bullet or arrow; the rest is kept as written.
      const plain = (l: string) => l.replace(/\*\*|`/g, '').replace(/^[\s#>*\-→]+/, '').trim()
      const first = text.split('\n').map(plain).find(l => l !== '') ?? ''
      // A bare tag like <heartbeat> is a keep-alive, not an answer.
      if (/^<[\w-]+>$/.test(first)) return ''
      return first.length <= max ? first : `${first.slice(0, max - 1)}…`
    } catch {
      continue
    }
  }
  return ''
}

// A turn that started and whose file has not moved for STALL_MS is "stalled", not "running":
// a crashed or killed run leaves no closing marker.
export function codexState(marker: Marker, mtimeMs: number, now: number): CodexState {
  if (marker === 'complete') return 'done'
  if (marker === 'started') return now - mtimeMs > STALL_MS ? 'stalled' : 'running'
  return 'unknown'
}

export function metaLabel(firstLine: string): string {
  try {
    const row = JSON.parse(firstLine) as { payload?: { cwd?: string } }
    const cwd = row.payload?.cwd ?? ''
    return cwd.split('/').filter(Boolean).pop() ?? 'codex'
  } catch {
    return 'codex'
  }
}

// The pane draws `Code format="diff"`, which reads hunks only: git's `diff --git`/`index` header
// and a hunk cut mid-way make it fall back to plain, uncoloured text. So the header is dropped and
// a cut hunk gets its `@@` counts rewritten to the lines that are kept.
export function clipDiff(text: string, max: number): { text: string; hidden: number } {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.startsWith('@@'))
  if (start < 0) return { text: '', hidden: 0 }
  const body = lines.slice(start)
  while (body.length && body[body.length - 1] === '') body.pop()
  if (body.length <= max) return { text: body.join('\n'), hidden: 0 }
  const kept = body.slice(0, max)
  let header = -1
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i]?.startsWith('@@')) {
      header = i
      break
    }
  }
  if (header === kept.length - 1) kept.pop()
  else if (header >= 0) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(kept[header] ?? '')
    if (m) {
      const rest = kept.slice(header + 1).filter(l => !l.startsWith('\\'))
      const oldCount = rest.filter(l => !l.startsWith('+')).length
      const newCount = rest.filter(l => !l.startsWith('-')).length
      kept[header] = `@@ -${m[1]},${oldCount} +${m[2]},${newCount} @@${m[3]}`
    }
  }
  return { text: kept.join('\n'), hidden: body.length - kept.length }
}

export function fileLabel(f: ChangedFile): string {
  const code = f.index === '?' ? '??' : `${f.index === ' ' ? '' : f.index}${f.worktree === ' ' ? '' : f.worktree}`
  const delta = f.added || f.removed ? ` +${f.added} -${f.removed}` : ''
  return `${code.padEnd(2)} ${f.path}${delta}`
}

const compactInput = (input: unknown) => JSON.stringify(input, (_key, value: unknown) =>
  typeof value === 'string' && value.length > 200
    ? `${value.slice(0, 200)}…(+${value.length - 200}자)` : value)

// Approval text keeps the full primary argument; only strings inside the extra JSON are shortened.
export function callText(tool: string, input: unknown, caller?: string): string {
  const title = caller ? `${tool} [${caller}]` : tool
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return `${title} ${compactInput(input) ?? ''}`.trimEnd()
  }
  const fields = Object.entries(input)
  if (tool === 'Bash') {
    const o = input as Record<string, unknown>
    return [title, ...(o.dangerouslyDisableSandbox === true ? ['[샌드박스 해제]'] : []),
      ...(o.run_in_background === true ? ['[백그라운드]'] : []),
      typeof o.command === 'string' ? o.command : compactInput(input)].join(' ')
  }
  const primary = ['file_path', 'url', 'pattern', 'command']
    .map(key => fields.find(([name, value]) => name === key && typeof value === 'string'))
    .find(field => field !== undefined)
  const remaining = Object.fromEntries(fields.filter(([key]) => key !== primary?.[0]))
  return [title, ...(primary ? [primary[1]] : []),
    ...(Object.keys(remaining).length ? [compactInput(remaining)] : [])].join(' ')
}

// One line for a running tool call: what it is, in a few words.
export function callSummary(tool: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  const text = typeof o.command === 'string' ? o.command
    : typeof o.file_path === 'string' ? o.file_path
    : typeof o.description === 'string' ? o.description
    : typeof o.pattern === 'string' ? o.pattern
    : ''
  const line = text.split('\n')[0]!.trim()
  return line ? `${tool} ${line.length > 100 ? `${line.slice(0, 99)}…` : line}` : tool
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
