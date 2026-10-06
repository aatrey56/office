import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { Actor, AgentRecord, ChatLine, Crew, Job, MangaShelf, ManagerEntry, RateWindow, SessionCard } from '../types'
import { freshAgentFiles, parseAgent, subagentsDir } from './agents'
import type { AgentFile } from './agents'
import { budgetLine } from './budget'
import { chatLines, projectSlug, SLUG_MAX } from './sessions'
import { officeArt, officeMap } from './scene/art'
import { toCells, toPng } from './scene/encode'
import { assignSeats, deriveCrew, distinctLooks, projectsOf } from './scene/model'
import { isSettled, stepActors } from './scene/motion'
import { paintFrame } from './scene/paint'
import { projectRootArgv, repoRootFromCommonDir } from './worktree'

// Owner: scene. The /office pane as a pixel office: every session is a crew member in the room
// for its state, office-spawned workers walk in, report and leave. `t` swaps to the text board
// (board.tsx draws that). The pure parts are in scene/*; the `$` calls live here.

const PANE = 'office'
const FRAME_MS = 100 // 10 frames/s while anyone walks or a bubble blinks; nothing is sent when still
const STEP_PX = 4 // a 16 px cell in 4 frames, about Gold's walking pace
const LINGER_MS = 20_000 // a finished worker is seen reporting, then leaving, for this long
const AGENT_SCAN_MS = 2000 // how often the live sessions' subagent folders are looked at
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
// The reader's series, so the manga tab opened from here is titled like /manga titles it.
const SHELF = atom({ plugin: 'office', key: 'shelf' } as const, { series: '', chapters: [], pages: [], dir: '', ready: [], loading: false } as MangaShelf)

// Not drawn from: the animation's own state. A reload starts the walk over, which is harmless.
let timer: Timer | undefined
let lastFrameAt = 0
let blitRefused = '' // why the engine last refused a frame swap, shown under the picture
// The chat window: the selected session's conversation, read again only when its transcript changes.
// Screenshots and tool output make transcript lines huge, so a byte tail holds little talk. This reader
// scans the last 20 MB, drops tool results and image data before parsing, and prints only the
// conversation rows (the last 400) for chatLines() to read.
const CHAT_READER = [
  'import sys,json,collections',
  'keep=collections.deque(maxlen=400)',
  'with open(sys.argv[1],"rb") as f:',
  ' f.seek(0,2); f.seek(max(0,f.tell()-20000000))',
  ' if f.tell(): f.readline()',
  ' for raw in f:',
  '  if b\'"tool_result"\' in raw or not (b\'"type":"user"\' in raw or b\'"type":"assistant"\' in raw): continue',
  '  try: r=json.loads(raw)',
  '  except Exception: continue',
  '  c=(r.get("message") or {}).get("content")',
  '  if isinstance(c,list):',
  '   c=[b if b.get("type")=="text" else {"type":"image"} for b in c if isinstance(b,dict) and b.get("type") in ("text","image")]',
  '   if not c: continue',
  '  keep.append(json.dumps({"type":r.get("type"),"isMeta":r.get("isMeta",False),"message":{"content":c}}))',
  'print("\\n".join(keep))',
].join('\n')
let chat: { id: string; mtimeMs: number; lines: ChatLine[] } | undefined
let chatScroll = 0 // messages hidden below the window, 0 = newest at the bottom

async function chatOf($: EngineInterface, card: SessionCard): Promise<ChatLine[]> {
  try {
    const root = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
    const slug = projectSlug(card.cwd)
    if (slug.length > SLUG_MAX) return chat?.id === card.sessionId ? chat.lines : []
    const path = `${root}/projects/${slug}/${card.sessionId}.jsonl`
    const stat = await $.fs.stat(path)
    if (chat && chat.id === card.sessionId && chat.mtimeMs === stat.mtimeMs) return chat.lines
    const ran = await $.process.run(['python3', '-c', CHAT_READER, path], { timeoutMs: 10_000 })
    chat = { id: card.sessionId, mtimeMs: stat.mtimeMs, lines: chatLines(ran.stdout) }
    return chat.lines
  } catch {
    return chat?.id === card.sessionId ? chat.lines : []
  }
}

// The newest messages that fit `rows` lines of `columns`, `skip` newest ones left out (scrolling up).
function chatWindow(lines: ChatLine[], rows: number, columns: number, skip: number): ChatLine[] {
  const shown: ChatLine[] = []
  let used = 0
  for (let i = lines.length - 1 - skip; i >= 0; i--) {
    const line = lines[i]!
    const height = line.text.split('\n').reduce((n, part) => n + Math.max(1, Math.ceil((part.length + 8) / columns)), 0)
    if (used + height > rows && shown.length > 0) break
    shown.unshift(line)
    used += height
  }
  return shown
}

