import type { CodexTier, ReviewTarget } from './codex'

// The Codex review policy's pure half: the ledger of review rounds per branch,
// and what an agent's codex_review call may start. The hooks that run it are in jobs.tsx.

/** One review of a branch: HEAD when it started, what it reviewed against, and its final text once done. */
export type ReviewRound = {
  sha: string
  base: string
  model: string
  jobId: string
  at: number
  findings?: string
  isPerson?: boolean // the person's own /codex-review
  isCovering?: boolean // reviewed the whole branch through `sha`: only such a round can be the next re-review's baseline
}
/** Branch key (git common dir + branch) → its rounds, oldest first. */
export type RoundLedger = Record<string, ReviewRound[]>

export const ROUND_TTL_MS = 14 * 86_400_000
export const FINDINGS_MAX = 4096

/** One key per branch of a repo, the same from its main checkout and from every worktree. */
export function branchKey(commonDir: string, branch: string): string {
  return `${commonDir.trim().replace(/\/+$/, '')}#${branch.trim() || 'HEAD'}`
}

function isRound(r: unknown): r is ReviewRound {
  const o = r as Partial<ReviewRound> | null
  return typeof o?.sha === 'string' && typeof o.jobId === 'string' && typeof o.at === 'number'
}

/** The stored ledger, read defensively, without rounds older than ROUND_TTL_MS or branches left empty. */
export function parseLedger(raw: unknown, now: number): RoundLedger {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: RoundLedger = {}
  for (const [key, rounds] of Object.entries(raw)) {
    const kept = Array.isArray(rounds) ? rounds.filter(isRound).filter(r => now - r.at < ROUND_TTL_MS) : []
    if (kept.length > 0) out[key] = kept
  }
  return out
}

/** The ledger with a job's round settled: its findings kept (truncated), or the round dropped when the job failed. */
export function settledLedger(ledger: RoundLedger, jobId: string, findings: string | undefined): RoundLedger {
  const out: RoundLedger = {}
  for (const [key, rounds] of Object.entries(ledger)) {
    const kept = rounds.flatMap(r => {
      if (r.jobId !== jobId) return [r]
      if (findings === undefined) return []
      const text = findings.length > FINDINGS_MAX ? `${findings.slice(0, FINDINGS_MAX)}\n…(truncated)` : findings
      return [{ ...r, findings: text }]
    })
    if (kept.length > 0) out[key] = kept
  }
  return out
}

/** A settlement that could not take the ledger lock: kept under its own store key, applied by the next ledger access. */
export type PendingSettle = { jobId: string; findings?: string; at: number }
export const SETTLE_PREFIX = 'codexSettle:'

export function parsePending(raw: unknown): PendingSettle | undefined {
  const o = raw as { jobId?: unknown; findings?: unknown; at?: unknown } | null
  if (typeof o?.jobId !== 'string' || typeof o.at !== 'number') return undefined
  return { jobId: o.jobId, at: o.at, ...(typeof o.findings === 'string' ? { findings: o.findings } : {}) }
}

/** The ledger with every pending settlement applied, oldest first. */
export function settledAll(ledger: RoundLedger, pending: readonly PendingSettle[]): RoundLedger {
  return [...pending].sort((a, b) => a.at - b.at).reduce((l, p) => settledLedger(l, p.jobId, p.findings), ledger)
}

/** Changed lines (insertions + deletions) from `git diff --shortstat`; 0 for no change. */
export function shortstatLines(text: string): number {
  const n = (word: string) => Number(text.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0)
  return n('insertion') + n('deletion')
}

/** Past this many untracked files (or lines) a re-review's size is not measured: it is taken as too large. */
export const UNTRACKED_MAX_FILES = 100
export const UNTRACKED_MAX_LINES = 100_000

/** Lines of an untracked file as `git diff` would count them added; Infinity for binary content (NUL), which cannot be measured. */
export function textLines(content: string): number {
  if (content.includes('\0')) return Number.POSITIVE_INFINITY
  return (content.match(/\n/g)?.length ?? 0) + (content !== '' && !content.endsWith('\n') ? 1 : 0)
}

/** The trailing window the full-review cap counts in. */
export const FULL_WINDOW_MS = 5 * 3_600_000

/** One full-model review: when it was booked and its job (a failed or interrupted job gives its slot back). */
export type FullReview = { at: number; jobId: string }

/** The stored full reviews, read defensively, without those past the window. */
export function parseFullReviews(raw: unknown, now: number): FullReview[] {
  if (!Array.isArray(raw)) return []
  const ok = (r: unknown): r is FullReview => typeof (r as FullReview | null)?.at === 'number' && typeof (r as FullReview).jobId === 'string'
  return raw.filter(ok).filter(r => now - r.at < FULL_WINDOW_MS)
}

