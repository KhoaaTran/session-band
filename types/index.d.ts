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

// The activity pane (hooks/activity.tsx).

export type CallStatus = 'running' | 'ok' | 'error' | 'denied'

export type Call = {
  id: string
  tool: string
  /** What the call works on: a file, a command, a pattern, an agent's task. */
  target: string
  /** The main-loop turn it ran in; absent for a subagent's call. */
  turnId?: string
  /** The subagent's loop it ran in; absent on the main loop. */
  agentId?: string
  /** The main-loop request whose tool use it answers (`Step.n`). */
  step?: number
  status: CallStatus
  startedAt: number
  endedAt?: number
  /** Characters of the result as the model reads it. */
  resultChars: number
  /** The first lines of what an errored or denied call answered. */
  error?: string
  /** The first lines of the call's input, as `CallBody.input` writes it. */
  input?: string
  /** The first lines of what a call that ran answered. */
  output?: string
  /** The call answered with no text: `output` is its result record as JSON. */
  isRecord?: boolean
}

/** The whole input and output of the call whose screen is open, from its file. */
export type CallBody = {
  id: string
  /**
   * The input exactly as the tool took it: a shell's command, with the arguments that
   * change its run as JSON under it; any other tool's arguments as JSON.
   */
  input?: string
  /** What the tool answered, as the model read it; its result record when it gave no text. */
  output?: string
  /** False when the call has no file: its screen keeps to the first lines `Call` holds. */
  isWhole: boolean
}

/** One main-loop turn: a prompt and everything the model did for it. */
export type Prompt = {
  turnId: string
  text: string
  startedAt: number
  endedAt?: number
  isAborted: boolean
  costUsd: number
}

export type StepStatus = 'streaming' | 'done' | 'failed'

/**
 * One request of the main loop to the model. Token totals are the API's own usage;
 * only the output's split across text, tool use and thinking is estimated.
 */
export type Step = {
  /** 1-based, across the session. */
  n: number
  turnId: string
  model: string
  status: StepStatus
  stopReason?: string | null
  startedAt: number
  endedAt?: number
  /** Input in all: uncached + cache read + cache write. */
  input?: number
  cacheRead?: number
  /** Input written to the prompt cache: the whole context again once the cache expired. */
  cacheWrite?: number
  /** When the response's first item arrived: before it the wait, after it the writing. */
  firstChunkAt?: number
  output?: number
  /** The output's split, estimated from characters; thinking takes the rest. */
  text: number
  toolUse: number
  thinking: number
  /** The tools the response asked for, in order. */
  tools: string[]
  /** The input shrank against the request before: a compaction ran between. */
  isCompacted: boolean
}

export type AgentStatus ='running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  /** The Agent tool call that spawned it: that call's `Call.id`. */
  toolUseId: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  /** Output tokens over every request of its run. */
  output: number
  costUsd: number
  steps: number
}

export type View = {
  /** What is open: a prompt by its turnId, a request as `s:<n>`. */
  expanded: string[]
  /** Opens the newest request of the prompt in progress; a new prompt sets it, a press clears it. */
  isFollowing: boolean
  isDoneCollapsed: boolean
  /** The call whose own screen is open, by its `Call.id`; the list when absent. */
  detail?: string
}

/**
 * The figures of the pane's session header, summed over what the pane keeps. Saved per
 * session in `$.store`, so a resumed session's header starts from what it showed before;
 * the rows themselves are not kept.
 */
export type Totals = {
  sessionId: string
  /** Prompts sent: those before a resume are counted, not listed. */
  prompts: number
  requests: number
  /** Main-loop tool calls, and those of them that failed or were denied. */
  tools: number
  failed: number
  durationMs: number
  costUsd: number
  /** Every token the API processed, the main loop's and the subagents'. */
  tokens: number
  output: number
  /** The main loop's input, and the part of it read from the cache. */
  mainInput: number
  cacheRead: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-band': {
      stats: Stats
      cache: Cache
      isBusy: boolean
      warned: number
      usage: Usage
      calls: Shaped<Call[]>
      prompts: Shaped<Prompt[]>
      steps: Shaped<Step[]>
      agents: Shaped<AgentRun[]>
      view: Shaped<View>
      now: number
      body: CallBody | null
      isPaneOpen: boolean
      /** The header's figures from before this process: a resumed session's earlier ones. */
      carried: Totals | null
    }
  }
}
