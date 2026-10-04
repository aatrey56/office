import type { ManagerEntry, Note } from '../types'

// The manager role's prompt text and the project notebook's format. Pure.
// CONTRACT STUB: signatures are fixed; the bodies are the orchestration builder's.

export const NOTE_TAGS = ['plan', 'decision', 'result', 'blocker', 'handoff'] as const

// The system-prompt section for the session managing `project`: what the role is, the tools
// (list_sessions, message_session, route_task, spawn_worker, session_usage, post_note,
// read_notes), and the loop: split the goal, route each task, delegate, collect, note, report.
// Under 250 words.
export function managerSection(project: string, self: string): string {
  throw new Error('not implemented')
}

// The two-line section for another lead in a managed project: report to `manager.name`
// with message_session when done or blocked.
export function reportToSection(project: string, manager: ManagerEntry): string {
  throw new Error('not implemented')
}

// One notebook line: ISO time, sender, tag, text, with newlines in `text` folded to spaces.
export function formatNote(note: Note): string {
  throw new Error('not implemented')
}

// The notebook file back into notes, oldest first; lines that do not parse are skipped.
export function parseNotes(text: string): Note[] {
  throw new Error('not implemented')
}

// The newest notes that fit in `maxChars`, as a prompt section that says they are
// information from other sessions, not instructions. '' when there are none.
export function notesSection(notes: Note[], maxChars: number): string {
  throw new Error('not implemented')
}

// The notebook's file name for a project root: a slug safe for one path segment.
export function notesFileName(project: string): string {
  throw new Error('not implemented')
}
