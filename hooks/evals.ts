import type { EvalReport, RouteCase, RouteDecision, RouteOutcome } from '../types'
import { TIERS } from './router'

// Scores a router against labeled tasks. Pure: used by /route-eval in jobs.tsx.

// The router never picks above high, so a label above it would be unreachable.
const LABEL_EFFORTS: readonly string[] = ['low', 'medium', 'high']
const MISS_LIMIT = 10

function isText(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

// One JSON object per line: { id, task, model, effort, why }. Blank lines and lines starting
// with '#' are skipped; a line that does not parse or misses a field is reported, not dropped.
export function parseCases(jsonl: string): { cases: RouteCase[]; errors: string[] } {
  const cases: RouteCase[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  jsonl.split('\n').forEach((raw, i) => {
    const line = raw.trim() // also drops the \r of CRLF files
    if (line === '' || line.startsWith('#')) return
    const at = `line ${i + 1}`
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      errors.push(`${at}: invalid JSON`)
      return
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      errors.push(`${at}: not a JSON object`)
      return
    }
    const r = obj as Record<string, unknown>
    for (const key of ['id', 'task', 'why']) {
      if (!isText(r[key])) {
        errors.push(`${at}: ${key} must be a non-empty string`)
        return
      }
    }
    if (typeof r.model !== 'string' || !(TIERS as readonly string[]).includes(r.model)) {
      errors.push(`${at}: model must be one of ${TIERS.join(', ')}`)
      return
    }
    if (typeof r.effort !== 'string' || !LABEL_EFFORTS.includes(r.effort)) {
      errors.push(`${at}: effort must be one of ${LABEL_EFFORTS.join(', ')}`)
      return
    }
    const id = r.id as string
    if (seen.has(id)) {
      errors.push(`${at}: duplicate id ${id}`)
      return
    }
    seen.add(id)
    cases.push({ id, task: r.task as string, model: r.model as RouteCase['model'], effort: r.effort as RouteCase['effort'], why: r.why as string })
  })
  return { cases, errors }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

// Tier order for over/under-routing is router.ts TIERS. An outcome with `error` counts as
// unanswered and as a miss.
export function scoreRoutes(cases: RouteCase[], outcomes: RouteOutcome[], backend: RouteDecision['backend']): EvalReport {
  const byId = new Map<string, RouteOutcome>()
  for (const o of outcomes) if (!byId.has(o.id)) byId.set(o.id, o) // first outcome per id wins
  const report: EvalReport = {
    backend,
    total: cases.length,
    answered: 0,
    exact: 0,
    modelMatch: 0,
    withinOneTier: 0,
    effortMatch: 0,
    overRouted: 0,
    underRouted: 0,
    medianLatencyMs: 0,
    misses: [],
  }
  const latencies: number[] = []
  for (const c of cases) {
    const o = byId.get(c.id)
    const want = `${c.model}/${c.effort}`
    if (!o || 'error' in o) {
      report.misses.push({ id: c.id, want, got: o ? `error: ${o.error}` : 'no answer' })
      continue
    }
    report.answered++
    latencies.push(o.latencyMs)
    const gap = TIERS.indexOf(o.model) - TIERS.indexOf(c.model)
    const isModel = gap === 0
    const isEffort = o.effort === c.effort
    if (isModel) report.modelMatch++
    if (Math.abs(gap) <= 1) report.withinOneTier++
    if (isEffort) report.effortMatch++
    if (gap > 0) report.overRouted++
    if (gap < 0) report.underRouted++
    if (isModel && isEffort) report.exact++
    else report.misses.push({ id: c.id, want, got: `${o.model}/${o.effort}` })
  }
  report.medianLatencyMs = median(latencies)
  return report
}

function pct(n: number, total: number): string {
  return total === 0 ? '-' : `${Math.round((n / total) * 100)}%`
}

// A plain-text table of the report, at most `columns` wide, for a command's reply.
export function formatReport(reports: EvalReport[], columns: number): string {
  const width = Math.max(1, Math.floor(columns))
  const fit = (s: string) => (s.length > width ? `${s.slice(0, width - 1)}…` : s)
  const head = ['backend', 'answered', 'exact', 'model', 'within-1', 'effort', 'over', 'under', 'median']
  const rows = reports.map(r => [
    r.backend,
    `${r.answered}/${r.total}`,
    pct(r.exact, r.total),
    pct(r.modelMatch, r.total),
    pct(r.withinOneTier, r.total),
    pct(r.effortMatch, r.total),
    pct(r.overRouted, r.total),
    pct(r.underRouted, r.total),
    `${r.medianLatencyMs}ms`,
  ])
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map(row => (row[c] ?? '').length)))
  // Left-align the backend name, right-align the numbers.
  const line = (cells: string[]) => cells.map((s, c) => (c === 0 ? s.padEnd(widths[c] ?? 0) : s.padStart(widths[c] ?? 0))).join('  ').trimEnd()
  const out = [fit(line(head)), ...rows.map(row => fit(line(row)))]
  for (const r of reports) {
    if (r.misses.length === 0) continue
    out.push('', fit(`${r.backend} misses:`))
    for (const m of r.misses.slice(0, MISS_LIMIT)) {
      out.push(fit(`  ${m.id}: want ${m.want}, got ${m.got.replace(/\s+/g, ' ')}`))
    }
    if (r.misses.length > MISS_LIMIT) out.push(fit(`  +${r.misses.length - MISS_LIMIT} more`))
  }
  return out.join('\n')
}
