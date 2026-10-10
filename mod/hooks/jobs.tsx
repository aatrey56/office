import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, On, PluginOptions, Timer } from 'claude-code'

import type { BudgetCaps, Deliverable, Effort, EvalReport, Job, RateWindow, RouteCase, RouteDecision, RouteOutcome } from '../types'
import type { AgentDef, AgentPin } from './agentguard'
import { agentGuard, agentRouteText, hardDeny, isManagerSession, needsRoute, parseAgentFile, pinOf } from './agentguard'
import { budgetVerdict, DEFAULT_CAPS, isOpusTier, isSmallRoute, tierOfModelId } from './budget'
import { formatSets, parseCases, scoreRoutes } from './evals'
import {
  CHECK_ENV,
  checkArgv,
  checksMode,
  checksShowArgv,
  gateReport,
  gitVerdict,
  isDeliverable,
  isPassed,
  OUTPUT_KEEP,
  parseChecks,
  shouldRerun,
} from './gates'
import type { CheckRun, GateResult, GitVerdict } from './gates'
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
  branchKey, CODEX_OUT_FALLBACK_TEXT, isUsageLimit, parseLedger, parsePending, planCovers, planReviewRound, roundOf, roundTiers,
  roundTitle, settledAll, SETTLE_PREFIX, shortstatLines, textLines, UNTRACKED_MAX_FILES, UNTRACKED_MAX_LINES,
} from './codex-rounds'
import type { PendingSettle, RoundFacts, RoundLedger, RoundPlan, RoundPolicy } from './codex-rounds'
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
import { alertKeysSeen, alertPctOf, staleAlertKeys, usageAlerts } from './usage-alert'
import {
  addJobTo,
  bgArgv,
  bgPhase,
  CAP_LOCK_HELD,
  capLockArgv,
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
  parseAgentsListing,
  parseBgId,
  parseBgIds,
  parseBgModels,
  prunedBg,
  parseSpawnArgs,
  parseStreamJsonLine,
  pushTail,
  readTranscript,
  RESERVATION_MS,
  RESERVATION_RENEW_MS,
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
  checkedOutIn,
  projectRootArgv,
  refArgError,
  removeWorktreeArgv,
  repoRootFromCommonDir,
  resolveBaseArgv,
  WIP_MAX_BYTES,
  wipAddArgv,
  wipCandidatesArgv,
  wipCommitArgv,
  wipStagedArgv,
  wipUnstageArgv,
  workerPreamble,
  worktreeDir,
  worktreeReport,
} from './worktree'
import { blockedVerdict, deadlineVerdict, isBgStopped, isStalled, nextGrowth, STOP_CONFIRM_MS, STOP_POLL_MS, timeoutText } from './watchdog'
import type { Growth } from './watchdog'

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
/** How long a wait for the capacity lock lasts before the start is refused (a holder never gets taken over). */
const LOCK_WAIT_MS = 15_000
/** What a refused start says when the capacity lock stayed held past LOCK_WAIT_MS. */
const CAP_BUSY_TEXT = 'office capacity lock busy; try again in a moment.'
/** How many times a started worker's registration waits out a busy capacity lock. */
const REGISTER_ATTEMPTS = 3
/** perl's exit code when it gave up waiting for the flock (capLockArgv). */
const CAP_LOCK_TIMEOUT_CODE = 1
/** $.store keys: Codex's last read rate limits, and the models out of quota until their reset. */
const CODEX_LIMITS_KEY = 'codexLimits'
const CODEX_OUT_KEY = 'codexOut'
const CODEX_LIMITS_TIMEOUT_MS = 6000
/** $.store key: the Codex review rounds per branch (codex-rounds.ts), shared by every session. */
const ROUNDS_KEY = 'codexRounds'
/** How many times a review's settlement waits out a busy ledger lock before it is kept as a pending record. */
const SETTLE_ATTEMPTS = 3
const SETTLE_BACKOFF_MS = 2000
/** How many times a booking measures the diff again when another session added a round meanwhile. */
const MEASURE_ATTEMPTS = 3
const ROUNDS_BUSY_TEXT = 'office review ledger lock busy; try again in a moment.'
const ROUNDS_UNRECORDED_TEXT = 'office could not record the review round; try again in a moment.'
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
  isRound?: boolean // a review recorded in the rounds ledger: settled when the job ends
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
/** Time a job spent blocked (its timeout is paused meanwhile), and when its current block began, on $.clock. */
const PAUSED_MS = new Map<string, number>()
const BLOCKED_AT = new Map<string, number>()
/** Max-runtime timers of running jobs, by job id. */
const TIMERS = new Map<string, Timer>()
/** When each job started, on $.clock: the clock its deadlines, blocks and stall checks are read on. */
const CLOCK_START = new Map<string, number>()
/** What the watchdog last saw of each job's transcript or output: when it last grew. */
const GROWTH = new Map<string, Growth>()
/** Jobs whose one extension past jobTimeoutMin is spent. */
const EXTENDED = new Set<string>()
/** Jobs already reported to the manager: blocked past blockedTimeoutMin (once per block), stalled before a first turn. */
const BLOCK_REPORTED = new Set<string>()
const STALL_REPORTED = new Set<string>()
/** Jobs being ended past their time: stopped and their work committed before finishJob delivers them. */
const ENDING = new Set<string>()
/** A WIP commit runs the repo's hooks, which may run checks. */
const WIP_COMMIT_TIMEOUT_MS = 120_000
/** Workers in their gate, by job id: a kill sets isKilled and ends the check under way. */
type GateRun = { isKilled: boolean; stop?: () => void }
const GATES = new Map<string, GateRun>()
/** $.store key: the gate's last verdict per branch, { branch: { sha, verdict, at } } (a merge guard reads it). */
const GATES_KEY = 'gates'
const GATES_KEPT = 200
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
/** The jobs pane's glyph and colour per status. */
const STATUS_LOOK: Record<Job['status'], [string, string]> = {
  running: ['●', 'yellow'],
  blocked: ['?', 'magenta'],
  checking: ['…', 'cyan'],
  done: ['✓', 'green'],
  rejected: ['⊘', '#ff8700'],
  failed: ['✗', 'red'],
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

  // The engine pushes the account's limits as a window moves a whole point: Claude's alert needs no poll.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await alertUsage($, options, 'Claude', e.rateLimits)
    return next(e)
  })

  // ── tools ───────────────────────────────────────────────────────────────
  on('tool.call', { tool: 'mcp__office__codex_review' }, async ($, e) => {
    const input = e as unknown as Input
    const deep = input.deep === true
    const ask = { ...BY_AGENT_CODEX, isFull: input.full === true }
    const msg = await startCodexReview($, options, str(input.target), str(input.instructions), str(input.cwd), deep, ask)
    const text = takeAlerts() + msg.text
    return msg.ok ? { result: text } : { deny: text }
  })

  // session_usage reads the account's limits anyway: the same read checks them for the alert.
  on('tool.call', { tool: 'mcp__office__session_usage' }, async $ => {
    const { startedAt, context, rateLimits, cost } = await $.session.usage()
    await alertUsage($, options, 'Claude', rateLimits)
    return { result: takeAlerts() + JSON.stringify({ startedAt, context, rateLimits, cost }, null, 2) }
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
    if (input.deliverable !== undefined && !isDeliverable(input.deliverable)) return { deny: 'deliverable is commit or report.' }
    const want = { base: str(input.base), branch: str(input.branch), deliverable: input.deliverable }
    const msg = await startWorker($, options, task, mode, str(input.model), input.effort, str(input.cwd), BY_AGENT, want)
    const text = takeAlerts() + msg.text
    return msg.ok ? { result: text } : { deny: text }
  })

  on('tool.call', { tool: 'mcp__office__route_task' }, async ($, e) => {
    const task = str((e as unknown as Input).task)
    if (!task) return { deny: 'route_task needs a task.' }
    return { result: describeRoute(await route($, options, task)) }
  })

  // ── commands ────────────────────────────────────────────────────────────
  on('command.run', { command: 'codex-review' }, async ($, e) => {
    const { deep, force, model, rest } = parseCodexReviewArgs(e.args)
    const msg = await startCodexReview($, options, str(rest), undefined, undefined, deep, { isPerson: true, isForced: force, model })
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
      await finishJob($, options, jobId, ok ? 'done' : 'failed', e.answer || `worker ended: ${e.reason}`)
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
          const [glyph, color] = STATUS_LOOK[job.status]
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
                <Button key="kill" hotkey="k" onPress={() => void killJob($, options, selected.id, 'killed')}>
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

/**
 * Ends a running job once (a later finish is a no-op) and delivers it. A worker with a worktree
 * that says it is done is not delivered here: it goes to `checking`, and its gate ends it.
 */
async function finishJob($: EngineInterface, options: PluginOptions, id: string, status: 'done' | 'failed', result: string): Promise<void> {
  // A job being ended past its time is delivered by endJob, once its work is committed.
  if (ENDING.has(id)) return
  const before = (await read($, JOBS)).find(j => j.id === id)
  // A timeout that began while the jobs were read owns the job now (endJob delivers it).
  if (ENDING.has(id)) return
  // Only a kill ends a job in its gate; the gate itself ends it otherwise.
  if (before?.status === 'checking' && status === 'done') return
  TIMERS.get(id)?.cancel()
  TIMERS.delete(id)
  RUNNING.delete(id)
  BG_JOBS.delete(id)
  BG_MISSES.delete(id)
  BG_IDLE.delete(id)
  PAUSED_MS.delete(id)
  BLOCKED_AT.delete(id)
  CLOCK_START.delete(id)
  GROWTH.delete(id)
  EXTENDED.delete(id)
  BLOCK_REPORTED.delete(id)
  STALL_REPORTED.delete(id)
  // A gate still checking is told it was ended, so it never ends the job a second time.
  const gate = GATES.get(id)
  if (gate !== undefined) {
    gate.isKilled = true
    gate.stop?.()
  }
  GATES.delete(id)
  if (before === undefined || !isLive(before)) return
  if (before.agentId !== undefined) SUBAGENT_JOBS.delete(before.agentId)
  const capped = capResult(withoutDoneMarker(result))
  if (status === 'done' && isGated(before)) {
    // Claimed before the await: a deadline firing meanwhile sees the gate and leaves the job to it.
    const run = claimGate(id)
    const checking = await update($, JOBS, jobs =>
      withJob(jobs, id, j => (j.status === 'running' || j.status === 'blocked' ? { ...j, status: 'checking', result: capped } : j)),
    )
    if (checking.find(j => j.id === id)?.status === 'checking' && !run.isKilled) startGate($, options, id, run)
    else if (GATES.get(id) === run) {
      GATES.delete(id)
      RUNNING.delete(id)
    }
    return
  }
  const endedAt = Date.now()
  // Killed in its gate: the worker's own report, unchecked, follows why.
  const text = (j: Job) => (j.status === 'checking' ? capResult(`${capped} during its checks.\n\nWorker's report (unchecked):\n${j.result ?? ''}`) : capped)
  const list = await update($, JOBS, jobs =>
    withJob(jobs, id, j => (isLive(j) ? { ...j, status, endedAt, result: text(j) } : j)),
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
  const verb = job.status === 'done' ? 'finished' : job.status === 'rejected' ? 'rejected' : 'failed'
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
type Slot = { id: string; jobId: string; isOpus: boolean; isSettled: boolean }

/** This process's reservations not yet given back: reservation id → the job it is for. */
const OWN_SLOTS = new Map<string, string>()

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  return $.store.get(key).catch(() => undefined)
}

/** Reservation times run on $.clock (a test's moves them); the host's clock if that is refused. */
async function clockNow($: EngineInterface): Promise<number> {
  return $.clock.now().catch(() => Date.now())
}

/** A lock every session sharing this store takes (its file is `<name>.lock`); `chain` serializes this process's own holds. */
type FileLock = { name: string; chain: Promise<unknown> }
const CAP_LOCK: FileLock = { name: 'capacity', chain: Promise.resolve() }
/** The Codex review ledger's: kept apart so a slow git run under it never holds up a worker's start. */
const ROUNDS_LOCK: FileLock = { name: 'codex-rounds', chain: Promise.resolve() }
/** The usage alerts' (usage-alert.ts): the first session to write an alert's key shows it. */
const ALERT_LOCK: FileLock = { name: 'usage-alerts', chain: Promise.resolve() }

/** The capacity lock stayed held by another session past LOCK_WAIT_MS: the transaction was not run. */
class CapLockBusy extends Error {
  constructor() {
    super(CAP_BUSY_TEXT)
  }
}

/**
 * Runs `fn` holding the capacity lock: every read of the --bg ids, models and reservations that counts, and every write.
 * Throws CapLockBusy, never running `fn`, when another session holds the lock past LOCK_WAIT_MS.
 */
async function withCapLock<T>($: EngineInterface, fn: () => Promise<T>): Promise<T> {
  return withLock($, CAP_LOCK, fn)
}

/** Runs `fn` holding `lock`; throws CapLockBusy, never running `fn`, when another session holds it past LOCK_WAIT_MS. */
async function withLock<T>($: EngineInterface, lock: FileLock, fn: () => Promise<T>): Promise<T> {
  const run = lock.chain.then(async () => {
    const release = await takeCapLock($, lock.name)
    try {
      return await fn()
    } finally {
      await release?.()
    }
  })
  lock.chain = run.catch(() => undefined)
  return run
}

const ALERT_TOAST_MS = 15_000
/** Alerts this session raised and the manager has not yet been told of: they lead the next session_usage, spawn_worker or codex_review result. */
const PENDING_ALERTS: string[] = []

/** The pending alerts as a lead for a manager-facing result, and forgotten; '' with none. */
function takeAlerts(): string {
  const text = PENDING_ALERTS.splice(0).join('\n')
  return text === '' ? '' : `${text}\n\n`
}

/**
 * Alerts the person once when `provider`'s 5-hour or weekly window reaches usageAlertPct (0 = off): a toast, and a
 * lead on the manager's next result. Deduped across sessions by a store key per provider, window and reset, written
 * under a lock so only the first session shows it. A worker never alerts (nobody reads its toasts). A busy lock or
 * unreadable store skips quietly: the next read tries again.
 */
async function alertUsage($: EngineInterface, options: PluginOptions, provider: 'Claude' | 'Codex', windows: readonly RateWindow[]): Promise<void> {
  try {
    const pct = alertPctOf(options.usageAlertPct)
    const alerts = usageAlerts(provider, windows, pct, Date.now())
    if (alerts.length === 0 || (await $.env.get('OFFICE_WORKER')) === '1') return
    for (const a of alerts) {
      const seen = async () => { for (const k of alertKeysSeen(a.key)) if ((await storeGet($, k)) !== undefined) return true; return false }
      if (await seen()) continue // the cheap check: no lock for a window already alerted
      const isFirst = await withLock($, ALERT_LOCK, async () => {
        if (await seen()) return false
        await $.store.set(a.key, { at: Date.now() })
        for (const stale of staleAlertKeys(await $.store.keys().catch(() => [] as string[]), Date.now())) await $.store.delete(stale).catch(() => undefined)
        return true
      })
      if (!isFirst) continue
      PENDING_ALERTS.push(a.text)
      $.ui.toast(a.text, { timeoutMs: ALERT_TOAST_MS })
    }
  } catch (err) {
    debugLog($, `office: usage alert skipped: ${String(err)}`)
  }
}

/** Like withCapLock, but a busy lock is `undefined` for a caller whose work can wait or lapse (a renewal, a release). */
async function withCapLockIfFree<T>($: EngineInterface, what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await withCapLock($, fn)
  } catch (err) {
    if (!(err instanceof CapLockBusy)) throw err
    debugLog($, `office: capacity lock busy; ${what} skipped`)
    return undefined
  }
}

/** Whether the loud "no cross-session lock" line has been logged: once per process. */
let hasWarnedNoCapLock = false

/**
 * A lock every session sharing this store takes (the capacity lock, or `name`'s): the kernel's flock on a file beside
 * it, held by a perl child (capLockArgv) until `release` ends it. Only the process holding an
 * flock can drop it, and its death always does, so a crashed holder needs no takeover and no
 * session can ever remove another's lock.
 *
 * Held past LOCK_WAIT_MS it throws CapLockBusy: the caller must not run its transaction, which
 * could overwrite what the holder is mid-way through. The holder this wait spawned is ended
 * first, so it cannot take the lock later and keep it. Returns undefined, and the caller goes on
 * with only this process's chain to serialize it (logged loudly once), when no lock is possible
 * at all: no config dir, or perl missing or unable to open the lock file.
 */
async function takeCapLock($: EngineInterface, name = CAP_LOCK.name): Promise<(() => Promise<void>) | undefined> {
  let holder: ReturnType<EngineInterface['process']['spawn']> | undefined
  const release = async () => {
    await holder?.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
  }
  let isTimedOut = false
  try {
    const path = `${(await configDirOf($)).replace(/\/+$/, '')}/office/locks/${name}.lock`
    holder = $.process.spawn({ argv: capLockArgv(path, LOCK_WAIT_MS) })
    void holder.result.catch(() => undefined)
    let out = ''
    for (let piece = await holder.next(); ; piece = await holder.next()) {
      if (piece.done) {
        isTimedOut = out === '' && piece.value?.code === CAP_LOCK_TIMEOUT_CODE
        break
      }
      if (piece.value.stream === 'stdout') out += piece.value.text
      if (out.startsWith(CAP_LOCK_HELD)) return release
    }
  } catch {
    // no config dir, or perl missing or refused: degraded, below
  }
  await release()
  if (isTimedOut) {
    debugLog($, `office: ${name} lock held past ${LOCK_WAIT_MS} ms; refused`)
    throw new CapLockBusy()
  }
  if (!hasWarnedNoCapLock) {
    hasWarnedNoCapLock = true
    debugLog($, 'office: WARNING no cross-session capacity lock (perl did not run); maxWorkers and maxOpusWorkers can be exceeded by sessions starting at the same moment')
  }
  return undefined
}

/** Consecutive unreadable `claude agents` listings in bgView; a good one resets it. */
let unreadableListings = 0
const UNREADABLE_WARN_AT = 3

/** Reads the stored --bg ids, then lists `claude agents`; ids it shows gone are pruned under the lock, when counting. */
async function bgView($: EngineInterface, options: PluginOptions): Promise<BgView> {
  const before = parseBgIds(await storeGet($, BG_STORE_KEY))
  if (before.length === 0) return { before, agents: [] }
  const listed = await $.process
    .run([opt(options, 'claudePath', 'claude'), 'agents', '--json', '--all'], { timeoutMs: 20000 })
    .catch(() => undefined)
  if (listed === undefined || listed.exitCode !== 0) return { before }
  // A cut or malformed listing proves nothing: reading it as empty would prune every stored id.
  const agents = listed.isStdoutTruncated ? undefined : parseAgentsListing(listed.stdout)
  if (agents !== undefined) {
    unreadableListings = 0
    return { before, agents }
  }
  if (++unreadableListings % UNREADABLE_WARN_AT === 0) {
    debugLog($, `office: WARNING ${UNREADABLE_WARN_AT} unreadable \`claude agents\` listings in a row; worker counts are not pruned and may be stale`)
  }
  return { before }
}

/**
 * The load, from one read of the store under the capacity lock (call it holding the lock): a
 * worker another session is turning from a reservation into a --bg id is seen as one or the
 * other, never both. Ids the listing showed gone are pruned, with their models, first: an id
 * registered since the listing stays, and nothing is written when nothing is gone.
 *
 * maxWorkers counts this process's own jobs (codex, headless, subagent), every live --bg session
 * this plugin started from any session, and the slots reserved by starts under way in any session;
 * maxOpusWorkers counts the workers among them on Opus-tier models.
 */
async function lockedLoad($: EngineInterface, view: BgView): Promise<{ load: Load; held: Reservation[]; now: number }> {
  const now = await clockNow($)
  let ids = parseBgIds(await storeGet($, BG_STORE_KEY))
  let models = parseBgModels(await storeGet($, BG_MODELS_KEY))
  if (view.agents !== undefined) {
    const kept = prunedBg(ids, models, view.before, view.agents)
    if (kept.ids.length !== ids.length) await $.store.set(BG_STORE_KEY, kept.ids).catch(() => undefined)
    if (Object.keys(kept.models).length !== Object.keys(models).length) await $.store.set(BG_MODELS_KEY, kept.models).catch(() => undefined)
    ids = kept.ids
    models = kept.models
  }
  const held = liveReservations(await storeGet($, RESERVED_KEY), now)
  const jobs = await read($, JOBS)
  const isOpusWorker = (job: Job | undefined) => job?.kind === 'worker' && isOpusTier(job.model)
  const local = [...RUNNING.keys()].filter(id => !BG_JOBS.has(id))
  // A slot of this process whose job already runs here (a local start mid-handoff) counts once, as the job.
  const pending = held.filter(r => !RUNNING.has(OWN_SLOTS.get(r.id) ?? ''))
  let used = local.length + pending.length
  let opus = local.filter(id => isOpusWorker(jobs.find(j => j.id === id))).length + pending.filter(r => r.isOpus).length
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
  return { load: { used, opus }, held, now }
}

/** The load as a precheck sees it; throws CapLockBusy when the lock stayed held, so no start goes on unchecked. */
async function runningLoad($: EngineInterface, options: PluginOptions): Promise<{ load: Load; view: BgView }> {
  const view = await bgView($, options)
  return { load: (await withCapLock($, () => lockedLoad($, view))).load, view }
}

function totalError(load: Load, options: PluginOptions): string | undefined {
  const max = num(options, 'maxWorkers', 4)
  return load.used >= max ? `${load.used} jobs already running (maxWorkers ${max}); wait for one or kill it in /jobs.` : undefined
}

async function capacityError($: EngineInterface, options: PluginOptions): Promise<string | undefined> {
  try {
    return totalError((await runningLoad($, options)).load, options)
  } catch (err) {
    if (err instanceof CapLockBusy) return err.message
    throw err
  }
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
  try {
    return await withCapLock($, async () => {
      const { load, held, now } = await lockedLoad($, view)
      const refused = totalError(load, options) ?? opusError(load, options, modelId)
      if (refused !== undefined) return refused
      // A job id alone may repeat across sessions; the suffix keeps one session's release off another's slot.
      const slot = { id: `${jobId}.${Math.random().toString(36).slice(2, 8)}`, jobId, isOpus: isOpusTier(modelId), isSettled: false }
      await $.store.set(RESERVED_KEY, [...held, { id: slot.id, isOpus: slot.isOpus, until: now + RESERVATION_MS }]).catch(() => undefined)
      OWN_SLOTS.set(slot.id, jobId)
      return slot
    })
  } catch (err) {
    // The lock stayed held: no worker starts on a count nobody checked.
    if (err instanceof CapLockBusy) return err.message
    throw err
  }
}

/** Keeps a slot reserved while its start runs on: every RESERVATION_RENEW_MS it holds RESERVATION_MS more. */
function renewSlot($: EngineInterface, slot: Slot): Timer {
  return $.clock.every(RESERVATION_RENEW_MS, () =>
    void withCapLockIfFree($, 'a reservation renewal', async () => {
      if (slot.isSettled) return
      const now = await clockNow($)
      const others = liveReservations(await storeGet($, RESERVED_KEY), now).filter(r => r.id !== slot.id)
      await $.store.set(RESERVED_KEY, [...others, { id: slot.id, isOpus: slot.isOpus, until: now + RESERVATION_MS }]).catch(() => undefined)
    }),
  )
}

/** Gives a slot back: its worker failed to start, or now counts where it runs (this process's RUNNING). */
async function releaseSlot($: EngineInterface, slot: Slot): Promise<void> {
  if (slot.isSettled) return
  slot.isSettled = true
  try {
    // Held past the wait: the reservation lapses by itself within RESERVATION_MS.
    await withCapLockIfFree($, 'a reservation release', async () => {
      const stored = await storeGet($, RESERVED_KEY)
      const left = liveReservations(stored, await clockNow($)).filter(r => r.id !== slot.id)
      if (JSON.stringify(left) !== JSON.stringify(stored)) await $.store.set(RESERVED_KEY, left).catch(() => undefined)
    })
  } finally {
    OWN_SLOTS.delete(slot.id)
  }
}

/** Turns a slot into the --bg registration in one hold of the lock: the worker is never counted twice, nor missed. */
async function registerBg($: EngineInterface, slot: Slot, bgId: string, model: string): Promise<void> {
  slot.isSettled = true
  // The worker already runs, so a busy lock is waited for again rather than written around.
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt++) {
    try {
      await registerBgLocked($, slot, bgId, model)
      return
    } catch (err) {
      if (!(err instanceof CapLockBusy)) throw err
    }
  }
  OWN_SLOTS.delete(slot.id)
  debugLog($, `office: WARNING capacity lock busy; worker ${bgId} not recorded, so it does not count toward maxWorkers`)
}

async function registerBgLocked($: EngineInterface, slot: Slot, bgId: string, model: string): Promise<void> {
  await withCapLock($, async () => {
    const stored = parseBgIds(await storeGet($, BG_STORE_KEY))
    const ids = stored.includes(bgId) ? stored : [...stored, bgId].slice(-200)
    const models = Object.fromEntries(
      Object.entries({ ...parseBgModels(await storeGet($, BG_MODELS_KEY)), [bgId]: model }).filter(([id]) => ids.includes(id)),
    )
    const left = liveReservations(await storeGet($, RESERVED_KEY), await clockNow($)).filter(r => r.id !== slot.id)
    await $.store.set(BG_STORE_KEY, ids).catch(() => undefined)
    await $.store.set(BG_MODELS_KEY, models).catch(() => undefined)
    await $.store.set(RESERVED_KEY, left).catch(() => undefined)
    OWN_SLOTS.delete(slot.id)
  })
}

/** Kill: stop the work (or its gate's check) and mark the job failed right away. */
async function killJob($: EngineInterface, options: PluginOptions, id: string, why: string): Promise<void> {
  void RUNNING.get(id)?.()
  await finishJob($, options, id, 'failed', why)
}

/** jobTimeoutMin, and jobTimeoutHardMin (never below it): the deadline, and the one extension's. */
function timeoutMins(options: PluginOptions): { softMin: number; hardMin: number } {
  const softMin = num(options, 'jobTimeoutMin', 45)
  return { softMin, hardMin: Math.max(softMin, num(options, 'jobTimeoutHardMin', 60)) }
}

/**
 * (Re)arms a job's deadline: jobTimeoutMin of running time, jobTimeoutHardMin once extended; time
 * spent blocked does not count. A job first armed here starts now (a reload sets CLOCK_START first).
 */
async function startTimeout($: EngineInterface, options: PluginOptions, id: string): Promise<void> {
  const now = await clockNow($)
  if (!CLOCK_START.has(id)) CLOCK_START.set(id, now)
  const { softMin, hardMin } = timeoutMins(options)
  const minutes = EXTENDED.has(id) ? hardMin : softMin
  const left = Math.max(1000, (CLOCK_START.get(id) ?? now) + (PAUSED_MS.get(id) ?? 0) + minutes * 60_000 - now)
  TIMERS.get(id)?.cancel()
  TIMERS.delete(id)
  if (RUNNING.has(id) && !GATES.has(id)) TIMERS.set(id, $.clock.after(left, () => void onDeadline($, options, id)))
}

/** At a running job's deadline: extend it once while its transcript still grows; otherwise end it. */
async function onDeadline($: EngineInterface, options: PluginOptions, id: string): Promise<void> {
  TIMERS.delete(id)
  // Finished or gone to its gate (RUNNING then holds the gate's handle): no longer the deadline's.
  const isOver = () => !RUNNING.has(id) || GATES.has(id)
  const job = (await read($, JOBS)).find(j => j.id === id)
  if (job?.status !== 'running' || isOver()) return // finished, or blocked (its unblock re-arms it)
  const { softMin, hardMin } = timeoutMins(options)
  const isExtended = EXTENDED.has(id)
  const now = await clockNow($)
  if (isOver()) return
  const verdict = deadlineVerdict({ softMin, hardMin, isExtended, grewAt: GROWTH.get(id)?.at, now })
  if (verdict === 'extend') {
    EXTENDED.add(id)
    await patchJob($, id, j => ({ ...j, isExtended: true }))
    if (isOver()) return
    $.ui.toast(`Job ${id} still active at ${softMin} min: extended to ${hardMin} min`)
    await startTimeout($, options, id)
    return
  }
  await endJob($, options, id, timeoutText(softMin, hardMin, isExtended), isExtended ? hardMin : softMin)
}

/**
 * Ends a job past its time: stops its worker and waits until it is confirmed stopped, commits a
 * dirty worktree's work on its branch as WIP, then fails it with `why` and what became of the work.
 * A worker not confirmed stopped may still be writing: its work is left uncommitted. The worktree
 * is kept for recovery: finishJob never removes a failed job's.
 */
async function endJob($: EngineInterface, options: PluginOptions, id: string, why: string, minutes: number): Promise<void> {
  // Taken before the first await: pollBg starts it without waiting, and may come round again.
  // A worker in its gate said it was done: no timeout ends it (only a kill, through finishJob).
  if (ENDING.has(id) || GATES.has(id)) return
  ENDING.add(id)
  let saved = ''
  let worktree: string | undefined
  try {
    const job = (await read($, JOBS)).find(j => j.id === id)
    if (job === undefined || !isLive(job) || job.status === 'checking' || GATES.has(id)) return
    worktree = job.worktree
    const isStopped = (await RUNNING.get(id)?.()) ?? true
    RUNNING.delete(id) // stopped (or given up on): it no longer counts toward maxWorkers
    if (!isStopped) {
      const where = job.worktree !== undefined ? `; its work was left uncommitted in ${job.worktree}` : ''
      saved = `Could not confirm the worker stopped${where}. It may still be running: check it before reusing its branch.`
    } else if (job.worktree !== undefined) saved = await commitWip($, job.worktree, minutes)
  } catch (err) {
    saved = `Its work was not committed (${String(err).slice(0, 200)}); the worktree is kept at ${worktree}.`
  } finally {
    ENDING.delete(id)
  }
  await finishJob($, options, id, 'failed', saved ? `${why}\n${saved}` : why)
}

/**
 * Commits a stopped worker's uncommitted work on its branch as "WIP: timed out at N min (office)":
 * all `add -A` takes but files over 5 MB (unstaged if the worker staged them: they stay in the
 * worktree), the repo's hooks run (never --no-verify). Says what happened, for the job's result;
 * '' when there was nothing to commit.
 */
async function commitWip($: EngineInterface, dir: string, minutes: number): Promise<string> {
  const status = await git($, ['git', '-C', dir, 'status', '--porcelain'])
  if (!status.isOk) return `Its work was not committed (git status: ${status.out}); the worktree is kept at ${dir}.`
  if (status.out.trim() === '') return ''
  const listed = await git($, wipCandidatesArgv(dir))
  if (!listed.isOk) return `WIP commit not made (git ls-files: ${listed.out}); the uncommitted work is left in ${dir}.`
  const staged = await git($, wipStagedArgv(dir))
  if (!staged.isOk) return `WIP commit not made (git diff --cached: ${staged.out}); the uncommitted work is left in ${dir}.`
  const skipped: string[] = []
  for (const path of new Set(`${listed.out}\0${staged.out}`.split('\0').filter(Boolean))) {
    // A link is committed as the link; a path gone (deleted) is committed as its deletion.
    const size = await $.fs.stat(`${dir}/${path}`).then(st => (st.isLink ? 0 : st.size), () => 0)
    if (size > WIP_MAX_BYTES) skipped.push(path)
  }
  const left = skipped.length > 0 ? ` Left out, over 5 MB (uncommitted in the worktree): ${skipped.join(', ')}.` : ''
  if (skipped.length > 0) {
    const unstaged = await git($, wipUnstageArgv(dir, skipped))
    if (!unstaged.isOk) return `WIP commit not made (git reset: ${unstaged.out}); the uncommitted work is left in ${dir}.${left}`
  }
  const added = await git($, wipAddArgv(dir, skipped))
  if (!added.isOk) return `WIP commit failed (git add: ${added.out}); the uncommitted work is left in ${dir}.`
  const committed = await git($, wipCommitArgv(dir, minutes), WIP_COMMIT_TIMEOUT_MS)
  if (!committed.isOk) return `WIP commit failed (git commit: ${committed.out.slice(0, 500)}); the uncommitted work is left in ${dir}.${left}`
  return `Its uncommitted work was committed on its branch as "WIP: timed out at ${minutes} min (office)"; the worktree is kept for recovery.${left}`
}

/**
 * Asks `isStopped` (given the time left, to bound its own query) until it says yes, for at most
 * STOP_CONFIRM_MS on the clock, its queries included: whether a worker's stop is confirmed.
 */
async function confirmStopped($: EngineInterface, isStopped: (leftMs: number) => Promise<boolean>): Promise<boolean> {
  const deadline = (await clockNow($)) + STOP_CONFIRM_MS
  for (;;) {
    const left = deadline - (await clockNow($))
    if (left <= 0) return false
    if (await isStopped(left).catch(() => false)) return true
    const rest = deadline - (await clockNow($))
    if (rest <= 0) return false
    await $.clock.sleep(Math.min(STOP_POLL_MS, rest))
  }
}

/** Registers a subagent job's kill handle (TaskStop, then its loop gone from $.agent.list), its answer route and its timeout. */
function adoptSubagent($: EngineInterface, options: PluginOptions, job: Job, agentId: string): void {
  SUBAGENT_JOBS.set(agentId, job.id)
  RUNNING.set(job.id, async () => {
    SUBAGENT_JOBS.delete(agentId)
    await $.tool.call({ tool: 'TaskStop', task_id: agentId }).catch(() => undefined)
    return confirmStopped($, async () => {
      const agent = (await $.agent.list()).find(a => a.id === agentId)
      return agent === undefined || !['running', 'pending', 'waiting'].includes(agent.status)
    })
  })
  void startTimeout($, options, job.id)
}

/** `claude stop`, then the session ended in `claude agents`: whether the --bg session's stop is confirmed. */
async function stopBg($: EngineInterface, options: PluginOptions, bgId: string): Promise<boolean> {
  const bin = opt(options, 'claudePath', 'claude')
  // A failed stop may mean the session already ended: the listing decides.
  await $.process.run([bin, 'stop', bgId], { timeoutMs: 20000 }).catch(() => undefined)
  return confirmStopped($, async leftMs => {
    const listed = await $.process.run([bin, 'agents', '--json', '--all'], { timeoutMs: Math.min(20000, leftMs) })
    // Only a whole listing is evidence: a cut or malformed one would read as "not listed", so stopped.
    const agents = listed.exitCode === 0 && !listed.isStdoutTruncated ? parseAgentsListing(listed.stdout) : undefined
    return agents !== undefined && isBgStopped(agents.find(a => a.id === bgId))
  })
}

/** Registers a --bg job's kill handle (stopBg), its polling and its timeout. */
function adoptBg($: EngineInterface, options: PluginOptions, job: Job, bgId: string): void {
  BG_JOBS.set(job.id, bgId)
  RUNNING.set(job.id, async () => {
    BG_JOBS.delete(job.id)
    return stopBg($, options, bgId)
  })
  // A blocked job's deadline waits for its unblock, which re-arms it (pollBg).
  if (job.status !== 'blocked') void startTimeout($, options, job.id)
}

/** One poll of every --bg job: state from `claude agents`, result from the transcript. */
async function pollBg($: EngineInterface, options: PluginOptions): Promise<void> {
  bgPolling = true
  try {
    const bin = opt(options, 'claudePath', 'claude')
    const listed = await $.process.run([bin, 'agents', '--json', '--all'], { timeoutMs: 20000 }).catch(() => undefined)
    if (listed === undefined || listed.exitCode !== 0 || listed.isStdoutTruncated) return
    // A malformed listing would count every worker as gone.
    const agents = parseAgentsListing(listed.stdout)
    if (agents === undefined) return
    const jobs = await read($, JOBS)
    const configDir = await configDirOf($)
    const now = await clockNow($)
    const blockedMin = num(options, 'blockedTimeoutMin', 20)
    for (const [jobId, bgId] of [...BG_JOBS]) {
      const job = jobs.find(j => j.id === jobId)
      if (job === undefined || !isLive(job)) {
        BG_JOBS.delete(jobId)
        continue
      }
      if (ENDING.has(jobId)) continue
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
          await finishJob($, options, jobId, 'done', seen.result ?? '')
          continue
        }
        const last = seen.result ? `\nLast reply:\n${seen.result}` : ''
        await finishJob($, options, jobId, 'failed', `background session ${bgId} is gone (stopped or removed)${last}`)
        continue
      }
      BG_MISSES.delete(jobId)
      const seen = agent.sessionId !== undefined
        ? await bgSeen($, configDir, agent.cwd ?? job.cwd, agent.sessionId)
        : { tail: '' }
      GROWTH.set(jobId, nextGrowth(GROWTH.get(jobId), seen.mark ?? '', now))
      const phase = bgPhase(agent.state, agent.status)
      const idlePolls = phase === 'idle' && seen.result !== undefined ? (BG_IDLE.get(jobId) ?? 0) + 1 : 0
      BG_IDLE.set(jobId, idlePolls)
      // The marker says the task is complete whatever the state (blocked, idle, even stopped).
      if (phase === 'done' || idlePolls >= 2 || hasDoneMarker(seen.result)) {
        await finishJob($, options, jobId, 'done', seen.result ?? '(the session ended without a reply)')
        // The conversation is kept; the idle ~300 MB process is not needed. A gated worker's gate stops it first.
        if (phase !== 'failed' && !isGated(job)) void $.process.run([bin, 'stop', bgId], { timeoutMs: 20000 }).catch(() => undefined)
        continue
      }
      if (phase === 'failed') {
        const last = seen.result ? `\nLast reply:\n${seen.result}` : ''
        await finishJob($, options, jobId, 'failed', `background session ${bgId} ended: ${agent.state}${last}`)
        continue
      }
      const sinceStart = now - (CLOCK_START.get(jobId) ?? job.startedAt)
      // Kept on the job: a later tail read may hold no turn (a big tool result pushed it out).
      let hasReplied = job.hasReplied === true || seen.hasTurn === true
      // The tail may miss a turn a big tool result pushed out between polls: look at the whole transcript first.
      if (isStalled(sinceStart, hasReplied, STALL_REPORTED.has(jobId)) && agent.sessionId !== undefined) {
        hasReplied = await bgHasTurn($, configDir, agent.cwd ?? job.cwd, agent.sessionId)
      }
      if (hasReplied && job.hasReplied !== true) await patchJob($, jobId, j => ({ ...j, hasReplied: true }))
      if (isStalled(sinceStart, hasReplied, STALL_REPORTED.has(jobId))) {
        STALL_REPORTED.add(jobId)
        const text = `Worker ${jobId} (${job.title}) has not replied ${formatElapsed(sinceStart)} after it started: no assistant turn in its transcript, so it may be stalled. Stop it (kill it in /jobs, or \`claude stop ${bgId}\`) and spawn it again.`
        $.ui.toast(`Worker ${jobId} may be stalled: no reply yet`)
        await notifyModel($, jobId, text, `Worker ${jobId} may be stalled: see above.`)
      }
      if (phase === 'blocked' && job.status === 'blocked') {
        const since = BLOCKED_AT.get(jobId) ?? now
        const blocked = blockedVerdict(now - since, blockedMin, BLOCK_REPORTED.has(jobId))
        if (blocked === 'end') {
          const why = `ended after ${formatElapsed(now - since)} waiting for approval or input (twice blockedTimeoutMin ${blockedMin})`
          // Not awaited: confirming the stop takes up to STOP_CONFIRM_MS, and the other workers' polls go on.
          void endJob($, options, jobId, why, Math.round(sinceStart / 60_000))
          continue
        }
        if (blocked === 'report') {
          BLOCK_REPORTED.add(jobId)
          const text = `Worker ${jobId} (${job.title}) has waited ${formatElapsed(now - since)} for approval or input (blockedTimeoutMin ${blockedMin}): \`claude attach ${bgId}\` answers it. Still waiting at ${2 * blockedMin} min, it is ended and its work committed as WIP on its branch.`
          $.ui.toast(`Worker ${jobId} blocked ${blockedMin}+ min: claude attach ${bgId}`)
          await notifyModel($, jobId, text, `Worker ${jobId} is still blocked: see above.`)
        }
      }
      if (phase === 'blocked' && job.status === 'running') {
        // Pause the timeout and tell the model once per block.
        TIMERS.get(jobId)?.cancel()
        TIMERS.delete(jobId)
        BLOCKED_AT.set(jobId, now)
        await patchJob($, jobId, j => ({ ...j, status: 'blocked', blockedAt: now, tail: seen.tail || j.tail, sessionId: agent.sessionId ?? j.sessionId }))
        const latest = seen.result ? `\n\nLatest reply:\n${seen.result}` : ''
        const text = `Worker ${jobId} (${job.title}) is waiting for input: \`claude attach ${bgId}\`${latest}`
        $.ui.toast(`Worker waiting for input: claude attach ${bgId}`)
        await notifyModel($, jobId, text, `Worker ${jobId} is waiting for input: see above.`)
        continue
      }
      if ((phase === 'active' || phase === 'idle') && job.status === 'blocked') {
        const since = BLOCKED_AT.get(jobId)
        BLOCKED_AT.delete(jobId)
        BLOCK_REPORTED.delete(jobId)
        if (since !== undefined) PAUSED_MS.set(jobId, (PAUSED_MS.get(jobId) ?? 0) + now - since)
        const pausedMs = PAUSED_MS.get(jobId)
        await patchJob($, jobId, j => ({ ...j, status: 'running', pausedMs, blockedAt: undefined }))
        await startTimeout($, options, jobId)
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

/** `mark`: the transcript's last bytes, which change whenever it grows (it is only ever appended to). */
type Seen = { result?: string; tail: string; hasTurn?: boolean; mark?: string }

/** The latest reply and tail of a --bg session's transcript (empty when it cannot be read). */
async function bgSeen($: EngineInterface, configDir: string, cwd: string, sessionId: string): Promise<Seen> {
  const path = await bgTranscript($, configDir, cwd, sessionId)
  const t = path
    ? await $.process.run(['tail', '-c', '262144', path], { timeoutMs: 10000 }).catch(() => undefined)
    : undefined
  return t !== undefined && t.exitCode === 0 ? { ...readTranscript(t.stdout), mark: t.stdout.slice(-512) } : { tail: '' }
}

/** Whether a --bg session's transcript holds an assistant turn anywhere (grep stops at the first). */
async function bgHasTurn($: EngineInterface, configDir: string, cwd: string, sessionId: string): Promise<boolean> {
  const path = await bgTranscript($, configDir, cwd, sessionId)
  if (path === undefined) return false
  const found = await $.process.run(['grep', '-q', '-F', '"type":"assistant"', path], { timeoutMs: 10000 }).catch(() => undefined)
  return found?.exitCode === 0
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
  if (stale.length === 0) return reconcileSettlements($, [])
  const agents = stale.some(j => j.agentId !== undefined) ? await $.agent.list().catch(() => []) : []
  const live = new Set(
    agents.filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting').map(a => a.id),
  )
  const dead = new Set<string>()
  const now = await clockNow($)
  for (const job of stale) {
    // A worker that said done before the reload is checked again, from the start.
    if (job.status === 'checking') {
      startGate($, options, job.id)
      continue
    }
    // A --bg session outlives this process; the poller settles a gone one.
    // A re-adopted job's deadlines run from when it really started (outside tests $.clock is the host's),
    // with the extension and blocked time its record kept.
    const restore = () => {
      CLOCK_START.set(job.id, job.startedAt)
      if (job.isExtended === true) EXTENDED.add(job.id)
      if (job.pausedMs !== undefined) PAUSED_MS.set(job.id, job.pausedMs)
    }
    if (job.bgId !== undefined) {
      restore()
      if (job.status === 'blocked') BLOCKED_AT.set(job.id, job.blockedAt ?? now)
      adoptBg($, options, job, job.bgId)
    } else if (job.agentId !== undefined && live.has(job.agentId)) {
      restore()
      adoptSubagent($, options, job, job.agentId)
    }
    else dead.add(job.id)
  }
  if (dead.size === 0) return reconcileSettlements($, [])
  const at = Date.now()
  const list = await update($, JOBS, jobs =>
    jobs.map(j =>
      dead.has(j.id) && isLive(j)
        ? { ...j, status: 'failed', endedAt: at, result: j.result ?? 'interrupted: the plugin reloaded' }
        : j,
    ),
  )
  // A review the reload interrupted is a failed round: it stops counting toward the cap and no longer blocks its HEAD.
  await reconcileSettlements($, list.filter(j => dead.has(j.id) && j.endedAt === at && j.kind === 'codex-review').map(j => j.id))
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

  let isClosed = false // the loop over the child's output was left: the stream, and so the child, is ended
  const stream = $.process.spawn({ argv: plan.argv, cwd: plan.cwd, input: plan.input, env: WORKER_ENV })
  RUNNING.set(jobId, async () => {
    killed = true
    // Not awaited: a return() queued behind a pending read could wait on the child it ends.
    void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
    return confirmStopped($, async () => isClosed)
  })
  void startTimeout($, options, jobId)

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
        GROWTH.set(jobId, { mark: '', at: await clockNow($) })
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
  isClosed = true
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
  if (killed) {
    // killJob already marked and delivered it; a killed review gave no findings to keep.
    if (plan.isRound) await settleRound($, jobId, undefined)
    return
  }

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
    // A review the plan's usage limit stopped: the manager's fallback, not a bare error.
    if (job.kind === 'codex-review' && isUsageLimit(`${why}\n${stderr}`)) final = `${final}\n${CODEX_OUT_FALLBACK_TEXT}`
  }
  if (!final) final = lastLine(stderr) || '(no output)'
  if (costUsd !== undefined) {
    const cost = costUsd
    await patchJob($, jobId, j => ({ ...j, costUsd: cost }))
  }
  // Marked before delivery, so a job started on reading the result already meets the guard.
  if (plan.codexModel !== undefined && quotaText !== undefined) await markCodexOut($, plan.codexModel, quotaText)
  // Kept before delivery too, so the next round, asked for on reading this one, sees its findings.
  if (plan.isRound) await settleRound($, jobId, status === 'done' ? final : undefined)
  await finishJob($, options, jobId, status, final)
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

/** Who asked for a Codex job: only the person's typed /codex-review sets `isPerson`, `isForced` or `model`; `isFull` is codex_review's full. */
type CodexAsk = { isPerson: boolean; isForced: boolean; model?: string; isFull?: boolean }
const BY_AGENT_CODEX: CodexAsk = { isPerson: false, isForced: false }

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
async function codexGuard($: EngineInterface, options: PluginOptions, bin: string, cwd: string, model: string, isForced: boolean): Promise<CodexVerdict> {
  const out = await storedCodexOut($)
  const live = await readCodexLimits($, bin, cwd)
  // The live read is the only one that costs a call, so it is the only one that can alert (the stored read may be old).
  if (live) await alertUsage($, options, 'Codex', live.buckets.flatMap(b => b.windows))
  const limits = live ?? ((await $.store.get(CODEX_LIMITS_KEY).catch(() => undefined)) as CodexLimits | undefined)
  return codexGuardVerdict(model, Date.now(), { limits: Array.isArray(limits?.buckets) ? limits : undefined, out }, isForced)
}

function refusedText(verdict: { reason: string }, ask: CodexAsk): string {
  return `${verdict.reason} ${!ask.isPerson ? 'Only the person can override, with /codex-review --force.' : '/codex-review --force overrides.'}`
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
  const asked = parseReviewTarget(targetArg)
  if (targetArg && !asked) return { ok: false, text: `Unknown review target "${targetArg}".` }
  const policy: RoundPolicy = {
    maxRounds: num(options, 'codexMaxRounds', 3),
    maxLines: num(options, 'codexRereviewMaxLines', 400),
    // Sol reviews a branch's first round only; deep and the person's own --model pin every round of the call
    ...roundTiers({
      review: { model: opt(options, 'codexReviewModel', CODEX_DEFAULTS.review.model), effort: CODEX_DEFAULTS.review.effort },
      rereview: { model: opt(options, 'codexRereviewModel', CODEX_DEFAULTS.rereview.model), effort: CODEX_DEFAULTS.rereview.effort },
      deep: deep ? { model: opt(options, 'codexDeepModel', CODEX_DEFAULTS.deep.model), effort: CODEX_DEFAULTS.deep.effort } : undefined,
      model: ask.model,
    }),
  }
  const status = await $.process.run(['git', 'status', '--porcelain'], { cwd }).catch(() => undefined)
  const isRepo = status !== undefined && status.exitCode === 0
  if (!isRepo && asked === undefined) return { ok: false, text: `${cwd} is not a git repository; codex review needs one.` }
  let fallback = asked
  if (isRepo && fallback === undefined) {
    const branches = await $.process
      .run(['git', 'branch', '--list', 'main', 'master', '--format=%(refname:short)'], { cwd })
      .catch(() => undefined)
    fallback = defaultReviewTarget(status.stdout, (branches?.stdout ?? '').split('\n').map(s => s.trim()))
  }
  const now = Date.now()
  const jobId = newJobId(now)
  const facts = {
    isDirty: isRepo && status.stdout.trim() !== '',
    isPerson: ask.isPerson,
    target: asked,
    isFull: ask.isFull === true || deep,
    instructions,
  }
  const booked = isRepo ? await bookRound($, cwd, jobId, now, policy, facts, fallback!) : undefined
  if (typeof booked === 'string') return { ok: false, text: booked }
  // Outside a repo (an explicit target only) no round is kept; codex reports the rest.
  const plan = booked ?? planReviewRound({ ...facts, rounds: [], head: '' }, policy)
  if (!plan.isAllowed) return { ok: false, text: plan.reason }
  const isRound = booked !== undefined
  const drop = async () => {
    if (isRound) await settleRound($, jobId, undefined)
  }
  const tier = plan.tier
  const target: ReviewTarget = plan.target ?? fallback!
  const verdict = await codexGuard($, options, bin, cwd, tier.model, ask.isForced)
  if (!verdict.isAllowed) {
    await drop()
    return { ok: false, text: `${refusedText(verdict, ask)} ${CODEX_OUT_FALLBACK_TEXT}` }
  }
  const job: Job = {
    id: jobId,
    kind: 'codex-review',
    title: roundTitle(plan, policy.maxRounds, target.label),
    cwd,
    status: 'running',
    startedAt: now,
    model: `${tier.model}@${tier.effort}`,
    tail: '',
  }
  const notReady = await codexNotReady($, bin, cwd)
  if (notReady) {
    await drop()
    return failedJob($, job, notReady)
  }
  const outFile = await tempFile($, cwd)
  if (!outFile) {
    await drop()
    return failedJob($, job, 'Could not create a temp file for the review output (mktemp failed).')
  }
  await addJob($, job)
  const runPlan: RunPlan = {
    argv: codexReviewArgv(bin, target, outFile, tier, plan.instructions !== undefined),
    cwd,
    input: plan.instructions !== undefined ? codexReviewPrompt(target, plan.instructions) : undefined,
    label: 'Codex review',
    parse: codexLine,
    outFile,
    codexModel: tier.model,
    isRound,
  }
  $.clock.after(0, () => void runJob($, options, job, runPlan))
  const kind = plan.isRereview ? 're-review' : 'review'
  const isLast = isRound && !ask.isPerson && plan.round >= policy.maxRounds
  const notes = [
    plan.note !== undefined ? `This is a ${plan.note}.` : '',
    isLast ? 'It is the last round an agent can start on this branch.' : '',
    verdict.warning ? `Budget: ${verdict.warning}` : '',
    booked?.isUnrecorded ? 'The round was not recorded (the review ledger could not be written), so it does not count toward the cap.' : '',
  ].filter(Boolean)
  return {
    ok: true,
    text: `Started Codex ${kind} job ${job.id}, round ${roundOf(plan.round, policy.maxRounds)} (${target.label}, ${tier.model}) in ${cwd}. It runs in the background; the review is appended to this conversation when it finishes. /jobs shows progress.${notes.length > 0 ? ` ${notes.join(' ')}` : ''}`,
  }
}

/** stdout of a git command in `cwd`, trimmed; undefined when it fails. */
async function gitOut($: EngineInterface, cwd: string, args: string[]): Promise<string | undefined> {
  const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 30000 }).catch(() => undefined)
  return r !== undefined && r.exitCode === 0 ? r.stdout.trim() : undefined
}

/**
 * Decides this call's round from the branch's ledger and records it, in one hold of the rounds
 * lock: a call racing it, here or in another session, sees the round. Undefined when the branch
 * has no commit to key it by (no round is kept); a string when the lock stayed busy.
 *
 * The slow git runs (size since the last sha) happen before the lock, against the last round as
 * read then; if another session added a round meanwhile, the lock is taken again and it is measured
 * anew (a few times; then the plan goes on without a measure, which makes it a full review).
 */
async function bookRound(
  $: EngineInterface,
  cwd: string,
  jobId: string,
  now: number,
  policy: RoundPolicy,
  facts: Omit<RoundFacts, 'rounds' | 'head' | 'sinceLast'>,
  fallback: ReviewTarget,
): Promise<(RoundPlan & { isUnrecorded?: true }) | string | undefined> {
  const head = await gitOut($, cwd, ['rev-parse', 'HEAD'])
  const commonDir = await gitOut($, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!head || !commonDir) return undefined
  const key = branchKey(commonDir, (await gitOut($, cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])) ?? '')
  const isIncremental = !facts.isPerson && facts.target === undefined && !facts.isFull
  const measureLast = async () => {
    const last = (await readLedgerLocked($, now)).ledger[key]?.at(-1) // the reconciled ledger, as the lock will see it
    return last !== undefined && last.isCovering === true && isIncremental
      ? { sha: last.sha, since: await sinceSha($, cwd, last.sha) }
      : undefined
  }
  let measured = await measureLast()
  try {
    for (let attempt = 1; ; attempt++) {
      const booked = await withLock($, ROUNDS_LOCK, async () => {
        const { stored, ledger, pending } = await readLedgerLocked($, now)
        const rounds = ledger[key] ?? []
        const last = rounds.at(-1)
        const isMeasured = measured !== undefined && measured.sha === last?.sha
        const needsMeasure = last !== undefined && last.isCovering === true && isIncremental
        if (needsMeasure && !isMeasured && attempt < MEASURE_ATTEMPTS) return undefined // the last round changed: measure again
        const plan = planReviewRound({ ...facts, rounds, head, sinceLast: isMeasured ? measured!.since : undefined }, policy)
        if (!plan.isAllowed) {
          await saveLedgerLocked($, stored, ledger, pending)
          return plan
        }
        const target = plan.target ?? fallback
        const base = target.args[0] === '--base' ? target.args[1]! : target.label
        const round = {
          sha: head, base, model: plan.tier.model, jobId, at: now,
          isCovering: planCovers(plan, fallback),
          ...(facts.isPerson ? { isPerson: true } : {}),
        }
        const isRecorded = await saveLedgerLocked($, stored, { ...ledger, [key]: [...rounds, round] }, pending)
        if (isRecorded) return plan
        // never recorded, so the cap could not count it: an agent waits, the person's review runs and says so
        return facts.isPerson ? { ...plan, isUnrecorded: true as const } : ROUNDS_UNRECORDED_TEXT
      })
      if (booked !== undefined) return booked
      measured = await measureLast()
    }
  } catch (err) {
    if (err instanceof CapLockBusy) return ROUNDS_BUSY_TEXT
    throw err
  }
}

