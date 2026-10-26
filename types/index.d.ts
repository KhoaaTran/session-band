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

/** `background`: the call answered, its command still runs as a background task. */
export type CallStatus = 'running' | 'background' | 'ok' | 'error' | 'denied'

export type Call = {
  id: string
  tool: string
  /** What the call works on: a file, a command, a pattern, an agent's task. */
  target: string
  /** The turn it ran in, the main loop's or its subagent's; absent when that turn went unheard. */
  turnId?: string
  /** The subagent's loop it ran in; absent on the main loop. */
  agentId?: string
  /** The request whose tool use it answers (`Step.n`). */
  step?: number
  status: CallStatus
  startedAt: number
  /** When the call answered; a background command runs on past it. */
  endedAt?: number
  /** The background task the call left running (a shell moved to the background). */
  taskId?: string
  /** When that task's notification said it ended. */
  taskEndedAt?: number
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

/** One turn: a prompt and everything the model did for it; a subagent's run is one too. */
export type Prompt = {
  turnId: string
  /** The main loop's turn number in the session, those before a resume counted; absent on a subagent's. */
  n?: number
  /** The subagent's loop it ran in; absent on the main loop. */
  agentId?: string
  /** Its row's title: the prompt on one line, a task notification as its summary, cut short. */
  text: string
  startedAt: number
  endedAt?: number
  isAborted: boolean
  costUsd: number
}

export type StepStatus = 'streaming' | 'done' | 'failed'

/**
 * One request of a loop to the model, the main loop's or a subagent's. Token totals are the API's own usage;
 * only the output's split across text, tool use and thinking is estimated.
 */
export type Step = {
  /** 1-based, across the session and every loop: the request's key. */
  n: number
  /** 1-based within its loop, as its row numbers it; a request kept before it was added has `n`. */
  seq?: number
  /** The subagent's loop it ran in; absent on the main loop. */
  agentId?: string
  turnId: string
  model: string
  /** The effort it was sent with, when the model takes one. */
  effort?: string
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
  /** The first lines of the task its spawner gave it, as `AgentBody.prompt` writes it. */
  prompt?: string
  /** The first lines of the report its last run handed back. */
  answer?: string
}

/** The whole task and report of the subagent whose screen is open, from its files. */
export type AgentBody = {
  /** `AgentRun.id`. */
  id: string
  /** The Agent call's `prompt`, as the subagent began with it. */
  prompt?: string
  /** The report its last run handed back; absent while it runs. */
  answer?: string
  /** False when its files are gone: its screen keeps to the first lines `AgentRun` holds. */
  isWhole: boolean
}

export type View = {
  /** What is open: a prompt by its turnId, a request as `s:<n>`. */
  expanded: string[]
  /** Opens the newest request of the prompt in progress; a new prompt sets it, a press clears it. */
  isFollowing: boolean
  isDoneCollapsed: boolean
  /** The call whose own screen is open, by its `Call.id`; the list when absent. */
  detail?: string
  /** The subagent whose own screen is open, by its `AgentRun.id`; a call's screen opened from it goes back to it. */
  agent?: string
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
      agentBody: AgentBody | null
      isPaneOpen: boolean
      /** The header's figures from before this process: a resumed session's earlier ones. */
      carried: Totals | null
    }
  }
}
