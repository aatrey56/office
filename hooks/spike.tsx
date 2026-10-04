import type { On, Timer } from 'claude-code'

// THROWAWAY drawing test for the office scene (build-plan.md §5.2). /spike opens a pane that
// shows one test card three ways, so a person can say which is crisp and whether a name-tag
// Button over the picture takes clicks. Delete this file and its line in register.tsx once
// the resolution and click method are decided. Self-contained on purpose: the real encoders
// are scene/encode.ts.

const PANE = 'spike'
const W = 208 // hi-res card, 13 tiles of 16 px
const H = 160
const FRAME_MS = 125

// 16 colors, 0x00RRGGBB.
const PALETTE = [
  0x1b1f2a, 0xf4f1e8, 0xc9c2ad, 0x8b8572, 0x4b4a45, 0xe0533d, 0xf2a03d, 0xf7d95c,
  0x6cc24a, 0x2f8f6b, 0x3fa7d6, 0x3a5fcd, 0x7a4fc9, 0xd96bb0, 0x8a5a3c, 0x2b2b33,
]

let view: 'cells' | 'png1' | 'png4' = 'cells'
let clicks = 0
let blits = 0 // frames the surface took since `since`
let fps = 0
let since = 0
let tick = 0
let timer: Timer | undefined

// The card: a floor of two-pixel checks, 16 color bars, one-pixel line work (the sharpness
// probe), and three plain block figures at 16 px. `shift` slides a marker so motion shows.
function card(shift: number): Uint8Array {
  const px = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c = ((x >> 1) + (y >> 1)) % 2 ? 2 : 3
      if (y < 16) c = Math.floor(x / (W / 16)) // color bars
      else if (y < 32) c = (x + y) % 2 ? 1 : 0 // one-pixel checkerboard
      else if (y < 40) c = x % 4 === 0 ? 1 : 0 // one-pixel vertical lines
      if (x === y || x === W - 1 - y) c = 5 // diagonals
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) c = 7
      px[y * W + x] = c
    }
  }
  // Block figures: a head and a body, in three colors, standing on a row of tiles.
  const figure = (left: number, top: number, shirt: number) => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const head = y >= 1 && y < 7 && x >= 4 && x < 12
        const body = y >= 7 && y < 13 && x >= 3 && x < 13
        const legs = y >= 13 && (x === 5 || x === 6 || x === 9 || x === 10)
        const eye = y === 4 && (x === 6 || x === 9)
        const c = eye ? 0 : head ? 6 : body ? shirt : legs ? 15 : -1
        if (c >= 0) px[(top + y) * W + left + x] = c
      }
    }
  }
  figure(32, 64, 10)
  figure(96, 64, 8)
  figure(160, 64, 13)
  // The moving marker: an 8 px square crossing under the figures.
  const mx = (shift * 4) % (W - 8)
  for (let y = 100; y < 108; y++) for (let x = mx; x < mx + 8; x++) px[y * W + x] = 5
  return px
}

function base64(bytes: Uint8Array): string {
  return (bytes as Uint8Array & { toBase64(): string }).toBase64()
}

// Raster cells: the card halved (nearest), one cell per two stacked pixels.
function toCells(px: Uint8Array): { cells: string; columns: number; rows: number } {
  const columns = W / 2
  const rows = H / 4
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const top = PALETTE[px[r * 4 * W + c * 2] ?? 0] ?? 0
      const bottom = PALETTE[px[(r * 4 + 2) * W + c * 2] ?? 0] ?? 0
      const i = (r * columns + c) * 3
      words[i] = 0x2580
      words[i + 1] = top
      words[i + 2] = bottom
    }
  }
  return { cells: base64(new Uint8Array(words.buffer)), columns, rows }
}

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = (CRC[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view32 = new DataView(out.buffer)
  view32.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view32.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

// An indexed PNG with stored (uncompressed) deflate blocks, each pixel repeated `scale` times.
function toPng(px: Uint8Array, scale: number): string {
  const w = W * scale
  const h = H * scale
  const raw = new Uint8Array(h * (w + 1))
  for (let y = 0; y < h; y++) {
    const row = y * (w + 1)
    const sy = Math.floor(y / scale) * W
    for (let x = 0; x < w; x++) raw[row + 1 + x] = px[sy + Math.floor(x / scale)] ?? 0
  }
  const blocks = Math.ceil(raw.length / 65535)
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  z[0] = 0x78
  z[1] = 0x01
  let at = 2
  let a = 1
  let b = 0
  for (let i = 0; i < raw.length; i++) {
    a = (a + (raw[i] ?? 0)) % 65521
    b = (b + a) % 65521
  }
  for (let i = 0; i < blocks; i++) {
    const part = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535))
    z[at++] = i === blocks - 1 ? 1 : 0
    z[at++] = part.length & 0xff
    z[at++] = part.length >>> 8
    z[at++] = ~part.length & 0xff
    z[at++] = (~part.length >>> 8) & 0xff
    z.set(part, at)
    at += part.length
  }
  new DataView(z.buffer).setUint32(at, ((b << 16) | a) >>> 0)

  const ihdr = new Uint8Array(13)
  const head = new DataView(ihdr.buffer)
  head.setUint32(0, w)
  head.setUint32(4, h)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 3 // indexed color
  const plte = new Uint8Array(PALETTE.length * 3)
  PALETTE.forEach((c, i) => {
    plte[i * 3] = c >>> 16
    plte[i * 3 + 1] = (c >>> 8) & 0xff
    plte[i * 3 + 2] = c & 0xff
  })
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return base64(out)
}