/** The ledger as stored, with the pending settlements applied. Only reads: safe with or without the rounds lock. */
async function readLedgerLocked($: EngineInterface, now: number) {
  const stored = await storeGet($, ROUNDS_KEY)
  const pending: (PendingSettle & { key: string })[] = []
  for (const key of await $.store.keys().catch(() => [] as string[])) {
    if (!key.startsWith(SETTLE_PREFIX)) continue
    const p = parsePending(await storeGet($, key))
    if (p !== undefined) pending.push({ ...p, key })
  }
  return { stored, ledger: settledAll(parseLedger(stored, now), pending), pending }
}

/**
 * Writes the ledger when it changed, then clears the pending settlements it applied (call holding
 * the rounds lock). A write that fails keeps them pending, for the next ledger access to apply, and
 * returns false: the caller's own changes are then only in memory and it must park them.
 */
async function saveLedgerLocked(
  $: EngineInterface,
  stored: unknown,
  ledger: RoundLedger,
  pending: readonly { key: string }[],
): Promise<boolean> {
  if (JSON.stringify(ledger) !== JSON.stringify(stored)) {
    const isWritten = await $.store.set(ROUNDS_KEY, ledger).then(() => true, () => false)
    if (!isWritten) return false
  }
  for (const p of pending) await $.store.delete(p.key).catch(() => undefined)
  return true
}

