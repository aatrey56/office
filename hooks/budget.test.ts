import { describe, expect, test } from 'claude-code/testing'

import { budgetLine, budgetVerdict, DEFAULT_CAPS, isSmallRoute } from './budget'

const none = { isSmall: false, isExplicit: false, isForced: false }
const five = (percentUsed: number, resetsAt?: string) => ({ kind: 'five_hour', percentUsed, resetsAt })
const week = (percentUsed: number, resetsAt?: string) => ({ kind: 'seven_day', percentUsed, resetsAt })

describe('isSmallRoute', () => {
  test('sonnet and haiku at low or medium are small', () => {
    expect(isSmallRoute('sonnet', 'low')).toBe(true)
    expect(isSmallRoute('sonnet', 'medium')).toBe(true)
    expect(isSmallRoute('haiku', 'low')).toBe(true)
    expect(isSmallRoute('haiku', 'medium')).toBe(true)
  })
  test('anything bigger is not', () => {
    expect(isSmallRoute('sonnet', 'high')).toBe(false)
    expect(isSmallRoute('haiku', 'xhigh')).toBe(false)
    expect(isSmallRoute('opus', 'low')).toBe(false)
    expect(isSmallRoute('fable', 'medium')).toBe(false)
  })
})

describe('budgetVerdict', () => {
  test('no windows is open', () => {
    expect(budgetVerdict([], DEFAULT_CAPS, none)).toEqual({ isAllowed: true, zone: 'open' })
  })
  test('under every soft line is open', () => {
    expect(budgetVerdict([five(79.9), week(84)], DEFAULT_CAPS, none)).toEqual({ isAllowed: true, zone: 'open' })
  })
  test('soft zone: a small route starts without a warning', () => {
    expect(budgetVerdict([five(82)], DEFAULT_CAPS, { ...none, isSmall: true })).toEqual({ isAllowed: true, zone: 'soft' })
  })
  test('soft zone: an explicit model starts with a warning', () => {
    const v = budgetVerdict([five(82, '2026-10-04T18:00:00Z')], DEFAULT_CAPS, { ...none, isExplicit: true })
    expect(v).toMatchObject({ isAllowed: true, zone: 'soft' })
    expect((v as { warning: string }).warning).toContain('5-hour limit')
    expect((v as { warning: string }).warning).toContain('82%')
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
  test('isForced changes nothing outside the hard zone', () => {
    expect(budgetVerdict([five(10)], DEFAULT_CAPS, { ...none, isForced: true })).toEqual({ isAllowed: true, zone: 'open' })
    expect(budgetVerdict([five(85)], DEFAULT_CAPS, { ...none, isForced: true })).toMatchObject({ isAllowed: false, zone: 'soft' })
  })
  test('a non-standard kind has no soft line but obeys the hard one', () => {
    const spend = (percentUsed: number) => ({ kind: 'spend_limit', percentUsed })
    expect(budgetVerdict([spend(94)], DEFAULT_CAPS, none)).toEqual({ isAllowed: true, zone: 'open' })
    const v = budgetVerdict([spend(95)], DEFAULT_CAPS, none)
    expect(v).toMatchObject({ isAllowed: false, zone: 'hard' })
    expect((v as { reason: string }).reason).toContain('spend_limit')
  })
  test('exactly at a line counts as past it', () => {
    expect(budgetVerdict([five(80)], DEFAULT_CAPS, none)).toMatchObject({ isAllowed: false, zone: 'soft' })
    expect(budgetVerdict([five(79.99)], DEFAULT_CAPS, none)).toMatchObject({ isAllowed: true, zone: 'open' })
    expect(budgetVerdict([week(85)], DEFAULT_CAPS, none)).toMatchObject({ isAllowed: false, zone: 'soft' })
    expect(budgetVerdict([week(84.99)], DEFAULT_CAPS, none)).toMatchObject({ isAllowed: true, zone: 'open' })
    expect(budgetVerdict([five(95)], DEFAULT_CAPS, none)).toMatchObject({ isAllowed: false, zone: 'hard' })
    expect(budgetVerdict([five(94.99)], DEFAULT_CAPS, none)).toMatchObject({ isAllowed: false, zone: 'soft' })
  })
  test('hard wins over soft across windows', () => {
    const v = budgetVerdict([five(82), week(96)], DEFAULT_CAPS, { ...none, isSmall: true })
    expect(v).toMatchObject({ isAllowed: false, zone: 'hard' })
    expect((v as { reason: string }).reason).toContain('weekly limit')
  })
  test('the window with the highest percent is the one named', () => {
    const v = budgetVerdict([five(81), week(92)], DEFAULT_CAPS, none)
    expect((v as { reason: string }).reason).toContain('weekly limit')
    expect((v as { reason: string }).reason).not.toContain('5-hour')
  })
  test('reason names the line crossed and skips an unparseable reset', () => {
    const v = budgetVerdict([five(85, 'soon')], DEFAULT_CAPS, none)
    const reason = (v as { reason: string }).reason
    expect(reason).toContain('80%')
    expect(reason).not.toContain('resets')
    expect((budgetVerdict([five(85)], DEFAULT_CAPS, none) as { reason: string }).reason).not.toContain('resets')
  })
  test('custom caps are honoured', () => {
    const caps = { softFiveHourPct: 50, softSevenDayPct: 60, hardPct: 70 }
    expect(budgetVerdict([five(50)], caps, none)).toMatchObject({ isAllowed: false, zone: 'soft' })
    expect(budgetVerdict([week(59)], caps, none)).toMatchObject({ isAllowed: true, zone: 'open' })
    expect(budgetVerdict([week(70)], caps, none)).toMatchObject({ isAllowed: false, zone: 'hard' })
  })
})

describe('budgetLine', () => {
  test('five hour then week, rounded', () => {
    expect(budgetLine([week(14.4), five(41.6)])).toBe('5h 42% · week 14%')
  })
  test('other kinds follow', () => {
    expect(budgetLine([{ kind: 'spend_limit', percentUsed: 7 }, week(1), five(2)])).toBe('5h 2% · week 1% · spend_limit 7%')
  })
  test('one window, and none', () => {
    expect(budgetLine([week(14)])).toBe('week 14%')
    expect(budgetLine([])).toBe('')
  })
})
