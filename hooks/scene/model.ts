import type { Crew, CrewRole, CrewState, Job, ManagerEntry, RoomId, SessionCard, TileMap } from '../../types'

// Who is in the office and where they belong. Pure: cards and jobs in, crew out.
// CONTRACT STUB: signatures are fixed; the bodies are the scene-model builder's.

// The project a cwd belongs to: its git toplevel when `roots` knows one, else the cwd itself.
export function projectOf(cwd: string, roots: Record<string, string | null>): string {
  throw new Error('not implemented')
}

// Registry status ('busy' | 'idle' | 'waiting' | 'blocked' | ...) or a job status, as a crew state.
export function stateOf(status: string, role: CrewRole): CrewState {
  throw new Error('not implemented')
}

// working → coding (a manager → manager), idle → break, needs-you → meeting,
// reporting / failed → manager, leaving → lobby.
export function roomFor(state: CrewState, role: CrewRole): RoomId {
  throw new Error('not implemented')
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
  throw new Error('not implemented')
}

// Gives each crew member of `project` a free seat in its room (stable across calls: the same
// id keeps its seat while its room is unchanged). More crew than seats: the rest stand on
// walkable tiles of that room.
export function assignSeats(crew: Crew[], map: TileMap, project: string, previous: Crew[]): Crew[] {
  throw new Error('not implemented')
}

// The distinct projects, most crew first; the lobby shows one door for each.
export function projectsOf(crew: Crew[]): string[] {
  throw new Error('not implemented')
}

// A stable small number from an id, for picking a sprite look.
export function lookOf(id: string, looks: number): number {
  throw new Error('not implemented')
}
