import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, Timer } from 'claude-code'

import type { Effort, EvalReport, Job, RouteCase, RouteDecision, RouteOutcome } from '../types'
import { formatReport, parseCases, scoreRoutes } from './evals'
import {
  CODEX_EXEC_TOOL,
  CODEX_LOGIN_HINT,
  CODEX_REVIEW_TOOL,
  codexEventText,
  codexExecArgv,
  codexFailureHint,
  codexReviewArgv,
  codexQuotaMessage,
  codexReviewPrompt,
  CODEX_DEFAULTS,
  defaultReviewTarget,
  parseReviewTarget,
  splitDeep,
} from './codex'
import type { CodexTier, ReviewTarget } from './codex'
import {
  CLAUDE_SYSTEM,
  claudePrompt,
  isEffort,
  jevRequestBody,
  MODEL_IDS,
  modelIdFor,
  parseClaudeRoute,
  parseJevResponse,
  rulesRoute,
} from './router'
import type { Routed } from './router'
import {
  addJobTo,
  bgArgv,
  bgPhase,
  capResult,
  deliveryText,
  formatElapsed,
  headlessArgv,
  lastLine,
  isLive,
  isWorkerMode,
  newestBgSince,
  newJobId,
  parseAgentsJson,
  parseBgId,
  parseSpawnArgs,
  parseStreamJsonLine,
  pushTail,
  readTranscript,
  ROUTE_TOOL,
  RUNNING,
  SPAWN_TOOL,
  takeLines,
  transcriptPath,
  withJob,
  WORKER_AGENT_SPECS,
  WORKER_ENV_NAME,
  WORKER_ENV_VALUE,
  workerAgentName,
} from './spawn'
import type { WorkerMode } from './spawn'

// Owner: jobs agent. Codex handoff, router, worker spawner, jobs pane.
// codex.ts, router.ts and spawn.ts hold the pure halves; every hook and
// every `$`-taking helper is here, since the engine follows `$` only into
// functions declared in the same file.
//
// Long-running work: a tool or command hook returns within a second or two
// with a job id. The 10 s hook budget would not count a minutes-long `$`
// wait, but awaiting it would hold the model's turn for the whole review,
// and Esc on that turn aborts `next.signal`, which kills the child. So the
// child runs from a `$.clock.after(0)` timer, detached from the dispatch,
// streams into $.state, and hands its result back with `$.session.append`
// (a user-role meta row), plus a short `$.prompt.submit` when the session
// is idle so the model reacts to it.

// Atoms live here: the validator reads a state source only in the file using it.
const JOBS = atom({ plugin: 'office', key: 'jobs' } as const, [] as Job[])
const LAST_ROUTE = atom({ plugin: 'office', key: 'lastRoute' } as const, null)
// Read by the jobs pane alone, so bumping it redraws that pane and nothing else.
const TICK = atom({ plugin: 'office', key: 'jobsTick' } as const, 0)

const PANE = 'jobs'
const FLUSH_MS = 400
const JEV_TIMEOUT_MS = 5000
const BG_POLL_MS = 5000
const KEY_RETRY_MS = 60_000

/** The Jev key once resolved, for the module's life; a miss is re-tried at most once a minute. Never logged or stored. */
let jevKeyCache: { key?: string; at: number } | undefined
const WORKER_ENV = { [WORKER_ENV_NAME]: WORKER_ENV_VALUE }
/** $.store key: the --bg ids this plugin started (counted against maxWorkers across sessions). */
const BG_STORE_KEY = 'bgIds'

type Input = Record<string, unknown>
type LineEvent = { tail?: string; result?: string; isError?: boolean; error?: string }
type RunPlan = {
  argv: string[]
  cwd: string
  input?: string
  label: string
  parse: (line: string) => LineEvent
  outFile?: string
  codexModel?: string // set for codex runs: names the model in a quota failure
}
type Started = { ok: boolean; text: string }

