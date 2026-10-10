import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { CODEX_DEFAULTS, codexQuotaMessage, codexReviewArgv, codexReviewPrompt, parseReviewTarget } from './codex'
import { MODEL_IDS, modelIdFor, parseClaudeRoute, parseJevResponse, rulesRoute } from './router'
import { bgArgv, bgPhase, headlessArgv, parseAgentsJson, parseBgId, readTranscript, transcriptPath } from './spawn'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const RUN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
// The reply shape docs.aimlapi.com/api-references/decision-models/typesafe/jev shows, verbatim in form.
const DOCS_REPLY =
  '{"model":"typesafe/jev-1.13-20260917","answers":{' +
  '"model":{"type":"choice","choice":"opus","confidence":0.97,"probabilities":{"sonnet":0.02,"opus":0.97,"fable":0.01}},' +
  '"effort":{"type":"choice","choice":"high","confidence":0.88,"probabilities":{"low":0.01,"medium":0.11,"high":0.88}}},' +
  '"usage":{"input_tokens":403,"output_tokens":73}}'

describe('rules backend', () => {
  test('review / refactor / debug go to opus/high', () => {
    expect(rulesRoute('review this PR for correctness')).toMatchObject({ model: 'opus', effort: 'high' })
    expect(rulesRoute('refactor the parser module')).toMatchObject({ model: 'opus', effort: 'high' })
    expect(rulesRoute('debug why the upload hangs')).toMatchObject({ model: 'opus', effort: 'high' })
  })
  test('a mechanical rename goes to haiku, architecture to opus', () => {
    expect(rulesRoute('rename get_usr to get_user in utils.py')).toMatchObject({ model: 'haiku', effort: 'low' })
    expect(rulesRoute('design the event-sourcing architecture for orders')).toMatchObject({ model: 'opus', effort: 'high' })
  })
})

describe('jev backend', () => {
  test('the literal documented reply', () => {
    expect(parseJevResponse(DOCS_REPLY)).toEqual({
      model: 'opus',
      effort: 'high',
      confidence: 0.88,
      reason: 'jev: opus (conf 0.97), high (conf 0.88)',
    })
  })
})

describe('route through the plugin', () => {
  test('claude backend: the completion is parsed', { options: { routerBackend: 'claude' } }, async ($, on) => {
    on('model.complete', () => ({
      value: {
        isAnswered: true,
        text: '```json\n{"model":"opus","effort":"high","confidence":0.75,"reason":"debugging"}\n```',
        usage: USAGE,
      },
    }))
    const r = await $.tool.call({ tool: 'mcp__office__route_task', task: 'debug the crash' })
    expect(r.text ?? JSON.stringify(r.result)).toContain('opus')
    expect(JSON.stringify(r.result)).toContain('claude in')
  })

  test('claude backend: garbage falls back to rules', { options: { routerBackend: 'claude' } }, async ($, on) => {
    on('model.complete', () => ({ value: { isAnswered: true, text: 'opus, probably', usage: USAGE } }))
    const r = await $.tool.call({ tool: 'mcp__office__route_task', task: 'rename x to y' })
    const text = JSON.stringify(r.result)
    expect(text).toContain('haiku')
    expect(text).toContain('rules in')
    expect(text).toContain('claude: unparseable reply')
  })

  test('auto without any key goes straight to claude: no Jev request', {
    options: { routerBackend: 'auto' },
  }, async ($, on) => {
    on('process.run', () => ({ value: { ...RUN, exitCode: 44 } }))
    on('env.get', () => ({ value: undefined }))
    let fetched = false
    on('http.fetch', () => {
      fetched = true
      return { value: { status: 500, ok: false, headers: {}, text: '' } }
    })
    on('model.complete', () => ({
      value: { isAnswered: true, text: '{"model":"sonnet","effort":"low","confidence":0.9,"reason":"rename"}', usage: USAGE },
    }))
    const r = await $.tool.call({ tool: 'mcp__office__route_task', task: 'rename x to y' })
    expect(fetched).toBe(false)
    expect(String(r.result)).toContain('claude in')
    expect(String(r.result)).not.toContain('jev:')
  })
})

