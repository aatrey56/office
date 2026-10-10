import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, RenderSurface, Timer } from 'claude-code'

import type { Activity, MangaShelf, SessionCard } from '../types'
import type { BoardMode, Registered } from './sessions'
import { SLUG_MAX, ago, bandWindow, parseMode, clip, isRegistryFile, lastActivity, lastAssistantText, parseRegistry, projectSlug, resumeCommand, shortCwd } from './sessions'
import { projectRootArgv, repoRootFromCommonDir } from './worktree'

// Owner: board agent. Session board pane (/office) + tap-in.

const PANE = 'office'
const POLL_MS = 3000
const SEND_TOOL = 'mcp__office__message_session'

const sessions = atom({ plugin: 'office', key: 'sessions' } as const, [] as SessionCard[])
const selected = atom({ plugin: 'office', key: 'selected' } as const, null as string | null)
// Bumped each poll so only this pane redraws its age column ($.ui.invalidate would redraw every pane).
const tick = atom({ plugin: 'office', key: 'boardTick' } as const, 0)
// 'band' draws the board above the prompt instead of in the pane; kept in $.store too.
const mode = atom({ plugin: 'office', key: 'boardMode' } as const, 'pane' as BoardMode)
// What the /office pane shows; scene.tsx draws 'scene', this file draws 'text'.
const view = atom({ plugin: 'office', key: 'officeView' } as const, 'scene' as 'scene' | 'text')
// The reader's series, so the manga tab opened from here is titled like /manga titles it.
const shelf = atom({ plugin: 'office', key: 'shelf' } as const, { series: '', chapters: [], pages: [], dir: '', ready: [], loading: false } as MangaShelf)

// Not drawn from: the poll's handle, the refresh in flight, and a transcript
// tail cache keyed by path (re-tailed only when the file's mtime moves). A
// reload drops them along with the environment's timers.
let poll: Timer | undefined
let lastPoll = 0
let inFlight: Promise<void> | undefined
const tails = new Map<string, { mtimeMs: number; text?: string; activity?: Activity }>()
// Git toplevel per cwd, null outside a repo.
const roots = new Map<string, string | null>()

// userConfig messageApproval: when message_session sends without asking.
type Approval = 'ask' | 'same-repo' | 'allow'

function approvalOf(options: PluginOptions): Approval {
  const value = options.messageApproval
  return value === 'ask' || value === 'allow' ? value : 'same-repo'
}

