import type { BudgetCaps, ModelTier, RateWindow, RouteDecision } from '../types'
import { budgetVerdict, isSmallRoute, tierOfModelId } from './budget'

// The guard on Claude Code's own Agent tool in a manager session, the pure half: whether this
// session manages a project, what already decides an agent's model, and the budget verdict.
// jobs.tsx holds the agent.spawn hook, the file reads and the router call.

const ROUTE_TEXT_MAX = 6000 // characters of an agent's task the router reads

/** Whether `sessionId` manages a project, from manage.tsx's $.store record (project → { sessionId, ... }). */
export function isManagerSession(stored: unknown, sessionId: string): boolean {
  if (typeof stored !== 'object' || stored === null) return false
  return Object.values(stored as Record<string, unknown>).some(
    m => typeof m === 'object' && m !== null && (m as Record<string, unknown>).sessionId === sessionId,
  )
}

/**
 * What decides an agent's model before the router may: the call's `model`, a definition that
 * pins one (an alias, an id or `inherit`), a fork (always the parent's), nothing (the router
 * sizes it), or unknown (its definition cannot be read, so it is left alone).
 */
export type AgentPin =
  | { by: 'call' | 'definition'; model: string }
  | { by: 'fork' }
  | { by: 'none' }
  | { by: 'unknown' }

export type AgentDef = { name: string; model?: string }

/** An agent file's frontmatter `name` and `model`; undefined without a frontmatter name. */
export function parseAgentFile(text: string): AgentDef | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (m === null) return undefined
  const field = (key: string) => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(m[1] ?? '')
    const v = line?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
    return v === undefined || v === '' ? undefined : v
  }
  const name = field('name')
  return name === undefined ? undefined : { name, model: field('model') }
}

/**
 * The pin of one spawn. `defs` are the agent files found, nearest first (project, then user);
 * `isComplete` says every one of them was read. The only built-in sized is `general-purpose`,
 * which carries no model, and only when the engine offered it as the built-in.
 * CLAUDE_CODE_SUBAGENT_MODEL (`envModel`) pins every agent whose definition names none.
 */
export function pinOf(a: {
  callModel?: string
  isFork: boolean
  type: string
  defs: AgentDef[]
  isComplete: boolean
  offeredAs?: string
  envModel?: string
}): AgentPin {
  const call = a.callModel?.trim()
  if (call) return { by: 'call', model: call }
  if (a.isFork) return { by: 'fork' }
  const unpinned: AgentPin = a.envModel ? { by: 'definition', model: a.envModel } : { by: 'none' }
  const def = a.defs.find(d => d.name === a.type)
  if (def !== undefined) return def.model ? { by: 'definition', model: def.model } : unpinned
  if (!a.isComplete) return { by: 'unknown' }
  if (a.type === 'general-purpose' && a.offeredAs === 'built-in') return unpinned
  return { by: 'unknown' }
}

/** The tier an agent surely runs on, when known without routing. */
export function knownTier(pin: AgentPin, parentModel: string): ModelTier | undefined {
  if (pin.by === 'fork') return tierOfModelId(parentModel)
  if (pin.by === 'call' || pin.by === 'definition') return tierOfModelId(pin.model === 'inherit' ? parentModel : pin.model)
  return undefined
}

/** The zone the account's windows are in, before anything is sized. */
export function budgetZone(windows: RateWindow[], caps: BudgetCaps): 'open' | 'soft' | 'hard' {
  return budgetVerdict(windows, caps, { isSmall: false, isExplicit: false, isForced: false }).zone
}

/** At the hard line, the refusal for every agent; undefined below it. */
export function hardDeny(windows: RateWindow[], caps: BudgetCaps): string | undefined {
  const v = budgetVerdict(windows, caps, { isSmall: false, isExplicit: false, isForced: false })
  if (v.zone !== 'hard' || v.isAllowed) return undefined
  return `${v.reason}. No agent starts past the hard limit and agents have no override: do not retry or work around it; tell the person.`
}

/** Whether the router must be asked: to size an unpinned agent, or to size an unknown one in the soft zone. */
export function needsRoute(windows: RateWindow[], caps: BudgetCaps, pin: AgentPin, parentModel: string): boolean {
  const zone = budgetZone(windows, caps)
  if (zone === 'hard') return false
  return pin.by === 'none' || (zone === 'soft' && knownTier(pin, parentModel) === undefined)
}

/**
 * The verdict on one agent spawn: refused (hard line; or the soft zone and not small), else
 * allowed, with `size` the router's tier when nothing else pins the model. Small: a known
 * model on sonnet or haiku; otherwise a route isSmallRoute accepts. Agents are never forced.
 */
export function agentGuard(
  windows: RateWindow[],
  caps: BudgetCaps,
  pin: AgentPin,
  parentModel: string,
  routed: RouteDecision | undefined,
): { deny: string } | { size?: ModelTier } {
  const hard = hardDeny(windows, caps)
  if (hard !== undefined) return { deny: hard }
  const tier = knownTier(pin, parentModel)
  const isSmall = tier !== undefined ? tier === 'sonnet' || tier === 'haiku' : routed !== undefined && isSmallRoute(routed.model, routed.effort)
  const v = budgetVerdict(windows, caps, { isSmall, isExplicit: false, isForced: false })
  if (!v.isAllowed) {
    const sized = tier !== undefined ? `runs on ${tier}` : routed !== undefined ? `was routed to ${routed.model} at ${routed.effort} effort` : 'could not be sized'
    return {
      deny: `${v.reason}. This agent ${sized}; only small work (a haiku or sonnet model; a task routed to haiku, or to sonnet at low or medium effort) starts in the soft zone. Do not retry or work around it; tell the person.`,
    }
  }
  return pin.by === 'none' && routed !== undefined ? { size: routed.model } : {}
}

/** What the router reads for an agent: its description, then its prompt, cut to ROUTE_TEXT_MAX. */
export function agentRouteText(description: string, prompt: string): string {
  const text = description.trim() ? `${description.trim()}\n\n${prompt}` : prompt
  return text.length > ROUTE_TEXT_MAX ? text.slice(0, ROUTE_TEXT_MAX) : text
}
