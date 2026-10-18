export type DuoChoice = 0 | 1 | 2 | 3

export type DuoQuestion = {
  id: string
  question: string
  choices: [string, string, string, string]
  answer: DuoChoice
  explanation: string
  isRetry: boolean
}

export type DuoQuiz = {
  status: 'idle' | 'generating' | 'active' | 'done'
  queue: DuoQuestion[]
  index: number
  phase: { kind: 'asking' } | { kind: 'answered'; chosen: DuoChoice }
  correct: number
  wrong: number
  skipped: number
  // Identifies the set so an old drawing cannot answer a newer set.
  setId: number
  // Why the last generation made no quiz; shown as one dim line until the next set.
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'duo-quiz': {
      quiz: DuoQuiz
      lastAnswer: string
    }
  }
}
