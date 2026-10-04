// Router: the shared rubric and every pure piece of the three backends.
// The `$`-calling halves (Jev's fetch, the claude completion) live in
// jobs.tsx, since the engine follows `$` only into same-file functions.
import type { Effort, ModelTier, RouteDecision } from '../types'

export const TIERS: readonly ModelTier[] = ['haiku', 'sonnet', 'opus', 'fable']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/**
 * The levels a router backend may choose. xhigh and max are taken only when
 * a caller names them explicitly (a tool arg, `/spawn --effort xhigh`).
 */
export const ROUTED_EFFORTS: readonly Effort[] = ['low', 'medium', 'high']
/** A routed effort above the cap comes back as `high`. */
export function capRoutedEffort(e: Effort): Effort {
  return (ROUTED_EFFORTS as readonly string[]).includes(e) ? e : 'high'
}

export const MODEL_IDS: Record<ModelTier, string> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5',
}

// Haiku 4.5 retires around 2026-10-15; after that no backend may pick it.
export const HAIKU_RETIRES_AT = Date.UTC(2026, 9, 15)
export function haikuAvailable(now: number): boolean {
  return now < HAIKU_RETIRES_AT
}
export function tiersAt(now: number): ModelTier[] {
  return TIERS.filter(t => t !== 'haiku' || haikuAvailable(now))
}

// ── the rubric every backend uses ─────────────────────────────────────────
export const TIER_CRITERIA: Record<ModelTier, string> = {
  haiku:
    'claude-haiku-4-5 ($1/$5 per MTok): trivial text work with no code judgment: summarize, classify, tag, extract fields.',
  sonnet:
    'claude-sonnet-5-5 ($2/$10): well-specified mechanical changes: rename, format, lint fixes, small single-file edits, boilerplate, simple lookups.',
  opus:
    'claude-opus-5-5 ($4/$20): real engineering judgment: debugging, code review, refactors, multi-file features, writing meaningful tests.',
  fable:
    'claude-fable-5-1 ($10/$50, slowest): architecture and system design, open-ended research, ambiguous problems spanning several systems, high-stakes decisions.',
}
export const EFFORT_CRITERIA: Record<Effort, string> = {
  low: 'Mechanical; the answer is obvious once the files are open.',
  medium: 'Routine work needing some judgment.',
  high: 'Debugging, review, refactoring, architecture or design where mistakes are costly. The ceiling: even the hardest task gets high.',
  xhigh: 'Never chosen by the router; only when a caller asks for it explicitly.',
  max: 'Never chosen by the router; only when a caller asks for it explicitly.',
}

export function rubricText(now: number): string {
  const tiers = tiersAt(now)
    .map(t => `- ${t}: ${TIER_CRITERIA[t]}`)
    .join('\n')
  const efforts = ROUTED_EFFORTS.map(e => `- ${e}: ${EFFORT_CRITERIA[e]}`).join('\n')
  return [
    'Pick the CHEAPEST model tier that will do the task well, and the lowest effort that suffices.',
    'Model tiers:',
    tiers,
    'Effort levels (high is the maximum you may choose):',
    efforts,
  ].join('\n')
}

export type Routed = Omit<RouteDecision, 'backend' | 'latencyMs'>

// ── backend 3: rules (instant, never fails) ──────────────────────────────
type Rule = { test: RegExp; model: ModelTier; effort: Effort; confidence: number; why: string }

const SYSTEM_WORDS =
  /\b(api|database|db|frontend|backend|infra|auth|queue|cache|service|pipeline|warehouse|deploy|ci)\b/gi

const RULES: readonly Rule[] = [
  {
    test: /\b(architect\w*|system design|design (?:a|the|our) \w+ system|research|investigat\w*|trade-?offs?|migration (?:plan|strategy)|across (?:services|systems|repos))\b/i,
    model: 'fable',
    effort: 'high',
    confidence: 0.6,
    why: 'architecture / research / cross-system work',
  },
  {
    test: /\b(review|refactor\w*|debug\w*|root cause|race condition|flaky|regression|failing tests?|fix (?:a |the )?bug|bug ?fix|security)\b/i,
    model: 'opus',
    effort: 'high',
    confidence: 0.6,
    why: 'review / refactor / debugging needs judgment',
  },
  {
    test: /\b(rename|format\w*|lint\w*|typos?|prettier|whitespace|sort imports|bump (?:the )?version)\b/i,
    model: 'sonnet',
    effort: 'low',
    confidence: 0.7,
    why: 'mechanical edit',
  },
  {
    // Only words that are not also code work (no extract / tag / label: "extract a function").
    test: /\b(summari[sz]e|summary|classify|categori[sz]e|tl;?dr)\b/i,
    model: 'haiku',
    effort: 'low',
    confidence: 0.6,
    why: 'summarize / classify',
  },
  {
    test: /\b(implement|add|write|build|create|tests?)\b/i,
    model: 'opus',
    effort: 'medium',
    confidence: 0.4,
    why: 'feature work',
  },
]

export function rulesRoute(task: string, now: number): Routed {
  const systems = new Set((task.match(SYSTEM_WORDS) ?? []).map(w => w.toLowerCase()))
  if (systems.size >= 3) {
    return {
      model: 'fable',
      effort: 'high',
      confidence: 0.5,
      reason: `rules: touches ${systems.size} systems (${[...systems].join(', ')})`,
    }
  }
  for (const rule of RULES) {
    if (!rule.test.test(task)) continue
    const model = rule.model === 'haiku' && !haikuAvailable(now) ? 'sonnet' : rule.model
    const note = model !== rule.model ? ' (haiku retired; sonnet instead)' : ''
    return { model, effort: rule.effort, confidence: rule.confidence, reason: `rules: ${rule.why}${note}` }
  }
  return { model: 'sonnet', effort: 'medium', confidence: 0.3, reason: 'rules: no rule matched; default' }
}

