import { describe, expect, test } from 'claude-code/testing'

import type { Actor, Art, Bitmap, Crew, CrewState, Facing, Frame, SpritePose, TileMap } from '../../types'
import { paintFrame } from './paint'

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
// The same poses for every facing; a look whose left facing differs passes `left`.
const facings = (p: Record<SpritePose, Bitmap>, left = p): Record<Facing, Record<SpritePose, Bitmap>> => ({ up: p, down: p, right: p, left })

// look 0: one solid color per pose. look 1: a 2x2 dot. look 2: a left-edge bar. look 3: 6 tall.
const ART: Art = {
  palette: [0, 0x111111, 0x222222, 0x333333, 0x444444, 0x555555, 0x666666, 0x777777, 0x888888, 0x999999],
  tiles: [solid(5), solid(6)],
  sprites: [
    facings({ stand: solid(1), walk1: solid(2), walk2: solid(3), sit: solid(4), type: solid(7) }),
    facings(allPoses(bmp(['....', '.11.', '.11.', '....']))),
    facings(allPoses(bmp(['2...', '2...', '2...', '2...'])), allPoses(bmp(['...2', '...2', '...2', '...2']))),
    facings(allPoses(solid(3, 4, 6))),
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
  test('each facing draws its own frames (left is not a mirror of right)', () => {
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
})

describe('pose table', () => {
  const at = (state: CrewState | null, more: Partial<Actor> = {}, tick = 0): number | undefined => {
    const crew = state ? [member('a', state, 0)] : []
    return px(paint([actor('a', 0, 0, more)], crew, tick), 0, 0)
  }
  test('arrived: working types and sits every 4 ticks, idle sits, the rest stand', () => {
    expect(at('working', {}, 0)).toBe(7)
    expect(at('working', {}, 3)).toBe(7)
    expect(at('working', {}, 4)).toBe(4)
    expect(at('working', {}, 8)).toBe(7)
    expect(at('idle')).toBe(4)
    for (const s of ['needs-you', 'reporting', 'failed', 'leaving'] as CrewState[]) expect(at(s)).toBe(1)
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
})

describe('selection outline', () => {
  test('outlines the silhouette, orthogonal neighbours only, never over it', () => {
    const f = paintFrame(MAP, ART, [actor('a', 1, 1)], [member('a', 'reporting', 1)], 0, 'a', 9)
    for (const [x, y] of [[5, 4], [6, 4], [4, 5], [4, 6], [7, 5], [7, 6], [5, 7], [6, 7]] as const) expect(px(f, x, y)).toBe(9)
    for (const [x, y] of [[5, 5], [6, 6]] as const) expect(px(f, x, y)).toBe(1)
    expect(px(f, 4, 4)).toBe(6) // a diagonal corner keeps the tile under it
  })
})

