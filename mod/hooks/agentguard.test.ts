import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'

import { pinOf } from './agentguard'
import { MODEL_IDS } from './router'

const RULES = { options: { routerBackend: 'rules' } } // rules: "rename x to y" is haiku/low, "debug the crash" opus/high
const MANAGERS = { '/r': { sessionId: 'sess-A', name: 'lead-a', since: 1 } }
const PARENT = 'claude-opus-5-5'
const ENGINE = { plugin: 'engine', tier: 'core' } as const
const OFFER = { agent: 'general-purpose', description: 'catch-all', source: 'built-in', provider: ENGINE }

const spawnOf = (prompt: string, more: Partial<AgentSpawnInput> = {}): AgentSpawnInput => ({
  tool_use_id: 'toolu_1',
  prompt,
  description: 'a task',
  subagentType: 'general-purpose',
  provider: ENGINE,
  parentModel: PARENT,
  background: false,
  fork: false,
  ...more,
})

// A session (the manager, sess-A, unless told otherwise) at `percent` of its 5-hour window, with no
// agent files on disk; the bottom agent.spawn records what reached it.
function fakeSession(on: On, opts: { percent: number; sessionId?: string }) {
  const reached: AgentSpawnInput[] = []
  const files: Record<string, string> = {}
  mock.store(on, { managers: MANAGERS })
  mock.env(on, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' })
  on('session.id', () => ({ value: opts.sessionId ?? 'sess-A' }))
  on('session.cwd', () => ({ value: '/r' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: opts.percent, resetsAt: '2026-10-06T05:00:00.000Z' }],
    },
  }))
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('agent.offer', () => ({ isOffered: true }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', (_$, e) => {
    reached.push(e)
    return { model: e.model ?? e.parentModel, agentId: 'agent-1' }
  })
  const inbox = () =>
    Object.entries(files)
      .filter(([path]) => path.endsWith('/evals/routing.inbox.jsonl'))
      .flatMap(([, text]) => text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>))
  return { reached, inbox }
}

describe("a manager's Agent calls", () => {
  test('past the hard line every spawn is refused, naming the window and its reset', RULES, async ($, on) => {
    const { reached } = fakeSession(on, { percent: 96 })
    const r = await $.agent.spawn(spawnOf('rename x to y', { model: 'haiku' }))
    expect(r.deny).toContain('5-hour limit is at 96%')
    expect(r.deny).toContain('resets 2026-10-06T05:00:00.000Z')
    expect(reached).toHaveLength(0)
  })

  test('in the soft zone a task routed large is refused and a small one starts, sized', RULES, async ($, on) => {
    const { reached } = fakeSession(on, { percent: 85 })
    await $.agent.offer(OFFER)
    const big = await $.agent.spawn(spawnOf('debug the crash'))
    expect(big.deny).toContain('routed to opus at high effort')
    expect(big.deny).toContain('resets 2026-10-06T05:00:00.000Z')
    const small = await $.agent.spawn(spawnOf('rename x to y'))
    expect(small.deny).toBeUndefined()
    expect(reached.map(e => e.model)).toEqual([MODEL_IDS.haiku])
  })

  test('below the soft line the router sizes it and the inbox logs its start and finish', RULES, async ($, on) => {
    const { reached, inbox } = fakeSession(on, { percent: 10 })
    const clock = mock.clock(on)
    await $.agent.offer(OFFER)
    await $.agent.spawn(spawnOf('debug the crash'))
    expect(reached[0]?.model).toBe(MODEL_IDS.opus)
    await $.turn.complete({ answer: 'fixed', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'agent-1', reason: 'answer' })
    await clock.settle()
    const [start, end] = inbox()
    expect(start).toMatchObject({ kind: 'routed', job: 'toolu_1', task: 'debug the crash', model: 'opus', backend: 'rules' })
    expect(end).toMatchObject({ kind: 'finished', job: 'toolu_1', status: 'done' })
  })

  test('an explicit model is never overridden', RULES, async ($, on) => {
    const { reached, inbox } = fakeSession(on, { percent: 10 })
    await $.agent.offer(OFFER)
    await $.agent.spawn(spawnOf('debug the crash', { model: 'haiku' }))
    expect(reached[0]?.model).toBe('haiku')
    expect(inbox()).toHaveLength(0)
  })

  test("another session's spawns are untouched, even past the hard line", RULES, async ($, on) => {
    const { reached } = fakeSession(on, { percent: 99, sessionId: 'sess-B' })
    await $.agent.offer(OFFER)
    const r = await $.agent.spawn(spawnOf('debug the crash'))
    expect(r.deny).toBeUndefined()
    expect(reached[0]?.model).toBeUndefined()
  })
})

describe('pinOf', () => {
  const base = { isFork: false, type: 'general-purpose', defs: [], isComplete: true, offeredAs: 'built-in' }
  test('a definition that names a model, or one that cannot be read, is never sized', () => {
    expect(pinOf({ ...base, type: 'scout', defs: [{ name: 'scout', model: 'haiku' }] })).toEqual({ by: 'definition', model: 'haiku' })
    expect(pinOf({ ...base, isComplete: false })).toEqual({ by: 'unknown' })
    expect(pinOf({ ...base, type: 'Explore' })).toEqual({ by: 'unknown' })
    expect(pinOf({ ...base, isFork: true })).toEqual({ by: 'fork' })
    expect(pinOf(base)).toEqual({ by: 'none' })
  })
})
