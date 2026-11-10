export type LineKind = 'tool' | 'text' | 'think' | 'info'
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
    'agent-board': { agents: Shaped<AgentCard[]> }
  }
}
