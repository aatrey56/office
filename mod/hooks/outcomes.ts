import type { Effort, Job, ModelTier, RouteDecision } from '../types'

// The outcome log: one JSON line per worker spawn, worker finish and Codex review finish, appended to
// <config dir>/office/outcomes.jsonl and keyed by job id, so an audit can join a worker's model, who
// chose it and why, with its gate verdict, minutes and tokens without its transcript. Also the
// Sonnet trial's rule. Pure: jobs.tsx gathers the facts and appends the lines.

export const OUTCOMES_FILE = 'outcomes.jsonl'
const TASK_KEEP = 160
/** A reason, why or error is clipped to this, so a record stays well under OUTCOME_LINE_MAX. */
const TEXT_KEEP = 300
/** The longest line appended (bytes); a longer one is skipped, never cut into torn JSON. */
export const OUTCOME_LINE_MAX = 4000

const clip = (s: string | null, n = TEXT_KEEP) => (s === null || s.length <= n ? s : `${s.slice(0, n - 1)}…`)

/**
 * perl appending `line` and a newline to `path` (made with its directory if missing), holding an
 * exclusive flock on it for the whole write, so lines from every session land whole. Exits 1 when
 * the lock stays held past `waitMs`, 2 when the file cannot be opened, 3 when the write fails.
 */
export function lockedAppendArgv(path: string, line: string, waitMs: number): string[] {
  const script = [
    "use Fcntl qw(:flock O_WRONLY O_APPEND O_CREAT); use File::Path 'make_path'; use File::Basename 'dirname'; use Time::HiRes 'time';",
    'my ($path, $line, $wait) = @ARGV; eval { make_path(dirname($path)) };',
    'sysopen(my $f, $path, O_WRONLY | O_APPEND | O_CREAT, 0644) or exit 2; my $until = time + $wait;',
    'until (flock($f, LOCK_EX | LOCK_NB)) { exit 1 if time >= $until; select(undef, undef, undef, 0.05) }',
    'my $s = "$line\\n"; while (length $s) { my $n = syswrite($f, $s); exit 3 unless $n; substr($s, 0, $n) = "" } close($f) or exit 3;',
  ].join(' ')
  return ['perl', '-e', script, path, line, String(waitMs / 1000)]
}

/** Who chose the model: the router, the router overruled by the Sonnet trial, an agent's explicit model, or the person's /spawn --model. */
export type Chooser = 'router' | 'trial' | 'manager' | 'person'
export type RouterPick = { model: ModelTier; effort: Effort; confidence: number; backend: RouteDecision['backend'] } | null

export function routerPick(d: RouteDecision | undefined): RouterPick {
  return d === undefined ? null : { model: d.model, effort: d.effort, confidence: d.confidence, backend: d.backend }
}

export type SpawnFacts = {
  job: string
  at: number
  cwd: string
  repo: string | null
  branch: string | null
  base: string | null
  mode: string
  deliverable: string | null
  model: string
  effort: Effort
  chooser: Chooser
  routerPick: RouterPick
  reason: string | null
  task: string
}

export function spawnRecord(f: SpawnFacts): string {
  return JSON.stringify({ kind: 'spawn', ...f, at: new Date(f.at).toISOString(), reason: clip(f.reason), taskChars: f.task.length, task: f.task.replace(/\s+/g, ' ').trim().slice(0, TASK_KEEP) })
}

export type Verdict = 'passed' | 'rejected' | 'no-change' | 'unverified' | 'failed' | 'timeout' | 'stopped'

const firstLine = (s: string | undefined) => (s ?? '').split('\n').map(l => l.trim()).find(l => l !== '') ?? ''

/** How a worker that did not finish ended, when its caller knows: stopped (a kill, an abort, its session stopped) or out of time. */
export type Ending = 'stopped' | 'timeout'

/** A --bg session's ending from its `claude agents` state; undefined for one that failed on its own. */
export function bgEnding(state: string | undefined): Ending | undefined {
  return state === 'killed' || state === 'stopped' ? 'stopped' : undefined
}

/** A subagent's ending from its turn's reason: an abort is a stop. */
export function turnEnding(reason: string): Ending | undefined {
  return reason === 'aborted' ? 'stopped' : undefined
}

/**
 * A finished worker's verdict and the first line of why. A done job is what its gate said (a job
 * with no gate, or a gate that checked nothing, is unverified, never passed); a failed one is
 * its `ending` when the caller knows it, else read off its result: a timeout, a stop (the
 * person's kill, or its session stopped) or a failure.
 */
