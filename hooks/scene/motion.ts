import type { Actor, Crew, Facing, Tile, TileMap } from '../../types'

// How crew walk. Pure: actors and their targets in, the next actors out.

// Neighbour order is fixed so equal-length routes always resolve the same way.
const DIRS: Tile[] = [
  { x: 0, y: -1 }, // up
  { x: 1, y: 0 }, // right
  { x: 0, y: 1 }, // down
  { x: -1, y: 0 }, // left
]

function isInside(map: TileMap, t: Tile): boolean {
  return Number.isInteger(t.x) && Number.isInteger(t.y) && t.x >= 0 && t.y >= 0 && t.x < map.width && t.y < map.height
}

function isSame(a: Tile, b: Tile): boolean {
  return a.x === b.x && a.y === b.y
}

// Shortest 4-neighbour path over walkable tiles, excluding `from`, ending at `to`.
// `to` counts as walkable even when it is a seat tile. No path: [].
export function findPath(map: TileMap, from: Tile, to: Tile): Tile[] {
  if (!isInside(map, from) || !isInside(map, to) || isSame(from, to)) return []
  const w = map.width
  const start = from.y * w + from.x
  const goal = to.y * w + to.x
  const prev = new Map<number, number>([[start, -1]])
  const queue = [start]
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]
    if (cur === undefined || cur === goal) break
    const cx = cur % w
    const cy = (cur - cx) / w
    for (const d of DIRS) {
      const nx = cx + d.x
      const ny = cy + d.y
      if (nx < 0 || ny < 0 || nx >= w || ny >= map.height) continue
      const n = ny * w + nx
      if (prev.has(n) || (n !== goal && !map.walkable[n])) continue
      prev.set(n, cur)
      queue.push(n)
    }
  }
  if (!prev.has(goal)) return []
  const path: Tile[] = []
  for (let i = goal; i !== start; i = prev.get(i) as number) path.push({ x: i % w, y: Math.floor(i / w) })
  return path.reverse()
}

// An actor for a crew member seen for the first time: it starts at the door.
export function spawnActor(crew: Crew, map: TileMap): Actor {
  return { id: crew.id, x: map.door.x * map.tileSize, y: map.door.y * map.tileSize, path: [], facing: 'down', step: 0, isGone: false }
}

// Advances every actor by `pixels` along its path and re-plans any whose crew seat changed.
// New crew get an actor at the door; an actor whose crew is gone (or 'leaving') walks to the
// door and is marked isGone on arrival. Returned in draw order (smaller y first).
export function stepActors(actors: Actor[], crew: Crew[], map: TileMap, pixels: number): Actor[] {
  const size = map.tileSize
  const crewById = new Map(crew.map((c) => [c.id, c]))
  const known = new Set(actors.map((a) => a.id))
  const all = actors.concat(crew.filter((c) => !known.has(c.id)).map((c) => spawnActor(c, map)))
  const out: Actor[] = []

  for (const actor of all) {
    if (actor.isGone) continue
    const member = crewById.get(actor.id)
    const isLeaving = !member || member.state === 'leaving'
    const target = isLeaving ? map.door : (member as Crew).seat

    let x = actor.x
    let y = actor.y
    let path = actor.path.slice()
    let facing: Facing = actor.facing
    const isOnTile = x % size === 0 && y % size === 0
    // Mid-step the actor is bound for path[0]; a new route must start there so it never cuts a corner.
    const heading = path[0]
    const base: Tile = !isOnTile && heading ? heading : { x: Math.round(x / size), y: Math.round(y / size) }
    const isOnTarget = path.length === 0 && isSame(base, target)
    const last = path[path.length - 1]
    if (!isOnTarget && (!last || !isSame(last, target))) {
      const route = findPath(map, base, target)
      path = !isOnTile && actor.path.length ? [base, ...route] : route
    }

    let isMoved = false
    let left = pixels
    while (left > 0 && path.length) {
      const next = path[0]
      if (!next) break
      const wx = next.x * size
      const wy = next.y * size
      if (x !== wx) {
        const d = Math.min(left, Math.abs(wx - x))
        facing = wx > x ? 'right' : 'left'
        x += wx > x ? d : -d
        left -= d
        isMoved = true
      } else if (y !== wy) {
        const d = Math.min(left, Math.abs(wy - y))
        facing = wy > y ? 'down' : 'up'
        y += wy > y ? d : -d
        left -= d
        isMoved = true
      }
      if (x === wx && y === wy) path.shift()
    }

    const isArrived = path.length === 0 && x === target.x * size && y === target.y * size
    if (isArrived && !isLeaving) facing = (member as Crew).facing
    out.push({ id: actor.id, x, y, path, facing, step: actor.step + (isMoved ? 1 : 0), isGone: isArrived && isLeaving })
  }

  return out.sort((a, b) => a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// True when nobody is walking: the scene can drop to its slow idle frame rate.
export function isSettled(actors: Actor[]): boolean {
  return actors.every((a) => a.path.length === 0)
}
