import { describe, expect, test } from 'claude-code/testing'

import { CODEX_DEFAULTS, codexExecArgv, codexQuotaMessage, codexReviewArgv, codexReviewPrompt, parseReviewTarget, splitDeep } from './codex'
import { HAIKU_RETIRES_AT, jevRequestBody, MODEL_IDS, modelIdFor, parseClaudeRoute, parseJevResponse, rulesRoute } from './router'
import { bgArgv, bgPhase, headlessArgv, newestBgSince, parseAgentsJson, parseBgId, parseSpawnArgs, readTranscript, transcriptPath } from './spawn'

const BEFORE = Date.UTC(2026, 9, 3) // haiku still available
const AFTER = HAIKU_RETIRES_AT + 1 // haiku retired
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const RUN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
// The reply shape docs.aimlapi.com/api-references/decision-models/typesafe/jev shows, verbatim in form.
const DOCS_REPLY =
  '{"model":"typesafe/jev-1.13-20260917","answers":{' +
  '"model":{"type":"choice","choice":"opus","confidence":0.97,"probabilities":{"sonnet":0.02,"opus":0.97,"fable":0.01}},' +
  '"effort":{"type":"choice","choice":"high","confidence":0.88,"probabilities":{"low":0.01,"medium":0.11,"high":0.88}}},' +
  '"usage":{"input_tokens":403,"output_tokens":73}}'

describe('rules backend', () => {
  test('mechanical edits go to sonnet/low', () => {
    expect(rulesRoute('rename fooBar to foo_bar across utils.py', BEFORE)).toMatchObject({ model: 'sonnet', effort: 'low' })
    expect(rulesRoute('run prettier and fix the lint errors', BEFORE)).toMatchObject({ model: 'sonnet', effort: 'low' })
  })
  test('review / refactor / debug go to opus/high', () => {
    expect(rulesRoute('review this PR for correctness', BEFORE)).toMatchObject({ model: 'opus', effort: 'high' })
    expect(rulesRoute('refactor the parser module', BEFORE)).toMatchObject({ model: 'opus', effort: 'high' })
    expect(rulesRoute('debug why the upload hangs', BEFORE)).toMatchObject({ model: 'opus', effort: 'high' })
  })
  test('architecture, research and multi-system work go to fable/high', () => {
    expect(rulesRoute('propose an architecture for the sync engine', BEFORE)).toMatchObject({ model: 'fable', effort: 'high' })
    expect(rulesRoute('research vector DB options', BEFORE)).toMatchObject({ model: 'fable' })
    expect(rulesRoute('the api, the queue and the cache disagree after deploy', BEFORE)).toMatchObject({
      model: 'fable',
      effort: 'high',
    })
  })
  test('summarize / classify use haiku only while it is available', () => {
    expect(rulesRoute('summarize this changelog', BEFORE)).toMatchObject({ model: 'haiku', effort: 'low' })
    const after = rulesRoute('classify these tickets', AFTER)
    expect(after).toMatchObject({ model: 'sonnet', effort: 'low' })
    expect(after.reason).toContain('haiku retired')
  })
  test('code words like extract / tag / label do not route to haiku', () => {
    expect(rulesRoute('extract a helper function from parse()', BEFORE).model).not.toBe('haiku')
    expect(rulesRoute('label the release and tag v2', BEFORE).model).not.toBe('haiku')
  })
  test('anything else gets a low-confidence default', () => {
    const r = rulesRoute('hmm', BEFORE)
    expect(r).toMatchObject({ model: 'sonnet', effort: 'medium' })
    expect(r.confidence).toBeLessThan(0.5)
  })
})

