import { describe, expect, test } from 'claude-code/testing'

import type { Actor, Art, Bitmap, Crew, CrewState, Frame, SpritePose, TileMap } from '../../types'
import { newFrame, paintFrame, poseFor } from './paint'

const TS = 4

// Rows of digits, '.' is index 0.
function bmp(rows: string[]): Bitmap {
  const width = rows[0]?.length ?? 0
  const pixels = new Uint8Array(width * rows.length)
  rows.forEach((row, y) => [...row].forEach((ch, x) => (pixels[y * width + x] = ch === '.' ? 0 : Number(ch))))
  return { width, height: rows.length, pixels }
}
const solid = (i: number, w = TS, h = TS): Bitmap => bmp(Array.from({ length: h }, () => String(i).repeat(w)))
const allPoses = (b: Bitmap): Record<SpritePose, Bitmap> => ({ stand: b, walk1: b, walk2: b, sit: b, type: b })

// look 0: one solid color per pose. look 1: a 2x2 dot. look 2: a left-edge bar. look 3: 6 tall.
const ART: Art = {
  palette: [0, 0x111111, 0x222222, 0x333333, 0x444444, 0x555555, 0x666666, 0x777777, 0x888888, 0x999999],
  tiles: [solid(5), solid(6)],
  sprites: [
    { stand: solid(1), walk1: solid(2), walk2: solid(3), sit: solid(4), type: solid(7) },
    allPoses(bmp(['....', '.11.', '.11.', '....'])),
    allPoses(bmp(['2...', '2...', '2...', '2...'])),
    allPoses(solid(3, 4, 6)),
  ],
  bubbles: { needsYou: solid(8, 2, 2), failed: solid(9, 2, 2) },
}

// 3x3 tiles; the middle tile is index 1, the bottom-right one has no bitmap.
const MAP: TileMap = {
  width: 3,
  height: 3,
  tileSize: TS,
  tiles: [0, 0, 0, 0, 1, 0, 0, 0, 99],
  walkable: Array(9).fill(true),
  seats: [],
  door: { x: 0, y: 2 },
}

function member(id: string, state: CrewState, look: number): Crew {
  return {
    id,
    name: id,
    role: 'lead',
    project: '/p',
    state,
    room: 'coding',
    seat: { x: 1, y: 1 },
    facing: 'down',
    look,
    isSelectable: true,
    isSelf: false,
  }
}
function actor(id: string, tx: number, ty: number, more: Partial<Actor> = {}): Actor {
  return { id, x: tx * TS, y: ty * TS, path: [], facing: 'down', step: 0, isGone: false, ...more }
}
const px = (f: Frame, x: number, y: number): number | undefined => f.pixels[y * f.width + x]
const paint = (actors: Actor[], crew: Crew[], tick = 0, selected: string | null = null) =>
  paintFrame(MAP, ART, actors, crew, tick, selected, 6)

describe('newFrame', () => {
  test('fills width * height with the index', () => {
    const f = newFrame(3, 2, 7)
    expect(f.width).toBe(3)
    expect(f.height).toBe(2)
    expect([...f.pixels]).toEqual([7, 7, 7, 7, 7, 7])
  })
})

describe('tiles', () => {
  test('every tile is drawn opaquely; a tile with no bitmap draws nothing', () => {
    const f = paint([], [])
    expect(f.width).toBe(12)
    expect(f.height).toBe(12)
    expect(px(f, 0, 0)).toBe(5)
    expect(px(f, 4, 4)).toBe(6)
    expect(px(f, 7, 7)).toBe(6)
    expect(px(f, 8, 4)).toBe(5)
    expect(px(f, 8, 8)).toBe(0)
    expect(px(f, 11, 11)).toBe(0)
  })
})

