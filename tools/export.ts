import { writeFileSync } from 'node:fs'
import { background, COLS, footprint, PLACEMENTS, props as roomProps, ROWS, scene, T, type Person } from './room'
import { crewSheet, LOOKS } from './crew'
import { load, save, scale, type Img } from './png'
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
// The back wall (rows 0-1) blocks everywhere; below it, each piece's base blocks the cells it stands on.
const BLOCKED: [number, number][] = [
  ...Array.from({ length: COLS }, (_, c) => [[c, 0], [c, 1]] as [number, number][]).flat(),
  ...PLACEMENTS.filter(p => p.blocks).flatMap(footprint),
]
const walkable = Array.from({ length: COLS * ROWS }, () => true)
for (const [c, r] of BLOCKED) walkable[r! * COLS + c!] = false

type Facing = 'down' | 'up' | 'right' | 'left'
type Seat = { room: string; at: { x: number; y: number }; facing: Facing; dx?: number; dy?: number; zBias?: true }
// dx/dy nudge the sitter off the cell (dx -8 centres them on a two-cell desk); zBias: they draw on top
// of what they sit on (a couch, a bench, a chair) instead of being sorted behind it.
const seat = (room: string, x: number, y: number, facing: Facing, dx = 0, dy = 0, zBias = false): Seat =>
  ({ room, at: { x, y }, facing, ...(dx ? { dx } : {}), ...(dy ? { dy } : {}), ...(zBias ? { zBias: true as const } : {}) })
const seats: Seat[] = [
  seat('manager', 2, 2, 'down', -8, 6),
  seat('meeting', 7, 3, 'right', 4, 0, true), seat('meeting', 7, 4, 'right', 4, 0, true), seat('meeting', 11, 4, 'left', -6, 0, true),
  seat('whiteboard', 8, 2, 'up', -4), seat('whiteboard', 9, 2, 'up', -4),
  seat('coding', 1, 7, 'up', -8, -6), seat('coding', 4, 7, 'up', -8, -6), seat('coding', 7, 7, 'up', -8, -6),
  seat('review', 2, 8, 'down', -8, 6), seat('review', 5, 8, 'down', -8, 6),
  // break room: two on the couch facing out, two on the bench facing them, one on the stool at the side
  seat('break', 9, 6, 'down', 0, 3, true), seat('break', 10, 6, 'down', 0, 3, true),
  seat('break', 9, 9, 'up', 0, -4, true), seat('break', 10, 9, 'up', 0, -4, true),
  seat('break', 8, 7, 'right', 0, 0, true),
  seat('lobby', 5, 3, 'down'), seat('lobby', 7, 2, 'down'),
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

// Every seat must be reachable from the door: standing on a walkable cell the door reaches, or (a
// seat on furniture) next to one. A floor plan that walls a seat off fails the export, loudly.
{
  const reach = new Set([`${door.x},${door.y}`]), queue = [[door.x, door.y]]
  while (queue.length) {
    const [x, y] = queue.shift()!
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const nx = x! + dx!, ny = y! + dy!
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS || !walkable[ny * COLS + nx] || reach.has(`${nx},${ny}`)) continue
      reach.add(`${nx},${ny}`); queue.push([nx, ny])
    }
  }
  const near = (x: number, y: number) => reach.has(`${x},${y}`) || [[0, -1], [1, 0], [0, 1], [-1, 0]].some(([dx, dy]) => reach.has(`${x + dx!},${y + dy!}`))
  const cut = seats.filter(s => !near(s.at.x, s.at.y))
  for (let y = 0; y < ROWS; y++) console.log(String(y).padStart(2), Array.from({ length: COLS }, (_, x) => (seats.some(s => s.at.x === x && s.at.y === y) ? (near(x, y) ? 's' : 'X') : walkable[y * COLS + x] ? (reach.has(`${x},${y}`) ? '.' : '?') : '#')).join(''))
  if (cut.length) throw new Error(`seats the door cannot reach: ${cut.map(s => `${s.room}(${s.at.x},${s.at.y})`).join(', ')}`)
}

// ── props: furniture drawn over the tiles, floor pieces first, the rest sorted by sortY with the crew ──
const propList = roomProps()
const props = propList.map(p => {
  const px = new Uint8Array(p.piece.w * p.piece.h), pal = PALETTES[p.piece.pal]!
  p.piece.slots.forEach((s, i) => { if (s >= 0) { const c = rgb8(pal[s]!); px[i] = index(c[0], c[1], c[2]) } })
  return { name: p.name, x: p.x, y: p.y, width: p.piece.w, height: p.piece.h, pixels: b64(px), sortY: p.sortY, floor: p.floor }
})

// ── previews: everyone seated (out/preview.png) and, with --debug, the empty room with the floor plan ──
const sitters: Person[] = seats.map((s, i) => ({ look: i % LOOKS.length, dir: s.facing, x: s.at.x * T + (s.dx ?? 0), y: s.at.y * T + (s.dy ?? 0), zBias: !!s.zBias }))
const Z = 4
save('out/preview.png', scale(scene(sitters), Z))
if (process.argv.includes('--debug')) {
  const img: Img = scale(scene(), Z)
  const mix = (x: number, y: number, c: number[], a: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return
    const i = (y * img.width + x) * 4
    for (let k = 0; k < 3; k++) img.data[i + k] = Math.round(img.data[i + k]! * (1 - a) + c[k]! * a)
  }
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (!walkable[r * COLS + c]) for (let y = 0; y < T * Z; y++) for (let x = 0; x < T * Z; x++) mix(c * T * Z + x, r * T * Z + y, [255, 0, 0], 0.3)
  }
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (x % (T * Z) === 0 || y % (T * Z) === 0) mix(x, y, [0, 0, 0], 0.25)
  // each seat: a dot at its sprite's top-left and an arrow at its centre pointing the way it faces
  for (const s of sitters) {
    const cx = (s.x + 8) * Z, cy = (s.y + 8) * Z
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) mix(s.x * Z + i, s.y * Z + j, [255, 0, 255], 1)
    for (let t = -10; t <= 10; t++) for (let u = -10; u <= 10; u++) {
      // a triangle: tip at +10 along the facing, base 20 wide at -10
      const along = s.dir === 'down' ? u : s.dir === 'up' ? -u : s.dir === 'right' ? t : -t
      const across = s.dir === 'down' || s.dir === 'up' ? t : u
      const half = (10 - along) / 2
      if (Math.abs(across) <= half + 1) mix(cx + t, cy + u, Math.abs(across) > half - 1 || along >= 9 || along <= -10 ? [0, 0, 0] : [255, 0, 255], 1)
    }
  }
  save('out/debug.png', img)
}

const data = {
  palette, tileSize: T, width: COLS, height: ROWS, tiles, map, walkable, seats, door, sprites, bubbles: { needsYou, failed, music, thinking }, props,
}
const src = `// GENERATED by ~/Coding/office-art/tools/export.ts. Do not edit by hand.
// Art: furniture from MonkeyImage "Home Interior Tilesheet (Game Boy styled)" (itch.io, free to use),
// crew bodies from "Simple Character Base 16x16" (OpenGameArt, CC0), recolored to Crystal-style palettes.
// Bitmaps are base64 palette indices, row-major.

export const ART_DATA = ${JSON.stringify(data)} as const
`
writeFileSync(OUT, src)
console.log(`palette ${palette.length}, unique tiles ${tiles.length} of ${COLS * ROWS}, props ${props.length}, looks ${sprites.length}, ${(src.length / 1024).toFixed(0)} KB`)