/** Subagent workers awaiting their turn.complete: agentId → job id. */
const SUBAGENT_JOBS = new Map<string, string>()
/** --bg workers being polled: job id → the short id `claude --bg` printed. */
const BG_JOBS = new Map<string, string>()
let bgPolling = false
/** --bg jobs absent from one `claude agents` listing: one miss is forgiven. */
const BG_MISSES = new Map<string, number>()
/** Time a job spent blocked (its timeout is paused meanwhile), and when its current block began. */
const PAUSED_MS = new Map<string, number>()
const BLOCKED_AT = new Map<string, number>()
/** Max-runtime timers of running jobs, by job id. */
const TIMERS = new Map<string, Timer>()
/** Whether the main loop is mid-turn (an appended row is then read at once). */
let mainTurnRunning = false

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}
function opt(options: PluginOptions, key: string, fallback: string): string {
  const v = options[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
}
function num(options: PluginOptions, key: string, fallback: number): number {
  const v = options[key]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}
function codexLine(line: string): LineEvent {
  const ev = codexEventText(line)
  return { tail: ev.tail, result: ev.message, isError: ev.error !== undefined, error: ev.error }
}
function describeRoute(d: RouteDecision): string {
  return `${d.model} (${MODEL_IDS[d.model]}) at ${d.effort} effort · confidence ${d.confidence.toFixed(2)} · ${d.backend} in ${d.latencyMs}ms · ${d.reason}`
}
function labelOf(job: Job): string {
  return job.kind === 'codex-review' ? 'Codex review' : job.kind === 'codex-exec' ? 'Codex second opinion' : 'Worker'
}

export function installJobs(on: On, options: PluginOptions) {
  // A distinct matcher: the module holds other session.start hooks.
  on('session.start', { cwd: /^\// }, async ($, e, next) => {
    const started = await next(e)
    // A worker this plugin spawned must not spawn or review in turn.
    const isWorker = (await $.env.get('OFFICE_WORKER')) !== undefined
    if (!isWorker) {
      await $.tool.register(CODEX_REVIEW_TOOL)
      await $.tool.register(CODEX_EXEC_TOOL)
      await $.tool.register(SPAWN_TOOL)
      await $.tool.register(ROUTE_TOOL)
      await $.command.register({
        name: 'codex-review',
        description: 'Codex reviews this repo in the background (dirty tree: uncommitted; else vs main/master)',
        argumentHint: '[--deep] [base|--uncommitted|--commit <sha>]',
      })
      await $.command.register({
        name: 'spawn',
        description: 'Route a task to a model tier and run it as a claude --bg worker',
        argumentHint: '[--mode bg|headless|subagent] [--model m] [--effort e] <task>',
      })
      await $.command.register({
        name: 'route-task',
        description: 'Dry run: which model tier and effort the router picks for a task',
        argumentHint: '<task>',
      })
      await $.command.register({
        name: 'route-eval',
        description: 'Score the router against the labeled tasks in evals/routing.jsonl',
        argumentHint: '[rules|claude|jev|all]',
      })
      for (const spec of WORKER_AGENT_SPECS) {
        try {
          await $.agent.register(spec)
        } catch (err) {
          $.ui.log(`office: agent ${spec.name} not registered: ${String(err)}`, { to: 'debug' })
        }
      }
    }
    await $.command.register({ name: 'jobs', description: 'Open the jobs pane (codex reviews, workers)' })
    await sweepAfterLoad($, options)
    // Keep elapsed times moving while anything runs: only the jobs pane reads TICK.
    $.clock.every(2000, () => {
      if (RUNNING.size > 0) void update($, TICK, n => (n + 1) % 1_000_000)
    })
    // --bg workers live outside this process: poll `claude agents --json`.
    $.clock.every(BG_POLL_MS, () => {
      if (BG_JOBS.size > 0 && !bgPolling) void pollBg($, options)
    })
    return started
  })

  on('agent.offer', { agent: /^office:worker-/ }, () => ({ isOffered: false }))

  // ── tools ───────────────────────────────────────────────────────────────
  on('tool.call', { tool: 'mcp__office__codex_review' }, async ($, e) => {
    const input = e as unknown as Input
    const deep = input.deep === true
    const msg = await startCodexReview($, options, str(input.target), str(input.instructions), str(input.cwd), deep)
    return msg.ok ? { result: msg.text } : { deny: msg.text }
  })

  on('tool.call', { tool: 'mcp__office__codex_exec' }, async ($, e) => {
    const input = e as unknown as Input
    const prompt = str(input.prompt)
    if (!prompt) return { deny: 'codex_exec needs a prompt.' }
    const msg = await startCodexExec($, options, prompt, str(input.cwd))
    return msg.ok ? { result: msg.text } : { deny: msg.text }
  })

  on('tool.call', { tool: 'mcp__office__spawn_worker' }, async ($, e) => {
    const input = e as unknown as Input
    const task = str(input.task)
    if (!task) return { deny: 'spawn_worker needs a task.' }
    const mode: WorkerMode = isWorkerMode(input.mode) ? input.mode : 'bg'
    const msg = await startWorker($, options, task, mode, str(input.model), input.effort, str(input.cwd))
    return msg.ok ? { result: msg.text } : { deny: msg.text }
  })

  on('tool.call', { tool: 'mcp__office__route_task' }, async ($, e) => {
    const task = str((e as unknown as Input).task)
    if (!task) return { deny: 'route_task needs a task.' }
    return { result: describeRoute(await route($, options, task)) }
  })

  // ── commands ────────────────────────────────────────────────────────────
  on('command.run', { command: 'codex-review' }, async ($, e) => {
    const { deep, rest } = splitDeep(e.args)
    const msg = await startCodexReview($, options, str(rest), undefined, undefined, deep)
    return { text: msg.text }
  })

  on('command.run', { command: 'spawn' }, async ($, e) => {
    const args = parseSpawnArgs(e.args)
    if (!args.task) return { text: 'Usage: /spawn [--mode bg|headless|subagent] [--model m] [--effort e] <task>' }
    if (args.mode !== undefined && !isWorkerMode(args.mode)) return { text: `Unknown mode "${args.mode}".` }
    if (args.effort !== undefined && !isEffort(args.effort)) return { text: `Unknown effort "${args.effort}".` }
    const mode: WorkerMode = isWorkerMode(args.mode) ? args.mode : 'bg'
    const msg = await startWorker($, options, args.task, mode, args.model, args.effort, undefined)
    return { text: msg.text }
  })

  on('command.run', { command: 'route-task' }, async ($, e) => {
    const task = str(e.args)
    if (!task) return { text: 'Usage: /route-task <task>' }
    return { text: describeRoute(await route($, options, task)) }
  })

  on('command.run', { command: 'route-eval' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase() || 'all'
    if (!EVAL_BACKENDS.includes(asked) && asked !== 'all') return { text: 'Usage: /route-eval [rules|claude|jev|all]' }
    const file = `${$.plugin.root}/evals/routing.jsonl`
    let text: string
    try {
      text = await $.fs.read(file)
    } catch {
      return { text: `No labeled tasks at ${file}.` }
    }
    const { cases, errors } = parseCases(text)
    if (cases.length === 0) return { text: `No usable cases in ${file}. ${errors.slice(0, 3).join('; ')}` }

    const now = Date.now()
    const jevKey = asked === 'jev' || asked === 'all' ? await resolveJevKey($, options) : undefined
    if (asked === 'jev' && !jevKey) return { text: 'No Jev key (Keychain service aimlapi, jevApiKey, or AIMLAPI_KEY).' }
    // all: every backend that can answer now; Jev joins once a key exists.
    const backends = asked === 'all' ? (jevKey ? EVAL_BACKENDS : EVAL_BACKENDS.filter(b => b !== 'jev')) : [asked]

    const reports: EvalReport[] = []
    const saved: string[] = []
    for (const backend of backends as RouteDecision['backend'][]) {
      const outcomes = await evalBackend($, options, backend, cases, jevKey, now)
      const report = scoreRoutes(cases, outcomes, backend)
      reports.push(report)
      // A dated record, so a later run (a new rubric, Jev) has something to compare against.
      const out = `${$.plugin.root}/evals/results/${new Date(now).toISOString().replace(/[:.]/g, '-')}-${backend}.json`
      try {
        await $.fs.write(out, JSON.stringify({ at: now, backend, report, outcomes }, null, 2))
        saved.push(out)
      } catch {
        // the table below is the result; a record that could not be written is not worth failing for
      }
    }
    const notes = [
      errors.length > 0 ? `${errors.length} line(s) skipped: ${errors.slice(0, 2).join('; ')}` : '',
      asked === 'all' && !jevKey ? 'Jev skipped: no key yet.' : '',
      saved.length > 0 ? `Saved under ${$.plugin.root}/evals/results/` : '',
    ].filter(Boolean)
    return { text: [formatReport(reports, e.presentation.columns), ...notes].join('\n') }
  })

  on('command.run', { command: 'jobs' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Jobs', focus: true })
    return { text: 'Jobs pane opened.' }
  })

  // ── turns: the main loop's idleness; subagent workers' answers ─────────
  on('turn.start', ($, e, next) => {
    mainTurnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined) {
      mainTurnRunning = false
      return next(e)
    }
    const jobId = SUBAGENT_JOBS.get(agentId)
    if (jobId !== undefined) {
      const ok = e.reason === 'answer'
      await finishJob($, jobId, ok ? 'done' : 'failed', e.answer || `worker ended: ${e.reason}`)
    }
    return next(e)
  })

  // ── the pane ────────────────────────────────────────────────────────────
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, TICK) // subscribes this pane alone to the elapsed-time tick
    const jobs = [...(await read($, JOBS))].reverse()
    const now = Date.now()
    const cols = Math.max(30, e.props.bodyColumns)
    const rows = Math.max(8, (e.viewport?.rows ?? 30) - 4)
    const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s)
    const selected = jobs.find(j => j.isSelected)

    const select = (id: string) =>
      update($, JOBS, list => list.map(j => ({ ...j, isSelected: j.id === id ? !j.isSelected : false })))

    const listRows = selected ? Math.min(jobs.length, Math.max(3, Math.floor(rows / 3))) : rows
    const detail = selected ? (selected.result ?? selected.tail) : ''
    const detailLines = detail.split('\n').slice(-Math.max(3, rows - listRows - 4))

    return (
      <Box flexDirection="column">
        {jobs.length === 0 && (
          <Text dimColor>No jobs yet. /codex-review, /spawn, or the codex_review / spawn_worker tools start one.</Text>
        )}
        {jobs.slice(0, listRows).map(job => {
          const glyph = job.status === 'running' ? '●' : job.status === 'blocked' ? '?' : job.status === 'done' ? '✓' : '✗'
          const color =
            job.status === 'running' ? 'yellow' : job.status === 'blocked' ? 'magenta' : job.status === 'done' ? 'green' : 'red'
          const elapsed = formatElapsed((job.endedAt ?? now) - job.startedAt)
          const me = [job.model?.replace(/^claude-/, ''), job.effort].filter(Boolean).join('/')
          const line = `${job.kind} ${job.title}${me ? ` · ${me}` : ''} · ${elapsed} · ${lastLine(job.result ?? job.tail)}`
          return (
            <Box key={`row-${job.id}`} flexDirection="row">
              <Text color={color}>{glyph} </Text>
              <Button key={`job-${job.id}`} plain dimColor={!job.isSelected} onPress={() => void select(job.id)}>
                {clip(line, cols - 3)}
              </Button>
            </Box>
          )
        })}
        {selected && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{clip(`${selected.title} (${selected.id}, ${selected.status}) in ${selected.cwd}`, cols)}</Text>
            {selected.route && <Text dimColor>{clip(describeRoute(selected.route), cols)}</Text>}
            <Box flexDirection="row">
              {isLive(selected) && (
                <Button key="kill" hotkey="k" onPress={() => void killJob($, selected.id, 'killed')}>
                  kill
                </Button>
              )}
              {selected.bgId !== undefined && (
                <Button
                  key="attach"
                  hotkey="a"
                  onPress={press => void $.ui.copy({ text: `claude attach ${selected.bgId}`, surface: press.surface })}
                >
                  copy attach
                </Button>
              )}
              <Button
                key="copy"
                hotkey="c"
                onPress={press => void $.ui.copy({ text: selected.result ?? selected.tail, surface: press.surface })}
              >
                copy
              </Button>
            </Box>
            <Text dimColor>{selected.result !== undefined ? 'result:' : 'output (tail):'}</Text>
            {detailLines.map((l, i) => (
              <Text key={`d-${i}`} wrap="truncate-end">
                {l || ' '}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}

// ── routing ($ halves; the rubric and parsers are in router.ts) ──────────

const EVAL_BACKENDS = ['rules', 'claude', 'jev']
const EVAL_BATCH = 5 // model calls in flight at once while scoring

/** One backend's answer for every case, with no fallback: a miss is that backend's miss. */
async function evalBackend(
  $: EngineInterface,
  options: PluginOptions,
  backend: RouteDecision['backend'],
  cases: RouteCase[],
  jevKey: string | undefined,
  now: number,
): Promise<RouteOutcome[]> {
  const one = async (c: RouteCase): Promise<RouteOutcome> => {
    const t0 = Date.now()
    const got =
      backend === 'rules'
        ? rulesRoute(c.task, now)
        : backend === 'jev'
          ? jevKey
            ? await routeJev($, options, jevKey, c.task, now)
            : 'no key'
          : await routeClaude($, options, c.task, now)
    if (typeof got === 'string') return { id: c.id, error: got }
    return { id: c.id, model: got.model, effort: got.effort, latencyMs: Date.now() - t0 }
  }
  const outcomes: RouteOutcome[] = []
  for (let i = 0; i < cases.length; i += EVAL_BATCH) {
    outcomes.push(...(await Promise.all(cases.slice(i, i + EVAL_BATCH).map(one))))
  }
  return outcomes
}

async function route($: EngineInterface, options: PluginOptions, task: string): Promise<RouteDecision> {
  const now = Date.now()
  const forced = opt(options, 'routerBackend', 'auto')
  const wantsJev = forced === 'auto' || forced === 'jev'
  const jevKey = wantsJev ? await resolveJevKey($, options) : undefined
  // auto skips Jev outright without a key: no request, no 5 s wait.
  const order =
    forced === 'auto' ? (jevKey ? ['jev', 'claude'] : ['claude']) : forced === 'rules' ? [] : [forced]
  const misses: string[] = []
  let decision: RouteDecision | undefined
  for (const backend of order) {
    const t0 = Date.now()
    const got =
      backend === 'jev'
        ? jevKey
          ? await routeJev($, options, jevKey, task, now)
          : 'no key (Keychain service aimlapi, jevApiKey, or AIMLAPI_KEY)'
        : await routeClaude($, options, task, now)
    if (typeof got === 'string') {
      misses.push(`${backend}: ${got}`)
      continue
    }
    decision = { ...got, backend: backend === 'jev' ? 'jev' : 'claude', latencyMs: Date.now() - t0 }
    break
  }
  if (decision === undefined) {
    const t0 = Date.now()
    const r = rulesRoute(task, now)
    const reason = misses.length === 0 ? r.reason : `${r.reason} [${misses.join('; ')}]`
    decision = { ...r, reason, backend: 'rules', latencyMs: Date.now() - t0 }
  }
  const stored = decision
  await update($, LAST_ROUTE, () => stored)
  return stored
}

/**
 * The AI/ML API key: the macOS Keychain (service "aimlapi"), then the
 * jevApiKey option, then $AIMLAPI_KEY. The key and the security command's
 * stderr are never logged, toasted or written to state.
 */
async function resolveJevKey($: EngineInterface, options: PluginOptions): Promise<string | undefined> {
  const now = Date.now()
  if (jevKeyCache?.key) return jevKeyCache.key
  if (jevKeyCache && now - jevKeyCache.at < KEY_RETRY_MS) return undefined
  let key: string | undefined
  try {
    const r = await $.process.run(['security', 'find-generic-password', '-s', 'aimlapi', '-w'], { timeoutMs: 5000 })
    if (r.exitCode === 0 && r.stdout.trim()) key = r.stdout.trim()
  } catch {
    // no `security` (not macOS) or it hung: fall through
  }
  if (!key && typeof options.jevApiKey === 'string' && options.jevApiKey.trim()) key = options.jevApiKey.trim()
  if (!key) key = (await $.env.get('AIMLAPI_KEY').catch(() => undefined))?.trim() || undefined
  jevKeyCache = { key, at: now }
  return key
}

/** TypeSafe Jev on AI/ML API, raced against 5 s; a string says why it gave no decision. */
async function routeJev(
  $: EngineInterface,
  options: PluginOptions,
  key: string,
  task: string,
  now: number,
): Promise<Routed | string> {
  const url = opt(options, 'jevEndpoint', 'https://api.aimlapi.com/v1/decisions')
  const fetching = $.http.fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: jevRequestBody(task, now),
  })
  fetching.catch(() => undefined) // a late failure after the timeout is nobody's
  let timer: Timer | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = $.clock.after(JEV_TIMEOUT_MS, () => resolve('timeout'))
  })
  try {
    const res = await Promise.race([fetching, timeout])
    if (res === 'timeout') return `timed out after ${JEV_TIMEOUT_MS / 1000}s`
    if (!res.ok) return `HTTP ${res.status}`
    return parseJevResponse(res.text, now) ?? 'unparseable reply'
  } catch {
    return 'request failed'
  } finally {
    timer?.cancel()
  }
}

