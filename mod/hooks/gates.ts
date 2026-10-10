import type { Deliverable, GateVerdict } from '../types'

// The gate a worker's branch passes after the worker says it is done, before its result is
// accepted: git first (a clean tree, HEAD on its branch, commits), then the project's checks.
// Pure: jobs.tsx runs git and the checks, these read what came back. The checks are read from
// the base commit, so a worker cannot weaken its own gate. A gate that cannot run says
// UNVERIFIED (fails open); a red check or a dirty tree never passes.

export const CHECKS_FILE = '.office/checks'
/** Set for every check command, so a check can tell it runs in the office gate. */
export const CHECK_ENV = { OFFICE_CHECK: '1' }
/** How much of a check's output is kept while it runs (the delivery shows tailOf it). */
export const OUTPUT_KEEP = 16 * 1024

/** workerChecks: enforce rejects a red result; report shows it and leaves the status; off runs no gate. */
export type ChecksMode = 'enforce' | 'report' | 'off'
export function checksMode(v: unknown): ChecksMode {
  return v === 'report' || v === 'off' ? v : 'enforce'
}

export function isDeliverable(v: unknown): v is Deliverable {
  return v === 'commit' || v === 'report'
}

/** One shell command per line; blank lines and lines starting with '#' are skipped. */
export function parseChecks(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))
}

/** A check line runs with `sh -c`, from the worktree's root. */
export function checkArgv(line: string): string[] {
  return ['sh', '-c', line]
}

/** `git show <base>:.office/checks`: the file as the base commit has it, never the worktree's copy. */
export function checksShowArgv(root: string, base: string): string[] {
  return ['git', '-C', root, 'show', `${base}:${CHECKS_FILE}`]
}

/** The last `lines` lines of `out`, at most `chars` characters of them. */
export function tailOf(out: string, lines = 40, chars = 3072): string {
  let t = out.replace(/\s+$/, '')
  const parts = t.split('\n')
  if (parts.length > lines) t = parts.slice(-lines).join('\n')
  return t.length > chars ? `…${t.slice(-chars)}` : t
}

export type GitFacts = { isDirty: boolean; headBranch: string; branch: string; commits: number; deliverable: Deliverable }
export type GitVerdict = { verdict: 'ok' | 'no-change' | 'fail'; reason: string }

/** The git rules: a clean tree, HEAD still on the job's branch, and commits unless the job is report-only. */
export function gitVerdict(f: GitFacts): GitVerdict {
  if (f.isDirty) return { verdict: 'fail', reason: 'uncommitted changes in the worktree' }
  if (f.headBranch !== f.branch) {
    return { verdict: 'fail', reason: `worker left its branch: HEAD is on ${f.headBranch || 'a detached commit'}, not ${f.branch}` }
  }
  if (f.commits > 0) return { verdict: 'ok', reason: '' }
  if (f.deliverable === 'commit') return { verdict: 'fail', reason: 'no commits on its branch (deliverable: commit)' }
  return { verdict: 'no-change', reason: 'no code changes, checks not run' }
}

/** One run of a check line; `rerun` is its one re-run after a red result (the flake filter). */
export type CheckRun = {
  cmd: string
  exitCode: number | null // null: ended by a signal (or never started)
  isTimedOut: boolean
  ms: number
  output: string
  rerun?: Omit<CheckRun, 'cmd' | 'rerun'>
}

const isGreen = (r: Omit<CheckRun, 'cmd' | 'rerun'>) => r.exitCode === 0 && !r.isTimedOut
/** A red line is re-run once, unless it ran out its time: a second slow run would only double the wait. */
export function shouldRerun(r: CheckRun): boolean {
  return !isGreen(r) && !r.isTimedOut
}
/** Green on its first run or on its re-run. */
export function isPassed(r: CheckRun): boolean {
  return isGreen(r.rerun ?? r)
}

