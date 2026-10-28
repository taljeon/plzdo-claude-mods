export type Highlight = { level: 'high' | 'mid' | 'low'; text: string; uiText?: string }

export type PreviewItem = { text: string; content?: string }
export type PreviewSection = { summary: string; items: PreviewItem[] }

export type WaitingCall = { id: string; command: string; who: string; agentId?: string }

export type HeldCommand = {
  id: string
  holdId?: string
  command: string
  agentId?: string
  /** Absent in held state saved by older plugin activations. */
  who?: string
  risk: 'delete' | 'force-push' | 'migration' | 'secret' | 'outside'
  summary: string
  details: string[]
  /** Korean summaries and grouped path/content rows; absent in older held state. */
  sections?: PreviewSection[]
  /** What would really hurt to lose, most dangerous first. */
  highlights: Highlight[]
  where: 'pane' | 'band'
  /** Seconds until the hold auto-cancels; null when it waits for a press forever. */
  secondsLeft: number | null
}

declare module 'claude-code' {
  // Compatibility with hosts exposing Grep; this build omits it from its generated table.
  interface BuiltinToolInputs {
    Grep: { pattern: string; path?: string }
  }
  interface PluginState {
    'blast-radius': { held: HeldCommand | null; waiting: WaitingCall[] }
  }
}
