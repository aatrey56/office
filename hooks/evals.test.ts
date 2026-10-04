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
  test('handles CRLF line endings', () => {
    const { cases, errors } = parseCases(`${line({ id: 'a' })}\r\n${line({ id: 'b' })}\r\n`)
    expect(errors).toEqual([])
    expect(cases.length).toBe(2)
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
  test('a missing field is reported', () => {
    const { cases, errors } = parseCases('{"id":"a","task":"t","model":"opus","why":"w"}')
    expect(cases).toEqual([])
    expect(errors).toEqual(['line 1: effort must be one of low, medium, high'])
  })
  test('haiku is a legal model value', () => {
    expect(parseCases(line({ model: 'haiku' })).errors).toEqual([])
  })
  test('duplicate ids are an error and the later line is dropped', () => {
    const { cases, errors } = parseCases([line({ id: 'a' }), line({ id: 'b' }), line({ id: 'a', model: 'opus' })].join('\n'))
    expect(cases.map(c => c.id)).toEqual(['a', 'b'])
    expect(cases[0].model).toBe('sonnet')
    expect(errors).toEqual(['line 3: duplicate id a'])
  })
  test('shape rules on a small inline set, with no disk read', () => {
    const inline = [
      '{"id":"r01","task":"rename a variable","model":"sonnet","effort":"low","why":"mechanical"}',
      '{"id":"r02","task":"debug a flaky test","model":"opus","effort":"high","why":"subtle"}',
      '{"id":"r03","task":"design the platform","model":"fable","effort":"high","why":"architecture"}',
    ].join('\n')
    const { cases, errors } = parseCases(inline)
    expect(errors).toEqual([])
    expect(cases.length).toBe(3)
    for (const c of cases) {
      expect(['sonnet', 'opus', 'fable']).toContain(c.model)
      expect(['low', 'medium', 'high']).toContain(c.effort)
      expect(c.task.length).toBeGreaterThan(0)
      expect(c.why.length).toBeGreaterThan(0)
    }
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length)
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
  test('outcomes are matched by id, not by position', () => {
    const rev = scoreRoutes(cases, [...outcomes].reverse(), 'rules')
    expect(rev).toEqual(r)
  })
  test('median of an odd count is the middle value', () => {
    const three = [kase('a', 'opus', 'low'), kase('b', 'opus', 'low'), kase('c', 'opus', 'low')]
    const rep = scoreRoutes(three, [got('a', 'opus', 'low', 900), got('b', 'opus', 'low', 10), got('c', 'opus', 'low', 50)], 'claude')
    expect(rep.medianLatencyMs).toBe(50)
  })
  test('median ignores unanswered cases', () => {
    const rep = scoreRoutes(cases.slice(0, 3), [got('c1', 'sonnet', 'low', 10), { id: 'c2', error: 'x' }, got('c3', 'fable', 'high', 30)], 'jev')
    expect(rep.medianLatencyMs).toBe(20)
  })
  test('no answers at all: zero median, every case a miss', () => {
    const rep = scoreRoutes(cases.slice(0, 2), [], 'jev')
    expect(rep.total).toBe(2)
    expect(rep.answered).toBe(0)
    expect(rep.medianLatencyMs).toBe(0)
    expect(rep.exact + rep.modelMatch + rep.withinOneTier + rep.effortMatch + rep.overRouted + rep.underRouted).toBe(0)
    expect(rep.misses.map(m => m.got)).toEqual(['no answer', 'no answer'])
  })
  test('no cases: all zero', () => {
    const rep = scoreRoutes([], [got('zz', 'opus', 'low', 5)], 'rules')
    expect(rep.total).toBe(0)
    expect(rep.answered).toBe(0)
    expect(rep.misses).toEqual([])
  })
  test('outcomes for unknown ids are ignored', () => {
    const rep = scoreRoutes([kase('a', 'opus', 'low')], [got('nope', 'opus', 'low', 5)], 'rules')
    expect(rep.answered).toBe(0)
    expect(rep.misses[0].got).toBe('no answer')
  })
  test('one tier under is within one tier and counts as under-routed', () => {
    const rep = scoreRoutes([kase('a', 'fable', 'high')], [got('a', 'opus', 'high', 5)], 'rules')
    expect(rep).toMatchObject({ modelMatch: 0, withinOneTier: 1, underRouted: 1, overRouted: 0, exact: 0, effortMatch: 1 })
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
  test('a dash for zero total', () => {
    const out = formatReport([report({ total: 0, answered: 0, exact: 0, modelMatch: 0, withinOneTier: 0, effortMatch: 0, overRouted: 0, underRouted: 0, medianLatencyMs: 0 })], 100)
    expect(out).toContain('0/0')
    expect(out).not.toContain('NaN')
    expect(out.split('\n')[1]).toContain('-')
    expect(out.split('\n')[1]).not.toContain('%')
  })
  test('lists up to 10 misses per report and a +N more line', () => {
    const misses = Array.from({ length: 13 }, (_, i) => ({ id: `m${i + 1}`, want: 'opus/high', got: 'sonnet/low' }))
    const out = formatReport([report({ misses })], 100)
    expect(out).toContain('m1: want opus/high, got sonnet/low')
    expect(out).toContain('m10: want opus/high, got sonnet/low')
    expect(out).not.toContain('m11:')
    expect(out).toContain('+3 more')
  })
  test('exactly 10 misses has no +N more line', () => {
    const misses = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, want: 'a/low', got: 'b/low' }))
    expect(formatReport([report({ misses })], 100)).not.toContain('more')
  })
  test('misses are listed per report', () => {
    const out = formatReport([report({ misses: [{ id: 'x1', want: 'a/low', got: 'b/low' }] }), report({ backend: 'jev', misses: [{ id: 'y1', want: 'a/low', got: 'no answer' }] })], 100)
    expect(out.indexOf('x1')).toBeLessThan(out.indexOf('y1'))
    expect(out).toContain('y1: want a/low, got no answer')
  })
  test('every line fits in the column count, cut with an ellipsis', () => {
    const misses = [{ id: 'long', want: 'opus/high', got: `error: ${'x'.repeat(200)}` }]
    for (const columns of [20, 40, 80]) {
      const out = formatReport([report({ misses })], columns)
      for (const l of out.split('\n')) expect(l.length).toBeLessThanOrEqual(columns)
      expect(out).toContain('…')
    }
  })
  test('short lines are not cut', () => {
    const out = formatReport([report({ misses: [{ id: 'a', want: 'a/low', got: 'b/low' }] })], 200)
    expect(out).not.toContain('…')
  })
  test('plain text: no ANSI escapes, and multi-line errors collapse to one line', () => {
    const out = formatReport([report({ misses: [{ id: 'a', want: 'a/low', got: 'error: bad\nthing' }] })], 100)
    expect(out).not.toContain('\u001b')
    expect(out).toContain('got error: bad thing')
  })
})
