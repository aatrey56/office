import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const RUN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const BASE = 'abc1234def5678abc1234def5678abc1234def56'
const OTHER = 'feed123def5678abc1234def5678abc1234def56'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const NO_LIMITS = { value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }

// A repo at /r, asked from /r/src; git answers as a clean checkout would, `claude --bg` prints its id
// (or `bg`; `bgExit` its exit code, `bgGate` holds it), `claude agents` lists what `agents()` says;
// `branches` exist (show-ref finds them), `worktrees` is `git worktree list --porcelain`; any `<x>^{commit}` is OTHER;
// `afterStop` is what `claude agents` prints once a stop was asked (`'slow'`: its first runs out its timeout on `wait`, the mock clock's sleep, exiting 124);
// `whole` is the whole transcript `grep` searches (default: `transcript()`);
// `dirty` leaves src/x.ts and big.bin uncommitted until a commit (exiting `commitExit`) takes them;
// `noHead`: a repo with no commits (rev-parse HEAD fails); `staged` lists what `diff --cached` shows while dirty; `claude stop <id>` lists that session as stopped from then on, unless `stopIgnored`;
// `store` seeds $.store (`runs.store` holds it, `runs.sets` the keys written). The capacity lock's perl
// holder takes `runs.flock`, as the kernel's flock would: one holder at a time, the others queued, and
// the lock dropped when the holder's stream ends; `flock.take()` is another session's hold. `flock.expire()`
// is perl's wait running out: every holder still waiting exits 1, printing nothing, and never takes the lock.
// `fake.perl: 'missing'` makes the holder fail to run at all.
// The gate: `checksFile` is .office/checks in the base commit (absent: `git show` fails), `check(line)` answers each
// `sh -c` line (default exit 0), `head` is the worktree's branch (default the one it was made on), `commits` counts base..branch (1).
type Flock = { expired: Promise<void>; holders: number; most: number; take: { (): Promise<() => void>; (until: Promise<void>): Promise<(() => void) | undefined> }; queued: () => Promise<void>; expire: () => void }
type Runs = { argv: string[]; cwd?: string }[] & { store: Map<string, unknown>; sets: string[]; flock: Flock }
type Check = (line: string) => { code: number; out?: string } | Promise<{ code: number; out?: string }>
type Fake = { checksFile?: string; check?: Check; head?: string; commits?: number; perl?: 'missing'; spawn?: (e: { argv: readonly string[]; cwd?: string }) => AsyncGenerator<{ stream: 'stdout'; text: string }, void>; bg?: string | (() => string); bgExit?: number; bgGate?: Promise<void>; agents?: () => string; rawAgents?: { stdout: string; isStdoutTruncated?: boolean }; transcript?: () => string; store?: Record<string, unknown>; branches?: string[]; worktrees?: string; dirty?: boolean; commitExit?: number; stopIgnored?: boolean; staged?: string[]; noHead?: boolean; afterStop?: string; wait?: (ms: number) => Promise<void>; whole?: () => string }
function fakeRepo(on: On, fake: Fake = {}): Runs {
  const runs = Object.assign([], { store: new Map(Object.entries(fake.store ?? {})), sets: [] as string[], flock: fakeFlock() }) as Runs
  const { store, flock } = runs
  let isDirty = fake.dirty === true
  const stopped = new Set<string>()
  let isStopAsked = false
  let isSlowDone = false
  let madeBranch = ''
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    runs.sets.push(e.key)
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('process.spawn', async function* (_$, e, next) {
    if (e.argv[0] === 'sh' && e.argv[1] === '-c') {
      runs.push({ argv: [...e.argv], cwd: e.cwd })
      const r: { code: number; out?: string } = await (fake.check ?? (() => ({ code: 0 })))(e.argv[2] ?? '')
      if (r.out) yield { stream: 'stdout' as const, text: r.out }
      return { value: { code: r.code, signal: null } }
    }
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
    if (argv.includes('worktree') && argv.includes('add')) madeBranch = argv[argv.indexOf('-b') + 1] ?? ''
    if (argv.includes('--show-current')) return out(`${fake.head ?? madeBranch}\n`)
    if (argv.includes('rev-list')) return out(`${fake.commits ?? 1}\n`)
    if (argv[3] === 'show') return fake.checksFile === undefined ? out('', 128) : out(fake.checksFile)
    if (cmd.endsWith('rev-parse HEAD')) return fake.noHead ? out('', 128) : out(`${BASE}\n`)
    if (cmd.endsWith('^{commit}')) return out(`${OTHER}\n`)
    if (argv.includes('show-ref')) return out('', fake.branches?.some(b => cmd.endsWith(`refs/heads/${b}`)) ? 0 : 1)
    if (cmd.endsWith('worktree list --porcelain')) return out(fake.worktrees ?? '')
    if (cmd.includes(' log --oneline ')) return out('f00d123 rename x to y\n')
    if (cmd.includes(' diff --stat ')) return out(' src/x.ts | 2 +-\n 1 file changed\n')
    if (argv.includes('--bg')) {
      await fake.bgGate
      return out((typeof fake.bg === 'function' ? fake.bg() : fake.bg) ?? 'backgrounded · 5ac0f0df\n', fake.bgExit ?? 0)
    }
    if (argv[1] === 'stop') isStopAsked = true
    if (argv[1] === 'stop' && !fake.stopIgnored) stopped.add(argv[2] ?? '')
    if (argv.includes('agents') && isStopAsked && fake.afterStop === 'slow' && !isSlowDone) {
      isSlowDone = true
      await fake.wait?.(e.init?.timeoutMs ?? 30000)
      return out('', 124)
    }
    if (argv.includes('agents') && isStopAsked && fake.afterStop !== undefined && fake.afterStop !== 'slow') return out(fake.afterStop)
    if (argv.includes('agents') && fake.rawAgents !== undefined) return { value: { ...RUN, ...fake.rawAgents } }
    if (argv.includes('agents')) {
      const listed = JSON.parse(fake.agents?.() ?? '[]') as { id: string; state?: string }[]
      return out(JSON.stringify(listed.map(a => (stopped.has(a.id) ? { ...a, state: 'stopped' } : a))))
    }
    if (argv[0] === 'tail') return out(fake.transcript?.() ?? '')
    if (argv[0] === 'grep') return out('', (fake.whole ?? fake.transcript)?.().includes(argv.at(-2) ?? '') ? 0 : 1)
    if (argv[0] === 'mktemp') return out('/tmp/office-job.x\n')
    if (cmd.endsWith('status --porcelain')) return out(isDirty ? ' M src/x.ts\n?? big.bin\n' : '')
    if (argv.includes('ls-files')) return out(isDirty ? 'src/x.ts\0big.bin\0' : '')
    if (cmd.includes(' diff --cached ')) return out(isDirty ? (fake.staged ?? []).map(p => `${p}\0`).join('') : '')
    if (argv.includes('commit')) {
      isDirty = (fake.commitExit ?? 0) !== 0
      return out(isDirty ? '' : '[x 1234567] WIP', fake.commitExit ?? 0)
    }
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

  test('base and branch: the worktree starts from that commit on that branch, and the worker is told never to switch', async ($, on) => {
    const runs = fakeRepo(on)
    const r = await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src', base: 'release', branch: 'fix/rename' })
    const add = runs.find(run => run.argv.includes('worktree') && run.argv.includes('add'))?.argv ?? []
    expect(add[add.indexOf('-b') + 1]).toBe('fix/rename')
    expect(add.at(-1)).toBe(OTHER)
    const task = runs.find(run => run.argv.includes('--bg'))?.argv.at(-1) ?? ''
    expect(task).toContain('already on your own branch fix/rename')
    expect(task).toContain('Never switch, create or rename branches')
    expect(JSON.stringify(r.result)).toContain('Own branch fix/rename (from feed123)')
  })

  test('a branch asked for in a repo with no commits is refused, never started in the shared checkout', async ($, on) => {
    const runs = fakeRepo(on, { noHead: true })
    const r = await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src', branch: 'fix/rename' })
    expect(JSON.stringify(r)).toContain('Worker not started: git rev-parse HEAD')
    expect(runs.some(run => run.argv.includes('--bg'))).toBe(false)
  })

  test('a branch that exists or is checked out elsewhere is refused before anything starts', async ($, on) => {
    const runs = fakeRepo(on, { branches: ['main', 'taken'], worktrees: 'worktree /r\nHEAD abc\nbranch refs/heads/main\n' })
    const spawn = (branch: string) =>
      $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src', branch }).then(r => JSON.stringify(r))
    expect(await spawn('main')).toContain('Branch main is checked out in /r')
    expect(await spawn('taken')).toContain('Branch taken already exists')
    expect(runs.some(run => run.argv.includes('add') || run.argv.includes('--bg'))).toBe(false)
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

describe('watchdog: deadline, blocked limit, stalled worker', () => {
  const turn = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  const agent = (state: string, status = 'busy') =>
    `[{"id":"5ac0f0df","sessionId":"S1","cwd":"/r","kind":"background","state":"${state}","status":"${status}"}]`
  const spawn = ($: Engine) => $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src' })
  async function start($: Engine, on: On) {
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('tool.register', (_$, e) => ({ value: { tool: `mcp__office__${e.name}` } }))
    on('ui.panes', () => ({ value: [] }))
    // big.bin is 6 MB; everything else is small.
    on('fs.stat', (_$, e) => ({ value: { kind: 'file' as const, size: e.path.endsWith('big.bin') ? 6 * 1024 * 1024 : 10, mtimeMs: 0, isLink: false } }))
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  }
  const stops = (runs: Runs) => runs.filter(run => run.argv.join(' ').endsWith('stop 5ac0f0df')).length

  test('still writing at the deadline: extended once, then ended with its work committed as WIP and the worktree kept', { options: { jobTimeoutMin: 1, jobTimeoutHardMin: 2 } }, async ($, on) => {
    let turns = 0
    const runs = fakeRepo(on, { agents: () => agent('working'), transcript: () => turn(`step ${++turns}`), dirty: true })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    await start($, on)
    await spawn($)
    await clock.advance(61_000)
    expect(stops(runs)).toBe(0) // its transcript grew: extended to 2 min
    await clock.advance(60_000)
    expect(stops(runs)).toBe(1)
    const add = runs.find(run => run.argv.includes('add') && run.argv.includes('-A'))?.argv ?? []
    expect(add.at(-1)).toBe(':(exclude,literal)big.bin')
    const commit = runs.find(run => run.argv.includes('commit'))?.argv ?? []
    expect(commit.slice(-2)).toEqual(['-m', 'WIP: timed out at 2 min (office)'])
    expect(commit).not.toContain('--no-verify')
    expect(runs.some(run => run.argv.includes('remove'))).toBe(false)
    const text = delivered.join('\n')
    expect(text).toContain('timed out after 2 min (jobTimeoutHardMin): extended once at 1 min')
    expect(text).toContain('committed on its branch as "WIP: timed out at 2 min (office)"')
    expect(text).toContain('Left out, over 5 MB (uncommitted in the worktree): big.bin')
    expect(text).toMatch(/Worktree kept at \/cfg\/office\/worktrees\//)
  })

  test('a failed WIP commit keeps the worktree and says so', { options: { jobTimeoutMin: 1 } }, async ($, on) => {
    const runs = fakeRepo(on, { agents: () => agent('working'), transcript: () => turn('step'), dirty: true, commitExit: 1 })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    await start($, on)
    await spawn($)
    await clock.advance(61_000) // a transcript that never changed: no extension
    const text = delivered.join('\n')
    expect(text).toContain('timed out after 1 min (jobTimeoutMin); not extended')
    expect(text).toContain('WIP commit failed')
    expect(text).toMatch(/Uncommitted changes left in \/cfg\/office\/worktrees\//)
    expect(runs.some(run => run.argv.includes('remove'))).toBe(false)
  })

  test('a reload keeps a granted extension: the re-adopted job runs on to jobTimeoutHardMin', { options: { jobTimeoutMin: 1, jobTimeoutHardMin: 2 } }, async ($, on) => {
    const runs = fakeRepo(on, { agents: () => agent('working'), transcript: () => turn('step') })
    const clock = mock.clock(on, { now: 61_000 })
    const job = { id: 'j1', kind: 'worker', title: 'rename x to y', cwd: '/r', status: 'running', startedAt: 0, mode: 'bg', bgId: '5ac0f0df', tail: '', isExtended: true }
    // The record the last load left, read until the first write of the jobs.
    let left: unknown = [job]
    on('state.set', (_$, e, next) => {
      if (e.key === 'jobs') left = undefined
      return next(e)
    })
    on('state.get', (_$, e, next) => (left !== undefined && e.key === 'jobs' ? { value: { value: left, version: 0 } } : next(e)))
    await start($, on)
    await clock.advance(30_000)
    expect(stops(runs)).toBe(0)
    await clock.advance(30_000)
    expect(stops(runs)).toBe(1)
  })

  test('an oversized file the worker staged is unstaged and left out of the WIP commit', { options: { jobTimeoutMin: 1 } }, async ($, on) => {
    const runs = fakeRepo(on, { agents: () => agent('working'), transcript: () => turn('step'), dirty: true, staged: ['out/staged-big.bin'] })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    await start($, on)
    await spawn($)
    await clock.advance(61_000)
    const at = (pred: (a: string[]) => boolean) => runs.findIndex(run => pred(run.argv))
    const reset = at(a => a.includes('reset'))
    expect(runs[reset]?.argv.slice(-3)).toEqual(['--', ':(literal)big.bin', ':(literal)out/staged-big.bin'])
    expect(reset).toBeLessThan(at(a => a.includes('commit')))
    expect(runs[at(a => a.includes('add') && a.includes('-A'))]?.argv).toContain(':(exclude,literal)out/staged-big.bin')
    expect(delivered.join('\n')).toContain('Left out, over 5 MB (uncommitted in the worktree): big.bin, out/staged-big.bin')
  })

  test('a worker not confirmed stopped: its work is left uncommitted and the worktree kept', { options: { jobTimeoutMin: 1 } }, async ($, on) => {
    const runs = fakeRepo(on, { agents: () => agent('working'), transcript: () => turn('step'), dirty: true, stopIgnored: true })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    await start($, on)
    await spawn($)
    await clock.advance(61_000)
    expect(stops(runs)).toBe(1)
    expect(delivered.join('\n')).not.toContain('Worker FAILED') // still waiting to see it stop
    await clock.advance(30_000)
    const text = delivered.join('\n')
    expect(text).toContain('Could not confirm the worker stopped; its work was left uncommitted in /cfg/office/worktrees/')
    expect(runs.some(run => run.argv.includes('commit') || (run.argv.includes('add') && run.argv.includes('-A')))).toBe(false)
    expect(runs.some(run => run.argv.includes('remove'))).toBe(false)
  })

  test('a malformed listing after a failed stop is no proof it stopped: nothing is committed (regression)', { options: { jobTimeoutMin: 1 } }, async ($, on) => {
    const runs = fakeRepo(on, { agents: () => agent('working'), transcript: () => turn('step'), dirty: true, stopIgnored: true, afterStop: '[{"id":"5ac0f0df","st' })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    await start($, on)
    await spawn($)
    await clock.advance(91_000)
    expect(delivered.join('\n')).toContain('Could not confirm the worker stopped')
    expect(runs.some(run => run.argv.includes('commit'))).toBe(false)
  })

  test('confirming a stop keeps to its time, a slow listing included, and never holds the other workers\' polls (regression)', { options: { blockedTimeoutMin: 1 } }, async ($, on) => {
    const clock = mock.clock(on)
    const ids = ['5ac0f0df', '7bd1e0aa']
    // The first worker stays blocked; the second finishes at 128 s, while the first's stop is being confirmed.
    const listing = () => `[{"id":"5ac0f0df","sessionId":"S1","cwd":"/r","kind":"background","state":"blocked","status":"idle"},{"id":"7bd1e0aa","sessionId":"S2","cwd":"/r","kind":"background","state":"${clock.now() < 128_000 ? 'working' : 'done'}","status":"busy"}]`
    fakeRepo(on, { bg: () => `backgrounded · ${ids.shift()}\n`, agents: listing, transcript: () => turn('May I run npm install?'), stopIgnored: true, afterStop: 'slow', wait: ms => clock.sleep(ms) })
    const delivered = collectDelivery(on)
    await start($, on)
    await spawn($)
    await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'add a test', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    await clock.advance(125_000) // the first: blocked at 5 s, ended at twice blockedTimeoutMin; its first listing then takes 20 s
    await clock.advance(10_000)
    expect(delivered.join('\n')).toContain('Worker finished: add a test')
    expect(delivered.join('\n')).not.toContain('Could not confirm')
    await clock.advance(15_000)
    expect(delivered.join('\n')).toContain('Could not confirm the worker stopped')
  })

  test('blocked past blockedTimeoutMin: reported once; ended at twice it', { options: { blockedTimeoutMin: 1 } }, async ($, on) => {
    const runs = fakeRepo(on, { agents: () => agent('blocked', 'idle'), transcript: () => turn('May I run npm install?') })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    await start($, on)
    await spawn($)
    await clock.advance(5_000)
    expect(delivered.join('\n')).toContain('is waiting for input')
    await clock.advance(90_000)
    const reports = () => delivered.filter(t => t.includes('(blockedTimeoutMin 1)')).length
    expect(reports()).toBe(1)
    expect(stops(runs)).toBe(0)
    await clock.advance(30_000)
    expect(stops(runs)).toBe(1)
    expect(reports()).toBe(1)
    expect(delivered.join('\n')).toContain('Worker FAILED: rename x to y')
    expect(delivered.join('\n')).toContain('waiting for approval or input (twice blockedTimeoutMin 1)')
  })

  test('a turn seen once is remembered: a tail that later holds none is not stalled', async ($, on) => {
    let reads = 0
    const tool = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(1000) }] } })
    fakeRepo(on, { agents: () => agent('working'), transcript: () => (++reads === 1 ? turn('Reading the code.') : tool) })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    await start($, on)
    await spawn($)
    await clock.advance(7 * 60_000)
    expect(reads).toBeGreaterThan(1)
    expect(delivered.join('\n')).not.toContain('may be stalled')
  })

  test('a turn the tail never saw, pushed out by a big tool result between polls, is found in the whole transcript (regression)', async ($, on) => {
    const tool = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(1000) }] } })
    fakeRepo(on, { agents: () => agent('working'), transcript: () => tool, whole: () => `${turn('Reading the code.')}\n${tool}` })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    await start($, on)
    await spawn($)
    await clock.advance(7 * 60_000)
    expect(delivered.join('\n')).not.toContain('may be stalled')
  })

  test('no assistant turn 5 min after the start: reported as stalled once, not ended', async ($, on) => {
    const runs = fakeRepo(on, { agents: () => agent('working') })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    await start($, on)
    await spawn($)
    await clock.advance(4 * 60_000)
    expect(delivered.join('\n')).not.toContain('may be stalled')
    await clock.advance(3 * 60_000)
    expect(delivered.filter(t => t.includes('may be stalled') && t.includes('spawn it again'))).toHaveLength(1)
    expect(stops(runs)).toBe(0)
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

describe('the worker gate', () => {
  const reply = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Renamed it.\n[office: done]' }] } })
  const listing = '[{"id":"5ac0f0df","sessionId":"S1","cwd":"/r","kind":"background","state":"working","status":"idle"}]'
  const CHECKS = '# fast gate checks\ntsc\nnpm test\nlint\n'
  // A --bg worker that says it is done on the first poll; the gate runs in the timer that poll arms.
  async function finish($: Engine, on: On, fake: Fake = {}, input: Record<string, unknown> = {}) {
    const runs = fakeRepo(on, { agents: () => listing, transcript: () => reply, ...fake })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('tool.register', (_$, e) => ({ value: { tool: `mcp__office__${e.name}` } }))
    on('ui.panes', () => ({ value: [] }))
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    const started = await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', model: 'sonnet', effort: 'low', cwd: '/r/src', ...input })
    const id = /job (\w+)/.exec(JSON.stringify(started))?.[1] ?? ''
    await clock.advance(5_000)
    return { runs, clock, id, text: () => delivered.join('\n') }
  }
  const checksRun = (runs: Runs) => runs.filter(r => r.argv[0] === 'sh').map(r => r.argv[2])
  const removed = (runs: Runs) => runs.some(r => r.argv.includes('worktree') && r.argv.includes('remove'))

  test('green checks: done, CHECKS PASSED in the head, the worktree removed; the session stopped before the checks', async ($, on) => {
    const { runs, id, text } = await finish($, on, { checksFile: CHECKS })
    expect(text()).toContain(`Worker finished: rename x to y (job ${id}) · CHECKS PASSED (3/3, 0s)`)
    expect(checksRun(runs)).toEqual(['tsc', 'npm test', 'lint'])
    expect(runs.find(r => r.argv[0] === 'sh')?.cwd).toMatch(/^\/cfg\/office\/worktrees\//)
    const at = (pred: (a: string[]) => boolean) => runs.findIndex(r => pred(r.argv))
    expect(at(a => a.join(' ').endsWith('stop 5ac0f0df'))).toBeLessThan(at(a => a[0] === 'sh'))
    expect(removed(runs)).toBe(true)
    expect(runs.store.get('gates')).toMatchObject({ [`office/${id}-rename-x-to-y`]: { sha: BASE, verdict: 'pass' } })
  })

  test('a red check, red again on its re-run: rejected with the command and output tail, the worktree kept, the slot freed', { options: { maxWorkers: 1 } }, async ($, on) => {
    const check: Check = line => (line === 'npm test' ? { code: 1, out: 'ok 1\nnot ok 2 login fails\n' } : { code: 0 })
    const { runs, id, text } = await finish($, on, { checksFile: CHECKS, check })
    expect(text()).toContain(`Worker REJECTED: CHECKS FAILED: \`npm test\` exit 1 · rename x to y (job ${id})`)
    expect(text()).toContain('$ npm test\nexit 1 after 0s (and again on its re-run)\nok 1\nnot ok 2 login fails')
    expect(text()).toContain("Worker's report:\nRenamed it.")
    expect(checksRun(runs)).toEqual(['tsc', 'npm test', 'npm test']) // lint never runs
    expect(removed(runs)).toBe(false)
    expect(text()).toMatch(/Worktree kept at \/cfg\/office\/worktrees\//)
    const next = await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'tidy it', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    expect(JSON.stringify(next)).toContain('Started background worker')
  })

  test('a dirty worktree is rejected as uncommitted, before any check runs', async ($, on) => {
    const { runs, text } = await finish($, on, { checksFile: CHECKS, dirty: true })
    expect(text()).toContain('Worker REJECTED: uncommitted changes in the worktree · rename x to y')
    expect(checksRun(runs)).toEqual([])
    expect(removed(runs)).toBe(false)
  })

  test('the checks are read from the base commit, never from the worktree', async ($, on) => {
    const read: string[] = []
    on('fs.read', (_$, e) => {
      read.push(e.path)
      return { value: '' }
    })
    const { runs } = await finish($, on, { checksFile: CHECKS })
    expect(runs.some(r => r.argv.join(' ') === `git -C /r show ${BASE}:.office/checks`)).toBe(true)
    expect(read.some(path => path.endsWith('.office/checks'))).toBe(false)
  })

  test('no checks file in the base commit: done, UNVERIFIED in the head', async ($, on) => {
    const { runs, text } = await finish($, on)
    expect(text()).toContain('· UNVERIFIED: no .office/checks in the base commit abc1234')
    expect(checksRun(runs)).toEqual([])
  })

  test('a report deliverable with no commits is done: no code changes, checks not run', async ($, on) => {
    const { runs, text } = await finish($, on, { checksFile: CHECKS, commits: 0 }, { deliverable: 'report' })
    expect(text()).toContain('Worker finished: rename x to y')
    expect(text()).toContain('· no code changes, checks not run')
    expect(checksRun(runs)).toEqual([])
  })

  test('a headless worker exiting 0 still goes through the gate (regression)', async ($, on) => {
    const runs = fakeRepo(on, {
      checksFile: CHECKS,
      check: line => ({ code: line === 'tsc' ? 2 : 0 }),
      async *spawn() {
        yield { stream: 'stdout', text: '{"type":"result","subtype":"success","result":"All tests pass."}\n' }
      },
    })
    const clock = mock.clock(on)
    const delivered = collectDelivery(on)
    await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', mode: 'headless', model: 'sonnet', effort: 'low', cwd: '/r/src' })
    await clock.settle()
    expect(delivered.join('\n')).toContain('Worker REJECTED: CHECKS FAILED: `tsc` exit 2')
    expect(removed(runs)).toBe(false)
  })

  test('a kill during the checks fails the job once; the gate never delivers after it', async ($, on) => {
    let release = () => {}
    const hung = new Promise<{ code: number }>(r => { release = () => r({ code: 0 }) })
    const { runs, clock, id, text } = await finish($, on, { checksFile: CHECKS, check: line => (line === 'npm test' ? hung : { code: 0 }) })
    expect(text()).not.toContain('Worker finished')
    const ui = await $.ui.mount({
      plugin: 'office',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'jobs',
      props: { title: 'Jobs', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } },
    } as Parameters<typeof $.ui.mount>[0])
    await ui.press({ key: `job-${id}` })
    await ui.press({ key: 'kill' })
    release() // the check under way ends now: its gate must not finish the job again
    await clock.advance(10_000)
    await ui.unmount()
    const heads = text().split('\n').filter(l => l.startsWith('Worker '))
    expect(heads.filter(l => l.includes(`(job ${id})`))).toEqual([`Worker FAILED: rename x to y (job ${id})`])
    expect(text()).toContain("killed during its checks.\n\nWorker's report (unchecked):\nRenamed it.")
    expect(checksRun(runs)).toEqual(['tsc', 'npm test'])
    expect(removed(runs)).toBe(false)
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

  for (const [what, rawAgents] of [['malformed', { stdout: '[{"id":"a1","kind":"back' }], ['truncated', { stdout: '[]', isStdoutTruncated: true }]] as const) {
    test(`a ${what} listing proves nothing: no stored id is pruned, the caps still count them (regression)`, { options: { maxWorkers: 2 } }, async ($, on) => {
      const runs = fakeRepo(on, { rawAgents, store: { bgIds: ['a1', 'b2'], bgModels: { a1: OPUS, b2: OPUS } } })
      expect(await spawn($, 'sonnet')).toContain('Started background worker')
      expect(runs.store.get('bgIds')).toEqual(['a1', 'b2', '5ac0f0df'])
    })
  }

  test('a truncated listing is not searched for a worker whose --bg printed no id (regression)', { options: { workerWorktree: 'off' } }, async ($, on) => {
    const startedAt = Date.now() + 60000
    fakeRepo(on, { bg: 'started\n', rawAgents: { stdout: JSON.stringify([{ id: 'c3', kind: 'background', cwd: '/r/src', startedAt }]), isStdoutTruncated: true } })
    expect(await spawn($, 'sonnet')).toContain('gave no session id')
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
