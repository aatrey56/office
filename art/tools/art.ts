import { blank, load, nativeScale, px, save, scale, shrink, type Img } from './png'

// ── palettes: Crystal-style, written as RGB5 (0-31) like the game's .pal files ───────────────
// Every palette: a shared warm off-white, a light and a dark tone of one hue, and a near-black.
type RGB5 = [number, number, number]
const OFFWHITE: RGB5 = [30, 28, 26]
const INK: RGB5 = [7, 7, 7]
export const PALETTES: Record<string, RGB5[]> = {
  wood: [OFFWHITE, [26, 20, 12], [17, 11, 5], INK],
  floor: [OFFWHITE, [29, 26, 20], [25, 21, 15], INK],
  wall: [OFFWHITE, [25, 25, 21], [17, 17, 14], INK],
  gray: [OFFWHITE, [21, 21, 22], [12, 12, 14], INK],
  green: [OFFWHITE, [16, 25, 11], [7, 16, 7], INK],
  red: [OFFWHITE, [29, 15, 13], [20, 6, 6], INK],
  blue: [OFFWHITE, [15, 21, 30], [7, 10, 22], INK],
  carpet: [OFFWHITE, [26, 21, 23], [19, 13, 17], INK],
}
export const rgb8 = (c: RGB5) => c.map(v => (v << 3) | (v >> 2)) as [number, number, number]

// The source sheet's four greens, lightest first, become slots 0-3 of a palette.
const SHADES = ['173,229,135', '112,186,101', '65,125,65', '33,65,58']

export function sheet(): Img {
  const s = load('raw/monkeyimage-interior/2367228')
  return shrink(s, nativeScale(s))
}

// A piece of the sheet as palette slots (-1 transparent).
export type Piece = { w: number; h: number; slots: Int8Array; pal: string }
export function cut(src: Img, x: number, y: number, w: number, h: number, pal: string): Piece {
  const slots = new Int8Array(w * h).fill(-1)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = px(src, x + i, y + j)
    if (p[3] === 0) continue
    const k = SHADES.indexOf(`${p[0]},${p[1]},${p[2]}`)
    if (k < 0) throw new Error(`unexpected color ${p.join()} at ${x + i},${y + j}`)
    slots[j * w + i] = k
  }
  return { w, h, slots, pal }
}

export function draw(dst: Img, piece: Piece, dx: number, dy: number) {
  const pal = PALETTES[piece.pal]!
  for (let j = 0; j < piece.h; j++) for (let i = 0; i < piece.w; i++) {
    const s = piece.slots[j * piece.w + i]!
    const x = dx + i, y = dy + j
    if (s < 0 || x < 0 || y < 0 || x >= dst.width || y >= dst.height) continue
    dst.data.set([...rgb8(pal[s]!), 255], (y * dst.width + x) * 4)
  }
}

// ── the cut list: [x, y, w, h] on the native 176x256 sheet ─────────────────────────────────
export const CUTS: Record<string, [number, number, number, number, string]> = {
  planks: [0, 0, 16, 16, 'floor'],
  brickLight: [16, 0, 16, 16, 'wall'],
  brickMid: [32, 0, 16, 16, 'wall'],
  stone: [48, 0, 16, 16, 'gray'],
  checker: [0, 16, 16, 16, 'carpet'],
  pcDesk: [0, 40, 32, 24, 'gray'],
  desk: [32, 48, 32, 16, 'wood'],
  tvCabinet: [64, 32, 32, 32, 'gray'],
  drawers: [96, 37, 32, 27, 'wood'],
  sideTable: [96, 16, 32, 16, 'wood'],
  tvBig: [139, 13, 26, 27, 'gray'],
  benchSmall: [128, 48, 16, 16, 'red'],
  benchLong: [144, 48, 32, 16, 'red'],
  bookshelf: [0, 72, 48, 24, 'wood'],
  plantSmall: [50, 72, 12, 8, 'green'],
  planter: [67, 64, 27, 16, 'green'],
  cabinetLow: [48, 80, 32, 16, 'wood'],
  fern: [82, 80, 13, 16, 'green'],
  tree: [96, 70, 16, 26, 'green'],
  doorLight: [128, 66, 16, 30, 'wood'],
  doorDark: [151, 71, 25, 25, 'wood'],
  lampTable: [146, 107, 11, 21, 'wood'],
  armchair: [5, 176, 23, 32, 'red'],
  sofaA: [32, 186, 32, 22, 'red'],
  sofaB: [64, 186, 32, 22, 'red'],
  coffeeTable: [103, 193, 34, 15, 'wood'],
  fridge: [160, 183, 16, 25, 'gray'],
  officeChair: [0, 207, 16, 16, 'gray'],
  bigTable: [135, 216, 34, 35, 'wood'],
  stool: [113, 211, 14, 11, 'wood'],
  cabinetTall: [18, 210, 13, 29, 'wood'],
  chairSmall: [18, 239, 13, 17, 'wood'],
}