describe('sprites', () => {
  test('index 0 is transparent and the tile shows through', () => {
    const f = paint([actor('a', 1, 1)], [member('a', 'reporting', 1)])
    expect(px(f, 4, 4)).toBe(6)
    expect(px(f, 5, 5)).toBe(1)
    expect(px(f, 6, 6)).toBe(1)
    expect(px(f, 7, 7)).toBe(6)
  })
  test('facing left mirrors the sprite', () => {
    const crew = [member('a', 'reporting', 2)]
    const right = paint([actor('a', 1, 1, { facing: 'right' })], crew)
    expect(px(right, 4, 5)).toBe(2)
    expect(px(right, 7, 5)).toBe(6)
    const left = paint([actor('a', 1, 1, { facing: 'left' })], crew)
    expect(px(left, 4, 5)).toBe(6)
    expect(px(left, 7, 5)).toBe(2)
  })
  test('a sprite taller than a tile sits on the bottom of its tile and overlaps the one above', () => {
    const f = paint([actor('a', 1, 1)], [member('a', 'reporting', 3)])
    expect(px(f, 4, 1)).toBe(5)
    expect(px(f, 4, 2)).toBe(3)
    expect(px(f, 7, 7)).toBe(3)
    expect(px(f, 4, 8)).toBe(5)
  })
  test('sprites are clipped at every frame edge', () => {
    const f = paint(
      [actor('top', 1, 0), actor('right', 0, 0, { x: 10, y: 4 }), actor('neg', 0, 0, { x: -2, y: 8 })],
      [member('top', 'reporting', 3), member('right', 'reporting', 0), member('neg', 'reporting', 0)],
    )
    expect(f.pixels.length).toBe(144)
    expect(px(f, 4, 0)).toBe(3) // the tall sprite's top two rows fall off
    expect(px(f, 10, 4)).toBe(1)
    expect(px(f, 11, 7)).toBe(1)
    expect(px(f, 0, 8)).toBe(1)
    expect(px(f, 1, 11)).toBe(1)
    expect(px(f, 2, 8)).toBe(5)
  })
  test('the look wraps around the sprite list', () => {
    const f = paint([actor('a', 1, 1)], [member('a', 'reporting', 5)])
    expect(px(f, 5, 5)).toBe(1)
    expect(px(f, 4, 4)).toBe(6)
  })
  test('later actors draw over earlier ones', () => {
    const f = paint([actor('a', 1, 1), actor('b', 1, 1)], [member('a', 'reporting', 0), member('b', 'idle', 0)])
    expect(px(f, 4, 4)).toBe(4)
  })
})

describe('pose table', () => {
  const at = (state: CrewState | null, more: Partial<Actor> = {}, tick = 0): number | undefined => {
    const crew = state ? [member('a', state, 0)] : []
    return px(paint([actor('a', 0, 0, more)], crew, tick), 0, 0)
  }
  test('walking alternates walk1 / walk2 on step, whatever the state', () => {
    const path = [{ x: 1, y: 0 }]
    expect(at('working', { path, step: 0 })).toBe(2)
    expect(at('working', { path, step: 1 })).toBe(3)
    expect(at('idle', { path, step: 4 })).toBe(2)
    expect(at('leaving', { path, step: 7 })).toBe(3)
  })
  test('arrived: working types and sits every 4 ticks, idle sits, the rest stand', () => {
    expect(at('working', {}, 0)).toBe(7)
    expect(at('working', {}, 3)).toBe(7)
    expect(at('working', {}, 4)).toBe(4)
    expect(at('working', {}, 8)).toBe(7)
    expect(at('idle')).toBe(4)
    for (const s of ['needs-you', 'reporting', 'failed', 'leaving'] as CrewState[]) expect(at(s)).toBe(1)
  })
  test('an actor with no crew member still walks', () => {
    expect(at(null, { step: 0 })).toBe(2)
    expect(at(null, { step: 1 })).toBe(3)
  })
  test('poseFor matches the table', () => {
    const a = actor('a', 0, 0)
    expect(poseFor(a, member('a', 'working', 0), 5)).toBe('sit')
    expect(poseFor(a, member('a', 'idle', 0), 0)).toBe('sit')
    expect(poseFor(a, undefined, 0)).toBe('walk1')
    expect(poseFor({ ...a, path: [{ x: 0, y: 0 }], step: 3 }, member('a', 'idle', 0), 0)).toBe('walk2')
  })
})

