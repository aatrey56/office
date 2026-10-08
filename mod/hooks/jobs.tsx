import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, On, PluginOptions, Timer } from 'claude-code'

import type { BudgetCaps, Effort, EvalReport, Job, RateWindow, RouteCase, RouteDecision, RouteOutcome } from '../types'
import type { AgentDef, AgentPin } from './agentguard'
import { agentGuard, agentRouteText, hardDeny, isManagerSession, needsRoute, parseAgentFile, pinOf } from './agentguard'
import { budgetVerdict, DEFAULT_CAPS, isOpusTier, isSmallRoute, tierOfModelId } from './budget'
import { formatSets, parseCases, scoreRoutes } from './evals'
import { endLine, finishedLine, foldInbox, formatInbox, INBOX_FILE, routeLine, routedLine } from './inbox'
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
} from './codex'
import type { CodexTier, ReviewTarget } from './codex'
import {
  CODEX_LIMITS_REQUEST,
  CODEX_OUT_FALLBACK_MS,
  codexGuardVerdict,
  codexLimitsArgv,
  codexLimitsFrom,
  codexResetAt,
  parseCodexReviewArgs,
} from './codex-budget'
import type { CodexLimits, CodexOut, CodexVerdict } from './codex-budget'
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
  hasDoneMarker,
  headlessArgv,
  lastLine,
  isLive,
  isWorkerMode,
  liveBgIds,
  liveReservations,
  newestBgSince,
  newJobId,
  parseAgentsJson,
  parseBgId,
  parseBgIds,
  parseBgModels,
  prunedBg,
  parseSpawnArgs,
  parseStreamJsonLine,
  pushTail,
  readTranscript,
  RESERVATION_MS,
  ROUTE_TOOL,
  RUNNING,
  SPAWN_TOOL,
  takeLines,
  transcriptPath,
  withJob,
  WORKER_AGENT_SPECS,
  WORKER_ENV_NAME,
  WORKER_ENV_VALUE,
  withDoneRule,
  withoutDoneMarker,
  workerAgentName,
} from './spawn'
import type { BgAgent, Reservation, WorkerMode } from './spawn'
import {
  addWorktreeArgv,
  branchName,
  projectRootArgv,
  removeWorktreeArgv,
  repoRootFromCommonDir,
  workerPreamble,
  worktreeDir,
  worktreeReport,
} from './worktree'

// Owner: jobs agent. Codex handoff, router, worker spawner, jobs pane.
// codex.ts, router.ts, spawn.ts and worktree.ts hold the pure halves; every hook and
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
/** $.store key: the --bg ids this plugin started (counted against maxWorkers across sessions); a string[], as older versions read it. */
const BG_STORE_KEY = 'bgIds'
/** $.store keys: those ids' models, { id: model }, for maxOpusWorkers (older versions ignore it); the slots held by starts under way. */
const BG_MODELS_KEY = 'bgModels'
const RESERVED_KEY = 'reservedSlots'
/** The capacity lock: a crashed holder's is taken over after LOCK_STALE_MS; a wait gives up after LOCK_WAIT_MS. */
const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 15_000
const LOCK_RETRY_MS = 50
/** $.store keys: Codex's last read rate limits, and the models out of quota until their reset. */
const CODEX_LIMITS_KEY = 'codexLimits'
const CODEX_OUT_KEY = 'codexOut'
const CODEX_LIMITS_TIMEOUT_MS = 6000
/** $.store key manage.tsx keeps: project root → its manager session. */
const MANAGERS_KEY = 'managers'

type Input = Record<string, unknown>
type LineEvent = { tail?: string; result?: string; isError?: boolean; error?: string; costUsd?: number }
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
type GitRun = { isOk: boolean; out: string } // out: stdout, or why it failed

