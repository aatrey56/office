import type { Frame } from '../../types'

// Turns a frame into what the terminal elements take. Pure.

const HALF_BLOCK = 0x2580
const STORED_MAX = 65535 // a stored deflate block's LEN is a u16

// The runtime has Uint8Array.prototype.toBase64; lib es2023 does not type it yet.
function base64(bytes: Uint8Array): string {
  return (bytes as Uint8Array & { toBase64(): string }).toBase64()
}

function colorOf(palette: number[], index: number): number {
  return (palette[index] ?? 0) & 0xffffff
}

// Nearest-pixel halving: the top-left pixel of each 2x2 block; an odd last row/column is dropped.
function halve(frame: Frame): Frame {
  const width = Math.floor(frame.width / 2)
  const height = Math.floor(frame.height / 2)
  const pixels = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels[y * width + x] = frame.pixels[2 * y * frame.width + 2 * x] ?? 0
  }
  return { width, height, pixels }
}

// For Raster: half-block cells, one cell per two stacked pixels (glyph U+2580, foreground the
// top pixel, background the bottom). `shrink` 2 halves the frame first (nearest pixel).
// `cells` is the base64 of columns * rows little-endian u32 triplets [codePoint, fg, bg],
// colors 0x00RRGGBB, as RasterProps.cells documents.
export function toCells(frame: Frame, palette: number[], shrink: 1 | 2): { cells: string; columns: number; rows: number } {
  const f = shrink === 2 ? halve(frame) : frame
  const columns = f.width
  const rows = Math.ceil(f.height / 2)
  const buffer = new ArrayBuffer(columns * rows * 12)
  const view = new DataView(buffer)
  let at = 0
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < columns; x++) {
      const top = f.pixels[2 * r * f.width + x] ?? 0
      // An odd last row has no bottom pixel: repeat the top so the cell is one solid color.
      const bottom = 2 * r + 1 < f.height ? (f.pixels[(2 * r + 1) * f.width + x] ?? 0) : top
      view.setUint32(at, HALF_BLOCK, true)
      view.setUint32(at + 4, colorOf(palette, top), true)
      view.setUint32(at + 8, colorOf(palette, bottom), true)
      at += 12
    }
  }
  return { cells: base64(new Uint8Array(buffer)), columns, rows }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

// length (u32 BE), type, data, CRC-32 over type + data.
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

// A zlib stream of stored deflate blocks: no compressor needed, still a valid IDAT.
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / STORED_MAX))
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4)
  const view = new DataView(out.buffer)
  out[0] = 0x78
  out[1] = 0x01
  let at = 2
  for (let i = 0; i < blocks; i++) {
    const part = raw.subarray(i * STORED_MAX, (i + 1) * STORED_MAX)
    out[at] = i === blocks - 1 ? 1 : 0 // BFINAL, BTYPE 00
    view.setUint16(at + 1, part.length, true)
    view.setUint16(at + 3, ~part.length & 0xffff, true)
    out.set(part, at + 5)
    at += 5 + part.length
  }
  view.setUint32(at, adler32(raw))
  return out
}

// Fixed-Huffman deflate (RFC 1951, BTYPE 01) with the two matches pixel art enlarged by a whole
// number is made of: a run of one byte (distance 1) and a copy of the line above (distance = stride).
// A 1536 x 1280 office frame shrinks from about 2 MB stored to a few tens of KB.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const MAX_MATCH = 258

class BitWriter {
  bytes: number[] = []
  private acc = 0
  private n = 0
  // `count` low bits of `value`, least significant first (deflate's order for extra bits and headers).
  bits(value: number, count: number) {
    for (let i = 0; i < count; i++) {
      this.acc |= ((value >>> i) & 1) << this.n
      if (++this.n === 8) {
        this.bytes.push(this.acc)
        this.acc = 0
        this.n = 0
      }
    }
  }
  // A Huffman code goes most significant bit first.
  code(value: number, count: number) {
    for (let i = count - 1; i >= 0; i--) this.bits((value >>> i) & 1, 1)
  }
  flush(): number[] {
    if (this.n > 0) this.bytes.push(this.acc)
    this.acc = 0
    this.n = 0
    return this.bytes
  }
}

