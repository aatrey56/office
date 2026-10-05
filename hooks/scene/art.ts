import type { Art, Bitmap, Facing, RoomId, Seat, SpritePose, TileMap } from '../../types'
import { ART_DATA } from './art-data'

// The office map, its tiles, and the crew sprites. The pixels are made in ~/Coding/office-art
// (tools/export.ts writes art-data.ts); this file only turns them into the scene's types.

const fromBase64 = (s: string): Uint8Array => (Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(s)

// Rows of single characters, each a key of `key` → palette index; '.' is index 0.
export function bitmapOf(rows: string[], key: Record<string, number>): Bitmap {
  const width = rows[0]?.length ?? 0
  const pixels = new Uint8Array(width * rows.length)
  rows.forEach((row, y) => [...row].forEach((ch, x) => (pixels[y * width + x] = ch === '.' ? 0 : (key[ch] ?? 0))))
  return { width, height: rows.length, pixels }
}

const square = (b64: string): Bitmap => ({ width: ART_DATA.tileSize, height: ART_DATA.tileSize, pixels: fromBase64(b64) })
const sprite = (b64: string): Bitmap => ({ width: 16, height: 16, pixels: fromBase64(b64) })

// Decoded once: the scene asks for the art on every frame.
let art: Art | undefined
let map: TileMap | undefined

// Only the 16 px art exists; the background-session fallback halves the frame instead (encode.ts).
export function officeArt(_tileSize: 8 | 16 = 16): Art {
  if (art) return art
  const poses = (p: Record<SpritePose, string>): Record<SpritePose, Bitmap> => ({
    stand: sprite(p.stand),
    walk1: sprite(p.walk1),
    walk2: sprite(p.walk2),
    sit: sprite(p.sit),
    type: sprite(p.type),
  })
  const b = (x: { width: number; height: number; pixels: string }): Bitmap => ({ width: x.width, height: x.height, pixels: fromBase64(x.pixels) })
  art = {
    palette: [...ART_DATA.palette],
    tiles: ART_DATA.tiles.map(square),
    sprites: ART_DATA.sprites.map(look => {
      const out = {} as Record<Facing, Record<SpritePose, Bitmap>>
      for (const facing of ['up', 'down', 'left', 'right'] as const) out[facing] = poses(look[facing])
      return out
    }),
    bubbles: { needsYou: b(ART_DATA.bubbles.needsYou), failed: b(ART_DATA.bubbles.failed) },
  }
  return art
}

export function officeMap(_tileSize: 8 | 16 = 16): TileMap {
  if (map) return map
  map = {
    width: ART_DATA.width,
    height: ART_DATA.height,
    tileSize: ART_DATA.tileSize,
    tiles: [...ART_DATA.map],
    walkable: [...ART_DATA.walkable],
    seats: ART_DATA.seats.map(s => ({ room: s.room as RoomId, at: { ...s.at }, facing: s.facing as Facing }) satisfies Seat),
    door: { ...ART_DATA.door },
  }
  return map
}

// How many distinct crew looks the art has, for lookOf().
export const LOOKS = ART_DATA.sprites.length
