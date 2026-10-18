export type Window = { percentUsed: number; resetsAt?: string }

export type Snapshot = {
  fiveHour?: Window
  sevenDay?: Window
  contextPercent?: number
  // Share of the last main-thread turn's input served from the prompt cache.
  cacheHitPercent?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-keeper': {
      snapshot: Snapshot | null
      idleDeadline: number | null
      keepAlives: number
      tick: number
    }
  }
}