// The `d` line: proof of life for the animation, to tell a stopped timer from frames that never show.
let debug = false
let stats = { painted: 0, swapped: 0, last: '' }
let frameNo = 0
let actors: Actor[] = []
let seated: Crew[] = []
let roots: Record<string, string | null> = {}
let listKey = ''
let lastPicture: { png?: string; cells?: string; file?: string; generation?: number } = {}
// Frames go to two files taken in turn and are shown by path with a rising `generation`: the
// documented way to tell the terminal that new content sits under a known name. Inline PNGs of
// one size and palette were accepted ("ok") yet never replaced on screen.
let frameDir: string | undefined
let fileFrames = true // false once writing a frame fails; inline PNGs from then on
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

// Project roots, filled in the background: a cwd is its own project until git answers. A
// worktree counts as its main repo; the plain toplevel when that answer is missing.
async function learnRoots($: EngineInterface, cwds: string[]): Promise<void> {
  for (const cwd of cwds) {
    if (cwd in roots) continue
    roots[cwd] = null
    let root: string | null = null
    try {
      const ran = await $.process.run(projectRootArgv(cwd))
      if (ran.exitCode === 0) root = repoRootFromCommonDir(ran.stdout)
    } catch {
      // not answered: the toplevel below
    }
    if (root === null) {
      const ran = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel']).catch(() => undefined)
      root = ran && ran.exitCode === 0 ? ran.stdout.trim() || null : null
    }
    roots = { ...roots, [cwd]: root }
  }
}

// The live sessions' subagents, looked at every AGENT_SCAN_MS in the background. Only transcripts
// written lately are tailed, and each again only when its mtime moves; a meta is read once.
let agents: AgentRecord[] = []
let agentScanAt = 0
let isScanning = false
let agentTails = new Map<string, { mtimeMs: number; agent: AgentRecord }>()
let agentMetas = new Map<string, string | undefined>()

async function agentFilesOf($: EngineInterface, config: string, card: SessionCard, now: number): Promise<AgentFile[]> {
  const where = subagentsDir(config, card.cwd, card.sessionId)
  let dir = where.dir
  if (dir === undefined) {
    // A long slug is cut and hashed: of the dirs with its prefix, the one holding this session.
    for (const e of await $.fs.list(where.projects).catch(() => [])) {
      if (e.kind !== 'dir' || !e.name.startsWith(where.prefix ?? '\u0000')) continue
      const candidate = `${where.projects}/${e.name}/${card.sessionId}/subagents`
      if (await $.fs.exists(candidate).catch(() => false)) {
        dir = candidate
        break
      }
    }
    if (dir === undefined) return []
  }
  const top = await $.fs.list(dir).catch(() => [])
  const files = freshAgentFiles(dir, top, now)
  // Workflow agents: subagents/workflows/<runId>/agent-<id>.jsonl
  if (top.some(e => e.kind === 'dir' && e.name === 'workflows')) {
    for (const run of await $.fs.list(`${dir}/workflows`).catch(() => [])) {
      if (run.kind !== 'dir') continue
      const runDir = `${dir}/workflows/${run.name}`
      files.push(...freshAgentFiles(runDir, await $.fs.list(runDir).catch(() => []), now))
    }
  }
  return files
}

