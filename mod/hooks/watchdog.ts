// Job watchdog, the pure half: when a running job is extended or ended, when a blocked one is
// reported or ended, and when a --bg worker that never replied is reported. jobs.tsx keeps the
// timers and the git commits; every time here is read from one clock ($.clock.now).

/** A transcript (or output stream) that grew this recently counts as a worker still working. */
export const GROWTH_WINDOW_MS = 5 * 60_000
/** A --bg worker with no assistant turn this long after its start is reported as stalled. */
export const STALL_MS = 5 * 60_000

/** What the watchdog last saw of a job's transcript: its end (`mark`), and when that last changed. */
export type Growth = { mark: string; at?: number }

/**
 * The growth record after one look at the transcript's end: `at` moves when the end changed since
 * the last look. A first look sets no time, so a reload never counts as growth.
 */
export function nextGrowth(prev: Growth | undefined, mark: string, now: number): Growth {
  if (prev === undefined) return { mark }
  return mark === prev.mark ? prev : { mark, at: now }
}

export type DeadlineInput = {
  softMin: number // jobTimeoutMin
  hardMin: number // jobTimeoutHardMin
  isExtended: boolean // the one extension is spent
  grewAt?: number // when the transcript last grew
  now: number
}

/** At a job's deadline: extend once to hardMin when its transcript grew within GROWTH_WINDOW_MS; otherwise end it. */
export function deadlineVerdict(d: DeadlineInput): 'extend' | 'end' {
  if (d.isExtended || d.hardMin <= d.softMin || d.grewAt === undefined) return 'end'
  return d.now - d.grewAt <= GROWTH_WINDOW_MS ? 'extend' : 'end'
}

/** A job blocked on approval: reported once past limitMin, ended at twice that. */
export function blockedVerdict(blockedMs: number, limitMin: number, hasReported: boolean): 'wait' | 'report' | 'end' {
  if (blockedMs >= 2 * limitMin * 60_000) return 'end'
  if (blockedMs >= limitMin * 60_000 && !hasReported) return 'report'
  return 'wait'
}

/** A --bg worker with no assistant turn STALL_MS after its start, not yet reported. */
export function isStalled(sinceStartMs: number, hasTurn: boolean, hasReported: boolean): boolean {
  return !hasTurn && !hasReported && sinceStartMs >= STALL_MS
}

/** Why a job past its time was ended, for its result. */
export function timeoutText(softMin: number, hardMin: number, isExtended: boolean): string {
  return isExtended
    ? `timed out after ${hardMin} min (jobTimeoutHardMin): extended once at ${softMin} min (jobTimeoutMin) because its transcript was still growing, then ended at the hard limit`
    : `timed out after ${softMin} min (jobTimeoutMin)${hardMin > softMin ? `; not extended: no transcript growth seen in its last ${GROWTH_WINDOW_MS / 60_000} min` : ''}`
}
