// Worker worktrees, the pure halves: a worker started in a git repo gets its own
// branch in its own worktree, so parallel workers never edit the same checkout.
// jobs.tsx runs the git commands; scene/board/manage use projectRootArgv so a
// worktree counts as its main repo's project.

import { projectSlug } from './sessions'

const BRANCH_MAX = 40 // chars after `office/`

/** Where a worker's worktree lives: <configDir>/office/worktrees/<projectSlug(projectRoot)>/<jobId>. */
export function worktreeDir(configDir: string, projectRoot: string, jobId: string): string {
  return `${configDir}/office/worktrees/${projectSlug(projectRoot)}/${jobId}`
}

/** `office/<jobId>-<first words of the title>`: lowercase ascii kebab-case, at most 40 chars after `office/`. */
export function branchName(jobId: string, title: string): string {
  const kebab = `${jobId}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '')
  return `office/${kebab.slice(0, BRANCH_MAX).replace(/-+$/, '')}`
}

/** `git -C <projectRoot> worktree add -b <branch> <dir> <base>` */
export function addWorktreeArgv(projectRoot: string, dir: string, branch: string, base: string): string[] {
  return ['git', '-C', projectRoot, 'worktree', 'add', '-b', branch, dir, base]
}

/** `git -C <projectRoot> worktree remove <dir>`, never --force: a worktree with uncommitted work stays. */
export function removeWorktreeArgv(projectRoot: string, dir: string): string[] {
  return ['git', '-C', projectRoot, 'worktree', 'remove', dir]
}

/** `git -C <cwd> rev-parse --path-format=absolute --git-common-dir`: same answer from a repo and from its worktrees. */
export function projectRootArgv(cwd: string): string[] {
  return ['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']
}

/** The main repo root from projectRootArgv's stdout ('/x/repo/.git\n' → '/x/repo'); null when it is not a `.git` dir. */
export function repoRootFromCommonDir(stdout: string): string | null {
  const dir = stdout.trim()
  return dir.endsWith('/.git') ? dir.slice(0, -'/.git'.length) || null : null
}

/** Put before the worker's task: its worktree and branch, and the git rules (commit there, never push or switch branch). */
export function workerPreamble(dir: string, branch: string, base: string): string {
  return [
    `You work in the git worktree ${dir} on branch ${branch}, started from ${base}.`,
    'Commit your work on this branch with clear messages.',
    'Never push, never switch branches, never touch other worktrees or the main checkout.',
    'Dependencies (node_modules, venvs) may be missing in a fresh worktree: install them if a check needs them.',
    'If a guard, hook or permission check blocks an action, stop and report it; never route around it another way.',
    '',
    'Task:',
  ].join('\n')
}

export type WorktreeOutcome = {
  branch: string
  base: string
  dir: string
  commits: string // `git log --oneline <base>..<branch>` stdout
  diffStat: string // `git diff --stat <base>..<branch>` stdout
  isDirty: boolean // uncommitted changes were left in the worktree
  isRemoved: boolean // the worktree was removed (the branch always stays)
}

/** Appended to a finished worker's result: branch, commits, diffstat, and where a kept worktree is. */
export function worktreeReport(o: WorktreeOutcome): string {
  const lines = [`Branch ${o.branch} (from ${o.base.slice(0, 7)})`]
  lines.push(o.commits.trim() || 'no commits')
  if (o.diffStat.trim()) lines.push(o.diffStat.trim())
  if (o.isDirty) lines.push(`Uncommitted changes left in ${o.dir}`)
  else if (!o.isRemoved) lines.push(`Worktree kept at ${o.dir}`)
  if (o.isRemoved) lines.push('worktree removed, branch kept')
  return lines.join('\n')
}
