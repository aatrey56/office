import type { Art, TileMap } from '../../types'

// The office map, its tiles, and the crew sprites, authored as string grids.
// CONTRACT STUB: filled in by the art builder once the drawing test fixes the tile size.
// All characters are original designs.

// Rows of single characters, each a key of `key` → palette index; '.' is index 0.
export function bitmapOf(rows: string[], key: Record<string, number>): { width: number; height: number; pixels: Uint8Array } {
  throw new Error('not implemented')
}

export function officeArt(tileSize: 8 | 16): Art {
  throw new Error('not implemented')
}

export function officeMap(tileSize: 8 | 16): TileMap {
  throw new Error('not implemented')
}
