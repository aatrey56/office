import { describe, expect, test } from 'claude-code/testing'

import {
  CODEX_DEEP_MAX_LINES, CODEX_USAGE_STALE_MS, codexDeepSizeVerdict, codexGuardVerdict, codexLimitsFrom, codexResetAt,
  codexUsageLine, parseCodexReviewArgs,
} from './codex-budget'
import type { CodexLimits } from './codex-budget'
import { codexQuotaMessage } from './codex'

// Local times, as codex prints them.
const now = new Date(2026, 9, 6, 1, 0).getTime()
const at311 = new Date(2026, 9, 6, 3, 11).getTime()

describe('codex quota hit', () => {
  test('blocks the next job on that model until its reset; --force overrides', () => {
    const until = codexResetAt("You've hit your usage limit. Upgrade to Pro or try again at 3:11 AM.", now)
    expect(until).toBe(at311)
    const state = { out: { 'gpt-6.1-sol': { until: until!, note: 'usage limit' } } }

    const refused = codexGuardVerdict('gpt-6.1-sol', now, state, false)
    expect(refused.isAllowed).toBe(false)
    const reason = (refused as { reason: string }).reason
    expect(reason).toContain('Codex gpt-6.1-sol is out until 3:11')
    expect(reason).toContain('--model')

    expect(codexGuardVerdict('gpt-6-luna', now, state, false)).toEqual({ isAllowed: true })
    expect(codexGuardVerdict('gpt-6.1-sol', now, state, true)).toMatchObject({ isAllowed: true })
    expect(codexGuardVerdict('gpt-6.1-sol', at311, state, false)).toEqual({ isAllowed: true })
  })

  test('reset times: dated, tomorrow, and a span', () => {
    expect(codexResetAt('Try again at Oct 7th, 2026 3:11 AM.', now)).toBe(new Date(2026, 9, 7, 3, 11).getTime())
    expect(codexResetAt('Try again at 12:30 AM.', now)).toBe(new Date(2026, 9, 7, 0, 30).getTime())
    expect(codexResetAt("You've hit your usage limit for GPT-6-Sol. Try again in 3 days.", now)).toBe(now + 3 * 86_400_000)
  })

  test('/codex-review flags: --force and --model are the person\'s, the rest is the target', () => {
    expect(parseCodexReviewArgs('--force --model gpt-6-luna --deep main')).toEqual({
      deep: true, force: true, model: 'gpt-6-luna', rest: 'main',
    })
  })
})

describe('codex rate-limit percentages', () => {
  // A trimmed `account/rateLimits/read` answer from codex 0.160's app-server.
  const answer = (primary: number, secondary: number) =>
    JSON.stringify({
      id: 2,
      result: {
        rateLimits: {},
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            normalModelSlug: null,
            primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: Math.floor(at311 / 1000) },
            secondary: { usedPercent: secondary, windowDurationMins: 10080, resetsAt: Math.floor(at311 / 1000) + 86_400 },
          },
        },
      },
    })
  const limits = (p: number, s: number): CodexLimits => codexLimitsFrom(`{"id":1,"result":{}}\n${answer(p, s)}\n`, now)!

  test('refused at 95% of a window, warned from 80%, --force overrides', () => {
    expect(limits(15, 17).buckets[0]!.windows.map(w => w.kind)).toEqual(['five_hour', 'seven_day'])
    expect(codexGuardVerdict('gpt-6.1-sol', now, { limits: limits(15, 17), out: {} }, false)).toEqual({ isAllowed: true })

    const warned = codexGuardVerdict('gpt-6.1-sol', now, { limits: limits(20, 82), out: {} }, false)
    expect(warned.isAllowed).toBe(true)
    expect((warned as { warning: string }).warning).toContain('weekly limit is at 82%')

    const refused = codexGuardVerdict('gpt-6-luna', now, { limits: limits(95, 40), out: {} }, false)
    expect(refused.isAllowed).toBe(false)
    expect((refused as { reason: string }).reason).toContain('5-hour limit is at 95%')
    expect(codexGuardVerdict('gpt-6-luna', now, { limits: limits(95, 40), out: {} }, true)).toMatchObject({ isAllowed: true })

    // Past the window's reset, the old reading no longer counts.
    expect(codexGuardVerdict('gpt-6-luna', at311 + 1, { limits: limits(99, 40), out: {} }, false)).toEqual({ isAllowed: true })
  })
})

describe('codex deep size and credits', () => {
  test('a deep review over the size limit is refused with its size; --force overrides', () => {
    expect(codexDeepSizeVerdict(CODEX_DEEP_MAX_LINES, false)).toEqual({ isAllowed: true })
    expect(codexDeepSizeVerdict(undefined, false)).toEqual({ isAllowed: true })
    const refused = codexDeepSizeVerdict(100_000, false)
    expect(refused.isAllowed).toBe(false)
    const reason = (refused as { reason: string }).reason
    expect(reason.startsWith('DEEP REVIEW REFUSED')).toBe(true)
    expect(reason).toContain('100,000 changed lines')
    expect(reason).toContain('/codex-review --deep --force')
    expect(codexDeepSizeVerdict(100_000, true)).toMatchObject({ isAllowed: true, warning: expect.stringContaining('100,000') })
  })

  test('"out of credits" marks the model out, so the guard refuses the next job on it', () => {
    const text = 'workspace is out of credits'
    expect(codexQuotaMessage(text, 'gpt-6-astra')).toBeDefined()
    // codex named no reset time: out for the fallback hour.
    const until = codexResetAt(text, now) ?? now + 60 * 60_000
    const state = { out: { 'gpt-6-astra': { until, note: text } } }
    expect(codexGuardVerdict('gpt-6-astra', now, state, false).isAllowed).toBe(false)
    expect(codexGuardVerdict('gpt-6.1-sol', now, state, false)).toEqual({ isAllowed: true })
  })
})

describe('codexUsageLine', () => {
  test('each window at its most used bucket, nothing once stale', () => {
    const w = (kind: string, percentUsed: number) => ({ kind, percentUsed })
    const limits: CodexLimits = { at: now, buckets: [{ windows: [w('five_hour', 30), w('seven_day', 12)] }, { model: 'gpt-6-astra', windows: [w('five_hour', 61)] }] }
    expect(codexUsageLine(limits, now)).toBe('codex 5h 61% · week 12%')
    expect(codexUsageLine(limits, now + CODEX_USAGE_STALE_MS + 1)).toBe('')
    expect(codexUsageLine(undefined, now)).toBe('')
  })
})