describe('codex handoff', () => {
  test('a failed `codex login status` fails the job with the login hint', async ($, on) => {
    const runs: string[] = []
    on('process.run', (_$, e) => {
      runs.push(e.argv.join(' '))
      const value = { exitCode: 1, stdout: '', stderr: 'Not logged in', isStdoutTruncated: false, isStderrTruncated: false }
      return { value }
    })
    const r = await $.tool.call({ tool: 'mcp__office__codex_review', target: '--uncommitted', cwd: '/repo' })
    expect(r.deny ?? '').toContain('codex login')
    expect(runs.some(cmd => cmd.endsWith('login status'))).toBe(true)
  })
})

describe('model ids', () => {
  test('fable is never routed, but an explicit fable is honoured', () => {
    expect(parseClaudeRoute('{"model":"fable","effort":"high"}')?.model).toBe('opus')
    const jev = JSON.stringify({ answers: { model: { choice: 'fable', confidence: 0.9 }, effort: { choice: 'high', confidence: 0.9 } } })
    expect(parseJevResponse(jev)?.model).toBe('opus')
    expect(modelIdFor('fable')).toBe(MODEL_IDS.fable)
    expect(modelIdFor('haiku')).toBe('claude-haiku-5-5')
    expect(modelIdFor('claude-opus-5-5')).toBe('claude-opus-5-5')
  })
})

describe('argv safety', () => {
  test('codex review with instructions drops the target flag and describes it on stdin', () => {
    const uncommitted = parseReviewTarget('--uncommitted')!
    const argv = codexReviewArgv('codex', uncommitted, '/tmp/o', CODEX_DEFAULTS.review, true)
    expect(argv).not.toContain('--uncommitted')
    expect(argv.at(-1)).toBe('-')
    expect(codexReviewPrompt(uncommitted, 'focus on auth')).toContain('uncommitted changes')
    const base = parseReviewTarget('develop')!
    expect(codexReviewArgv('codex', base, '/tmp/o', CODEX_DEFAULTS.review, true)).not.toContain('--base')
    expect(codexReviewPrompt(base, 'x')).toContain('git diff develop...HEAD')
    const commit = parseReviewTarget('--commit abc123')!
    expect(codexReviewPrompt(commit, 'x')).toContain('git show abc123')
  })
  test('the headless worker task never rides argv', () => {
    const argv = headlessArgv('claude', 'claude-sonnet-5-5', 'low', 'acceptEdits')
    expect(argv).toEqual([
      'claude', '-p', '--model', 'claude-sonnet-5-5', '--effort', 'low', '--permission-mode', 'acceptEdits',
      '--output-format', 'stream-json', '--verbose',
    ])
    expect(argv.some(a => a.includes('fix bug'))).toBe(false)
  })
})

describe('codex tiers', () => {
  test('usage / rate limits become a quota message with the reset time', () => {
    expect(
      codexQuotaMessage("You've hit your usage limit. Upgrade to Pro or try again at 3:11 AM.", 'gpt-6-astra'),
    ).toBe('Codex quota hit for gpt-6-astra, resets at 3:11 AM.')
    expect(codexQuotaMessage("You've hit your usage limit for GPT-6-Sol. Try again in 3 days.", 'gpt-6-sol')).toBe(
      'Codex quota hit for gpt-6-sol, resets in 3 days.',
    )
    expect(codexQuotaMessage('{"type":"error","error":{"code":"usage_limit_reached"}}', 'gpt-6-luna')).toBe(
      'Codex quota hit for gpt-6-luna.',
    )
    // Not codex's own wording: no false alarm on a stray 429 or "quota" in a diff.
    expect(codexQuotaMessage('stream error: 429 Too Many Requests', 'gpt-6-sol')).toBeUndefined()
    expect(codexQuotaMessage('fix the quota check in billing.ts', 'gpt-6-sol')).toBeUndefined()
    expect(codexQuotaMessage('The model is not supported', 'gpt-6-sol')).toBeUndefined()
  })
})

describe('effort cap', () => {
  test('routers never pick above high', () => {
    expect(rulesRoute('design multi-region billing architecture')).toMatchObject({ model: 'opus', effort: 'high' })
    expect(parseClaudeRoute('{"model":"fable","effort":"xhigh"}')?.effort).toBe('high')
    expect(parseClaudeRoute('{"model":"fable","effort":"max"}')?.effort).toBe('high')
    const jev = JSON.stringify({
      answers: { model: { choice: 'fable', confidence: 0.9 }, effort: { choice: 'max', confidence: 0.9 } },
    })
    expect(parseJevResponse(jev)?.effort).toBe('high')
  })
})

