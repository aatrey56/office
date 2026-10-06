import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { ManagerEntry, Note, SessionCard } from '../types'
import { formatNote, managerSection, NOTE_TAGS, notesFileName, notesSection, parseNotes, reportToSection } from './manager'
import { projectRootArgv, repoRootFromCommonDir } from './worktree'

// Owner: orchestration. `/office manage` makes this session the manager of its project:
// its system prompt gains the manager role, the project's other sessions are told to report
// to it, and every lead in the project shares one notebook (post_note / read_notes).
// The prompt text and the notebook format are in manager.ts; the `$` calls live here.

const STORE_KEY = 'managers'
const NOTES_IN_PROMPT = 1200 // characters of notebook a lead's prompt carries
const READ_DEFAULT = 10
const READ_MAX = 50
const POST_TOOL = 'mcp__office__post_note'
const READ_TOOL = 'mcp__office__read_notes'

// project root → its manager, mirrored from $.store so the scene can draw the manager's office.
const MANAGERS = atom({ plugin: 'office', key: 'managers' } as const, {} as Record<string, ManagerEntry>)
const SESSIONS = atom({ plugin: 'office', key: 'sessions' } as const, [] as SessionCard[])

type Input = Record<string, unknown>

// This session's project never changes, so one `git rev-parse` serves every prompt.
// The common dir, not the toplevel: a worker in a worktree belongs to its main repo's project.
let projectCache: string | undefined

async function projectOfSession($: EngineInterface): Promise<string> {
  if (projectCache !== undefined) return projectCache
  const cwd = await $.session.cwd()
  const ran = await $.process.run(projectRootArgv(cwd)).catch(() => undefined)
  if (!ran) return cwd // could not run: decide again next time
  projectCache = (ran.exitCode === 0 && repoRootFromCommonDir(ran.stdout)) || cwd
  return projectCache
}

async function isWorker($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OFFICE_WORKER')) === '1'
}

// The store is shared by every session on this machine, so what comes back is checked.
async function loadManagers($: EngineInterface): Promise<Record<string, ManagerEntry>> {
  const raw = await $.store.get(STORE_KEY).catch(() => undefined)
  const out: Record<string, ManagerEntry> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [project, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const m = v as Record<string, unknown>
    if (typeof m.sessionId === 'string' && typeof m.name === 'string' && typeof m.since === 'number') {
      out[project] = { sessionId: m.sessionId, name: m.name, since: m.since }
    }
  }
  return out
}

async function saveManagers($: EngineInterface, managers: Record<string, ManagerEntry>): Promise<void> {
  await $.store.set(STORE_KEY, managers)
  await update($, MANAGERS, () => managers)
}

async function selfName($: EngineInterface): Promise<string> {
  const self = (await read($, SESSIONS)).find(card => card.isSelf)
  return self?.name ?? (await $.session.id()).slice(0, 8)
}

async function notesFile($: EngineInterface, project: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  return `${home}/.claude/office/notes/${notesFileName(project)}`
}

async function readNotes($: EngineInterface, project: string): Promise<Note[]> {
  const text = await $.fs.read(await notesFile($, project)).catch(() => '')
  return parseNotes(text)
}

