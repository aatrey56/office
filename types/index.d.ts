// Contract for the `office` mod. Each feature owns its own block; edit only yours.

// ── board (sessions.ts / board.tsx) ──────────────────────────────────────
export type SessionCard = {
  pid: number
  sessionId: string
  name: string
  cwd: string
  status: string // 'busy' | 'idle' | ... as ~/.claude/sessions/<pid>.json reports
  kind: string // 'interactive' | 'print' | ...
  updatedAt: number
  isSelf: boolean
  lastText?: string // last assistant text, trimmed
}

// ── jobs (codex.ts / router.ts / spawn.ts / jobs.tsx) ────────────────────
export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RouteDecision = {
  model: ModelTier
  effort: Effort
  confidence: number // 0..1
  reason: string
  backend: 'jev' | 'claude' | 'rules'
  latencyMs: number
}
export type Job = {
  id: string
  kind: 'codex-review' | 'codex-exec' | 'worker'
  title: string
  cwd: string
  status: 'running' | 'blocked' | 'done' | 'failed' // blocked: a --bg worker waits on a person
  startedAt: number
  endedAt?: number
  model?: string
  effort?: Effort
  route?: RouteDecision
  tail: string // last ~2KB of output
  result?: string // final message / review text
  mode?: 'bg' | 'headless' | 'subagent' // worker jobs only
  agentId?: string // subagent-mode worker's loop id
  bgId?: string // bg-mode worker: the short id `claude --bg` printed (attach/logs/stop take it)
  sessionId?: string // bg-mode worker: its session id (names its transcript)
  isSelected?: boolean // the /jobs pane's selection (at most one job)
}

// ── manga (manga.tsx) ────────────────────────────────────────────────────
// pages: the PNG name each page shows from `dir` (a chapter folder, or a cbz's cache dir);
// ready[i]: that PNG exists (a cbz page may still be converting); loading: a cbz is unpacking.
export type MangaShelf = {
  series: string
  chapters: string[]
  pages: string[]
  dir: string
  ready: boolean[]
  loading: boolean
}

declare module 'claude-code' {
  interface PluginState {
    office: {
      // board
      sessions: SessionCard[]
      selected: string | null
      boardTick: number // bumped each poll while the board pane or band is up; read only by the board
      boardMode: 'pane' | 'band' // where the board draws; persisted in $.store 'boardMode'
      // jobs
      jobs: Job[]
      lastRoute: RouteDecision | null
      jobsTick: number // bumped every 2 s while a job runs; read only by the jobs pane
      // manga
      shelf: MangaShelf
      chapter: number
      page: number
    }
  }
}
