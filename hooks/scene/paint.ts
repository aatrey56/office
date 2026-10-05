import type { Actor, Art, Bitmap, Crew, Frame, SpritePose, TileMap } from '../../types'

// Draws one frame. Pure: map, art and actors in, palette indices out.

const BLINK_TICKS = 4 // the needs-you bubble and the typing hands flip every 4 ticks

// An empty frame filled with palette index `fill`.
export function newFrame(width: number, height: number, fill: number): Frame {
  const w = Math.max(0, Math.floor(width))
  const h = Math.max(0, Math.floor(height))
  return { width: w, height: h, pixels: new Uint8Array(w * h).fill(fill) }
}

// Walking beats everything; a crew-less actor (a worker on its way out) still walks.
export function poseFor(actor: Actor, crew: Crew | undefined, tick: number): SpritePose {
  const walk: SpritePose = actor.step % 2 === 0 ? 'walk1' : 'walk2'
  if (actor.path.length > 0 || !crew) return walk
  if (crew.state === 'working') return Math.floor(tick / BLINK_TICKS) % 2 === 0 ? 'type' : 'sit'
  if (crew.state === 'idle') return 'sit'
  return 'stand'
}

// Copies a bitmap onto the frame at (x, y), clipped. Index 0 is skipped unless opaque.
function blit(frame: Frame, bmp: Bitmap, x: number, y: number, opaque: boolean, mirror: boolean): void {
  for (let row = 0; row < bmp.height; row++) {
    const fy = y + row
    if (fy < 0 || fy >= frame.height) continue
    for (let col = 0; col < bmp.width; col++) {
      const fx = x + col
      if (fx < 0 || fx >= frame.width) continue
      const src = mirror ? bmp.width - 1 - col : col
      const p = bmp.pixels[row * bmp.width + src] ?? 0
      if (p === 0 && !opaque) continue
      frame.pixels[fy * frame.width + fx] = p
    }
  }
}

// Paints `color` on every pixel orthogonally next to the sprite's silhouette but not in it.
function outline(frame: Frame, bmp: Bitmap, x: number, y: number, mirror: boolean, color: number): void {
  const solid = (col: number, row: number): boolean => {
    if (col < 0 || row < 0 || col >= bmp.width || row >= bmp.height) return false
    const src = mirror ? bmp.width - 1 - col : col
    return (bmp.pixels[row * bmp.width + src] ?? 0) !== 0
  }
  for (let row = -1; row <= bmp.height; row++) {
    const fy = y + row
    if (fy < 0 || fy >= frame.height) continue
    for (let col = -1; col <= bmp.width; col++) {
      const fx = x + col
      if (fx < 0 || fx >= frame.width) continue
      if (solid(col, row)) continue
      if (solid(col - 1, row) || solid(col + 1, row) || solid(col, row - 1) || solid(col, row + 1)) {
        frame.pixels[fy * frame.width + fx] = color
      }
    }
  }
}

// Tiles first, then actors in the order given, each with its pose for its state and step
// (walking: walk1/walk2 alternating; arrived: sit / type / stand by crew state), mirrored
// when facing left, then a bubble above needs-you and failed crew, blinking on `tick`.
// The selected crew member gets a one-pixel outline in `selectColor`.
export function paintFrame(
  map: TileMap,
  art: Art,
  actors: Actor[],
  crew: Crew[],
  tick: number,
  selectedId: string | null,
  selectColor: number,
): Frame {
  const ts = map.tileSize
  const frame = newFrame(map.width * ts, map.height * ts, 0)

  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      const bmp = art.tiles[map.tiles[ty * map.width + tx] ?? -1]
      if (bmp) blit(frame, bmp, tx * ts, ty * ts, true, false)
    }
  }

  const byId = new Map(crew.map(c => [c.id, c]))
  const looks = art.sprites.length
  for (const actor of actors) {
    if (looks === 0) break
    const member = byId.get(actor.id)
    const look = (((member?.look ?? 0) % looks) + looks) % looks
    const sprite = art.sprites[look]?.[actor.facing]?.[poseFor(actor, member, tick)]
    if (!sprite) continue
    // Centered across the tile, bottom edge on the tile's bottom; a tall sprite pokes up.
    const sx = actor.x + Math.floor((ts - sprite.width) / 2)
    const sy = actor.y + ts - sprite.height
    const mirror = false // every facing has its own frames
    blit(frame, sprite, sx, sy, false, mirror)
    if (member && member.id === selectedId) outline(frame, sprite, sx, sy, mirror, selectColor)

    const bubble =
      member?.state === 'failed'
        ? art.bubbles.failed
        : member?.state === 'needs-you' && Math.floor(tick / BLINK_TICKS) % 2 === 0
          ? art.bubbles.needsYou
          : undefined
    if (bubble) blit(frame, bubble, sx + Math.floor((sprite.width - bubble.width) / 2), sy - bubble.height, false, false)
  }
  return frame
}
