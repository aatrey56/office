import type { Activity, SessionCard } from '../types'

// Registry of live Claude Code processes (<config>/sessions/<pid>.json) and the
// last assistant line of each one's transcript. The registry folder also holds
// `<pid>.<hash>.key` files, which are secrets: only `<digits>.json` is read.
// Pure helpers only: the validator never follows `$` across an import, so the
// reads that need `$` live in board.tsx.

const REGISTRY_FILE = /^\d+\.json$/
const TEXT_MAX = 600 // a few sentences: the scene shows them in full, the board clips to its width
export const SLUG_MAX = 200 // the engine cuts longer slugs and appends a hash

export type Registered = Omit<SessionCard, 'isSelf' | 'lastText'>

export function isRegistryFile(name: string): boolean {
  return REGISTRY_FILE.test(name)
}

// The engine's project-folder rule: every non-alphanumeric character becomes '-'.
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function parseRegistry(text: string): Registered | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.pid !== 'number' || typeof r.sessionId !== 'string' || typeof r.cwd !== 'string') return null
  // A parked process (`/exit` moved its conversation to a background job) only shows that job;
  // its sessionId is stale and takes no messages. The job has its own entry, so skip this one.
  if (typeof r.parkedJobId === 'string' && r.parkedJobId) return null
  const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : typeof r.startedAt === 'number' ? r.startedAt : 0

  return {
    pid: r.pid,
    sessionId: r.sessionId,
    cwd: r.cwd,
    name: typeof r.name === 'string' && r.name ? r.name : r.sessionId.slice(0, 8),
    status: typeof r.status === 'string' ? r.status : 'unknown',
    kind: typeof r.kind === 'string' ? r.kind : 'unknown',
    updatedAt,
  }
}

export function clip(text: string, max = TEXT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

// The last JSONL row with type 'assistant' whose content holds a text block.
export function lastAssistantText(tail: string): string | undefined {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('"assistant"')) continue
    let row: { type?: unknown; message?: { content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.type !== 'assistant' || !Array.isArray(row.message?.content)) continue
    const texts = (row.message.content as { type?: unknown; text?: unknown }[])
      .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
      .map(block => block.text as string)
    if (texts.length > 0) return clip(texts.join(' '))
  }
  return undefined
}

// The newest tool call in a transcript tail, as an activity: editing files or running commands is
// coding, reading and searching is reviewing, plans, todo lists, research and delegation are planning.
const CODING = /^(Edit|MultiEdit|Write|NotebookEdit|Bash|PowerShell)$/
const REVIEWING = /^(Read|Grep|Glob|LS|mcp__office__codex_review)$/
const PLANNING = /^(EnterPlanMode|ExitPlanMode|TodoWrite|TaskCreate|TaskUpdate|WebSearch|WebFetch|Agent|Task|Workflow|mcp__office__route_task|mcp__office__spawn_worker)$/
export function lastActivity(tail: string): Activity | undefined {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('"tool_use"')) continue
    let row: { type?: unknown; message?: { content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.type !== 'assistant' || !Array.isArray(row.message?.content)) continue
    const tools = (row.message.content as { type?: unknown; name?: unknown }[]).filter(b => b?.type === 'tool_use' && typeof b.name === 'string')
    const name = tools[tools.length - 1]?.name as string | undefined
    if (!name) continue
    if (CODING.test(name)) return 'coding'
    if (REVIEWING.test(name)) return 'reviewing'
    if (PLANNING.test(name)) return 'planning'
    return undefined
  }
  return undefined
}

export function shortCwd(cwd: string, home: string | undefined): string {
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`
  return cwd
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function resumeCommand(card: Pick<SessionCard, 'cwd' | 'sessionId'>): string {
  return `cd '${card.cwd.replace(/'/g, `'\\''`)}' && claude --resume ${card.sessionId}`
}

// Which rows the compact band shows: at most min(rows-1, 6) sessions (one row
// fewer while the message Input shows), slid so the selected one is in view.
export function bandWindow(count: number, picked: number, maxRows: number, hasInput: boolean): { start: number; end: number; more: number } {
  const room = Math.max(1, Math.min(maxRows - 1 - (hasInput ? 1 : 0), 6))
  const shown = Math.min(count, room)
  const start = picked < 0 ? 0 : Math.max(0, Math.min(picked - shown + 1, count - shown))
  return { start, end: start + shown, more: count - shown }
}

export type BoardMode = 'pane' | 'band'

export function parseMode(value: unknown): BoardMode {
  return value === 'band' ? 'band' : 'pane'
}