async function scanAgents($: EngineInterface, cards: SessionCard[]): Promise<void> {
  if (isScanning || Date.now() - agentScanAt < AGENT_SCAN_MS) return
  isScanning = true
  agentScanAt = Date.now()
  try {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
    const now = Date.now()
    const found: AgentRecord[] = []
    const tails = new Map<string, { mtimeMs: number; agent: AgentRecord }>()
    const metas = new Map<string, string | undefined>()
    for (const card of cards) {
      for (const file of await agentFilesOf($, config, card, now)) {
        const meta = agentMetas.has(file.meta) ? agentMetas.get(file.meta) : await $.fs.read(file.meta).catch(() => undefined)
        metas.set(file.meta, meta)
        let hit = agentTails.get(file.path)
        if (!hit || hit.mtimeMs !== file.mtimeMs) {
          const ran = await $.process.run(['tail', '-n', '40', file.path]).catch(() => undefined)
          if (!ran) continue
          hit = { mtimeMs: file.mtimeMs, agent: parseAgent(file, ran.stdout, meta, card, now) }
        }
        tails.set(file.path, hit)
        found.push(hit.agent)
      }
    }
    agents = found
    agentTails = tails
    agentMetas = metas
  } catch {
    // keep the last answer; the next scan tries again
  } finally {
    isScanning = false
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
  void scanAgents($, cards)
  const everyone = deriveCrew(cards, jobs, managers, roots, Date.now(), LINGER_MS, agents)
  const project = shownProject(everyone, await read($, PROJECT))
  if (project === null) return { crew: [], project, all: [] }
  seated = assignSeats(everyone, officeMap(), project, seated)
  // Someone leaving is drawn only while its walk to the door lasts: one never seen inside, or
  // already out of the door, is not brought back to the doorway.
  const here = seated.filter(c => c.project === project && (c.state !== 'leaving' || actors.some(a => a.id === c.id && !a.isGone)))
  return { crew: distinctLooks(here, officeArt().sprites.length), project, all: projectsOf(everyone) }
}

function selectColor(): number {
  const i = officeArt().palette.indexOf(0xd64030)
  return i > 0 ? i : 1
}

// One frame: walk everyone a step, paint, and hand the picture over when it changed.
async function frame($: EngineInterface): Promise<void> {
  lastFrameAt = Date.now()
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
  // Nobody walking: the quiet animations (typing, music, thinking, the needs-you blink) only
  // need every other frame. Nobody in the office: send nothing.
  const quiet = wasSettled && isSettled(actors)
  const hasPicture = (box.graphics ? lastPicture.png : lastPicture.cells) !== undefined
  if (quiet && hasPicture && (crew.length === 0 || frameNo % 2 === 1) && !blinking) return
  if (quiet && hasPicture && blinking && frameNo % 2 === 1) return
  paint(crew, selected)
  stats.painted++
  if (box.graphics) await toFile($)
  const sent = box.graphics
    ? await $.ui.blit({ requestId: PANE, key: 'scene', source: imageSource() }).catch((err: unknown) => ({ deny: String(err) }))
    : await $.ui.blit({ requestId: PANE, key: 'scene', cells: lastPicture.cells! }).catch((err: unknown) => ({ deny: String(err) }))
  // A refused swap would leave the picture frozen: redraw the pane instead, and say why once.
  const refused = 'deny' in sent && sent.deny ? String(sent.deny) : ''
  stats.last = refused ? `refused: ${refused}` : 'ok'
  if (!refused) stats.swapped++
  // While the d line shows, redraw it about once a second so its numbers move.
  if (debug && frameNo % 10 === 0) await update($, TICK, n => (n + 1) % 1_000_000)
  if (refused !== blitRefused || refused) {
    blitRefused = refused
    await update($, TICK, n => (n + 1) % 1_000_000)
  }
}

function paint(crew: Crew[], selected: string | null): void {
  const art = officeArt()
  const pixels = paintFrame(officeMap(), art, actors, crew, frameNo, selected, selectColor())
  lastPicture = box.graphics ? { png: toPng(pixels, art.palette, box.scale, true, frameNo) } : { cells: toCells(pixels, art.palette, 2).cells }
}

// Idempotent and self-healing like the board's poll: a reload drops the timer, a refused period
// ends it quietly, so every redraw calls this and a loop silent for a second starts over.
// Writes the newest PNG to the next of the two frame files; on any failure, inline PNGs from then on.
async function toFile($: EngineInterface): Promise<void> {
  if (!fileFrames || !lastPicture.png) return
  try {
    if (!frameDir) {
      const home = (await $.env.get('HOME')) ?? ''
      const dir = `${home}/Library/Caches/office-scene`
      await $.process.run(['mkdir', '-p', dir])
      frameDir = `${dir}/${(await $.session.id()).slice(0, 8)}`
    }
    const file = `${frameDir}-${frameNo % 2}.png`
    const ran = await $.process.run(['/usr/bin/base64', '-D', '-o', file], { stdin: lastPicture.png })
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `base64 exited ${ran.exitCode}`)
    lastPicture = { ...lastPicture, file, generation: frameNo }
  } catch {
    fileFrames = false
  }
}

function imageSource() {
  return lastPicture.file !== undefined && fileFrames
    ? { file: lastPicture.file, format: 'png' as const, generation: lastPicture.generation ?? 0 }
    : { png: lastPicture.png ?? '' }
}

