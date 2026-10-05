import { writeFileSync } from 'node:fs'
import { background, COLS, ROWS, T } from './room'
import { crewSheet, LOOKS } from './crew'
import { load } from './png'
import { PALETTES, rgb8 } from './art'

// Writes the mod's hooks/scene/art-data.ts: one shared palette, the office cut into 16 px tiles,
// the map (tiles, walkable, seats, door) and every crew look's frames. Generated: edit tools/, not the output.
const OUT = '/Users/aatrey/.claude/dev-mods/2cb96d62-1d23-4435-9b5c-280236cac8ba/office/hooks/scene/art-data.ts'

const palette: number[] = [0x000000] // index 0: transparent for sprites
const index = (r: number, g: number, b: number) => {
  const c = (r << 16) | (g << 8) | b
  let i = palette.indexOf(c, 1)
  if (i < 0) { palette.push(c); i = palette.length - 1 }
  return i
}
const b64 = (a: Uint8Array) => Buffer.from(a).toString('base64')

// ── tiles: cut the composed office into 16x16 blocks, identical blocks shared ──
const bg = background()
const tileKeys: string[] = [], tiles: string[] = [], map: number[] = []
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
  const px = new Uint8Array(T * T)
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const i = ((r * T + y) * bg.width + c * T + x) * 4
    px[y * T + x] = index(bg.data[i]!, bg.data[i + 1]!, bg.data[i + 2]!)
  }
  const key = b64(px)
  let t = tileKeys.indexOf(key)
  if (t < 0) { tileKeys.push(key); tiles.push(key); t = tiles.length - 1 }
  map.push(t)
}

// ── the floor plan (cells): what blocks a walk, where each room's seats are, and the door ──
const BLOCKED = [
  ...[0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11].flatMap(c => [[c, 0], [c, 1]]), // the back wall (col 6 is the door)
  [6, 0], [6, 1],
  [1, 3], [2, 3], // manager desk
  [3, 2], [3, 3], // tree
  [0, 4], [1, 4], // planter
  [8, 3], [9, 3], [10, 3], [8, 4], [9, 4], [10, 4], [8, 5], [9, 5], [10, 5], // meeting table
  [11, 2], [11, 3], // tall cabinet
  [0, 5], [1, 5], [2, 5], [0, 6], [1, 6], [2, 6], [3, 5], [4, 5], [3, 6], [4, 6], [5, 5], [6, 5], [7, 5], [5, 6], [6, 6], // computer desks
  [7, 6], // fern
  [8, 6], [9, 6], [10, 6], [8, 7], [9, 7], [10, 7], [8, 8], [9, 8], [10, 8], // sofa and coffee table
  [11, 5], [11, 6], [11, 7], // fridge
  [4, 9], [5, 9], // review desk
]
const walkable = Array.from({ length: COLS * ROWS }, () => true)
for (const [c, r] of BLOCKED) walkable[r! * COLS + c!] = false

type Seat = { room: string; at: { x: number; y: number }; facing: string }
const seat = (room: string, x: number, y: number, facing: string): Seat => ({ room, at: { x, y }, facing })
const seats: Seat[] = [
  seat('manager', 1, 2, 'down'), seat('manager', 2, 2, 'down'),
  seat('meeting', 7, 3, 'right'), seat('meeting', 7, 4, 'right'), seat('meeting', 11, 4, 'left'),
  seat('coding', 1, 7, 'up'), seat('coding', 3, 7, 'up'), seat('coding', 6, 7, 'up'),
  seat('break', 9, 6, 'down'), seat('break', 10, 6, 'down'), seat('break', 11, 8, 'left'),
  seat('lobby', 5, 3, 'down'), seat('lobby', 7, 2, 'down'),
  seat('whiteboard', 8, 2, 'up'), seat('whiteboard', 9, 2, 'up'),
  seat('review', 4, 8, 'down'), seat('review', 5, 8, 'down'),
]
const door = { x: 6, y: 2 }

// ── crew: per look, per facing, the five poses ──
const { grids } = crewSheet(load('raw/character_base_16x16.png'))
const SKIN = [248, 192, 144], BLACK = [16, 16, 24]
const sprites = LOOKS.map(look => {
  const color = (ch: string) =>
    ch === '#' ? BLACK : ch === 's' ? SKIN : ch === 'c' ? look.clothes : ch === 'h' ? (look.hair === 'black' ? BLACK : look.clothes) : null
  const frame = (rows: string[]) => {
    const px = new Uint8Array(16 * 16)
    rows.forEach((row, y) => row.split('').forEach((ch, x) => { const c = color(ch); if (c) px[y * 16 + x] = index(c[0]!, c[1]!, c[2]!) }))
    return b64(px)
  }
  const g = grids[look.name]!
  return Object.fromEntries((['up', 'down', 'right', 'left'] as const).map(dir => {
    const f = g[dir].map(frame)
    return [dir, { stand: f[0], walk1: f[1], walk2: f[3], sit: f[0], type: f[2] }]
  }))
})

// ── bubbles: '#' ink, 'W' off-white, 'R' red ──
const ink = rgb8(PALETTES.wall![3]!), white = rgb8(PALETTES.wall![0]!), red = rgb8(PALETTES.red![2]!), blue = rgb8(PALETTES.blue![2]!)
const bubble = (rows: string[]) => {
  const w = rows[0]!.length, px = new Uint8Array(w * rows.length)
  rows.forEach((row, y) => row.split('').forEach((ch, x) => {
    const c = ch === '#' ? ink : ch === 'W' ? white : ch === 'R' ? red : ch === 'B' ? blue : null
    if (c) px[y * w + x] = index(c[0]!, c[1]!, c[2]!)
  }))
  return { width: w, height: rows.length, pixels: b64(px) }
}
const needsYou = bubble(['.#######.', '#WWWRWWW#', '#WWWRWWW#', '#WWWRWWW#', '#WWWRWWW#', '#WWWWWWW#', '#WWWRWWW#', '.###.###.', '....#....'])
const failed = bubble(['.#######.', '#WWWWWWW#', '#WRWWWRW#', '#WWRWRWW#', '#WWWRWWW#', '#WWRWRWW#', '#WRWWWRW#', '.###.###.', '....#....'])

// idle crew: two music notes that alternate; planning at the whiteboard: a thought bubble
const music = [
  bubble(['...BB.', '...B.B', '...B..', '...B..', '.BBB..', '.BBB..']),
  bubble(['..BBBBB', '..B...B', '..B...B', '..B...B', 'BBB.BBB', 'BBB.BBB']),
]
const thinking = bubble(['.#######.', '#WWWWWWW#', '#W#W#W#W#', '#WWWWWWW#', '.#######.', '..##.....', '.#.......'])

const data = {
  palette, tileSize: T, width: COLS, height: ROWS, tiles, map, walkable, seats, door, sprites, bubbles: { needsYou, failed, music, thinking },
}
const src = `// GENERATED by ~/Coding/office-art/tools/export.ts. Do not edit by hand.
// Art: furniture from MonkeyImage "Home Interior Tilesheet (Game Boy styled)" (itch.io, free to use),
// crew bodies from "Simple Character Base 16x16" (OpenGameArt, CC0), recolored to Crystal-style palettes.
// Bitmaps are base64 palette indices, row-major.

export const ART_DATA = ${JSON.stringify(data)} as const
`
writeFileSync(OUT, src)
console.log(`palette ${palette.length}, unique tiles ${tiles.length} of ${COLS * ROWS}, looks ${sprites.length}, ${(src.length / 1024).toFixed(0)} KB`)