describe('claude backend JSON parsing', () => {
  test('plain JSON', () => {
    expect(parseClaudeRoute('{"model":"opus","effort":"high","confidence":0.8,"reason":"debugging"}', BEFORE)).toEqual({
      model: 'opus',
      effort: 'high',
      confidence: 0.8,
      reason: 'debugging',
    })
  })
  test('fenced, with prose around it and braces inside strings', () => {
    const text = 'Sure!\n```json\n{"model": "sonnet", "effort": "low", "confidence": "0.9", "reason": "rename {x}"}\n```\nDone.'
    expect(parseClaudeRoute(text, BEFORE)).toEqual({ model: 'sonnet', effort: 'low', confidence: 0.9, reason: 'rename {x}' })
  })
  test('full model ids, odd effort spellings (capped at high), clamped confidence', () => {
    const r = parseClaudeRoute('{"model":"claude-fable-5-1","effort":"Extra-High","confidence":7}', BEFORE)
    expect(r).toMatchObject({ model: 'fable', effort: 'high', confidence: 1 })
    expect(parseClaudeRoute('{"model":"sonnet","effort":"Med"}', BEFORE)?.effort).toBe('medium')
  })
  test('haiku after retirement becomes sonnet', () => {
    expect(parseClaudeRoute('{"model":"haiku","effort":"low"}', AFTER)?.model).toBe('sonnet')
  })
  test('unusable replies answer undefined', () => {
    expect(parseClaudeRoute('I think opus.', BEFORE)).toBeUndefined()
    expect(parseClaudeRoute('{"model":"gpt","effort":"low"}', BEFORE)).toBeUndefined()
    expect(parseClaudeRoute('{"model":"opus","effort":"enormous"}', BEFORE)).toBeUndefined()
    expect(parseClaudeRoute('{"model":"opus", effort: high', BEFORE)).toBeUndefined()
  })
})

