import type { EvalReport, RouteCase, RouteDecision, RouteOutcome } from '../types'

// Scores a router against labeled tasks. Pure: used by /route-eval in jobs.tsx.
// CONTRACT STUB: signatures are fixed; the bodies are the evals builder's.

// One JSON object per line: { id, task, model, effort, why }. Blank lines and lines starting
// with '#' are skipped; a line that does not parse or misses a field is reported, not dropped.
export function parseCases(jsonl: string): { cases: RouteCase[]; errors: string[] } {
  throw new Error('not implemented')
}

// Tier order for over/under-routing is router.ts TIERS. An outcome with `error` counts as
// unanswered and as a miss.
export function scoreRoutes(cases: RouteCase[], outcomes: RouteOutcome[], backend: RouteDecision['backend']): EvalReport {
  throw new Error('not implemented')
}

// A plain-text table of the report, at most `columns` wide, for a command's reply.
export function formatReport(reports: EvalReport[], columns: number): string {
  throw new Error('not implemented')
}
