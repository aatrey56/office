import { describe, expect, test } from 'claude-code/testing'

import type { Actor, Crew, Tile, TileMap } from '../../types'
import { findPath, isSettled, spawnActor, stepActors } from './motion'

const SIZE = 16

// '#' is a wall, anything else floor. Row-major like the real map.
function mapOf(rows: string[], door: Tile = { x: 0, y: 0 }): TileMap {
  const width = rows[0].length
  const cells = rows.join('').split('')
  return {
    width,
    height: rows.length,
    tileSize: SIZE,
    tiles: cells.map(() => 0),
    walkable: cells.map((c) => c !== '#'),
    seats: [],
    door,
  }
}

function crewAt(id: string, seat: Tile, over: Partial<Crew> = {}): Crew {
  return {
    id,
    name: id,
    role: 'lead',
    project: '/p',
    state: 'working',
    room: 'coding',
    seat,
    facing: 'up',
    look: 0,
    isSelectable: true,
    isSelf: false,
    ...over,
  }
}

function actorAt(id: string, tile: Tile, over: Partial<Actor> = {}): Actor {
  return { id, x: tile.x * SIZE, y: tile.y * SIZE, path: [], facing: 'down', step: 0, isGone: false, ...over }
}

describe('findPath', () => {
  test('walks around a wall, trying up before down', () => {
    const map = mapOf(['.....', '.###.', '.....'])
    expect(findPath(map, { x: 0, y: 1 }, { x: 4, y: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
    ])
  })
  test('excludes the start and takes the straight line when open', () => {
    const map = mapOf(['....'])
    expect(findPath(map, { x: 0, y: 0 }, { x: 3, y: 0 })).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ])
  })
  test('no path when a wall seals the destination off', () => {
    const map = mapOf(['..#..', '..#..', '..#..'])
    expect(findPath(map, { x: 0, y: 0 }, { x: 4, y: 2 })).toEqual([])
  })
  test('a destination on a non-walkable seat tile is still reachable', () => {
    const map = mapOf(['..#'])
    expect(map.walkable[2]).toBe(false)
    expect(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 })).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ])
  })
  test('a non-walkable tile is not a way through', () => {
    const map = mapOf(['.#.'])
    expect(findPath(map, { x: 0, y: 0 }, { x: 2, y: 0 })).toEqual([])
  })
  test('from equal to to, and out-of-bounds input, give []', () => {
    const map = mapOf(['...', '...'])
    expect(findPath(map, { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([])
    expect(findPath(map, { x: -1, y: 0 }, { x: 1, y: 1 })).toEqual([])
    expect(findPath(map, { x: 0, y: 0 }, { x: 3, y: 0 })).toEqual([])
    expect(findPath(map, { x: 0, y: 0 }, { x: 0, y: 2 })).toEqual([])
  })
})

describe('spawnActor', () => {
  test('starts at the door in pixels, facing down, not walking', () => {
    const map = mapOf(['...', '...'], { x: 2, y: 1 })
    expect(spawnActor(crewAt('a', { x: 0, y: 0 }), map)).toEqual({
      id: 'a',
      x: 32,
      y: 16,
      path: [],
      facing: 'down',
      step: 0,
      isGone: false,
    })
  })
})

describe('stepActors walking', () => {
  // door (0,0), seat (2,0): the route goes down the left column, along the bottom and back up.
  const map = mapOf(['.#.', '.#.', '...'])
  const seat = { x: 2, y: 0 }

  test('a new crew member appears at the door, then heads off on the same call', () => {
    const out = stepActors([], [crewAt('a', seat)], map, 5)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'a', x: 0, y: 5, facing: 'down', step: 1, isGone: false })
    expect(out[0].path[0]).toEqual({ x: 0, y: 1 })
  })

  test('walks the route with a pixel step that does not divide the tile size', () => {
    const crew = [crewAt('a', seat, { facing: 'left' })]
    let actors = stepActors([], crew, map, 5)
    let calls = 1
    while (!isSettled(actors) && calls < 100) {
      // never overlaps a wall tile, even mid-step
      const a = actors[0]
      for (const tx of [Math.floor(a.x / SIZE), Math.ceil(a.x / SIZE)]) {
        for (const ty of [Math.floor(a.y / SIZE), Math.ceil(a.y / SIZE)]) {
          expect(map.walkable[ty * map.width + tx]).toBe(true)
        }
      }
      actors = stepActors(actors, crew, map, 5)
      calls++
    }
    // 6 tiles = 96 px; 5 px a call -> 20 calls, the last one moving a single pixel
    expect(calls).toBe(20)
    expect(actors[0]).toMatchObject({ x: 32, y: 0, path: [], facing: 'left', step: 20, isGone: false })
    // arrived: another call changes nothing, not even the animation step
    expect(stepActors(actors, crew, map, 5)).toEqual(actors)
  })

  test('pixels left over at a waypoint carry on to the next one', () => {
    const open = mapOf(['....'])
    const out = stepActors([actorAt('a', { x: 0, y: 0 })], [crewAt('a', { x: 3, y: 0 })], open, 40)
    expect(out[0]).toMatchObject({ x: 40, y: 0, facing: 'right', step: 1 })
    expect(out[0].path).toEqual([{ x: 3, y: 0 }])
  })

  test('a step that ends exactly on a waypoint drops it', () => {
    const open = mapOf(['...'])
    const out = stepActors([actorAt('a', { x: 0, y: 0 })], [crewAt('a', { x: 2, y: 0 })], open, 16)
    expect(out[0].x).toBe(16)
    expect(out[0].path).toEqual([{ x: 2, y: 0 }])
  })
})

