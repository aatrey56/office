import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { Actor, Crew, Job, ManagerEntry, RateWindow, SessionCard } from '../types'
import { budgetLine } from './budget'
import { officeArt, officeMap } from './scene/art'
import { toCells, toPng } from './scene/encode'
import { assignSeats, deriveCrew, projectsOf } from './scene/model'
import { isSettled, stepActors } from './scene/motion'
import { paintFrame } from './scene/paint'

// Owner: scene. The /office pane as a pixel office: every session is a crew member in the room
// for its state, office-spawned workers walk in, report and leave. `t` swaps to the text board
// (board.tsx draws that). The pure parts are in scene/*; the `$` calls live here.

const PANE = 'office'
const FRAME_MS = 100 // 10 frames/s while anyone walks or a bubble blinks; nothing is sent when still
const STEP_PX = 4 // a 16 px cell in 4 frames, about Gold's walking pace
const LINGER_MS = 20_000 // a finished worker is seen reporting, then leaving, for this long
const CELL_W = 9.35 // pixels per terminal cell, as measured in Ghostty; sizes the picture box
const CELL_H = 20

const SESSIONS = atom({ plugin: 'office', key: 'sessions' } as const, [] as SessionCard[])
const JOBS = atom({ plugin: 'office', key: 'jobs' } as const, [] as Job[])
const MANAGERS = atom({ plugin: 'office', key: 'managers' } as const, {} as Record<string, ManagerEntry>)
const VIEW = atom({ plugin: 'office', key: 'officeView' } as const, 'scene' as 'scene' | 'text')
const SELECTED = atom({ plugin: 'office', key: 'sceneSelected' } as const, null as string | null)
const PROJECT = atom({ plugin: 'office', key: 'sceneProject' } as const, null as string | null)
// Bumped when the crew list (names, states) changes, so only the list under the picture redraws.
const TICK = atom({ plugin: 'office', key: 'sceneTick' } as const, 0)

// Not drawn from: the animation's own state. A reload starts the walk over, which is harmless.
let timer: Timer | undefined
let frameNo = 0
let actors: Actor[] = []
let seated: Crew[] = []
let roots: Record<string, string | null> = {}
let listKey = ''
let lastPicture: { png?: string; cells?: string } = {}
let box = { columns: 0, rows: 0, scale: 4, graphics: true }

function graphicsLikely(termProgram?: string, term?: string, kittyWindow?: string): boolean {
  if (kittyWindow) return true
  if (termProgram && /^(ghostty|iTerm\.app|WezTerm|kitty)$/i.test(termProgram)) return true
  return !!term && /kitty|ghostty|wezterm/i.test(term)
}

async function canDrawPictures($: EngineInterface): Promise<boolean> {
  try {
    return graphicsLikely(await $.env.get('TERM_PROGRAM'), await $.env.get('TERM'), await $.env.get('KITTY_WINDOW_ID'))
  } catch {
    return true
  }
}

// Git toplevels, filled in the background: a cwd is its own project until git answers.
async function learnRoots($: EngineInterface, cwds: string[]): Promise<void> {
  for (const cwd of cwds) {
    if (cwd in roots) continue
    roots[cwd] = null
    const ran = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel']).catch(() => undefined)
    roots = { ...roots, [cwd]: ran && ran.exitCode === 0 ? ran.stdout.trim() || null : null }
  }
}

// The project shown: the one picked with [ ], else this session's, else the busiest.
function shownProject(crew: Crew[], picked: string | null): string | null {
  const projects = projectsOf(crew)
  if (picked && projects.includes(picked)) return picked
  return crew.find(c => c.isSelf)?.project ?? projects[0] ?? null
}

async function currentCrew($: EngineInterface): Promise<{ crew: Crew[]; project: string | null; all: string[] }> {
  const cards = await read($, SESSIONS)
  const jobs = await read($, JOBS)
  const managers = await read($, MANAGERS)
  void learnRoots($, [...cards.map(c => c.cwd), ...jobs.map(j => j.cwd)])
  const everyone = deriveCrew(cards, jobs, managers, roots, Date.now(), LINGER_MS)
  const project = shownProject(everyone, await read($, PROJECT))
  if (project === null) return { crew: [], project, all: [] }
  seated = assignSeats(everyone, officeMap(), project, seated)
  return { crew: seated.filter(c => c.project === project), project, all: projectsOf(everyone) }
}

