import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import type { SessionCard } from '../types'
import { bashActivity, chatLines, parseRegistry, projectSlug } from './sessions'

const HOME = '/Users/me'
const SESSIONS = `${HOME}/.claude/sessions`
type Entry = { name: string; kind: 'dir' | 'file'; size: number; mtimeMs: number; isLink: boolean }
const file = (name: string): Entry => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })

const REGISTRY = {
  pid: 49178,
  sessionId: 'aaaa-1111',
  cwd: '/Users/me/Coding/proj.v2',
  kind: 'interactive',
  name: 'coding-0b',
  status: 'busy',
  updatedAt: 1000,
  messagingSocketPath: '/tmp/x.sock',
}

const TRANSCRIPT = [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first   answer' }] } }),
  JSON.stringify({ type: 'user', message: { content: 'next' } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on\nthe build now.' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }),
  '{"type":"assistant", truncated',
].join('\n')

describe('pure helpers', () => {

  test('parses a registry entry and rejects junk', () => {
    expect(parseRegistry(JSON.stringify(REGISTRY))).toEqual({
      pid: 49178,
      sessionId: 'aaaa-1111',
      cwd: '/Users/me/Coding/proj.v2',
      name: 'coding-0b',
      status: 'busy',
      kind: 'interactive',
      updatedAt: 1000,
    })
    expect(parseRegistry(JSON.stringify({ ...REGISTRY, parkedJobId: '2cb96d62' }))).toBe(null)
    expect(parseRegistry('not json')).toBe(null)
    expect(parseRegistry('{"pid":"1"}')).toBe(null)
  })
})

// The test environment has no disk or processes: answer them from memory, and
// record every path read so the test can prove no .key file was touched.
// `roots` gives each cwd's repo root, answered as projectRootArgv's `<root>/.git` (absent: not a repo).
// `other`: a second live session, in another project.
type World = { roots?: Record<string, string>; selfCwd?: string; registered?: string[]; other?: boolean }

function fakeHost(on: On, reads: string[], world: World = {}) {
  const slugDir = `${HOME}/.claude/projects/${projectSlug(REGISTRY.cwd)}`
  on('fs.list', (_$, e) => ({
    value: e.path === SESSIONS ? [file('49178.json'), file('49178.deadbeef.key'), file('5.json'), ...(world.other ? [file('7.json')] : [])] : [],
  }))
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    if (e.path === `${SESSIONS}/49178.json`) return { value: JSON.stringify(REGISTRY) }
    if (e.path === `${SESSIONS}/5.json`) return { value: JSON.stringify({ ...REGISTRY, pid: 5, sessionId: 'dead' }) }
    if (world.other && e.path === `${SESSIONS}/7.json`)
      return { value: JSON.stringify({ ...REGISTRY, pid: 7, sessionId: 'bbbb-2222', name: 'other-1', cwd: '/Users/me/Other' }) }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.stat', (_$, e) => {
    if (e.path !== `${slugDir}/${REGISTRY.sessionId}.jsonl`) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file' as const, size: 1, mtimeMs: 7, isLink: false } }
  })
  const out = (exitCode: number, stdout: string) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', (_$, e) => {
    const [cmd] = e.argv
    if (cmd === 'ps') return out(0, world.other ? '49178\n7\n' : '49178\n')
    if (cmd === 'tail') return out(0, TRANSCRIPT)
    if (cmd === 'git' && e.argv[1] === '-C') {
      const root = world.roots?.[e.argv[2] ?? '']
      return root ? out(0, `${root}/.git\n`) : out(128, '')
    }
    return out(1, '')
  })
  on('session.cwd', () => ({ value: world.selfCwd ?? HOME }))
  on('session.id', () => ({ value: 'someone-else' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => {
    world.registered?.push(e.name)
    return { value: { tool: `mcp__office__${e.name}` } }
  })
  on('ui.panes', () => ({ value: [] }))
  return mock.clock(on, { now: 5000 })
}

test('list_sessions reads only live <pid>.json entries and their transcript tail', async ($, on) => {
  const reads: string[] = []
  mock.env(on, { HOME })
  fakeHost(on, reads)
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: 'mcp__office__list_sessions', tool_use_id: 'call-1' })
  const board = JSON.parse(String(ran.text ?? ran.result)) as SessionCard[]

  expect(board.length).toBe(1)
  expect(board[0]?.sessionId).toBe('aaaa-1111')
  expect(board[0]?.isSelf).toBe(false)
  expect(board[0]?.lastText).toBe('Working on the build now.')
  expect(reads.some(path => path.endsWith('.key'))).toBe(false)
})

