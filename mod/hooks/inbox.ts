import type { Job } from '../types'

// The routing inbox: every routed worker's task and how it went, appended to the git-ignored
// evals/routing.inbox.jsonl so real tasks can be labelled into routing.local.jsonl later.
// Pure: jobs.tsx writes the lines and runs /route-inbox.

export const INBOX_PATH = 'evals/routing.inbox.jsonl'
const SHOW = 10

export type InboxEntry = {
  job: string
  at: string
  task: string
  pick: string // model/effort, backend
  outcome?: string // done, 3.2 min, $0.41
  isLabelled: boolean
}

/** The start line of a routed worker; undefined for a job whose model was given. */
export function routedLine(job: Job, task: string, at: number): string | undefined {
  const r = job.route
  if (r === undefined) return undefined
  return JSON.stringify({
    kind: 'routed',
    job: job.id,
    at: new Date(at).toISOString(),
    task,
    model: r.model,
    effort: r.effort,
    backend: r.backend,
    confidence: r.confidence,
  })
}

/** The finish line of a routed worker; undefined for an unrouted or still-live job. */
export function finishedLine(job: Job): string | undefined {
  if (job.route === undefined || job.endedAt === undefined) return undefined
  if (job.status !== 'done' && job.status !== 'failed') return undefined
  return JSON.stringify({
    kind: 'finished',
    job: job.id,
    at: new Date(job.endedAt).toISOString(),
    status: job.status,
    minutes: Math.round((job.endedAt - job.startedAt) / 6000) / 10,
    ...(job.costUsd !== undefined ? { costUsd: job.costUsd } : {}),
  })
}

function objects(jsonl: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    try {
      const o: unknown = JSON.parse(line)
      if (typeof o === 'object' && o !== null && !Array.isArray(o)) out.push(o as Record<string, unknown>)
    } catch {
      // a torn line (a write cut short) is skipped, not fatal
    }
  }
  return out
}

const sameText = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * Joins each routed line with its finished line by job id, newest first. An entry whose task
 * text is already in the labels (routing.local.jsonl) is labelled.
 */
export function foldInbox(inbox: string, labels: string): InboxEntry[] {
  const labelled = new Set(objects(labels).flatMap(o => (typeof o.task === 'string' ? [sameText(o.task)] : [])))
  const byJob = new Map<string, InboxEntry>()
  const ends = new Map<string, Record<string, unknown>>()
  for (const o of objects(inbox)) {
    if (typeof o.job !== 'string') continue
    if (o.kind === 'finished') ends.set(o.job, o)
    if (o.kind !== 'routed' || typeof o.task !== 'string' || byJob.has(o.job)) continue
    byJob.set(o.job, {
      job: o.job,
      at: String(o.at ?? ''),
      task: o.task,
      pick: `${String(o.model)}/${String(o.effort)}, ${String(o.backend)}`,
      isLabelled: labelled.has(sameText(o.task)),
    })
  }
  for (const [id, end] of ends) {
    const entry = byJob.get(id)
    if (entry === undefined) continue
    const cost = typeof end.costUsd === 'number' ? `$${end.costUsd.toFixed(2)}` : ''
    entry.outcome = [String(end.status), `${String(end.minutes)} min`, cost].filter(Boolean).join(', ')
  }
  return [...byJob.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/** /route-inbox: the unlabelled count, then the newest unlabelled tasks, at most `columns` wide. */
export function formatInbox(entries: InboxEntry[], columns: number): string {
  const width = Math.max(1, Math.floor(columns))
  const fit = (s: string) => (s.length > width ? `${s.slice(0, width - 1)}…` : s)
  const open = entries.filter(e => !e.isLabelled)
  const head = `${open.length} of ${entries.length} routed tasks unlabelled (${INBOX_PATH})`
  if (open.length === 0) return fit(head)
  const rows = open.slice(0, SHOW).map(e => {
    const task = sameText(e.task)
    return [e.job, e.pick, e.outcome ?? 'running', task.length > 70 ? `${task.slice(0, 70)}…` : task]
  })
  const cols = ['job', 'pick', 'outcome', 'task']
  const widths = cols.map((h, c) => Math.max(h.length, ...rows.map(r => (r[c] ?? '').length)))
  const line = (cells: string[]) => cells.map((s, c) => s.padEnd(widths[c] ?? 0)).join('  ').trimEnd()
  const out = [head, '', line(cols), ...rows.map(line)]
  if (open.length > SHOW) out.push(`  +${open.length - SHOW} older`)
  return out.map(fit).join('\n')
}
