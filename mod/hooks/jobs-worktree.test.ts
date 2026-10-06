import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const RUN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const BASE = 'abc1234def5678abc1234def5678abc1234def56'
const NO_LIMITS = { value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }

// A repo at /r, asked from /r/src; git answers as a clean checkout would, `claude --bg` prints its id
// (or `bg`), `claude agents` lists what `agents()` says.
function fakeRepo(on: On, fake: { bg?: string; agents?: () => string; transcript?: () => string } = {}) {
  const runs: { argv: string[]; cwd?: string }[] = []
  mock.store(on)
  mock.env(on, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' })
  on('session.usage', () => NO_LIMITS)
  on('session.cwd', () => ({ value: '/r/src' }))
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    runs.push({ argv, cwd: e.init?.cwd })
    const cmd = argv.join(' ')
    const out = (stdout: string) => ({ value: { ...RUN, stdout } })
    if (cmd.includes('--git-common-dir')) return out('/r/.git\n')
    if (cmd.endsWith('rev-parse HEAD')) return out(`${BASE}\n`)
    if (cmd.includes(' log --oneline ')) return out('f00d123 rename x to y\n')
    if (cmd.includes(' diff --stat ')) return out(' src/x.ts | 2 +-\n 1 file changed\n')
    if (argv.includes('--bg')) return out(fake.bg ?? 'backgrounded · 5ac0f0df\n')
    if (argv.includes('agents')) return out(fake.agents?.() ?? '[]')
    if (argv[0] === 'tail') return out(fake.transcript?.() ?? '')
    return out('') // worktree add / remove, status: clean
  })
  return runs
}

