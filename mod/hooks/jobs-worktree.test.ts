import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const RUN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const BASE = 'abc1234def5678abc1234def5678abc1234def56'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const NO_LIMITS = { value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }

// A repo at /r, asked from /r/src; git answers as a clean checkout would, `claude --bg` prints its id
// (or `bg`; `bgExit` its exit code, `bgGate` holds it), `claude agents` lists what `agents()` says;
// `store` seeds $.store (`runs.store` holds it, `runs.sets` the keys written). The capacity lock's perl
// holder takes `runs.flock`, as the kernel's flock would: one holder at a time, the others queued, and
// the lock dropped when the holder's stream ends; `flock.take()` is another session's hold. `flock.expire()`
// is perl's wait running out: every holder still waiting exits 1, printing nothing, and never takes the lock.
// `fake.perl: 'missing'` makes the holder fail to run at all.
type Flock = { expired: Promise<void>; holders: number; most: number; take: { (): Promise<() => void>; (until: Promise<void>): Promise<(() => void) | undefined> }; queued: () => Promise<void>; expire: () => void }
type Runs = { argv: string[]; cwd?: string }[] & { store: Map<string, unknown>; sets: string[]; flock: Flock }
type Fake = { perl?: 'missing'; spawn?: (e: { argv: readonly string[]; cwd?: string }) => AsyncGenerator<{ stream: 'stdout'; text: string }, void>; bg?: string; bgExit?: number; bgGate?: Promise<void>; agents?: () => string; transcript?: () => string; store?: Record<string, unknown> }
function fakeRepo(on: On, fake: Fake = {}): Runs {
  const runs = Object.assign([], { store: new Map(Object.entries(fake.store ?? {})), sets: [] as string[], flock: fakeFlock() }) as Runs
  const { store, flock } = runs
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    runs.sets.push(e.key)
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('process.spawn', async function* (_$, e, next) {
    if (e.argv[0] !== 'perl') {
      if (fake.spawn === undefined) return yield* next(e)
      yield* fake.spawn(e)
      return { value: { code: 0, signal: null } }
    }
    if (fake.perl === 'missing') throw new Error('spawn perl ENOENT')
    const drop = await flock.take(flock.expired)
    if (drop === undefined) return { value: { code: 1, signal: null } }
    try {
      yield { stream: 'stdout' as const, text: 'held\n' }
      await new Promise(() => {}) // held until the stream is ended
      return { value: { code: 0, signal: null } }
    } finally {
      drop()
    }
  })
  mock.env(on, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' })
  on('session.usage', () => NO_LIMITS)
  on('session.cwd', () => ({ value: '/r/src' }))
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    runs.push({ argv, cwd: e.init?.cwd })
    const cmd = argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { ...RUN, stdout, exitCode } })
    if (cmd.includes('--git-common-dir')) return out('/r/.git\n')
    if (cmd.endsWith('rev-parse HEAD')) return out(`${BASE}\n`)
    if (cmd.includes(' log --oneline ')) return out('f00d123 rename x to y\n')
    if (cmd.includes(' diff --stat ')) return out(' src/x.ts | 2 +-\n 1 file changed\n')
    if (argv.includes('--bg')) {
      await fake.bgGate
      return out(fake.bg ?? 'backgrounded · 5ac0f0df\n', fake.bgExit ?? 0)
    }
    if (argv.includes('agents')) return out(fake.agents?.() ?? '[]')
    if (argv[0] === 'tail') return out(fake.transcript?.() ?? '')
    if (argv[0] === 'mktemp') return out('/tmp/office-job.x\n')
    return out('') // worktree add / remove, status: clean
  })
  return runs
}