function startTimer($: EngineInterface): void {
  if (timer && Date.now() - lastFrameAt < FRAME_MS * 10) return
  timer?.cancel()
  lastFrameAt = Date.now()
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

// The first few sentences of a session's last reply: enough to know what it is on.
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g)
  const head = sentences ? sentences.slice(0, 3).join('').trim() : flat
  return head.length > 420 ? `${head.slice(0, 419)}…` : head
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
    // Office-spawned workers only: subagents are drawn but never listed.
    const workers = crew.filter(c => !c.isSelectable && !agents.some(a => a.id === c.id))
    const picked = leads.find(c => c.id === selectedId)
    const pickedCard = picked && cards.find(c => c.sessionId === picked.id)
    let usage = ''
    try {
      usage = budgetLine((await $.session.usage()).rateLimits as RateWindow[])
    } catch {
      // the header simply goes without it
    }
    const projectName = project ? (project.split('/').pop() ?? project) : 'no sessions'
    const series = (await read($, SHELF)).series
    const mangaTitle = series ? `Manga: ${series}` : 'Manga'
    const choose = (id: string) => () => {
      chatScroll = 0
      return update($, SELECTED, prev => (prev === id ? null : id))
    }
    const scrollChat = (delta: number) => () => {
      chatScroll = Math.max(0, chatScroll + delta)
      return update($, TICK, n => (n + 1) % 1_000_000)
    }
    const talk = pickedCard ? await chatOf($, pickedCard) : []
    // The chat fills the pane below the picture, the crew list and the message box.
    const chatRows = Math.max(4, (e.props.scroll?.bodyRows ?? 40) - rows - 8)
    chatScroll = Math.min(chatScroll, Math.max(0, talk.length - 1))
    const shownTalk = chatWindow(talk, chatRows, Math.max(20, columns - 2), chatScroll)
    const cycle = (delta: number) => () =>
      update($, PROJECT, prev => {
        if (all.length === 0) return null
        const at = Math.max(0, all.indexOf(prev ?? project ?? ''))
        return all[(at + delta + all.length) % all.length] ?? null
      })

    let picture
    if (graphics && Image) {
      picture = <Image key="scene" source={imageSource()} columns={columns} rows={rows} alt="the office" />
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
          <Button
            plain
            key="debug"
            label="debug"
            hotkey="d"
            onPress={() => {
              debug = !debug
              return update($, TICK, n => (n + 1) % 1_000_000)
            }}
          />
          <Button plain key="manga" label="manga" hotkey="b" onPress={() => $.ui.open({ id: 'manga', title: mangaTitle, focus: true })} />
        </Box>
        {picture}
        {debug && (
          <Text dimColor wrap="truncate-end">
            {`frames drawn ${stats.painted} · swapped ${stats.swapped} · last swap ${stats.last || 'none yet'} · timer ${timer ? `running, last tick ${Math.round((Date.now() - lastFrameAt) / 100) / 10}s ago` : 'stopped'} · ${box.graphics ? `picture ×${box.scale} ${lastPicture.file && fileFrames ? `file gen ${lastPicture.generation}` : 'inline'}` : 'cells'} · walking ${actors.filter(a => a.path.length > 0).length}`}
          </Text>
        )}
        {blitRefused && <Text dimColor wrap="truncate-end">{`frames redrawn whole: the engine refused a swap (${blitRefused})`}</Text>}
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
        {workers.length > 0 && (
          <Text dimColor wrap="truncate-end">
            {`workers: ${workers.map(c => `${c.name} (${STATE_WORDS[c.state]})`).join(', ')}`}
          </Text>
        )}
        {picked && (
          <Box flexDirection="column">
            <Box gap={1}>
              <Text bold>{`${picked.name} · ${STATE_WORDS[picked.state]}${picked.activity ? ` (${picked.activity})` : ''}`}</Text>
              <Button plain key="older" label="older" hotkey="u" onPress={scrollChat(1)} />
              <Button plain key="newer" label="newer" hotkey="n" onPress={scrollChat(-1)} />
              {chatScroll > 0 && <Text dimColor>{`${chatScroll} newer below`}</Text>}
            </Box>
            <Box flexDirection="column" height={chatRows} overflow="hidden">
              {shownTalk.length === 0 && <Text dimColor>{preview(pickedCard?.lastText ?? picked.tag ?? 'No conversation found for this session.')}</Text>}
              {shownTalk.map((line, i) => (
                <Text key={`chat:${i}`} wrap="wrap">
                  <Text bold color={line.who === 'you' ? 'cyan' : 'yellow'}>{line.who === 'you' ? 'you › ' : `${picked.name} › `}</Text>
                  {line.text}
                </Text>
              ))}
            </Box>
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