async function routeClaude($: EngineInterface, options: PluginOptions, task: string, now: number): Promise<Routed | string> {
  const model = opt(options, 'routerModel', MODEL_IDS.sonnet)
  try {
    const r = await $.model.complete({
      model,
      system: CLAUDE_SYSTEM,
      prompt: claudePrompt(task, now),
      maxTokens: 300,
      effort: 'low',
      timeoutMs: 20000,
    })
    if (!r.isAnswered) return r.reason === 'api-error' ? `api-error ${r.error}` : r.reason
    return parseClaudeRoute(r.text, now) ?? 'unparseable reply'
  } catch (err) {
    return `refused: ${String(err).slice(0, 120)}`
  }
}

// ── job store ───────────────────────────────────────────────────────────

async function addJob($: EngineInterface, job: Job): Promise<void> {
  await update($, JOBS, list => addJobTo(list, job))
}

async function patchJob($: EngineInterface, id: string, change: (job: Job) => Job): Promise<void> {
  await update($, JOBS, list => withJob(list, id, change))
}

/** Ends a running job once (a later finish is a no-op) and delivers it. */
async function finishJob($: EngineInterface, id: string, status: 'done' | 'failed', result: string): Promise<void> {
  TIMERS.get(id)?.cancel()
  TIMERS.delete(id)
  RUNNING.delete(id)
  BG_JOBS.delete(id)
  BG_MISSES.delete(id)
  PAUSED_MS.delete(id)
  BLOCKED_AT.delete(id)
  const before = (await read($, JOBS)).find(j => j.id === id)
  if (before === undefined || !isLive(before)) return
  if (before.agentId !== undefined) SUBAGENT_JOBS.delete(before.agentId)
  const endedAt = Date.now()
  const capped = capResult(result)
  const list = await update($, JOBS, jobs =>
    withJob(jobs, id, j => (isLive(j) ? { ...j, status, endedAt, result: capped } : j)),
  )
  const finished = list.find(j => j.id === id)
  if (finished === undefined || finished.endedAt !== endedAt) return
  await deliver($, finished)
}

