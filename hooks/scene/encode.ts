import type { Frame } from '../../types'

// Turns a frame into what the terminal elements take. Pure.
// CONTRACT STUB: signatures are fixed; the bodies are the paint builder's.

// For Raster: half-block cells, one cell per two stacked pixels (glyph U+2580, foreground the
// top pixel, background the bottom). `shrink` 2 halves the frame first (nearest pixel).
// `cells` is the base64 of columns * rows little-endian u32 triplets [codePoint, fg, bg],
// colors 0x00RRGGBB, as RasterProps.cells documents.
export function toCells(frame: Frame, palette: number[], shrink: 1 | 2): { cells: string; columns: number; rows: number } {
  throw new Error('not implemented')
}

// For Image: a whole PNG, base64. Indexed color (PLTE from `palette`), each pixel repeated
// `scale` times both ways. No compression library exists here, so IDAT uses stored deflate
// blocks; CRC-32 and Adler-32 are computed in this file.
export function toPng(frame: Frame, palette: number[], scale: number): string {
  throw new Error('not implemented')
}
