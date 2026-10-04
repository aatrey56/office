import { describe, expect, test } from 'claude-code/testing'

import type { EvalReport, RouteCase, RouteOutcome } from '../types'
import { formatReport, parseCases, scoreRoutes } from './evals'

const line = (o: Record<string, unknown>) => JSON.stringify({ id: 'a', task: 't', model: 'sonnet', effort: 'low', why: 'w', ...o })
const kase = (id: string, model: RouteCase['model'], effort: RouteCase['effort']): RouteCase => ({ id, task: 't', model, effort, why: 'w' })
const got = (id: string, model: 'haiku' | 'sonnet' | 'opus' | 'fable', effort: 'low' | 'medium' | 'high', latencyMs: number): RouteOutcome => ({
  id,
  model,
  effort,
  latencyMs,
})

describe('parseCases', () => {
  test('reads valid lines and skips blanks and comments', () => {
    const text = ['# labels', '', line({ id: 'a' }), '  ', line({ id: 'b', model: 'fable', effort: 'high' })].join('\n')
    const { cases, errors } = parseCases(text)
    expect(errors).toEqual([])
    expect(cases.map(c => c.id)).toEqual(['a', 'b'])
    expect(cases[1]).toEqual({ id: 'b', task: 't', model: 'fable', effort: 'high', why: 'w' })
  })
  test('errors name the 1-based line number and the problem; bad lines are excluded', () => {
    const text = [
      line({ id: 'ok' }), // 1
      '{not json', // 2
      '[1,2]', // 3
      line({ id: '' }), // 4
      line({ id: 'x', task: '  ' }), // 5
      line({ id: 'y', why: 7 }), // 6
      line({ id: 'z', model: 'gpt' }), // 7
      line({ id: 'w', effort: 'xhigh' }), // 8
      line({ id: 'v', effort: 'max' }), // 9
    ].join('\n')
    const { cases, errors } = parseCases(text)
    expect(cases.map(c => c.id)).toEqual(['ok'])
    expect(errors.length).toBe(8)
    expect(errors[0]).toBe('line 2: invalid JSON')
    expect(errors[1]).toContain('line 3: not a JSON object')
    expect(errors[2]).toContain('line 4: id')
    expect(errors[3]).toContain('line 5: task')
    expect(errors[4]).toContain('line 6: why')
    expect(errors[5]).toContain('line 7: model')
    expect(errors[6]).toContain('line 8: effort')
    expect(errors[7]).toContain('line 9: effort')
  })
})

describe('scoreRoutes', () => {
  const cases = [
    kase('c1', 'sonnet', 'low'),
    kase('c2', 'opus', 'high'),
    kase('c3', 'fable', 'high'),
    kase('c4', 'opus', 'medium'),
    kase('c5', 'sonnet', 'medium'),
    kase('c6', 'fable', 'medium'),
  ]
  const outcomes: RouteOutcome[] = [
    got('c1', 'sonnet', 'low', 100), // exact
    got('c2', 'fable', 'high', 300), // one tier over, effort right
    got('c3', 'sonnet', 'high', 200), // two tiers under, effort right
    got('c4', 'opus', 'low', 400), // model right, effort wrong
    { id: 'c5', error: 'timeout' },
    // c6 has no outcome
  ]
  const r = scoreRoutes(cases, outcomes, 'rules')

  test('every counter', () => {
    expect(r.backend).toBe('rules')
    expect(r.total).toBe(6)
    expect(r.answered).toBe(4)
    expect(r.exact).toBe(1)
    expect(r.modelMatch).toBe(2)
    expect(r.withinOneTier).toBe(3)
    expect(r.effortMatch).toBe(3)
    expect(r.overRouted).toBe(1)
    expect(r.underRouted).toBe(1)
    expect(r.medianLatencyMs).toBe(250)
  })
  test('misses are in case order with want and got as model/effort', () => {
    expect(r.misses).toEqual([
      { id: 'c2', want: 'opus/high', got: 'fable/high' },
      { id: 'c3', want: 'fable/high', got: 'sonnet/high' },
      { id: 'c4', want: 'opus/medium', got: 'opus/low' },
      { id: 'c5', want: 'sonnet/medium', got: 'error: timeout' },
      { id: 'c6', want: 'fable/medium', got: 'no answer' },
    ])
  })
})

describe('formatReport', () => {
  const report = (over: Partial<EvalReport> = {}): EvalReport => ({
    backend: 'rules',
    total: 8,
    answered: 8,
    exact: 4,
    modelMatch: 6,
    withinOneTier: 8,
    effortMatch: 5,
    overRouted: 1,
    underRouted: 1,
    medianLatencyMs: 12,
    misses: [],
    ...over,
  })

  test('one row per report with whole-number percentages of total', () => {
    const out = formatReport([report(), report({ backend: 'claude', total: 3, answered: 2, exact: 1, modelMatch: 1, withinOneTier: 2, effortMatch: 2, overRouted: 0, underRouted: 1, medianLatencyMs: 840 })], 100)
    const lines = out.split('\n')
    expect(lines.length).toBe(3) // header and two rows, no misses
    expect(lines[1]).toContain('rules')
    expect(lines[1]).toContain('8/8')
    expect(lines[1]).toContain('50%') // exact 4/8
    expect(lines[1]).toContain('75%') // model 6/8
    expect(lines[1]).toContain('100%')
    expect(lines[1]).toContain('13%') // 1/8 rounds from 12.5
    expect(lines[1]).toContain('12ms')
    expect(lines[2]).toContain('claude')
    expect(lines[2]).toContain('2/3')
    expect(lines[2]).toContain('33%') // 1/3
    expect(lines[2]).toContain('67%') // 2/3
    expect(lines[2]).toContain('840ms')
  })
})
