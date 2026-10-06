// Worker worktrees, the pure halves: a worker started in a git repo gets its own
// branch in its own worktree, so parallel workers never edit the same checkout.
// jobs.tsx runs the git commands; scene/board/manage use projectRootArgv so a
// worktree counts as its main repo's project.

/** Where a worker's worktree lives: <configDir>/office/worktrees/<projectSlug(projectRoot)>/<jobId>. */
export function worktreeDir(configDir: string, projectRoot: string, jobId: string): string {
  throw new Error('not built')
}

/** `office/<jobId>-<first words of the title>`: lowercase ascii kebab-case, at most 40 chars after `office/`. */
export function branchName(jobId: string, title: string): string {
  throw new Error('not built')
}

/** `git -C <projectRoot> worktree add -b <branch> <dir> <base>` */
export function addWorktreeArgv(projectRoot: string, dir: string, branch: string, base: string): string[] {
  throw new Error('not built')
}

/** `git -C <projectRoot> worktree remove <dir>`, never --force: a worktree with uncommitted work stays. */
export function removeWorktreeArgv(projectRoot: string, dir: string): string[] {
  throw new Error('not built')
}

/** `git -C <cwd> rev-parse --path-format=absolute --git-common-dir`: same answer from a repo and from its worktrees. */
export function projectRootArgv(cwd: string): string[] {
  throw new Error('not built')
}

/** The main repo root from projectRootArgv's stdout ('/x/repo/.git\n' → '/x/repo'); null when it is not a `.git` dir. */
export function repoRootFromCommonDir(stdout: string): string | null {
  throw new Error('not built')
}

/** Put before the worker's task: its worktree and branch, and the git rules (commit there, never push or switch branch). */
export function workerPreamble(dir: string, branch: string, base: string): string {
  throw new Error('not built')
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

/** Appended to a finished worker's result: branch, commits, diffstat, and where uncommitted work was left. */
export function worktreeReport(o: WorktreeOutcome): string {
  throw new Error('not built')
}