/** Keeps a settlement under its own store key, for the next ledger access to apply (best effort). */
async function parkSettlement($: EngineInterface, jobId: string, findings?: string): Promise<void> {
  const record: PendingSettle = { jobId, at: Date.now(), ...(findings !== undefined ? { findings } : {}) }
  await $.store.set(`${SETTLE_PREFIX}${jobId}`, record).catch(() => undefined)
}

/** Whether `sha` is still an ancestor of HEAD, and the lines changed since it (committed or not). */
async function sinceSha($: EngineInterface, cwd: string, sha: string): Promise<{ isAncestor: boolean; changedLines: number }> {
  const isAncestor = (await gitOut($, cwd, ['merge-base', '--is-ancestor', sha, 'HEAD'])) !== undefined
  if (!isAncestor) return { isAncestor, changedLines: 0 }
  const stat = await gitOut($, cwd, ['diff', '--shortstat', sha])
  if (stat === undefined) return { isAncestor, changedLines: Number.POSITIVE_INFINITY }
  return { isAncestor, changedLines: shortstatLines(stat) + (await untrackedLines($, cwd)) }
}

/** Lines in the files git does not track yet (`git diff` skips them); Infinity when they cannot be measured or are too many. */
async function untrackedLines($: EngineInterface, cwd: string): Promise<number> {
  const top = (await gitOut($, cwd, ['rev-parse', '--show-toplevel'])) || cwd
  const listed = await gitOut($, top, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (listed === undefined) return Number.POSITIVE_INFINITY
  const files = listed.split('\0').filter(Boolean)
  if (files.length > UNTRACKED_MAX_FILES) return Number.POSITIVE_INFINITY
  let lines = 0
  for (const file of files) {
    lines += textLines(await $.fs.read(`${top}/${file}`).catch(() => '\0'))
    if (lines > UNTRACKED_MAX_LINES) return Number.POSITIVE_INFINITY
  }
  return lines
}

/**
 * A review job's end: its final text kept on its round (the next round checks it), or the round
 * dropped when it failed. A busy ledger lock is retried with a backoff; still busy, the settlement
 * is kept under its own store key and applied by the next ledger access (reconcileSettlements).
 */
async function settleRound($: EngineInterface, jobId: string, findings: string | undefined): Promise<void> {
  for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
    try {
      await withLock($, ROUNDS_LOCK, () => settleLocked($, jobId, findings))
      return
    } catch (err) {
      if (!(err instanceof CapLockBusy)) throw err
    }
    if (attempt < SETTLE_ATTEMPTS) await new Promise<void>(resolve => void $.clock.after(SETTLE_BACKOFF_MS * attempt, resolve))
  }
  debugLog($, `office: review ledger lock busy; round of job ${jobId} settles on the next ledger access`)
  await parkSettlement($, jobId, findings)
}