export function installManage(on: On) {
  // A matcher of its own: the other features hook session.start too, and a repeat throws.
  on('session.start', { cwd: /\S/ }, async ($, e, next) => {
    const started = await next(e)
    // A worker gets neither tool: a hijacked worker must not be able to write into the
    // prompts of the person's lead sessions.
    if (!(await isWorker($))) {
      await $.tool.register({
        name: 'post_note',
        description:
          "Appends one note to this project's shared notebook, which every lead session in the project reads. Use it for plans, decisions, results, blockers and handoffs worth keeping; not for chatter.",
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The note, one or two sentences' },
            tag: { type: 'string', enum: [...NOTE_TAGS], description: 'What kind of note it is' },
          },
          required: ['text'],
        },
      })
      await $.tool.register({
        name: 'read_notes',
        description: "Returns the newest notes from this project's shared notebook, oldest first: time, sender, tag, text.",
        inputSchema: {
          type: 'object',
          properties: { last: { type: 'number', description: `How many notes, newest; default ${READ_DEFAULT}, at most ${READ_MAX}` } },
        },
      })
    }
    const managersNow = await loadManagers($)
    await update($, MANAGERS, () => managersNow)
    return started
  })

  // `/office manage` and `/office manage off`; board.tsx passes these on with next(e).
  on('command.run', { command: 'office' }, async ($, e, next) => {
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    if (arg !== 'manage' && arg !== 'manage off') return next(e)
    const project = await projectOfSession($)
    const sessionId = await $.session.id()
    const managers = await loadManagers($)
    const current = managers[project]

    if (arg === 'manage off') {
      if (current?.sessionId !== sessionId) {
        return { text: current ? `This session is not the manager of ${project}; ${current.name} is.` : `${project} has no manager.` }
      }
      const { [project]: _gone, ...rest } = managers
      await saveManagers($, rest)
      return { text: `This session no longer manages ${project}.` }
    }

    const name = await selfName($)
    await saveManagers($, { ...managers, [project]: { sessionId, name, since: Date.now() } })
    const took = current && current.sessionId !== sessionId ? ` It takes over from ${current.name}.` : ''
    return {
      text: `This session (${name}) now manages ${project}.${took} From its next turn it has the manager role; other sessions in this project are told to report to it. /office manage off ends it.`,
    }
  })

  on('tool.call', { tool: POST_TOOL }, async ($, e) => {
    if (await isWorker($)) return { deny: 'post_note is not available to office workers' }
    const input = e as unknown as Input
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (!text) return { deny: 'post_note needs text.' }
    const tag = typeof input.tag === 'string' ? input.tag : 'result'
    const project = await projectOfSession($)
    const file = await notesFile($, project)
    const line = formatNote({ at: Date.now(), from: await selfName($), tag, text })
    // There is no append: the file is read and written whole. Two sessions posting in the
    // same instant can lose one note; notes are for a person's pace, so that is accepted.
    const before = await $.fs.read(file).catch(() => '')
    await $.fs.write(file, before === '' || before.endsWith('\n') ? `${before}${line}\n` : `${before}\n${line}\n`)
    return { result: `Noted in the ${project} notebook.` }
  })

  on('tool.call', { tool: READ_TOOL }, async ($, e) => {
    if (await isWorker($)) return { deny: 'read_notes is not available to office workers' }
    const asked = (e as unknown as Input).last
    const last = typeof asked === 'number' && asked >= 1 ? Math.min(READ_MAX, Math.floor(asked)) : READ_DEFAULT
    const project = await projectOfSession($)
    const notes = (await readNotes($, project)).slice(-last)
    if (notes.length === 0) return { result: `No notes yet for ${project}.` }
    return { result: notes.map(formatNote).join('\n') }
  })

  // The role, and the notebook's newest entries, ride at the end of the system prompt.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (await isWorker($)) return composed
    let project: string
    let sessionId: string
    let managers: Record<string, ManagerEntry>
    try {
      project = await projectOfSession($)
      sessionId = await $.session.id()
      managers = await loadManagers($)
    } catch {
      return composed // a prompt is never held up by this
    }
    const manager = managers[project]
    if (!manager) return composed

    const added = [
      manager.sessionId === sessionId
        ? { id: 'office:manager', text: managerSection(project, manager.name), scope: 'session' as const }
        : { id: 'office:report-to', text: reportToSection(project, manager), scope: 'session' as const },
    ]
    const notes = notesSection(await readNotes($, project).catch(() => []), NOTES_IN_PROMPT)
    if (notes) added.push({ id: 'office:notes', text: notes, scope: 'session' as const })
    return { ...composed, sections: [...composed.sections, ...added] }
  })

  // A manager that ends stops being one, so nobody is told to report to a session that is gone.
  on('session.end', async ($, e, next) => {
    try {
      const managers = await loadManagers($)
      const mine = Object.entries(managers).filter(([, m]) => m.sessionId === e.sessionId)
      if (mine.length > 0) {
        const rest = { ...managers }
        for (const [project] of mine) delete rest[project]
        await $.store.set(STORE_KEY, rest)
      }
    } catch {
      // ending is never held up by this
    }
    return next(e)
  })
}
