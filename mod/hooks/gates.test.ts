import { describe, expect, test } from 'claude-code/testing'

import { gateReport, gitVerdict, parseChecks, tailOf } from './gates'
import type { CheckRun } from './gates'

const GIT = { isDirty: false, headBranch: 'office/j1-fix', branch: 'office/j1-fix', commits: 1, deliverable: 'commit' as const }
const OPTS = { mode: 'enforce' as const, budgetSec: 120, timeoutMin: 10, base: 'abc1234def', git: { verdict: 'ok' as const, reason: '' } }
const run = (cmd: string, exitCode: number, ms = 1000, more: Partial<CheckRun> = {}): CheckRun => ({ cmd, exitCode, isTimedOut: false, ms, output: '', ...more })

describe('parseChecks', () => {
  test('one command per line; blank lines and # comments skipped', () => {
    expect(parseChecks('# gate\nnpm test\n\n  # more\n  cd mod && tsc  \n')).toEqual(['npm test', 'cd mod && tsc'])
  })
})

describe('tailOf', () => {
  test('the last lines, capped in length', () => {
    const out = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    expect(tailOf(out, 3)).toBe('line 47\nline 48\nline 49')
    expect(tailOf('x'.repeat(5000), 40, 100)).toBe(`…${'x'.repeat(100)}`)
  })
})

describe('gitVerdict', () => {
  test('dirty, off its branch, or no commits for a commit deliverable: fail', () => {
    expect(gitVerdict({ ...GIT, isDirty: true })).toMatchObject({ verdict: 'fail', reason: 'uncommitted changes in the worktree' })
    expect(gitVerdict({ ...GIT, headBranch: 'main' }).reason).toContain('worker left its branch: HEAD is on main')
    expect(gitVerdict({ ...GIT, headBranch: '' }).reason).toContain('a detached commit')
    expect(gitVerdict({ ...GIT, commits: 0 }).verdict).toBe('fail')
  })

  test('no commits for a report deliverable: no change, not a failure', () => {
    expect(gitVerdict({ ...GIT, commits: 0, deliverable: 'report' })).toEqual({ verdict: 'no-change', reason: 'no code changes, checks not run' })
    // A dirty tree is never fine, report or not.
    expect(gitVerdict({ ...GIT, commits: 0, deliverable: 'report', isDirty: true }).verdict).toBe('fail')
  })
})

describe('gateReport', () => {
  test('every line green: pass; over the budget, it says so', () => {
    const ok = gateReport({ ...OPTS, checks: ['a', 'b'], runs: [run('a', 0, 20_000), run('b', 0, 21_000)] })
    expect(ok).toMatchObject({ verdict: 'pass', isRejected: false, head: 'CHECKS PASSED (2/2, 41s)' })
    const slow = gateReport({ ...OPTS, checks: ['a'], runs: [run('a', 0, 130_000)] })
    expect(slow.head).toBe('CHECKS PASSED (1/1, 130s; over budget)')
    expect(slow.block).toContain('checks took 130s, over the 120 s budget; move slow commands to PR-level checks.')
  })

  test('a red line, red again on its re-run: rejected with the command, exit code and output tail', () => {
    const red = run('npm test', 1, 1000, { output: 'ok 1\nnot ok 2 login\n', rerun: { exitCode: 1, isTimedOut: false, ms: 1000, output: 'not ok 2 login again\n' } })
    const r = gateReport({ ...OPTS, checks: ['tsc', 'npm test', 'lint'], runs: [run('tsc', 0), red] })
    expect(r).toMatchObject({ verdict: 'fail', isRejected: true, head: 'CHECKS FAILED: `npm test` exit 1' })
    expect(r.block).toContain('$ npm test\nexit 1 after 1s (and again on its re-run)\nnot ok 2 login again')
  })

  test('red then green on its re-run: a flaky pass', () => {
    const flaky = run('npm test', 1, 1000, { rerun: { exitCode: 0, isTimedOut: false, ms: 1000, output: '' } })
    const r = gateReport({ ...OPTS, checks: ['npm test'], runs: [flaky] })
    expect(r.verdict).toBe('pass')
    expect(r.block).toContain('flaky: `npm test` failed once (exit 1), passed on its re-run.')
  })

  test('report mode: red is shown, never rejected; no checks file: unverified', () => {
    const r = gateReport({ ...OPTS, mode: 'report', checks: ['npm test'], runs: [run('npm test', 2)] })
    expect(r).toMatchObject({ verdict: 'fail', isRejected: false, head: 'CHECKS FAILED: `npm test` exit 2 (not enforced: workerChecks report)' })
    expect(gateReport({ ...OPTS, runs: [] })).toMatchObject({ verdict: 'unverified', isRejected: false, head: 'UNVERIFIED: no .office/checks in the base commit abc1234' })
  })
})
