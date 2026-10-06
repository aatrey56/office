import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { foldInbox } from './inbox'

const RUN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const OPTIONS = { options: { routerBackend: 'rules', workerWorktree: 'off' } }

const CONFIG = '/fake/config'
const ASK = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

// A headless worker outside any repo, with a fake config dir; files are in memory, and the
// plugin folder's evals/ is filed under `plugin:evals/`.
function fakeWorker(on: On, files: Record<string, string> = {}) {
  const key = (path: string) => (path.startsWith(CONFIG) ? path : path.replace(/^.*\/evals\//, 'plugin:evals/'))
  on('env.get', (_$, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? CONFIG : undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.cwd', () => ({ value: '/r' }))
  on('store.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { ...RUN, exitCode: 1 } }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"type":"result","subtype":"success","result":"Renamed it.","total_cost_usd":0.25}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('fs.exists', (_$, e) => ({ value: key(e.path) in files }))
  on('fs.read', (_$, e) => ({ value: files[key(e.path)] ?? '' }))
  on('fs.write', (_$, e) => {
    files[key(e.path)] = e.text
    return { value: undefined }
  })
  on('prompt.submit', () => ({ text: '' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  const inbox = () =>
    Object.entries(files)
      .filter(([path]) => path === `${CONFIG}/office/evals/routing.inbox.jsonl`)
      .flatMap(([, text]) => text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>))
  return inbox
}

describe('routing inbox', () => {
  test('a routed worker logs its start and its finish under one job id', OPTIONS, async ($, on) => {
    const inbox = fakeWorker(on)
    const clock = mock.clock(on)
    await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', mode: 'headless', cwd: '/r' })
    await clock.settle()
    const [start, end] = inbox()
    expect(start).toMatchObject({ kind: 'routed', task: 'rename x to y', backend: 'rules' })
    expect(end).toMatchObject({ kind: 'finished', job: start?.job, status: 'done', costUsd: 0.25 })
    expect(typeof end?.minutes).toBe('number')
  })

  test('an old plugin-folder label file is copied to the config dir once, then read from there', OPTIONS, async ($, on) => {
    const old = 'plugin:evals/routing.local.jsonl'
    const label = (task: string) => `{"id":"l01","task":"${task}","model":"sonnet","effort":"low","why":"x"}\n`
    const files: Record<string, string> = { [old]: label('rename x to y') }
    fakeWorker(on, files)
    const clock = mock.clock(on)
    await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', mode: 'headless', cwd: '/r' })
    await clock.settle()
    const first = await $.command.run({ command: 'route-inbox', args: '', ...ASK })
    expect(first.text).toContain(`0 of 1 routed tasks unlabelled (${CONFIG}/office/evals/routing.inbox.jsonl)`)
    expect(files[`${CONFIG}/office/evals/routing.local.jsonl`]).toBe(label('rename x to y'))
    // A later change to the old file is not copied again: the new file is the one read.
    files[old] = label('something else')
    const second = await $.command.run({ command: 'route-inbox', args: '', ...ASK })
    expect(second.text).toContain('0 of 1 routed tasks unlabelled')
    expect(files[old]).toBe(label('something else'))
  })

  test('a worker given its model logs nothing', OPTIONS, async ($, on) => {
    const inbox = fakeWorker(on)
    const clock = mock.clock(on)
    await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', mode: 'headless', model: 'sonnet', cwd: '/r' })
    await clock.settle()
    expect(inbox()).toHaveLength(0)
  })

  test('the fold joins by job id and counts a task already in the labels as labelled', () => {
    const inbox = [
      '{"kind":"routed","job":"a1","at":"2026-10-05T10:00:00.000Z","task":"Bump the  version","model":"sonnet","effort":"low","backend":"rules","confidence":0.6}',
      '{"kind":"routed","job":"b2","at":"2026-10-05T11:00:00.000Z","task":"Design the cache","model":"opus","effort":"high","backend":"claude","confidence":0.8}',
      '{"kind":"finished","job":"a1","at":"2026-10-05T10:03:00.000Z","status":"done","minutes":3.1,"costUsd":0.4}',
    ].join('\n')
    const labels = '{"id":"l01","task":"Bump the version","model":"sonnet","effort":"low","why":"mechanical"}'
    const [newest, oldest] = foldInbox(inbox, labels)
    expect(newest).toMatchObject({ job: 'b2', isLabelled: false })
    expect(newest?.outcome).toBeUndefined()
    expect(oldest).toMatchObject({ job: 'a1', isLabelled: true, outcome: 'done, 3.1 min, $0.40' })
  })
})