describe('worker worktrees', () => {
  test('a worker started in a repo runs on its own branch in its own worktree', async ($, on) => {
    const runs = fakeRepo(on)
    const r = await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    const add = runs.find(run => run.argv.includes('worktree') && run.argv.includes('add'))?.argv ?? []
    const branch = add[add.indexOf('-b') + 1] ?? ''
    const dir = add[add.indexOf('-b') + 2] ?? ''
    expect(add.slice(0, 3)).toEqual(['git', '-C', '/r'])
    expect(branch).toMatch(/^office\/.+-rename-x-to-y$/)
    expect(dir).toMatch(/^\/cfg\/office\/worktrees\/.+\/[^/]+$/)
    expect(add.at(-1)).toBe(BASE)
    const bg = runs.find(run => run.argv.includes('--bg'))
    expect(bg?.cwd).toBe(dir)
    expect(bg?.argv.at(-1)).toContain(`branch ${branch}`)
    expect(bg?.argv.at(-1)).toContain('Task:\nrename x to y')
    expect(bg?.argv.at(-1)).toContain('end your final reply with the line [office: done]')
    expect(JSON.stringify(r.result)).toContain(branch)
  })

  test('a clean finished worker gives its worktree back and reports its branch', async ($, on) => {
    const runs = fakeRepo(on)
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    let spawnedCwd: string | undefined
    on('process.spawn', async function* (_$, e) {
      spawnedCwd = e.cwd
      yield { stream: 'stdout' as const, text: '{"type":"result","subtype":"success","result":"Renamed it."}\n' }
      return { value: { code: 0, signal: null } }
    })
    await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', mode: 'headless', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    await clock.settle()
    expect(spawnedCwd).toMatch(/^\/cfg\/office\/worktrees\//)
    const remove = runs.find(run => run.argv.includes('worktree') && run.argv.includes('remove'))?.argv
    expect(remove).toEqual(['git', '-C', '/r', 'worktree', 'remove', spawnedCwd])
    const text = delivered.join('\n')
    expect(text).toContain('Renamed it.')
    expect(text).toMatch(/Branch office\/\S+ \(from abc1234\)/)
    expect(text).toContain('f00d123 rename x to y')
    expect(text).toContain('1 file changed')
    expect(text).toContain('worktree removed, branch kept')
  })

  test('a timed-out worker keeps its worktree: it may still be running (regression)', { options: { jobTimeoutMin: 1 } }, async ($, on) => {
    const runs = fakeRepo(on, { agents: () => '[{"id":"5ac0f0df","state":"working","status":"busy"}]' })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    await clock.advance(61_000)
    expect(runs.some(run => run.argv.includes('stop'))).toBe(true)
    expect(runs.some(run => run.argv.includes('remove'))).toBe(false)
    const text = delivered.join('\n')
    expect(text).toContain('timed out')
    expect(text).toMatch(/Worktree kept at \/cfg\/office\/worktrees\//)
  })

  test('claude --bg exiting 0 with no findable id keeps the worktree (regression)', async ($, on) => {
    const runs = fakeRepo(on, { bg: 'started\n' })
    const r = await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    expect(runs.some(run => run.argv.includes('remove') || run.argv.includes('branch'))).toBe(false)
    expect(JSON.stringify(r)).toMatch(/worktree is kept at \/cfg\/office\/worktrees\//)
  })

  test('a blocked worker seen idle with no reply resumes its timeout (regression)', { options: { jobTimeoutMin: 1 } }, async ($, on) => {
    let state = 'blocked'
    const runs = fakeRepo(on, { agents: () => `[{"id":"5ac0f0df","state":"${state}","status":"idle"}]` })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    // The session start arms the 5 s poll of `claude agents`.
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('tool.register', (_$, e) => ({ value: { tool: `mcp__office__${e.name}` } }))
    on('ui.panes', () => ({ value: [] }))
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    await clock.advance(5_000) // blocked: the timeout pauses
    expect(delivered.join('\n')).toContain('waiting for input')
    state = 'working' // now idle, and no transcript to read a reply from
    await clock.advance(70_000) // the next poll resumes the timeout, a full minute from then
    expect(runs.some(run => run.argv.includes('stop'))).toBe(true)
    expect(delivered.join('\n')).toContain('timed out')
  })
})

describe('--bg worker finish: the [office: done] marker', () => {
  const reply = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  const agent = (state: string, status = 'idle') =>
    `[{"id":"5ac0f0df","sessionId":"S1","cwd":"/r","kind":"background","state":"${state}","status":"${status}"}]`

  // What the session start needs; the start arms the 5 s poll of `claude agents`.
  function stubStart(on: On) {
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('tool.register', (_$, e) => ({ value: { tool: `mcp__office__${e.name}` } }))
    on('ui.panes', () => ({ value: [] }))
  }
  const START = { cwd: '/r', surface: 'terminal', isInteractive: true } as const

  test('a finished worker left at state blocked is done and frees its slot (regression, 2026-10-05)', { options: { maxWorkers: 1 } }, async ($, on) => {
    let state = 'blocked'
    const runs = fakeRepo(on, { agents: () => agent(state), transcript: () => reply('Renamed it.\n\n[office: done]') })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    stubStart(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    await clock.advance(5_000)
    const text = delivered.join('\n')
    expect(text).toContain('Worker finished: rename x to y')
    expect(text).toContain('Renamed it.')
    expect(text).not.toContain('[office: done]')
    expect(text).not.toContain('waiting for input')
    expect(runs.some(run => run.argv.join(' ').endsWith('stop 5ac0f0df'))).toBe(true)
    state = 'stopped' // what `claude stop` leaves: the slot is free for the next worker
    const next = await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'tidy it', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    expect(JSON.stringify(next)).toContain('Started background worker')
  })

  test('a finished worker stopped by hand is done, not failed (regression, 2026-10-05)', async ($, on) => {
    fakeRepo(on, { agents: () => agent('stopped'), transcript: () => reply('Renamed it.\n[office: done]') })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    stubStart(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    await clock.advance(5_000)
    const text = delivered.join('\n')
    expect(text).toContain('Worker finished: rename x to y')
    expect(text).not.toContain('FAILED')
  })

  test('a finished worker removed from the listing is done, not failed (regression, 2026-10-05)', async ($, on) => {
    let listed = agent('working', 'busy')
    let last = reply('Renaming x.')
    fakeRepo(on, { agents: () => listed, transcript: () => last })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    stubStart(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    await clock.advance(5_000) // the poll learns the session id
    last = reply('Renamed it.\n[office: done]')
    listed = '[]'
    await clock.advance(10_000) // gone for two polls
    const text = delivered.join('\n')
    expect(text).toContain('Worker finished: rename x to y')
    expect(text).toContain('Renamed it.')
    expect(text).not.toContain('FAILED')
  })

  test('blocked without the marker still waits for input', async ($, on) => {
    fakeRepo(on, { agents: () => agent('blocked'), transcript: () => reply('Rename x in tests too?') })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    stubStart(on)
    await $.session.start(START)
    await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    await clock.advance(5_000)
    const text = delivered.join('\n')
    expect(text).toContain('is waiting for input')
    expect(text).toContain('Rename x in tests too?')
    expect(text).not.toContain('Worker finished')
  })
})

// No session.append beneath the test: each result is delivered as the prompt.
function collectDelivery(on: On): string[] {
  const delivered: string[] = []
  on('prompt.submit', (_$, e) => {
    delivered.push(e.text)
    return { text: '' }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return delivered
}
