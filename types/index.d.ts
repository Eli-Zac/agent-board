export type LineKind = 'tool' | 'out' | 'err' | 'text' | 'think' | 'info'
export type BoardLine = { kind: LineKind; text: string }
export type AgentStatusWord = 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'killed'
export type AgentCard = {
  id: string
  description: string
  type: string
  model?: string
  status: AgentStatusWord
  startedAt: number
  endedAt?: number
  tools: number
  log: BoardLine[]
  live: string
  liveKind: 'text' | 'think' | 'none'
}

declare module 'claude-code' {
  interface PluginState {
    'agent-board': {
      agents: Shaped<AgentCard[]>
      /** Per agent id: the first wrapped line a scrolled-back card shows. Absent = following live output. */
      scrollTop: Record<string, number>
      /** Agent ids cleared with Clear completed; the tick doesn't bring these back while they stay finished. */
      dismissed: Record<string, true>
    }
  }
}