export function finishVerdict(job: Pick<Job, 'status' | 'gate' | 'result'>, ending?: Ending): { verdict: Verdict; why: string | null } {
  const line = firstLine(job.result)
  const gate = job.gate
  if (job.status === 'rejected') return { verdict: 'rejected', why: gate?.head ?? (line.replace(/^REJECTED by the office gate: /, '') || null) }
  if (job.status === 'done') {
    if (gate?.verdict === 'pass') return { verdict: 'passed', why: null }
    if (gate?.verdict === 'no-change') return { verdict: 'no-change', why: gate.head }
    // A red check in report mode is not enforced, but it is not a pass either.
    if (gate?.verdict === 'fail') return { verdict: 'rejected', why: gate.head }
    return { verdict: 'unverified', why: gate?.head ?? null }
  }
  if (ending !== undefined) return { verdict: ending, why: line || null }
  if (/^(timed out after|ended after .* waiting for approval)/.test(line)) return { verdict: 'timeout', why: line }
  if (/^killed\b|is gone \(stopped|ended: (stopped|killed|aborted)\b/.test(line)) return { verdict: 'stopped', why: line }
  return { verdict: 'failed', why: line || null }
}

export type Tokens = { outputTokens: number; cacheReadTokens: number }

export function finishRecord(job: Job, at: number, commits: number | null, tokens?: Tokens, ending?: Ending): string {
  const { verdict, why } = finishVerdict(job, ending)
  return JSON.stringify({
    kind: 'finish',
    job: job.id,
    at: new Date(at).toISOString(),
    minutes: Math.round((at - job.startedAt) / 6000) / 10,
    verdict,
    why: clip(why),
    commits,
    ...(tokens ?? {}),
  })
}

/**
 * Output and cache-read tokens of a transcript's assistant lines; undefined when it has none. A reply
 * written as several lines repeats its message id, so each id counts once, at its largest usage.
 */
export function transcriptTokens(jsonl: string): Tokens | undefined {
  const byId = new Map<string, Tokens>()
  let n = 0
  for (const raw of jsonl.split('\n')) {
    if (!raw.includes('"assistant"')) continue
    let o: { type?: unknown; message?: { id?: unknown; usage?: { output_tokens?: unknown; cache_read_input_tokens?: unknown } } }
    try {
      o = JSON.parse(raw) as typeof o
    } catch {
      continue
    }
    const usage = o.type === 'assistant' ? o.message?.usage : undefined
    if (usage === undefined) continue
    const id = typeof o.message?.id === 'string' ? o.message.id : `#${n++}`
    const out = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
    const cache = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
    const old = byId.get(id)
    byId.set(id, { outputTokens: Math.max(out, old?.outputTokens ?? 0), cacheReadTokens: Math.max(cache, old?.cacheReadTokens ?? 0) })
  }
  if (byId.size === 0) return undefined
  let outputTokens = 0
  let cacheReadTokens = 0
  for (const t of byId.values()) {
    outputTokens += t.outputTokens
    cacheReadTokens += t.cacheReadTokens
  }
  return { outputTokens, cacheReadTokens }
}

/** The [P1]/[P2]/[P3] markers in a Codex review's text. */
export function countFindings(text: string): { p1: number; p2: number; p3: number } {
  const n = { p1: 0, p2: 0, p3: 0 }
  for (const m of text.matchAll(/\[P([123])\]/g)) n[`p${m[1]}` as keyof typeof n]++
  return n
}

export type ReviewFacts = { job: string; at: number; branch: string | null; round: number | null; model: string; text: string; error?: string }

/** A finished review; a failed one has no findings and is not clean, and `error` says why. */
export function reviewRecord(f: ReviewFacts): string {
  const findings = f.error === undefined ? countFindings(f.text) : { p1: 0, p2: 0, p3: 0 }
  return JSON.stringify({
    kind: 'review',
    job: f.job,
    at: new Date(f.at).toISOString(),
    branch: f.branch,
    round: f.round,
    model: f.model,
    findings,
    clean: f.error === undefined && findings.p1 + findings.p2 + findings.p3 === 0,
    ...(f.error !== undefined ? { error: clip(firstLine(f.error)) } : {}),
  })
}

// ── the Sonnet trial ────────────────────────────────────────────────────

export const SONNET_TRIAL_DEFAULT = '2026-11-30'

/** The trial's last day (YYYY-MM-DD), from the sonnetTrialUntil option; undefined when off or not a date. */
export function trialUntil(option: unknown): string | undefined {
  const v = typeof option === 'string' ? option.trim() : SONNET_TRIAL_DEFAULT
  if (v === '' || v.toLowerCase() === 'off') return undefined
  const day = v.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) ? day : undefined
}

/**
 * Until the end of `until` (UTC), a commit worker the router sized as Opus runs on Sonnet at high
 * effort (or the effort the caller gave). Report workers and every explicit model are left alone.
 */
export function trialSwap(
  routed: Pick<RouteDecision, 'model' | 'effort'>,
  deliverable: string | undefined,
  until: string | undefined,
  now: number,
  effortArg?: Effort,
): { model: 'sonnet'; effort: Effort; line: string } | undefined {
  if (until === undefined || now >= Date.parse(until) + 86_400_000) return undefined
  if (routed.model !== 'opus' || deliverable === 'report') return undefined
  const effort = effortArg ?? 'high'
  return { model: 'sonnet', effort, line: `Sonnet trial until ${until}: router picked opus/${routed.effort}, running sonnet/${effort}.` }
}

/** The refusal for an agent that names a model without saying why. */
export function reasonMissingText(model: string): string {
  return `spawn_worker: model "${model}" was given without a reason. Omit model (and effort) to let the router pick, or add reason: one line on why this task needs ${model}.`
}
