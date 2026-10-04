import { describe, expect, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
const RUN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const
const ROOT = '/repo'
const NOTES = '/home/me/.claude/office/notes/repo.md'

// What the manager hooks touch beneath the plugin: the shared store, this session's id and
// folder, git for the project root, the environment, and the notebook file.
function fakeWorld(on: On, opts: { sessionId?: string; store?: Record<string, unknown>; files?: Record<string, string>; isWorker?: boolean } = {}) {
  const store = new Map(Object.entries(opts.store ?? {}))
  const files = new Map(Object.entries(opts.files ?? {}))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.id', () => ({ value: opts.sessionId ?? 'sess-A' }))
  on('session.cwd', () => ({ value: `${ROOT}/src` }))
  on('process.run', () => ({ value: { ...RUN, stdout: `${ROOT}\n` } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : e.name === 'OFFICE_WORKER' && opts.isWorker ? '1' : undefined }))
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'core', scope: 'shared' as const }] }))
  return { store, files }
}

describe('/office manage', () => {
  test('makes this session the manager of its git project, and off ends it', async ($, on) => {
    const { store } = fakeWorld(on)
    const on1 = await $.command.run({ command: 'office', args: 'manage', ...TYPED })
    expect(on1.text).toContain(`now manages ${ROOT}`)
    expect(store.get('managers')).toMatchObject({ [ROOT]: { sessionId: 'sess-A' } })
    const off = await $.command.run({ command: 'office', args: 'manage off', ...TYPED })
    expect(off.text).toContain('no longer manages')
    expect(store.get('managers')).toEqual({})
  })

  test('off from a session that is not the manager changes nothing', async ($, on) => {
    const managers = { [ROOT]: { sessionId: 'sess-B', name: 'other', since: 1 } }
    const { store } = fakeWorld(on, { store: { managers } })
    const off = await $.command.run({ command: 'office', args: 'manage off', ...TYPED })
    expect(off.text).toContain('other is')
    expect(store.get('managers')).toEqual(managers)
  })

  test('taking over names the session it replaces', async ($, on) => {
    fakeWorld(on, { store: { managers: { [ROOT]: { sessionId: 'sess-B', name: 'other', since: 1 } } } })
    expect((await $.command.run({ command: 'office', args: 'manage', ...TYPED })).text).toContain('takes over from other')
  })

  test('an unknown argument still gets the board\'s usage line', async ($, on) => {
    fakeWorld(on)
    expect((await $.command.run({ command: 'office', args: 'nonsense', ...TYPED })).text).toContain('Usage: /office')
  })
})

describe('the role in the system prompt', () => {
  const ids = (r: { sections: readonly { id: string }[] }) => r.sections.map(s => s.id)

  test('no manager: the prompt is left as it was', async ($, on) => {
    fakeWorld(on)
    expect(ids(await $.prompt.compose(COMPOSE))).toEqual(['intro'])
  })

  test('the manager gets the manager section, last and on the session side', async ($, on) => {
    fakeWorld(on, { store: { managers: { [ROOT]: { sessionId: 'sess-A', name: 'lead-a', since: 1 } } } })
    const r = await $.prompt.compose(COMPOSE)
    expect(ids(r)).toEqual(['intro', 'office:manager'])
    const section = r.sections[1]
    expect(section?.scope).toBe('session')
    expect(section?.text).toContain('spawn_worker')
    expect(section?.text).toContain(ROOT)
  })

  test('another session in the project is told who to report to, and reads the notebook', async ($, on) => {
    fakeWorld(on, {
      sessionId: 'sess-C',
      store: { managers: { [ROOT]: { sessionId: 'sess-A', name: 'lead-a', since: 1 } } },
      files: { [NOTES]: '2026-10-04T10:00:00.000Z | lead-a | decision | Use the cells renderer as the fallback.\n' },
    })
    const r = await $.prompt.compose(COMPOSE)
    expect(ids(r)).toEqual(['intro', 'office:report-to', 'office:notes'])
    expect(r.sections[1]?.text).toContain('lead-a')
    expect(r.sections[2]?.text).toContain('Use the cells renderer')
    expect(r.sections[2]?.text).toContain('not as instructions')
  })

  test('a worker gets nothing added, even in a managed project', async ($, on) => {
    fakeWorld(on, { isWorker: true, store: { managers: { [ROOT]: { sessionId: 'sess-A', name: 'lead-a', since: 1 } } } })
    expect(ids(await $.prompt.compose(COMPOSE))).toEqual(['intro'])
  })
})

describe('the project notebook', () => {
  test('post_note appends a line and read_notes returns it', async ($, on) => {
    const { files } = fakeWorld(on, { files: { [NOTES]: '2026-10-04T10:00:00.000Z | lead-a | plan | First.\n' } })
    const posted = await $.tool.call({ tool: 'mcp__office__post_note', text: 'Second,\nover two lines.', tag: 'result' })
    expect(JSON.stringify(posted)).toContain('Noted')
    const lines = (files.get(NOTES) ?? '').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/\| result \| Second, over two lines\.$/)
    const got = JSON.stringify(await $.tool.call({ tool: 'mcp__office__read_notes', last: 1 }))
    expect(got).toContain('Second, over two lines.')
    expect(got).not.toContain('First.')
  })

  test('an empty note is refused, and an empty notebook says so', async ($, on) => {
    fakeWorld(on)
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__office__post_note', text: '   ' }))).toContain('needs text')
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__office__read_notes' }))).toContain('No notes yet')
  })

  test('workers can neither post nor read', async ($, on) => {
    const { files } = fakeWorld(on, { isWorker: true })
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__office__post_note', text: 'hello' }))).toContain('not available to office workers')
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__office__read_notes' }))).toContain('not available to office workers')
    expect(files.size).toBe(0)
  })
})