function literal(w: BitWriter, sym: number) {
  if (sym < 144) w.code(0x30 + sym, 8)
  else if (sym < 256) w.code(0x190 + sym - 144, 9)
  else if (sym < 280) w.code(sym - 256, 7)
  else w.code(0xc0 + sym - 280, 8)
}

function match(w: BitWriter, length: number, distance: number) {
  let li = LEN_BASE.length - 1
  while ((LEN_BASE[li] ?? 0) > length) li--
  literal(w, 257 + li)
  w.bits(length - (LEN_BASE[li] ?? 0), LEN_EXTRA[li] ?? 0)
  let di = DIST_BASE.length - 1
  while ((DIST_BASE[di] ?? 0) > distance) di--
  w.code(di, 5)
  w.bits(distance - (DIST_BASE[di] ?? 0), DIST_EXTRA[di] ?? 0)
}

// How many bytes from `at` repeat the bytes `distance` back, up to MAX_MATCH.
function runLength(raw: Uint8Array, at: number, distance: number): number {
  if (at < distance) return 0
  let n = 0
  while (n < MAX_MATCH && at + n < raw.length && raw[at + n] === raw[at + n - distance]) n++
  return n
}

function zlibDeflate(raw: Uint8Array, stride: number): Uint8Array {
  const w = new BitWriter()
  w.bits(1, 1) // BFINAL
  w.bits(1, 2) // BTYPE 01: fixed Huffman codes
  for (let i = 0; i < raw.length; ) {
    const up = stride <= 32768 ? runLength(raw, i, stride) : 0
    const run = runLength(raw, i, 1)
    if (up >= 3 && up >= run) {
      match(w, up, stride)
      i += up
    } else if (run >= 3) {
      match(w, run, 1)
      i += run
    } else {
      literal(w, raw[i] ?? 0)
      i++
    }
  }
  literal(w, 256) // end of block
  const body = w.flush()
  const out = new Uint8Array(2 + body.length + 4)
  out[0] = 0x78
  out[1] = 0x01
  out.set(body, 2)
  new DataView(out.buffer).setUint32(2 + body.length, adler32(raw))
  return out
}

// For Image: a whole PNG, base64. Indexed color (PLTE from `palette`), each pixel repeated
// `scale` times both ways. No compression library exists here, so IDAT uses stored deflate
// blocks; CRC-32 and Adler-32 are computed in this file.
export function toPng(frame: Frame, palette: number[], scale: number, compress = true): string {
  const s = Math.max(1, Math.floor(scale) || 1)
  const width = frame.width * s
  const height = frame.height * s

  const ihdr = new Uint8Array(13)
  const ih = new DataView(ihdr.buffer)
  ih.setUint32(0, width)
  ih.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 3 // indexed color; bytes 10-12 (compression, filter, interlace) stay 0

  const colors = palette.length > 0 ? palette : [0]
  const plte = new Uint8Array(colors.length * 3)
  colors.forEach((c, i) => {
    plte[i * 3] = (c >>> 16) & 0xff
    plte[i * 3 + 1] = (c >>> 8) & 0xff
    plte[i * 3 + 2] = c & 0xff
  })

  // Each scanline: filter byte 0, then one index per pixel. Repeated rows are copied whole.
  const stride = width + 1
  const raw = new Uint8Array(stride * height)
  for (let y = 0; y < frame.height; y++) {
    const line = raw.subarray(y * s * stride, (y * s + 1) * stride)
    for (let x = 0; x < frame.width; x++) line.fill(frame.pixels[y * frame.width + x] ?? 0, 1 + x * s, 1 + (x + 1) * s)
    for (let k = 1; k < s; k++) raw.set(line, (y * s + k) * stride)
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', compress ? zlibDeflate(raw, stride) : zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    png.set(p, at)
    at += p.length
  }
  return base64(png)
}
