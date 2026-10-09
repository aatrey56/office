import { describe, expect, test } from 'claude-code/testing'

import { CODEX_DEFAULTS } from './codex'
import {
  CODEX_OUT_FALLBACK_TEXT, coversBranch, FINDINGS_MAX, FULL_WINDOW_MS, isUsageLimit, nextFullSlot, parseFullReviews, parseLedger,
  planCovers, planReviewRound, ROUND_TTL_MS, roundTitle, settledFulls, settledLedger, shortstatLines, textLines,
} from './codex-rounds'
import type { ReviewRound, RoundFacts } from './codex-rounds'

const A = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const B = 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3'
const policy = { maxRounds: 3, maxLines: 400, review: CODEX_DEFAULTS.review, rereview: CODEX_DEFAULTS.rereview }
const round = (sha: string, findings?: string): ReviewRound => ({ sha, base: 'main', model: 'gpt-6.1-sol', jobId: `j-${sha}`, at: 0, findings, isCovering: true })
const facts = (over: Partial<RoundFacts> = {}): RoundFacts => ({
  rounds: [round(A, '[P1] x.ts:3 off by one')],
  head: B,
  isDirty: false,
  isPerson: false,
  isFull: false,
  sinceLast: { isAncestor: true, changedLines: 40 },
  ...over,
})