export type GateInput = {
  mode: ChecksMode
  budgetSec: number
  timeoutMin: number
  base?: string
  error?: string // the gate could not run: why
  git?: GitVerdict
  checks?: string[] // undefined: no checks file in the base commit
  runs: CheckRun[]
}
/** isRejected: the job ends `rejected` (only in enforce mode); head: the delivery head's words; block: leads the result. */
export type GateResult = { verdict: GateVerdict; isRejected: boolean; head: string; block: string }

const secs = (ms: number) => `${Math.round(ms / 1000)}s`
function exitText(r: Omit<CheckRun, 'cmd' | 'rerun'>, timeoutMin: number): string {
  if (r.isTimedOut) return `timed out after ${timeoutMin} min (checkTimeoutMin)`
  return r.exitCode === null ? 'ended by a signal' : `exit ${r.exitCode}`
}

/** The verdict, from what git and the checks said. */
export function gateReport(g: GateInput): GateResult {
  const unverified = (why: string, more = ''): GateResult => ({
    verdict: 'unverified',
    isRejected: false,
    head: `UNVERIFIED: ${why}`,
    block: `UNVERIFIED: ${why}. Nothing checked this branch.${more}`,
  })
  if (g.error !== undefined) return unverified(`the gate could not run (${g.error})`)
  if (g.mode === 'off') return unverified('workerChecks is off')
  const red = (reason: string, detail: string): GateResult => {
    if (g.mode === 'report') {
      const head = `${reason} (not enforced: workerChecks report)`
      return { verdict: 'fail', isRejected: false, head, block: `${head}\n${detail}`.trimEnd() }
    }
    return { verdict: 'fail', isRejected: true, head: reason, block: `REJECTED by the office gate: ${reason}\n${detail}`.trimEnd() }
  }
  if (g.git?.verdict === 'fail') return red(g.git.reason, '')
  if (g.git?.verdict === 'no-change') {
    return { verdict: 'no-change', isRejected: false, head: g.git.reason, block: `No commits on its branch: ${g.git.reason}.` }
  }
  const where = g.base !== undefined ? ` in the base commit ${g.base.slice(0, 7)}` : ' in the base commit'
  if (g.checks === undefined) {
    return unverified(`no ${CHECKS_FILE}${where}`, ` Add one (one shell command per line, run from the repo root) to gate workers.`)
  }
  if (g.checks.length === 0) return unverified(`${CHECKS_FILE}${where} lists no commands`)
  const total = g.runs.reduce((ms, r) => ms + r.ms + (r.rerun?.ms ?? 0), 0)
  const failed = g.runs.find(r => !isPassed(r))
  if (failed !== undefined) {
    const last = failed.rerun ?? failed
    const again = failed.rerun !== undefined ? ` (and again on its re-run)` : ''
    const detail = [`$ ${failed.cmd}`, `${exitText(last, g.timeoutMin)} after ${secs(last.ms)}${again}`, tailOf(last.output)]
    return red(`CHECKS FAILED: \`${failed.cmd}\` ${exitText(last, g.timeoutMin)}`, detail.filter(Boolean).join('\n'))
  }
  const n = g.checks.length
  // A kill can stop the loop short: only every line green is a pass.
  if (g.runs.length < n) return unverified(`${n - g.runs.length} of ${n} checks did not run`)
  const flaky = g.runs.filter(r => r.rerun !== undefined)
  const lines = [`CHECKS PASSED: ${n}/${n} commands of ${CHECKS_FILE}${where}, ${secs(total)}.`]
  for (const r of flaky) lines.push(`flaky: \`${r.cmd}\` failed once (${exitText(r, g.timeoutMin)}), passed on its re-run.`)
  if (total > g.budgetSec * 1000) {
    lines.push(`checks took ${secs(total)}, over the ${g.budgetSec} s budget; move slow commands to PR-level checks.`)
  }
  const notes = [flaky.length > 0 ? `${flaky.length} flaky` : '', total > g.budgetSec * 1000 ? 'over budget' : ''].filter(Boolean)
  return {
    verdict: 'pass',
    isRejected: false,
    head: `CHECKS PASSED (${n}/${n}, ${secs(total)}${notes.length > 0 ? `; ${notes.join(', ')}` : ''})`,
    block: lines.join('\n'),
  }
}
