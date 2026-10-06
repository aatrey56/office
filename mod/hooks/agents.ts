import type { AgentRecord } from '../types'
import { clip, lastActivity, projectSlug, SLUG_MAX } from './sessions'

// A live session's subagents, the pure half: where their transcripts are and what one says.
// Subagents write <config>/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl beside an
// agent-<id>.meta.json; workflow agents go one level down, in subagents/workflows/<runId>/.
// scene.tsx lists and tails them.
//
// Finished rule: an agent is finished when its newest assistant row ends the turn
// (stop_reason 'end_turn') or calls a hand-back tool (SubagentHandback for Agent calls,
// StructuredOutput for workflow agents); it ended at the file's last write. A transcript
// untouched for STALE_MS is finished too (killed, or its session went away). Anything else runs.

export const STALE_MS = 2 * 60_000 // the owner's pick: a crashed agent leaves within 2 minutes
const NAME_MAX = 16
const AGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/
const HAND_BACK = /^(SubagentHandback|StructuredOutput)$/

export type AgentFile = { id: string; path: string; meta: string; mtimeMs: number }
type Entry = { name: string; kind: string; mtimeMs: number }

/** The session's subagents folder; a long (cut + hashed) slug is found by `prefix`, as spawn.ts transcriptPath does. */
export function subagentsDir(configDir: string, cwd: string, sessionId: string): { dir?: string; projects: string; prefix?: string } {
  const projects = `${configDir.replace(/\/$/, '')}/projects`
  const slug = projectSlug(cwd)
  if (slug.length <= SLUG_MAX) return { dir: `${projects}/${slug}/${sessionId}/subagents`, projects }
  return { projects, prefix: `${slug.slice(0, SLUG_MAX)}-` }
}

/** The agent transcripts in one listing of `dir` written within STALE_MS of `now`: older ones never show. */
export function freshAgentFiles(dir: string, entries: Entry[], now: number): AgentFile[] {
  const out: AgentFile[] = []
  for (const e of entries) {
    const id = e.kind === 'file' ? e.name.match(AGENT_FILE)?.[1] : undefined
    if (!id || now - e.mtimeMs > STALE_MS) continue
    out.push({ id, path: `${dir}/${e.name}`, meta: `${dir}/agent-${id}.meta.json`, mtimeMs: e.mtimeMs })
  }
  return out
}

/** One agent from its transcript tail and meta text; `parent` fills what the tail lacks. */
export function parseAgent(
  file: AgentFile,
  tail: string,
  meta: string | undefined,
  parent: { sessionId: string; cwd: string },
  now: number,
): AgentRecord {
  let cwd: string | undefined
  let isEnded: boolean | undefined
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0 && (cwd === undefined || isEnded === undefined); i--) {
    const line = lines[i]
    if (!line?.startsWith('{')) continue
    let row: { type?: unknown; cwd?: unknown; message?: { content?: unknown; stop_reason?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (cwd === undefined && typeof row.cwd === 'string' && row.cwd) cwd = row.cwd
    if (isEnded !== undefined || row.type !== 'assistant' || !Array.isArray(row.message?.content)) continue
    const blocks = row.message.content as { type?: unknown; name?: unknown }[]
    isEnded =
      row.message.stop_reason === 'end_turn' || blocks.some(b => b?.type === 'tool_use' && typeof b.name === 'string' && HAND_BACK.test(b.name))
  }
  const activity = lastActivity(tail)
  const isFinished = isEnded === true || now - file.mtimeMs > STALE_MS
  return {
    id: file.id,
    sessionId: parent.sessionId,
    cwd: cwd ?? parent.cwd,
    name: metaName(meta) ?? file.id,
    ...(activity ? { activity } : {}),
    ...(isFinished ? { endedAt: file.mtimeMs } : {}),
  }
}

function metaName(text: string | undefined): string | undefined {
  if (!text) return undefined
  try {
    const m = JSON.parse(text) as { description?: unknown; agentType?: unknown }
    const name = typeof m.description === 'string' && m.description ? m.description : typeof m.agentType === 'string' ? m.agentType : ''
    return name ? clip(name, NAME_MAX) : undefined
  } catch {
    return undefined
  }
}