/** Appends the result for the model; wakes an idle session with a short prompt. */
async function deliver($: EngineInterface, job: Job): Promise<void> {
  const label = labelOf(job)
  const verb = job.status === 'done' ? 'finished' : 'failed'
  $.ui.toast(`${label} ${verb}: ${job.title}`)
  await notifyModel($, job.id, deliveryText(job, label), `${label} ${job.id} ${verb}: see above.`)
}

/** A user-role meta row for the model; if refused, the text as a prompt; if idle, a short nudge. */
async function notifyModel($: EngineInterface, jobId: string, text: string, nudge: string): Promise<void> {
  let appended = false
  try {
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    appended = r.deny === undefined
    if (!appended) $.ui.log(`office: job ${jobId} delivery refused: ${r.deny ?? ''}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`office: could not deliver job ${jobId}: ${String(err)}`, { to: 'debug' })
  }
  try {
    if (!appended) await $.prompt.submit({ text })
    else if (!mainTurnRunning) await $.prompt.submit({ text: nudge })
  } catch (err) {
    $.ui.log(`office: could not wake the session for job ${jobId}: ${String(err)}`, { to: 'debug' })
  }
}

/**
 * maxWorkers counts this process's own jobs (codex, headless, subagent) plus
 * every live --bg session this plugin started, from any session (ids in $.store).
 */
async function capacityError($: EngineInterface, options: PluginOptions): Promise<string | undefined> {
  const max = num(options, 'maxWorkers', 4)
  const local = [...RUNNING.keys()].filter(id => !BG_JOBS.has(id)).length
  let bg = 0
  const stored = await $.store.get(BG_STORE_KEY).catch(() => undefined)
  const ids = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
  if (ids.length > 0) {
    const listed = await $.process
      .run([opt(options, 'claudePath', 'claude'), 'agents', '--json', '--all'], { timeoutMs: 20000 })
      .catch(() => undefined)
    if (listed !== undefined && listed.exitCode === 0) {
      const agents = parseAgentsJson(listed.stdout).filter(a => ids.includes(a.id))
      bg = agents.filter(a => { const p = bgPhase(a.state); return p === 'active' || p === 'blocked' }).length
      const kept = agents.map(a => a.id)
      if (kept.length !== ids.length) await $.store.set(BG_STORE_KEY, kept).catch(() => undefined)
    } else {
      bg = BG_JOBS.size // cannot list: count what this process knows
    }
  }
  const used = local + bg
  return used >= max ? `${used} jobs already running (maxWorkers ${max}); wait for one or kill it in /jobs.` : undefined
}

async function rememberBgId($: EngineInterface, bgId: string): Promise<void> {
  const stored = await $.store.get(BG_STORE_KEY).catch(() => undefined)
  const ids = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
  if (!ids.includes(bgId)) await $.store.set(BG_STORE_KEY, [...ids, bgId].slice(-200)).catch(() => undefined)
}

/** Kill (or timeout): stop the work and mark the job failed right away. */
async function killJob($: EngineInterface, id: string, why: string): Promise<void> {
  RUNNING.get(id)?.()
  await finishJob($, id, 'failed', why)
}

/** (Re)arms a job's max-runtime timer; time spent blocked does not count. */
function startTimeout($: EngineInterface, options: PluginOptions, id: string, startedAt: number): void {
  const minutes = num(options, 'jobTimeoutMin', 30)
  const left = Math.max(1000, startedAt + (PAUSED_MS.get(id) ?? 0) + minutes * 60_000 - Date.now())
  TIMERS.get(id)?.cancel()
  TIMERS.set(id, $.clock.after(left, () => void killJob($, id, `timed out after ${minutes} min (jobTimeoutMin)`)))
}

/** Registers a subagent job's kill handle, its answer route and its timeout. */
function adoptSubagent($: EngineInterface, options: PluginOptions, job: Job, agentId: string): void {
  SUBAGENT_JOBS.set(agentId, job.id)
  RUNNING.set(job.id, () => {
    SUBAGENT_JOBS.delete(agentId)
    void $.tool.call({ tool: 'TaskStop', task_id: agentId }).catch(() => undefined)
  })
  startTimeout($, options, job.id, job.startedAt)
}

/** Registers a --bg job's kill handle (`claude stop`), its polling and its timeout. */
function adoptBg($: EngineInterface, options: PluginOptions, job: Job, bgId: string): void {
  BG_JOBS.set(job.id, bgId)
  RUNNING.set(job.id, () => {
    BG_JOBS.delete(job.id)
    void $.process.run([opt(options, 'claudePath', 'claude'), 'stop', bgId]).catch(() => undefined)
  })
  startTimeout($, options, job.id, job.startedAt)
}

/** One poll of every --bg job: state from `claude agents`, result from the transcript. */
async function pollBg($: EngineInterface, options: PluginOptions): Promise<void> {
  bgPolling = true
  try {
    const bin = opt(options, 'claudePath', 'claude')
    const listed = await $.process.run([bin, 'agents', '--json', '--all'], { timeoutMs: 20000 }).catch(() => undefined)
    if (listed === undefined || listed.exitCode !== 0) return
    const agents = parseAgentsJson(listed.stdout)
    const jobs = await read($, JOBS)
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
    for (const [jobId, bgId] of [...BG_JOBS]) {
      const job = jobs.find(j => j.id === jobId)
      if (job === undefined || !isLive(job)) {
        BG_JOBS.delete(jobId)
        continue
      }
      const agent = agents.find(a => a.id === bgId)
      if (agent === undefined) {
        const misses = (BG_MISSES.get(jobId) ?? 0) + 1
        BG_MISSES.set(jobId, misses)
        if (misses >= 2) await finishJob($, jobId, 'failed', `background session ${bgId} is gone (stopped or removed)`)
        continue
      }
      BG_MISSES.delete(jobId)
      let seen: { result?: string; tail: string } = { tail: '' }
      if (agent.sessionId !== undefined) {
        const path = await bgTranscript($, configDir, agent.cwd ?? job.cwd, agent.sessionId)
        const t = path
          ? await $.process.run(['tail', '-c', '262144', path], { timeoutMs: 10000 }).catch(() => undefined)
          : undefined
        if (t !== undefined && t.exitCode === 0) seen = readTranscript(t.stdout)
      }
      const phase = bgPhase(agent.state)
      if (phase === 'done') {
        await finishJob($, jobId, 'done', seen.result ?? '(the session ended without a reply)')
        // The conversation is kept; the idle ~300 MB process is not needed.
        void $.process.run([bin, 'stop', bgId], { timeoutMs: 20000 }).catch(() => undefined)
        continue
      }
      if (phase === 'failed') {
        const last = seen.result ? `\nLast reply:\n${seen.result}` : ''
        await finishJob($, jobId, 'failed', `background session ${bgId} ended: ${agent.state}${last}`)
        continue
      }
      if (phase === 'blocked' && job.status === 'running') {
        // Pause the timeout and tell the model once per block.
        TIMERS.get(jobId)?.cancel()
        TIMERS.delete(jobId)
        BLOCKED_AT.set(jobId, Date.now())
        await patchJob($, jobId, j => ({ ...j, status: 'blocked', tail: seen.tail || j.tail, sessionId: agent.sessionId ?? j.sessionId }))
        const latest = seen.result ? `\n\nLatest reply:\n${seen.result}` : ''
        const text = `Worker ${jobId} (${job.title}) is waiting for input: \`claude attach ${bgId}\`${latest}`
        $.ui.toast(`Worker waiting for input: claude attach ${bgId}`)
        await notifyModel($, jobId, text, `Worker ${jobId} is waiting for input: see above.`)
        continue
      }
      if (phase === 'active' && job.status === 'blocked') {
        const since = BLOCKED_AT.get(jobId)
        BLOCKED_AT.delete(jobId)
        if (since !== undefined) PAUSED_MS.set(jobId, (PAUSED_MS.get(jobId) ?? 0) + Date.now() - since)
        await patchJob($, jobId, j => ({ ...j, status: 'running' }))
        startTimeout($, options, jobId, job.startedAt)
      }
      const tail = seen.tail.slice(-2048)
      if (tail && (tail !== job.tail || agent.sessionId !== job.sessionId)) {
        await patchJob($, jobId, j => ({ ...j, tail, sessionId: agent.sessionId ?? j.sessionId }))
      }
    }
  } finally {
    bgPolling = false
  }
}

