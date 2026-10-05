import { blank, load, px, save, scale, type Img } from './png'

// Gen 2 overworld rule: 3 colors + transparent. Light = skin, mid = clothing (hair may share it), dark = outline.
// The base (CC0, opengameart "Simple Character Base 16x16") has skin + black; this paints hair and an outfit
// onto its silhouette by region, so nothing is drawn freehand.
export const LOOKS = [
  { name: 'red', clothes: [214, 64, 48], hair: 'clothes' },
  { name: 'blue', clothes: [56, 104, 216], hair: 'black' },
  { name: 'green', clothes: [56, 152, 72], hair: 'clothes' },
  { name: 'purple', clothes: [136, 72, 192], hair: 'black' },
  { name: 'teal', clothes: [32, 144, 152], hair: 'black' },
  { name: 'brown', clothes: [152, 96, 48], hair: 'clothes' },
] as const
const SKIN: [number, number, number] = [248, 192, 144] // ≈ RGB5 (31,24,18) expanded
const BLACK: [number, number, number] = [16, 16, 24]

const S = 16
type Dir = 'down' | 'up' | 'right' | 'left'
const DIRS: Dir[] = ['down', 'up', 'right', 'left']

function frame(base: Img, fx: number, fy: number): string[] {
  const rows: string[] = []
  for (let y = 0; y < S; y++) {
    let r = ''
    for (let x = 0; x < S; x++) {
      const p = px(base, fx * S + x, fy * S + y)
      r += p[3] === 0 ? '.' : p[0] + p[1] + p[2] < 60 ? '#' : 's'
    }
    rows.push(r)
  }
  return rows
}

// '.' transparent, '#' outline, 's' skin, 'c' clothes, 'h' hair
function dress(rows: string[], dir: Dir): string[] {
  const g = rows.map(r => r.split(''))
  const chin = g.findIndex((r, y) => y >= 5 && r.join('').includes('#####'))
  const top = g.findIndex(r => r.includes('#'))
  const eyes = g.findIndex((r, y) => y > top && y < chin && r.join('').replace(/^\.*#/, '').replace(/#\.*$/, '').includes('#'))
  for (let y = top + 1; y < chin; y++) {
    const xs = g[y]!.map((c, x) => (c === 's' ? x : -1)).filter(x => x >= 0)
    if (!xs.length) continue
    const [lo, hi] = [xs[0]!, xs[xs.length - 1]!]
    for (const x of xs) {
      const crown = eyes < 0 || y < eyes - 1 // the rows above the brow
      const bangs = y < eyes + 1 && (x === lo || x === hi) // a pixel of hair down each side
      const behind = dir === 'right' ? x <= lo + 1 : dir === 'left' ? x >= hi - 1 : false // back of the head
      if (dir === 'up' || crown || bangs || (behind && y < chin - 1)) g[y]![x] = 'h'
    }
  }
  for (let y = chin + 1; y < S; y++) {
    const xs = g[y]!.map((c, x) => (c === 's' ? x : -1)).filter(x => x >= 0)
    for (const x of xs) g[y]![x] = 'c'
    // hands: the outermost skin pixel of the arm row stays skin
    if (y === chin + 2 && xs.length && (dir === 'down' || dir === 'up')) {
      g[y]![xs[0]!] = 's'
      g[y]![xs[xs.length - 1]!] = 's'
    }
  }
  return g.map(r => r.join(''))
}

export function crewSheet(base: Img) {
  // one sheet: a row per look, 4 directions x 4 frames across
  const out = blank(S * 16, S * LOOKS.length)
  const grids: Record<string, Record<Dir, string[][]>> = {}
  LOOKS.forEach((look, li) => {
    grids[look.name] = { down: [], up: [], right: [], left: [] }
    DIRS.forEach((dir, di) => {
      for (let f = 0; f < 4; f++) {
        const rows = dress(frame(base, f, di), dir)
        grids[look.name]![dir].push(rows)
        rows.forEach((r, y) =>
          r.split('').forEach((c, x) => {
            const col =
              c === '#' ? BLACK : c === 's' ? SKIN : c === 'c' ? look.clothes : c === 'h' ? (look.hair === 'black' ? BLACK : look.clothes) : null
            if (col) out.data.set([...col, 255], ((li * S + y) * out.width + (di * 4 + f) * S + x) * 4)
          }),
        )
      }
    })
  })
  return { sheet: out, grids }
}

if (import.meta.main) {
  const { sheet } = crewSheet(load('raw/character_base_16x16.png'))
  save('out/crew.png', sheet)
  save('out/crew_x6.png', scale(sheet, 6))
  console.log('wrote out/crew.png', sheet.width, sheet.height)
}