test('the pane lists sessions and selects one', async ($, on) => {
  mock.env(on, { HOME })
  fakeHost(on, [])
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__office__list_sessions', tool_use_id: 'call-2' })

  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'office',
    props: { title: 'Office', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } },
  } as Parameters<typeof $.ui.mount>[0])

  // The office scene is the default view; t swaps to this text board, and back.
  expect(await ui.find({ key: 'scene' })).toBeDefined()
  await ui.press({ key: 'text' })
  expect(await ui.find({ type: 'Button', text: /coding-0b/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Working on the build/ })).toBeDefined()
  expect(await ui.find({ key: 'copy' })).toBeUndefined()

  await ui.press({ key: 'pick:aaaa-1111' })
  expect(await ui.find({ key: 'copy' })).toBeDefined()
  expect(await ui.find({ key: 'msg' })).toBeDefined()
  await ui.press({ key: 'scene' })
  expect(await ui.find({ key: 'copy' })).toBeUndefined()
  await ui.unmount()
})

test('the office scene with sessions in two projects: pictures, the crew list, and switching offices', async ($, on) => {
  mock.env(on, { HOME, TERM_PROGRAM: 'ghostty' })
  fakeHost(on, [], { other: true })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__office__list_sessions', tool_use_id: 'call-3' })
  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'office',
    props: { title: 'Office', isFocused: true, bodyColumns: 160, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } },
  } as Parameters<typeof $.ui.mount>[0])
  expect(await ui.find({ type: 'Image', key: 'scene' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /error/ })).toBeUndefined()
  // Selecting a session opens its chat under the picture; the scene still draws without error.
  await ui.press({ key: 'crew:aaaa-1111' })
  expect(await ui.find({ key: 'older' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /error/ })).toBeUndefined()
  const before = (await ui.find({ type: 'Button', text: /coding-0b|other-1/ }))?.props.label
  await ui.press({ key: 'next-proj' })
  const after = (await ui.find({ type: 'Button', text: /coding-0b|other-1/ }))?.props.label
  expect(after).not.toBe(before)
  await ui.unmount()
})

test('an open pane keeps its session list fresh on its own, in either view', async ($, on) => {
  mock.env(on, { HOME })
  const reads: string[] = []
  const clock = fakeHost(on, reads)
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'office',
    props: { title: 'Office', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } },
  } as Parameters<typeof $.ui.mount>[0])
  const registryReads = () => reads.filter(path => path.endsWith('/49178.json')).length
  const before = registryReads()
  await clock.advance(3_100)
  await clock.advance(3_100)
  expect(registryReads()).toBeGreaterThan(before)
  await ui.unmount()
})

test('a shell command that only looks is reviewing, one that changes or runs things is coding', () => {
  expect(['cd /r && git status --short', 'sed -n 1,40p a.ts', 'grep -n x *.ts'].map(bashActivity)).toEqual(['reviewing', 'reviewing', 'reviewing'])
  expect(["sed -i '' s/a/b/ f", 'claude plugin test .', 'git commit -m x'].map(bashActivity)).toEqual(['coding', 'coding', 'coding'])
})