async function configDir($: EngineInterface): Promise<string | undefined> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) return custom
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude` : undefined
}

// One `ps` for every pid; a pid it does not print has exited.
async function alivePids($: EngineInterface, pids: number[]): Promise<Set<number>> {
  if (pids.length === 0) return new Set()
  const ran = await $.process.run(['ps', '-o', 'pid=', '-p', pids.join(',')]).catch(() => undefined)
  if (!ran) return new Set(pids) // cannot tell: keep them
  return new Set(ran.stdout.split(/\s+/).filter(Boolean).map(Number))
}

async function transcriptPath($: EngineInterface, root: string, card: Registered): Promise<string | undefined> {
  const projects = `${root}/projects`
  const slug = projectSlug(card.cwd)
  if (slug.length <= SLUG_MAX) return `${projects}/${slug}/${card.sessionId}.jsonl`
  const prefix = `${slug.slice(0, SLUG_MAX)}-`
  const dirs = await $.fs.list(projects).catch(() => [])
  const hit = dirs.find(entry => entry.kind === 'dir' && entry.name.startsWith(prefix))
  return hit ? `${projects}/${hit.name}/${card.sessionId}.jsonl` : undefined
}

async function lastTextOf($: EngineInterface, root: string, card: Registered): Promise<{ text?: string; activity?: Activity }> {
  const path = await transcriptPath($, root, card)
  if (!path) return {}
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat) return {}
  const hit = tails.get(path)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit
  const ran = await $.process.run(['tail', '-n', '40', path]).catch(() => undefined)
  const text = (ran ? lastAssistantText(ran.stdout) : undefined) ?? hit?.text
  const activity = (ran ? lastActivity(ran.stdout) : undefined) ?? hit?.activity
  const got = { mtimeMs: stat.mtimeMs, ...(text ? { text } : {}), ...(activity ? { activity } : {}) }
  tails.set(path, got)
  return got
}

async function loadBoard($: EngineInterface): Promise<SessionCard[]> {
  const root = await configDir($)
  if (!root) return []
  const dir = `${root}/sessions`
  const entries = await $.fs.list(dir).catch(() => [])
  const found: Registered[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !isRegistryFile(entry.name)) continue
    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => undefined)
    const card = typeof text === 'string' ? parseRegistry(text) : null
    if (card) found.push(card)
  }
  const alive = await alivePids($, found.map(card => card.pid))
  const self = await $.session.id()
  const live = found.filter(card => alive.has(card.pid))
  const cards = await Promise.all(
    live.map(async card => {
      const { text: lastText, activity } = await lastTextOf($, root, card)
      return { ...card, isSelf: card.sessionId === self, ...(lastText ? { lastText } : {}), ...(activity ? { activity } : {}) }
    }),
  )

  return cards.sort((a, b) => b.updatedAt - a.updatedAt)
}

function glyph(status: string): string {
  if (status === 'busy') return '●'
  if (status === 'idle') return '○'
  return '◐'
}

async function writeBoard($: EngineInterface): Promise<void> {
  const next = await loadBoard($)
  const prev = await read($, sessions)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, sessions, () => next)
}

// Callers during a refresh wait on the same one; a failed poll keeps the last board.
function refresh($: EngineInterface): Promise<void> {
  inFlight ??= writeBoard($)
    .catch(() => undefined)
    .finally(() => {
      inFlight = undefined
    })
  return inFlight
}

async function move($: EngineInterface, delta: number): Promise<void> {
  const list = await read($, sessions)
  if (list.length === 0) return
  await update($, selected, current => {
    const at = list.findIndex(card => card.sessionId === current)
    const to = at < 0 ? 0 : (at + delta + list.length) % list.length
    return list[to]?.sessionId ?? null
  })
}

async function selfName($: EngineInterface): Promise<string> {
  let self = (await read($, sessions)).find(card => card.isSelf)
  if (!self) {
    await refresh($)
    self = (await read($, sessions)).find(card => card.isSelf)
  }
  return self?.name ?? (await $.session.id()).slice(0, 8)
}

// null when delivered, else why not. The receiver sees who sent it and how.
async function sendTo($: EngineInterface, sessionId: string, text: string): Promise<string | null> {
  const body = text.trim()
  if (!body) return 'empty message'
  const sent = await $.session.send({ to: { sessionId }, text: `[via office from ${await selfName($)}] ${body}` })
  return sent.isDelivered ? null : sent.reason
}

async function repoRoot($: EngineInterface, cwd: string): Promise<string | null> {
  const known = roots.get(cwd)
  if (known !== undefined) return known
  const ran = await $.process.run(projectRootArgv(cwd)).catch(() => undefined)
  if (!ran) return null // could not run: decide again next time
  const root = ran.exitCode === 0 ? repoRootFromCommonDir(ran.stdout) : null
  roots.set(cwd, root)
  return root
}

// Same git toplevel; when either cwd is outside a repo, the same cwd.
async function isSameRepo($: EngineInterface, a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([repoRoot($, a), repoRoot($, b)])
  return ra !== null && rb !== null ? ra === rb : a === b
}

async function isWorker($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OFFICE_WORKER')) === '1'
}

async function findCard($: EngineInterface, sessionId: string): Promise<SessionCard | undefined> {
  const hit = (await read($, sessions)).find(card => card.sessionId === sessionId)
  if (hit) return hit
  await refresh($)
  return (await read($, sessions)).find(card => card.sessionId === sessionId)
}

// A plugin tool's hook answers above core's permission step, so the gate is
// here. The engine's verdict refuses on deny in every policy, and allows
// outright only when a settings rule allows this tool (a mode's blanket allow,
// such as bypassPermissions, does not skip the policy); then `allow` sends,
// `same-repo` sends when the target shares this session's repo, and anything
// left asks the person.
async function approveSend($: EngineInterface, approval: Approval, sessionId: string, text: string): Promise<string | null> {
  const verdict = await $.tool.check({ tool: SEND_TOOL, input: { sessionId, text } })
  if (verdict.decision === 'deny') return verdict.reason ?? 'denied by permission rules'
  if ((verdict.decision === 'allow' && verdict.rule !== undefined) || approval === 'allow') return null
  const target = await findCard($, sessionId)
  if (approval === 'same-repo' && target && (await isSameRepo($, await $.session.cwd(), target.cwd))) return null
  const preview = clip(text, 200)
  const answer = await $.ui
    .ask(`Send this to session ${target?.name ?? sessionId}? "${preview}"`, ['Send', "Don't send"])
    .catch(() => undefined)
  return answer === 'Send' ? null : 'the user did not approve this message'
}

// Poll only while the pane is open or band mode is on; each tick also redraws the age column.
// Idempotent, and self-healing: a reload drops the timer, and an interval whose period the engine
// refused ends quietly, so any redraw calls this and a poll silent for three periods starts over.
function startPolling($: EngineInterface): void {
  if (poll && Date.now() - lastPoll < POLL_MS * 3) return
  poll?.cancel()
  lastPoll = Date.now()
  poll = $.clock.every(POLL_MS, () => {
    lastPoll = Date.now()
    void refresh($)
      .then(() => update($, tick, n => (n ?? 0) + 1))
      .catch(() => undefined)
  })
}

function stopPolling(): void {
  poll?.cancel()
  poll = undefined
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function setMode($: EngineInterface, next: BoardMode): Promise<void> {
  await update($, mode, () => next)
  await $.store.set('boardMode', next)
}

async function openPane($: EngineInterface): Promise<{ text: string }> {
  const opened = await $.ui.open({ id: PANE, title: 'Office', focus: true })
  const count = (await read($, sessions)).length
  if (!opened.isPlaced) return { text: `Office pane not shown: ${opened.reason}` }

  return { text: `Office: ${count} live session${count === 1 ? '' : 's'}. j/k or 1-9 select, m message, c copy resume, r refresh, b manga tab, Tab switches tabs.` }
}

async function messageFromPane($: EngineInterface, card: SessionCard, text: string): Promise<void> {
  const failed = await sendTo($, card.sessionId, text)
  $.ui.toast(failed === null ? `Sent to ${card.name}` : `Not sent to ${card.name}: ${failed}`)
}

async function copyResume($: EngineInterface, card: SessionCard, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text: resumeCommand(card), surface })
  $.ui.toast(copied.isCopied ? `Copied resume command for ${card.name}` : `Copy failed: ${copied.reason}`)
}

export function installBoard(on: On, options: PluginOptions) {
  const approval = approvalOf(options)

  // Always matches. The matcher is there because sibling features in this
  // module hook session.start too, and the validator allows only one unmatched.
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    await $.command.register({
      name: 'office',
      description: 'Session board: see, message and resume your other Claude Code sessions',
      argumentHint: '[band|pane|manage|manage off]',
      immediate: true,
    })
    await $.tool.register({
      name: 'list_sessions',
      description:
        'Lists the live Claude Code sessions on this machine as JSON: pid, sessionId, name, cwd, status (busy/idle/...), kind, updatedAt (ms epoch), isSelf, and lastText (their last assistant line).',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'session_usage',
      description:
        "Reports this session's context use and the account's rate-limit windows as JSON: context (tokens, percent of the window), rateLimits (five_hour / seven_day: percentUsed 0-100, resetsAt ISO time) and cost. Check it before launching several agents.",
      inputSchema: { type: 'object', properties: {} },
    })
    // A worker this mod spawned never gets it: a prompt-injected worker could
    // otherwise message the person's sessions.
    if (!(await isWorker($))) await $.tool.register({
      name: 'message_session',
      description:
        'Sends a plain-text message to another live Claude Code session on this machine, by the sessionId list_sessions reports. It arrives there as a peer message prefixed "[via office from <this session>]". Each send needs the user\'s approval unless their permission rules allow this tool.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The target session id, from list_sessions' },
          text: { type: 'string', description: 'The message to send' },
        },
        required: ['sessionId', 'text'],
      },
    })
    // The mode survives restarts; a reload with the pane or band up picks the poll back up.
    const stored = parseMode(await $.store.get('boardMode'))
    if (stored !== (await read($, mode))) await update($, mode, () => stored)
    if (stored === 'band' || (await isPaneOpen($))) startPolling($)

    return next(e)
  })

  // Every open of the board, from /office or the reader's button, comes through here.
  // The board and the reader sit side by side as tabs; Tab (pane:next) switches them.
  on('ui.open', { id: PANE }, async ($, e, next) => {
    await refresh($)
    startPolling($)
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if ((await read($, mode)) !== 'band') stopPolling()
    return next(e)
  })

  on('command.run', { command: 'office' }, async ($, e, next) => {
    const arg = e.args.trim().toLowerCase()
    // `manage` and `manage off` are manage.tsx's: pass them on.
    if (/^manage\b/.test(arg)) return next(e)
    if (arg === 'band') {
      await setMode($, 'band')
      await $.ui.close({ id: PANE })
      await refresh($)
      startPolling($)
      return { text: 'Office board moved above the prompt. ctrl+x tab (or a click) gives it the keys; /office pane moves it back.' }
    }
    if (arg === 'pane') {
      await setMode($, 'pane')
      return openPane($)
    }
    if (arg !== '') return { text: 'Usage: /office [band|pane|manage|manage off]' }
    if ((await read($, mode)) === 'band') {
      await refresh($)
      const count = (await read($, sessions)).length
      return { text: `Office band refreshed: ${count} live session${count === 1 ? '' : 's'}.` }
    }

    return openPane($)
  })

  on('tool.call', { tool: 'mcp__office__list_sessions' }, async $ => {
    await refresh($)

    return { result: JSON.stringify(await read($, sessions), null, 2) }
  })

  on('tool.call', { tool: SEND_TOOL }, async ($, e) => {
    if (await isWorker($)) return { deny: 'message_session is not available to office workers' }
    if (typeof e.sessionId !== 'string' || typeof e.text !== 'string') {
      return { deny: 'message_session needs string sessionId and text' }
    }
    const refused = await approveSend($, approval, e.sessionId, e.text)
    if (refused !== null) return { deny: `Not sent: ${refused}` }
    const failed = await sendTo($, e.sessionId, e.text)

    return failed === null ? { result: `Delivered to ${e.sessionId}.` } : { deny: `Not delivered: ${failed}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // Drawn means open: keep the session list fresh whichever view is showing.
    startPolling($)
    if ((await read($, view)) === 'scene') return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const list = await read($, sessions)
    const pick = await read($, selected)
    await read($, tick)
    const now = await $.clock.now()
    const home = await $.env.get('HOME')
    const width = Math.max(20, e.props.bodyColumns)
    const current = list.find(card => card.sessionId === pick)
    const series = (await read($, shelf)).series
    const mangaTitle = series ? `Manga: ${series}` : 'Manga'

    return (
      <Box flexDirection="column" width={width}>
        <Box gap={1}>
          <Button plain key="up" label="up" hotkey="k" onPress={() => move($, -1)} />
          <Button plain key="down" label="down" hotkey="j" onPress={() => move($, 1)} />
          <Button plain key="refresh" label="refresh" hotkey="r" onPress={() => refresh($)} />
          <Button plain key="manga" label="manga" hotkey="b" onPress={() => $.ui.open({ id: 'manga', title: mangaTitle, focus: true })} />
          <Button plain key="scene" label="office view" hotkey="t" onPress={() => update($, view, () => 'scene')} />
        </Box>
        {list.length === 0 && <Text dimColor>No live sessions found.</Text>}
        {list.map((card, i) => {
          const isPicked = card.sessionId === pick
          const where = `${shortCwd(card.cwd, home)} · ${ago(now - card.updatedAt)}${card.isSelf ? ' · this session' : ''}`
          const label = clip(`${glyph(card.status)} ${card.name}`, Math.max(8, width - 6))
          const choose = () => update($, selected, () => card.sessionId)
          return (
            <Box key={`row:${card.sessionId}`} flexDirection="column">
              <Box gap={1}>
                <Text bold={isPicked}>{isPicked ? '›' : ' '}</Text>
                {i < 9 ? (
                  <Button plain key={`pick:${card.sessionId}`} label={label} hotkey={String(i + 1)} onPress={choose} />
                ) : (
                  <Button plain key={`pick:${card.sessionId}`} label={label} onPress={choose} />
                )}
                <Text dimColor wrap="truncate-end">
                  {where}
                </Text>
              </Box>
              {card.lastText && (
                <Text dimColor wrap="truncate-end">
                  {`  ${clip(card.lastText, Math.max(10, width - 2))}`}
                </Text>
              )}
            </Box>
          )
        })}
        {current && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold wrap="truncate-end">
              {`${current.name} (${current.status}, pid ${current.pid})`}
            </Text>
            <Box gap={1}>
              {!current.isSelf && Input && (
                <Button plain key="message" label="message" hotkey="m" onPress={() => $.ui.focus({ requestId: PANE, key: 'msg' })} />
              )}
              <Button plain key="copy" label="copy resume" hotkey="c" onPress={press => copyResume($, current, press.surface)} />
            </Box>
            {!current.isSelf && Input && (
              <Input key="msg" label="> " placeholder={`message ${current.name}`} submitLabel="send" onSubmit={text => messageFromPane($, current, text)} />
            )}
          </Box>
        )}
      </Box>
    )
  })

  // The compact board above the prompt, while band mode is on.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, mode)) !== 'band') return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const site = e.requestId
    const list = await read($, sessions)
    const pick = await read($, selected)
    await read($, tick)
    const now = await $.clock.now()
    const home = await $.env.get('HOME')
    const width = Math.max(20, e.props.bodyColumns)
    const at = list.findIndex(card => card.sessionId === pick)
    const current = list[at]
    const canMessage = current !== undefined && !current.isSelf && Input !== undefined
    const { start, end, more } = bandWindow(list.length, at, e.props.maxRows, canMessage)

    return (
      <Box flexDirection="column" width={width}>
        <Box gap={1}>
          <Text bold>Office</Text>
          <Button plain key="up" label="up" hotkey="k" onPress={() => move($, -1)} />
          <Button plain key="down" label="down" hotkey="j" onPress={() => move($, 1)} />
          <Button plain key="refresh" label="refresh" hotkey="r" onPress={() => refresh($)} />
          {canMessage && <Button plain key="message" label="message" hotkey="m" onPress={() => $.ui.focus({ requestId: site, key: 'msg' })} />}
          {current && <Button plain key="copy" label="copy resume" hotkey="c" onPress={press => copyResume($, current, press.surface)} />}
          {more > 0 && <Text dimColor>{`+${more} more`}</Text>}
          {list.length === 0 && <Text dimColor>no live sessions</Text>}
        </Box>
        {list.slice(start, end).map((card, offset) => {
          const i = start + offset
          const isPicked = i === at
          const label = clip(`${glyph(card.status)} ${card.name}`, 24)
          const rest = [shortCwd(card.cwd, home), ago(now - card.updatedAt), card.isSelf ? 'this session' : '', card.lastText ?? '']
            .filter(Boolean)
            .join(' · ')
          const choose = () => update($, selected, () => card.sessionId)
          return (
            <Box key={`band:${card.sessionId}`} gap={1}>
              <Text bold={isPicked}>{isPicked ? '›' : ' '}</Text>
              {i < 9 ? (
                <Button plain key={`pick:${card.sessionId}`} label={label} hotkey={String(i + 1)} onPress={choose} />
              ) : (
                <Button plain key={`pick:${card.sessionId}`} label={label} onPress={choose} />
              )}
              <Text dimColor wrap="truncate-end">
                {clip(rest, Math.max(10, width - label.length - 4))}
              </Text>
            </Box>
          )
        })}
        {canMessage && current && Input && (
          <Input key="msg" label="> " placeholder={`message ${current.name}`} submitLabel="send" onSubmit={text => messageFromPane($, current, text)} />
        )}
      </Box>
    )
  })
}
