import { describe, expect, test } from 'claude-code/testing'

import { codexGuardVerdict, codexLimitsFrom, codexResetAt, parseCodexReviewArgs } from './codex-budget'
import type { CodexLimits } from './codex-budget'

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
