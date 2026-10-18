import { describe, expect, test } from 'claude-code/testing'
import { parseQuestions, spreadAnswers } from '../hooks/quiz'
import type { DuoQuestion } from '../types'

const question = {
  id: 'q1', question: '상태(atom)의 역할은?', choices: ['상태 보관', '파일 삭제', '프로세스 종료', '네트워크 차단'],
  answer: 0, explanation: 'atom은 세션 상태를 보관합니다.',
}

describe('quiz parser', () => {
  test('accepts fenced JSON and initializes originals as non-retries', () => {
    expect(parseQuestions(`\n\`\`\`json\n${JSON.stringify([question])}\n\`\`\`\n`)).toEqual([{ ...question, isRetry: false }])
    expect(parseQuestions(JSON.stringify({ questions: [question] }))).toHaveLength(1)
  })

  test('finds the array inside surrounding prose', () => {
    expect(parseQuestions(`문제입니다:\n${JSON.stringify([question])}\n끝.`)).toHaveLength(1)
  })

  test('drops invalid entries without dropping valid neighbors', () => {
    const invalid = [
      null, 'question', {}, { ...question, id: ' ' }, { ...question, question: '' },
      { ...question, explanation: '\n' }, { ...question, choices: ['a', 'b', 'c'] },
      { ...question, choices: ['a', 'b', 'c', 'd', 'e'] }, { ...question, choices: ['a', 'b', '', 'd'] },
      { ...question, choices: ['a', 'b', 1, 'd'] }, { ...question, answer: -1 },
      { ...question, answer: 4 }, { ...question, answer: 1.5 }, { ...question, answer: '0' },
    ]
    expect(parseQuestions(JSON.stringify([question, ...invalid, { ...question, id: 'q2', answer: 3 }])).map(q => q.id)).toEqual(['q1', 'q2'])
  })

  test('keeps at most ten valid entries', () => {
    const entries = [null, ...Array.from({ length: 15 }, (_, i) => ({ ...question, id: `q${i}` }))]
    const parsed = parseQuestions(JSON.stringify(entries))
    expect(parsed).toHaveLength(10)
    expect(parsed[9]?.id).toBe('q9')
  })

  test('garbage, non-arrays and empty arrays are empty', () => {
    for (const text of ['garbage', '', 'null', '{}', '[]', '```json\ninvalid\n```']) {
      expect(parseQuestions(text)).toEqual([])
    }
  })

  test('spreadAnswers walks the answer through all four slots and keeps the right choice', () => {
    const choices: DuoQuestion['choices'] = ['상태 보관', '파일 삭제', '프로세스 종료', '네트워크 차단']
    const set: DuoQuestion[] = Array.from({ length: 8 }, (_, i) => ({ ...question, choices, id: `q${i}`, question: `질문 ${i}`, answer: 1, isRetry: false }))
    const spread = spreadAnswers(set)
    expect(new Set(spread.map(q => q.answer)).size).toBe(4)
    for (const q of spread) {
      expect(q.choices[q.answer]).toBe(choices[1])
      expect([...q.choices].sort()).toEqual([...choices].sort())
    }
    expect(spreadAnswers(set)).toEqual(spread)
  })
})