/** The transcript of a --bg session; a long (cut + hashed) slug is found by its prefix. */
async function bgTranscript($: EngineInterface, configDir: string, cwd: string, sessionId: string): Promise<string | undefined> {
  const where = transcriptPath(configDir, cwd, sessionId)
  if (where.path !== undefined) return where.path
  const dirs = await $.fs.list(where.projects).catch(() => [])
  const hit = dirs.find(entry => entry.kind === 'dir' && entry.name.startsWith(where.prefix ?? '\u0000'))
  return hit ? `${where.projects}/${hit.name}/${sessionId}.jsonl` : undefined
}

/** After a (re)load: re-adopt live subagent and --bg jobs, fail the rest that "run". */
async function sweepAfterLoad($: EngineInterface, options: PluginOptions): Promise<void> {
  const jobs = await read($, JOBS)
  const stale = jobs.filter(j => isLive(j) && !RUNNING.has(j.id))
  if (stale.length === 0) return
  const agents = stale.some(j => j.agentId !== undefined) ? await $.agent.list().catch(() => []) : []
  const live = new Set(
    agents.filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting').map(a => a.id),
  )
  const dead = new Set<string>()
  for (const job of stale) {
    // A --bg session outlives this process; the poller settles a gone one.
    if (job.bgId !== undefined) {
      adoptBg($, options, job, job.bgId)
      if (job.status === 'blocked') {
        TIMERS.get(job.id)?.cancel()
        TIMERS.delete(job.id)
        BLOCKED_AT.set(job.id, Date.now())
      }
    }
    else if (job.agentId !== undefined && live.has(job.agentId)) adoptSubagent($, options, job, job.agentId)
    else dead.add(job.id)
  }
  if (dead.size === 0) return
  const at = Date.now()
  await update($, JOBS, list =>
    list.map(j =>
      dead.has(j.id) && isLive(j)
        ? { ...j, status: 'failed', endedAt: at, result: j.result ?? 'interrupted: the plugin reloaded' }
        : j,
    ),
  )
}

