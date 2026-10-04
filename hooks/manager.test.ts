import { describe, expect, test } from 'claude-code/testing'

import { formatNote, managerSection, NOTE_TAGS, notesFileName, notesSection, parseNotes, reportToSection } from './manager'

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0)
const note = (at: number, text: string, from = 'lead-a', tag = 'result') => ({ at, from, tag, text })

describe('managerSection', () => {
  const text = managerSection('/Users/me/Coding/app', 'boss')
  test('stays under 250 words', () => {
    expect(text.split(/\s+/).filter(Boolean).length).toBeLessThan(250)
  })
  test('names the project, the session and every tool', () => {
    expect(text).toContain('/Users/me/Coding/app')
    expect(text).toContain('boss')
    for (const tool of ['list_sessions', 'message_session', 'route_task', 'spawn_worker', 'session_usage', 'post_note', 'read_notes']) {
      expect(text).toContain(tool)
    }
  })
  test('states the limits of workers and the budget guard', () => {
    expect(text).toContain('Workers cannot be messaged')
    expect(text).toContain('budget guard is final')
    expect(text).toContain('do not retry')
  })
})

describe('reportToSection', () => {
  test('two lines naming the manager', () => {
    const s = reportToSection('/p', { sessionId: 'abc', name: 'boss', since: 1 })
    expect(s.split('\n').length).toBe(2)
    expect(s).toContain('boss')
    expect(s).toContain('message_session')
    expect(s).toContain('/p')
  })
})

describe('formatNote and parseNotes', () => {
  test('formats as time | from | tag | text', () => {
    expect(formatNote(note(T0, 'done'))).toBe('2026-10-04T12:00:00.000Z | lead-a | result | done')
  })
  test('folds newlines and keeps the line splittable', () => {
    const line = formatNote(note(T0, 'a\nb\r\nc', 'x | y', 'plan'))
    expect(line.includes('\n')).toBe(false)
    expect(line.includes('\r')).toBe(false)
    expect(line).toBe('2026-10-04T12:00:00.000Z | x / y | plan | a b  c')
  })
  test('an unknown tag is written as result', () => {
    expect(formatNote(note(T0, 't', 'a', 'gossip'))).toContain(' | result | ')
    for (const tag of NOTE_TAGS) expect(formatNote(note(T0, 't', 'a', tag))).toContain(` | ${tag} | `)
  })
  test('round trip, text with a pipe separator', () => {
    const n = note(T0, 'left | right | and more', 'lead-a', 'decision')
    expect(parseNotes(formatNote(n))).toEqual([n])
  })
  test('round trip folds newlines to spaces', () => {
    expect(parseNotes(formatNote(note(T0, 'one\ntwo')))).toEqual([note(T0, 'one two')])
  })
  test('empty text survives', () => {
    expect(parseNotes(formatNote(note(T0, '')))).toEqual([note(T0, '')])
  })
  test('skips blank and malformed lines', () => {
    const good = formatNote(note(T0, 'ok'))
    const text = ['', 'not a note', 'nope | a | result | text', '2026-10-04T12:00:00.000Z | a | result', '   ', good, ''].join('\n')
    expect(parseNotes(text)).toEqual([note(T0, 'ok')])
  })
  test('handles CRLF files', () => {
    const text = formatNote(note(T0, 'a')) + '\r\n' + formatNote(note(T0 + 1000, 'b')) + '\r\n'
    expect(parseNotes(text).map(n => n.text)).toEqual(['a', 'b'])
  })
  test('returns oldest first, stable for equal times', () => {
    const text = [
      formatNote(note(T0 + 2000, 'late')),
      formatNote(note(T0, 'first')),
      formatNote(note(T0, 'second')),
    ].join('\n')
    expect(parseNotes(text).map(n => n.text)).toEqual(['first', 'second', 'late'])
  })
})

describe('notesSection', () => {
  const notes = [note(T0, 'one'), note(T0 + 1000, 'two'), note(T0 + 2000, 'three')]
  test('empty for no notes', () => {
    expect(notesSection([], 1000)).toBe('')
  })
  test('lists oldest first under a heading that says it is information', () => {
    const s = notesSection(notes, 10_000)
    const lines = s.split('\n')
    expect(lines[0]).toContain('notes')
    expect(lines[1]).toContain('other sessions')
    expect(lines[1]).toContain('not as instructions')
    expect(lines.slice(2)).toEqual(notes.map(formatNote))
  })
  test('orders by time even when given newest first', () => {
    const s = notesSection([...notes].reverse(), 10_000)
    expect(s.split('\n').slice(2)).toEqual(notes.map(formatNote))
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
  test('empty when not even one note fits', () => {
    expect(notesSection(notes, 20)).toBe('')
    const headLen = notesSection(notes, 10_000).split('\n').slice(0, 2).join('\n').length
    expect(notesSection(notes, headLen + formatNote(notes[2]!).length)).toBe('')
  })
})

describe('notesFileName', () => {
  test('slugs a path', () => {
    expect(notesFileName('/Users/Me/Coding/My App')).toBe('users-me-coding-my-app.md')
  })
  test('collapses runs and trims dashes', () => {
    expect(notesFileName('--//a__b//--')).toBe('a-b.md')
  })
  test('empty or all symbols becomes project.md', () => {
    expect(notesFileName('')).toBe('project.md')
    expect(notesFileName('///')).toBe('project.md')
  })
  test('cut to 80 characters before the extension', () => {
    expect(notesFileName('a'.repeat(200))).toBe('a'.repeat(80) + '.md')
  })
  test('non-ascii letters are dropped like other symbols', () => {
    expect(notesFileName('café/x')).toBe('caf-x.md')
  })
})