describe('--bg workers', () => {
  test('the task follows "--", so a dash-led task stays the prompt', () => {
    const argv = bgArgv('claude', 'claude-sonnet-5-5', 'low', 'acceptEdits', '- fix bug')
    expect(argv.slice(-2)).toEqual(['--', '- fix bug'])
    expect(argv).toContain('--bg')
    // The worker marker rides --settings: the spawn env does not reach a --bg session.
    const i = argv.indexOf('--settings')
    expect(JSON.parse(argv[i + 1]!)).toEqual({ env: { OFFICE_WORKER: '1' } })
  })
  test('the id claude --bg prints', () => {
    const out = 'backgrounded · 5ac0f0df\n  claude agents             list sessions\n  claude attach 5ac0f0df    open in this terminal\n'
    expect(parseBgId(out)).toBe('5ac0f0df')
    expect(parseBgId('\u001b[2mbackgrounded\u001b[22m · \u001b[1m5ac0f0df\u001b[22m\n')).toBe('5ac0f0df')
    expect(parseBgId('nothing here')).toBeUndefined()
  })
  test('claude agents --json and the transcript', () => {
    const agents = parseAgentsJson(
      '[{"id":"5ac0f0df","sessionId":"5ac0f0df-52a5","cwd":"/Users/a/Coding","kind":"background","state":"done"},{"pid":1}]',
    )
    expect(agents).toEqual([{ id: '5ac0f0df', sessionId: '5ac0f0df-52a5', cwd: '/Users/a/Coding', kind: 'background', state: 'done' }])
    expect(transcriptPath('/Users/a/.claude', '/Users/a/Coding', 'S').path).toBe('/Users/a/.claude/projects/-Users-a-Coding/S.jsonl')
    const long = transcriptPath('/c', `/${'x'.repeat(250)}`, 'S')
    expect(long.path).toBeUndefined()
    expect(long.prefix).toBe(`-${'x'.repeat(199)}-`)
    const jsonl = [
      'tial line cut by tail -c',
      '{"type":"user","message":{"content":"Reply with the single word OK"}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}',
      '{"type":"system","subtype":"turn_duration"}',
    ].join('\n')
    expect(readTranscript(jsonl)).toEqual({ result: 'OK', tail: '[tool Read]\nOK', hasTurn: true })
  })
  test('a finished worker left at state working, status idle reads as idle (regression, 2026-10-05)', () => {
    expect(bgPhase('working', 'idle')).toBe('idle')
    expect(bgPhase('working', 'busy')).toBe('active')
    expect(bgPhase('blocked', 'idle')).toBe('blocked')
  })
})

