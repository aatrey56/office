import type { BudgetCaps, BudgetVerdict, Effort, ModelTier, RateWindow } from '../types'

// Whether a new worker may start, from the account's rate-limit windows. Pure.

export const DEFAULT_CAPS: BudgetCaps = { softFiveHourPct: 80, softSevenDayPct: 85, hardPct: 95 }

// Small enough to start inside the soft zone: sonnet (or haiku while it exists) at low or medium.
export function isSmallRoute(model: ModelTier, effort: Effort): boolean {
  return (model === 'sonnet' || model === 'haiku') && (effort === 'low' || effort === 'medium')
}

// Kinds without a soft line (a gateway's spend_limit) only ever hit the hard one.
function softLine(w: RateWindow, caps: BudgetCaps): number | undefined {
  if (w.kind === 'five_hour') return caps.softFiveHourPct
  if (w.kind === 'seven_day') return caps.softSevenDayPct
  return undefined
}

function windowName(kind: string): string {
  if (kind === 'five_hour') return '5-hour limit'
  if (kind === 'seven_day') return 'weekly limit'
  return kind
}

// Plain words for one crossed window; no relative times since there is no clock here.
function describe(w: RateWindow, line: number, lineName: string): string {
  const resets = w.resetsAt !== undefined && !Number.isNaN(Date.parse(w.resetsAt)) ? `, resets ${w.resetsAt}` : ''
  return `${windowName(w.kind)} is at ${Math.round(w.percentUsed)}% (${lineName} ${line}%${resets})`
}

// The most used window among those at or past their line, if any.
function worst(windows: RateWindow[], lineOf: (w: RateWindow) => number | undefined): { w: RateWindow; line: number } | undefined {
  let found: { w: RateWindow; line: number } | undefined
  for (const w of windows) {
    const line = lineOf(w)
    if (line === undefined || w.percentUsed < line) continue
    if (found === undefined || w.percentUsed > found.w.percentUsed) found = { w, line }
  }
  return found
}

// open: every window under its soft line → allowed.
// soft: some window at or past its soft line, none at the hard line → allowed when `isSmall`,
//       or when `isExplicit` (the person typed the model) with a warning; else refused.
// hard: some window at or past hardPct → refused unless `isForced`.
// Windows other than five_hour and seven_day (a gateway's spend_limit) use hardPct only.
// A refusal's reason names the window, its percent and, when known, when it resets.
export function budgetVerdict(
  windows: RateWindow[],
  caps: BudgetCaps,
  ask: { isSmall: boolean; isExplicit: boolean; isForced: boolean },
): BudgetVerdict {
  const hard = worst(windows, () => caps.hardPct)
  if (hard !== undefined) {
    const what = describe(hard.w, hard.line, 'hard limit')
    if (ask.isForced) return { isAllowed: true, zone: 'hard', warning: `Forced past the limit: ${what}` }
    return { isAllowed: false, zone: 'hard', reason: `Budget guard refused: ${what}` }
  }
  const soft = worst(windows, w => softLine(w, caps))
  if (soft !== undefined) {
    const what = describe(soft.w, soft.line, 'soft limit')
    if (ask.isSmall) return { isAllowed: true, zone: 'soft' }
    if (ask.isExplicit) return { isAllowed: true, zone: 'soft', warning: `Running in the soft zone: ${what}` }
    return { isAllowed: false, zone: 'soft', reason: `Budget guard refused a non-small route: ${what}` }
  }
  return { isAllowed: true, zone: 'open' }
}

// "5h 42% · week 14%" for the scene footer; '' when there are no windows.
export function budgetLine(windows: RateWindow[]): string {
  const rank = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2)
  const label = (w: RateWindow) =>
    `${w.kind === 'five_hour' ? '5h' : w.kind === 'seven_day' ? 'week' : w.kind} ${Math.round(w.percentUsed)}%`
  return windows
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rank(a.w.kind) - rank(b.w.kind) || a.i - b.i)
    .map(({ w }) => label(w))
    .join(' · ')
}
