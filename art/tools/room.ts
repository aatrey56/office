import { crewSheet, LOOKS } from './crew'
import { blank, load, save, scale, type Img } from './png'
import { draw, pieces, PALETTES, rgb8, type Piece } from './art'

// The office: 12 x 10 cells of 16 px (192 x 160), laid out like a Pokémon Center: small one-cell
// pieces and open floor. Back wall on rows 0-1 with the bookshelf, the door (col 6) and the whiteboard
// (cols 8-9); the manager's desk top-left, the meeting table top-right, four small review desks mid-left,
// a bank of five PCs along the bottom and a small break room bottom-right.
export const COLS = 12, ROWS = 10, T = 16
const P = pieces()

// Every piece in the room, where it goes, and whether its base blocks a walk. Wall pieces
// (rows 0-1) never block: the wall already does. The floor plan is computed from this list.
// `tall` pieces (a tree, a cabinet, a chair, a PC) block only their base: their top half stands in front
// of the cell behind. Flat furniture (desks, tables, the couch) blocks all the cells it covers.
// Layers: 'wall' is baked into the background tiles (always behind everyone); 'floor' is drawn after
// the tiles but under everything sorted; 'sorted' (the default) is drawn in bottom-edge order with the crew.
// `props` are small things on a desk, offset from its top-left, drawn just after it.
export type Layer = 'wall' | 'floor' | 'sorted'
type Place = { piece: keyof typeof P; x: number; y: number; blocks: boolean; tall?: true; layer?: Layer; props?: [keyof typeof P, number, number][] }
export const PLACEMENTS: Place[] = [
  // on the back wall: bookshelf, the door with its light spilling in, the whiteboard
  { piece: 'bookshelf', x: 0, y: 8, blocks: false, layer: 'wall' },
  { piece: 'doorLight', x: 96, y: 2, blocks: false, layer: 'wall' },
  { piece: 'tvBig', x: 127, y: 4, blocks: false, layer: 'wall' },
  // manager's corner: the big desk, a chair behind it, a tree
  { piece: 'chairSmall', x: 25, y: 32, blocks: true, tall: true },
  { piece: 'desk', x: 16, y: 48, blocks: true, props: [['paper', 1, 3], ['mug', 24, 2]] },
  { piece: 'tree', x: 48, y: 32, blocks: true, tall: true },
  // coding: five PCs in a row along the bottom, each one cell, the sitter in the cell below
  ...[1, 2, 3, 4, 5].map(c => ({ piece: 'pcDesk' as const, x: c * T, y: 131, blocks: true, props: [['monitor', 2, -11]] as [keyof typeof P, number, number][] })),
  // meeting: the big table, two chairs either side, two stools in front, a cabinet in the corner
  { piece: 'bigTable', x: 126, y: 64, blocks: true },
  { piece: 'cabinetTall', x: 176, y: 32, blocks: true, tall: true },
  { piece: 'chairSmall', x: 110, y: 63, blocks: true, tall: true },
  { piece: 'chairSmall', x: 110, y: 79, blocks: true, tall: true },
  { piece: 'chairSmall', x: 164, y: 63, blocks: true, tall: true },
  { piece: 'chairSmall', x: 164, y: 79, blocks: true, tall: true },
  { piece: 'stool', x: 129, y: 99, blocks: false, layer: 'floor' },
  { piece: 'stool', x: 145, y: 99, blocks: false, layer: 'floor' },
  // review: four small desks in two pairs, the reader behind each
  { piece: 'deskSmall', x: 0, y: 99, blocks: true, props: [['paper', 2, 1]] },
  { piece: 'deskSmall', x: 16, y: 99, blocks: true, props: [['mug', 8, 1]] },
  { piece: 'deskSmall', x: 48, y: 99, blocks: true, props: [['paper', 2, 1]] },
  { piece: 'deskSmall', x: 64, y: 99, blocks: true, props: [['pencilCup', 9, -1]] },
  // break room: a couch, a bench facing it, the fridge
  { piece: 'benchSmall', x: 128, y: 128, blocks: false },
  { piece: 'sofaA', x: 144, y: 130, blocks: true },
  { piece: 'fridge', x: 176, y: 135, blocks: true, tall: true },
]

