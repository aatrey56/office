import type { RateWindow } from '../types'

// The Codex budget guard's pure half: reading the account's rate limits from
// `codex app-server`, parsing a quota hit's reset time, and the verdict before
// a Codex job starts. The hooks that run it are in jobs.tsx.

/**
 * Codex's usage, read without spending a message: `codex app-server` answers
 * `account/rateLimits/read` (codex 0.160; `codex app-server generate-json-schema`
 * documents it) with a 5-hour `primary` and a weekly `secondary` window per
 * metered bucket. Every model seen so far reports into one bucket, `codex`.
 * `codex exec --json` itself carries no usage, only token counts.
 */
export const CODEX_LIMITS_REQUEST =
  [
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'office', version: '0.3.0' } } },
    { method: 'initialized' },
    { id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } },
  ]
    .map(m => JSON.stringify(m))
    .join('\n') + '\n'

/**
 * app-server exits when stdin closes, before the answer comes back, and a
 * spawn's stdin closes after its input: the shell holds it open a while. The
 * caller stops reading at the answer; the server then exits within the sleep.
 */
export function codexLimitsArgv(bin: string): string[] {
  return ['sh', '-c', '{ cat; sleep 10; } | exec "$0" app-server', bin]
}

/** One metered bucket; `model` set when the bucket is that model's own (`normalModelSlug`). */
export type CodexBucket = { model?: string; windows: RateWindow[] }
export type CodexLimits = { at: number; buckets: CodexBucket[] }
/** Models that hit their quota: model → when it resets (ms) and Codex's words. */
export type CodexOut = Record<string, { until: number; note: string }>

function windowOf(raw: unknown): RateWindow | undefined {
  const w = raw as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined
  if (typeof w?.usedPercent !== 'number') return undefined
  const mins = w.windowDurationMins
  const kind = mins === 300 ? 'five_hour' : mins === 10080 ? 'seven_day' : typeof mins === 'number' ? `${mins}-minute` : 'window'
  const resetsAt = typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : undefined
  return { kind, percentUsed: w.usedPercent, resetsAt }
}

/** The `account/rateLimits/read` answer in app-server's stdout, once it is there. */
export function codexLimitsFrom(stdout: string, now: number): CodexLimits | undefined {
  for (const line of stdout.split('\n')) {
    let o: { id?: unknown; result?: Record<string, unknown> }
    try {
      o = JSON.parse(line) as typeof o
    } catch {
      continue
    }
    if (o.id !== 2 || o.result === undefined) continue
    const byId = o.result.rateLimitsByLimitId as Record<string, unknown> | null | undefined
    const snapshots = byId ? Object.values(byId) : [o.result.rateLimits]
    const buckets = snapshots.flatMap(raw => {
      const s = raw as { primary?: unknown; secondary?: unknown; normalModelSlug?: unknown } | null | undefined
      if (!s) return []
      const windows = [windowOf(s.primary), windowOf(s.secondary)].filter((w): w is RateWindow => w !== undefined)
      return [{ model: typeof s.normalModelSlug === 'string' ? s.normalModelSlug : undefined, windows }]
    })
    return { at: now, buckets }
  }
  return undefined
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * When a quota hit lifts, from codex's own words (local time, as it prints it):
 * "Try again at 3:11 AM", "Try again at Oct 7th, 2026 3:11 AM", "try again in 3 days".
 */
export function codexResetAt(errorText: string, now: number): number | undefined {
  const at = errorText.match(/try again at (?:([a-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})(?: at)? )?(\d{1,2}):(\d{2}) ?([ap]m)/i)
  if (at) {
    const [, mon, day, year, h, m, ampm] = at
    const hour = (Number(h) % 12) + (ampm!.toLowerCase() === 'pm' ? 12 : 0)
    const base = new Date(now)
    const month = mon ? MONTHS.indexOf(mon.toLowerCase()) : -1
    const d = mon && month >= 0
      ? new Date(Number(year), month, Number(day), hour, Number(m))
      : new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, Number(m))
    // A bare time already past today means tomorrow.
    return !mon && d.getTime() <= now ? d.getTime() + 86_400_000 : d.getTime()
  }
  const span = errorText.match(/try again in (\d+(?:\.\d+)?) ?(ms|s|sec|seconds?|minutes?|min|hours?|days?)\b/i)
  if (span) {
    const u = span[2]!.toLowerCase()
    const unitMs = u === 'ms' ? 1 : u.startsWith('s') ? 1000 : u.startsWith('m') ? 60_000 : u.startsWith('h') ? 3_600_000 : 86_400_000
    return now + Number(span[1]) * unitMs
  }
  return undefined
}

