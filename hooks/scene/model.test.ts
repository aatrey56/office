import { describe, expect, test } from 'claude-code/testing'

import type { Crew, Job, ManagerEntry, SessionCard, TileMap } from '../../types'
import { assignSeats, deriveCrew, roomFor, stateOf } from './model'

const NOW = 1_000_000
const LINGER = 10_000

function card(over: Partial<SessionCard> = {}): SessionCard {
  return {
    pid: 1,
    sessionId: 's1',
    name: 'alpha',
    cwd: '/repo/a',
    status: 'busy',
    kind: 'interactive',
    updatedAt: NOW,
    isSelf: false,
    ...over,
  }
}

function job(over: Partial<Job> = {}): Job {
  return { id: 'j1', kind: 'worker', title: 'fix the parser', cwd: '/repo/a', status: 'running', startedAt: NOW - 5000, tail: '', ...over }
}

const ROOTS = { '/repo/a': '/repo/a', '/repo/a/sub': '/repo/a', '/tmp/x': null }
const derive = (cards: SessionCard[], jobs: Job[] = [], managers: Record<string, ManagerEntry> = {}) =>
  deriveCrew(cards, jobs, managers, ROOTS, NOW, LINGER)

describe('stateOf and roomFor', () => {
  test('lead and manager statuses', () => {
    for (const role of ['lead', 'manager'] as const) {
      expect(stateOf('busy', role)).toBe('working')
      expect(stateOf('idle', role)).toBe('idle')
      expect(stateOf('waiting', role)).toBe('needs-you')
      expect(stateOf('blocked', role)).toBe('needs-you')
      expect(stateOf('zzz', role)).toBe('idle')
    }
  })
  test('rooms', () => {
    expect(roomFor('working', 'lead')).toBe('coding')
    expect(roomFor('working', 'worker')).toBe('coding')
    expect(roomFor('working', 'manager')).toBe('manager')
    expect(roomFor('idle', 'lead')).toBe('break')
    expect(roomFor('needs-you', 'lead')).toBe('meeting')
    expect(roomFor('reporting', 'worker')).toBe('manager')
    expect(roomFor('failed', 'worker')).toBe('manager')
    expect(roomFor('leaving', 'worker')).toBe('lobby')
  })
})

describe('deriveCrew sessions', () => {
  test('the session named in managers[project] is the manager', () => {
    const managers = { '/repo/a': { sessionId: 's2', name: 'beta', since: 1 } }
    const crew = derive([card(), card({ sessionId: 's2', name: 'beta' }), card({ sessionId: 's3', cwd: '/tmp/x' })], [], managers)
    expect(crew.map(c => c.role)).toEqual(['lead', 'manager', 'lead'])
    expect(crew[1]).toMatchObject({ room: 'manager', state: 'working', isSelectable: true })
  })
})

describe('deriveCrew workers', () => {
  test('only worker jobs become crew, and never selectable', () => {
    const crew = derive([], [job(), job({ id: 'j2', kind: 'codex-exec' }), job({ id: 'j3', kind: 'codex-review' })])
    expect(crew.map(c => c.id)).toEqual(['j1'])
    expect(crew[0]).toMatchObject({ role: 'worker', isSelectable: false, isSelf: false, state: 'working', room: 'coding' })
  })
  test('done worker: reporting, then leaving, then gone (boundaries)', () => {
    const at = (since: number, status: Job['status'] = 'done') => derive([], [job({ status, endedAt: NOW - since })])
    expect(at(0)[0]).toMatchObject({ state: 'reporting', room: 'manager' })
    expect(at(LINGER / 2 - 1)[0]?.state).toBe('reporting')
    expect(at(LINGER / 2)[0]).toMatchObject({ state: 'leaving', room: 'lobby' })
    expect(at(LINGER)[0]?.state).toBe('leaving')
    expect(at(LINGER + 1)).toEqual([])
  })
})

// 12 x 6 map: manager seats at (1,1),(3,1); coding seats at (1,3),(3,3); floor everywhere but the top wall.
function makeMap(): TileMap {
  const width = 12
  const height = 6
  return {
    width,
    height,
    tileSize: 16,
    tiles: new Array(width * height).fill(0),
    walkable: Array.from({ length: width * height }, (_, i) => Math.floor(i / width) > 0),
    seats: [
      { room: 'manager', at: { x: 1, y: 1 }, facing: 'down' },
      { room: 'manager', at: { x: 3, y: 1 }, facing: 'left' },
      { room: 'coding', at: { x: 1, y: 3 }, facing: 'up' },
      { room: 'coding', at: { x: 3, y: 3 }, facing: 'right' },
    ],
    door: { x: 11, y: 5 },
  }
}

function member(id: string, over: Partial<Crew> = {}): Crew {
  return {
    id,
    name: id,
    role: 'lead',
    project: '/repo/a',
    state: 'working',
    room: 'coding',
    seat: { x: 0, y: 0 },
    facing: 'down',
    look: 0,
    isSelectable: true,
    isSelf: false,
    ...over,
  }
}

describe('assignSeats', () => {
  test('seats are stable across calls, even when the order changes', () => {
    const map = makeMap()
    const first = assignSeats([member('a'), member('b')], map, '/repo/a', [])
    const second = assignSeats([member('c'), member('b'), member('a')], map, '/repo/a', first)
    expect(second[1]?.seat).toEqual(first[1]?.seat)
    expect(second[2]?.seat).toEqual(first[0]?.seat)
    expect(second[0]?.seat).not.toEqual(first[0]?.seat) // the newcomer takes neither kept seat
  })
  test('overflow: extra crew stand on distinct walkable non-seat tiles', () => {
    const map = makeMap()
    const crew = ['a', 'b', 'c', 'd', 'e'].map(id => member(id))
    const out = assignSeats(crew, map, '/repo/a', [])
    const seatKeys = map.seats.map(s => `${s.at.x},${s.at.y}`)
    const spots = out.map(c => `${c.seat.x},${c.seat.y}`)
    expect(new Set(spots).size).toBe(5)
    for (const c of out.slice(0, 2)) expect(seatKeys).toContain(`${c.seat.x},${c.seat.y}`)
    for (const c of out.slice(2)) {
      expect(map.walkable[c.seat.y * map.width + c.seat.x]).toBe(true)
      expect(seatKeys).not.toContain(`${c.seat.x},${c.seat.y}`)
    }
  })
})