function selectColor(): number {
  const i = officeArt().palette.indexOf(0xd64030)
  return i > 0 ? i : 1
}

// One frame: walk everyone a step, paint, and hand the picture over when it changed.
async function frame($: EngineInterface): Promise<void> {
  const { crew } = await currentCrew($)
  const selected = await read($, SELECTED)
  const wasSettled = isSettled(actors)
  actors = stepActors(actors, crew, officeMap(), STEP_PX)
  frameNo++
  const blinking = crew.some(c => c.state === 'needs-you')
  const key = crew.map(c => `${c.id}:${c.state}:${c.name}`).join('|')
  if (key !== listKey) {
    listKey = key
    await update($, TICK, n => (n + 1) % 1_000_000)
  }
  // Still, nobody blinking, nothing new: send nothing.
  if (wasSettled && isSettled(actors) && !blinking && frameNo > 1 && lastPicture.png !== undefined) return
  paint(crew, selected)
  const sent = box.graphics
    ? await $.ui.blit({ requestId: PANE, key: 'scene', source: { png: lastPicture.png! } }).catch(() => undefined)
    : await $.ui.blit({ requestId: PANE, key: 'scene', cells: lastPicture.cells! }).catch(() => undefined)
  void sent
}

function paint(crew: Crew[], selected: string | null): void {
  const art = officeArt()
  const pixels = paintFrame(officeMap(), art, actors, crew, frameNo, selected, selectColor())
  lastPicture = box.graphics ? { png: toPng(pixels, art.palette, box.scale) } : { cells: toCells(pixels, art.palette, 2).cells }
}

function startTimer($: EngineInterface): void {
  if (timer) return
  timer = $.clock.every(FRAME_MS, () => {
    void frame($)
  })
}

function stopTimer(): void {
  timer?.cancel()
  timer = undefined
}

async function sendTo($: EngineInterface, card: SessionCard, text: string): Promise<void> {
  const body = text.trim()
  if (!body) return
  const self = (await read($, SESSIONS)).find(c => c.isSelf)?.name ?? (await $.session.id()).slice(0, 8)
  const sent = await $.session.send({ to: { sessionId: card.sessionId }, text: `[via office from ${self}] ${body}` })
  $.ui.toast(sent.isDelivered ? `Sent to ${card.name}` : `Not sent to ${card.name}: ${sent.reason}`)
}

const STATE_WORDS: Record<Crew['state'], string> = {
  working: 'working',
  idle: 'idle',
  'needs-you': 'needs you',
  reporting: 'reporting',
  failed: 'failed',
  leaving: 'leaving',
}