// ── backend 2: claude (JSON-only completion) ─────────────────────────────
export const CLAUDE_SYSTEM =
  'You route coding tasks to a model tier. Reply with ONE JSON object and nothing else: no prose, no code fence.'

export function claudePrompt(task: string, now: number): string {
  const tiers = tiersAt(now).join('|')
  return [
    rubricText(now),
    '',
    `Answer exactly: {"model":"${tiers}","effort":"${ROUTED_EFFORTS.join('|')}","confidence":0.0-1.0,"reason":"<one short sentence>"}`,
    '',
    '<task>',
    task,
    '</task>',
  ].join('\n')
}

function normalizeTier(raw: unknown): ModelTier | undefined {
  if (typeof raw !== 'string') return undefined
  const s = raw.toLowerCase()
  return TIERS.find(t => s === t || s.includes(t))
}
function normalizeEffort(raw: unknown): Effort | undefined {
  if (typeof raw !== 'string') return undefined
  const s = raw.toLowerCase().replace(/[^a-z]/g, '')
  if (s === 'extrahigh' || s === 'veryhigh') return 'xhigh'
  if (s === 'med') return 'medium'
  return EFFORTS.find(e => e === s)
}

/** The first balanced {...} in `text`, string-aware; undefined if none. */
export function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return undefined
}

/** Parses the claude backend's reply; undefined when it is unusable. */
export function parseClaudeRoute(text: string, now: number): Routed | undefined {
  const json = firstJsonObject(text)
  if (json === undefined) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  let model = normalizeTier(o.model ?? o.tier)
  const rawEffort = normalizeEffort(o.effort)
  if (model === undefined || rawEffort === undefined) return undefined
  const effort = capRoutedEffort(rawEffort)
  let reason = typeof o.reason === 'string' ? o.reason.slice(0, 300) : ''
  if (model === 'haiku' && !haikuAvailable(now)) {
    model = 'sonnet'
    reason += ' (haiku retired; sonnet instead)'
  }
  const c = typeof o.confidence === 'string' ? Number(o.confidence) : o.confidence
  const confidence = typeof c === 'number' && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5
  return { model, effort, confidence, reason: reason.trim() || 'claude router' }
}

// ── backend 1: TypeSafe Jev via AI/ML API ────────────────────────────────
// Schema per https://docs.aimlapi.com/api-references/decision-models/typesafe/jev
// and https://aimlapi.com/models/typesafe-jev: POST /v1/decisions with
// { model, state, questions: { key: { type: 'choice', instructions, criteria: { option: description } } } },
// answered { model, answers: { key: { type: 'choice', choice, confidence, probabilities } }, usage }.
export function jevRequestBody(task: string, now: number): string {
  const tierCriteria: Record<string, string> = {}
  for (const t of tiersAt(now)) tierCriteria[t] = TIER_CRITERIA[t]
  return JSON.stringify({
    model: 'typesafe/jev',
    state: task,
    questions: {
      model: {
        type: 'choice',
        instructions:
          'Which Claude model tier should handle this coding task? Pick the cheapest tier that will do it well.',
        criteria: tierCriteria,
      },
      effort: {
        type: 'choice',
        instructions: 'How much reasoning effort does this task need? Pick the lowest level that suffices.',
        criteria: Object.fromEntries(ROUTED_EFFORTS.map(e => [e, EFFORT_CRITERIA[e]])),
      },
    },
  })
}

type JevChoice = { type?: string; choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> }

function jevPick(answer: JevChoice | undefined): { value: string; confidence: number } | undefined {
  if (answer === undefined || typeof answer.choice !== 'string') return undefined
  const conf = typeof answer.confidence === 'number' ? answer.confidence : undefined
  const prob = answer.probabilities?.[answer.choice]
  const confidence = conf ?? (typeof prob === 'number' ? prob : 0.5)
  return { value: answer.choice, confidence: Math.min(1, Math.max(0, confidence)) }
}

/** Parses a /v1/decisions reply; undefined when either answer is unusable. */
export function parseJevResponse(text: string, now: number): Routed | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  const answers = (raw as { answers?: Record<string, JevChoice> } | null)?.answers
  const m = jevPick(answers?.model)
  const e = jevPick(answers?.effort)
  let model = normalizeTier(m?.value)
  const picked = normalizeEffort(e?.value)
  if (m === undefined || e === undefined || model === undefined || picked === undefined) return undefined
  const effort = capRoutedEffort(picked)
  if (model === 'haiku' && !haikuAvailable(now)) model = 'sonnet'
  return {
    model,
    effort,
    confidence: Math.min(m.confidence, e.confidence),
    reason: `jev: ${model} (conf ${m.confidence.toFixed(2)}), ${effort} (conf ${e.confidence.toFixed(2)})`,
  }
}

/**
 * A tier name or a full model id, as a caller gave it, to the id to run.
 * Haiku (tier or any claude-haiku id) becomes sonnet once Haiku has retired,
 * an explicit request included.
 */
export function modelIdFor(model: string, now: number): string {
  const m = model.trim().toLowerCase()
  const isHaiku = m === 'haiku' || m.startsWith('claude-haiku')
  if (isHaiku && !haikuAvailable(now)) return MODEL_IDS.sonnet
  const tier = TIERS.find(t => t === m)
  return tier ? MODEL_IDS[tier] : model.trim()
}
export function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)
}
