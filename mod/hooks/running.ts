import type { Job } from '../types'

// Owner: jobs writes, scene reads. Each session's running jobs (Codex reviews, codex_exec,
// workers) sit in $.store under `running:<sessionId>`, so every office pane can show the work
// that is not a session of its own. Pure: jobs in, the record and the pane's words out.

/** One running job as other sessions see it. */
export type RunningJob = {
  id: string
  kind: Job['kind']
  label: string // "codex review r1 sol", "worker opus/high"
  model?: string
  startedAt: number
  cwd: string
  project?: string // worker: the main repo it works for
  mode?: Job['mode'] // worker: a --bg one is a session already, drawn as one
  agentId?: string // subagent-mode worker: its transcript is drawn as a subagent already
}
/** What one session publishes; `updatedAt` is its heartbeat. */
export type RunningRecord = { sessionId: string; updatedAt: number; jobs: RunningJob[] }
/** A running job in a pane, with the session that started it. */
export type ShownJob = RunningJob & { sessionId: string; owner: string }

export const RUNNING_PREFIX = 'running:'
/** A record whose heartbeat is older than this is ignored: its session crashed or went away. */
export const RUNNING_STALE_MS = 2 * 60_000
/** A session with jobs running writes its record again this often, even when nothing changed. */
export const RUNNING_BEAT_MS = 30_000
/** Readers delete a record this old: no live session leaves its heartbeat that long. */
export const RUNNING_DROP_MS = 60 * 60_000

export const runningKey = (sessionId: string): string => `${RUNNING_PREFIX}${sessionId}`

/** Still at it: running, waiting on a person, or in its gate. */
export function isRunning(job: Job): boolean {
  return job.endedAt === undefined && (job.status === 'running' || job.status === 'blocked' || job.status === 'checking')
}

/** "gpt-6.1-sol@high" → "sol", "claude-opus-5-5" → "opus"; anything else as it is, without its @effort. */
function shortModel(model: string | undefined): string {
  const bare = (model ?? '').split('@')[0]!.trim()
  const tier = /\b(haiku|sonnet|opus|fable)\b/.exec(bare)?.[1]
  return tier ?? bare.replace(/^gpt-[\d.]+-/, '')
}

/** The few words a pane shows for a job. */
export function jobLabel(job: Job): string {
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ')
  if (job.kind === 'codex-review') {
    const round = /^codex (re-review|review) (\d+)/.exec(job.title)
    return join(`codex ${round?.[1] ?? 'review'}`, round ? `r${round[2]}` : '', shortModel(job.model))
  }
  if (job.kind === 'codex-exec') return join('codex exec', shortModel(job.model))
  return join('worker', [shortModel(job.model), job.effort ?? ''].filter(Boolean).join('/'))
}

/** This session's running jobs, oldest first, as its record lists them. */
export function runningOf(jobs: Job[]): RunningJob[] {
  return jobs
    .filter(isRunning)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(j => ({
      id: j.id,
      kind: j.kind,
      label: jobLabel(j),
      ...(j.model ? { model: j.model } : {}),
      startedAt: j.startedAt,
      cwd: j.cwd,
      ...(j.project ? { project: j.project } : {}),
      ...(j.mode ? { mode: j.mode } : {}),
      ...(j.agentId ? { agentId: j.agentId } : {}),
    }))
}

/** What the publisher does now: write on a change or a due heartbeat, delete once nothing runs. */
export function publishPlan(last: { sig: string; at: number } | undefined, jobs: RunningJob[], now: number): 'set' | 'delete' | 'none' {
  const sig = JSON.stringify(jobs)
  if (last !== undefined && last.sig === sig && (jobs.length === 0 || now - last.at < RUNNING_BEAT_MS)) return 'none'
  return jobs.length > 0 ? 'set' : 'delete'
}

const KINDS: readonly string[] = ['worker', 'codex-review', 'codex-exec']

/** A stored record when it is well formed and its heartbeat is fresh; else undefined (ignored). */
export function freshRecord(raw: unknown, now: number): RunningRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Partial<RunningRecord>
  if (typeof r.sessionId !== 'string' || typeof r.updatedAt !== 'number' || !Array.isArray(r.jobs)) return undefined
  if (now - r.updatedAt > RUNNING_STALE_MS) return undefined
  const jobs = r.jobs.filter(
    (j): j is RunningJob =>
      typeof j === 'object' && j !== null && typeof j.id === 'string' && KINDS.includes(j.kind) &&
      typeof j.label === 'string' && typeof j.startedAt === 'number' && typeof j.cwd === 'string',
  )
  return { sessionId: r.sessionId, updatedAt: r.updatedAt, jobs }
}

/** True for a record no live session would leave behind (old heartbeat, or junk): safe to delete. */
export function isDroppable(raw: unknown, now: number): boolean {
  const at = typeof raw === 'object' && raw !== null ? (raw as { updatedAt?: unknown }).updatedAt : undefined
  return typeof at !== 'number' || now - at > RUNNING_DROP_MS
}

/** "<1m", "6m", "1h5m". */
export function elapsedText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

/** The pane's running row; each job names its session when `withOwner` (several sessions shown). */
export function runningRow(jobs: ShownJob[], now: number, withOwner: boolean): string {
  if (jobs.length === 0) return 'running: nothing'
  const one = (j: ShownJob) => `${j.label} ${elapsedText(now - j.startedAt)}${withOwner ? ` (${j.owner})` : ''}`
  return `running: ${jobs.map(one).join(' · ')}`
}

/** After a session's status in the list: " · waiting on 2 jobs", or nothing. */
export function waitingText(count: number): string {
  return count > 0 ? ` · waiting on ${count} job${count === 1 ? '' : 's'}` : ''
}