/** Subagent workers awaiting their turn.complete: agentId → job id. */
const SUBAGENT_JOBS = new Map<string, string>()
/** --bg workers being polled: job id → the short id `claude --bg` printed. */
const BG_JOBS = new Map<string, string>()
let bgPolling = false
/** --bg jobs absent from one `claude agents` listing: one miss is forgiven. */
const BG_MISSES = new Map<string, number>()
/** --bg jobs seen idle with a reply on consecutive polls: two in a row end the job. */
const BG_IDLE = new Map<string, number>()
/** Time a job spent blocked (its timeout is paused meanwhile), and when its current block began. */
const PAUSED_MS = new Map<string, number>()
const BLOCKED_AT = new Map<string, number>()
/** Max-runtime timers of running jobs, by job id. */
const TIMERS = new Map<string, Timer>()
/** Whether the main loop is mid-turn (an appended row is then read at once). */
let mainTurnRunning = false
/** Agent calls the router sized in a manager session, awaiting their turn.complete: agentId → inbox id and start. */
const SIZED_AGENTS = new Map<string, { id: string; startedAt: number }>()
/** Where the engine says an agent type comes from (agent.offer's `source`), by type. */
const OFFERED = new Map<string, string>()

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
        argumentHint: '[--deep] [--model m] [--force] [base|--uncommitted|--commit <sha>]',
      })
      await $.command.register({
        name: 'spawn',
        description: 'Route a task to a model tier and run it as a claude --bg worker',
        argumentHint: '[--force] [--mode bg|headless|subagent] [--model m] [--effort e] <task>',
      })
      await $.command.register({
        name: 'route-task',
        description: 'Dry run: which model tier and effort the router picks for a task',
        argumentHint: '<task>',
      })
      await $.command.register({
        name: 'route-eval',
        description: "Score the router against the plugin's evals/routing.jsonl (and ~/.claude/office/evals/routing.local.jsonl)",
        argumentHint: '[rules|claude|jev|all]',
      })
      await $.command.register({
        name: 'route-inbox',
        description: 'Routed worker tasks not yet labelled in ~/.claude/office/evals/routing.local.jsonl, newest first',
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
  // Only general-purpose is ever sized among the built-ins: its source says it is the built-in.
  on('agent.offer', { agent: 'general-purpose' }, ($, e, next) => {
    OFFERED.set(e.agent, e.source)
    return next(e)
  })

  // A manager's own Agent calls pass the budget guard, the router and the routing inbox, as
  // spawn_worker does. A failure here lets the spawn through unchanged.
  on('agent.spawn', async ($, e, next) => {
    let plan: AgentPlan
    try {
      plan = next.origin.plugin === 'engine' ? await planAgent($, options, e) : {}
    } catch (err) {
      debugLog($, `office: agent guard skipped for ${e.tool_use_id}: ${String(err)}`)
      return next(e)
    }
    if (plan.deny !== undefined) return { deny: plan.deny }
    const spawned = await next(plan.model !== undefined ? { ...e, model: plan.model } : e)
    if (plan.routed !== undefined && spawned.deny === undefined) {
      try {
        const now = Date.now()
        logInbox($, routeLine(e.tool_use_id, plan.routed, e.prompt, now))
        if (spawned.agentId !== undefined) SIZED_AGENTS.set(spawned.agentId, { id: e.tool_use_id, startedAt: now })
      } catch (err) {
        debugLog($, `office: agent ${e.tool_use_id} not logged: ${String(err)}`)
      }
    }
    return spawned
  })

  // ── tools ───────────────────────────────────────────────────────────────
  on('tool.call', { tool: 'mcp__office__codex_review' }, async ($, e) => {
    const input = e as unknown as Input
    const deep = input.deep === true
    const msg = await startCodexReview($, options, str(input.target), str(input.instructions), str(input.cwd), deep, BY_AGENT_CODEX)
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
    const msg = await startWorker($, options, task, mode, str(input.model), input.effort, str(input.cwd), BY_AGENT)
    return msg.ok ? { result: msg.text } : { deny: msg.text }
  })

  on('tool.call', { tool: 'mcp__office__route_task' }, async ($, e) => {
    const task = str((e as unknown as Input).task)
    if (!task) return { deny: 'route_task needs a task.' }
    return { result: describeRoute(await route($, options, task)) }
  })

  // ── commands ────────────────────────────────────────────────────────────
  on('command.run', { command: 'codex-review' }, async ($, e) => {
    const { deep, force, model, rest } = parseCodexReviewArgs(e.args)
    const msg = await startCodexReview($, options, str(rest), undefined, undefined, deep, { isForced: force, model })
    return { text: msg.text }
  })

  on('command.run', { command: 'spawn' }, async ($, e) => {
    const args = parseSpawnArgs(e.args)
    if (!args.task) return { text: 'Usage: /spawn [--force] [--mode bg|headless|subagent] [--model m] [--effort e] <task>' }
    if (args.mode !== undefined && !isWorkerMode(args.mode)) return { text: `Unknown mode "${args.mode}".` }
    if (args.effort !== undefined && !isEffort(args.effort)) return { text: `Unknown effort "${args.effort}".` }
    const mode: WorkerMode = isWorkerMode(args.mode) ? args.mode : 'bg'
    const msg = await startWorker($, options, args.task, mode, args.model, args.effort, undefined, { isPerson: true, isForced: args.force === true })
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
    // The public labels in the plugin, plus the owner's real tasks when the private local file exists.
    const sets: { name: string; tag: string; cases: RouteCase[]; reports: EvalReport[] }[] = []
    const errors: string[] = []
    for (const [name, tag, path, file] of [
      ['public', '', 'evals/routing.jsonl', `${$.plugin.root}/evals/routing.jsonl`],
      ['local', 'local-', `${OFFICE_EVALS}/${LOCAL_LABELS}`, await privateEval($, LOCAL_LABELS)],
    ] as const) {
      let text: string
      try {
        text = await $.fs.read(file)
      } catch {
        if (name === 'public') return { text: `No labeled tasks at ${file}.` }
        continue
      }
      const parsed = parseCases(text)
      errors.push(...parsed.errors.map(err => `${path} ${err}`))
      if (name === 'public' && parsed.cases.length === 0) return { text: `No usable cases in ${file}. ${parsed.errors.slice(0, 3).join('; ')}` }
      if (parsed.cases.length > 0) sets.push({ name: `${name}: ${path}`, tag, cases: parsed.cases, reports: [] })
    }

    const now = Date.now()
    const jevKey = asked === 'jev' || asked === 'all' ? await resolveJevKey($, options) : undefined
    if (asked === 'jev' && !jevKey) return { text: 'No Jev key (Keychain service aimlapi, jevApiKey, or AIMLAPI_KEY).' }
    // all: every backend that can answer now; Jev joins once a key exists.
    const backends = asked === 'all' ? (jevKey ? EVAL_BACKENDS : EVAL_BACKENDS.filter(b => b !== 'jev')) : [asked]

    const saved: string[] = []
    const results = await privateEval($, RESULTS)
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
    for (const backend of backends as RouteDecision['backend'][]) {
      for (const set of sets) {
        const outcomes = await evalBackend($, options, backend, set.cases, jevKey)
        const report = scoreRoutes(set.cases, outcomes, backend)
        set.reports.push(report)
        // A dated record, so a later run (a new rubric, Jev) has something to compare against.
        const out = `${results}/${stamp}-${set.tag}${backend}.json`
        try {
          await $.fs.write(out, JSON.stringify({ at: now, backend, report, outcomes }, null, 2))
          saved.push(out)
        } catch {
          // the table below is the result; a record that could not be written is not worth failing for
        }
      }
    }
    const notes = [
      errors.length > 0 ? `${errors.length} line(s) skipped: ${errors.slice(0, 2).join('; ')}` : '',
      asked === 'all' && !jevKey ? 'Jev skipped: no key yet.' : '',
      saved.length > 0 ? `Saved under ${results}/` : '',
    ].filter(Boolean)
    return { text: [formatSets(sets, e.presentation.columns), ...notes].join('\n') }
  })

  on('command.run', { command: 'route-inbox' }, async ($, e) => {
    const inbox = await privateEval($, INBOX_FILE)
    const readOr = (file: string) => $.fs.read(file).catch(() => '')
    const entries = foldInbox(await readOr(inbox), await readOr(await privateEval($, LOCAL_LABELS)))
    if (entries.length === 0) return { text: `No routed tasks logged yet (${inbox}).` }
    return { text: formatInbox(entries, e.presentation.columns, inbox) }
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
    const sized = SIZED_AGENTS.get(agentId)
    if (sized !== undefined) {
      SIZED_AGENTS.delete(agentId)
      logInbox($, endLine(sized.id, e.reason === 'answer' ? 'done' : 'failed', sized.startedAt, Date.now()))
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
): Promise<RouteOutcome[]> {
  const one = async (c: RouteCase): Promise<RouteOutcome> => {
    const t0 = Date.now()
    const got =
      backend === 'rules'
        ? rulesRoute(c.task)
        : backend === 'jev'
          ? jevKey
            ? await routeJev($, options, jevKey, c.task)
            : 'no key'
          : await routeClaude($, options, c.task)
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
          ? await routeJev($, options, jevKey, task)
          : 'no key (Keychain service aimlapi, jevApiKey, or AIMLAPI_KEY)'
        : await routeClaude($, options, task)
    if (typeof got === 'string') {
      misses.push(`${backend}: ${got}`)
      continue
    }
    decision = { ...got, backend: backend === 'jev' ? 'jev' : 'claude', latencyMs: Date.now() - t0 }
    break
  }
  if (decision === undefined) {
    const t0 = Date.now()
    const r = rulesRoute(task)
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
): Promise<Routed | string> {
  const url = opt(options, 'jevEndpoint', 'https://api.aimlapi.com/v1/decisions')
  const fetching = $.http.fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: jevRequestBody(task),
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
    return parseJevResponse(res.text) ?? 'unparseable reply'
  } catch {
    return 'request failed'
  } finally {
    timer?.cancel()
  }
}

async function routeClaude($: EngineInterface, options: PluginOptions, task: string): Promise<Routed | string> {
  const model = opt(options, 'routerModel', MODEL_IDS.sonnet)
  try {
    const r = await $.model.complete({
      model,
      system: CLAUDE_SYSTEM,
      prompt: claudePrompt(task),
      maxTokens: 300,
      effort: 'low',
      timeoutMs: 20000,
    })
    if (!r.isAnswered) return r.reason === 'api-error' ? `api-error ${r.error}` : r.reason
    return parseClaudeRoute(r.text) ?? 'unparseable reply'
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
  BG_IDLE.delete(id)
  PAUSED_MS.delete(id)
  BLOCKED_AT.delete(id)
  const before = (await read($, JOBS)).find(j => j.id === id)
  if (before === undefined || !isLive(before)) return
  if (before.agentId !== undefined) SUBAGENT_JOBS.delete(before.agentId)
  const endedAt = Date.now()
  const capped = capResult(withoutDoneMarker(result))
  const list = await update($, JOBS, jobs =>
    withJob(jobs, id, j => (isLive(j) ? { ...j, status, endedAt, result: capped } : j)),
  )
  const finished = list.find(j => j.id === id)
  if (finished === undefined || finished.endedAt !== endedAt) return
  logInbox($, finishedLine(finished))
  // Only a 'done' worker has surely stopped: a killed or timed-out one may still write there.
  await deliver($, finished.worktree !== undefined ? await settleWorktree($, finished, status === 'done') : finished)
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

/** Lines wait here so two writers never read the same old file; each write is read, append, write back. */
let inboxChain: Promise<void> = Promise.resolve()

/** Appends a routing-inbox line off the caller's path; a failure is logged, never thrown. */
function logInbox($: EngineInterface, line: string | undefined): void {
  if (line === undefined) return
  inboxChain = inboxChain.then(async () => {
    try {
      const file = await privateEval($, INBOX_FILE)
      // fs has no append: a file that exists but cannot be read is left alone, not overwritten.
      const old = (await $.fs.exists(file)) ? await $.fs.read(file) : ''
      await $.fs.write(file, `${old}${old === '' || old.endsWith('\n') ? '' : '\n'}${line}\n`)
    } catch (err) {
      try {
        $.ui.log(`office: routing inbox not written: ${String(err)}`, { to: 'debug' })
      } catch {
        // logging is best effort too
      }
    }
  })
}

/** Jobs running now, and how many of them are workers on Opus-tier models. */
type Load = { used: number; opus: number }

/** What one `claude agents` listing saw: the stored --bg ids read just before it, and the agents (none when it failed). */
type BgView = { before: string[]; agents?: BgAgent[] }

/** A slot reserved for a worker being started (`id` names the reservation); settled once released or turned into the --bg registration. */
type Slot = { id: string; jobId: string; isSettled: boolean }

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  return $.store.get(key).catch(() => undefined)
}

/** Serializes this process's capacity updates; the lock directory serializes them across sessions. */
let capChain: Promise<unknown> = Promise.resolve()

/** Runs `fn` holding the capacity lock: every read-modify-write of the --bg ids, models and reservations. */
async function withCapLock<T>($: EngineInterface, fn: () => Promise<T>): Promise<T> {
  const run = capChain.then(async () => {
    const lock = await takeCapLock($)
    try {
      return await fn()
    } finally {
      if (lock !== undefined) await $.process.run(['rmdir', lock]).catch(() => undefined)
    }
  })
  capChain = run.catch(() => undefined)
  return run
}

/**
 * The capacity lock every session sharing this store takes: a directory beside it, made with
 * mkdir (of two makers one fails). One older than LOCK_STALE_MS was left by a crash and is moved
 * aside (a rename, so of two takers one wins). Undefined, and the caller goes on unlocked rather
 * than refusing every start, when mkdir cannot run, cannot make it, or the wait runs out.
 */
async function takeCapLock($: EngineInterface): Promise<string | undefined> {
  const dir = `${(await configDirOf($)).replace(/\/+$/, '')}/office/locks`
  const lock = `${dir}/capacity`
  let isDirMade = false
  for (let tries = 0; tries < LOCK_WAIT_MS / LOCK_RETRY_MS; tries++) {
    const made = await $.process.run(['mkdir', lock], { timeoutMs: 5000 }).catch(() => undefined)
    if (made === undefined) return undefined
    if (made.exitCode === 0) return lock
    const held = await $.fs.stat(lock).catch(() => undefined)
    if (held === undefined) {
      // Not there, yet not made: its folder is missing (first use) or mkdir fails outright.
      if (isDirMade) return undefined
      isDirMade = true
      await $.process.run(['mkdir', '-p', dir]).catch(() => undefined)
      continue
    }
    if (Date.now() - held.mtimeMs > LOCK_STALE_MS) {
      const aside = `${lock}.stale-${newJobId(Date.now())}`
      const moved = await $.process.run(['mv', lock, aside]).catch(() => undefined)
      if (moved?.exitCode === 0) void $.process.run(['rm', '-rf', aside]).catch(() => undefined)
      continue
    }
    if (!(await $.clock.sleep(LOCK_RETRY_MS).then(() => true, () => false))) break
  }
  debugLog($, `office: capacity lock not taken (held, or no clock to wait on); going on without it`)
  return undefined
}

/**
 * Reads the stored --bg ids, then lists `claude agents`. Ids the listing shows gone are pruned,
 * with their models, under the capacity lock from a fresh read: an id another session added
 * meanwhile stays. Nothing is written when nothing is gone.
 */
async function bgView($: EngineInterface, options: PluginOptions): Promise<BgView> {
  const before = parseBgIds(await storeGet($, BG_STORE_KEY))
  if (before.length === 0) return { before, agents: [] }
  const listed = await $.process
    .run([opt(options, 'claudePath', 'claude'), 'agents', '--json', '--all'], { timeoutMs: 20000 })
    .catch(() => undefined)
  if (listed === undefined || listed.exitCode !== 0) return { before }
  const agents = parseAgentsJson(listed.stdout)
  if (before.every(id => agents.some(a => a.id === id))) return { before, agents }
  await withCapLock($, async () => {
    const ids = parseBgIds(await storeGet($, BG_STORE_KEY))
    const models = parseBgModels(await storeGet($, BG_MODELS_KEY))
    const kept = prunedBg(ids, models, before, agents)
    if (kept.ids.length !== ids.length) await $.store.set(BG_STORE_KEY, kept.ids).catch(() => undefined)
    if (Object.keys(kept.models).length !== Object.keys(models).length) {
      await $.store.set(BG_MODELS_KEY, kept.models).catch(() => undefined)
    }
  })
  return { before, agents }
}

/**
 * maxWorkers counts this process's own jobs (codex, headless, subagent), every live --bg session
 * this plugin started from any session (ids in $.store), and the slots reserved by starts under
 * way in any session; maxOpusWorkers counts the workers among them on Opus-tier models.
 */
async function loadOf($: EngineInterface, view: BgView, held: readonly Reservation[]): Promise<Load> {
  const jobs = await read($, JOBS)
  const isOpusWorker = (job: Job | undefined) => job?.kind === 'worker' && isOpusTier(job.model)
  const local = [...RUNNING.keys()].filter(id => !BG_JOBS.has(id))
  let used = local.length + held.length
  let opus = local.filter(id => isOpusWorker(jobs.find(j => j.id === id))).length + held.filter(r => r.isOpus).length
  const ids = parseBgIds(await storeGet($, BG_STORE_KEY))
  const models = parseBgModels(await storeGet($, BG_MODELS_KEY))
  const modelOf = (id: string) => models[id] ?? jobs.find(j => j.bgId === id)?.model
  if (view.agents !== undefined) {
    const live = liveBgIds(ids, view.before, view.agents)
    used += live.length
    opus += live.filter(id => isOpusTier(modelOf(id))).length
  } else {
    // Cannot list: count what this process knows, and ids other sessions added since the read.
    const own = new Set(BG_JOBS.values())
    const since = ids.filter(id => !view.before.includes(id) && !own.has(id))
    used += BG_JOBS.size + since.length
    opus += [...BG_JOBS.keys()].filter(id => isOpusWorker(jobs.find(j => j.id === id))).length
    opus += since.filter(id => isOpusTier(modelOf(id))).length
  }
  return { used, opus }
}

async function runningLoad($: EngineInterface, options: PluginOptions): Promise<{ load: Load; view: BgView }> {
  const view = await bgView($, options)
  return { load: await loadOf($, view, liveReservations(await storeGet($, RESERVED_KEY), Date.now())), view }
}

function totalError(load: Load, options: PluginOptions): string | undefined {
  const max = num(options, 'maxWorkers', 4)
  return load.used >= max ? `${load.used} jobs already running (maxWorkers ${max}); wait for one or kill it in /jobs.` : undefined
}

async function capacityError($: EngineInterface, options: PluginOptions): Promise<string | undefined> {
  return totalError((await runningLoad($, options)).load, options)
}

/** maxOpusWorkers 0 (the default) sets no limit beyond maxWorkers. */
function opusError(load: Load, options: PluginOptions, modelId: string): string | undefined {
  const max = num(options, 'maxOpusWorkers', 0)
  if (max === 0 || !isOpusTier(modelId) || load.opus < max) return undefined
  return `${load.opus} Opus jobs already running (maxOpusWorkers ${max}); wait for one, pick a cheaper model, or kill one in /jobs.`
}

/**
 * Checks both caps again with the model known and, in the same hold of the lock, reserves the
 * slot: a start racing this one, here or in another session, sees it. A refusal is the text.
 */
async function reserveSlot($: EngineInterface, options: PluginOptions, view: BgView, jobId: string, modelId: string): Promise<Slot | string> {
  return withCapLock($, async () => {
    const now = Date.now()
    const held = liveReservations(await storeGet($, RESERVED_KEY), now)
    const load = await loadOf($, view, held)
    const refused = totalError(load, options) ?? opusError(load, options, modelId)
    if (refused !== undefined) return refused
    // A job id alone may repeat across sessions; the suffix keeps one session's release off another's slot.
    const id = `${jobId}.${Math.random().toString(36).slice(2, 8)}`
    await $.store.set(RESERVED_KEY, [...held, { id, isOpus: isOpusTier(modelId), until: now + RESERVATION_MS }]).catch(() => undefined)
    return { id, jobId, isSettled: false }
  })
}

/** Gives a slot back: its worker failed to start, or now counts where it runs (this process's RUNNING). */
async function releaseSlot($: EngineInterface, slot: Slot): Promise<void> {
  if (slot.isSettled) return
  slot.isSettled = true
  await withCapLock($, async () => {
    const stored = await storeGet($, RESERVED_KEY)
    const left = liveReservations(stored, Date.now()).filter(r => r.id !== slot.id)
    if (JSON.stringify(left) !== JSON.stringify(stored)) await $.store.set(RESERVED_KEY, left).catch(() => undefined)
  })
}

/** Turns a slot into the --bg registration in one hold of the lock: the worker is never counted twice, nor missed. */
async function registerBg($: EngineInterface, slot: Slot, bgId: string, model: string): Promise<void> {
  slot.isSettled = true
  await withCapLock($, async () => {
    const stored = parseBgIds(await storeGet($, BG_STORE_KEY))
    const ids = stored.includes(bgId) ? stored : [...stored, bgId].slice(-200)
    const models = Object.fromEntries(
      Object.entries({ ...parseBgModels(await storeGet($, BG_MODELS_KEY)), [bgId]: model }).filter(([id]) => ids.includes(id)),
    )
    const left = liveReservations(await storeGet($, RESERVED_KEY), Date.now()).filter(r => r.id !== slot.id)
    await $.store.set(BG_STORE_KEY, ids).catch(() => undefined)
    await $.store.set(BG_MODELS_KEY, models).catch(() => undefined)
    await $.store.set(RESERVED_KEY, left).catch(() => undefined)
  })
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
    const configDir = await configDirOf($)
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
        if (misses < 2) continue
        // A worker removed after its last reply may still have finished: its transcript says so.
        const seen = job.sessionId !== undefined
          ? await bgSeen($, configDir, job.cwd, job.sessionId).catch(() => ({ tail: '' }) as Seen)
          : { tail: '' }
        if (hasDoneMarker(seen.result)) {
          await finishJob($, jobId, 'done', seen.result ?? '')
          continue
        }
        const last = seen.result ? `\nLast reply:\n${seen.result}` : ''
        await finishJob($, jobId, 'failed', `background session ${bgId} is gone (stopped or removed)${last}`)
        continue
      }
      BG_MISSES.delete(jobId)
      const seen = agent.sessionId !== undefined
        ? await bgSeen($, configDir, agent.cwd ?? job.cwd, agent.sessionId)
        : { tail: '' }
      const phase = bgPhase(agent.state, agent.status)
      const idlePolls = phase === 'idle' && seen.result !== undefined ? (BG_IDLE.get(jobId) ?? 0) + 1 : 0
      BG_IDLE.set(jobId, idlePolls)
      // The marker says the task is complete whatever the state (blocked, idle, even stopped).
      if (phase === 'done' || idlePolls >= 2 || hasDoneMarker(seen.result)) {
        await finishJob($, jobId, 'done', seen.result ?? '(the session ended without a reply)')
        // The conversation is kept; the idle ~300 MB process is not needed.
        if (phase !== 'failed') void $.process.run([bin, 'stop', bgId], { timeoutMs: 20000 }).catch(() => undefined)
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
      if ((phase === 'active' || phase === 'idle') && job.status === 'blocked') {
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

type Seen = { result?: string; tail: string }

/** The latest reply and tail of a --bg session's transcript (empty when it cannot be read). */
async function bgSeen($: EngineInterface, configDir: string, cwd: string, sessionId: string): Promise<Seen> {
  const path = await bgTranscript($, configDir, cwd, sessionId)
  const t = path
    ? await $.process.run(['tail', '-c', '262144', path], { timeoutMs: 10000 }).catch(() => undefined)
    : undefined
  return t !== undefined && t.exitCode === 0 ? readTranscript(t.stdout) : { tail: '' }
}

/** The transcript of a --bg session; a long (cut + hashed) slug is found by its prefix and the session's file. */
async function bgTranscript($: EngineInterface, configDir: string, cwd: string, sessionId: string): Promise<string | undefined> {
  const where = transcriptPath(configDir, cwd, sessionId)
  if (where.path !== undefined) return where.path
  const dirs = await $.fs.list(where.projects).catch(() => [])
  for (const entry of dirs) {
    if (entry.kind !== 'dir' || !entry.name.startsWith(where.prefix ?? '\u0000')) continue
    const path = `${where.projects}/${entry.name}/${sessionId}.jsonl`
    if (await $.fs.exists(path).catch(() => false)) return path
  }
  return undefined
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
  const list = await update($, JOBS, jobs =>
    jobs.map(j =>
      dead.has(j.id) && isLive(j)
        ? { ...j, status: 'failed', endedAt: at, result: j.result ?? 'interrupted: the plugin reloaded' }
        : j,
    ),
  )
  // Whether the worker still runs is unknown: its worktree is kept and reported.
  for (const job of list) {
    if (dead.has(job.id) && job.endedAt === at && job.worktree !== undefined) await settleWorktree($, job, false)
  }
}

async function configDirOf($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
}

// Private router data lives in <config dir>/office/evals, beside the manager notebooks, so the dev
// checkout, the stable clone and a marketplace install share one set. Only the public labels
// (evals/routing.jsonl) stay in the plugin folder.
const OFFICE_EVALS = '~/.claude/office/evals'
const LOCAL_LABELS = 'routing.local.jsonl'
const RESULTS = 'results'

/**
 * The path of a private eval file or folder, first copied from the plugin folder where older
 * versions kept it: only when the new one does not exist yet. The old copy is never touched.
 */
async function privateEval($: EngineInterface, name: string): Promise<string> {
  const to = `${(await configDirOf($)).replace(/\/+$/, '')}/office/evals/${name}`
  const from = `${$.plugin.root}/evals/${name}`
  try {
    if ((await $.fs.exists(to)) || !(await $.fs.exists(from))) return to
    if (name === RESULTS) {
      for (const f of await $.fs.list(from)) {
        if (f.kind === 'file') await $.fs.write(`${to}/${f.name}`, await $.fs.read(`${from}/${f.name}`))
      }
    } else {
      await $.fs.write(to, await $.fs.read(from))
    }
  } catch (err) {
    try {
      $.ui.log(`office: ${from} not copied to ${to}: ${String(err)}`, { to: 'debug' })
    } catch {
      // logging is best effort
    }
  }
  return to
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
  let costUsd: number | undefined
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
    if (ev.costUsd !== undefined) costUsd = ev.costUsd
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
  let quotaText: string | undefined
  if (startError !== undefined) {
    status = 'failed'
    final = `could not run ${plan.argv[0]}: ${startError}`
  } else if (exit?.code !== 0 || (errorText !== undefined && !result)) {
    status = 'failed'
    const why = errorText ?? lastLine(stderr)
    const quota = plan.codexModel !== undefined ? codexQuotaMessage(`${why}\n${stderr}`, plan.codexModel) : undefined
    const hint = plan.codexModel !== undefined ? codexFailureHint(`${why}\n${stderr}`) : ''
    final = quota ?? [`exit ${exit?.code ?? exit?.signal ?? '?'}: ${why}`, hint, result ?? ''].filter(Boolean).join('\n')
    if (quota !== undefined) quotaText = `${why}\n${stderr}`
  }
  if (!final) final = lastLine(stderr) || '(no output)'
  if (costUsd !== undefined) {
    const cost = costUsd
    await patchJob($, jobId, j => ({ ...j, costUsd: cost }))
  }
  // Marked before delivery, so a job started on reading the result already meets the guard.
  if (plan.codexModel !== undefined && quotaText !== undefined) await markCodexOut($, plan.codexModel, quotaText)
  await finishJob($, jobId, status, final)
  if (plan.codexModel !== undefined) void readCodexLimits($, plan.argv[0]!, plan.cwd)
}

// ── codex ───────────────────────────────────────────────────────────────

async function codexNotReady($: EngineInterface, bin: string, cwd: string): Promise<string | undefined> {
  try {
    const r = await $.process.run([bin, 'login', 'status'], { cwd, timeoutMs: 15000 })
    return r.exitCode === 0 ? undefined : `${CODEX_LOGIN_HINT}\n${(r.stderr || r.stdout).trim()}`
  } catch (err) {
    return `Could not run codex (${bin}): ${String(err).slice(0, 120)}\nInstall the Codex CLI with \`npm install -g @openai/codex\`, or set the office plugin's codexPath to where it lives.`
  }
}

/** Who asked for a Codex job: only the person's typed /codex-review sets `isForced` or `model`. */
type CodexAsk = { isForced: boolean; model?: string }
const BY_AGENT_CODEX: CodexAsk = { isForced: false }

/**
 * Codex's rate limits, read live through `codex app-server` (no message spent)
 * and kept in $.store; undefined when it does not answer in time.
 */
async function readCodexLimits($: EngineInterface, bin: string, cwd: string): Promise<CodexLimits | undefined> {
  const stream = $.process.spawn({ argv: codexLimitsArgv(bin), cwd, input: CODEX_LIMITS_REQUEST })
  const timer = $.clock.after(CODEX_LIMITS_TIMEOUT_MS, () => void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined))
  let out = ''
  let limits: CodexLimits | undefined
  try {
    for await (const chunk of stream) {
      if (chunk.stream !== 'stdout') continue
      out = (out + chunk.text).slice(-65536)
      limits = codexLimitsFrom(out, Date.now())
      if (limits) break // leaving the loop ends the child
    }
  } catch {
    // codex missing or app-server refused: the stored read stands
  } finally {
    timer.cancel()
  }
  if (limits) await $.store.set(CODEX_LIMITS_KEY, limits).catch(() => undefined)
  return limits
}

async function storedCodexOut($: EngineInterface): Promise<CodexOut> {
  const stored = await $.store.get(CODEX_OUT_KEY).catch(() => undefined)
  return stored !== null && typeof stored === 'object' ? (stored as CodexOut) : {}
}

/** A quota hit: the model is out until codex's reset time (an hour when it named none). */
async function markCodexOut($: EngineInterface, model: string, errorText: string): Promise<void> {
  const now = Date.now()
  const until = codexResetAt(errorText, now) ?? now + CODEX_OUT_FALLBACK_MS
  const kept = Object.fromEntries(Object.entries(await storedCodexOut($)).filter(([, o]) => o.until > now))
  await $.store.set(CODEX_OUT_KEY, { ...kept, [model]: { until, note: lastLine(errorText) } }).catch(() => undefined)
}

/** The budget guard before a Codex job: a live read of the limits, else the last one kept. */
async function codexGuard($: EngineInterface, bin: string, cwd: string, model: string, isForced: boolean): Promise<CodexVerdict> {
  const out = await storedCodexOut($)
  const limits =
    (await readCodexLimits($, bin, cwd)) ??
    ((await $.store.get(CODEX_LIMITS_KEY).catch(() => undefined)) as CodexLimits | undefined)
  return codexGuardVerdict(model, Date.now(), { limits: Array.isArray(limits?.buckets) ? limits : undefined, out }, isForced)
}

function refusedText(verdict: { reason: string }, ask: CodexAsk): string {
  return `${verdict.reason} ${ask === BY_AGENT_CODEX ? 'Only the person can override, with /codex-review --force.' : '/codex-review --force overrides.'}`
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
  ask: CodexAsk,
): Promise<Started> {
  const full = await capacityError($, options)
  if (full) return { ok: false, text: full }
  const cwd = await resolveCwd($, cwdArg)
  const bin = opt(options, 'codexPath', 'codex')
  const base: CodexTier = deep
    ? { model: opt(options, 'codexDeepModel', CODEX_DEFAULTS.deep.model), effort: CODEX_DEFAULTS.deep.effort }
    : { model: opt(options, 'codexReviewModel', CODEX_DEFAULTS.review.model), effort: CODEX_DEFAULTS.review.effort }
  const tier: CodexTier = ask.model !== undefined ? { ...base, model: ask.model } : base
  const verdict = await codexGuard($, bin, cwd, tier.model, ask.isForced)
  if (!verdict.isAllowed) return { ok: false, text: refusedText(verdict, ask) }
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
    text: `Started Codex review job ${job.id} (${target.label}, ${tier.model}) in ${cwd}. It runs in the background; the review is appended to this conversation when it finishes. /jobs shows progress.${verdict.warning ? ` Budget: ${verdict.warning}` : ''}`,
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
  // codex_exec is only ever an agent's call: the guard holds, with no override.
  const verdict = await codexGuard($, bin, cwd, tier.model, false)
  if (!verdict.isAllowed) return { ok: false, text: refusedText(verdict, BY_AGENT_CODEX) }
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
    text: `Started Codex job ${job.id} (read-only sandbox) in ${cwd}. Its answer is appended to this conversation when it finishes. /jobs shows progress.${verdict.warning ? ` Budget: ${verdict.warning}` : ''}`,
  }
}

// ── workers ─────────────────────────────────────────────────────────────

/** Who asked for a worker: a /spawn the person typed, or a tool call from a model. */
type SpawnedBy = { isPerson: boolean; isForced: boolean }
const BY_AGENT: SpawnedBy = { isPerson: false, isForced: false }

/** The account's rate-limit windows; none when they cannot be read, which leaves the guard open. */
async function rateWindows($: EngineInterface): Promise<RateWindow[]> {
  try {
    return (await $.session.usage()).rateLimits
  } catch {
    return []
  }
}

function budgetCaps(options: PluginOptions): BudgetCaps {
  return {
    softFiveHourPct: num(options, 'budgetSoftFiveHourPct', DEFAULT_CAPS.softFiveHourPct),
    softSevenDayPct: num(options, 'budgetSoftSevenDayPct', DEFAULT_CAPS.softSevenDayPct),
    hardPct: num(options, 'budgetHardPct', DEFAULT_CAPS.hardPct),
  }
}

async function startWorker(
  $: EngineInterface,
  options: PluginOptions,
  task: string,
  mode: WorkerMode,
  modelArg: string | undefined,
  effortArg: unknown,
  cwdArg: string | undefined,
  by: SpawnedBy,
): Promise<Started> {
  const { load, view } = await runningLoad($, options)
  const full = totalError(load, options)
  if (full) return { ok: false, text: full }
  // The budget guard, in two looks: past the hard limit nothing starts, so no routing call
  // is spent finding out the task's size; in the soft zone the route decides.
  const windows = await rateWindows($)
  const caps = budgetCaps(options)
  const isForced = by.isPerson && by.isForced
  const atHard = budgetVerdict(windows, caps, { isSmall: false, isExplicit: false, isForced })
  if (!atHard.isAllowed && atHard.zone === 'hard') return { ok: false, text: `${atHard.reason}. /spawn --force (typed by the person) is the only override.` }
  const cwd = await resolveCwd($, cwdArg)
  const now = Date.now()
  const routed = modelArg === undefined ? await route($, options, task) : undefined
  const modelId = modelIdFor(modelArg ?? routed?.model ?? 'sonnet')
  const effort: Effort = isEffort(effortArg) ? effortArg : (routed?.effort ?? 'medium')
  // Refused, never quietly moved to a cheaper model (checked again with the slot reserved below).
  const opusFull = opusError(load, options, modelId)
  if (opusFull) return { ok: false, text: opusFull }
  const verdict = budgetVerdict(windows, caps, {
    isSmall: isSmallRoute(routed?.model ?? tierOfModelId(modelId), effort),
    // Only a model the person typed counts as their explicit choice; an agent's does not.
    isExplicit: by.isPerson && modelArg !== undefined,
    isForced,
  })
  if (!verdict.isAllowed) {
    return { ok: false, text: `${verdict.reason}. This task was sized as ${modelId} at ${effort} effort; only small tasks (sonnet at low or medium) start in the soft zone.` }
  }
  // The load above was read before routing: a start racing this one may have taken the last slot.
  const slot = await reserveSlot($, options, view, newJobId(now), modelId)
  if (typeof slot === 'string') return { ok: false, text: slot }
  try {
    return await launchWorker($, options, slot, task, mode, { modelId, effort, routed, cwd, now, warning: verdict.warning })
  } finally {
    await releaseSlot($, slot)
  }
}

type Launch = { modelId: string; effort: Effort; routed?: RouteDecision; cwd: string; now: number; warning?: string }

/** Starts a worker on a reserved slot; the slot is settled once the worker counts where it runs. */
async function launchWorker(
  $: EngineInterface,
  options: PluginOptions,
  slot: Slot,
  task: string,
  mode: WorkerMode,
  { modelId, effort, routed, cwd, now, warning }: Launch,
): Promise<Started> {
  const placed = await placeWorker($, options, task, {
    id: slot.jobId,
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
  })
  const job = placed.job
  const workerTask = withDoneRule(placed.task)
  const how = `${modelId} at ${effort} effort${routed ? ` (routed by ${routed.backend}: ${routed.reason})` : ''}${warning ? `. Budget: ${warning}` : ''}`
  const where = `in ${job.cwd}.${placed.note ? ` ${placed.note}` : ''}`
  // A start that failed gives back its fresh worktree and branch (both refuse to go if any work is there).
  const failed = async (why: string) => failedJob($, await dropWorktree($, job), why)

  if (mode === 'subagent') {
    const spawned = await $.agent
      .spawn({
        prompt: workerTask,
        model: modelId,
        description: job.title.slice(0, 40),
        subagentType: `office:${workerAgentName(effort)}`,
        cwd: job.cwd,
      })
      .catch((err: unknown) => ({ deny: String(err) }))
    if (spawned.deny !== undefined || spawned.agentId === undefined) {
      return failed(`Subagent not started: ${spawned.deny ?? 'no agent id'}`)
    }
    const agentId = spawned.agentId
    const withAgent = { ...job, agentId }
    await addJob($, withAgent)
    logInbox($, routedLine(job, task, now))
    adoptSubagent($, options, withAgent, agentId)
    return { ok: true, text: `Started subagent worker job ${job.id} (agent ${agentId}) on ${how} ${where} /jobs shows it.` }
  }

  const permissionMode = opt(options, 'workerPermissionMode', 'acceptEdits')
  const claudeBin = opt(options, 'claudePath', 'claude')

  if (mode === 'bg') {
    const spawnedAt = Date.now() - 2000
    const r = await $.process
      .run(bgArgv(claudeBin, modelId, effort, permissionMode, workerTask), { cwd: job.cwd, env: WORKER_ENV, timeoutMs: 60000 })
      .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    let bgId = r.exitCode === 0 ? parseBgId(r.stdout) : undefined
    if (bgId === undefined && r.exitCode === 0) {
      // Started but printed no id we could read: the newest background session here.
      const listed = await $.process.run([claudeBin, 'agents', '--json', '--all'], { timeoutMs: 20000 }).catch(() => undefined)
      bgId = listed?.exitCode === 0 ? newestBgSince(parseAgentsJson(listed.stdout), job.cwd, spawnedAt)?.id : undefined
    }
    if (bgId === undefined) {
      const why = (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`
      if (r.exitCode !== 0) return failed(`claude --bg did not start: ${why}`)
      // It exited 0, so the worker may be running: its worktree stays.
      const kept = job.worktree !== undefined ? ` Its worktree is kept at ${job.worktree} (branch ${job.branch}).` : ''
      return failedJob($, job, `claude --bg gave no session id we could find, so this job is not tracked; it may still be running (\`claude agents\` lists it): ${why}.${kept}`)
    }
    const withBg = { ...job, bgId }
    await registerBg($, slot, bgId, modelId)
    await addJob($, withBg)
    logInbox($, routedLine(job, task, now))
    adoptBg($, options, withBg, bgId)
    return {
      ok: true,
      text: `Started background worker job ${job.id} (claude --bg ${bgId}) on ${how} ${where} Its result is appended to this conversation when it finishes; \`claude attach ${bgId}\` opens it.`,
    }
  }

  await addJob($, job)
  logInbox($, routedLine(job, task, now))
  const plan: RunPlan = {
    argv: headlessArgv(claudeBin, modelId, effort, permissionMode),
    cwd: job.cwd,
    input: workerTask, // stdin, never argv: a task led by "-" would parse as a flag
    label: 'Worker',
    parse: parseStreamJsonLine,
  }
  // The slot is handed to the timer: it holds until runJob has the job in RUNNING (its first, synchronous step).
  const handed: Slot = { ...slot }
  slot.isSettled = true
  $.clock.after(0, () => {
    void runJob($, options, job, plan)
    void releaseSlot($, handed)
  })
  return {
    ok: true,
    text: `Started headless worker job ${job.id} on ${how} ${where} Its result is appended to this conversation when it finishes; /jobs shows progress.`,
  }
}

// ── the Agent tool in manager sessions ($ halves; the rules are in agentguard.ts) ──

/** What the agent.spawn hook does: refuse, set the model, and the route to log; {} leaves the spawn alone. */
type AgentPlan = { deny?: string; model?: string; routed?: RouteDecision }

function debugLog($: EngineInterface, text: string): void {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // best effort
  }
}

/**
 * Only a session that manages a project now, and never an office worker. Budget first: past the
 * hard line every agent is refused before anything else is read or routed.
 */
async function planAgent($: EngineInterface, options: PluginOptions, e: AgentSpawnInput): Promise<AgentPlan> {
  if ((await $.env.get('OFFICE_WORKER')) !== undefined) return {}
  if (!isManagerSession(await $.store.get(MANAGERS_KEY), await $.session.id())) return {}
  const windows = await rateWindows($)
  const caps = budgetCaps(options)
  const hard = hardDeny(windows, caps)
  if (hard !== undefined) return { deny: hard }
  const pin = await agentPin($, e)
  const routed = needsRoute(windows, caps, pin, e.parentModel)
    ? await route($, options, agentRouteText(e.description, e.prompt))
    : undefined
  const verdict = agentGuard(windows, caps, pin, e.parentModel, routed)
  if ('deny' in verdict) return { deny: verdict.deny }
  if (verdict.size === undefined || routed === undefined) return {}
  return { model: modelIdFor(verdict.size), routed }
}

/** What pins this spawn's model; a definition that cannot be read leaves it unknown, so never overridden. */
async function agentPin($: EngineInterface, e: AgentSpawnInput): Promise<AgentPin> {
  const base = { callModel: e.model, isFork: e.fork, type: e.subagentType, offeredAs: OFFERED.get(e.subagentType) }
  try {
    const envModel = str(await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL'))
    return pinOf({ ...base, ...(await agentDefs($)), envModel })
  } catch (err) {
    debugLog($, `office: agent definitions not read: ${String(err)}`)
    return pinOf({ ...base, defs: [], isComplete: false })
  }
}

/**
 * The agent files the engine reads, nearest first: .claude/agents in the session's folder and
 * each folder above it, then the user's. isComplete is false when any of them could not be read.
 */
async function agentDefs($: EngineInterface): Promise<{ defs: AgentDef[]; isComplete: boolean }> {
  const dirs: string[] = []
  let dir = (await $.session.cwd()).replace(/\/+$/, '')
  while (dir !== '') {
    dirs.push(`${dir}/.claude/agents`)
    dir = dir.slice(0, dir.lastIndexOf('/'))
  }
  dirs.push(`${(await configDirOf($)).replace(/\/+$/, '')}/agents`)
  const defs: AgentDef[] = []
  let isComplete = true
  for (const d of [...new Set(dirs)]) {
    try {
      if (!(await $.fs.exists(d))) continue
      for (const entry of await $.fs.list(d)) {
        if (entry.kind === 'dir' || !entry.name.endsWith('.md')) continue
        const def = parseAgentFile(await $.fs.read(`${d}/${entry.name}`))
        if (def !== undefined) defs.push(def)
      }
    } catch {
      isComplete = false
    }
  }
  return { defs, isComplete }
}

// ── worker worktrees ($ halves; the argv and texts are in worktree.ts) ───

async function git($: EngineInterface, argv: string[]): Promise<GitRun> {
  const r = await $.process
    .run(argv, { timeoutMs: 30000 })
    .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  return r.exitCode === 0 ? { isOk: true, out: r.stdout } : { isOk: false, out: (r.stderr || r.stdout).trim() || `exit ${r.exitCode}` }
}

/**
 * Gives a worker started in a git repo its own branch in its own worktree:
 * the job then runs there and the task leads with the git rules. Outside a
 * repo, with workerWorktree off, or when a git step fails, it runs in the
 * cwd it was given; `note` says why for the start message.
 */
async function placeWorker(
  $: EngineInterface,
  options: PluginOptions,
  task: string,
  job: Job,
): Promise<{ job: Job; task: string; note: string }> {
  const here = { job, task, note: '' }
  if (opt(options, 'workerWorktree', 'auto') === 'off') return here
  const common = await git($, projectRootArgv(job.cwd))
  const root = common.isOk ? repoRootFromCommonDir(common.out) : null
  if (root === null) return here
  const fallback = (why: string) => ({ ...here, note: `No worktree of its own (${why}): it shares this checkout.` })
  // From the commit the caller is on: a manager in a linked worktree hands out its own branch.
  const head = await git($, ['git', '-C', job.cwd, 'rev-parse', 'HEAD'])
  if (!head.isOk) return fallback(`git rev-parse HEAD: ${head.out}`)
  const base = head.out.trim()
  const dir = worktreeDir(await configDirOf($), root, job.id)
  const branch = branchName(job.id, job.title)
  const added = await git($, addWorktreeArgv(root, dir, branch, base))
  if (!added.isOk) {
    // `add -b` may have made the branch before failing; its name holds the new job id, so it is ours.
    await git($, ['git', '-C', root, 'branch', '-d', branch])
    return fallback(`git worktree add: ${added.out}`)
  }
  const status = await git($, ['git', '-C', job.cwd, 'status', '--porcelain'])
  const dirty = status.isOk && status.out.trim() !== ''
    ? ' It starts from the last commit: the uncommitted changes in your checkout are not in its worktree.'
    : ''
  return {
    job: { ...job, cwd: dir, project: root, worktree: dir, branch, baseRef: base },
    task: `${workerPreamble(dir, branch, base)}\n${task}`,
    note: `Own branch ${branch} (from ${base.slice(0, 7)}) in its own worktree.${dirty}`,
  }
}

/** A worktree whose worker never started: remove it and its branch, neither forced. */
async function dropWorktree($: EngineInterface, job: Job): Promise<Job> {
  const { project: root, worktree: dir, branch, ...rest } = job
  if (root === undefined || dir === undefined || branch === undefined) return job
  if (!(await git($, removeWorktreeArgv(root, dir))).isOk) return job
  if (!(await git($, ['git', '-C', root, 'branch', '-d', branch])).isOk) return { ...rest, project: root, branch }
  return { ...rest, project: root }
}

/**
 * A finished worker's branch, commits and diffstat, appended to its result;
 * with canRemove a clean worktree is removed (its branch stays), otherwise it
 * is kept. Never throws: the result is delivered whatever git says.
 */
async function settleWorktree($: EngineInterface, job: Job, canRemove: boolean): Promise<Job> {
  const { project: root, worktree: dir, branch, baseRef: base } = job
  if (root === undefined || dir === undefined || branch === undefined || base === undefined) return job
  try {
    const range = `${base}..${branch}`
    const [log, stat, status] = await Promise.all([
      git($, ['git', '-C', root, 'log', '--oneline', range]),
      git($, ['git', '-C', root, 'diff', '--stat', range]),
      git($, ['git', '-C', dir, 'status', '--porcelain']),
    ])
    const isDirty = status.isOk && status.out.trim() !== ''
    const isRemoved = canRemove && status.isOk && !isDirty && (await git($, removeWorktreeArgv(root, dir))).isOk
    const report = worktreeReport({
      branch,
      base,
      dir,
      commits: log.isOk ? log.out : `(git log failed: ${log.out})`,
      diffStat: stat.isOk ? stat.out : '',
      isDirty,
      isRemoved,
    })
    const list = await update($, JOBS, jobs =>
      withJob(jobs, job.id, ({ worktree, ...j }) => ({
        ...j,
        ...(isRemoved ? {} : { worktree }),
        result: `${j.result ?? ''}\n\n${report}`,
      })),
    )
    return list.find(j => j.id === job.id) ?? job
  } catch (err) {
    $.ui.log(`office: worktree report for job ${job.id} failed: ${String(err)}`, { to: 'debug' })
    return job
  }
}