export function installScene(on: On) {
  // The text board (board.tsx) passes the pane on with next(e) while the view is the scene;
  // this passes it on while the view is text. Either order of the two hooks draws the right one.
  on('ui.render', { component: 'Pane', requestId: /^office$/ }, async ($, e, next) => {
    if ((await read($, VIEW)) === 'text') {
      stopTimer()
      return next(e)
    }
    try {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Image = 'Image' in ui ? ui.Image : undefined
    const Raster = 'Raster' in ui ? ui.Raster : undefined
    const Input = 'Input' in ui ? ui.Input : undefined
    await read($, TICK)

    const map = officeMap()
    const W = map.width * map.tileSize
    const H = map.height * map.tileSize
    const graphics = Image !== undefined && (await canDrawPictures($))
    // The picture fills the pane's width; its pixels are enlarged by a whole number by us, never
    // by the terminal's smoothing, and the box keeps the office's shape on tall cells.
    const columns = Math.max(24, Math.min(e.props.bodyColumns - 1, 160))
    const rows = Math.max(8, Math.round((columns * CELL_W * H) / W / CELL_H))
    const scale = Math.max(2, Math.min(7, Math.round((columns * CELL_W) / W)))
    const sized = box.columns !== columns || box.rows !== rows || box.graphics !== graphics || box.scale !== scale
    box = { columns, rows, scale, graphics }

    const { crew, project, all } = await currentCrew($)
    const selectedId = await read($, SELECTED)
    if (sized || lastPicture[graphics ? 'png' : 'cells'] === undefined) paint(crew, selectedId)
    startTimer($)

    const cards = await read($, SESSIONS)
    const leads = crew.filter(c => c.isSelectable)
    const picked = leads.find(c => c.id === selectedId)
    const pickedCard = picked && cards.find(c => c.sessionId === picked.id)
    let usage = ''
    try {
      usage = budgetLine((await $.session.usage()).rateLimits as RateWindow[])
    } catch {
      // the header simply goes without it
    }
    const projectName = project ? (project.split('/').pop() ?? project) : 'no sessions'
    const choose = (id: string) => () => update($, SELECTED, prev => (prev === id ? null : id))
    const cycle = (delta: number) => () =>
      update($, PROJECT, prev => {
        if (all.length === 0) return null
        const at = Math.max(0, all.indexOf(prev ?? project ?? ''))
        return all[(at + delta + all.length) % all.length] ?? null
      })

    let picture
    if (graphics && Image) {
      picture = <Image key="scene" source={{ png: lastPicture.png ?? '' }} columns={columns} rows={rows} alt="the office" />
    } else if (Raster) {
      const cells = lastPicture.cells ?? ''
      picture = <Raster key="scene" columns={W / 2} rows={H / 4} cells={cells} />
    } else {
      picture = <Text dimColor>This surface cannot draw the office; press t for the text board.</Text>
    }

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold>{projectName}</Text>
          {usage && <Text dimColor>{usage}</Text>}
          {all.length > 1 && <Button plain key="prev-proj" label="prev office" hotkey="h" onPress={cycle(-1)} />}
          {all.length > 1 && <Button plain key="next-proj" label="next office" hotkey="l" onPress={cycle(1)} />}
          <Button plain key="text" label="text board" hotkey="t" onPress={() => update($, VIEW, () => 'text')} />
          <Button plain key="manga" label="manga" hotkey="b" onPress={() => $.ui.open({ id: 'manga', focus: true })} />
        </Box>
        {picture}
        <Box flexWrap="wrap" columnGap={2}>
          {leads.length === 0 && <Text dimColor>No sessions in this office yet.</Text>}
          {leads.map((c, i) => {
            const label = `${c.id === selectedId ? '›' : ''}${c.name}${c.role === 'manager' ? ' (manager)' : ''} · ${STATE_WORDS[c.state]}`
            return i < 9 ? (
              <Button plain key={`crew:${c.id}`} label={label} hotkey={String(i + 1)} onPress={choose(c.id)} />
            ) : (
              <Button plain key={`crew:${c.id}`} label={label} onPress={choose(c.id)} />
            )
          })}
        </Box>
        {crew.some(c => !c.isSelectable) && (
          <Text dimColor wrap="truncate-end">
            {`workers: ${crew.filter(c => !c.isSelectable).map(c => `${c.name} (${STATE_WORDS[c.state]})`).join(', ')}`}
          </Text>
        )}
        {picked && (
          <Box flexDirection="column">
            <Text wrap="truncate-end">{`${picked.name}: ${picked.tag ?? STATE_WORDS[picked.state]}`}</Text>
            {pickedCard && !pickedCard.isSelf && Input && (
              <Box gap={1}>
                <Button plain key="message" label="message" hotkey="m" onPress={() => $.ui.focus({ requestId: PANE, key: 'msg' })} />
                <Input key="msg" label="> " placeholder={`message ${picked.name}`} submitLabel="send" onSubmit={text => sendTo($, pickedCard, text)} />
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
    } catch (err) {
      // A blank pane tells nobody anything: say what broke, and keep the text board one key away.
      stopTimer()
      $.ui.log(`office: scene failed: ${String(err)}`, { to: 'debug' })
      const { Box, Text, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>{`The office scene hit an error: ${String(err).slice(0, 300)}`}</Text>
          <Button plain key="text" label="text board" hotkey="t" onPress={() => update($, VIEW, () => 'text')} />
        </Box>
      )
    }
  })

  on('ui.close', { id: /^office$/ }, async ($, e, next) => {
    stopTimer()
    actors = []
    lastPicture = {}
    return next(e)
  })
}
