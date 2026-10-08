// Spawner + job store: the pure halves. The hooks and every `$`-taking
// helper are in jobs.tsx (the engine follows `$` only within one file).
import type { Effort, Job } from '../types'
import { EFFORTS } from './router'
import { projectSlug, SLUG_MAX } from './sessions'

/** Kill handles of the jobs this module environment runs, by job id. */
export const RUNNING = new Map<string, () => void>()

export const TAIL_MAX = 2048
export const RESULT_MAX = 64 * 1024
export const MAX_JOBS = 50

let seq = 0
export function newJobId(now: number): string {
  seq = (seq + 1) % 1296
  return `${now.toString(36).slice(-5)}${seq.toString(36).padStart(2, '0')}`
}

export function pushTail(tail: string, text: string): string {
  const next = tail + text
  return next.length > TAIL_MAX ? next.slice(next.length - TAIL_MAX) : next
}

export function capResult(text: string): string {
  return text.length > RESULT_MAX ? text.slice(0, RESULT_MAX) + '\n…(truncated at 64KB)' : text
}

export function lastLine(text: string): string {
  const lines = text.split('\n').filter(l => l.trim() !== '')
  return lines[lines.length - 1]?.trim() ?? ''
}

/** Splits streamed text into whole lines, keeping the unfinished rest. */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** Running, or a --bg worker paused on a question: either still holds a slot. */
export function isLive(job: Pick<Job, 'status'>): boolean {
  return job.status === 'running' || job.status === 'blocked'
}

export function withJob(list: Job[], id: string, change: (job: Job) => Job): Job[] {
  return list.map(j => (j.id === id ? change(j) : j))
}

export function addJobTo(list: Job[], job: Job): Job[] {
  const next = [...list.filter(j => j.id !== job.id), job]
  // Drop the oldest finished jobs past the cap; running ones always stay.
  while (next.length > MAX_JOBS) {
    const i = next.findIndex(j => !isLive(j))
    if (i < 0) break
    next.splice(i, 1)
  }
  return next
}

/** The user-role meta row a finished job leaves for this session's model. */
export function deliveryText(job: Job, label: string): string {
  const head =
    job.status === 'done'
      ? `${label} finished: ${job.title} (job ${job.id})`
      : `${label} FAILED: ${job.title} (job ${job.id})`
  const body = (job.result ?? lastLine(job.tail)) || '(no output)'
  return `${head}\n\n${capResult(body)}`
}

// ── headless workers: claude -p ... --output-format stream-json ──────────
/**
 * The task never rides argv (a task led by "-" or "--" would parse as a
 * flag): `claude -p` with no prompt argument reads it from stdin, which the
 * caller passes as the spawn's `input`.
 */
export function headlessArgv(bin: string, modelId: string, effort: Effort, permissionMode: string): string[] {
  return [
    bin, '-p', '--model', modelId, '--effort', effort, '--permission-mode', permissionMode,
    '--output-format', 'stream-json', '--verbose',
  ]
}

export type StreamEvent = { tail?: string; result?: string; isError?: boolean; costUsd?: number }

/** One line of `claude -p --output-format stream-json --verbose`. */
export function parseStreamJsonLine(line: string): StreamEvent {
  const trimmed = line.trim()
  if (trimmed === '') return {}
  let o: Record<string, unknown>
  try {
    o = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return { tail: trimmed + '\n' }
  }
  if (o.type === 'system') {
    return o.subtype === 'init' ? { tail: `[init ${String(o.model ?? '')}]\n` } : {}
  }
  if (o.type === 'assistant') {
    const content = (o.message as { content?: unknown } | undefined)?.content
    const out: string[] = []
    if (Array.isArray(content)) {
      for (const b of content as Record<string, unknown>[]) {
        if (b.type === 'text' && typeof b.text === 'string') out.push(b.text)
        else if (b.type === 'tool_use') out.push(`[tool ${String(b.name)}]`)
      }
    }
    return out.length ? { tail: out.join('\n') + '\n' } : {}
  }
  if (o.type === 'result') {
    const result = typeof o.result === 'string' ? o.result : undefined
    const isError = o.is_error === true || (typeof o.subtype === 'string' && o.subtype !== 'success')
    return {
      result: result ?? (isError ? `worker ended: ${String(o.subtype ?? 'error')}` : undefined),
      isError,
      costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined,
    }
  }
  return {}
}

// ── --bg workers: claude --bg, a daemon-managed background session ─────
// Verified with claude 2.1.289 (one real run): `claude --bg ... -- <task>`
// prints "backgrounded · <8-hex id>"; `claude agents --json --all` lists it
// as { id, sessionId, cwd, kind: 'background', state, status? } with state
// 'done' once its turn ended ('blocked' while it waits on a person); `claude
// logs` is raw terminal paint, so the result is read from the transcript
// ~/.claude/projects/<cwd slug>/<sessionId>.jsonl. A --bg session runs in a
// pre-spawned daemon process: the spawning env does NOT reach it, but a
// `--settings '{"env":{...}}'` block does (verified: the worker's Bash saw
// OFFICE_WORKER=1), so that is how workers are marked.