export function installSpike(on: On) {
  // A matcher of its own: the other features hook session.start too, and a repeat throws.
  on('session.start', { cwd: /./ }, async ($, e, next) => {
    await $.command.register({ name: 'spike', description: 'Office scene drawing test (temporary)', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'spike' }, async $ => {
    view = 'cells'
    clicks = 0
    const opened = await $.ui.open({ id: PANE, title: 'Drawing test', focus: true, closeOnEscape: true, columns: 112 })
    return { text: opened.isPlaced ? 'Drawing test open. Keys: 1 cells, 2 picture, 3 picture x4. Click the [tag] button. Esc closes.' : `Drawing test waits: ${opened.reason}` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Raster = 'Raster' in els ? els.Raster : undefined
    const Image = 'Image' in els ? els.Image : undefined
    const show = (next: typeof view) => () => {
      view = next
      void $.ui.invalidate('ui.render')
    }

    // One timer for the pane's life: repaint the cells with the marker moved, count the
    // frames the surface took, and redraw the fps line once a second.
    if (!timer) {
      since = await $.clock.now()
      timer = $.clock.every(FRAME_MS, async () => {
        tick++
        if (view === 'cells') {
          const sent = await $.ui.blit({ requestId: PANE, key: 'card', cells: toCells(card(tick)).cells })
          if (!('deny' in sent && sent.deny)) blits++
        }
        const now = await $.clock.now()
        if (now - since >= 1000) {
          fps = Math.round((blits * 1000) / (now - since))
          blits = 0
          since = now
          void $.ui.invalidate('ui.render')
        }
      })
    }

    const still = card(0)
    const cells = toCells(still)
    // The picture box keeps the card's shape: 104 columns wide, and as tall as 208:160 needs
    // on cells about 2.14 times taller than wide.
    const pictureRows = Math.round((104 * H) / W / 2.14)

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Button plain autoFocus key="v1" label="cells" hotkey="1" onPress={show('cells')} />
          <Button plain key="v2" label="picture" hotkey="2" onPress={show('png1')} />
          <Button plain key="v3" label="picture x4" hotkey="3" onPress={show('png4')} />
          <Text dimColor>
            showing: {view} · tag clicks: {clicks} · {view === 'cells' ? `${fps} frames/s (target ${Math.round(1000 / FRAME_MS)})` : 'still picture'}
          </Text>
        </Box>
        <Box position="relative" flexDirection="column">
          {view === 'cells' && Raster && <Raster key="card" columns={cells.columns} rows={cells.rows} cells={cells.cells} />}
          {view === 'cells' && !Raster && <Text dimColor>Raster element unavailable on this surface</Text>}
          {view !== 'cells' && Image && (
            <Image key="pic" source={{ png: toPng(still, view === 'png4' ? 4 : 1) }} columns={104} rows={pictureRows} alt="(no picture here: this session cannot draw images; run it directly in Ghostty)" />
          )}
          {view !== 'cells' && !Image && <Text dimColor>Image element unavailable on this surface</Text>}
          <Box position="absolute" top={Math.round((view === 'cells' ? cells.rows : pictureRows) * 0.52)} left={14}>
            <Button
              plain
              key="tag"
              label="[tag]"
              onPress={() => {
                clicks++
                void $.ui.invalidate('ui.render')
              }}
            />
          </Box>
        </Box>
        <Text dimColor>Look for: sharp one-pixel lines near the top, square figure edges, a red square moving smoothly, and the [tag] sitting on top of the picture.</Text>
      </Box>
    )
  })
}
