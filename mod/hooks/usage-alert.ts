import type { RateWindow } from '../types'

// The 90% usage alert's pure half: which windows alert, the text, and the dedupe key. The hooks that show it are in jobs.tsx.

export const DEFAULT_ALERT_PCT = 90
export const ALERT_KEY_PREFIX = 'usageAlert:'
/** A window's reset time is keyed to this grain, so a few seconds of drift between two reads is the same window. */
const RESET_GRAIN_MS = 5 * 60_000

const WINDOW_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' }

export type UsageAlert = { key: string; text: string }

/** `usageAlertPct`: 0 turns the alert off; anything but a number from 0 to 100 is the default. */
export function alertPctOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : DEFAULT_ALERT_PCT
}

/** "3:11 PM" for a reset later today, "Tue 3:11 PM" otherwise, in the person's own time zone. */
function localTime(ms: number, now: number): string {
  const at = new Date(ms)
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/**
 * The alerts a read of one provider's windows calls for: each 5-hour or weekly window at `pct` or more
 * (rounded, as shown). A window with no usable reset time is skipped: its key could not tell this
 * window from the next. The key names provider, window and reset, so each window alerts once.
 */
export function usageAlerts(provider: 'Claude' | 'Codex', windows: readonly RateWindow[], pct: number, now: number): UsageAlert[] {
  if (pct <= 0) return []
  return [...windows]
    .sort((a, b) => b.percentUsed - a.percentUsed)
    .flatMap(w => {
      const name = WINDOW_NAMES[w.kind]
      const resets = w.resetsAt === undefined ? Number.NaN : Date.parse(w.resetsAt)
      const used = Math.round(w.percentUsed)
      if (name === undefined || !Number.isFinite(used) || used < pct || !(resets > now)) return []
      return [{
        key: `${ALERT_KEY_PREFIX}${provider}:${w.kind}:${Math.round(resets / RESET_GRAIN_MS)}`,
        text: `Usage alert: ${provider} ${name} window at ${used}% (resets ${localTime(resets, now)}).`,
      }]
    })
}

/** How long past its bucket a key lives: rounding puts a bucket up to half a grain before the real reset. */
const STALE_MARGIN_MS = 60 * 60_000

/** The stored alert keys whose window has long reset: they can never recur, so they are deleted. */
export function staleAlertKeys(keys: readonly string[], now: number): string[] {
  return keys.filter(k => k.startsWith(ALERT_KEY_PREFIX) && (Number(k.split(':').at(-1)) + 1) * RESET_GRAIN_MS + STALE_MARGIN_MS < now)
}

/** The key itself and its two neighbour buckets: drift across a bucket edge must not alert a window twice. */
export function alertKeysSeen(key: string): string[] {
  const at = key.lastIndexOf(':')
  const bucket = Number(key.slice(at + 1))
  return [key, `${key.slice(0, at + 1)}${bucket - 1}`, `${key.slice(0, at + 1)}${bucket + 1}`]
}
