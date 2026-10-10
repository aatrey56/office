import { describe, expect, test } from 'claude-code/testing'

import { alertKeysSeen, alertPctOf, staleAlertKeys, usageAlerts } from './usage-alert'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const HOUR = 3_600_000
const win = (kind: string, percentUsed: number, resetsAt = new Date(NOW + 2 * HOUR).toISOString()) => ({ kind, percentUsed, resetsAt })

describe('usage alert', () => {
  test('a 5-hour or weekly window at the threshold alerts, with the agreed text; below it, or off, does not', () => {
    const [alert] = usageAlerts('Claude', [win('five_hour', 92)], 90, NOW)
    expect(alert!.text).toMatch(/^Usage alert: Claude 5-hour window at 92% \(resets .+\)\.$/)
    expect(usageAlerts('Codex', [win('seven_day', 90)], 90, NOW)[0]!.text).toMatch(/^Usage alert: Codex weekly window at 90% \(resets .+\)\.$/)
    expect(usageAlerts('Claude', [win('five_hour', 89.4), win('seven_day', 40), win('spend_limit', 99)], 90, NOW)).toEqual([])
    expect(usageAlerts('Claude', [win('five_hour', 99)], 0, NOW)).toEqual([])
    expect(alertPctOf(undefined)).toBe(90)
    expect(alertPctOf(0)).toBe(0)
    expect(alertPctOf(75)).toBe(75)
    expect(alertPctOf(250)).toBe(90)
  })

  test('one key per provider, window and reset: the same window keys alike, a new window or provider differs', () => {
    const key = (provider: 'Claude' | 'Codex', w: ReturnType<typeof win>) => usageAlerts(provider, [w], 90, NOW)[0]!.key
    const first = key('Claude', win('five_hour', 91))
    expect(key('Claude', win('five_hour', 97))).toBe(first) // more use, same window
    expect(key('Claude', win('five_hour', 91, new Date(NOW + 2 * HOUR + 4000).toISOString()))).toBe(first) // seconds of drift
    expect(key('Claude', win('five_hour', 91, new Date(NOW + 7 * HOUR).toISOString()))).not.toBe(first) // the next window
    expect(key('Claude', win('seven_day', 91))).not.toBe(first)
    expect(key('Codex', win('five_hour', 91))).not.toBe(first)
  })

  test('a window with no usable reset time, or one already past, does not alert; keys of reset windows are stale', () => {
    expect(usageAlerts('Claude', [{ kind: 'five_hour', percentUsed: 95 }, win('five_hour', 95, 'soon'), win('five_hour', 95, new Date(NOW - HOUR).toISOString())], 90, NOW)).toEqual([])
    const live = usageAlerts('Claude', [win('five_hour', 95)], 90, NOW)[0]!.key
    const old = usageAlerts('Claude', [win('five_hour', 95, new Date(NOW - 2 * HOUR).toISOString())], 90, NOW - 5 * HOUR)[0]!.key // its reset passed long ago
    expect(staleAlertKeys([live, old, 'codexRounds'], NOW)).toEqual([old])
  })

  test('a key whose bucket rounded down is not stale just after the bucket time', () => {
    const grain = 5 * 60_000
    const reset = 1000 * grain + 2 * 60_000 // rounds down to bucket 1000, so bucket time is 2 min before the reset
    const key = usageAlerts('Claude', [win('five_hour', 95, new Date(reset).toISOString())], 90, reset - HOUR)[0]!.key
    expect(key.endsWith(':1000')).toBe(true)
    expect(staleAlertKeys([key], 1000 * grain + 1000)).toEqual([])
    expect(staleAlertKeys([key], reset + 2 * HOUR)).toEqual([key])
  })

  test('a neighbour-bucket key counts as already shown', () => {
    const key = 'usageAlert:Claude:five_hour:1000'
    expect(alertKeysSeen(key)).toEqual([key, 'usageAlert:Claude:five_hour:999', 'usageAlert:Claude:five_hour:1001'])
  })
})
