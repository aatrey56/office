import { crewSheet, LOOKS } from './crew'
import { blank, load, save, scale, type Img } from './png'
import { draw, pieces, PALETTES, rgb8 } from './art'

// The office: 12 x 10 cells of 16 px (192 x 160). Back wall on rows 0-1, open-plan zones below:
// manager top-left, meeting top-right, coding desks centre-left, break room bottom-right, door bottom-centre.
export const COLS = 12, ROWS = 10, T = 16
const P = pieces()

// Every piece in the room, where it goes, and whether its base blocks a walk. Wall pieces
// (rows 0-1) never block: the wall already does. The floor plan is computed from this list.
// `tall` pieces (a tree, a cabinet, a chair) block only their base: their top half stands in front of
// the cell behind. Flat furniture (desks, tables, the couch) blocks all the cells it covers.
type Place = { piece: keyof typeof P; x: number; y: number; blocks: boolean; tall?: true }
export const PLACEMENTS: Place[] = [
  // manager office
  { piece: 'bookshelf', x: 0, y: 8, blocks: false },
  { piece: 'desk', x: 16, y: 48, blocks: true },
  { piece: 'tree', x: 56, y: 32, blocks: true, tall: true },
  { piece: 'planter', x: 2, y: 64, blocks: true },
  // meeting: whiteboard on the wall, the big table, chairs
  { piece: 'tvBig', x: 131, y: 4, blocks: false },
  { piece: 'bigTable', x: 139, y: 48, blocks: true },
  { piece: 'cabinetTall', x: 176, y: 32, blocks: true, tall: true },
  { piece: 'chairSmall', x: 123, y: 62, blocks: true, tall: true },
  { piece: 'chairSmall', x: 176, y: 62, blocks: true, tall: true },
  // coding corner: three computer desks on whole cells, a walkway between each pair
  { piece: 'pcDesk', x: 0, y: 88, blocks: true },
  { piece: 'pcDesk', x: 48, y: 88, blocks: true },
  { piece: 'pcDesk', x: 96, y: 88, blocks: true },
  // break room
  { piece: 'sofaA', x: 136, y: 98, blocks: true },
  { piece: 'coffeeTable', x: 135, y: 124, blocks: true },
  { piece: 'fridge', x: 176, y: 95, blocks: true, tall: true },
  // review corner: a plain desk with no computer
  { piece: 'desk', x: 64, y: 144, blocks: true },
  { piece: 'fern', x: 114, y: 136, blocks: true, tall: true },
  // the door, top centre, with its light spilling in
  { piece: 'doorLight', x: 96, y: 2, blocks: false },
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

export function background(): Img {
  const img = blank(COLS * T, ROWS * T, [...rgb8(PALETTES.floor![0]!), 255])
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) draw(img, r < 2 ? P.brickLight! : P.planks!, c * T, r * T)
  // a dark skirting line where the wall meets the floor
  for (let x = 0; x < img.width; x++) img.data.set([...rgb8(PALETTES.wall![3]!), 255], (2 * T * img.width + x) * 4)
  // break-room rug: checker carpet under the sofa corner
  for (let r = 6; r < 9; r++) for (let c = 8; c < 12; c++) draw(img, P.checker!, c * T, r * T)
  for (const place of PLACEMENTS) draw(img, P[place.piece]!, place.x, place.y)
  return img
}

// A test cast: one of each look, posed where its state would put it.
export function withCrew(bg: Img): Img {
  const img: Img = { width: bg.width, height: bg.height, data: bg.data.slice() }
  const { sheet } = crewSheet(load('raw/character_base_16x16.png'))
  const put = (look: number, dir: number, frame: number, x: number, y: number) => {
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) {
      const s = ((look * 16 + j) * sheet.width + (dir * 4 + frame) * 16 + i) * 4
      if (sheet.data[s + 3] === 0) continue
      const d = ((y + j) * img.width + x + i) * 4
      if (x + i < img.width && y + j < img.height) img.data.set(sheet.data.subarray(s, s + 4), d)
    }
  }
  put(0, 0, 0, 24, 30) // manager at the desk, facing you
  put(1, 1, 0, 16, 108) // coders at their desks, backs to you
  put(2, 1, 2, 56, 108)
  put(3, 2, 0, 122, 50) // meeting: beside the table, facing it
  put(4, 0, 0, 144, 92) // break room, on the sofa
  put(5, 0, 1, 98, 130) // just arrived at the door
  return img
}

if (import.meta.main) {
  const bg = background()
  save('out/room_x6.png', scale(withCrew(bg), 6))
  console.log('room', bg.width, 'x', bg.height)
}
