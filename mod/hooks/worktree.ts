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

/** A `branch` or `base` a caller gave is refused when git could read it as an option. */
export function refArgError(what: 'branch' | 'base', ref: string): string | undefined {
  return ref.startsWith('-') ? `${what} "${ref}" may not start with "-".` : undefined
}

/** `git -C <cwd> rev-parse --verify --quiet <base>^{commit}`: the commit a given base names. */
export function resolveBaseArgv(cwd: string, base: string): string[] {
  return ['git', '-C', cwd, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`]
}

/** The worktree `branch` is checked out in, from `git worktree list --porcelain`; undefined when none. */
export function checkedOutIn(porcelain: string, branch: string): string | undefined {
  let dir: string | undefined
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}`) return dir
  }
  return undefined
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
    `You work in the git worktree ${dir}, already on your own branch ${branch}, started from ${base}.`,
    'Commit your work on this branch with clear messages: it is the branch your result is read from.',
    'Never switch, create or rename branches (no git switch, git checkout <branch>, git branch -m), even if the task says to: your branch is already set up.',
    'Never push, never touch other worktrees or the main checkout.',
    'Dependencies (node_modules, venvs) may be missing in a fresh worktree: install them if a check needs them.',
    'If a guard, hook or permission check blocks an action, stop and report it; never route around it another way.',
    '',
    'Task:',
  ].join('\n')
}

/** Files over this size are left out of a WIP commit (and stay uncommitted in the kept worktree). */
export const WIP_MAX_BYTES = 5 * 1024 * 1024

/** `git -C <dir> ls-files -z --others --modified --exclude-standard`: every file `add -A` would take. */
export function wipCandidatesArgv(dir: string): string[] {
  return ['git', '-C', dir, 'ls-files', '-z', '--others', '--modified', '--exclude-standard']
}

/** `git -C <dir> diff --cached --name-only -z --no-renames`: what the worker already staged, which ls-files --modified misses. */
export function wipStagedArgv(dir: string): string[] {
  return ['git', '-C', dir, 'diff', '--cached', '--name-only', '-z', '--no-renames']
}

/** `git -C <dir> reset -q -- <paths>` (taken literally): out of the index, still in the worktree. */
export function wipUnstageArgv(dir: string, paths: readonly string[]): string[] {
  return ['git', '-C', dir, 'reset', '-q', '--', ...paths.map(p => `:(literal)${p}`)]
}

/** `git -C <dir> add -A` of the whole worktree but the `skipped` paths (relative to it, taken literally). */
export function wipAddArgv(dir: string, skipped: readonly string[]): string[] {
  return ['git', '-C', dir, 'add', '-A', '--', '.', ...skipped.map(p => `:(exclude,literal)${p}`)]
}

/** The WIP commit of a worker ended past its time; never --no-verify, so the repo's hooks still run. */
export function wipCommitArgv(dir: string, minutes: number): string[] {
  return ['git', '-C', dir, 'commit', '-m', `WIP: timed out at ${minutes} min (office)`]
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