// Cells a piece stands on: in this 3/4 view only the lower part of a piece is its base, so a
// cell is blocked when that base covers at least 40% of it.
export function footprint(place: Place): [number, number][] {
  const p = P[place.piece]!
  const baseTop = place.tall ? place.y + Math.max(0, Math.floor(p.h * 0.55)) : place.y
  const cells: [number, number][] = []
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const w = Math.min(place.x + p.w, (c + 1) * T) - Math.max(place.x, c * T)
    const h = Math.min(place.y + p.h, (r + 1) * T) - Math.max(baseTop, r * T)
    if (w > 0 && h > 0 && w * h >= 0.4 * T * T) cells.push([c, r])
  }
  return cells
}

// Background tiles: floor planks, wall bricks, skirting, the break-room rug and the wall layer only.
export function background(): Img {
  const img = blank(COLS * T, ROWS * T, [...rgb8(PALETTES.floor![0]!), 255])
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) draw(img, r < 2 ? P.brickLight! : P.planks!, c * T, r * T)
  // a dark skirting line where the wall meets the floor
  for (let x = 0; x < img.width; x++) img.data.set([...rgb8(PALETTES.wall![3]!), 255], (2 * T * img.width + x) * 4)
  // break-room rug: checker carpet under the sofa corner
  for (let r = 7; r <= 9; r++) for (let c = 8; c < 12; c++) draw(img, P.checker!, c * T, r * T)
  for (const place of PLACEMENTS) if (place.layer === 'wall') draw(img, P[place.piece]!, place.x, place.y)
  return img
}

// Everything drawn over the tiles: floor pieces, sorted furniture (sortY = bottom pixel row), and each
// desk's props just after their desk (sortY + 0.1).
export type Prop = { name: string; x: number; y: number; piece: Piece; sortY: number; floor: boolean }
export function props(): Prop[] {
  const out: Prop[] = []
  for (const place of PLACEMENTS) {
    if (place.layer === 'wall') continue
    const p = P[place.piece]!, floor = place.layer === 'floor', sortY = place.y + p.h
    out.push({ name: place.piece, x: place.x, y: place.y, piece: p, sortY, floor })
    for (const [name, ox, oy] of place.props ?? []) out.push({ name, x: place.x + ox, y: place.y + oy, piece: P[name]!, sortY: sortY + 0.1, floor })
  }
  return out
}

// The room as the plugin draws it: tiles, floor props, then props and people by sort key.
// A person's key is their bottom pixel row + 0.5, + 24 when they sit on top of their furniture.
export type Person = { look: number; dir: 'down' | 'up' | 'right' | 'left'; x: number; y: number; zBias?: boolean }
const DIRS = ['down', 'up', 'right', 'left'] as const
export function scene(people: Person[] = []): Img {
  const img = background()
  const ps = props()
  for (const p of ps) if (p.floor) draw(img, p.piece, p.x, p.y)
  const { sheet } = crewSheet(load('raw/character_base_16x16.png'))
  const put = (who: Person) => {
    const dir = DIRS.indexOf(who.dir)
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) {
      const s = ((who.look * 16 + j) * sheet.width + dir * 4 * 16 + i) * 4
      const x = who.x + i, y = who.y + j
      if (sheet.data[s + 3] === 0 || x < 0 || y < 0 || x >= img.width || y >= img.height) continue
      img.data.set(sheet.data.subarray(s, s + 4), (y * img.width + x) * 4)
    }
  }
  const items: [number, () => void][] = [
    ...ps.filter(p => !p.floor).map(p => [p.sortY, () => draw(img, p.piece, p.x, p.y)] as [number, () => void]),
    ...people.map(w => [w.y + 16 + 0.5 + (w.zBias ? 24 : 0), () => put(w)] as [number, () => void]),
  ]
  items.sort((a, b) => a[0] - b[0]).forEach(([, f]) => f())
  return img
}

if (import.meta.main) {
  save('out/room_x6.png', scale(scene(), 6))
  console.log('room', COLS * T, 'x', ROWS * T, 'looks', LOOKS.length)
}