// ── small desk props drawn by hand: 0 transparent, 1-4 = the palette's off-white, light, dark, outline ──
export const GRIDS: Record<string, [string, string[]]> = {
  // One-cell desks, 16 x 13: a lit top, a shaded front with one drawer line, and legs. `pcDesk` (gray)
  // carries the `monitor` prop above it like a Pokémon Center PC; `deskSmall` (wood) is a reviewer's desk.
  pcDesk: ['gray', [
    '0000004444000000',
    '4444444444444444',
    '4111114444411114',
    '4111111111111114',
    '4122222222222224',
    '4122222222222224',
    '4333333333333334',
    '4333333333333334',
    '4333444444444334',
    '4333333333333334',
    '4444444444444444',
    '0433400000004334',
    '0444400000004444',
  ]],
  deskSmall: ['wood', [
    '0444444444444440',
    '4111111111111114',
    '4122222222222224',
    '4122222222222224',
    '4122222222222224',
    '4122222222222224',
    '4333333333333334',
    '4333333333333334',
    '4333444444444334',
    '4333333333333334',
    '4444444444444444',
    '0433400000004334',
    '0444400000004444',
  ]],
  // The PC's monitor: a dark frame around a lit blue screen with a few lines of text, 12 x 11.
  monitor: ['blue', [
    '044444444440',
    '433333333334',
    '432222222234',
    '432122222234',
    '432233322234',
    '432222222234',
    '432233332234',
    '432222222234',
    '433333333334',
    '044444444440',
    '000004444000',
  ]],
  paper: ['gray', ['44444440', '41111114', '41333114', '41111114', '04444444']],
  pencilCup: ['red', ['01030', '01030', '44444', '42224', '42234', '42334', '04440']],
  mug: ['blue', ['044440', '433334', '422224', '422224', '044440']],
}
export function grid(rows: string[], pal: string): Piece {
  const w = rows[0]!.length, slots = new Int8Array(w * rows.length)
  rows.forEach((row, j) => row.split('').forEach((ch, i) => (slots[j * w + i] = Number(ch) - 1)))
  return { w, h: rows.length, slots, pal }
}

export function pieces(): Record<string, Piece> {
  const s = sheet()
  return {
    ...Object.fromEntries(Object.entries(CUTS).map(([k, [x, y, w, h, p]]) => [k, cut(s, x, y, w, h, p)])),
    ...Object.fromEntries(Object.entries(GRIDS).map(([k, [p, rows]]) => [k, grid(rows, p)])),
  }
}

// A contact sheet: every piece on off-white, in cut-list order, wrapped at `width`.
export function contact(width = 200): Img {
  const ps = Object.values(pieces())
  let x = 2, y = 2, rowH = 0
  const pos = ps.map(p => { if (x + p.w + 2 > width) { x = 2; y += rowH + 4; rowH = 0 } const at = [x, y]; x += p.w + 4; rowH = Math.max(rowH, p.h); return at as [number, number] })
  const img = blank(width, y + rowH + 2, [...rgb8([22, 22, 24]), 255])
  ps.forEach((p, i) => draw(img, p, pos[i]![0], pos[i]![1]))
  return img
}

if (import.meta.main) {
  save('out/contact_x4.png', scale(contact(), 4))
  console.log(Object.keys(CUTS).join(' '))
}