describe('jev backend', () => {
  test('request body asks two choice questions over the rubric', () => {
    const body = JSON.parse(jevRequestBody('fix the flaky test', AFTER))
    expect(body.model).toBe('typesafe/jev')
    expect(body.questions.model.type).toBe('choice')
    expect(Object.keys(body.questions.model.criteria)).toEqual(['sonnet', 'opus', 'fable'])
    expect(Object.keys(body.questions.effort.criteria)).toEqual(['low', 'medium', 'high'])
  })
  test('the literal documented reply', () => {
    expect(parseJevResponse(DOCS_REPLY, BEFORE)).toEqual({
      model: 'opus',
      effort: 'high',
      confidence: 0.88,
      reason: 'jev: opus (conf 0.97), high (conf 0.88)',
    })
  })
  test('response in the documented shape', () => {
    const text = JSON.stringify({
      model: 'typesafe/jev-1.13-20260917',
      answers: {
        model: { type: 'choice', choice: 'opus', confidence: 0.9, probabilities: { opus: 0.93, sonnet: 0.07 } },
        effort: { type: 'choice', choice: 'high', confidence: 0.7, probabilities: { high: 0.8 } },
      },
      usage: { input_tokens: 400, output_tokens: 0 },
    })
    expect(parseJevResponse(text, BEFORE)).toMatchObject({ model: 'opus', effort: 'high', confidence: 0.7 })
    expect(parseJevResponse('{"answers":{}}', BEFORE)).toBeUndefined()
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
    expect(text).toContain('sonnet')
    expect(text).toContain('rules in')
    expect(text).toContain('claude: unparseable reply')
  })

  test('jev backend: the option key when the Keychain has none', {
    options: { routerBackend: 'jev', jevApiKey: 'test-key' },
  }, async ($, on) => {
    on('process.run', () => ({ value: { ...RUN, exitCode: 44, stderr: 'could not be found' } }))
    let auth: string | undefined
    on('http.fetch', (_$, e) => {
      auth = e.init?.headers?.Authorization
      return { value: { status: 200, ok: true, headers: {}, text: DOCS_REPLY } }
    })
    const r = await $.tool.call({ tool: 'mcp__office__route_task', task: 'design the sync architecture' })
    expect(auth).toBe('Bearer test-key')
    expect(JSON.stringify(r.result)).toContain('jev in')
  })

  test('auto: the Keychain key wins, and the documented reply routes', {
    options: { routerBackend: 'auto', jevApiKey: 'option-key' },
  }, async ($, on) => {
    const runs: string[] = []
    on('process.run', (_$, e) => {
      runs.push(e.argv.join(' '))
      return { value: { ...RUN, stdout: 'keychain-key\n' } }
    })
    let auth: string | undefined
    on('http.fetch', (_$, e) => {
      auth = e.init?.headers?.Authorization
      return { value: { status: 200, ok: true, headers: {}, text: DOCS_REPLY } }
    })
    const r = await $.tool.call({ tool: 'mcp__office__route_task', task: 'debug the flaky upload' })
    expect(runs).toContain('security find-generic-password -s aimlapi -w')
    expect(auth).toBe('Bearer keychain-key')
    const text = String(r.result)
    expect(text).toMatch(/^opus \(claude-opus-5-5\) at high effort/)
    expect(text).toMatch(/· jev in \d+ms ·/)
    expect(text).not.toContain('keychain-key')
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
  test('haiku maps to sonnet once retired, explicit ids included', () => {
    expect(modelIdFor('haiku', BEFORE)).toBe(MODEL_IDS.haiku)
    expect(modelIdFor('haiku', AFTER)).toBe(MODEL_IDS.sonnet)
    expect(modelIdFor('claude-haiku-4-5', AFTER)).toBe(MODEL_IDS.sonnet)
    expect(modelIdFor('opus', AFTER)).toBe(MODEL_IDS.opus)
    expect(modelIdFor('claude-opus-5-5', AFTER)).toBe('claude-opus-5-5')
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
  test('codex review without instructions keeps the flag and no prompt', () => {
    const argv = codexReviewArgv('codex', parseReviewTarget('--uncommitted')!, '/tmp/o', { model: 'gpt-5', effort: '' }, false)
    expect(argv).toContain('--uncommitted')
    expect(argv).not.toContain('-')
    expect(argv).toContain('model="gpt-5"')
    expect(argv.some(a => a.startsWith('model_reasoning_effort'))).toBe(false)
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
  test('reviews run gpt-6-sol at high, second opinions gpt-6-luna at medium, deep gpt-6-astra at high', () => {
    const review = codexReviewArgv('codex', parseReviewTarget('--uncommitted')!, '/tmp/o', CODEX_DEFAULTS.review, false)
    expect(review.slice(0, 9)).toEqual([
      'codex', 'exec', 'review', '-c', 'model="gpt-6-sol"', '-c', 'review_model="gpt-6-sol"',
      '-c', 'model_reasoning_effort="high"',
    ])
    const deep = codexReviewArgv('codex', parseReviewTarget('main')!, '/tmp/o', CODEX_DEFAULTS.deep, false)
    expect(deep).toContain('review_model="gpt-6-astra"')
    const exec = codexExecArgv('codex', '/tmp/o', CODEX_DEFAULTS.exec)
    expect(exec.slice(0, 6)).toEqual(['codex', 'exec', '-c', 'model="gpt-6-luna"', '-c', 'model_reasoning_effort="medium"'])
    expect(exec).toContain('read-only')
    expect(CODEX_DEFAULTS.deep).toEqual({ model: 'gpt-6-astra', effort: 'high' })
  })
  test('--deep is opt-in and stripped from the target', () => {
    expect(splitDeep('--deep --base main')).toEqual({ deep: true, rest: '--base main' })
    expect(splitDeep('--uncommitted')).toEqual({ deep: false, rest: '--uncommitted' })
    expect(splitDeep('')).toEqual({ deep: false, rest: '' })
  })
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
    expect(rulesRoute('design multi-region billing architecture', BEFORE)).toMatchObject({ model: 'fable', effort: 'high' })
    expect(parseClaudeRoute('{"model":"fable","effort":"xhigh"}', BEFORE)?.effort).toBe('high')
    expect(parseClaudeRoute('{"model":"fable","effort":"max"}', BEFORE)?.effort).toBe('high')
    const jev = JSON.stringify({
      answers: { model: { choice: 'fable', confidence: 0.9 }, effort: { choice: 'max', confidence: 0.9 } },
    })
    expect(parseJevResponse(jev, BEFORE)?.effort).toBe('high')
  })
  test('/spawn takes an explicit effort (xhigh allowed) and a mode', () => {
    expect(parseSpawnArgs('--effort xhigh design the billing system')).toEqual({
      task: 'design the billing system',
      effort: 'xhigh',
    })
    expect(parseSpawnArgs('--mode headless --model opus -- --fix the flag parser')).toEqual({
      task: '--fix the flag parser',
      mode: 'headless',
      model: 'opus',
    })
    expect(parseSpawnArgs('fix the bug')).toEqual({ task: 'fix the bug' })
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
  test('no printed id: the newest background session in the cwd since the spawn', () => {
    const agents = [
      { id: 'old', kind: 'background', cwd: '/r', startedAt: 100 },
      { id: 'new', kind: 'background', cwd: '/r', startedAt: 300 },
      { id: 'other', kind: 'background', cwd: '/x', startedAt: 400 },
      { id: 'tty', kind: 'interactive', cwd: '/r', startedAt: 500 },
    ]
    expect(newestBgSince(agents, '/r', 200)?.id).toBe('new')
    expect(newestBgSince(agents, '/r', 350)).toBeUndefined()
  })
  test('agent states', () => {
    expect(bgPhase('done')).toBe('done')
    expect(bgPhase('failed')).toBe('failed')
    expect(bgPhase('stopped')).toBe('failed')
    expect(bgPhase('blocked')).toBe('blocked')
    expect(bgPhase('working')).toBe('active')
    expect(bgPhase(undefined)).toBe('active')
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
    expect(readTranscript(jsonl)).toEqual({ result: 'OK', tail: '[tool Read]\nOK' })
  })
})

describe('/route-eval', () => {
  const ASK = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
  const CASES = [
    '{"id":"a","task":"rename fooBar to foo_bar across utils.py","model":"sonnet","effort":"low","why":"mechanical"}',
    '{"id":"b","task":"rename fooBar to foo_bar across utils.py","model":"fable","effort":"high","why":"deliberately wrong label"}',
  ].join('\n')

  test('rules: scores the labeled file, saves a dated record, and never calls a model', async ($, on) => {
    let modelCalls = 0
    const written: { path: string; text: string }[] = []
    on('fs.read', () => ({ value: CASES }))
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
    expect(ran.text).toContain('b: want fable/high, got sonnet/low')
    expect(modelCalls).toBe(0)
    expect(written).toHaveLength(1)
    expect(written[0]?.path).toMatch(/evals\/results\/.*-rules\.json$/)
    expect(JSON.parse(written[0]?.text ?? '{}').report).toMatchObject({ backend: 'rules', total: 2, exact: 1, underRouted: 1 })
  })

  test('claude: one model call per case; an unparseable reply is that case\'s miss', async ($, on) => {
    let n = 0
    on('fs.read', () => ({ value: CASES }))
    on('fs.write', () => ({ value: undefined }))
    on('model.complete', () => {
      n++
      return { value: { isAnswered: true, text: n === 1 ? '{"model":"sonnet","effort":"low","confidence":0.9,"reason":"mechanical"}' : 'no idea', usage: USAGE } }
    })
    const ran = await $.command.run({ command: 'route-eval', args: 'claude', ...ASK })
    expect(n).toBe(2)
    expect(ran.text).toContain('1/2')
    expect(ran.text).toContain('error: unparseable reply')
  })

  test('a bad argument answers the usage line', async $ => {
    expect((await $.command.run({ command: 'route-eval', args: 'gpt', ...ASK })).text).toContain('Usage: /route-eval')
  })

  test('a missing file answers in words', async ($, on) => {
    on('fs.read', () => {
      throw new Error('ENOENT')
    })
    expect((await $.command.run({ command: 'route-eval', args: 'rules', ...ASK })).text).toContain('No labeled tasks at')
  })
})
