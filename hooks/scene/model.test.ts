import { describe, expect, test } from 'claude-code/testing'

import type { Crew, Job, ManagerEntry, SessionCard, TileMap } from '../../types'
import { assignSeats, deriveCrew, lookOf, projectOf, projectsOf, roomFor, stateOf } from './model'

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

describe('projectOf', () => {
  test('a known root wins', () => {
    expect(projectOf('/repo/a/sub', ROOTS)).toBe('/repo/a')
  })
  test('a null root falls back to the cwd', () => {
    expect(projectOf('/tmp/x', ROOTS)).toBe('/tmp/x')
  })
  test('an unknown cwd is its own project', () => {
    expect(projectOf('/elsewhere', ROOTS)).toBe('/elsewhere')
  })
})

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
  test('worker statuses', () => {
    expect(stateOf('running', 'worker')).toBe('working')
    expect(stateOf('blocked', 'worker')).toBe('needs-you')
    expect(stateOf('done', 'worker')).toBe('reporting')
    expect(stateOf('failed', 'worker')).toBe('failed')
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
  test('without a manager every session is a lead', () => {
    const crew = derive([card(), card({ sessionId: 's2', name: 'beta' })])
    expect(crew.map(c => c.role)).toEqual(['lead', 'lead'])
    expect(crew.every(c => c.isSelectable)).toBe(true)
  })
  test('the session named in managers[project] is the manager', () => {
    const managers = { '/repo/a': { sessionId: 's2', name: 'beta', since: 1 } }
    const crew = derive([card(), card({ sessionId: 's2', name: 'beta' }), card({ sessionId: 's3', cwd: '/tmp/x' })], [], managers)
    expect(crew.map(c => c.role)).toEqual(['lead', 'manager', 'lead'])
    expect(crew[1]).toMatchObject({ room: 'manager', state: 'working', isSelectable: true })
  })
  test('a manager of another project does not count', () => {
    const managers = { '/other': { sessionId: 's1', name: 'x', since: 1 } }
    expect(derive([card()], [], managers)[0].role).toBe('lead')
  })
  test('fields: project, look, isSelf, placeholders, tag clip', () => {
    const c = derive([card({ cwd: '/repo/a/sub', isSelf: true, lastText: 'x'.repeat(40) })])[0]
    expect(c.project).toBe('/repo/a')
    expect(c.look).toBe(lookOf('s1', 3))
    expect(c.isSelf).toBe(true)
    expect(c.facing).toBe('down')
    expect(c.seat).toEqual({ x: 0, y: 0 })
    expect(c.tag!.length).toBe(24)
    expect(c.id).toBe('s1')
    expect(c.name).toBe('alpha')
  })
  test('no lastText means no tag', () => {
    expect('tag' in derive([card()])[0]).toBe(false)
  })
  test('status maps to state and room', () => {
    const crew = derive([
      card({ sessionId: 'a', status: 'busy' }),
      card({ sessionId: 'b', status: 'idle' }),
      card({ sessionId: 'c', status: 'waiting' }),
    ])
    expect(crew.map(c => [c.state, c.room])).toEqual([
      ['working', 'coding'],
      ['idle', 'break'],
      ['needs-you', 'meeting'],
    ])
  })
})

