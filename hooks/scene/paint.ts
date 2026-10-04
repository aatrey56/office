import type { Actor, Art, Crew, Frame, TileMap } from '../../types'

// Draws one frame. Pure: map, art and actors in, palette indices out.
// CONTRACT STUB: signatures are fixed; the bodies are the paint builder's.

// An empty frame filled with palette index `fill`.
export function newFrame(width: number, height: number, fill: number): Frame {
  throw new Error('not implemented')
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
  throw new Error('not implemented')
}
