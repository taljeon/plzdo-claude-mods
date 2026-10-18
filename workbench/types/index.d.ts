export type ChangedFile = {
  path: string
  // git status letters: index column, then worktree column ('?' for untracked)
  index: string
  worktree: string
  added: number
  removed: number
}

export type AgentRow = { id: string; label: string; status: string; description: string }

export type CodexState = 'running' | 'stalled' | 'done' | 'unknown'
// `result`: the first line of the last finished turn's answer, or ''.
export type CodexRun = { id: string; label: string; state: CodexState; updatedAt: number; result: string }

// A tool call that has not finished; `asked` once a permission dialog was put to the person, `hidden` once they dropped its row.
export type Activity = { id: string; summary: string; startedAt: number; asked: boolean; hidden: boolean }
export type Pin = { id: string; text: string; at: number }
export type Approval = { id: string; decision: 'proceed' | 'cancel'; at: number }
export type PermissionAsk = {
  id: string; tool: string; text: string; rule: string; agentId?: string; at: number
}

declare module 'claude-code' {
  interface PluginState {
    workbench: {
      files: ChangedFile[]
      selected: string | null
      diff: string
      repo: string | null
      agents: AgentRow[]
      codex: CodexRun[]
      activity: Activity[]
      pins: Pin[]
      approvals: Approval[]
      permissions: PermissionAsk[]
    }
  }
}