test('the chat window keeps what was said, not the machinery', () => {
  const rows = [
    { type: 'user', message: { content: 'fix the map<system-reminder>engine note</system-reminder>' } },
    { type: 'user', isMeta: true, message: { content: 'hidden context' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }, { type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed.' }] } },
    { type: 'user', message: { content: '<command-name>/office</command-name><command-args>manage</command-args>' } },
  ]
  expect(chatLines(rows.map(r => JSON.stringify(r)).join('\n'))).toEqual([
    { who: 'you', text: 'fix the map' },
    { who: 'claude', text: 'Fixed.' },
    { who: 'you', text: '/office manage' },
  ])
})

describe('message_session', () => {
  async function setup($: Engine, on: On, decision: 'allow' | 'deny' | 'ask', world: World = {}, asked: string[] = [], rule?: string) {
    const sent: { to: string; text: string }[] = []
    mock.env(on, { HOME })
    fakeHost(on, [], world)
    // The person dismisses every approval dialog; `asked` records that one opened.
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
      asked.push(e.tool_use_id)
      return { deny: 'dismissed' }
    })
    on('session.send', (_$, e) => {
      sent.push({ to: e.to, text: e.text })
      return { isDelivered: true as const }
    })
    on('tool.check', () => ({ decision, reason: 'rule', ...(rule ? { rule } : {}) }))
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    return sent
  }

  test('a deny from the permission check sends nothing', async ($, on) => {
    const sent = await setup($, on, 'deny')
    const ran = await $.tool.call({ tool: 'mcp__office__message_session', tool_use_id: 'm1', sessionId: 'aaaa-1111', text: 'hi' })
    expect(ran.deny ?? ran.text ?? '').toMatch(/Not sent/)
    expect(sent.length).toBe(0)
  })

  test('an allowed send is prefixed with the sender', async ($, on) => {
    const sent = await setup($, on, 'allow', {}, [], 'mcp__office__message_session')
    await $.tool.call({ tool: 'mcp__office__message_session', tool_use_id: 'm2', sessionId: 'aaaa-1111', text: 'hi' })
    expect(sent.length).toBe(1)
    expect(sent[0]?.text).toMatch(/^\[via office from .+\] hi$/)
  })

  const SEND = { tool: 'mcp__office__message_session', sessionId: 'aaaa-1111', text: 'hi' } as const
  const TARGET = REGISTRY.cwd
  const SAME = { roots: { [TARGET]: '/Users/me/Coding', '/Users/me/Coding/other': '/Users/me/Coding' }, selfCwd: '/Users/me/Coding/other' }
  const OTHER = { roots: { [TARGET]: '/Users/me/Coding', '/Users/me/elsewhere': '/Users/me/elsewhere' }, selfCwd: '/Users/me/elsewhere' }

  test('policy same-repo (the default) sends within one repo', async ($, on) => {
    const asked: string[] = []
    const sent = await setup($, on, 'ask', SAME, asked)
    await $.tool.call({ ...SEND, tool_use_id: 'p4' })
    expect(sent.length).toBe(1)
    expect(asked.length).toBe(0)
  })

  test('policy same-repo asks across repos', { options: { messageApproval: 'same-repo' } }, async ($, on) => {
    const asked: string[] = []
    const sent = await setup($, on, 'ask', OTHER, asked)
    await $.tool.call({ ...SEND, tool_use_id: 'p5' })
    expect(asked.length).toBe(1)
    expect(sent.length).toBe(0)
  })
})

test('an office worker gets list_sessions but not message_session', async ($, on) => {
  const registered: string[] = []
  mock.env(on, { HOME, OFFICE_WORKER: '1' })
  fakeHost(on, [], { registered })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  expect(registered).toContain('list_sessions')
  expect(registered).not.toContain('message_session')
})

describe('band mode', () => {
  const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
  const band = (hasSurvey = false) =>
    ({
      plugin: 'office',
      surface: 'terminal',
      component: 'AbovePrompt',
      requestId: 'band',
      props: { hasSurvey, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 7 }, view: {} },
    }) as const

  // What the engine draws in the band when no plugin does.
  function engineBand(on: On) {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, { key: 'engine' }, 'engine band') as RenderElement
    })
  }

  async function start($: Engine, on: On, stored: Record<string, unknown> = {}) {
    const panes: string[] = []
    mock.env(on, { HOME })
    mock.store(on, stored)
    fakeHost(on, [])
    engineBand(on)
    on('ui.open', (_$, e) => {
      panes.push(`open:${e.id}`)
      return { value: { isPlaced: true as const } }
    })
    on('ui.close', (_$, e) => {
      panes.push(`close:${e.id}`)
      return { value: undefined }
    })
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    return panes
  }

  test('/office band closes the pane and draws the board above the prompt', async ($, on) => {
    const panes = await start($, on)
    await $.command.run({ command: 'office', args: 'band', ...RUN })
    expect(panes).toContain('close:office')

    const ui = await $.ui.mount(band())
    expect(await ui.find({ type: 'Button', text: /coding-0b/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Working on the build/ })).toBeDefined()
    await ui.press({ key: 'pick:aaaa-1111' })
    expect(await ui.find({ key: 'copy' })).toBeDefined()
    expect(await ui.find({ key: 'msg' })).toBeDefined()
    expect(await ui.find({ text: /engine band/ })).toBeUndefined()

    await $.command.run({ command: 'office', args: 'pane', ...RUN })
    expect(panes).toContain('open:office')
    await ui.unmount()
    const after = await $.ui.mount(band())
    expect(await after.find({ text: /engine band/ })).toBeDefined()
    await after.unmount()
  })
})
