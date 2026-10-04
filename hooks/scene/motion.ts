import type { Actor, Crew, Tile, TileMap } from '../../types'

// How crew walk. Pure: actors and their targets in, the next actors out.
// CONTRACT STUB: signatures are fixed; the bodies are the motion builder's.

// Shortest 4-neighbour path over walkable tiles, excluding `from`, ending at `to`.
// `to` counts as walkable even when it is a seat tile. No path: [].
export function findPath(map: TileMap, from: Tile, to: Tile): Tile[] {
  throw new Error('not implemented')
}

// An actor for a crew member seen for the first time: it starts at the door.
export function spawnActor(crew: Crew, map: TileMap): Actor {
  throw new Error('not implemented')
}

// Advances every actor by `pixels` along its path and re-plans any whose crew seat changed.
// New crew get an actor at the door; an actor whose crew is gone (or 'leaving') walks to the
// door and is marked isGone on arrival. Returned in draw order (smaller y first).
export function stepActors(actors: Actor[], crew: Crew[], map: TileMap, pixels: number): Actor[] {
  throw new Error('not implemented')
}

// True when nobody is walking: the scene can drop to its slow idle frame rate.
export function isSettled(actors: Actor[]): boolean {
  throw new Error('not implemented')
}