describe('bubbles', () => {
  // The sprite at tile 1,1 spans 4..7; the 2x2 bubble is centred above it at 5..6, rows 2..3.
  test('needs-you blinks on tick / 4', () => {
    const crew = [member('a', 'needs-you', 0)]
    const on = paint([actor('a', 1, 1)], crew, 0)
    expect([px(on, 5, 2), px(on, 6, 3), px(on, 4, 2), px(on, 7, 3)]).toEqual([8, 8, 5, 5])
    expect(px(paint([actor('a', 1, 1)], crew, 3), 5, 2)).toBe(8)
    expect(px(paint([actor('a', 1, 1)], crew, 4), 5, 2)).toBe(5)
    expect(px(paint([actor('a', 1, 1)], crew, 8), 5, 2)).toBe(8)
  })
  test('failed always shows', () => {
    const crew = [member('a', 'failed', 0)]
    for (const tick of [0, 4, 5]) expect(px(paint([actor('a', 1, 1)], crew, tick), 6, 3)).toBe(9)
  })
  test('other states get no bubble', () => {
    expect(px(paint([actor('a', 1, 1)], [member('a', 'working', 0)]), 5, 2)).toBe(5)
  })
  test('a bubble above the top row is clipped', () => {
    const f = paint([actor('a', 1, 0)], [member('a', 'failed', 0)])
    expect(px(f, 5, 0)).toBe(1)
  })
})

describe('selection outline', () => {
  test('outlines the silhouette, orthogonal neighbours only, never over it', () => {
    const f = paintFrame(MAP, ART, [actor('a', 1, 1)], [member('a', 'reporting', 1)], 0, 'a', 9)
    for (const [x, y] of [[5, 4], [6, 4], [4, 5], [4, 6], [7, 5], [7, 6], [5, 7], [6, 7]] as const) expect(px(f, x, y)).toBe(9)
    for (const [x, y] of [[5, 5], [6, 6]] as const) expect(px(f, x, y)).toBe(1)
    expect(px(f, 4, 4)).toBe(6) // a diagonal corner keeps the tile under it
  })
  test('reaches one pixel outside the sprite box', () => {
    const f = paintFrame(MAP, ART, [actor('a', 1, 1)], [member('a', 'reporting', 0)], 0, 'a', 9)
    for (const [x, y] of [[3, 4], [3, 7], [8, 5], [4, 3], [7, 8]] as const) expect(px(f, x, y)).toBe(9)
    expect(px(f, 3, 3)).toBe(5)
    expect(px(f, 4, 4)).toBe(1)
  })
  test('only the selected crew member is outlined', () => {
    const f = paintFrame(MAP, ART, [actor('a', 1, 1)], [member('a', 'reporting', 0)], 0, 'b', 9)
    expect(px(f, 3, 4)).toBe(5)
  })
})

describe('purity', () => {
  test('does not mutate any input', () => {
    const actors = [actor('a', 1, 1, { facing: 'left', path: [{ x: 2, y: 1 }] }), actor('b', 0, 0)]
    const crew = [member('a', 'needs-you', 2), member('b', 'failed', 3)]
    const snapshot = (): string =>
      JSON.stringify({
        map: MAP,
        actors,
        crew,
        tiles: ART.tiles.map(t => [...t.pixels]),
        sprites: ART.sprites.map(s => Object.values(s).map(b => [...b.pixels])),
        bubbles: [...ART.bubbles.needsYou.pixels, ...ART.bubbles.failed.pixels],
      })
    const before = snapshot()
    paintFrame(MAP, ART, actors, crew, 0, 'a', 9)
    expect(snapshot()).toBe(before)
  })
})
