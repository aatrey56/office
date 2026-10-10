import { describe, expect, test } from 'claude-code/testing'

import { branchName, checkedOutIn, repoRootFromCommonDir, wipAddArgv, wipCommitArgv, worktreeReport } from './worktree'

const OUTCOME = {
  branch: 'office/j1-fix-login',
  base: '856d578abcdef0123',
  dir: '/cfg/office/worktrees/-x-repo/j1',
  commits: 'abc1234 Fix login\n',
  diffStat: ' login.ts | 2 +-\n',
  isDirty: false,
  isRemoved: false,
}

describe('branchName', () => {
  test('kebab-case under office/, at most 40 chars after it, no trailing dash', () => {
    expect(branchName('j1', 'Fix the Login bug!')).toBe('office/j1-fix-the-login-bug')
    const long = branchName('j2', 'Rewrite the whole session board so it renders worker worktrees nicely')
    const tail = long.slice('office/'.length)
    expect(long.startsWith('office/j2-rewrite-the-whole')).toBe(true)
    expect(tail.length <= 40).toBe(true)
    expect(/^[a-z0-9-]+$/.test(tail) && !tail.endsWith('-')).toBe(true)
  })
})

describe('checkedOutIn', () => {
  test('the worktree a branch is checked out in, from the porcelain listing', () => {
    const listed = 'worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /w/j1\nHEAD 2\nbranch refs/heads/office/j1\n\nworktree /w/d\nHEAD 3\ndetached\n'
    expect(checkedOutIn(listed, 'office/j1')).toBe('/w/j1')
    expect(checkedOutIn(listed, 'office')).toBe(undefined)
  })
})

describe('WIP commit', () => {
  test('adds all but the skipped paths, taken literally; commits with the hooks run (never --no-verify)', () => {
    expect(wipAddArgv('/w/j1', ['data/big*.bin'])).toEqual(['git', '-C', '/w/j1', 'add', '-A', '--', '.', ':(exclude,literal)data/big*.bin'])
    expect(wipCommitArgv('/w/j1', 45)).toEqual(['git', '-C', '/w/j1', 'commit', '-m', 'WIP: timed out at 45 min (office)'])
  })
})

describe('repoRootFromCommonDir', () => {
  test('a repo or worktree gives the main repo root', () => {
    expect(repoRootFromCommonDir('/x/repo/.git\n')).toBe('/x/repo')
  })

  test('a common dir that is not .git gives null', () => {
    expect(repoRootFromCommonDir('/x/bare-repo.git\n')).toBe(null)
  })
})

describe('worktreeReport', () => {
  test('dirty: says where the uncommitted work was left', () => {
    const out = worktreeReport({ ...OUTCOME, isDirty: true })
    expect(out).toContain('Branch office/j1-fix-login (from 856d578)')
    expect(out).toContain('abc1234 Fix login')
    expect(out).toContain('Uncommitted changes left in /cfg/office/worktrees/-x-repo/j1')
    expect(out).not.toContain('worktree removed')
  })

  test('removed with no commits', () => {
    const out = worktreeReport({ ...OUTCOME, commits: '', diffStat: '', isRemoved: true })
    expect(out).toContain('no commits')
    expect(out).toContain('worktree removed, branch kept')
    expect(out).not.toContain('Uncommitted')
  })
})
