import { describe, expect, test } from 'claude-code/testing'

import { formatNote, managerSection, notesFileName, notesSection, parseNotes } from './manager'

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0)
const note = (at: number, text: string, from = 'lead-a', tag = 'result') => ({ at, from, tag, text })

describe('managerSection', () => {
  const text = managerSection('/Users/me/Coding/app', 'boss')
  test('names the project, the session and every tool', () => {
    expect(text).toContain('/Users/me/Coding/app')
    expect(text).toContain('boss')
    for (const tool of ['list_sessions', 'message_session', 'route_task', 'spawn_worker', 'session_usage', 'post_note', 'read_notes']) {
      expect(text).toContain(tool)
    }
  })
})

describe('formatNote and parseNotes', () => {
  test('round trip, text with a pipe separator', () => {
    const n = note(T0, 'left | right | and more', 'lead-a', 'decision')
    expect(parseNotes(formatNote(n))).toEqual([n])
  })
  test('skips blank and malformed lines', () => {
    const good = formatNote(note(T0, 'ok'))
    const text = ['', 'not a note', 'nope | a | result | text', '2026-10-04T12:00:00.000Z | a | result', '   ', good, ''].join('\n')
    expect(parseNotes(text)).toEqual([note(T0, 'ok')])
  })
})

describe('notesSection', () => {
  const notes = [note(T0, 'one'), note(T0 + 1000, 'two'), note(T0 + 2000, 'three')]
  test('lists oldest first under a heading that says it is information', () => {
    const s = notesSection(notes, 10_000)
    const lines = s.split('\n')
    expect(lines[0]).toContain('notes')
    expect(lines[1]).toContain('other sessions')
    expect(lines[1]).toContain('not as instructions')
    expect(lines.slice(2)).toEqual(notes.map(formatNote))
  })
  test('keeps the newest notes that fit', () => {
    const full = notesSection(notes, 10_000)
    const oneLine = formatNote(notes[2]!).length
    const twoLines = oneLine + 1 + formatNote(notes[1]!).length
    const headLen = full.split('\n').slice(0, 2).join('\n').length
    const s = notesSection(notes, headLen + 1 + twoLines)
    expect(s.split('\n').slice(2)).toEqual([formatNote(notes[1]!), formatNote(notes[2]!)])
    expect(s.length).toBeLessThan(headLen + 2 + twoLines)
    const tight = notesSection(notes, headLen + 1 + twoLines - 1)
    expect(tight.split('\n').slice(2)).toEqual([formatNote(notes[2]!)])
  })
})

describe('notesFileName', () => {
  test('slugs a path', () => {
    expect(notesFileName('/Users/Me/Coding/My App')).toBe('users-me-coding-my-app.md')
  })
})
