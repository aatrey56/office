// Codex review handoff: the pure halves (argv, target choice, JSONL events,
// error hints, tool specs). The hooks that run it are in jobs.tsx.

export const CODEX_LOGIN_HINT =
  'Codex is not logged in (`codex login status` failed). Run `codex login` in a terminal, then retry.'

export type ReviewTarget = { args: string[]; label: string }

/**
 * `/codex-review` and `codex_review`'s target: `--uncommitted`,
 * `--commit <sha>`, `--base <branch>` or a bare branch name.
 * Empty answers undefined: the caller picks from the tree's state.
 */
export function parseReviewTarget(raw: string | undefined): ReviewTarget | undefined {
  const words = (raw ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return undefined
  const [first, second] = words
  if (first === '--uncommitted' || first === 'uncommitted') return { args: ['--uncommitted'], label: 'uncommitted changes' }
  if ((first === '--commit' || first === 'commit') && second) return { args: ['--commit', second], label: `commit ${second}` }
  if ((first === '--base' || first === 'base') && second) return { args: ['--base', second], label: `vs ${second}` }
  if (first && !first.startsWith('-')) return { args: ['--base', first], label: `vs ${first}` }
  return undefined
}

/** The default target: dirty tree → uncommitted; else the first base branch that exists. */
export function defaultReviewTarget(porcelain: string, branches: readonly string[]): ReviewTarget {
  if (porcelain.trim() !== '') return { args: ['--uncommitted'], label: 'uncommitted changes' }
  const base = branches.find(b => b === 'main') ?? branches.find(b => b === 'master') ?? 'main'
  return { args: ['--base', base], label: `vs ${base}` }
}

/**
 * A Codex model and reasoning effort, passed as config overrides
 * (`codex exec --help`: `-c key=value`, value parsed as TOML).
 * Slugs as ~/.codex/models_cache.json lists them for a ChatGPT plan.
 */
export type CodexTier = { model: string; effort: string }
export const CODEX_DEFAULTS = {
  review: { model: 'gpt-6-sol', effort: 'high' }, // /codex-review, codex_review
  exec: { model: 'gpt-6-luna', effort: 'medium' }, // codex_exec second opinions
  deep: { model: 'gpt-6-astra', effort: 'high' }, // only `--deep` / deep: true; scarce quota
} as const satisfies Record<string, CodexTier>

export function codexTierArgs(tier: CodexTier, isReview = false): string[] {
  const out: string[] = []
  const model = tier.model.trim()
  if (model) out.push('-c', `model=${JSON.stringify(model)}`)
  // config.toml's review_model would otherwise win over `model` for a review.
  if (model && isReview) out.push('-c', `review_model=${JSON.stringify(model)}`)
  if (tier.effort.trim()) out.push('-c', `model_reasoning_effort=${JSON.stringify(tier.effort.trim())}`)
  return out
}

/** `/codex-review` args: `--deep` anywhere asks for the deep tier; the rest is the target. */
export function splitDeep(raw: string | undefined): { deep: boolean; rest: string } {
  const words = (raw ?? '').trim().split(/\s+/).filter(Boolean)
  const deep = words.includes('--deep')
  return { deep, rest: words.filter(w => w !== '--deep').join(' ') }
}

/**
 * `codex exec review` (the non-interactive review, with `--json` events and
 * `-o` for the final message). codex 0.142 refuses a [PROMPT] beside
 * `--uncommitted`/`--base`/`--commit` ("cannot be used with '[PROMPT]'"), so
 * with custom instructions the target flag is dropped and the target is
 * described in the stdin prompt instead (`-`; see codexReviewPrompt).
 */
export function codexReviewArgv(
  bin: string,
  target: ReviewTarget,
  outFile: string,
  tier: CodexTier,
  hasInstructions: boolean,
): string[] {
  return [
    bin, 'exec', 'review', ...codexTierArgs(tier, true), ...(hasInstructions ? [] : target.args),
    '--json', '-o', outFile, ...(hasInstructions ? ['-'] : []),
  ]
}

/** The stdin prompt for a review with custom instructions: target + focus. */
export function codexReviewPrompt(target: ReviewTarget, instructions: string): string {
  const [flag, value] = target.args
  const what =
    flag === '--commit'
      ? `Review the changes introduced by commit ${value} (see \`git show ${value}\`).`
      : flag === '--base'
        ? `Review the changes on the current branch against the base branch ${value} (see \`git diff ${value}...HEAD\`).`
        : 'Review the uncommitted changes in this repository: staged, unstaged and untracked files (see `git status` and `git diff HEAD`).'
  return `${what}\n\nAdditional review instructions:\n${instructions}`
}

/** `codex exec` in a read-only sandbox for a second opinion; the prompt rides stdin. */
export function codexExecArgv(bin: string, outFile: string, tier: CodexTier): string[] {
  return [
    bin, 'exec', ...codexTierArgs(tier), '--sandbox', 'read-only', '--skip-git-repo-check',
    '--json', '-o', outFile, '-',
  ]
}

/**
 * One `--json` line as tail text. Events seen from codex 0.1xx:
 * thread.started, turn.started, item.started / item.completed with
 * item.type agent_message | reasoning | command_execution | ...,
 * turn.completed, turn.failed { error }, error { message }.
 * Parsed defensively; an unknown line is kept as is.
 */
export function codexEventText(line: string): { tail?: string; message?: string; error?: string } {
  const trimmed = line.trim()
  if (trimmed === '') return {}
  let o: Record<string, unknown>
  try {
    o = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return { tail: trimmed + '\n' }
  }
  const type = String(o.type ?? '')
  const item = o.item as Record<string, unknown> | undefined
  if (type === 'item.completed' && item) {
    const kind = String(item.type ?? '')
    if (kind === 'agent_message' && typeof item.text === 'string') return { tail: item.text + '\n', message: item.text }
    if (kind === 'command_execution') return { tail: `$ ${String(item.command ?? '')}\n` }
    if (typeof item.text === 'string') return { tail: `[${kind}] ${item.text.slice(0, 200)}\n` }
    return { tail: `[${kind}]\n` }
  }
  if (type === 'turn.failed' || type === 'error') {
    const err = (o.error as { message?: unknown } | undefined)?.message ?? o.message
    const text = typeof err === 'string' ? err : JSON.stringify(o)
    return { tail: `ERROR: ${text}\n`, error: text }
  }
  return {}
}

/**
 * Codex's own usage-limit wording, from the 0.142.5 binary's strings:
 * "You've hit your usage limit for …", "Usage limit reached. You've reached
 * your usage limit.", error codes usage_limit_exceeded / *usage_limit_reached /
 * rate_limit_reached, and the reset as " Try again at <time>" (or "in <span>").
 */
const CODEX_QUOTA = /You've hit your usage limit|You've reached your usage limit|Usage limit reached|usage_limit_(?:exceeded|reached)|rate_limit_reached/i

/**
 * Matched on codex's error text alone: a note naming the model and the reset
 * ("Codex quota hit for gpt-6-sol, resets at 3:11 AM."), undefined otherwise.
 */
export function codexQuotaMessage(errorText: string, model: string): string | undefined {
  if (!CODEX_QUOTA.test(errorText)) return undefined
  const reset = errorText.match(/try again (at|in) ([^\n."}]+)/i)
  const when = reset ? `, resets ${reset[1]!.toLowerCase()} ${reset[2]!.trim()}` : ''
  return `Codex quota hit for ${model || 'the configured model'}${when}.`
}

/** A hint for a failure codex reported; '' when there is none to add. */
export function codexFailureHint(text: string): string {
  if (/not supported when using Codex with a ChatGPT account/i.test(text)) {
    return 'Hint: that model is not available on a ChatGPT login; change the office plugin\'s codexReviewModel / codexExecModel / codexDeepModel.'
  }
  if (/not logged in|login|unauthori[sz]ed|401/i.test(text)) return CODEX_LOGIN_HINT
  return ''
}

export const CODEX_REVIEW_TOOL = {
  name: 'codex_review',
  description:
    'Hand the current repo\'s changes to OpenAI Codex for an independent code review (`codex exec review`). ' +
    'Returns a job id at once; the review runs in the background (minutes) and its text is appended to this conversation when done.',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description:
          '"--uncommitted", "--commit <sha>", "--base <branch>" or a branch name. Default: uncommitted if the tree is dirty, else vs main/master.',
      },
      instructions: { type: 'string', description: 'Custom review focus for Codex.' },
      deep: {
        type: 'boolean',
        description: 'Use the scarce deep-review model (gpt-6-astra). Only when the user explicitly asks for a deep review.',
      },
      cwd: { type: 'string', description: 'Repo directory (absolute); default the session cwd.' },
    },
  },
}

export const CODEX_EXEC_TOOL = {
  name: 'codex_exec',
  description:
    'Ask OpenAI Codex (`codex exec`, read-only sandbox) for a second opinion on a plan, design or question. ' +
    'Give a self-contained prompt. Returns a job id at once; the answer is appended to this conversation when done.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The whole question, self-contained.' },
      cwd: { type: 'string', description: 'Directory Codex may read (absolute); default the session cwd.' },
    },
    required: ['prompt'],
  },
}