async function resolveCwd($: EngineInterface, cwd: string | undefined): Promise<string> {
  if (cwd?.startsWith('/')) return cwd
  const base = await $.session.cwd()
  return cwd ? `${base.replace(/\/$/, '')}/${cwd}` : base
}

async function tempFile($: EngineInterface, cwd: string): Promise<string | undefined> {
  try {
    const r = await $.process.run(['mktemp', '-t', 'office-job'], { cwd })
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** Runs a job's child to its end: tail into state, then result and delivery. */
async function runJob($: EngineInterface, options: PluginOptions, job: Job, plan: RunPlan): Promise<void> {
  const jobId = job.id
  let killed = false
  let result: string | undefined
  let errorText: string | undefined
  let stderr = ''
  let pending = ''
  let stdoutRest = ''
  let lastFlush = 0
  let exit: { code: number | null; signal: string | null } | undefined
  let startError: string | undefined

  const stream = $.process.spawn({ argv: plan.argv, cwd: plan.cwd, input: plan.input, env: WORKER_ENV })
  RUNNING.set(jobId, () => {
    killed = true
    void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
  })
  startTimeout($, options, jobId, job.startedAt)

  const take = (line: string) => {
    const ev = plan.parse(line)
    if (ev.tail) pending += ev.tail
    if (ev.result !== undefined) result = ev.result
    if (ev.error !== undefined) errorText = ev.error
    else if (ev.isError) errorText = ev.result ?? 'error'
  }

  try {
    for await (const chunk of stream) {
      if (killed) break
      if (chunk.stream === 'stdout') {
        const { lines, rest } = takeLines(stdoutRest + chunk.text)
        stdoutRest = rest
        lines.forEach(take)
      } else {
        stderr = (stderr + chunk.text).slice(-8192)
        pending += chunk.text
      }
      if (pending !== '' && Date.now() - lastFlush > FLUSH_MS) {
        const text = pending
        pending = ''
        lastFlush = Date.now()
        await patchJob($, jobId, j => ({ ...j, tail: pushTail(j.tail, text) }))
      }
    }
    if (!killed) {
      if (stdoutRest.trim()) take(stdoutRest)
      exit = await stream.result
    }
  } catch (err) {
    if (!killed) startError = String(err)
  }
  if (pending !== '') {
    const text = pending
    await patchJob($, jobId, j => ({ ...j, tail: pushTail(j.tail, text) }))
  }

  if (plan.outFile) {
    try {
      const text = (await $.fs.read(plan.outFile)).trim()
      if (text) result = text
    } catch {
      // no last message was written (the run failed early)
    }
    void $.process.run(['rm', '-f', plan.outFile]).catch(() => undefined)
  }
  if (killed) return // killJob already marked and delivered it

  let status: 'done' | 'failed' = 'done'
  let final = result ?? ''
  if (startError !== undefined) {
    status = 'failed'
    final = `could not run ${plan.argv[0]}: ${startError}`
  } else if (exit?.code !== 0 || (errorText !== undefined && !result)) {
    status = 'failed'
    const why = errorText ?? lastLine(stderr)
    const quota = plan.codexModel !== undefined ? codexQuotaMessage(`${why}\n${stderr}`, plan.codexModel) : undefined
    const hint = plan.codexModel !== undefined ? codexFailureHint(`${why}\n${stderr}`) : ''
    final = quota ?? [`exit ${exit?.code ?? exit?.signal ?? '?'}: ${why}`, hint, result ?? ''].filter(Boolean).join('\n')
  }
  if (!final) final = lastLine(stderr) || '(no output)'
  await finishJob($, jobId, status, final)
}

// ── codex ───────────────────────────────────────────────────────────────

async function codexNotReady($: EngineInterface, bin: string, cwd: string): Promise<string | undefined> {
  try {
    const r = await $.process.run([bin, 'login', 'status'], { cwd, timeoutMs: 15000 })
    return r.exitCode === 0 ? undefined : `${CODEX_LOGIN_HINT}\n${(r.stderr || r.stdout).trim()}`
  } catch (err) {
    return `Could not run codex at ${bin} (${String(err).slice(0, 120)}). Set the office plugin's codexPath.`
  }
}

async function failedJob($: EngineInterface, job: Job, why: string): Promise<Started> {
  await addJob($, { ...job, status: 'failed', endedAt: Date.now(), result: why })
  return { ok: false, text: why }
}

async function startCodexReview(
  $: EngineInterface,
  options: PluginOptions,
  targetArg: string | undefined,
  instructions: string | undefined,
  cwdArg: string | undefined,
  deep: boolean,
): Promise<Started> {
  const full = await capacityError($, options)
  if (full) return { ok: false, text: full }
  const cwd = await resolveCwd($, cwdArg)
  const bin = opt(options, 'codexPath', 'codex')
  const tier: CodexTier = deep
    ? { model: opt(options, 'codexDeepModel', CODEX_DEFAULTS.deep.model), effort: CODEX_DEFAULTS.deep.effort }
    : { model: opt(options, 'codexReviewModel', CODEX_DEFAULTS.review.model), effort: CODEX_DEFAULTS.review.effort }
  const now = Date.now()
  let target: ReviewTarget | undefined = parseReviewTarget(targetArg)
  if (targetArg && !target) return { ok: false, text: `Unknown review target "${targetArg}".` }
  if (target === undefined) {
    const status = await $.process.run(['git', 'status', '--porcelain'], { cwd }).catch(() => undefined)
    if (status === undefined || status.exitCode !== 0) {
      return { ok: false, text: `${cwd} is not a git repository; codex review needs one.` }
    }
    const branches = await $.process
      .run(['git', 'branch', '--list', 'main', 'master', '--format=%(refname:short)'], { cwd })
      .catch(() => undefined)
    target = defaultReviewTarget(status.stdout, (branches?.stdout ?? '').split('\n').map(s => s.trim()))
  }
  const job: Job = {
    id: newJobId(now),
    kind: 'codex-review',
    title: `codex review ${target.label}${deep ? ' (deep)' : ''}`,
    cwd,
    status: 'running',
    startedAt: now,
    model: `${tier.model}@${tier.effort}`,
    tail: '',
  }
  const notReady = await codexNotReady($, bin, cwd)
  if (notReady) return failedJob($, job, notReady)
  const outFile = await tempFile($, cwd)
  if (!outFile) return failedJob($, job, 'Could not create a temp file for the review output (mktemp failed).')
  await addJob($, job)
  const plan: RunPlan = {
    argv: codexReviewArgv(bin, target, outFile, tier, instructions !== undefined),
    cwd,
    input: instructions !== undefined ? codexReviewPrompt(target, instructions) : undefined,
    label: 'Codex review',
    parse: codexLine,
    outFile,
    codexModel: tier.model,
  }
  $.clock.after(0, () => void runJob($, options, job, plan))
  return {
    ok: true,
    text: `Started Codex review job ${job.id} (${target.label}) in ${cwd}. It runs in the background; the review is appended to this conversation when it finishes. /jobs shows progress.`,
  }
}

async function startCodexExec(
  $: EngineInterface,
  options: PluginOptions,
  prompt: string,
  cwdArg: string | undefined,
): Promise<Started> {
  const full = await capacityError($, options)
  if (full) return { ok: false, text: full }
  const cwd = await resolveCwd($, cwdArg)
  const bin = opt(options, 'codexPath', 'codex')
  const tier: CodexTier = { model: opt(options, 'codexExecModel', CODEX_DEFAULTS.exec.model), effort: CODEX_DEFAULTS.exec.effort }
  const now = Date.now()
  const job: Job = {
    id: newJobId(now),
    kind: 'codex-exec',
    title: `codex: ${prompt.replace(/\s+/g, ' ').slice(0, 60)}`,
    cwd,
    status: 'running',
    startedAt: now,
    model: `${tier.model}@${tier.effort}`,
    tail: '',
  }
  const notReady = await codexNotReady($, bin, cwd)
  if (notReady) return failedJob($, job, notReady)
  const outFile = await tempFile($, cwd)
  if (!outFile) return failedJob($, job, 'Could not create a temp file for the codex output (mktemp failed).')
  await addJob($, job)
  const plan: RunPlan = {
    argv: codexExecArgv(bin, outFile, tier),
    cwd,
    input: prompt,
    label: 'Codex second opinion',
    parse: codexLine,
    outFile,
    codexModel: tier.model,
  }
  $.clock.after(0, () => void runJob($, options, job, plan))
  return {
    ok: true,
    text: `Started Codex job ${job.id} (read-only sandbox) in ${cwd}. Its answer is appended to this conversation when it finishes. /jobs shows progress.`,
  }
}

// ── workers ─────────────────────────────────────────────────────────────

async function startWorker(
  $: EngineInterface,
  options: PluginOptions,
  task: string,
  mode: WorkerMode,
  modelArg: string | undefined,
  effortArg: unknown,
  cwdArg: string | undefined,
): Promise<Started> {
  const full = await capacityError($, options)
  if (full) return { ok: false, text: full }
  const cwd = await resolveCwd($, cwdArg)
  const now = Date.now()
  const routed = modelArg === undefined ? await route($, options, task) : undefined
  const modelId = modelIdFor(modelArg ?? routed?.model ?? 'sonnet', now)
  const effort: Effort = isEffort(effortArg) ? effortArg : (routed?.effort ?? 'medium')
  const job: Job = {
    id: newJobId(now),
    kind: 'worker',
    title: task.replace(/\s+/g, ' ').slice(0, 60),
    cwd,
    status: 'running',
    startedAt: now,
    model: modelId,
    effort,
    route: routed,
    mode,
    tail: '',
  }
  const how = `${modelId} at ${effort} effort${routed ? ` (routed by ${routed.backend}: ${routed.reason})` : ''}`

  if (mode === 'subagent') {
    const spawned = await $.agent
      .spawn({
        prompt: task,
        model: modelId,
        description: job.title.slice(0, 40),
        subagentType: `office:${workerAgentName(effort)}`,
        cwd,
      })
      .catch((err: unknown) => ({ deny: String(err) }))
    if (spawned.deny !== undefined || spawned.agentId === undefined) {
      return failedJob($, job, `Subagent not started: ${spawned.deny ?? 'no agent id'}`)
    }
    const agentId = spawned.agentId
    const withAgent = { ...job, agentId }
    await addJob($, withAgent)
    adoptSubagent($, options, withAgent, agentId)
    return { ok: true, text: `Started subagent worker job ${job.id} (agent ${agentId}) on ${how}. /jobs shows it.` }
  }

  const permissionMode = opt(options, 'workerPermissionMode', 'acceptEdits')
  const claudeBin = opt(options, 'claudePath', 'claude')

  if (mode === 'bg') {
    const spawnedAt = Date.now() - 2000
    const r = await $.process
      .run(bgArgv(claudeBin, modelId, effort, permissionMode, task), { cwd, env: WORKER_ENV, timeoutMs: 60000 })
      .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    let bgId = r.exitCode === 0 ? parseBgId(r.stdout) : undefined
    if (bgId === undefined && r.exitCode === 0) {
      // Started but printed no id we could read: the newest background session here.
      const listed = await $.process.run([claudeBin, 'agents', '--json', '--all'], { timeoutMs: 20000 }).catch(() => undefined)
      bgId = listed?.exitCode === 0 ? newestBgSince(parseAgentsJson(listed.stdout), cwd, spawnedAt)?.id : undefined
    }
    if (bgId === undefined) {
      const why = (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`
      return failedJob($, job, `claude --bg did not start: ${why}`)
    }
    const withBg = { ...job, bgId }
    await addJob($, withBg)
    await rememberBgId($, bgId)
    adoptBg($, options, withBg, bgId)
    return {
      ok: true,
      text: `Started background worker job ${job.id} (claude --bg ${bgId}) on ${how} in ${cwd}. Its result is appended to this conversation when it finishes; \`claude attach ${bgId}\` opens it.`,
    }
  }

  await addJob($, job)
  const plan: RunPlan = {
    argv: headlessArgv(claudeBin, modelId, effort, permissionMode),
    cwd,
    input: task, // stdin, never argv: a task led by "-" would parse as a flag
    label: 'Worker',
    parse: parseStreamJsonLine,
  }
  $.clock.after(0, () => void runJob($, options, job, plan))
  return {
    ok: true,
    text: `Started headless worker job ${job.id} on ${how} in ${cwd}. Its result is appended to this conversation when it finishes; /jobs shows progress.`,
  }
}
