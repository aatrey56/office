import { describe, expect, test } from 'claude-code/testing'

import { formatNote, notesSection, parseNotes } from './manager'

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0)
const note = (at: number, text: string, from = 'lead-a', tag = 'result') => ({ at, from, tag, text })

describe('formatNote and parseNotes', () => {
  test('round trip, text with a pipe separator', () => {
    const n = note(T0, 'left | right | and more', 'lead-a', 'decision')
    expect(parseNotes(formatNote(n))).toEqual([n])
  })
})

describe('notesSection', () => {
  const notes = [note(T0, 'one'), note(T0 + 1000, 'two'), note(T0 + 2000, 'three')]
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
