import { describe, expect, test } from 'claude-code/testing'

import { bgEnding, countFindings, finishRecord, finishVerdict, OUTCOME_LINE_MAX, reviewRecord, spawnRecord, transcriptTokens, trialSwap, trialUntil, turnEnding } from './outcomes'

describe('finishVerdict', () => {
  test('a done job is what its gate said; a failed one is a timeout, a stop or a failure', () => {
    const gate = (verdict: 'pass' | 'fail' | 'unverified' | 'no-change', head: string) => ({ verdict, head })
    const cases: [Parameters<typeof finishVerdict>[0], string, string | null][] = [
      [{ status: 'done', gate: gate('pass', 'CHECKS PASSED (3/3, 4s)') }, 'passed', null],
      [{ status: 'done', gate: gate('no-change', 'no code changes, checks not run') }, 'no-change', 'no code changes, checks not run'],
      [{ status: 'done', result: 'Did it.' }, 'unverified', null],
      [{ status: 'rejected', gate: gate('fail', 'CHECKS FAILED: `npm run test:go:db` timed out after 10 min (checkTimeoutMin)') }, 'rejected', 'CHECKS FAILED: `npm run test:go:db` timed out after 10 min (checkTimeoutMin)'],
      [{ status: 'failed', result: 'timed out after 60 min (jobTimeoutHardMin): extended once\nWIP committed' }, 'timeout', 'timed out after 60 min (jobTimeoutHardMin): extended once'],
      [{ status: 'failed', result: 'ended after 61m waiting for approval or input (twice blockedTimeoutMin 30)' }, 'timeout', 'ended after 61m waiting for approval or input (twice blockedTimeoutMin 30)'],
      [{ status: 'failed', result: 'killed' }, 'stopped', 'killed'],
      [{ status: 'failed', result: 'claude --bg did not start: not logged in' }, 'failed', 'claude --bg did not start: not logged in'],
    ]
    for (const [job, verdict, why] of cases) expect(finishVerdict(job)).toEqual({ verdict: verdict as never, why })
  })
  test('a killed, stopped or aborted ending is a stop: from the ending passed in, else read off the result (regression)', () => {
    expect(bgEnding('killed')).toBe('stopped')
    expect(bgEnding('stopped')).toBe('stopped')
    expect(bgEnding('error')).toBeUndefined()
    expect(turnEnding('aborted')).toBe('stopped')
    expect(turnEnding('error')).toBeUndefined()
    expect(finishVerdict({ status: 'failed', result: 'any text' }, 'stopped')).toEqual({ verdict: 'stopped', why: 'any text' })
    expect(finishVerdict({ status: 'failed', result: 'background session 5ac0f0df ended: killed' }).verdict).toBe('stopped')
    expect(finishVerdict({ status: 'failed', result: 'worker ended: aborted' }).verdict).toBe('stopped')
    expect(finishVerdict({ status: 'failed', result: 'worker ended: error' }).verdict).toBe('failed')
  })
})

test('a record stays well under OUTCOME_LINE_MAX however long its reason, why or error', () => {
  const long = 'x'.repeat(60_000)
  const spawn = spawnRecord({ job: 'j', at: 0, cwd: '/r', repo: 'r', branch: null, base: null, mode: 'bg', deliverable: 'commit', model: 'm', effort: 'low', chooser: 'manager', routerPick: null, reason: long, task: long })
  const finish = finishRecord({ id: 'j', kind: 'worker', title: 't', cwd: '/r', status: 'failed', startedAt: 0, tail: '', result: long } as never, 0, null)
  const review = reviewRecord({ job: 'j', at: 0, branch: null, round: null, model: 'm', text: '', error: long })
  for (const line of [spawn, finish, review]) expect(line.length).toBeLessThan(OUTCOME_LINE_MAX / 4)
})

test('a review counts its [P1]/[P2]/[P3] markers; clean only with none, and a failed one is never clean', () => {
  expect(countFindings('[P1] a\n[P2] b\n[P2] c\nP3 is not a marker')).toEqual({ p1: 1, p2: 2, p3: 0 })
  const at = Date.UTC(2026, 10, 16)
  const one = (text: string, error?: string) => JSON.parse(reviewRecord({ job: 'j1', at, branch: 'feat/x', round: 1, model: 'gpt-6.1-sol', text, ...(error ? { error } : {}) }))
  expect(one('No findings.')).toEqual({ kind: 'review', job: 'j1', at: '2026-11-16T00:00:00.000Z', branch: 'feat/x', round: 1, model: 'gpt-6.1-sol', findings: { p1: 0, p2: 0, p3: 0 }, clean: true })
  expect(one('[P3] nit').clean).toBe(false)
  expect(one('', 'workspace is out of credits\nmore')).toMatchObject({ clean: false, error: 'workspace is out of credits' })
})

test('tokens count each assistant message once, at its largest usage', () => {
  const line = (id: string, out: number, cache: number) => JSON.stringify({ type: 'assistant', message: { id, usage: { output_tokens: out, cache_read_input_tokens: cache } } })
  expect(transcriptTokens([line('m1', 5, 100), line('m1', 40, 100), line('m2', 10, 300), '{"type":"user"}', 'torn {'].join('\n'))).toEqual({ outputTokens: 50, cacheReadTokens: 400 })
  expect(transcriptTokens('{"type":"user"}')).toBeUndefined()
})

test('the spawn record keeps the first 160 characters of the task', () => {
  const r = JSON.parse(spawnRecord({ job: 'j', at: 0, cwd: '/r', repo: 'r', branch: null, base: null, mode: 'bg', deliverable: 'commit', model: 'm', effort: 'low', chooser: 'router', routerPick: null, reason: null, task: 'x'.repeat(200) }))
  expect(r.task).toHaveLength(160)
  expect(r.taskChars).toBe(200) // the full brief's length: does a longer brief push the router to opus?
  expect(r.kind).toBe('spawn')
})

describe('the Sonnet trial', () => {
  const now = Date.UTC(2026, 10, 30, 23, 0)
  test('through its last day, a routed opus commit worker runs on sonnet/high; report workers, other tiers and a later day are left alone', () => {
    const until = trialUntil(undefined)
    expect(until).toBe('2026-11-30')
    expect(trialSwap({ model: 'opus', effort: 'medium' }, undefined, until, now)).toEqual({
      model: 'sonnet',
      effort: 'high',
      line: 'Sonnet trial until 2026-11-30: router picked opus/medium, running sonnet/high.',
    })
    expect(trialSwap({ model: 'opus', effort: 'high' }, 'report', until, now)).toBeUndefined()
    expect(trialSwap({ model: 'sonnet', effort: 'low' }, 'commit', until, now)).toBeUndefined()
    expect(trialSwap({ model: 'opus', effort: 'high' }, 'commit', until, now + 3_600_000)).toBeUndefined()
  })
  test('empty, off or not a date disables it', () => {
    for (const v of ['', 'off', 'OFF', 'soon']) expect(trialUntil(v)).toBeUndefined()
  })
})
