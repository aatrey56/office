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
  activity?: Activity // what its newest tool call says it is doing
}

// From the newest tool call in a transcript: edits and commands, reading, or planning.
export type Activity = 'coding' | 'reviewing' | 'planning'

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

// ── scene (scene/*.ts / scene.tsx) ───────────────────────────────────────
// The pixel office. Everything under hooks/scene/ is pure: the map and the crew go in,
// a frame of palette indices comes out. Only scene.tsx touches `$`.
export type Tile = { x: number; y: number } // tile coordinates, 0,0 at the top left
export type Facing = 'up' | 'down' | 'left' | 'right'
export type RoomId = 'manager' | 'meeting' | 'coding' | 'break' | 'lobby' | 'whiteboard' | 'review'
// dx: pixels to shift the sitter sideways, so one person centres on a two-cell desk.
export type Seat = { room: RoomId; at: Tile; facing: Facing; dx?: number }
// tiles / walkable are row-major, width * height long. `door` is where crew enter and leave.
export type TileMap = {
  width: number
  height: number
  tileSize: number // pixels per tile edge: 16 (hi-res) or 8 (lo-res)
  tiles: number[] // index into Art.tiles
  walkable: boolean[]
  seats: Seat[]
  door: Tile
}

export type CrewRole = 'manager' | 'lead' | 'worker'
// working: at a desk. idle: break room. needs-you: meeting room, waiting on the person.
// reporting: a finished worker walking to the manager. failed: stays with an ✗. leaving: to the door.
export type CrewState = 'working' | 'idle' | 'needs-you' | 'reporting' | 'failed' | 'leaving'
export type Crew = {
  id: string // a lead's sessionId, a worker's job id
  name: string
  role: CrewRole
  project: string // git toplevel of its cwd, else the cwd
  state: CrewState
  room: RoomId
  seat: Tile // where it stands once it has arrived
  seatDx?: number // the seat's sideways shift, in pixels
  facing: Facing
  look: number // which base sprite and color swap, stable per id
  tag?: string // two or three words on what it is doing
  activity?: Activity
  isSelectable: boolean // leads and managers only; workers never
  isSelf: boolean
}

// A crew member on screen: pixel position, the tiles still to walk, and its animation step.
export type Actor = {
  id: string
  x: number // pixels, top left of the sprite's tile
  y: number
  path: Tile[] // remaining waypoints, next first; empty once arrived
  facing: Facing
  step: number // animation frame counter
  isGone: boolean // walked out of the door; drop it
}

// One drawn frame: palette indices, row-major, width * height long. Never stored in $.state.
export type Frame = { width: number; height: number; pixels: Uint8Array }
// A sprite or tile: rows of palette indices, 0 = transparent (sprites only).
export type Bitmap = { width: number; height: number; pixels: Uint8Array }
export type SpritePose = 'stand' | 'walk1' | 'walk2' | 'sit' | 'type'
export type Art = {
  palette: number[] // 0xRRGGBB, at most 256; index 0 is the transparent slot for sprites
  tiles: Bitmap[] // tileSize square, opaque
  sprites: Record<Facing, Record<SpritePose, Bitmap>>[] // one entry per look, every facing drawn (none mirrored)
  bubbles: { needsYou: Bitmap; failed: Bitmap; music: Bitmap[]; thinking: Bitmap }
}

// ── evals (evals.ts / jobs.tsx /route-eval) ──────────────────────────────
export type RouteCase = { id: string; task: string; model: ModelTier; effort: Effort; why: string }
export type RouteOutcome = { id: string; model: ModelTier; effort: Effort; latencyMs: number } | { id: string; error: string }
export type EvalReport = {
  backend: RouteDecision['backend']
  total: number
  answered: number // cases the backend returned a decision for
  exact: number // model and effort both match
  modelMatch: number
  withinOneTier: number
  effortMatch: number
  overRouted: number // picked a more expensive model than the label
  underRouted: number // picked a cheaper one
  medianLatencyMs: number
  misses: { id: string; want: string; got: string }[] // every non-exact case, as "model/effort"
}

// ── budget (budget.ts / jobs.tsx) ────────────────────────────────────────
export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string }
export type BudgetCaps = { softFiveHourPct: number; softSevenDayPct: number; hardPct: number }
export type BudgetVerdict =
  | { isAllowed: true; zone: 'open' | 'soft' | 'hard'; warning?: string } // 'hard' only when the person forced it
  | { isAllowed: false; zone: 'soft' | 'hard'; reason: string }

// ── manager (manager.ts / manage.tsx) ────────────────────────────────────
// managers: project root → the session managing it. Kept in $.store 'managers', mirrored in state.
export type ManagerEntry = { sessionId: string; name: string; since: number }
export type Note = { at: number; from: string; tag: string; text: string }

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
      // scene
      sceneTick: number // bumped by the animation timer while the scene is up; read only by the scene
      sceneSelected: string | null // the selected crew id (leads and managers only)
      sceneProject: string | null // the project office shown; null is the lobby
      sceneZoom: 'side' | 'big' | 'max' // dock width the scene asks for; persisted in $.store 'sceneZoom'
      officeView: 'scene' | 'text' // what the /office pane shows; persisted in $.store 'officeView'
      // manager
      managers: Record<string, ManagerEntry>
    }
  }
}