/** The marker every worker this plugin starts carries; the mod skips its spawning tools there. */
export const WORKER_ENV_NAME = 'OFFICE_WORKER'
export const WORKER_ENV_VALUE = '1'
export const WORKER_SETTINGS = JSON.stringify({ env: { [WORKER_ENV_NAME]: WORKER_ENV_VALUE } })

// Seen with claude 2.1.289 (2026-10-05): a worker that finished and wrote its
// report may end at 'blocked', 'working'/'idle' or 'done', so the state alone
// cannot tell "finished" from "waiting on a person". Every worker is told to
// end a finished task's reply with this line; its presence is the contract.
export const DONE_MARKER = '[office: done]'
export const DONE_RULE =
  `When the task is complete, end your final reply with the line ${DONE_MARKER}\n` +
  'If you need an answer from a person, ask it and do not write that line.'

/** The task as a worker gets it: the done rule follows it. */
export function withDoneRule(task: string): string {
  return `${task}\n\n${DONE_RULE}`
}

const isMarkerLine = (line: string) => line.trim().replace(/^[`*_]+|[`*_]+$/g, '') === DONE_MARKER

/** True when the reply's last non-blank line is the done marker. */
export function hasDoneMarker(text: string | undefined): boolean {
  const lines = (text ?? '').split('\n').filter(l => l.trim() !== '')
  const last = lines[lines.length - 1]
  return last !== undefined && isMarkerLine(last)
}

/** The reply without its marker line(s), for delivery. */
export function withoutDoneMarker(text: string): string {
  return text.split('\n').filter(l => !isMarkerLine(l)).join('\n').trimEnd()
}

/** `claude agents --json` states: done ends a job well; these end it badly. */
export const BG_FAILED_STATES: readonly string[] = ['failed', 'stopped', 'error', 'errored', 'killed']
// Seen with claude 2.1.289 (2026-10-05): a worker whose turn ended can stay at
// state 'working' with status 'idle' indefinitely, never reaching 'done'.
export function bgPhase(state: string | undefined, status?: string): 'done' | 'failed' | 'blocked' | 'active' | 'idle' {
  if (state === 'done') return 'done'
  if (state !== undefined && BG_FAILED_STATES.includes(state)) return 'failed'
  if (state === 'blocked') return 'blocked'
  return status === 'idle' ? 'idle' : 'active'
}

export type WorkerMode = 'bg' | 'headless' | 'subagent'
export function isWorkerMode(v: unknown): v is WorkerMode {
  return v === 'bg' || v === 'headless' || v === 'subagent'
}

/** `--` ends the options, so a task led by "-" stays the prompt. */
export function bgArgv(bin: string, modelId: string, effort: Effort, permissionMode: string, task: string): string[] {
  return [
    bin, '--bg', '--model', modelId, '--effort', effort, '--permission-mode', permissionMode,
    '--settings', WORKER_SETTINGS, '--', task,
  ]
}

/** CSI / OSC escape sequences, as a terminal-minded CLI may print them. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
}

export function parseBgId(raw: string): string | undefined {
  const stdout = stripAnsi(raw)
  return (
    stdout.match(/backgrounded\s*\S*\s*([0-9a-f]{6,})/i)?.[1] ??
    stdout.match(/claude (?:attach|logs|stop) ([0-9a-f]{6,})/)?.[1]
  )
}

export type BgAgent = {
  id: string
  sessionId?: string
  cwd?: string
  kind?: string
  state?: string
  status?: string
  startedAt?: number
}

/** When `claude --bg` printed no id: the newest background session in `cwd` started since `since`. */
export function newestBgSince(agents: readonly BgAgent[], cwd: string, since: number): BgAgent | undefined {
  return agents
    .filter(a => a.kind === 'background' && a.cwd === cwd && (a.startedAt ?? 0) >= since)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
}

/** A --bg session this plugin started, and the model it runs (none for ids stored before models were kept). */
export type BgEntry = { id: string; model?: string }

/** The stored --bg entries; the old format, a list of bare ids, reads as entries with no model. */
export function parseBgStore(stored: unknown): BgEntry[] {
  if (!Array.isArray(stored)) return []
  return stored.flatMap((x): BgEntry[] => {
    if (typeof x === 'string') return [{ id: x }]
    if (typeof x !== 'object' || x === null || typeof (x as BgEntry).id !== 'string') return []
    const model = (x as BgEntry).model
    return [typeof model === 'string' ? { id: (x as BgEntry).id, model } : { id: (x as BgEntry).id }]
  })
}

