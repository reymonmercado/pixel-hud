export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type PlanItem = { content: string; status: 'pending' | 'in_progress' | 'completed' }

export type Plan = { items: PlanItem[] }

export type Run = {
  turnId: string
  prompt: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'stopped' | 'error'
  steps: number
  tools: number
  lastTool?: string
  tokens: Tokens
  costAtStart: number
  plan?: Plan
}

export type SubAgent = {
  key: string
  agentId?: string
  description: string
  type: string
  model?: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'stopped' | 'error'
  steps: number
  tools: number
  lastTool?: string
  tokens: Tokens
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'pixel-hud': {
      run: Run | null
      agents: SubAgent[]
      costUsd: number
      now: number
      limits: Limit[]
    }
  }
}
