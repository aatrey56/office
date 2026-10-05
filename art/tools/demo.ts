// The README's animated preview: the mod's own scene code, driven by a scripted day.
// An empty office; six sessions come in through the door one after another and walk to their
// rooms; everyone settles (typing, music, thinking, a blinking "!"); then one idle session gets
// up and goes to a computer. Frames go to out/demo/, the GIF and a still to ../docs/.
//   bun tools/demo.ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Actor, Crew, SessionCard } from '../../mod/types'
import { officeArt, officeMap } from '../../mod/hooks/scene/art'
import { toPng } from '../../mod/hooks/scene/encode'
import { assignSeats, deriveCrew, distinctLooks } from '../../mod/hooks/scene/model'
import { isSettled, stepActors } from '../../mod/hooks/scene/motion'
import { paintFrame } from '../../mod/hooks/scene/paint'

const FPS = 10
const STEP_PX = 4 // the plugin's walking pace: a 16 px cell in 4 frames
const SCALE = 3
const CWD = '/demo'
const ROOT = new URL('../', import.meta.url).pathname
const FRAMES_DIR = join(ROOT, 'out/demo')
const DOCS = join(ROOT, '../docs')
const FFMPEG = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg'

type Status = 'busy' | 'idle' | 'waiting'
type Cast = { at: number; name: string; status: Status; activity?: SessionCard['activity'] }

// Who walks in, and on which frame: the longest walks first, so everyone sits at about the same time.
const cast: Cast[] = [
  { at: 2, name: 'api-server', status: 'busy', activity: 'coding' },
  { at: 6, name: 'lunch-break', status: 'idle' },
  { at: 10, name: 'frontend', status: 'busy', activity: 'coding' },
  { at: 14, name: 'docs-fix', status: 'idle' },
  { at: 18, name: 'pr-review', status: 'busy', activity: 'reviewing' },
  { at: 22, name: 'migrations', status: 'waiting' },
  { at: 26, name: 'design-doc', status: 'busy', activity: 'planning' },
]
const CHANGER = 1 // 'lunch-break' gets a task and walks to the free computer...
const HOLD = 14 // ...this many frames after everyone has sat down
const TAIL = 8 // frames kept after it sits again
const MAX_FRAMES = 160

const card = (c: Cast, i: number): SessionCard => ({
  pid: 1000 + i,
  sessionId: `demo-${i}-${c.name}`,
  name: c.name,
  cwd: CWD,
  status: c.status,
  kind: 'interactive',
  updatedAt: 0,
  isSelf: i === 0,
  ...(c.activity ? { activity: c.activity } : {}),
})

const map = officeMap()
const art = officeArt()
const selectColor = Math.max(1, art.palette.indexOf(0xd64030))

rmSync(FRAMES_DIR, { recursive: true, force: true })
mkdirSync(FRAMES_DIR, { recursive: true })
mkdirSync(DOCS, { recursive: true })

let seated: Crew[] = []
let actors: Actor[] = []
let changeAt = Infinity // set once everyone is seated
let stillSaved = false
let total = MAX_FRAMES
const lastArrival = Math.max(...cast.map(c => c.at))
for (let f = 0; f < total; f++) {
  const cards = cast
    .map((c, i) => (i === CHANGER && f >= changeAt ? { ...c, status: 'busy' as const, activity: 'coding' as const } : c))
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => f >= c.at)
    .map(({ c, i }) => card(c, i))
  const everyone = deriveCrew(cards, [], {}, {}, 0, 0)
  seated = assignSeats(everyone, map, CWD, seated)
  const crew = distinctLooks(seated, art.sprites.length)
  actors = stepActors(actors, crew, map, STEP_PX)
  // Settled: everyone on their seat's pixel (isSettled alone is true while a sitter still sinks in).
  const seatedNow = actors.every(a => {
    const c = crew.find(m => m.id === a.id)
    return !!c && a.x === c.seat.x * map.tileSize + (c.seatDx ?? 0) && a.y === c.seat.y * map.tileSize + (c.seatDy ?? 0)
  })
  const settled = f > lastArrival && actors.length === cast.length && isSettled(actors) && seatedNow
  const frame = paintFrame(map, art, actors, crew, f, null, selectColor)
  const png = Buffer.from(toPng(frame, art.palette, SCALE), 'base64')
  writeFileSync(join(FRAMES_DIR, `${String(f).padStart(4, '0')}.png`), png)
  if (settled && changeAt === Infinity) changeAt = f + HOLD
  // The still: everyone seated, on a frame where the "!" and the thought bubble both show.
  if (settled && f < changeAt && !stillSaved && Math.floor(f / 4) % 2 === 0 && Math.floor(f / 10) % 3 !== 2) {
    writeFileSync(join(DOCS, 'office.png'), png)
    stillSaved = true
  }
  if (settled && f > changeAt && total === MAX_FRAMES) {
    total = f + TAIL
  }
}
if (!stillSaved || total === MAX_FRAMES) throw new Error('the scene never settled: lengthen MAX_FRAMES')

// One palette for the whole clip, nearest-neighbour, no dithering: the pixels stay as painted.
const gif = join(DOCS, 'office-demo.gif')
const ran = Bun.spawnSync([
  FFMPEG, '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FRAMES_DIR, '%04d.png'),
  '-filter_complex', '[0:v]split[a][b];[a]palettegen=reserve_transparent=0:stats_mode=full[p];[b][p]paletteuse=dither=none',
  '-sws_flags', 'neighbor', '-loop', '0', gif,
], { stdout: 'inherit', stderr: 'inherit' })
if (ran.exitCode !== 0) throw new Error(`ffmpeg exited ${ran.exitCode}`)
console.log(`seated at ${changeAt - HOLD}, change at ${changeAt}; ${total} frames (${(total / FPS).toFixed(1)} s) -> ${gif}, still -> ${join(DOCS, 'office.png')}`)
