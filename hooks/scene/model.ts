import type { Crew, CrewRole, CrewState, Job, ManagerEntry, RoomId, SessionCard, Tile, TileMap, Activity } from '../../types'
import { LOOKS } from './art'
import { clip } from '../sessions'

// Who is in the office and where they belong. Pure: cards and jobs in, crew out.

const NAME_MAX = 16
const TAG_MAX = 24

// The project a cwd belongs to: its git toplevel when `roots` knows one, else the cwd itself.
export function projectOf(cwd: string, roots: Record<string, string | null>): string {
  return roots[cwd] || cwd
}

// Registry status ('busy' | 'idle' | 'waiting' | 'blocked' | ...) or a job status, as a crew state.
export function stateOf(status: string, role: CrewRole): CrewState {
  if (role === 'worker') {
    if (status === 'running') return 'working'
    if (status === 'blocked') return 'needs-you'
    if (status === 'done') return 'reporting'
    if (status === 'failed') return 'failed'
    return 'idle'
  }
  if (status === 'busy') return 'working'
  if (status === 'waiting' || status === 'blocked') return 'needs-you'
  return 'idle'
}

// working → coding (a manager → manager), idle → break, needs-you → meeting,
// reporting / failed → manager, leaving → lobby.
export function roomFor(state: CrewState, role: CrewRole, activity?: Activity): RoomId {
  // Planning happens at the whiteboard and reviewing at the plain desk, for anyone; other work
  // is the manager's own desk or a computer.
  if (state === 'working' && activity === 'planning') return 'whiteboard'
  if (state === 'working' && activity === 'reviewing') return 'review'
  if (state === 'working') return role === 'manager' ? 'manager' : 'coding'
  if (state === 'idle') return 'break'
  if (state === 'needs-you') return 'meeting'
  if (state === 'reporting' || state === 'failed') return 'manager'
  return 'lobby'
}

function workerTag(job: Job): string | undefined {
  if (job.model && job.effort) return `${job.model}/${job.effort}`
  return job.model || job.effort || undefined
}

// One crew member per lead session and per worker job that is running, blocked, or ended
// within `lingerMs` of `now` (so a finished worker is seen reporting and leaving).
// `managers` is project → manager; that session's role is 'manager'. Seats are not set here.
export function deriveCrew(
  cards: SessionCard[],
  jobs: Job[],
  managers: Record<string, ManagerEntry>,
  roots: Record<string, string | null>,
  now: number,
  lingerMs: number,
): Crew[] {
  const crew: Crew[] = []

  for (const card of cards) {
    const project = projectOf(card.cwd, roots)
    const role: CrewRole = managers[project]?.sessionId === card.sessionId ? 'manager' : 'lead'
    const state = stateOf(card.status, role)
    const tag = card.lastText ? clip(card.lastText, TAG_MAX) : ''
    crew.push({
      id: card.sessionId,
      name: card.name,
      role,
      project,
      state,
      room: roomFor(state, role, card.activity),
      seat: { x: 0, y: 0 },
      facing: 'down',
      look: lookOf(card.sessionId, LOOKS),
      ...(tag ? { tag } : {}),
      ...(card.activity ? { activity: card.activity } : {}),
      isSelectable: true,
      isSelf: card.isSelf,
    })
  }

  for (const job of jobs) {
    if (job.kind !== 'worker') continue
    let state = stateOf(job.status, 'worker')
    if (job.endedAt !== undefined) {
      const since = now - job.endedAt
      if (since > lingerMs) continue
      // A finished worker reports for the first half of the linger, then walks out.
      if (state === 'reporting' && since >= lingerMs / 2) state = 'leaving'
    }
    const tag = workerTag(job)
    crew.push({
      id: job.id,
      name: job.title.slice(0, NAME_MAX),
      role: 'worker',
      project: projectOf(job.cwd, roots),
      state,
      room: roomFor(state, 'worker'),
      seat: { x: 0, y: 0 },
      facing: 'down',
      look: lookOf(job.id, LOOKS),
      ...(tag ? { tag } : {}),
      isSelectable: false,
      isSelf: false,
    })
  }

  return crew
}

const key = (t: Tile) => `${t.x},${t.y}`

// Walkable tiles that belong to no seat, nearest the room's seats first (the map names seats
// per room but not floor areas, so "of that room" means closest to its seats).
function standingTiles(map: TileMap, room: RoomId, seatTiles: Set<string>): Tile[] {
  const anchors = map.seats.filter(s => s.room === room).map(s => s.at)
  if (anchors.length === 0) anchors.push(map.door)
  const out: { t: Tile; d: number }[] = []
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (!map.walkable[y * map.width + x]) continue
      const t = { x, y }
      if (seatTiles.has(key(t)) || key(t) === key(map.door)) continue
      out.push({ t, d: Math.min(...anchors.map(a => Math.abs(a.x - x) + Math.abs(a.y - y))) })
    }
  }
  return out.sort((a, b) => a.d - b.d || a.t.y - b.t.y || a.t.x - b.t.x).map(o => o.t)
}

// Gives each crew member of `project` a free seat in its room (stable across calls: the same
// id keeps its seat while its room is unchanged). More crew than seats: the rest stand on
// walkable tiles of that room.
export function assignSeats(crew: Crew[], map: TileMap, project: string, previous: Crew[]): Crew[] {
  const before = new Map(previous.map(c => [c.id, c]))
  const seatTiles = new Set(map.seats.map(s => key(s.at)))
  const taken = new Set<string>() // `${room}:${x},${y}`
  const kept = new Map<string, Crew>()

  // First pass: whoever can keep its old seat does, so newcomers never take it.
  for (const c of crew) {
    if (c.project !== project) continue
    const old = before.get(c.id)
    if (!old || old.room !== c.room) continue
    const seat = map.seats.find(s => s.room === c.room && s.at.x === old.seat.x && s.at.y === old.seat.y)
    const slot = `${c.room}:${seat ? key(seat.at) : ''}`
    if (!seat || taken.has(slot)) continue
    taken.add(slot)
    kept.set(c.id, { ...c, seat: { ...seat.at }, facing: seat.facing })
  }

  const standing = new Map<RoomId, Tile[]>()
  const used = new Set<string>() // standing tiles handed out, across rooms
  return crew.map(c => {
    if (c.project !== project) return c
    const keptCrew = kept.get(c.id)
    if (keptCrew) return keptCrew

    const free = map.seats.find(s => s.room === c.room && !taken.has(`${c.room}:${key(s.at)}`))
    if (free) {
      taken.add(`${c.room}:${key(free.at)}`)
      return { ...c, seat: { ...free.at }, facing: free.facing }
    }

    // Overflow: the nearest standing tile nobody has taken.
    if (!standing.has(c.room)) standing.set(c.room, standingTiles(map, c.room, seatTiles))
    const spot = standing.get(c.room)!.find(t => !used.has(key(t)))
    if (!spot) return c // no floor at all: leave the placeholder
    used.add(key(spot))
    return { ...c, seat: spot, facing: 'down' }
  })
}

// The distinct projects, most crew first; the lobby shows one door for each.
export function projectsOf(crew: Crew[]): string[] {
  const counts = new Map<string, number>()
  for (const c of crew) counts.set(c.project, (counts.get(c.project) ?? 0) + 1)
  return [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || (a < b ? -1 : a > b ? 1 : 0))
}

// A stable small number from an id, for picking a sprite look.
export function lookOf(id: string, looks: number): number {
  const n = Math.floor(looks)
  if (!(n > 0)) return 0
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0
  return h % n
}