describe('stepActors re-planning', () => {
  const map = mapOf(['.....', '.....', '.....'])

  test('a seat change mid-walk keeps the tile being headed to as the first waypoint', () => {
    const crew = [crewAt('a', { x: 4, y: 0 })]
    let actors = stepActors([], crew, map, 5)
    actors = stepActors(actors, crew, map, 5)
    expect(actors[0]).toMatchObject({ x: 10, y: 0 })

    const moved = [crewAt('a', { x: 0, y: 2 })]
    actors = stepActors(actors, moved, map, 5)
    expect(actors[0]).toMatchObject({ x: 15, y: 0, facing: 'right' })
    expect(actors[0].path[0]).toEqual({ x: 1, y: 0 })
    expect(actors[0].path[actors[0].path.length - 1]).toEqual({ x: 0, y: 2 })

    let calls = 0
    while (!isSettled(actors) && calls++ < 100) actors = stepActors(actors, moved, map, 5)
    expect(actors[0]).toMatchObject({ x: 0, y: 32, path: [] })
  })

  test('a seat change for an actor standing still plans from its own tile', () => {
    const seated = [actorAt('a', { x: 2, y: 2 }, { facing: 'up' })]
    const out = stepActors(seated, [crewAt('a', { x: 2, y: 0 })], map, 4)
    expect(out[0]).toMatchObject({ x: 32, y: 28, facing: 'up', step: 1 })
    expect(out[0].path).toEqual([
      { x: 2, y: 1 },
      { x: 2, y: 0 },
    ])
  })

  test('arriving at the seat takes the crew member facing', () => {
    const out = stepActors([actorAt('a', { x: 0, y: 0 })], [crewAt('a', { x: 1, y: 0 }, { facing: 'up' })], map, 16)
    expect(out[0]).toMatchObject({ x: 16, y: 0, path: [], facing: 'up' })
  })
})

describe('stepActors leaving', () => {
  const map = mapOf(['...', '...'], { x: 0, y: 0 })

  test('a leaving crew member walks to the door, is marked gone, then dropped next call', () => {
    const crew = [crewAt('a', { x: 2, y: 0 }, { state: 'leaving' })]
    let actors = [actorAt('a', { x: 2, y: 0 })]
    let calls = 0
    while (!actors[0].isGone && calls++ < 100) {
      expect(actors[0].isGone).toBe(false)
      actors = stepActors(actors, crew, map, 8)
    }
    expect(actors).toHaveLength(1)
    expect(actors[0]).toMatchObject({ x: 0, y: 0, path: [], isGone: true })
    expect(stepActors(actors, crew, map, 8)).toEqual([])
  })

  test('an actor whose crew is missing walks out the same way', () => {
    const out = stepActors([actorAt('a', { x: 1, y: 0 })], [], map, 16)
    expect(out).toEqual([{ id: 'a', x: 0, y: 0, path: [], facing: 'left', step: 1, isGone: true }])
    expect(stepActors(out, [], map, 16)).toEqual([])
  })

  test('an actor already at the door with no crew is marked gone without moving', () => {
    const out = stepActors([actorAt('a', { x: 0, y: 0 })], [], map, 16)
    expect(out[0]).toMatchObject({ isGone: true, step: 0 })
  })
})

describe('stepActors ordering and purity', () => {
  const map = mapOf(['....', '....', '....'])

  test('returns actors by y ascending, ties by id', () => {
    const actors = [actorAt('c', { x: 0, y: 2 }), actorAt('b', { x: 1, y: 1 }), actorAt('a', { x: 2, y: 1 }), actorAt('d', { x: 3, y: 0 })]
    const crew = [
      crewAt('a', { x: 2, y: 1 }),
      crewAt('b', { x: 1, y: 1 }),
      crewAt('c', { x: 0, y: 2 }),
      crewAt('d', { x: 3, y: 0 }),
    ]
    expect(stepActors(actors, crew, map, 4).map((a) => a.id)).toEqual(['d', 'a', 'b', 'c'])
  })

  test('does not mutate its inputs', () => {
    const actors = [actorAt('a', { x: 0, y: 0 }, { path: [{ x: 1, y: 0 }] }), actorAt('gone', { x: 0, y: 0 }, { isGone: true })]
    const crew = [crewAt('a', { x: 3, y: 2 }), crewAt('new', { x: 1, y: 1 })]
    const before = JSON.stringify({ actors, crew, map })
    const out = stepActors(actors, crew, map, 7)
    expect(JSON.stringify({ actors, crew, map })).toBe(before)
    expect(out.map((a) => a.id)).toEqual(['a', 'new'])
  })
})

describe('isSettled', () => {
  test('true only when every path is empty', () => {
    expect(isSettled([])).toBe(true)
    expect(isSettled([actorAt('a', { x: 0, y: 0 })])).toBe(true)
    expect(isSettled([actorAt('a', { x: 0, y: 0 }), actorAt('b', { x: 0, y: 0 }, { path: [{ x: 1, y: 0 }] })])).toBe(false)
  })
})
