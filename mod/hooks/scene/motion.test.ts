import { describe, expect, test } from 'claude-code/testing'
import { officeArt, officeMap } from './art'
import { paintFrame } from './paint'

import type { Actor, Crew, Tile, TileMap } from '../../types'
import { findPath, isSettled, stepActors } from './motion'

const SIZE = 16

// '#' is a wall, anything else floor. Row-major like the real map.
function mapOf(rows: string[], door: Tile = { x: 0, y: 0 }): TileMap {
  const width = (rows[0] ?? '').length
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
})

describe('stepActors walking', () => {
  // door (0,0), seat (2,0): the route goes down the left column, along the bottom and back up.
  const map = mapOf(['.#.', '.#.', '...'])
  const seat = { x: 2, y: 0 }

  test('walks the route with a pixel step that does not divide the tile size', () => {
    const crew = [crewAt('a', seat, { facing: 'left' })]
    let actors = stepActors([], crew, map, 5)
    let calls = 1
    while (!isSettled(actors) && calls < 100) {
      // never overlaps a wall tile, even mid-step
      const a = actors[0]!
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
    expect(actors[0]?.path[0]).toEqual({ x: 1, y: 0 })
    expect(actors[0]?.path.at(-1)).toEqual({ x: 0, y: 2 })

    let calls = 0
    while (!isSettled(actors) && calls++ < 100) actors = stepActors(actors, moved, map, 5)
    expect(actors[0]).toMatchObject({ x: 0, y: 32, path: [] })
  })
})

describe('stepActors leaving', () => {
  const map = mapOf(['...', '...'], { x: 0, y: 0 })

  test('a leaving crew member walks to the door, is marked gone, then dropped next call', () => {
    const crew = [crewAt('a', { x: 2, y: 0 }, { state: 'leaving' })]
    let actors = [actorAt('a', { x: 2, y: 0 })]
    let calls = 0
    while (!actors[0]?.isGone && calls++ < 100) {
      expect(actors[0]?.isGone).toBe(false)
      actors = stepActors(actors, crew, map, 8)
    }
    expect(actors).toHaveLength(1)
    expect(actors[0]).toMatchObject({ x: 0, y: 0, path: [], isGone: true })
    expect(stepActors(actors, crew, map, 8)).toEqual([])
  })
})

describe('the real office', () => {
  test('every seat can be walked to from the door', () => {
    const map = officeMap()
    for (const seat of map.seats) {
      const path = findPath(map, map.door, seat.at)
      expect(path.at(-1)).toEqual(seat.at)
    }
  })
})

describe('the real office, drawn', () => {
  // A fingerprint of the empty room as drawn: tiles, floor props, then furniture in sort order.
  // Any change to the art or the layout changes it. After a deliberate change, re-export the art
  // (bun tools/export.ts in art/), look at art/out/debug.png, and update this value.
  test('the empty office matches its snapshot', () => {
    const frame = paintFrame(officeMap(), officeArt(), [], [], 0, null, 1)
    let hash = 0x811c9dc5
    for (const p of frame.pixels) hash = Math.imul(hash ^ p, 0x01000193) >>> 0
    expect(`${frame.width}x${frame.height} 0x${hash.toString(16)}`).toBe('192x160 0xc095bce9')
  })
})
