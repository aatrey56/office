import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const RUN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const BASE = 'abc1234def5678abc1234def5678abc1234def56'
const NO_LIMITS = { value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }

// A repo at /r, asked from /r/src; git answers as a clean checkout would, `claude --bg` prints its id.
function fakeRepo(on: On) {
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
    if (argv.includes('--bg')) return out('backgrounded · 5ac0f0df\n')
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
    expect(bg?.argv.at(-1)).toMatch(/rename x to y$/)
    expect(JSON.stringify(r.result)).toContain(branch)
  })

  test('a clean finished worker gives its worktree back and reports its branch', async ($, on) => {
    const runs = fakeRepo(on)
    const clock = mock.clock(on)
    const delivered: string[] = []
    let spawnedCwd: string | undefined
    on('process.spawn', async function* (_$, e) {
      spawnedCwd = e.cwd
      yield { stream: 'stdout' as const, text: '{"type":"result","subtype":"success","result":"Renamed it."}\n' }
      return { value: { code: 0, signal: null } }
    })
    // No session.append beneath the test: the result is delivered as the prompt.
    on('prompt.submit', (_$, e) => {
      delivered.push(e.text)
      return { text: '' }
    })
    on('ui.toast', () => ({ value: undefined }))
    on('ui.log', () => ({ value: undefined }))
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
})
