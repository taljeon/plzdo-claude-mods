import type { DuoQuestion } from '../types'

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// The model sometimes wraps the array in a sentence; fall back to the outermost [...] span.
function parseJson(text: string): unknown {
  const json = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')
  try {
    return JSON.parse(json)
  } catch {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start < 0 || end <= start) throw new Error('no JSON array')
    return JSON.parse(text.slice(start, end + 1))
  }
}

export function parseQuestions(text: string): DuoQuestion[] {
  try {
    const parsed: unknown = parseJson(text)
    const entries: unknown = record(parsed) ? parsed.questions : parsed
    if (!Array.isArray(entries)) return []
    const questions: DuoQuestion[] = []
    for (const entry of entries) {
      if (!record(entry) || !nonempty(entry.id) || !nonempty(entry.question) || !nonempty(entry.explanation)) continue
      const choices: unknown = entry.choices
      if (!Array.isArray(choices) || choices.length !== 4) continue
      const [a, b, c, d]: unknown[] = choices
      if (!nonempty(a) || !nonempty(b) || !nonempty(c) || !nonempty(d)) continue
      const answer = entry.answer
      if (answer !== 0 && answer !== 1 && answer !== 2 && answer !== 3) continue
      questions.push({
        id: entry.id.trim(), question: entry.question.trim(),
        choices: [a.trim(), b.trim(), c.trim(), d.trim()], answer,
        explanation: entry.explanation.trim(), isRetry: false,
      })
      if (questions.length === 10) break
    }
    return questions
  } catch {
    return []
  }
}

// Models put the right answer in the same slot most of the time; rotate each question's choices
// so the answers walk through all four slots. Deterministic, so a redraw never reshuffles.
export function spreadAnswers(questions: DuoQuestion[]): DuoQuestion[] {
  let seed = 0
  for (const q of questions) for (const ch of q.question) seed = (seed * 31 + ch.charCodeAt(0)) % 9973
  return questions.map((q, i) => {
    const target = (seed + i) % 4
    const shift = (q.answer - target + 4) % 4
    const choices = [0, 1, 2, 3].map(j => q.choices[(j + shift) % 4]) as DuoQuestion['choices']
    return { ...q, choices, answer: target as DuoQuestion['answer'] }
  })
}