describe('deriveCrew workers', () => {
  test('only worker jobs become crew, and never selectable', () => {
    const crew = derive([], [job(), job({ id: 'j2', kind: 'codex-exec' }), job({ id: 'j3', kind: 'codex-review' })])
    expect(crew.map(c => c.id)).toEqual(['j1'])
    expect(crew[0]).toMatchObject({ role: 'worker', isSelectable: false, isSelf: false, state: 'working', room: 'coding' })
  })
  test('name is the title cut to 16, tag is model/effort', () => {
    const c = derive([], [job({ title: 'refactor the whole parser module', model: 'opus', effort: 'high' })])[0]
    expect(c.name).toBe('refactor the who')
    expect(c.tag).toBe('opus/high')
    expect(derive([], [job({ model: 'sonnet' })])[0].tag).toBe('sonnet')
    expect('tag' in derive([], [job()])[0]).toBe(false)
  })
  test('a blocked worker needs you', () => {
    expect(derive([], [job({ status: 'blocked' })])[0]).toMatchObject({ state: 'needs-you', room: 'meeting' })
  })
  test('project comes from the cwd like a session', () => {
    expect(derive([], [job({ cwd: '/repo/a/sub' })])[0].project).toBe('/repo/a')
  })
  test('done worker: reporting, then leaving, then gone (boundaries)', () => {
    const at = (since: number, status: Job['status'] = 'done') => derive([], [job({ status, endedAt: NOW - since })])
    expect(at(0)[0]).toMatchObject({ state: 'reporting', room: 'manager' })
    expect(at(LINGER / 2 - 1)[0].state).toBe('reporting')
    expect(at(LINGER / 2)[0]).toMatchObject({ state: 'leaving', room: 'lobby' })
    expect(at(LINGER)[0].state).toBe('leaving')
    expect(at(LINGER + 1)).toEqual([])
  })
  test('a failed worker stays until the linger passes', () => {
    const at = (since: number) => derive([], [job({ status: 'failed', endedAt: NOW - since })])
    expect(at(LINGER - 1)[0]).toMatchObject({ state: 'failed', room: 'manager' })
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
  test('seats go to the room the crew belongs in', () => {
    const out = assignSeats([member('a'), member('b'), member('m', { room: 'manager', role: 'manager' })], makeMap(), '/repo/a', [])
    expect(out[0]).toMatchObject({ seat: { x: 1, y: 3 }, facing: 'up' })
    expect(out[1]).toMatchObject({ seat: { x: 3, y: 3 }, facing: 'right' })
    expect(out[2]).toMatchObject({ seat: { x: 1, y: 1 }, facing: 'down' })
  })
  test('other projects are returned unchanged', () => {
    const other = member('z', { project: '/repo/b' })
    const out = assignSeats([other, member('a')], makeMap(), '/repo/a', [])
    expect(out[0]).toBe(other)
    expect(out[1].seat).toEqual({ x: 1, y: 3 })
  })
  test('seats are stable across calls, even when the order changes', () => {
    const map = makeMap()
    const first = assignSeats([member('a'), member('b')], map, '/repo/a', [])
    const second = assignSeats([member('c'), member('b'), member('a')], map, '/repo/a', first)
    expect(second[1].seat).toEqual(first[1].seat)
    expect(second[2].seat).toEqual(first[0].seat)
    expect(second[0].seat).not.toEqual(first[0].seat) // the newcomer takes neither kept seat
  })
  test('a crew member that changed room gets a seat in the new room', () => {
    const map = makeMap()
    const first = assignSeats([member('a')], map, '/repo/a', [])
    const moved = assignSeats([member('a', { room: 'manager' })], map, '/repo/a', first)
    expect(moved[0].seat).toEqual({ x: 1, y: 1 })
  })
  test('a previous seat that is not a seat of the room is not kept', () => {
    const map = makeMap()
    const stale = member('a', { seat: { x: 7, y: 3 } })
    const out = assignSeats([member('a')], map, '/repo/a', [stale])
    expect(out[0].seat).toEqual({ x: 1, y: 3 })
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
  test('overflow is deterministic', () => {
    const map = makeMap()
    const crew = ['a', 'b', 'c'].map(id => member(id))
    expect(assignSeats(crew, map, '/repo/a', [])).toEqual(assignSeats(crew, map, '/repo/a', []))
  })
})

describe('projectsOf', () => {
  test('most crew first, ties alphabetical', () => {
    const crew = [
      member('1', { project: '/b' }),
      member('2', { project: '/a' }),
      member('3', { project: '/c' }),
      member('4', { project: '/c' }),
    ]
    expect(projectsOf(crew)).toEqual(['/c', '/a', '/b'])
  })
  test('empty crew, empty list', () => {
    expect(projectsOf([])).toEqual([])
  })
})

describe('lookOf', () => {
  test('is deterministic and within range', () => {
    expect(lookOf('abc', 3)).toBe(lookOf('abc', 3))
    for (const id of ['a', 'b', 'session-123', 'job-9', '']) {
      const l = lookOf(id, 3)
      expect(l >= 0 && l < 3).toBe(true)
    }
  })
  test('spreads ids over the looks', () => {
    const seen = new Set(Array.from({ length: 30 }, (_, i) => lookOf(`id-${i}`, 3)))
    expect(seen.size).toBe(3)
  })
  test('looks <= 0 returns 0', () => {
    expect(lookOf('abc', 0)).toBe(0)
    expect(lookOf('abc', -2)).toBe(0)
  })
})