async function settleLocked($: EngineInterface, jobId: string, findings: string | undefined): Promise<void> {
  const { stored, ledger, pending } = await readLedgerLocked($, Date.now())
  if (!(await saveLedgerLocked($, stored, settledAll(ledger, [{ jobId, findings, at: Date.now() }]), pending))) {
    await parkSettlement($, jobId, findings)
  }
}

/** At load: applies the settlements a busy lock left pending, and drops the rounds of Codex reviews the reload interrupted. */
async function reconcileSettlements($: EngineInterface, interruptedJobIds: readonly string[]): Promise<void> {
  try {
    await withLock($, ROUNDS_LOCK, async () => {
      const { stored, ledger, pending } = await readLedgerLocked($, Date.now())
      const dropped = interruptedJobIds.map(jobId => ({ jobId, at: Date.now() }))
      if (!(await saveLedgerLocked($, stored, settledAll(ledger, dropped), pending))) {
        for (const { jobId } of dropped) await parkSettlement($, jobId)
      }
    })
  } catch (err) {
    if (!(err instanceof CapLockBusy)) throw err
    // an interrupted job's round has no findings to keep: park its drop where the next access finds it
    for (const jobId of interruptedJobIds) await parkSettlement($, jobId)
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
  const verdict = await codexGuard($, options, bin, cwd, tier.model, false)
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
async function rateWindows($: EngineInterface, options: PluginOptions): Promise<RateWindow[]> {
  let windows: RateWindow[]
  try {
    windows = (await $.session.usage()).rateLimits
  } catch {
    return []
  }
  await alertUsage($, options, 'Claude', windows)
  return windows
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
  want: Want = {},
): Promise<Started> {
  let ran: { load: Load; view: BgView }
  try {
    ran = await runningLoad($, options)
  } catch (err) {
    if (err instanceof CapLockBusy) return { ok: false, text: err.message }
    throw err
  }
  const { load, view } = ran
  const full = totalError(load, options)
  if (full) return { ok: false, text: full }
  // The budget guard, in two looks: past the hard limit nothing starts, so no routing call
  // is spent finding out the task's size; in the soft zone the route decides.
  const windows = await rateWindows($, options)
  const caps = budgetCaps(options)
  const isForced = by.isPerson && by.isForced
  const atHard = budgetVerdict(windows, caps, { isSmall: false, isExplicit: false, isForced })
  if (!atHard.isAllowed && atHard.zone === 'hard') return { ok: false, text: `${atHard.reason}. /spawn --force (typed by the person) is the only override.` }
  const cwd = await resolveCwd($, cwdArg)
  // A base or branch the caller named is checked before routing or holding a slot.
  const placement = await checkPlacement($, options, cwd, want)
  if (typeof placement === 'string') return { ok: false, text: placement }
  const now = Date.now()
  const routed = modelArg === undefined ? await route($, options, task) : undefined
  const deliverable = isDeliverable(want.deliverable) ? want.deliverable : undefined
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
  // A slow start (worktree, --bg, a listing) may outlast one reservation: it is renewed until settled.
  const renewal = renewSlot($, slot)
  try {
    return await launchWorker($, options, slot, task, mode, { modelId, effort, routed, cwd, now, warning: verdict.warning, placement, deliverable })
  } finally {
    renewal.cancel()
    await releaseSlot($, slot)
  }
}

type Launch = { modelId: string; effort: Effort; routed?: RouteDecision; cwd: string; now: number; warning?: string; placement: Placement; deliverable?: Deliverable }

/** Starts a worker on a reserved slot; the slot is settled once the worker counts where it runs. */
async function launchWorker(
  $: EngineInterface,
  options: PluginOptions,
  slot: Slot,
  task: string,
  mode: WorkerMode,
  { modelId, effort, routed, cwd, now, warning, placement, deliverable }: Launch,
): Promise<Started> {
  const placed = await placeWorker($, options, task, placement, {
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
  if (placed.error !== undefined) return { ok: false, text: `Worker not started: ${placed.error}` }
  // Gated on its worktree: commits are expected unless the caller said it reports.
  const job: Job = placed.job.worktree !== undefined ? { ...placed.job, deliverable: deliverable ?? 'commit' } : placed.job
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
      const agents = listed?.exitCode === 0 && !listed.isStdoutTruncated ? parseAgentsListing(listed.stdout) : undefined
      bgId = agents !== undefined ? newestBgSince(agents, job.cwd, spawnedAt)?.id : undefined
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
  // The slot is handed to the timer: it holds until runJob has the job in RUNNING (its first, synchronous step),
  // and is counted once meanwhile (lockedLoad skips this process's slots whose job is in RUNNING).
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
  const windows = await rateWindows($, options)
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

async function git($: EngineInterface, argv: string[], timeoutMs = 30000): Promise<GitRun> {
  const r = await $.process
    .run(argv, { timeoutMs })
    .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  return r.exitCode === 0 ? { isOk: true, out: r.stdout } : { isOk: false, out: (r.stderr || r.stdout).trim() || `exit ${r.exitCode}` }
}

/** The base commit and branch name a caller asked a worker's worktree for; unset parts take the defaults. */
type Placement = { base?: string; branch?: string }
/** What a spawn_worker call asks for beyond the task: the placement, and the deliverable (checked by startWorker). */
type Want = Placement & { deliverable?: unknown }

/**
 * A base or branch the caller gave, checked: the base resolved to its commit, the branch a valid
 * name nobody has (not an existing branch, not checked out in any worktree). A refusal is the text.
 */
async function checkPlacement($: EngineInterface, options: PluginOptions, cwd: string, want: Placement): Promise<Placement | string> {
  if (want.base === undefined && want.branch === undefined) return {}
  if (opt(options, 'workerWorktree', 'auto') === 'off') return 'base and branch need worker worktrees, and workerWorktree is off.'
  const common = await git($, projectRootArgv(cwd))
  const root = common.isOk ? repoRootFromCommonDir(common.out) : null
  if (root === null) return `${cwd} is not in a git repository: base and branch need one.`
  let base: string | undefined
  if (want.base !== undefined) {
    const bad = refArgError('base', want.base)
    if (bad !== undefined) return bad
    const sha = await git($, resolveBaseArgv(cwd, want.base))
    if (!sha.isOk || sha.out.trim() === '') return `base "${want.base}" names no commit in ${cwd}.`
    base = sha.out.trim()
  }
  const branch = want.branch
  if (branch !== undefined) {
    const bad = refArgError('branch', branch)
    if (bad !== undefined) return bad
    if (!(await git($, ['git', '-C', root, 'check-ref-format', '--branch', branch])).isOk) return `"${branch}" is not a valid branch name.`
    const listed = await git($, ['git', '-C', root, 'worktree', 'list', '--porcelain'])
    const where = listed.isOk ? checkedOutIn(listed.out, branch) : undefined
    if (where !== undefined) return `Branch ${branch} is checked out in ${where}; pick another name.`
    if ((await git($, ['git', '-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).isOk) {
      return `Branch ${branch} already exists; pick another name, or omit branch for office/<job>-<title>.`
    }
  }
  return { base, branch }
}

/**
 * Gives a worker started in a git repo its own branch in its own worktree:
 * the job then runs there and the task leads with the git rules. Outside a
 * repo, with workerWorktree off, or when a git step fails, it runs in the
 * cwd it was given; `note` says why for the start message. A worker asked
 * for a base or branch never falls back: `error` says why it cannot start.
 */
async function placeWorker(
  $: EngineInterface,
  options: PluginOptions,
  task: string,
  want: Placement,
  job: Job,
): Promise<{ job: Job; task: string; note: string; error?: string }> {
  const here = { job, task, note: '' }
  if (opt(options, 'workerWorktree', 'auto') === 'off') return here
  const common = await git($, projectRootArgv(job.cwd))
  const root = common.isOk ? repoRootFromCommonDir(common.out) : null
  if (root === null) return here
  // A worker asked for a base or branch never shares the checkout: it is not started.
  const isAsked = want.base !== undefined || want.branch !== undefined
  const fallback = (why: string) => (isAsked ? { ...here, error: why } : { ...here, note: `No worktree of its own (${why}): it shares this checkout.` })
  // From the commit the caller is on: a manager in a linked worktree hands out its own branch.
  const head = want.base !== undefined ? { isOk: true, out: want.base } : await git($, ['git', '-C', job.cwd, 'rev-parse', 'HEAD'])
  if (!head.isOk) return fallback(`git rev-parse HEAD: ${head.out}`)
  const base = head.out.trim()
  const dir = worktreeDir(await configDirOf($), root, job.id)
  const branch = want.branch ?? branchName(job.id, job.title)
  const added = await git($, addWorktreeArgv(root, dir, branch, base))
  if (!added.isOk) {
    // `add -b` may have made the branch before failing; a default name holds the new job id, so it is ours.
    if (want.branch === undefined) await git($, ['git', '-C', root, 'branch', '-d', branch])
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

// ── worker gates ($ halves; the rules and texts are in gates.ts) ─────────

/** A worker the gate checks: one with its own worktree, branch and base commit. */
function isGated(job: Job): boolean {
  return job.kind === 'worker' && job.worktree !== undefined && job.project !== undefined && job.branch !== undefined && job.baseRef !== undefined
}

/**
 * Runs a `checking` worker's gate off the caller's path (pollBg awaits finishJob, and checks take
 * minutes). The job holds its slot in RUNNING meanwhile, and a kill there ends the check under way.
 */
function startGate($: EngineInterface, options: PluginOptions, id: string, run = claimGate(id)): void {
  $.clock.after(0, () => void gateWorker($, options, id, run))
}

/** Makes the job its gate's, synchronously: GATES says so (no timeout ends it), and RUNNING holds the gate's kill. */
function claimGate(id: string): GateRun {
  const run: GateRun = { isKilled: false }
  GATES.set(id, run)
  RUNNING.set(id, async () => {
    run.isKilled = true
    run.stop?.()
    return true
  })
  return run
}

/**
 * The gate's verdict ends the job: done (its worktree removed when clean and not red) or rejected (kept).
 * A --bg worker not confirmed stopped is never checked or accepted: failed, its worktree kept. Never twice.
 */
async function gateWorker($: EngineInterface, options: PluginOptions, id: string, run: GateRun): Promise<void> {
  const job = (await read($, JOBS)).find(j => j.id === id)
  if (job?.status !== 'checking' || run.isKilled) return
  // Nothing may write in the worktree while it is checked, and a live worker's worktree is never
  // removed: a --bg worker is stopped first, whatever workerChecks says (pollBg leaves it to the gate).
  if (job.bgId !== undefined && !(await stopBg($, options, job.bgId))) {
    if (run.isKilled) return
    const why = `Could not confirm the worker stopped: its result was not checked or accepted, and its worktree is kept at ${job.worktree}. It may still be running: check it before reusing its branch.`
    await endGate($, id, run, { status: 'failed', block: why, canRemove: false })
    return
  }
  if (run.isKilled) return
  let gate: { report: GateResult; sha?: string }
  try {
    gate = await checkWorker($, options, job, run)
  } catch (err) {
    // The gate's own failure is the one case that fails open: UNVERIFIED, never a pass.
    const opts = { mode: checksMode(options.workerChecks), budgetSec: 0, timeoutMin: 0, runs: [] }
    gate = { report: gateReport({ ...opts, error: String(err).slice(0, 200) }) }
  }
  if (run.isKilled) return
  const { report, sha } = gate
  const status = report.isRejected ? 'rejected' : 'done'
  // A red branch keeps its worktree, enforced or not: someone will look at it.
  const canRemove = status === 'done' && report.verdict !== 'fail'
  await endGate($, id, run, { status, block: report.block, canRemove, gate: { verdict: report.verdict, head: report.head, ...(sha !== undefined ? { sha } : {}) } })
}

/** Ends a `checking` job with the gate's outcome, once, and delivers it; `block` leads the worker's report. */
async function endGate(
  $: EngineInterface,
  id: string,
  run: GateRun,
  end: { status: 'done' | 'rejected' | 'failed'; block: string; canRemove: boolean; gate?: NonNullable<Job['gate']> },
): Promise<void> {
  if (GATES.get(id) === run) {
    GATES.delete(id)
    RUNNING.delete(id)
  }
  const { status, block, canRemove, gate } = end
  const endedAt = Date.now()
  const report = status === 'failed' ? "Worker's report (unchecked)" : "Worker's report"
  const list = await update($, JOBS, jobs =>
    withJob(jobs, id, j =>
      j.status === 'checking'
        ? { ...j, status, endedAt, ...(gate !== undefined ? { gate } : {}), result: capResult(`${block}\n\n${report}:\n${j.result ?? ''}`) }
        : j,
    ),
  )
  const finished = list.find(j => j.id === id)
  if (finished === undefined || finished.endedAt !== endedAt) return
  logInbox($, finishedLine(finished))
  if (gate?.sha !== undefined && finished.branch !== undefined) await recordGate($, finished.branch, gate.sha, gate.verdict, endedAt)
  await deliver($, await settleWorktree($, finished, canRemove))
}

/** Git first (clean, on its branch, commits), then each line of the base commit's .office/checks, a red one re-run once. */
async function checkWorker($: EngineInterface, options: PluginOptions, job: Job, run: GateRun): Promise<{ report: GateResult; sha?: string }> {
  const mode = checksMode(options.workerChecks)
  const timeoutMin = num(options, 'checkTimeoutMin', 10)
  const opts = { mode, budgetSec: num(options, 'checkBudgetSec', 120), timeoutMin, base: job.baseRef, runs: [] as CheckRun[] }
  const { project: root, worktree: dir, branch, baseRef: base } = job
  if (root === undefined || dir === undefined || branch === undefined || base === undefined) throw new Error('no worktree')
  if (mode === 'off') return { report: gateReport(opts) }
  // Commits are counted to the worktree's HEAD: a branch the worker renamed leaves no job ref to count to.
  const [status, head, count, tip] = await Promise.all([
    git($, ['git', '-C', dir, 'status', '--porcelain']),
    git($, ['git', '-C', dir, 'branch', '--show-current']),
    git($, ['git', '-C', dir, 'rev-list', '--count', `${base}..HEAD`]),
    git($, ['git', '-C', dir, 'rev-parse', 'HEAD']),
  ])
  const sha = tip.isOk ? tip.out.trim() : undefined
  const facts = { branch, commits: 0, deliverable: job.deliverable ?? 'commit' }
  // A dirty tree or a HEAD off its branch that git did show is a verdict, whatever else git failed at.
  const isDirty = status.isOk && status.out.trim() !== ''
  const headBranch = head.isOk ? head.out.trim() : undefined
  if (isDirty || (headBranch !== undefined && headBranch !== branch)) {
    return { report: gateReport({ ...opts, git: gitVerdict({ ...facts, isDirty, headBranch: headBranch ?? '' }) }), sha }
  }
  for (const [what, r] of [['status', status], ['branch', head], ['rev-list', count]] as const) {
    if (!r.isOk) throw new Error(`git ${what}: ${r.out.slice(0, 160)}`)
  }
  const git1: GitVerdict = gitVerdict({ ...facts, isDirty, headBranch: branch, commits: Number.parseInt(count.out.trim(), 10) || 0 })
  if (git1.verdict !== 'ok') return { report: gateReport({ ...opts, git: git1 }), sha }
  // From the base commit, never the worktree: a worker cannot edit its own gate.
  const shown = await git($, checksShowArgv(root, base))
  const checks = shown.isOk ? parseChecks(shown.out) : undefined
  for (const line of checks ?? []) {
    if (run.isKilled) break
    let r = await runCheck($, run, line, dir, timeoutMin * 60_000)
    if (shouldRerun(r) && !run.isKilled) r = { ...r, rerun: await runCheck($, run, line, dir, timeoutMin * 60_000) }
    opts.runs.push(r)
    if (!isPassed(r)) break
  }
  return { report: gateReport({ ...opts, git: git1, checks }), sha }
}

/** One check line, `sh -c` in the worktree, to its end, its timeout or a kill (both end the child). */
async function runCheck($: EngineInterface, run: GateRun, line: string, dir: string, timeoutMs: number): Promise<CheckRun> {
  const t0 = await clockNow($)
  let output = ''
  let isTimedOut = false
  let isEnded = false
  let exitCode: number | null = null
  // Killed while the clock was read: never started (and the gate never delivers after a kill).
  if (run.isKilled) return { cmd: line, exitCode, isTimedOut, ms: 0, output }
  // No await from here to run.stop: a kill always finds the child it must end.
  const stream = $.process.spawn({ argv: checkArgv(line), cwd: dir, env: CHECK_ENV })
  const end = () => {
    if (isEnded) return
    isEnded = true
    // Not awaited: a return() queued behind a pending read could wait on the child it ends.
    void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
  }
  run.stop = end
  const timer = $.clock.after(timeoutMs, () => {
    isTimedOut = true
    end()
  })
  try {
    for await (const chunk of stream) {
      output = (output + chunk.text).slice(-OUTPUT_KEEP)
      if (isEnded) break
    }
    if (!isEnded) exitCode = (await stream.result).code
  } catch (err) {
    output = `${output}\n${String(err)}`.slice(-OUTPUT_KEEP)
  } finally {
    timer.cancel()
    if (run.stop === end) run.stop = undefined
  }
  return { cmd: line, exitCode, isTimedOut, ms: (await clockNow($)) - t0, output }
}

/** Keeps the branch's verdict at its tip in $.store; best effort. */
async function recordGate($: EngineInterface, branch: string, sha: string, verdict: string, at: number): Promise<void> {
  try {
    const stored = await storeGet($, GATES_KEY)
    const old = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
    const kept = Object.entries(old).filter(([b]) => b !== branch).slice(-(GATES_KEPT - 1))
    await $.store.set(GATES_KEY, Object.fromEntries([...kept, [branch, { sha, verdict, at }]]))
  } catch (err) {
    debugLog($, `office: gate of ${branch} not recorded: ${String(err)}`)
  }
}