describe('/route-eval', () => {
  const ASK = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
  const CASES = [
    '{"id":"a","task":"rename fooBar to foo_bar across utils.py","model":"haiku","effort":"low","why":"mechanical"}',
    '{"id":"b","task":"rename fooBar to foo_bar across utils.py","model":"opus","effort":"high","why":"deliberately wrong label"}',
  ].join('\n')

  test('rules: scores the labeled file, saves a dated record, and never calls a model', async ($, on) => {
    on('env.get', (_$, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/fake/config' : undefined }))
    on('fs.exists', () => ({ value: false }))
    let modelCalls = 0
    const written: { path: string; text: string }[] = []
    on('fs.read', (_$, e) => {
      if (e.path.endsWith('/routing.jsonl')) return { value: CASES }
      throw new Error('ENOENT')
    })
    on('fs.write', (_$, e) => {
      written.push({ path: e.path, text: e.text })
      return { value: undefined }
    })
    on('model.complete', () => {
      modelCalls++
      return { value: { isAnswered: true, text: '{}', usage: USAGE } }
    })
    const ran = await $.command.run({ command: 'route-eval', args: 'rules', ...ASK })
    expect(ran.text).toContain('rules')
    expect(ran.text).toContain('2/2')
    expect(ran.text).toContain('b: want opus/high, got haiku/low')
    expect(modelCalls).toBe(0)
    expect(written).toHaveLength(1)
    expect(written[0]?.path).toMatch(/^\/fake\/config\/office\/evals\/results\/.*-rules\.json$/)
    expect(JSON.parse(written[0]?.text ?? '{}').report).toMatchObject({ backend: 'rules', total: 2, exact: 1, underRouted: 1 })
  })

  test('a local label file is scored and reported apart from the public one', async ($, on) => {
    const LOCAL = '{"id":"l01","task":"Bump the version in package.json","model":"opus","effort":"high","why":"deliberately wrong label"}'
    on('env.get', (_$, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/fake/config' : undefined }))
    on('fs.exists', () => ({ value: false }))
    const written: string[] = []
    on('fs.read', (_$, e) => ({ value: e.path.endsWith('/routing.local.jsonl') ? LOCAL : CASES }))
    on('fs.write', (_$, e) => {
      written.push(e.path)
      return { value: undefined }
    })
    const ran = await $.command.run({ command: 'route-eval', args: 'rules', ...ASK })
    const [pub, local] = (ran.text ?? '').split('local: ~/.claude/office/evals/routing.local.jsonl (1 tasks)')
    expect(pub).toContain('public: evals/routing.jsonl (2 tasks)')
    expect(pub).toContain('2/2')
    expect(local).toContain('1/1')
    expect(local).toContain('l01: want opus/high, got haiku/low')
    expect(written.map(p => p.replace(/.*\//, '').replace(/^.*Z-/, ''))).toEqual(['rules.json', 'local-rules.json'])
  })
})

describe('budget guard on worker starts', () => {
  const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
  const usageAt = (fiveHour: number) => ({
    value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2026-10-05T01:00:00.000Z' }] },
  })
  const routeReply = (model: string, effort: string) => ({
    value: { isAnswered: true as const, text: `{"model":"${model}","effort":"${effort}","confidence":0.9,"reason":"test"}`, usage: USAGE },
  })
  // What a start touches beneath the plugin: the bg id list, the cwd, the config dir (its capacity lock) and `claude --bg` itself.
  function fakeStart(on: On) {
    const ran: string[][] = []
    mock.env(on, { HOME: '/home/me' })
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => ({ value: undefined }))
    on('session.cwd', () => ({ value: '/r' }))
    on('process.run', (_$, e) => {
      ran.push([...e.argv])
      return { value: { ...RUN, stdout: 'backgrounded · 5ac0f0df\n' } }
    })
    return ran
  }

  test('soft zone: a task routed large is refused and nothing is spawned', { options: { routerBackend: 'claude' } }, async ($, on) => {
    const ran = fakeStart(on)
    on('session.usage', () => usageAt(85))
    on('model.complete', () => routeReply('opus', 'high'))
    const r = await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'debug the crash', cwd: '/r' })
    const text = JSON.stringify(r)
    expect(text).toContain('5-hour limit is at 85%')
    expect(text).toContain('only small tasks')
    expect(ran.filter(argv => argv.includes('--bg'))).toHaveLength(0)
  })

  test('hard limit: refused before any routing call is spent', { options: { routerBackend: 'claude' } }, async ($, on) => {
    const ran = fakeStart(on)
    let routed = 0
    on('session.usage', () => usageAt(96))
    on('model.complete', () => {
      routed++
      return routeReply('sonnet', 'low')
    })
    const r = await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'rename x to y', cwd: '/r' })
    expect(JSON.stringify(r)).toContain('hard limit 95%')
    expect(routed).toBe(0)
    expect(ran.filter(argv => argv.includes('--bg'))).toHaveLength(0)
  })

  test('an agent naming a model does not count as the person choosing it', async ($, on) => {
    const ran = fakeStart(on)
    on('session.usage', () => usageAt(85))
    const r = await $.tool.call({ tool: 'mcp__office__spawn_worker', task: 'design it', model: 'opus', cwd: '/r' })
    expect(JSON.stringify(r)).toContain('only small tasks')
    expect(ran.filter(argv => argv.includes('--bg'))).toHaveLength(0)
  })

  test('the person may pick a model in the soft zone (warned) and force past the hard limit', async ($, on) => {
    const ran = fakeStart(on)
    let used = 85
    on('session.usage', () => usageAt(used))
    const soft = await $.command.run({ command: 'spawn', args: '--model opus design it', ...TYPED })
    expect(soft.text).toContain('soft zone')
    used = 97
    const refused = await $.command.run({ command: 'spawn', args: '--model sonnet --effort low tidy it', ...TYPED })
    expect(refused.text).toContain('hard limit 95%')
    const forced = await $.command.run({ command: 'spawn', args: '--force --model sonnet --effort low tidy it', ...TYPED })
    expect(forced.text).toContain('Forced past the limit')
    expect(ran.filter(argv => argv.includes('--bg'))).toHaveLength(2)
  })
})
