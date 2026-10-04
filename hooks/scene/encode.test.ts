import { describe, expect, test } from 'claude-code/testing'

import type { Frame } from '../../types'
import { toCells, toPng } from './encode'

// The runtime has Uint8Array.fromBase64; lib es2023 does not type it yet.
const fromBase64 = (s: string): Uint8Array => (Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(s)

function frameOf(width: number, height: number, pixels: number[]): Frame {
  return { width, height, pixels: Uint8Array.from(pixels) }
}

function triplets(b64: string): number[][] {
  const bytes = fromBase64(b64)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: number[][] = []
  for (let i = 0; i < bytes.length; i += 12) out.push([view.getUint32(i, true), view.getUint32(i + 4, true), view.getUint32(i + 8, true)])
  return out
}

const PAL = [0x112233, 0xff0000, 0x00ff00, 0x0000ff]
const HB = 0x2580

describe('toCells', () => {
  test('shrink 1: one cell per two stacked pixels, top is fg and bottom is bg', () => {
    const f = frameOf(2, 2, [0, 1, 2, 3])
    const { cells, columns, rows } = toCells(f, PAL, 1)
    expect([columns, rows]).toEqual([2, 1])
    expect(triplets(cells)).toEqual([
      [HB, 0x112233, 0x00ff00],
      [HB, 0xff0000, 0x0000ff],
    ])
  })
  test('an odd last row repeats the top pixel as the bottom', () => {
    const f = frameOf(2, 3, [0, 1, 2, 3, 1, 0])
    const { cells, columns, rows } = toCells(f, PAL, 1)
    expect([columns, rows]).toEqual([2, 2])
    expect(triplets(cells)).toEqual([
      [HB, 0x112233, 0x00ff00],
      [HB, 0xff0000, 0x0000ff],
      [HB, 0xff0000, 0xff0000],
      [HB, 0x112233, 0x112233],
    ])
  })
  test('a palette index with no entry is black, and alpha bits are dropped', () => {
    const { cells } = toCells(frameOf(1, 2, [7, 0]), [0xff123456], 1)
    expect(triplets(cells)).toEqual([[HB, 0, 0x123456]])
  })
  test('shrink 2 takes the top-left of each 2x2 block and drops an odd trailing row and column', () => {
    // 5x5: rows/cols 0 and 2 survive, row/col 4 is dropped.
    // prettier-ignore
    const f = frameOf(5, 5, [
      1, 0, 2, 0, 3,
      0, 0, 0, 0, 0,
      3, 0, 0, 0, 1,
      0, 0, 0, 0, 0,
      2, 2, 2, 2, 2,
    ])
    const { cells, columns, rows } = toCells(f, PAL, 2)
    expect([columns, rows]).toEqual([2, 1])
    expect(triplets(cells)).toEqual([
      [HB, 0xff0000, 0x0000ff],
      [HB, 0x00ff00, 0x112233],
    ])
  })
  test('shrink 2 with an odd height after halving', () => {
    // 4x6 → 2x3 → 2 columns, 2 rows; the last row is a lone top pixel.
    const px = Array(24).fill(0)
    px[0] = 1
    px[2] = 2
    px[2 * 4] = 3
    px[4 * 4 + 2] = 1
    const { cells, columns, rows } = toCells(frameOf(4, 6, px), PAL, 2)
    expect([columns, rows]).toEqual([2, 2])
    expect(triplets(cells)).toEqual([
      [HB, 0xff0000, 0x0000ff],
      [HB, 0x00ff00, 0x112233],
      [HB, 0x112233, 0x112233],
      [HB, 0xff0000, 0xff0000],
    ])
  })
})

// ── an independent PNG reader ──────────────────────────────────────────────
function crc32(bytes: Uint8Array): number {
  let c = ~0 >>> 0
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (const x of bytes) {
    a = (a + x) % 65521
    b = (b + a) % 65521
  }
  return (b * 65536 + a) >>> 0
}

type Chunk = { type: string; data: Uint8Array; crcOk: boolean }
function chunks(png: Uint8Array): Chunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out: Chunk[] = []
  let at = 8
  while (at < png.length) {
    const len = view.getUint32(at)
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8))
    const data = png.subarray(at + 8, at + 8 + len)
    const crcOk = view.getUint32(at + 8 + len) === crc32(png.subarray(at + 4, at + 8 + len))
    out.push({ type, data, crcOk })
    at += 12 + len
  }
  return out
}