function fakeFlock(): Flock {
  const waiting: (() => void)[] = []
  let onQueued: (() => void)[] = []
  let expire = () => {}
  const flock: Flock = {
    expired: new Promise<void>(r => { expire = r }),
    expire: () => expire(),
    holders: 0,
    most: 0,
    queued: () => new Promise<void>(r => onQueued.push(r)), // resolves once a taker waits
    take: (async (until?: Promise<void>) => {
      let isExpired = false
      void until?.then(() => { isExpired = true })
      while (flock.holders > 0) {
        let wake = () => {}
        const waited = new Promise<void>(r => { wake = r; waiting.push(r) })
        for (const r of onQueued) r()
        onQueued = []
        await Promise.race([waited, until ?? waited])
        if (isExpired) {
          waiting.splice(waiting.indexOf(wake) >>> 0, 1) // gone from the queue, so a drop wakes a live waiter
          return undefined
        }
      }
      flock.holders++
      flock.most = Math.max(flock.most, flock.holders)
      let isDropped = false
      return () => {
        if (isDropped) return
        isDropped = true
        flock.holders--
        waiting.shift()?.()
      }
    }) as Flock['take'],
  }
  return flock
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
    let spawnedCwd: string | undefined
    const runs = fakeRepo(on, {
      async *spawn(e) {
        spawnedCwd = e.cwd
        yield { stream: 'stdout', text: '{"type":"result","subtype":"success","result":"Renamed it."}\n' }
      },
    })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
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

describe('maxOpusWorkers', () => {
  const OPUS = 'claude-opus-5-5'
  const working = (...ids: string[]) => JSON.stringify(ids.map(id => ({ id, kind: 'background', state: 'working', status: 'busy' })))
  const spawn = ($: Engine, model: string | undefined, task = 'rename x to y') =>
    $.tool.call({ tool: 'mcp__office__spawn_worker', task, ...(model ? { model } : {}), effort: 'low', cwd: '/r/src' })
      .then(r => JSON.stringify(r))
  const bgStarts = (runs: Runs) => runs.filter(run => run.argv.includes('--bg')).length

  test('an Opus or Fable worker is refused at the cap; a Sonnet one still starts', { options: { maxWorkers: 8, maxOpusWorkers: 2 } }, async ($, on) => {
    const runs = fakeRepo(on, {
      agents: () => working('a1', 'b2', '5ac0f0df'),
      store: { bgIds: ['a1', 'b2'], bgModels: { a1: OPUS, b2: 'claude-fable-5-1' } },
    })
    for (const model of ['opus', 'fable', 'claude-mythos-1']) {
      const r = await spawn($, model)
      expect(r).toContain('2 Opus jobs already running (maxOpusWorkers 2); wait for one, pick a cheaper model, or kill one in /jobs.')
    }
    expect(bgStarts(runs)).toBe(0) // refused, never downgraded
    expect(await spawn($, 'sonnet')).toContain('Started background worker')
  })

  test('a router-chosen Opus worker counts toward the cap', { options: { maxWorkers: 8, maxOpusWorkers: 1, routerBackend: 'rules' } }, async ($, on) => {
    const runs = fakeRepo(on, { agents: () => working('5ac0f0df') })
    const first = await spawn($, undefined, 'debug the flaky login test')
    expect(first).toContain(OPUS)
    expect(first).toContain('Started background worker')
    expect(runs.store.get('bgModels')).toEqual({ '5ac0f0df': OPUS })
    expect(await spawn($, undefined, 'debug the race condition in the queue')).toContain('1 Opus jobs already running (maxOpusWorkers 1)')
  })

  test('a running Codex review does not count toward the Opus cap', { options: { maxWorkers: 8, maxOpusWorkers: 1, workerWorktree: 'off' } }, async ($, on) => {
    fakeRepo(on, {
      async *spawn(e) {
        if (e.argv[0] !== 'sh') await new Promise(() => {}) // the review keeps running; the limits read ends at once
      },
    })
    const clock = mock.clock(on)
    const review = await $.tool.call({ tool: 'mcp__office__codex_review', cwd: '/r/src' })
    expect(JSON.stringify(review)).toContain('Started Codex review')
    await clock.advance(0)
    expect(await spawn($, 'opus')).toContain('Started background worker')
  })

  test('maxOpusWorkers 0 (the default) sets no separate limit', { options: { maxWorkers: 8 } }, async ($, on) => {
    fakeRepo(on, { agents: () => working('a1', 'b2', 'c3'), store: { bgIds: ['a1', 'b2', 'c3'], bgModels: { a1: OPUS, b2: OPUS, c3: OPUS } } })
    expect(await spawn($, 'opus')).toContain('Started background worker')
  })

  test('bgIds stays the string[] older versions read; models go in bgModels', { options: { maxWorkers: 2, maxOpusWorkers: 1 } }, async ($, on) => {
    const agents = { list: working('a1') }
    // a1 was started by an older version: no model kept, so it counts as a job but not as Opus.
    const runs = fakeRepo(on, { agents: () => agents.list, store: { bgIds: ['a1'] } })
    expect(await spawn($, 'opus')).toContain('Started background worker')
    const ids = runs.store.get('bgIds')
    expect(ids).toEqual(['a1', '5ac0f0df'])
    // An older version's read (strings only) still sees every id.
    expect(Array.isArray(ids) ? ids.filter(x => typeof x === 'string') : []).toEqual(['a1', '5ac0f0df'])
    expect(runs.store.get('bgModels')).toEqual({ '5ac0f0df': OPUS })
    agents.list = working('a1', '5ac0f0df')
    const writes = runs.sets.length
    expect(await spawn($, 'sonnet')).toContain('2 jobs already running (maxWorkers 2)')
    expect(runs.sets.slice(writes)).toEqual([]) // nothing gone, nothing written
  })

  test('two starts racing for the last Opus slot: exactly one starts (regression)', { options: { maxWorkers: 8, maxOpusWorkers: 1, routerBackend: 'claude' } }, async ($, on) => {
    let openRoute = () => {}
    let openBg = () => {}
    const routeGate = new Promise<void>(r => { openRoute = r })
    const runs = fakeRepo(on, { agents: () => working('5ac0f0df'), bgGate: new Promise<void>(r => { openBg = r }) })
    const clock = mock.clock(on)
    let routing = false
    on('model.complete', async () => {
      routing = true
      await routeGate
      return { value: { isAnswered: true as const, text: '{"model":"opus","effort":"high","confidence":0.9,"reason":"debugging"}', usage: USAGE } }
    })
    // A passes the first check (nothing running), then waits on its route...
    const routed = spawn($, undefined, 'debug the flaky login test')
    await clock.settle()
    expect(routing).toBe(true)
    // ...while B, on Opus by name, reserves the slot and starts.
    const named = spawn($, 'opus')
    await clock.settle()
    expect(bgStarts(runs)).toBe(1)
    openRoute()
    expect(await routed).toContain('1 Opus jobs already running (maxOpusWorkers 1)')
    openBg()
    expect(await named).toContain('Started background worker')
    expect(bgStarts(runs)).toBe(1)
    expect(runs.store.get('reservedSlots')).toEqual([])
  })

  test('a start that fails gives its reserved slot back', { options: { maxWorkers: 8, maxOpusWorkers: 1 } }, async ($, on) => {
    const runs = fakeRepo(on, { bgExit: 1, bg: 'not logged in' })
    expect(await spawn($, 'opus')).toContain('claude --bg did not start')
    expect(runs.store.get('reservedSlots')).toEqual([])
    expect(await spawn($, 'opus')).not.toContain('Opus jobs already running')
  })

  test('a reservation left by a crashed start expires', { options: { maxWorkers: 8, maxOpusWorkers: 1 } }, async ($, on) => {
    const runs = fakeRepo(on, { store: { reservedSlots: [{ id: 'gone.1', isOpus: true, until: Date.now() - 1 }] } })
    expect(await spawn($, 'opus')).toContain('Started background worker')
    // One still in time holds its slot. (5ac0f0df is not listed, so it is pruned and does not count.)
    runs.store.set('reservedSlots', [{ id: 'held.2', isOpus: true, until: Date.now() + 60_000 }])
    expect(await spawn($, 'opus')).toContain('1 Opus jobs already running (maxOpusWorkers 1)')
  })

  test('pruning keeps an id another session registered during the listing; gone ids lose their models (regression)', { options: { maxWorkers: 8 } }, async ($, on) => {
    const runs = fakeRepo(on, {
      store: { bgIds: ['a1', 'b2'], bgModels: { a1: OPUS, b2: OPUS } },
      agents: () => {
        // Another session registers c3 while `claude agents` runs; b2 has gone.
        runs.store.set('bgIds', [...(runs.store.get('bgIds') as string[]), 'c3'])
        runs.store.set('bgModels', { ...(runs.store.get('bgModels') as object), c3: 'claude-sonnet-5-5' })
        return working('a1')
      },
    })
    expect(await spawn($, 'sonnet')).toContain('Started background worker')
    expect(runs.store.get('bgIds')).toEqual(['a1', 'c3', '5ac0f0df'])
    expect(runs.store.get('bgModels')).toEqual({ a1: OPUS, c3: 'claude-sonnet-5-5', '5ac0f0df': 'claude-sonnet-5-5' })
  })

  test('the capacity lock is the kernel\'s: a live holder is waited for within the wait, never taken over (regression)', { options: { maxOpusWorkers: 1 } }, async ($, on) => {
    const runs = fakeRepo(on)
    const clock = mock.clock(on)
    const drop = await runs.flock.take() // another session holds it, and is slow
    const first = spawn($, 'opus')
    const second = spawn($, 'sonnet', 'tidy it')
    await clock.advance(10_000) // far past the old takeover age, short of the 15 s wait
    expect(bgStarts(runs)).toBe(0)
    expect(runs.some(run => ['mv', 'rm', 'rmdir'].includes(run.argv[0] ?? ''))).toBe(false)
    drop()
    expect(await first).toContain('Started background worker')
    expect(await second).toContain('Started background worker')
    expect(runs.flock.most).toBe(1) // one holder at a time
    expect(runs.flock.holders).toBe(0) // each hold ended with its holder
  })

  test('a lock held past the wait refuses the start: no worker, no reservation, no orphaned holder (regression)', { options: { maxOpusWorkers: 1 } }, async ($, on) => {
    const runs = fakeRepo(on)
    const clock = mock.clock(on)
    const drop = (await runs.flock.take()) // another session holds it, and stays slow
    const starting = spawn($, 'opus')
    await clock.advance(10_000)
    runs.flock.expire() // perl's 15 s wait runs out
    expect(await starting).toContain('office capacity lock busy; try again in a moment')
    drop() // the slow holder lets go: the waiter's holder must not take the lock now
    await clock.settle()
    expect(bgStarts(runs)).toBe(0)
    expect(runs.sets).not.toContain('reservedSlots')
    expect(runs.flock.holders).toBe(0)
  })

  test('with perl unavailable there is no cross-session lock: the start goes on, logged loudly once', { options: { maxOpusWorkers: 1 } }, async ($, on) => {
    const runs = fakeRepo(on, { perl: 'missing' })
    const logged: string[] = []
    on('ui.log', (_$, e) => {
      logged.push(e.text)
      return { value: undefined }
    })
    expect(await spawn($, 'opus')).toContain('Started background worker')
    expect(await spawn($, 'sonnet', 'tidy it')).toContain('Started background worker')
    expect(bgStarts(runs)).toBe(2)
    expect(logged.filter(line => line.includes('no cross-session capacity lock'))).toHaveLength(1)
  })

  test('a slow start keeps its slot past one reservation\'s life (regression)', { options: { maxWorkers: 8, maxOpusWorkers: 1 } }, async ($, on) => {
    let openBg = () => {}
    const runs = fakeRepo(on, { agents: () => working('5ac0f0df'), bgGate: new Promise<void>(r => { openBg = r }) })
    const clock = mock.clock(on)
    const slow = spawn($, 'opus')
    await clock.settle()
    expect(bgStarts(runs)).toBe(1)
    await clock.advance(4 * 60_000) // --bg still starting, past RESERVATION_MS and the old 3 min
    expect(await spawn($, 'opus', 'tidy it')).toContain('1 Opus jobs already running (maxOpusWorkers 1)')
    openBg()
    expect(await slow).toContain('Started background worker')
    expect(runs.store.get('reservedSlots')).toEqual([])
  })

  test('a worker another session is registering counts once (regression)', { options: { maxWorkers: 2 } }, async ($, on) => {
    // Mid-registration, under its lock: the other session's worker is in bgIds and still holds its reservation.
    const runs = fakeRepo(on, {
      agents: () => working('x1', '5ac0f0df'),
      store: { bgIds: ['x1'], reservedSlots: [{ id: 'j1.ab12cd', isOpus: false, until: Number.MAX_SAFE_INTEGER }] },
    })
    const drop = await runs.flock.take()
    const queued = runs.flock.queued()
    const started = spawn($, 'sonnet')
    await queued
    runs.store.set('reservedSlots', []) // its registration done,
    drop() // it lets go of the lock
    expect(await started).toContain('Started background worker')
  })

  test('a headless worker mid-handoff counts once (regression)', { options: { maxWorkers: 2, workerWorktree: 'off' } }, async ($, on) => {
    const runs = fakeRepo(on, {
      async *spawn() {
        await new Promise(() => {}) // the worker runs on
      },
    })
    const clock = mock.clock(on)
    const start = (task: string, mode: string) =>
      $.tool.call({ tool: 'mcp__office__spawn_worker', task, mode, model: 'sonnet', effort: 'low', cwd: '/r/src' }).then(r => JSON.stringify(r))
    expect(await start('rename x to y', 'headless')).toContain('Started headless worker')
    // The next start waits on the lock (another session holds it)...
    const drop = await runs.flock.take()
    const queued = runs.flock.queued()
    const next = start('tidy it', 'bg')
    await queued
    // ...while the first worker joins RUNNING and its slot's release queues behind that start.
    await clock.settle()
    drop()
    expect(await next).toContain('Started background worker')
  })
})

// A result reaches the model as an appended user row (the full text) plus, when the main loop is idle, a
// submitted nudge. Both are collected; a refused append would fall back to submitting the full text.
function collectDelivery(on: On): string[] {
  const delivered: string[] = []
  on('session.append', (_$, e, next) => {
    for (const block of e.message.content) {
      if (block.type === 'text' && typeof block.text === 'string') delivered.push(block.text)
    }
    return next(e)
  })
  on('prompt.submit', (_$, e) => {
    delivered.push(e.text)
    return { text: '' }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return delivered
}