export function parseAgentsJson(text: string): BgAgent[] {
  try {
    const raw = JSON.parse(text) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((a): a is BgAgent => typeof a === 'object' && a !== null && typeof (a as BgAgent).id === 'string')
  } catch {
    return []
  }
}

/**
 * ~/.claude/projects/<slug>/<sessionId>.jsonl, the slug by sessions.ts's rule.
 * A slug past SLUG_MAX is cut and hashed by the engine: then `prefix` is the
 * directory-name start to look for, and `path` is undefined.
 */
export function transcriptPath(
  configDir: string,
  cwd: string,
  sessionId: string,
): { path?: string; projects: string; prefix?: string } {
  const projects = `${configDir.replace(/\/$/, '')}/projects`
  const slug = projectSlug(cwd)
  if (slug.length <= SLUG_MAX) return { path: `${projects}/${slug}/${sessionId}.jsonl`, projects }
  return { projects, prefix: `${slug.slice(0, SLUG_MAX)}-` }
}

/** A transcript's tail: the last assistant text (the result) and a progress tail. */
export function readTranscript(text: string): { result?: string; tail: string } {
  const lines: string[] = []
  let result: string | undefined
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let o: { type?: string; message?: { content?: unknown } }
    try {
      o = JSON.parse(line) as typeof o
    } catch {
      continue // the first line of a cut tail
    }
    if (o.type !== 'assistant') continue
    const content = o.message?.content
    if (!Array.isArray(content)) continue
    const texts: string[] = []
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text)
      else if (b.type === 'tool_use') lines.push(`[tool ${String(b.name)}]`)
    }
    if (texts.length) {
      result = texts.join('\n')
      lines.push(result)
    }
  }
  return { result, tail: lines.join('\n').slice(-TAIL_MAX) }
}

/** `/spawn [--force] [--mode m] [--model x] [--effort e] [--] <task>`; --force starts past the budget's hard limit. */
export function parseSpawnArgs(raw: string): {
  task: string
  mode?: string
  model?: string
  effort?: string
  force?: true
} {
  const out: { task: string; mode?: string; model?: string; effort?: string; force?: true } = { task: '' }
  let rest = raw.trim()
  for (;;) {
    const f = rest.match(/^--force(?:\s+|$)/)
    if (f) {
      out.force = true
      rest = rest.slice(f[0].length)
      continue
    }
    const m = rest.match(/^--(mode|model|effort)(?:=|\s+)(\S+)\s*/)
    if (!m) break
    const key = m[1] as 'mode' | 'model' | 'effort'
    out[key] = m[2]
    rest = rest.slice(m[0].length)
  }
  if (rest.startsWith('-- ')) rest = rest.slice(3)
  out.task = rest.trim()
  return out
}

// ── subagent workers: one agent type per effort (AgentSpawnArgs has no
// `effort`; an agent definition does) ─────────────────────────────────────
export function workerAgentName(effort: Effort): string {
  return `worker-${effort}`
}
export const WORKER_AGENT_PROMPT = [
  'You are a focused worker agent dispatched by the office router.',
  'Do exactly the task you are given, using the tools you have.',
  'Finish with a concise report: what you did, what you found, and any files you changed (absolute paths).',
].join('\n')
export const WORKER_AGENT_SPECS = EFFORTS.map(effort => ({
  name: workerAgentName(effort),
  description: `office worker at ${effort} effort (spawned by the office plugin's router; not for direct use)`,
  prompt: WORKER_AGENT_PROMPT,
  effort,
  background: true as const,
}))

// ── tool and command specs ───────────────────────────────────────────────
export const SPAWN_TOOL = {
  name: 'spawn_worker',
  description:
    'Start a background worker on a self-contained task: a `claude --bg` background session (default), a headless `claude -p` process, or a subagent. ' +
    'With no model, the office router picks the cheapest adequate model tier and effort (at most high). Returns a job id at once; ' +
    'the worker result is appended to this conversation when it finishes (watch it in /jobs).',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The whole task, self-contained: the worker has none of this context.' },
      mode: { type: 'string', enum: ['bg', 'headless', 'subagent'], description: 'Default bg.' },
      model: { type: 'string', description: 'haiku | sonnet | opus | fable, or a full model id. Omit to route (the router picks haiku, sonnet or opus; fable only when named).' },
      effort: {
        type: 'string',
        enum: [...EFFORTS],
        description: 'Omit to route (low/medium/high). xhigh/max only when the user explicitly asks.',
      },
      cwd: { type: 'string', description: 'Working directory (absolute); default the session cwd.' },
    },
    required: ['task'],
  },
}

export const ROUTE_TOOL = {
  name: 'route_task',
  description:
    'Dry run of the office router: which model tier (haiku/sonnet/opus) and effort a task should get, with confidence, reason and which backend decided. Starts nothing.',
  inputSchema: {
    type: 'object',
    properties: { task: { type: 'string' } },
    required: ['task'],
  },
}