/** How long a quota hit blocks a model when codex named no reset time. */
export const CODEX_OUT_FALLBACK_MS = 60 * 60_000

/** "3:11 AM" today, "Oct 7, 3:11 AM" another day; the machine's local time, like codex's. */
export function clockText(ms: number, now: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date(now).toDateString()
    ? time
    : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`
}

export const CODEX_WARN_PCT = 80
export const CODEX_REFUSE_PCT = 95

export type CodexVerdict = { isAllowed: true; warning?: string } | { isAllowed: false; reason: string }

/**
 * Before a Codex job on `model`:
 * - the model hit its quota and has not reset → refused;
 * - a window of a bucket that meters it (a shared one, or the model's own) at
 *   CODEX_REFUSE_PCT or more → refused; at CODEX_WARN_PCT or more → allowed with a warning.
 * `isForced` (only the person's typed /codex-review --force) lets either refusal start, with a warning.
 * A window whose reset time has passed is ignored.
 */
export function codexGuardVerdict(
  model: string,
  now: number,
  state: { limits?: CodexLimits; out: CodexOut },
  isForced: boolean,
): CodexVerdict {
  const out = state.out[model]
  if (out !== undefined && out.until > now) {
    const what = `Codex ${model} is out until ${clockText(out.until, now)} (quota hit)`
    if (isForced) return { isAllowed: true, warning: `Forced past a quota hit: ${what}.` }
    return { isAllowed: false, reason: `${what}; try --model <another model> or wait.` }
  }
  const windows = (state.limits?.buckets ?? [])
    .filter(b => b.model === undefined || b.model === model)
    .flatMap(b => b.windows)
    .filter(w => w.resetsAt === undefined || Date.parse(w.resetsAt) > now)
  const worst = windows.reduce<RateWindow | undefined>((a, w) => (a === undefined || w.percentUsed > a.percentUsed ? w : a), undefined)
  if (worst === undefined || worst.percentUsed < CODEX_WARN_PCT) return { isAllowed: true }
  const name = worst.kind === 'five_hour' ? '5-hour limit' : worst.kind === 'seven_day' ? 'weekly limit' : worst.kind
  const resets = worst.resetsAt !== undefined ? `, resets ${clockText(Date.parse(worst.resetsAt), now)}` : ''
  const what = `Codex's ${name} is at ${Math.round(worst.percentUsed)}%${resets}`
  if (worst.percentUsed < CODEX_REFUSE_PCT) return { isAllowed: true, warning: `${what}.` }
  if (isForced) return { isAllowed: true, warning: `Forced past the limit: ${what}.` }
  return { isAllowed: false, reason: `Codex budget guard refused: ${what} (limit ${CODEX_REFUSE_PCT}%).` }
}

/** `/codex-review` args: `--deep`, `--force` and `--model <m>` anywhere; the rest is the target. */
export function parseCodexReviewArgs(raw: string | undefined): { deep: boolean; force: boolean; model?: string; rest: string } {
  const words = (raw ?? '').trim().split(/\s+/).filter(Boolean)
  let deep = false
  let force = false
  let model: string | undefined
  const rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '--deep') deep = true
    else if (w === '--force') force = true
    else if (w === '--model' && words[i + 1] !== undefined) model = words[++i]
    else rest.push(w)
  }
  return { deep, force, model, rest: rest.join(' ') }
}
