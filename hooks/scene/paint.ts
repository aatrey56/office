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

const BOB_TICKS = 6
const NOTE_TICKS = 8

// What a settled crew member is quietly doing: idle ones listen to music (a note drifting up beside
// the head, two notes taking turns), planners at the whiteboard think (a thought bubble, now and then).
function ambient(frame: Frame, art: Art, member: Crew, sx: number, sy: number, width: number, tick: number): void {
  if (member.state === 'idle' && art.bubbles.music.length > 0) {
    const n = Math.floor(tick / NOTE_TICKS)
    const note = art.bubbles.music[n % art.bubbles.music.length]
    if (note) blit(frame, note, sx + width - 2, sy - note.height - (n % 3), false, false)
  } else if (member.state === 'working' && member.activity === 'planning' && Math.floor(tick / 10) % 3 !== 2) {
    const t = art.bubbles.thinking
    blit(frame, t, sx + Math.floor((width - t.width) / 2), sy - t.height, false, false)
  }
}

const SEAT_Z = 24 // an arrived seatZ sitter sorts this many rows lower, so it draws over its seat

// Painter's order: opaque tiles, then floor props (rugs) in array order, then every other prop and
// every actor sorted by bottom pixel row (actors win ties; a seated seatZ crew member counts
// SEAT_Z rows lower), then bubbles and the selection outline over everything.
// Each actor gets its pose for its state and step (walking: walk1/walk2 alternating; arrived:
// sit / type / stand by crew state); a bubble shows above needs-you and failed crew, blinking on
// `tick`. The selected crew member gets a one-pixel outline in `selectColor`.
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
  for (const prop of art.props) if (prop.floor) blit(frame, prop.bitmap, prop.x, prop.y, false, false)

  // Where each actor's sprite lands, kept for the overlay pass.
  type Placed = { member: Crew | undefined; sprite: Bitmap; sx: number; sy: number; isSettled: boolean }
  type Item = { key: number; order: number; draw: () => void }
  const items: Item[] = []
  const placed: Placed[] = []
  art.props.forEach((prop, i) => {
    if (!prop.floor) items.push({ key: prop.sortY, order: i, draw: () => blit(frame, prop.bitmap, prop.x, prop.y, false, false) })
  })

  const byId = new Map(crew.map(c => [c.id, c]))
  const looks = art.sprites.length
  actors.forEach((actor, i) => {
    if (looks === 0) return
    const member = byId.get(actor.id)
    const look = (((member?.look ?? 0) % looks) + looks) % looks
    const sprite = art.sprites[look]?.[actor.facing]?.[poseFor(actor, member, tick)]
    if (!sprite) return
    // Centered across the tile, bottom edge on the tile's bottom; a tall sprite pokes up.
    // Someone at work and settled bobs a pixel now and then: typing, writing, reading.
    const isSettled = actor.path.length === 0 && member !== undefined
    const bob = isSettled && member.state === 'working' && Math.floor(tick / BOB_TICKS) % 2 === 1 ? 1 : 0
    const sx = actor.x + Math.floor((ts - sprite.width) / 2)
    const sy = actor.y + ts - sprite.height + bob
    const isOnSeat = isSettled && member.seatZ === true && isAtSeat(actor, member, ts)
    const key = sy - bob + sprite.height - 1 + 0.5 + (isOnSeat ? SEAT_Z : 0) // the bob never re-sorts
    placed.push({ member, sprite, sx, sy, isSettled })
    items.push({ key, order: art.props.length + i, draw: () => blit(frame, sprite, sx, sy, false, false) })
  })

  items.sort((a, b) => a.key - b.key || a.order - b.order)
  for (const item of items) item.draw()

  for (const { member, sprite, sx, sy, isSettled } of placed) {
    if (member && member.id === selectedId) outline(frame, sprite, sx, sy, false, selectColor)
    const bubble =
      member?.state === 'failed'
        ? art.bubbles.failed
        : member?.state === 'needs-you' && Math.floor(tick / BLINK_TICKS) % 2 === 0
          ? art.bubbles.needsYou
          : undefined
    if (bubble) blit(frame, bubble, sx + Math.floor((sprite.width - bubble.width) / 2), sy - bubble.height, false, false)
    else if (isSettled && member) ambient(frame, art, member, sx, sy, sprite.width, tick)
  }
  return frame
}

// True when the actor stands on its crew's seat pixel (the seat's cell nudged by dx / dy).
function isAtSeat(actor: Actor, member: Crew, ts: number): boolean {
  return actor.x === member.seat.x * ts + (member.seatDx ?? 0) && actor.y === member.seat.y * ts + (member.seatDy ?? 0)
}
