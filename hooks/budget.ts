import type { BudgetCaps, BudgetVerdict, Effort, ModelTier, RateWindow } from '../types'

// Whether a new worker may start, from the account's rate-limit windows. Pure.
// CONTRACT STUB: signatures are fixed; the bodies are the orchestration builder's.

export const DEFAULT_CAPS: BudgetCaps = { softFiveHourPct: 80, softSevenDayPct: 85, hardPct: 95 }

// Small enough to start inside the soft zone: sonnet (or haiku while it exists) at low or medium.
export function isSmallRoute(model: ModelTier, effort: Effort): boolean {
  throw new Error('not implemented')
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
  throw new Error('not implemented')
}

// "5h 42% · week 14%" for the scene footer; '' when there are no windows.
export function budgetLine(windows: RateWindow[]): string {
  throw new Error('not implemented')
}
