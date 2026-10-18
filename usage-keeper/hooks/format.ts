import type { Snapshot } from '../types'

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  return hours > 0 ? `${hours}h${rest}m` : `${rest}m`
}

export function bandText(snapshot: Snapshot | null, idleDeadline: number | null, now: number, keepAlive = false): string {
  const parts: string[] = []
  const fiveHour = snapshot?.fiveHour

  if (fiveHour) {
    const resetsAt = fiveHour.resetsAt ? Date.parse(fiveHour.resetsAt) : NaN
    const reset = Number.isFinite(resetsAt) && resetsAt > now ? ` 리셋 ${formatDuration(resetsAt - now)}` : ''
    parts.push(`5h ${fiveHour.percentUsed}%${reset}`)
  }
  if (snapshot?.sevenDay) parts.push(`7d ${snapshot.sevenDay.percentUsed}%`)
  if (snapshot?.contextPercent !== undefined) parts.push(`ctx ${snapshot.contextPercent}%`)
  if (snapshot?.cacheHitPercent !== undefined) parts.push(`캐시 ${snapshot.cacheHitPercent}%`)
  if (idleDeadline !== null) parts.push(`${keepAlive ? '유지' : '핸드오프'} ${formatDuration(idleDeadline - now)}`)

  return parts.join(' · ')
}

// The highest window decides the band's color, so a nearly spent limit stands out.
export function bandColor(snapshot: Snapshot | null): string | undefined {
  const worst = Math.max(snapshot?.fiveHour?.percentUsed ?? 0, snapshot?.sevenDay?.percentUsed ?? 0)
  if (worst >= 90) return 'red'
  if (worst >= 70) return 'yellow'
  return undefined
}

export function cacheHitPercent(usage: {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): number | undefined {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return total > 0 ? Math.round((usage.cache_read_input_tokens / total) * 100) : undefined
}