/** The full reviews without those of dropped jobs (settlements with no findings). */
export function settledFulls(fulls: readonly FullReview[], settlements: readonly { jobId: string; findings?: string }[]): FullReview[] {
  const dropped = new Set(settlements.filter(s => s.findings === undefined).map(s => s.jobId))
  return fulls.filter(r => !dropped.has(r.jobId))
}

/** Whether a round on this tier is a full review for the cap: any model but the re-review model. */
export function isFullTier(tier: CodexTier, policy: Pick<RoundPolicy, 'rereview'>): boolean {
  return tier.model !== policy.rereview.model
}

/** When the next full-review slot frees (ms): the (count - cap + 1)th oldest in the window expires. Undefined with a free slot. */
export function nextFullSlot(fulls: readonly FullReview[], now: number, cap: number): number | undefined {
  const times = fulls.filter(r => now - r.at < FULL_WINDOW_MS).map(r => r.at).sort((a, b) => a - b)
  return cap > 0 && times.length >= cap ? times[times.length - cap]! + FULL_WINDOW_MS : undefined
}

/** The refusal of a full review at the cap, or undefined when a slot is free (or there is no cap). */
export function fullReviewRefusal(fulls: readonly FullReview[], now: number, cap: number, rereviewModel: string): string | undefined {
  const free = nextFullSlot(fulls, now, cap)
  if (free === undefined) return undefined
  const ran = fulls.filter(r => now - r.at < FULL_WINDOW_MS).length
  return (
    `Codex full-review cap reached: ${ran} full reviews ran in the last 5 h (codexFullReviewsPer5h ${cap}); ` +
    `the next slot frees at ${new Date(free).toISOString()}. No review started. ` +
    `A full review (round 1, a rebase, a large diff or full: true) has to wait for that slot; ` +
    `a re-review of new commits (no target, no full) still runs on ${rereviewModel}. Otherwise ask the person.`
  )
}

/** Codex's usage / rate-limit failure wording, matched case-insensitively. */
const USAGE_LIMIT = /usage limit|rate limit|hit your limit/i
export function isUsageLimit(text: string): boolean {
  return USAGE_LIMIT.test(text)
}

/** What a manager does when Codex cannot review: the ChatGPT plan's usage or rate limit is hit. */
export const CODEX_OUT_FALLBACK_TEXT =
  'Codex is out of usage (the ChatGPT plan\'s usage or rate limit was hit). Fallback: run an Opus review via a subagent instead. ' +
  'It is a same-model-family review with lower trust: Claude also wrote this code and may confirm its own bias, ' +
  'so verify each finding yourself, and do not count a clean Opus review as evidence the branch is correct. ' +
  'Say "reviewed by Opus (Codex out of usage), not independent" in the PR description.'

export type RoundPolicy = {
  maxRounds: number
  maxLines: number
  review: CodexTier
  rereview: CodexTier
  maxFullReviews?: number // codexFullReviewsPer5h: full reviews allowed in any FULL_WINDOW_MS; 0 or unset: no cap
}

/** What the call knows: the branch's rounds, the tree now, the caller's choices, and git's view of the last reviewed sha. */
export type RoundFacts = {
  rounds: readonly ReviewRound[]
  head: string
  isDirty: boolean
  isPerson: boolean
  target?: ReviewTarget // the caller's own target
  isFull: boolean // full: true, or a deep review
  instructions?: string
  sinceLast?: { isAncestor: boolean; changedLines: number }
  now?: number // with `fullReviews`: the full-review window is counted at this time
  fullReviews?: readonly FullReview[] // every session's and branch's full reviews; unset: not counted
}

/**
 * A round to start. `target` undefined: the default target (uncommitted, else vs main/master).
 * `note` says why a later round is a full review.
 */
export type RoundPlan =
  | { isAllowed: false; reason: string }
  | { isAllowed: true; round: number; isRereview: boolean; tier: CodexTier; target?: ReviewTarget; instructions?: string; note?: string }

/** Whether a target reviews the whole branch up to HEAD: a diff against a branch, not a commit, a bare sha or the working tree. */
export function coversBranch(target: ReviewTarget): boolean {
  const [flag, value = ''] = target.args
  return flag === '--base' && !/^[0-9a-f]{7,40}$/i.test(value) && !/[~^@]/.test(value)
}

/** Whether the round `plan` starts covers the branch through HEAD: a re-review does (its baseline was valid), else its target decides. */
export function planCovers(plan: { isRereview: boolean; target?: ReviewTarget }, fallback: ReviewTarget): boolean {
  return plan.isRereview || coversBranch(plan.target ?? fallback)
}

const short = (sha: string) => sha.slice(0, 7)

