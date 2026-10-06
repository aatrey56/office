// The inputs of the MCP tools this plugin registers ($.tool.register in board.tsx, manage.tsx,
// jobs.tsx), declared by hand so tsc does not depend on which session last wrote
// .claude-plugin/types/claude-code-mcp/: a worker session (OFFICE_WORKER) registers only
// list_sessions and session_usage, and the file it writes drops the rest.
// Keep each entry identical to what the engine generates from the inputSchema: the two
// declarations merge, and a mismatch is a tsc error (TS2717) that points here.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    mcp__office__list_sessions: {}
    mcp__office__session_usage: {}
    mcp__office__message_session: {
      sessionId: string
      text: string
    }
    mcp__office__post_note: {
      text: string
      tag?: "plan" | "decision" | "result" | "blocker" | "handoff"
    }
    mcp__office__read_notes: {
      last?: number
    }
    mcp__office__codex_review: {
      target?: string
      instructions?: string
      deep?: boolean
      cwd?: string
    }
    mcp__office__codex_exec: {
      prompt: string
      cwd?: string
    }
    mcp__office__spawn_worker: {
      task: string
      mode?: "bg" | "headless" | "subagent"
      model?: string
      effort?: "low" | "medium" | "high" | "xhigh" | "max"
      cwd?: string
    }
    mcp__office__route_task: {
      task: string
    }
  }
}
