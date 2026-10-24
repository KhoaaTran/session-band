export type Stats = {
  turn: number
  speed: number | null
}

export type Cache = {
  ttlSeconds: number
  expiresAt: number | null
  secondsLeft: number | null
}

export type Limit = {
  percentUsed: number
  resetsAt: string | null
}

export type Usage = {
  context: { percent: number; tokens: number | null; window: number } | null
  fiveHour: Limit | null
  weekly: Limit | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-band': { stats: Stats; cache: Cache; isBusy: boolean; warned: number; usage: Usage }
  }
}
