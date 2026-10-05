import { crewSheet, LOOKS } from './crew'
import { blank, load, save, scale, type Img } from './png'
import { draw, pieces, PALETTES, rgb8 } from './art'

// The office: 12 x 10 cells of 16 px (192 x 160). Back wall on rows 0-1, open-plan zones below:
// manager top-left, meeting top-right, coding desks centre-left, break room bottom-right, door bottom-centre.
export const COLS = 12, ROWS = 10, T = 16
const P = pieces()

export function background(): Img {
  const img = blank(COLS * T, ROWS * T, [...rgb8(PALETTES.floor![0]!), 255])
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) draw(img, r < 2 ? P.brickLight! : P.planks!, c * T, r * T)
  // a dark skirting line where the wall meets the floor
  for (let x = 0; x < img.width; x++) img.data.set([...rgb8(PALETTES.wall![3]!), 255], (2 * T * img.width + x) * 4)
  // break-room rug: checker carpet under the sofa corner
  for (let r = 6; r < 9; r++) for (let c = 8; c < 12; c++) draw(img, P.checker!, c * T, r * T)
  // manager office
  draw(img, P.bookshelf!, 0, 8)
  draw(img, P.desk!, 16, 48)
  draw(img, P.tree!, 56, 32)
  // meeting: whiteboard on the wall, the big table, stools
  draw(img, P.tvBig!, 131, 4)
  draw(img, P.bigTable!, 139, 48)
  draw(img, P.cabinetTall!, 176, 32)
  draw(img, P.chairSmall!, 123, 62)
  draw(img, P.chairSmall!, 176, 62)
  // coding corner: three computer desks
  draw(img, P.pcDesk!, 8, 88)
  draw(img, P.pcDesk!, 48, 88)
  draw(img, P.pcDesk!, 88, 88)
  draw(img, P.planter!, 2, 64)
  // break room
  draw(img, P.sofaA!, 136, 98)
  draw(img, P.coffeeTable!, 135, 124)
  draw(img, P.fridge!, 176, 95)
  draw(img, P.fern!, 120, 98)
  // review corner: a plain desk (no computer) at the bottom left, reviewers sit behind it
  draw(img, P.desk!, 64, 144)
  // door, bottom centre, with its light spilling in
  draw(img, P.doorLight!, 96, 2)
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