type Block = { len: number; nlen: number; final: boolean }
function inflateStored(z: Uint8Array): { header: number[]; blocks: Block[]; raw: Uint8Array; adler: number } {
  const view = new DataView(z.buffer, z.byteOffset, z.byteLength)
  const blocks: Block[] = []
  const parts: Uint8Array[] = []
  let at = 2
  for (;;) {
    const head = z[at] ?? 0
    expect(head & 0b110).toBe(0) // BTYPE 00, stored
    const len = view.getUint16(at + 1, true)
    const nlen = view.getUint16(at + 3, true)
    blocks.push({ len, nlen, final: (head & 1) === 1 })
    parts.push(z.subarray(at + 5, at + 5 + len))
    at += 5 + len
    if (head & 1) break
  }
  const raw = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    raw.set(p, o)
    o += p.length
  }
  expect(at + 4).toBe(z.length)
  return { header: [z[0] ?? -1, z[1] ?? -1], blocks, raw, adler: view.getUint32(at) }
}

function decode(b64: string) {
  const png = fromBase64(b64)
  const list = chunks(png)
  const ihdr = list[0]!.data
  const iv = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength)
  const z = inflateStored(list.find(c => c.type === 'IDAT')!.data)
  return {
    signature: [...png.subarray(0, 8)],
    list,
    width: iv.getUint32(0),
    height: iv.getUint32(4),
    fields: [...ihdr.subarray(8, 13)],
    plte: [...list.find(c => c.type === 'PLTE')!.data],
    z,
  }
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function checkPixels(z: { raw: Uint8Array }, f: Frame, s: number): void {
  const w = f.width * s
  const h = f.height * s
  expect(z.raw.length).toBe((w + 1) * h)
  for (let y = 0; y < h; y++) {
    expect(z.raw[y * (w + 1)]).toBe(0)
    for (let x = 0; x < w; x++) {
      const want = f.pixels[Math.floor(y / s) * f.width + Math.floor(x / s)]
      if (z.raw[y * (w + 1) + 1 + x] !== want) throw new Error(`pixel ${x},${y}: ${z.raw[y * (w + 1) + 1 + x]} != ${want}`)
    }
  }
}

describe('toPng', () => {
  const small = frameOf(3, 2, [0, 1, 2, 3, 2, 1])

  test('signature, chunk order and every CRC', () => {
    const d = decode(toPng(small, PAL, 2))
    expect(d.signature).toEqual(SIGNATURE)
    expect(d.list.map(c => c.type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND'])
    for (const c of d.list) expect(c.crcOk).toBe(true)
    expect(d.list[3]!.data.length).toBe(0)
  })
  test('IHDR: scaled size, 8-bit indexed, no interlace', () => {
    const d = decode(toPng(small, PAL, 3))
    expect([d.width, d.height]).toEqual([9, 6])
    expect(d.fields).toEqual([8, 3, 0, 0, 0])
  })
  test('PLTE is three bytes per entry; an empty palette writes one black entry', () => {
    expect(decode(toPng(small, PAL, 1)).plte).toEqual([0x11, 0x22, 0x33, 0xff, 0, 0, 0, 0xff, 0, 0, 0, 0xff])
    expect(decode(toPng(small, [], 1)).plte).toEqual([0, 0, 0])
  })
  test('zlib header, stored block lengths and Adler-32', () => {
    const { z } = decode(toPng(small, PAL, 2))
    expect(z.header).toEqual([0x78, 0x01])
    expect((0x78 * 256 + 0x01) % 31).toBe(0)
    expect(z.blocks).toEqual([{ len: 7 * 4, nlen: ~(7 * 4) & 0xffff, final: true }])
    expect(z.adler).toBe(adler32(z.raw))
  })
  test('scanlines reconstruct the scaled pixels', () => {
    for (const s of [1, 2, 3]) checkPixels(decode(toPng(small, PAL, s)).z, small, s)
  })
  test('scale below 1 is treated as 1', () => {
    for (const s of [0, -2, 0.5]) {
      const d = decode(toPng(small, PAL, s))
      expect([d.width, d.height]).toEqual([3, 2])
      checkPixels(d.z, small, 1)
    }
  })
  test('a large frame splits into several 65535-byte stored blocks', () => {
    const w = 200
    const h = 200
    const f = frameOf(w, h, Array.from({ length: w * h }, (_, i) => (i * 7 + (i >> 5)) % 4))
    const d = decode(toPng(f, PAL, 2))
    const total = (400 + 1) * 400
    expect([d.width, d.height]).toEqual([400, 400])
    for (const c of d.list) expect(c.crcOk).toBe(true)
    expect(d.z.blocks.map(b => b.len)).toEqual([65535, 65535, total - 2 * 65535])
    expect(d.z.blocks.map(b => b.final)).toEqual([false, false, true])
    for (const b of d.z.blocks) expect(b.nlen).toBe(~b.len & 0xffff)
    expect(d.z.adler).toBe(adler32(d.z.raw))
    checkPixels(d.z, f, 2)
  })
  test('does not mutate the frame or palette', () => {
    const f = frameOf(2, 2, [1, 2, 3, 0])
    const pal = [...PAL]
    toPng(f, pal, 2)
    toCells(f, pal, 2)
    expect([...f.pixels]).toEqual([1, 2, 3, 0])
    expect(pal).toEqual(PAL)
  })
})
