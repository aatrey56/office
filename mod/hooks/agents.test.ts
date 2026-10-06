import { describe, expect, test } from 'claude-code/testing'

import { freshAgentFiles, parseAgent, STALE_MS, subagentsDir } from './agents'

const NOW = 10_000_000
const PARENT = { sessionId: 'p1', cwd: '/hub' }
const DIR = '/cfg/projects/-hub/p1/subagents'

const row = (type: string, content: unknown[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ type, isSidechain: true, agentId: 'a1', sessionId: 'p1', cwd: '/hub/repo', message: { content }, ...over })
const use = (name: string, input: unknown = {}) => ({ type: 'tool_use', id: 't', name, input })
const result = row('user', [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }])
const META = JSON.stringify({ agentType: 'explore', description: 'Look around the repo', spawnDepth: 1 })

describe('subagent transcripts', () => {
  test('folder and fresh agent files', () => {
    expect(subagentsDir('/cfg/', '/hub', 'p1').dir).toBe(DIR)
    const files = freshAgentFiles(DIR, [
      { name: 'agent-a1.jsonl', kind: 'file', mtimeMs: NOW - 1000 },
      { name: 'agent-a1.meta.json', kind: 'file', mtimeMs: NOW - 1000 },
      { name: 'agent-old.jsonl', kind: 'file', mtimeMs: NOW - STALE_MS - 1 },
      { name: 'workflows', kind: 'dir', mtimeMs: 0 },
    ], NOW)
    expect(files).toEqual([{ id: 'a1', path: `${DIR}/agent-a1.jsonl`, meta: `${DIR}/agent-a1.meta.json`, mtimeMs: NOW - 1000 }])
  })

  test('a running agent: its pending tool call is its activity', () => {
    const [file] = freshAgentFiles(DIR, [{ name: 'agent-a1.jsonl', kind: 'file', mtimeMs: NOW - 1000 }], NOW)
    const tail = ['{"cut', row('assistant', [{ type: 'text', text: 'looking' }]), row('assistant', [use('Grep')], { message: { content: [use('Grep')], stop_reason: 'tool_use' } })].join('\n')
    expect(parseAgent(file!, tail, META, PARENT, NOW)).toEqual({ id: 'a1', sessionId: 'p1', cwd: '/hub/repo', name: 'Look around the…', activity: 'reviewing' })
  })

  test('a finished agent: handed back, ended at its last write', () => {
    const [file] = freshAgentFiles(DIR, [{ name: 'agent-a1.jsonl', kind: 'file', mtimeMs: NOW - 1000 }], NOW)
    const tail = [row('assistant', [use('Bash', { command: 'npm test' })]), result, row('assistant', [use('SubagentHandback')]), result].join('\n')
    expect(parseAgent(file!, tail, undefined, PARENT, NOW)).toMatchObject({ id: 'a1', name: 'a1', endedAt: NOW - 1000 })
  })
})
