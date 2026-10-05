import { describe, expect, test } from 'claude-code/testing'

import { budgetVerdict, DEFAULT_CAPS } from './budget'

const none = { isSmall: false, isExplicit: false, isForced: false }
const five = (percentUsed: number, resetsAt?: string) => ({ kind: 'five_hour', percentUsed, resetsAt })
const week = (percentUsed: number, resetsAt?: string) => ({ kind: 'seven_day', percentUsed, resetsAt })

describe('budgetVerdict', () => {
  test('soft zone: a small route starts without a warning', () => {
    expect(budgetVerdict([five(82)], DEFAULT_CAPS, { ...none, isSmall: true })).toEqual({ isAllowed: true, zone: 'soft' })
  })
  test('soft zone: otherwise refused', () => {
    const v = budgetVerdict([week(90, '2026-10-09T00:00:00Z')], DEFAULT_CAPS, none)
    expect(v).toMatchObject({ isAllowed: false, zone: 'soft' })
    const reason = (v as { reason: string }).reason
    expect(reason).toContain('weekly limit')
    expect(reason).toContain('90%')
    expect(reason).toContain('85%')
    expect(reason).toContain('resets 2026-10-09T00:00:00Z')
  })
  test('hard zone: refused, and small or explicit does not help', () => {
    const v = budgetVerdict([five(96)], DEFAULT_CAPS, { isSmall: true, isExplicit: true, isForced: false })
    expect(v).toMatchObject({ isAllowed: false, zone: 'hard' })
    expect((v as { reason: string }).reason).toContain('95%')
  })
  test('hard zone: forced starts with a warning that names the window', () => {
    const v = budgetVerdict([five(97)], DEFAULT_CAPS, { ...none, isForced: true })
    expect(v).toMatchObject({ isAllowed: true, zone: 'hard' })
    const warning = (v as { warning: string }).warning
    expect(warning.startsWith('Forced past the limit:')).toBe(true)
    expect(warning).toContain('5-hour limit')
    expect(warning).toContain('97%')
  })
  test('exactly at a line counts as past it', () => {
    expect(budgetVerdict([five(80)], DEFAULT_CAPS, none)).toMatchObject({ isAllowed: false, zone: 'soft' })
    expect(budgetVerdict([five(79.99)], DEFAULT_CAPS, none)).toMatchObject({ isAllowed: true, zone: 'open' })
    expect(budgetVerdict([week(85)], DEFAULT_CAPS, none)).toMatchObject({ isAllowed: false, zone: 'soft' })
    expect(budgetVerdict([week(84.99)], DEFAULT_CAPS, none)).toMatchObject({ isAllowed: true, zone: 'open' })
    expect(budgetVerdict([five(95)], DEFAULT_CAPS, none)).toMatchObject({ isAllowed: false, zone: 'hard' })
    expect(budgetVerdict([five(94.99)], DEFAULT_CAPS, none)).toMatchObject({ isAllowed: false, zone: 'soft' })
  })
})

