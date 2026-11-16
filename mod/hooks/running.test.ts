import { describe, expect, test } from 'claude-code/testing'

import type { Job } from '../types'
import { freshRecord, freshRecords, isOwnKey, jobLabel, publishPlan, runningOf, runningRow, scanned, selfAfter, RUNNING_BEAT_MS, RUNNING_FUTURE_SKEW_MS, RUNNING_STALE_MS } from './running'
import type { ShownJob } from './running'

const NOW = 10_000_000
const job = (over: Partial<Job> = {}): Job => ({ id: 'j1', kind: 'worker', title: 'fix it', cwd: '/r', status: 'running', startedAt: NOW, tail: '', ...over })

describe('running jobs', () => {
  test('a record with a heartbeat older than ~2 minutes is ignored; junk entries are dropped', () => {
    const record = { sessionId: 's1', updatedAt: NOW - RUNNING_STALE_MS, jobs: [{ id: 'a', kind: 'codex-review', label: 'x', startedAt: 1, cwd: '/r' }, { id: 'b' }] }
    expect(freshRecord(record, NOW)?.jobs.map(j => j.id)).toEqual(['a'])
    expect(freshRecord({ ...record, updatedAt: NOW - RUNNING_STALE_MS - 1 }, NOW)).toBeUndefined()
    expect(freshRecord('junk', NOW)).toBeUndefined()
    // A heartbeat dated far ahead (a writer's clock set wrong) would otherwise never go stale.
    expect(freshRecord({ ...record, updatedAt: NOW + RUNNING_FUTURE_SKEW_MS }, NOW)).toBeDefined()
    expect(freshRecord({ ...record, updatedAt: NOW + RUNNING_FUTURE_SKEW_MS + 1 }, NOW)).toBeUndefined()
  })

  test('a failed read keeps what the last scan read there; freshness is checked at each use', () => {
    const rec = (sessionId: string) => ({ sessionId, updatedAt: NOW, jobs: [{ id: 'a', kind: 'worker', label: 'x', startedAt: 1, cwd: '/r' }] })
    const last = new Map<string, unknown>([['running:s1', rec('s1')], ['running:gone', rec('gone')]])
    const held = scanned(last, [['running:s1', 'failed'], ['running:s2', { value: rec('s2') }], ['running:new', 'failed']])
    expect([...held.keys()]).toEqual(['running:s1', 'running:s2'])
    expect(freshRecords(held.values(), NOW + RUNNING_STALE_MS).map(r => r.sessionId)).toEqual(['s1', 's2'])
    expect(freshRecords(held.values(), NOW + RUNNING_STALE_MS + 1)).toEqual([]) // a crashed session's jobs go though no scan ran
  })

  test('after /clear or a resume (a new id), records under the old id and the new are both its own', () => {
    const first = selfAfter(undefined, 'old')
    expect(selfAfter(first, 'old')).toBe(first)
    const now = selfAfter(first, 'new')
    expect(['running:old', 'running:new', 'running:other'].map(k => isOwnKey(now, k))).toEqual([true, true, false])
  })

  test('labels, and only live jobs are published: on a change, as a heartbeat, deleted once none run', () => {
    const review = job({ id: 'r', kind: 'codex-review', title: 'codex review 1/3 vs main (sol)', model: 'gpt-6.1-sol@high' })
    const worker = job({ id: 'w', model: 'claude-opus-5-5', effort: 'high', startedAt: NOW - 1 })
    expect([review, worker, job({ kind: 'codex-exec', model: 'gpt-6-luna@medium' })].map(jobLabel)).toEqual(['codex review r1 sol', 'worker opus/high', 'codex exec luna'])
    const live = runningOf([review, worker, job({ id: 'd', status: 'done', endedAt: NOW })])
    expect(live.map(j => j.id)).toEqual(['w', 'r'])
    const last = { sig: JSON.stringify(live), at: NOW }
    expect([publishPlan(undefined, live, NOW), publishPlan(last, live, NOW + 1), publishPlan(last, live, NOW + RUNNING_BEAT_MS)]).toEqual(['set', 'none', 'set'])
    expect(publishPlan(last, [], NOW + 1)).toBe('delete')
  })

  test('the running row: nothing, one job, several with their sessions', () => {
    const shown = (label: string, minutes: number, owner: string): ShownJob => ({ id: label, kind: 'worker', label, startedAt: NOW - minutes * 60_000, cwd: '/r', sessionId: owner, owner })
    expect(runningRow([], NOW, true)).toBe('running: nothing')
    expect(runningRow([shown('codex review r1 sol', 6, 'a')], NOW, false)).toBe('running: codex review r1 sol 6m')
    expect(runningRow([shown('codex review r1 sol', 6, 'a'), shown('worker opus/high', 72, 'merge-prs')], NOW, true)).toBe(
      'running: codex review r1 sol 6m (a) · worker opus/high 1h12m (merge-prs)',
    )
  })
})