describe('codex review rounds', () => {
  test('round 1 is a full review on the review model, at the default target', () => {
    expect(planReviewRound(facts({ rounds: [], sinceLast: undefined }), policy)).toEqual({
      isAllowed: true, round: 1, isRereview: false, tier: CODEX_DEFAULTS.review, target: undefined, instructions: undefined, note: undefined,
    })
  })

  test('a later round re-reviews the changes since the last sha on the re-review model, checking its findings', () => {
    const plan = planReviewRound(facts({ instructions: 'focus on auth' }), policy)
    expect(plan).toMatchObject({ isAllowed: true, round: 2, isRereview: true, tier: CODEX_DEFAULTS.rereview, target: { args: ['--base', A] } })
    const text = (plan as { instructions: string }).instructions
    expect(text).toContain('[P1] x.ts:3 off by one')
    expect(text).toContain('fixed or still open')
    expect(text).toContain('focus on auth')
    expect(roundTitle(plan as { round: number; isRereview: boolean; tier: typeof CODEX_DEFAULTS.rereview }, 3, 'vs a1b2c3d')).toBe(
      'codex re-review 2/3 vs a1b2c3d (luna)',
    )
  })

  test('a rebase, a large diff, full: true or an explicit target make it a full review, still a round', () => {
    const fullOn = (over: Partial<RoundFacts>) => planReviewRound(facts(over), policy) as { round: number; isRereview: boolean; tier: unknown; note?: string }
    expect(fullOn({ sinceLast: { isAncestor: false, changedLines: 0 } })).toMatchObject({ round: 2, isRereview: false, tier: CODEX_DEFAULTS.review })
    expect(fullOn({ sinceLast: { isAncestor: false, changedLines: 0 } }).note).toContain('no longer an ancestor')
    expect(fullOn({ sinceLast: { isAncestor: true, changedLines: 401 } }).note).toContain('401 lines changed')
    expect(fullOn({ isFull: true })).toMatchObject({ isRereview: false, tier: CODEX_DEFAULTS.review })
    expect(fullOn({ isFull: true, target: { args: ['--uncommitted'], label: 'uncommitted changes' } })).toMatchObject({ isRereview: false, tier: CODEX_DEFAULTS.review })
    expect(shortstatLines(' 3 files changed, 250 insertions(+), 151 deletions(-)')).toBe(401)
  })

  test('a later round with an explicit target runs that target on the re-review model unless full', () => {
    const target = { args: ['--commit', B], label: `commit ${B}` }
    expect(planReviewRound(facts({ target }), policy)).toMatchObject({ isAllowed: true, round: 2, isRereview: false, tier: CODEX_DEFAULTS.rereview, target })
    expect(planReviewRound(facts({ target, isFull: true }), policy)).toMatchObject({ tier: CODEX_DEFAULTS.review, target })
    expect(planReviewRound(facts({ rounds: [], target }), policy)).toMatchObject({ round: 1, tier: CODEX_DEFAULTS.review })
  })

  test('only a round that covered the whole branch is a baseline; otherwise the next round is a full review (coverage)', () => {
    const commit = { args: ['--commit', A], label: `commit ${A}` }
    const uncommitted = { args: ['--uncommitted'], label: 'uncommitted changes' }
    const vsMain = { args: ['--base', 'main'], label: 'vs main' }
    expect(coversBranch(vsMain)).toBe(true)
    expect([commit, uncommitted, { args: ['--base', A.slice(0, 9)], label: '' }, { args: ['--base', 'HEAD~2'], label: '' }].map(coversBranch)).toEqual([false, false, false, false])
    expect(planCovers({ isRereview: true, target: { args: ['--base', A], label: '' } }, vsMain)).toBe(true)
    expect(planCovers({ isRereview: false }, uncommitted)).toBe(false) // the default target of a dirty tree
    expect(planCovers({ isRereview: false }, vsMain)).toBe(true)
    // A --commit round at HEAD left the rest unreviewed: not a no-op, not a baseline.
    const partial = [{ ...round(A, '[P2] y'), isCovering: false }]
    expect(planReviewRound(facts({ rounds: partial, head: A }), policy)).toMatchObject({ isAllowed: true, isRereview: false, tier: CODEX_DEFAULTS.review })
    const plan = planReviewRound(facts({ rounds: partial }), policy) as { isRereview: boolean; note: string }
    expect(plan.isRereview).toBe(false)
    expect(plan.note).toContain('did not review the whole branch')
  })

  test('untracked files count as changed lines; binary ones cannot be measured', () => {
    expect([textLines(''), textLines('a\nb\n'), textLines('a\nb')]).toEqual([0, 2, 2])
    expect(textLines('PNG\0\x01')).toBe(Number.POSITIVE_INFINITY)
    expect((planReviewRound(facts({ sinceLast: { isAncestor: true, changedLines: Number.POSITIVE_INFINITY } }), policy) as { note: string }).note).toContain('could not be measured')
  })

  test('at codexMaxRounds an agent is refused and told to ask the person; the person is not', () => {
    const three = [round(A), round(B), round('c'.repeat(40))]
    const refused = planReviewRound(facts({ rounds: three }), policy)
    expect(refused.isAllowed).toBe(false)
    expect((refused as { reason: string }).reason).toContain('summarise the remaining findings for the person')
    expect((refused as { reason: string }).reason).toContain('/codex-review --force')
    expect(planReviewRound(facts({ rounds: three, isPerson: true }), policy)).toMatchObject({ isAllowed: true, round: 4, tier: CODEX_DEFAULTS.review })
  })

  test('nothing new since the last round (same HEAD, clean tree) is refused; uncommitted changes are new', () => {
    const refused = planReviewRound(facts({ head: A }), policy)
    expect((refused as { reason: string }).reason).toContain('Nothing new since round 1')
    expect(planReviewRound(facts({ head: A, isDirty: true }), policy)).toMatchObject({ isAllowed: true, isRereview: true })
  })

  test('the ledger drops rounds past 14 days and failed rounds, and truncates kept findings', () => {
    const now = ROUND_TTL_MS + 10
    const ledger = parseLedger({ k: [{ ...round(A), at: 5 }, { ...round(B), at: 20 }], old: [{ ...round(A), at: 0 }], junk: 'x' }, now)
    expect(Object.keys(ledger)).toEqual(['k'])
    expect(ledger.k!.map(r => r.sha)).toEqual([B])
    const kept = settledLedger(ledger, `j-${B}`, 'x'.repeat(FINDINGS_MAX + 100))
    expect(kept.k![0]!.findings!.length).toBeLessThan(FINDINGS_MAX + 20)
    expect(settledLedger(ledger, `j-${B}`, undefined)).toEqual({})
  })

  const H = 3_600_000
  const full = (jobId: string, at: number) => ({ jobId, at })
  const tenIn5h = (now: number) => Array.from({ length: 10 }, (_, i) => full(`f${i}`, now - (4.5 - i * 0.4) * H)) // oldest 4.5 h ago

  test('the full-review window counts the trailing 5 h only, prunes older ones, and gives a dropped job its slot back', () => {
    const now = 100 * H
    const stored = [full('old', now - FULL_WINDOW_MS), full('in', now - FULL_WINDOW_MS + 1), { jobId: 1 }, 'junk']
    expect(parseFullReviews(stored, now).map(r => r.jobId)).toEqual(['in'])
    expect(parseFullReviews(undefined, now)).toEqual([])
    const fulls = [full('a', now), full('b', now)]
    expect(settledFulls(fulls, [{ jobId: 'a' }, { jobId: 'b', findings: 'kept' }]).map(r => r.jobId)).toEqual(['b'])
  })

  test('the next slot frees when the oldest full review leaves the window (the cap-th newest, past the cap)', () => {
    const now = 100 * H
    const fulls = tenIn5h(now)
    expect(nextFullSlot(fulls.slice(1), now, 10)).toBeUndefined() // 9 of 10
    expect(nextFullSlot(fulls, now, 0)).toBeUndefined() // no cap
    expect(nextFullSlot(fulls, now, 10)).toBe(now - 4.5 * H + FULL_WINDOW_MS)
    expect(nextFullSlot(fulls, now, 8)).toBe(fulls[2]!.at + FULL_WINDOW_MS) // 10 in the window, cap 8: two must leave
  })

  test('at the full-review cap a full round is refused (agent, person, forced full) but a re-review runs on the re-review model', () => {
    const now = 100 * H
    const capped = { ...policy, maxFullReviews: 10 }
    const at = (over: Partial<RoundFacts>) => planReviewRound(facts({ now, fullReviews: tenIn5h(now), ...over }), capped)
    const iso = new Date(now - 4.5 * H + FULL_WINDOW_MS).toISOString()
    for (const refused of [
      at({ rounds: [], sinceLast: undefined }), // round 1: not downgraded to Luna
      at({ isPerson: true }),
      at({ isFull: true }),
      at({ sinceLast: { isAncestor: false, changedLines: 0 } }), // rebase
      at({ sinceLast: { isAncestor: true, changedLines: 401 } }), // size
    ]) {
      expect(refused.isAllowed).toBe(false)
      expect((refused as { reason: string }).reason).toContain(`10 full reviews ran in the last 5 h`)
      expect((refused as { reason: string }).reason).toContain(`next slot frees at ${iso}`)
    }
    expect(at({})).toMatchObject({ isAllowed: true, isRereview: true, tier: CODEX_DEFAULTS.rereview })
    expect(at({ target: { args: ['--commit', B], label: 'c' } })).toMatchObject({ isAllowed: true, tier: CODEX_DEFAULTS.rereview })
    // 9 in the window, or no cap: a full round runs
    expect(planReviewRound(facts({ now, fullReviews: tenIn5h(now).slice(1), isFull: true }), capped).isAllowed).toBe(true)
    expect(planReviewRound(facts({ now, fullReviews: tenIn5h(now), isFull: true }), { ...policy, maxFullReviews: 0 }).isAllowed).toBe(true)
  })

  test('a Codex usage / rate limit failure is matched case-insensitively; other failures are not', () => {
    for (const text of ["You've hit your usage limit. Try again at 3:11 AM.", 'Rate Limit exceeded', 'ERROR: you HIT YOUR LIMIT']) {
      expect(isUsageLimit(text)).toBe(true)
    }
    for (const text of ['Not logged in', 'stream error: 429 Too Many Requests', 'model not supported', '']) expect(isUsageLimit(text)).toBe(false)
    expect(CODEX_OUT_FALLBACK_TEXT).toContain('reviewed by Opus (Codex out of usage), not independent')
  })
})