/**
 * The review policy for one codex_review call. The person's /codex-review is never refused and
 * runs as asked; it is still a round. For an agent:
 * - nothing new since the last round (same HEAD, clean tree) → refused;
 * - maxRounds rounds already → refused: the manager stops and asks the person;
 * - round 1, `full` / deep, a rebase past the last sha, or more than maxLines changed since
 *   it → a full review on the review model;
 * - a later round with an explicit target → that target as given, on the re-review model;
 * - any full review at maxFullReviews in the trailing 5 h → refused, for the person too (a re-review still runs);
 * - otherwise a re-review of the changes since the last sha on the re-review model, checking
 *   the previous round's findings.
 */
export function planReviewRound(facts: RoundFacts, policy: RoundPolicy): RoundPlan {
  const { rounds, head, isDirty } = facts
  const round = rounds.length + 1
  const last = rounds.at(-1)
  const full = (note?: string): RoundPlan => {
    // The cap holds for the person too, and for a forced full re-review; it never downgrades a full round to the re-review model.
    const cap = policy.maxFullReviews ?? 0
    if (cap > 0 && facts.fullReviews !== undefined && facts.now !== undefined && isFullTier(policy.review, policy)) {
      const reason = fullReviewRefusal(facts.fullReviews, facts.now, cap, policy.rereview.model)
      if (reason !== undefined) return { isAllowed: false, reason }
    }
    return { isAllowed: true, round, isRereview: false, tier: policy.review, target: facts.target, instructions: facts.instructions, note }
  }
  if (facts.isPerson || last === undefined) return full()
  if (last.sha === head && !isDirty && last.isCovering === true) {
    return { isAllowed: false, reason: `Nothing new since round ${rounds.length} (${short(head)}, clean tree): no review started.` }
  }
  if (rounds.length >= policy.maxRounds) {
    return {
      isAllowed: false,
      reason:
        `Codex review cap reached: ${rounds.length} rounds on this branch (codexMaxRounds ${policy.maxRounds}). ` +
        'Stop re-reviewing: summarise the remaining findings for the person and ask them. ' +
        'Only they can run more, with /codex-review --force (or plain /codex-review).',
    }
  }
  if (facts.isFull) return full(facts.target === undefined ? `full review as asked (round ${round})` : undefined)
  // An explicit target is not a way round the cheaper model: only full / deep earn the review model.
  if (facts.target !== undefined) {
    return { isAllowed: true, round, isRereview: false, tier: policy.rereview, target: facts.target, instructions: facts.instructions }
  }
  if (last.isCovering !== true) {
    return full(`full review: round ${rounds.length} (${short(last.sha)}) did not review the whole branch, so it cannot be a baseline`)
  }
  const since = facts.sinceLast
  if (since === undefined) return full(`full review: the changes since ${short(last.sha)} could not be measured`)
  if (!since.isAncestor) {
    return full(`full review: ${short(last.sha)} is no longer an ancestor of HEAD (rebase or force-push)`)
  }
  if (since.changedLines > policy.maxLines) {
    const size = Number.isFinite(since.changedLines) ? `${since.changedLines} lines changed` : 'the diff could not be measured'
    return full(`full review: ${size} since ${short(last.sha)} (codexRereviewMaxLines ${policy.maxLines})`)
  }
  return {
    isAllowed: true,
    round,
    isRereview: true,
    tier: policy.rereview,
    target: { args: ['--base', last.sha], label: `vs ${short(last.sha)}` },
    instructions: rereviewInstructions(rounds.length, last, facts.instructions),
  }
}

/** A re-review's focus: the previous round's findings to check, then the caller's own. */
export function rereviewInstructions(lastRound: number, last: ReviewRound, extra: string | undefined): string {
  const findings = last.findings?.trim() || '(its findings were not recorded)'
  return [
    `This is a re-review. Round ${lastRound} reviewed commit ${last.sha} and reported:`,
    '<previous-findings>',
    findings,
    '</previous-findings>',
    '1. For each finding above, check whether the changes since then fix it; list each as fixed or still open.',
    '2. Look for new problems the fix commits introduced.',
    'Report only problems in, or caused by, the changes since that commit.',
    ...(extra ? ['', extra] : []),
  ].join('\n')
}

/** "2/3"; past the cap (only the person's rounds go there) just "4". */
export function roundOf(round: number, max: number): string {
  return round <= max ? `${round}/${max}` : `${round}`
}

/** The job title: "codex re-review 2/3 vs a1b2c3d (luna)". */
export function roundTitle(plan: { round: number; isRereview: boolean; tier: CodexTier }, max: number, label: string): string {
  const model = plan.tier.model.replace(/^gpt-[\d.]+-/, '')
  return `codex ${plan.isRereview ? 're-review' : 'review'} ${roundOf(plan.round, max)} ${label} (${model})`
}
