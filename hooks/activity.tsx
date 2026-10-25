import { atom, read, update } from 'claude-code'
import type {
  CommandPresentation,
  EngineInterface,
  Register,
  RenderChildren,
  TurnCompleteInput,
  TurnStartInput,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code'

import type { AgentRun, Call, CallBody, CallStatus, Prompt, Step, View } from '../types'

// The band's full view: a pane of what the session does, opened from the band's button
// beside Context, `/activity` or ctrl+x ctrl+p. Each prompt lists its requests to the model,
// each with a bar of the context it fills (after turn-inspector, davila7/claude-code-templates);
// open a request for its input and output and the table of the tool calls it asked for.
// The subagents sit above (merged from the old agents-panel), and while a subagent's
// transcript is in view the pane shows that subagent's own calls. No session-wide context
// bar: the band shows it.

const PANE = 'activity'
// The key of a call's screen's Back button.
const BACK = 'back'
const TITLE = 'Activity'
// Asked of the dock, which gives at most 45% of the terminal: the widest it allows.
// A width the person dragged or keyed it to wins.
const COLUMNS = 100
// Seated above the prompt, the pane asks for this many rows, not the third it would take,
// so the band above the prompt (session-band) keeps room; it scrolls past them.
const INLINE_ROWS = 10
const DOCK_MIN_COLUMNS = 110
// The right half of a request's or prompt's row: "⚠ 416k · 8s", "≈$0.31 · 01:20".
const METRICS_COLUMNS = 16

const MAX_CALLS = 1000
const MAX_PROMPTS = 100
const MAX_STEPS = 300
const MAX_AGENTS = 100
// A tool call that ran this long is drawn in the warning hue.
const SLOW_MS = 30_000
// Calls listed under one request, and prompts listed; the earlier ones fold into a line.
const MAX_ROWS = 12
const MAX_PROMPTS_SHOWN = 15
const CHARS_PER_TOKEN = 4

const calls = atom({ plugin: 'session-band', key: 'calls' } as const, [], { shape: 'calls-1' })
const prompts = atom({ plugin: 'session-band', key: 'prompts' } as const, [], { shape: 'prompts-1' })
const steps = atom({ plugin: 'session-band', key: 'steps' } as const, [], { shape: 'steps-1' })
const agents = atom({ plugin: 'session-band', key: 'agents' } as const, [], { shape: 'agents-5' })
const view = atom(
  { plugin: 'session-band', key: 'view' } as const,
  { expanded: [], isFollowing: true, isDoneCollapsed: true },
  { shape: 'view-1' },
)
const now = atom({ plugin: 'session-band', key: 'now' } as const, 0)
// The whole input and output of the call whose screen is open, read from its file.
const body = atom({ plugin: 'session-band', key: 'body' } as const, null)
// The pane is open: the band's button (register.tsx) reads it for its label.
const isPaneOpen = atom({ plugin: 'session-band', key: 'isPaneOpen' } as const, false)

// Catppuccin Mocha, the band's own hues (register.tsx): every item "Label: value", the
// label in the item's hue, the value bold, items split by a muted " · ".
const PROMPT = '#f5c2e7'
const REQUEST = '#b4befe'
const TOOL = '#94e2d5'
const CONTEXT = '#74c7ec'
const TIME = '#cba6f7'
const COST = '#eba0ac'
const SUB = '#a6adc8'
const OK = '#a6e3a1'
const YELLOW = '#f9e2af'
const WARN = '#fab387'
const ALERT = '#f38ba8'
const MUTED = '#7f849c'
const SEPARATOR = '#89b4fa'
const RULE = '#45475a'

// Glyphs Claude Code draws itself, so the terminal's font has them.
const CALL_GLYPH: Record<CallStatus, string> = { running: '●', ok: '✓', error: '✗', denied: '✗' }
const CALL_COLOR: Record<CallStatus, string> = { running: YELLOW, ok: OK, error: ALERT, denied: WARN }
const AGENT_GLYPH: Record<string, string> = { done: '✓', failed: '✗' }
const AGENT_COLOR: Record<string, string> = { running: YELLOW, done: OK, failed: ALERT }
// The pane redraws once a second while something runs: one frame per redraw.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// The band's steps by the share used.
const usedLevel = (used: number) => (used >= 85 ? ALERT : used >= 70 ? WARN : used >= 50 ? YELLOW : OK)

// USD per million tokens: input, output, cache read, cache write. The first row that
// matches a model id wins, so a release sits above its family. The engine reports
// tokens, not money, so cost is an estimate; cache writes are priced at the 1-hour
// rate (2x input), which ENABLE_PROMPT_CACHING_1H makes Claude Code write.
type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]

const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

// Haiku 5.5 is priced by prompt length: a request whose prompt (input, cache reads and
// cache writes together) is over 100,000 tokens pays these prices instead.
const HAIKU_LONG_PROMPT = 100_000
const HAIKU_LONG: Price = [0.5, 2.5, 0.05, 1]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const promptOf = (u: Usage): number =>
  (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

const priceOf = (model: string, prompt: number): Price => {
  const id = model.toLowerCase()
  if (prompt > HAIKU_LONG_PROMPT && /haiku-5-5/.test(id)) return HAIKU_LONG
  return PRICES.find(([re]) => re.test(id))?.[1] ?? [4, 20, 0.2, 8]
}

// `isRequest` says the usage is one model request, which is what a prompt-length price
// is set by; a turn's sum is priced at the model's ordinary prices.
const costOf = (model: string, u: Usage, isRequest: boolean): number => {
  const [i, o, r, w] = priceOf(model, isRequest ? promptOf(u) : 0)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

// Haiku 4.5 and the Claude 3 models have a 200K window; the rest, Haiku 5.5 included, 1M.
const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const runModel = (a: AgentRun): string => (a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model))

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

// Every duration in the pane: seconds under a minute (2s, 48s), a clock from there
// (01:39, 1:02:40).
const pad = (n: number) => String(n).padStart(2, '0')
const fmtDuration = (ms: number): string => {
  const whole = Math.round(Math.max(0, ms) / 1000)
  if (whole < 60) return `${whole}s`
  const hours = Math.floor(whole / 3600)
  const clock = `${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}`
  return hours ? `${hours}:${clock}` : clock
}

// A duration in the right-hand column, padded to one width (`  12s` as wide as `01:39`)
// so the dots and figures line up down the pane. Non-breaking spaces: a remote surface
// collapses runs of ordinary ones.
const TIME_CELLS = 5
const timeCell = (ms: number): string => fmtDuration(ms).padStart(TIME_CELLS, '\u00a0')

const estimate = (chars: number): number => (chars <= 0 ? 0 : Math.max(1, Math.round(chars / CHARS_PER_TOKEN)))

const ctxOf = (a: AgentRun): number =>
  a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0

// The band's bar, ten cells.
const BAR_CELLS = 10
const textBar = (percent: number) => {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS)))
  return { filled: '▰'.repeat(filled), empty: '▱'.repeat(BAR_CELLS - filled) }
}

/** Cuts `text` to `width` cells with an ellipsis. */
const fit = (text: string, width: number): string => {
  const chars = Array.from(text)
  const w = Math.max(1, Math.floor(width))
  return chars.length <= w ? text : chars.slice(0, w - 1).join('') + '…'
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

// A Text refuses control characters: drop a CLI's escape sequences (colours, a terminal
// link's OSC) and the rest. A lone \r redraws its line, as a progress bar does: the
// line shows what a terminal leaves of it, its last part.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
const printable = (text: string): string =>
  text
    .replace(ANSI, '')
    .replace(/\t/g, ' ')
    .split(/\r?\n/)
    .map(line => (line.split('\r').filter(Boolean).at(-1) ?? '').replace(CONTROL, ''))
    .join('\n')

// What a call was given and what it answered, as the session's state keeps it: a few
// first lines, for when its file is gone. The whole texts live in the call's file.
const EXCERPT_LINES = 4
const EXCERPT_CHARS = 400
// What a call's screen reads from its file, input and output together: under the 100,000
// characters a pane draws in all, so the line naming the file, last, still shows.
const SCREEN_CHARS = 80_000
const excerpt = (text: string): string | undefined => {
  const lines = printable(text)
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .slice(0, EXCERPT_LINES)
  const kept = lines.join('\n')
  return kept ? fit(kept, EXCERPT_CHARS) : undefined
}

const safeJson = (v: unknown, indent?: number): string => {
  try {
    return typeof v === 'string' ? v : (JSON.stringify(v, null, indent) ?? '')
  } catch {
    return ''
  }
}

// `mcp__server__tool` reads as `tool`: the column is narrow.
const toolName = (tool: string): string => (tool.startsWith('mcp__') ? (tool.split('__').at(-1) ?? tool) : tool)

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

/** What a call works on, from its arguments: a file, a command, a pattern, a task. */
const targetOf = (tool: string, input: Record<string, unknown>): string => {
  const str = (key: string) => {
    const v = input[key]
    return typeof v === 'string' ? v : ''
  }
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return baseName(str('file_path'))
    case 'NotebookEdit':
      return baseName(str('notebook_path'))
    case 'Bash':
    case 'PowerShell':
      return oneLine(str('command'))
    case 'Grep':
    case 'Glob':
      return str('pattern')
    case 'Agent':
      return [str('subagent_type'), str('description')].filter(Boolean).join(': ')
    case 'WebFetch':
      return str('url')
    case 'WebSearch':
      return str('query')
    case 'Skill':
      return str('skill')
    default: {
      const first = Object.entries(input).find(([k, v]) => !RESERVED.has(k) && typeof v === 'string')
      return first ? oneLine(String(first[1])) : ''
    }
  }
}

/**
 * A call's input exactly as the tool takes it, so the same input to the same tool gives
 * the same output again: any tool's arguments as JSON, a shell's command as written, to
 * copy and run, with the arguments that change what it does (a timeout, a background
 * run) as JSON under it. Left out: the engine's own fields, and a shell's description,
 * which only names the call.
 */
const SHELLS = new Set(['Bash', 'PowerShell'])
const fullInputOf = (tool: string, input: Record<string, unknown>): string => {
  const args = Object.fromEntries(Object.entries(input).filter(([k, v]) => !RESERVED.has(k) && v !== undefined))
  const command = args.command
  if (!SHELLS.has(tool) || typeof command !== 'string') return safeJson(args, 2)
  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'command' && k !== 'description'))
  return Object.keys(rest).length ? `${command}\n\n${safeJson(rest, 2)}` : command
}

// A result record as JSON, for a tool that answers with no text. A long string that is
// data rather than text (an image's base64) stands as its size: it cannot be read anyway.
const DATA_CHARS = 2000
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const recordOf = (result: unknown): string | undefined => {
  if (result === undefined || result === null) return undefined
  try {
    const json = JSON.stringify(
      result,
      (_, v) => (typeof v === 'string' && v.length > DATA_CHARS && BASE64.test(v) ? `<${v.length} characters of base64 data>` : v),
      2,
    )
    return json && json !== '{}' ? json : undefined
  } catch {
    return undefined
  }
}

// Each call's whole input and output, one file per call in the session's own folder:
// the state keeps only their first lines, so the session stays small.
// A temporary folder only this user reads, on each OS: TEMP or TMP on Windows, TMPDIR on
// macOS (ending in a slash). On Linux /tmp is every user's, and TMPDIR often names it:
// XDG_RUNTIME_DIR, the user's own (cleared at logout), goes before it, ~/.cache after.
// Each name is read as written: the engine lists the variables a module reads. The helpers
// that take $ are function declarations, which the engine follows $ into from another file.
async function tempDir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME'))?.trim()
  const dir = [
    await $.env.get('TEMP'),
    await $.env.get('TMP'),
    await $.env.get('XDG_RUNTIME_DIR'),
    await $.env.get('TMPDIR'),
    home ? `${home}/.cache` : undefined,
  ]
    .map(v => v?.trim())
    .find(Boolean)
  return dir ? dir.replace(/\\/g, '/').replace(/\/+$/, '') || '/' : '/tmp'
}

// Every session's folder sits in one of the mod's own, so a start lists only those and
// never the whole temporary folder.
const BODY_ROOT = 'session-band'
async function bodyRoot($: EngineInterface): Promise<string> {
  return `${await tempDir($)}/${BODY_ROOT}`
}

async function sessionDir($: EngineInterface, sessionId?: string): Promise<string> {
  return `${await bodyRoot($)}/${sessionId ?? (await $.session.id())}`
}

async function bodyPath($: EngineInterface, id: string): Promise<string> {
  return `${await sessionDir($)}/${id.replace(/[^\w-]/g, '_')}.json`
}

// The files are kept only while the pane can show them. A session marks its folder alive
// every minute and with each call's file, so a session that starts leaves another one's
// that still runs alone; an ended session marks its own 0.
const ALIVE_FILE = 'alive'
const ALIVE_EVERY_MS = 60_000
const STALE_MS = 10 * 60_000

async function markAlive($: EngineInterface, sessionId?: string, at?: number): Promise<void> {
  try {
    await $.fs.write(`${await sessionDir($, sessionId)}/${ALIVE_FILE}`, String(at ?? (await $.clock.now())))
  } catch {
    // The next minute marks it again.
  }
}

// `$.fs` deletes nothing: the system's own command removes the folder, rmdir on Windows
// and rm on macOS and Linux. Only a session's folder in the mod's own is removed.
async function removeDir($: EngineInterface, dir: string): Promise<void> {
  if (!new RegExp(`/${BODY_ROOT}/[\\w-]+$`).test(dir)) return
  try {
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    await $.process.run(
      isWindows ? ['cmd', '/c', 'rmdir', '/s', '/q', dir.replace(/\//g, '\\')] : ['rm', '-rf', '--', dir],
      { timeoutMs: 5000 },
    )
  } catch {
    // Left for the next session's start.
  }
}

/**
 * At a session's start: the folders of sessions that ended (or were killed before their
 * end ran), and this session's own when the pane shows none of its calls (a resume in a
 * new process). A hot reload keeps the calls in view, so it keeps their folder.
 */
async function pruneBodies($: EngineInterface): Promise<void> {
  let root: string
  let own: string
  let entries: Awaited<ReturnType<typeof $.fs.list>>
  try {
    root = await bodyRoot($)
    own = await $.session.id()
    entries = await $.fs.list(root)
  } catch {
    // No folder yet, or none to read: nothing to prune now, the next start tries again.
    return
  }
  const hasCalls = (await read($, calls)).length > 0
  const at = await $.clock.now()
  for (const entry of entries) {
    // A link is no folder of the mod's: `kind` is `other` for one.
    if (entry.kind !== 'dir') continue
    const dir = `${root}/${entry.name}`
    if (entry.name === own) {
      if (!hasCalls) await removeDir($, dir)
      continue
    }
    // 0, or no mark: its session ended, or its folder is not one a session marks. A folder
    // never stands unmarked while its session runs: the mark is written before any file.
    let aliveAt = 0
    try {
      aliveAt = Number(await $.fs.read(`${dir}/${ALIVE_FILE}`)) || 0
    } catch {
      // No mark.
    }
    if (aliveAt === 0 || at - aliveAt > STALE_MS) await removeDir($, dir)
  }
}

// Past what a pane draws, a text ends on how much is left and where the whole of it is,
// cut between characters, never between the two halves of an emoji.
const cutAt = (text: string | undefined, room: number, path: string): string | undefined => {
  if (text === undefined || text.length <= room) return text
  const end = /[\uD800-\uDBFF]/.test(text.charAt(room - 1)) ? room - 1 : room
  return `${text.slice(0, end)}\n… ${text.length - end} more characters, whole in ${path}`
}

async function readBody($: EngineInterface, id: string): Promise<CallBody> {
  try {
    const path = await bodyPath($, id)
    const kept = JSON.parse(await $.fs.read(path)) as { input?: string; output?: string }
    // The input first (it is short but for a Write's content), the output in the rest.
    const input = cutAt(kept.input, SCREEN_CHARS / 5, path)
    const output = cutAt(kept.output, SCREEN_CHARS - (input?.length ?? 0), path)
    return { id, input, output, isWhole: true }
  } catch {
    // No file: a call made before this version, a write that failed, or one over 4 MiB.
    return { id, isWhole: false }
  }
}

/**
 * A request's response is whole: the API's usage, and its output split across text,
 * tool use and thinking. Text and tool use are sized by their characters; thinking,
 * which the stream shows a summary of at most, takes the rest of the real total.
 */
const endStep = (s: Step, r: TurnStepResult, endedAt: number, prev: Step | undefined): Step => {
  const tools = r.toolUses.map(t => t.name)
  if (!r.usage) return { ...s, status: 'failed', stopReason: r.stopReason, endedAt, tools }
  const output = r.usage.output_tokens
  let text = estimate(r.answer.length)
  let toolUse = estimate(r.toolUses.reduce((sum, t) => sum + t.name.length + safeJson(t.input).length, 0))
  if (text + toolUse > output) {
    text = Math.round((output * text) / (text + toolUse))
    toolUse = output - text
  }
  const input = promptOf(r.usage)
  return {
    ...s,
    status: 'done',
    stopReason: r.stopReason,
    endedAt,
    model: r.usage.model || s.model,
    input,
    cacheRead: r.usage.cache_read_input_tokens,
    cacheWrite: r.usage.cache_creation_input_tokens,
    output,
    text,
    toolUse,
    thinking: output - text - toolUse,
    tools,
    isCompacted: prev?.input !== undefined && input < prev.input,
  }
}

/** What a request answered with, for its row. */
const gist = (s: Step): string => {
  if (s.status === 'streaming') return 'streaming…'
  if (s.status === 'failed') return 'no response'
  if (s.tools.length) {
    const names = [...new Set(s.tools.map(toolName))]
    return `${s.tools.length}× ${names.slice(0, 2).join(', ')}${names.length > 2 ? '…' : ''}`
  }
  if (s.stopReason === 'max_tokens' || s.stopReason === 'model_context_window_exceeded') return 'cut off'
  return s.text ? 'answer' : 'thinking only'
}

// Closes the pane when it is on screen; otherwise opens it, or shows it when it is open but
// waiting undrawn or behind another pane's tab. Says what came of it, and whether the pane
// is on screen now (false once closed, or when it could not be placed).
export async function togglePane(
  $: EngineInterface,
  where: CommandPresentation,
): Promise<{ text: string; isShown: boolean }> {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane?.isPlaced && pane.isShown) {
    await $.ui.close({ id: PANE })
    await update($, isPaneOpen, () => false)
    return { text: 'Activity pane closed.', isShown: false }
  }
  await tick($)
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS, rows: INLINE_ROWS })
  await update($, isPaneOpen, () => opened.isPlaced)
  if (!opened.isPlaced) return { text: `The pane is not shown yet: ${opened.reason}`, isShown: false }
  // The fullscreen layout docks it beside the transcript from 110 columns; anywhere else it
  // sits above the prompt, in the room session-band's rows share.
  const isDocked = where.isFullscreen && where.columns >= DOCK_MIN_COLUMNS
  const text = isDocked
    ? 'Activity pane opened beside the transcript.'
    : `Activity pane opened above the prompt (${where.isFullscreen ? 'fullscreen' : 'classic layout'}, ${where.columns} columns; docking beside needs fullscreen from ${DOCK_MIN_COLUMNS} columns).`
  return { text, isShown: true }
}

async function tick($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
}

const stepKey = (n: number): string => `s:${n}`
const allKey = (list: string): string => `all:${list}`

// A request writes what is new to the prompt cache, a few thousand tokens; one that writes
// most of its input found the cache expired and paid to write the whole context again.
const REWRITE_MIN = 20_000
const isCacheRewrite = (s: Step): boolean =>
  s.cacheWrite !== undefined &&
  s.input !== undefined &&
  s.cacheWrite >= REWRITE_MIN &&
  s.cacheWrite >= s.input / 2

// The band's own hooks call these on the events both parts follow: a plugin hooks an event
// once without a matcher.

/** `session.start`, after the engine's: the command and the clock of the running rows. */
export async function startActivity($: EngineInterface): Promise<void> {
  await update($, isPaneOpen, () => false)
  await pruneBodies($)
  await markAlive($)
  $.clock.every(ALIVE_EVERY_MS, () => markAlive($))
  await $.command.register({
    name: 'activity',
    description: 'Show or hide the activity pane: requests, tool calls and subagents per prompt (clear)',
    argumentHint: '[clear]',
    // Runs mid-turn too, so the shortcut toggles the pane while Claude works.
    immediate: true,
  })

  // Ticks the running clocks; quiet when nothing runs.
  $.clock.every(1000, async () => {
    const [c, a, p] = [await read($, calls), await read($, agents), await read($, prompts)]
    const isRunning =
      c.some(x => x.status === 'running') ||
      a.some(x => x.status === 'running') ||
      (p.length > 0 && p.at(-1)?.endedAt === undefined)
    if (isRunning) await tick($)
  })
}

/** `turn.start`: a main-loop prompt opens a row. */
export async function activityTurnStart($: EngineInterface, e: TurnStartInput): Promise<void> {
  if (e.agentId !== undefined) return
  const at = await $.clock.now()
  const prompt: Prompt = { turnId: e.turnId, text: e.text, startedAt: at, isAborted: false, costUsd: 0 }
  await update($, prompts, list => [...list.filter(p => p.turnId !== e.turnId), prompt].slice(-MAX_PROMPTS))
  // A new prompt is followed again, whatever was opened by hand before it.
  await update($, view, v => ({ ...v, isFollowing: true, expanded: [e.turnId] }))
  await update($, now, () => at)
}

/** `turn.step` as it is sent: a main-loop request opens a row; its `n`, or undefined. */
export async function activityStepStart($: EngineInterface, e: TurnStepInput): Promise<number | undefined> {
  if (e.agentId !== undefined) return undefined
  const startedAt = await $.clock.now()
  const n = ((await read($, steps)).at(-1)?.n ?? 0) + 1
  const step: Step = {
    n,
    turnId: e.turnId,
    model: e.model,
    status: 'streaming',
    startedAt,
    text: 0,
    toolUse: 0,
    thinking: 0,
    tools: [],
    isCompacted: false,
  }
  await update($, steps, list => [...list, step].slice(-MAX_STEPS))
  await update($, view, v => (v.isFollowing ? { ...v, expanded: [e.turnId, stepKey(n)] } : v))
  await update($, now, () => startedAt)
  return n
}

/**
 * `turn.step` once its response is whole (`result` null when it threw): a main-loop
 * request's row gets its usage and when its first item came (`firstChunkAt`, null when
 * none did); a subagent's live context and output move.
 */
export async function activityStepEnd(
  $: EngineInterface,
  e: TurnStepInput,
  n: number | undefined,
  result: TurnStepResult | null,
  firstChunkAt: number | null,
): Promise<void> {
  const endedAt = await $.clock.now()
  if (n !== undefined) {
    await update($, steps, list => {
      const prev = list.findLast(s => s.n < n)
      return list.map((s): Step => {
        if (s.n !== n) return s
        const ended: Step = result ? endStep(s, result, endedAt, prev) : { ...s, status: 'failed', endedAt }
        return firstChunkAt === null ? ended : { ...ended, firstChunkAt }
      })
    })
    return
  }
  const agentId = e.agentId
  const usage = result?.usage
  if (!agentId || !usage) return

  const model = usage.model || e.model
  await update($, agents, list =>
    list.map(
      (a): AgentRun =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens: promptOf(usage) + (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens: a.tokens + promptOf(usage) + (usage.output_tokens || 0),
              output: a.output + (usage.output_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage, true),
              steps: a.steps + 1,
            },
    ),
  )
}

/** `turn.complete`: a prompt's row or a subagent's run ends. */
export async function activityTurnComplete($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  const at = await $.clock.now()
  const agentId = e.agentId
  if (agentId) {
    await update($, agents, list =>
      list.map((a): AgentRun => {
        if (a.agentId !== agentId) return a
        // A run whose steps went unseen still gets the turn's own sum.
        const fallback = a.steps === 0 ? e.usage : undefined
        return {
          ...a,
          status: e.reason === 'answer' ? 'done' : 'failed',
          endedAt: at,
          ...(fallback
            ? {
                model: fallback.model || a.model,
                tokens: promptOf(fallback) + fallback.output_tokens,
                output: fallback.output_tokens,
                costUsd: costOf(fallback.model || a.model, fallback, false),
              }
            : {}),
        }
      }),
    )
  } else {
    const usage = e.usage
    await update($, prompts, list =>
      list.map(p =>
        p.turnId !== e.turnId
          ? p
          : {
              ...p,
              endedAt: at,
              isAborted: e.isAborted,
              costUsd: usage ? costOf(usage.model, usage, false) : p.costUsd,
            },
      ),
    )
  }
  await update($, now, () => at)
}

/** The hooks of events only the activity pane follows. */
export const registerActivity: Register = on => {
  on('command.run', { command: 'activity' }, async ($, e) => {
    if ((e.args ?? '').trim() === 'clear') {
      const last = (await read($, prompts)).at(-1)
      const keep = last?.endedAt === undefined ? last?.turnId : undefined
      await update($, prompts, list => list.filter(p => p.turnId === keep))
      await update($, steps, list => list.filter(s => s.turnId === keep))
      await update($, calls, list => list.filter(c => c.status === 'running' || (keep && c.turnId === keep)))
      await update($, agents, list => list.filter(a => a.status === 'running'))
      $.ui.toast('Cleared what is done from the pane.')
      return {}
    }
    // A toast, not a transcript line: the model would read the line as context.
    $.ui.toast((await togglePane($, e.presentation)).text)
    return {}
  })

  // Exit, /clear, a resume: what the session showed is gone from view, so are its files.
  // A /clear or a /resume goes on in this process under another id: the pane starts over.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    try {
      // Marked ended first: a removal the end's short time cuts off is the next start's.
      await markAlive($, e.sessionId, 0)
      await removeDir($, await sessionDir($, e.sessionId))
    } catch {
      // Its folder waits for the next session's start.
    }
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, prompts, () => [])
      await update($, steps, () => [])
      await update($, calls, () => [])
      await update($, agents, () => [])
      await update($, view, v => ({ ...v, expanded: [], isFollowing: true, detail: undefined }))
      await update($, body, () => null)
    }
    return ended
  })

  // Closed by the person (its close mark, ctrl+x x) or on unload: the button says so.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) await update($, isPaneOpen, () => false)
    return closed
  })

  // Every tool call: the main loop's under the request that asked for it, a subagent's
  // under its loop.
  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const id = e.tool_use_id
    const isMain = e.agentId === undefined
    const turnId = isMain ? (await read($, prompts)).at(-1)?.turnId : undefined
    const step = isMain ? (await read($, steps)).findLast(s => s.turnId === turnId)?.n : undefined
    const fullInput = fullInputOf(e.tool, e as unknown as Record<string, unknown>)
    const call: Call = {
      id,
      tool: e.tool,
      target: targetOf(e.tool, e as unknown as Record<string, unknown>),
      input: excerpt(fullInput),
      turnId,
      agentId: e.agentId,
      step,
      status: 'running',
      startedAt,
      resultChars: 0,
    }
    await update($, calls, list => [...list.filter(c => c.id !== id), call].slice(-MAX_CALLS))
    await update($, now, () => startedAt)

    // `isRecord`: the tool answered with no text (ToolSearch's tool references, Read's image),
    // so its result record stands in, as the tool returned it.
    const finish = async (status: CallStatus, text: string, isRecord = false) => {
      const endedAt = await $.clock.now()
      const error = status === 'ok' ? undefined : excerpt(text)
      const output = status === 'ok' ? excerpt(text) : undefined
      await update($, calls, list =>
        list.map(c => (c.id === id ? { ...c, status, endedAt, resultChars: text.length, error, output, isRecord } : c)),
      )
      // A failed write leaves the screen on the first lines the state keeps. The folder is
      // marked alive first: after a /clear, the new id's has no mark until the minute's.
      try {
        await markAlive($)
        await $.fs.write(await bodyPath($, id), JSON.stringify({ input: fullInput, output: text }))
      } catch {
        return
      }
      // Its screen was opened while it ran: it now has the answer.
      if ((await read($, view)).detail === id) {
        const whole = await readBody($, id)
        await update($, body, () => whole)
      }
    }
    try {
      const ran = await next(e)
      const status: CallStatus = ran.deny !== undefined ? 'denied' : ran.isError ? 'error' : 'ok'
      const text = ran.deny ?? ran.text ?? ''
      const record = text ? undefined : recordOf(ran.result)
      await finish(status, record ?? text, record !== undefined)
      return ran
    } catch (err) {
      await finish('error', String(err))
      throw err
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    const run: AgentRun = {
      id: started.agentId ?? e.tool_use_id,
      toolUseId: e.tool_use_id,
      agentId: started.agentId,
      type: e.subagentType,
      description: e.description,
      model: started.model,
      status: 'running',
      startedAt: at,
      contextTokens: 0,
      contextMax: windowOf(started.model),
      tokens: 0,
      output: 0,
      costUsd: 0,
      steps: 0,
    }
    await update($, agents, list => [...list.filter(a => a.id !== run.id), run].slice(-MAX_AGENTS))
    await update($, now, () => at)
    return started
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const allCalls = await read($, calls)
    const promptList = await read($, prompts)
    const stepList = await read($, steps)
    const agentList = await read($, agents)
    const v = await read($, view)
    const at = Math.max(
      await read($, now),
      ...allCalls.map(c => c.startedAt),
      ...agentList.map(a => a.startedAt),
      0,
    )
    // The root pads a cell either side.
    const cols = Math.max(30, (e.props.bodyColumns || COLUMNS) - 2)
    const frame = SPINNER[Math.floor(at / 1000) % SPINNER.length] ?? '●'

    // "Label: value" as the band writes it: the label in its hue, the value bold.
    const item = (key: string, label: string, hue: string, value: string, valueColor = hue) => (
      <Text key={key}>
        <Text color={hue}>{`${label}: `}</Text>
        <Text bold color={valueColor}>
          {value}
        </Text>
      </Text>
    )
    // One line of items split by a muted dot, cut at the pane's edge.
    const items = (key: string, parts: (RenderChildren | false)[]) => (
      <Text key={key} wrap="truncate-end">
        {parts
          .filter(p => p !== false)
          .flatMap((p, i) => (i ? [<Text key={`d${i}`} color={MUTED}>{' · '}</Text>, p] : [p]))}
      </Text>
    )
    const failedOf = (list: Call[]) => list.filter(c => c.status === 'error' || c.status === 'denied').length

    const toggle = (key: string) =>
      update($, view, prev => ({
        ...prev,
        isFollowing: false,
        expanded: prev.expanded.includes(key) ? prev.expanded.filter(k => k !== key) : [...prev.expanded, key],
      }))

    // A row's right half: "│ " then its figures right-aligned in a column of fixed width,
    // so the separators line up down the pane and the figures read as one column.
    const metrics = (parts: (RenderChildren | null | false)[]) => (
      <Box flexShrink={0} width={METRICS_COLUMNS + 2} flexDirection="row">
        <Text color={SEPARATOR}>│ </Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text wrap="truncate-start">{parts.filter(p => p !== null && p !== false)}</Text>
        </Box>
      </Box>
    )
    // Columns a row's left half has once `indent` cells in.
    const leftColumns = (indent: number) => Math.max(8, cols - indent - METRICS_COLUMNS - 3)

    // The subagent an Agent call spawned, matched by the call's id.
    const runOf = (c: Call): AgentRun | undefined =>
      c.tool === 'Agent' ? agentList.find(a => a.toolUseId === c.id) : undefined
    const callsOf = (a: AgentRun): Call[] => (a.agentId ? allCalls.filter(c => c.agentId === a.agentId) : [])
    // A subagent's cost with every subagent it spawned in turn.
    const runCost = (a: AgentRun): number =>
      callsOf(a).reduce((sum, c) => {
        const child = runOf(c)
        return child ? sum + runCost(child) : sum
      }, a.costUsd)

    // Ctx: ▰▱▱▱▱▱▱▱▱▱ 12% · 120k tok · ≈$0.05
    const ctxLine = (a: AgentRun) => {
      const ctx = ctxOf(a)
      const bar = textBar(ctx)
      return (
        <Text wrap="truncate-end">
          <Text color={CONTEXT}>Ctx: </Text>
          <Text color={usedLevel(ctx)}>{bar.filled}</Text>
          <Text color={MUTED}>{bar.empty}</Text>
          <Text bold color={usedLevel(ctx)}>{` ${ctx}%`}</Text>
          <Text color={MUTED}>{` · ${fmtTokens(a.tokens)} tok · ≈${fmtCost(runCost(a))}`}</Text>
        </Text>
      )
    }

    // ✓ Edit ContactList.tsx              0s
    // An Agent call opens on its subagent: its context and cost, then its own calls.
    // ▾ ✓ Agent Explore: find callers         01:10
    //     Ctx: ▰▱▱▱▱▱▱▱▱▱ 12% · 120k tok · ≈$0.05
    //     ✓ Grep scrollToTop               0s
    // A call opens its own screen at its top, the keys' focus on Back; Back lands on the
    // call's row again, wherever the list had scrolled to. The window moves after the
    // redraw it waits for; one the site refuses (it holds no keys) leaves things as they are.
    const reveal = async (key: string) => {
      try {
        await $.ui.scroll(key === BACK ? { to: 'start', in: PANE } : { to: { key }, in: PANE, block: 'center' })
        await $.ui.focus({ requestId: PANE, key })
      } catch {
        // The press already did what it was for.
      }
    }
    const openDetail = async (id: string) => {
      await update($, view, prev => ({ ...prev, isFollowing: false, detail: id }))
      await reveal(BACK)
      const whole = await readBody($, id)
      await update($, body, () => whole)
    }
    const closeDetail = async (id: string) => {
      await update($, view, prev => ({ ...prev, detail: undefined }))
      await update($, body, () => null)
      await reveal(`a:${id}`)
    }
    const shownBody = await read($, body)

    // In:
    //   yarn type-check
    // One Text a block, wrapped whole, never cut at the edge: a Box a line would spend the
    // pane's room on keys. Cleaned again as drawn: an error stored before excerpt cleaned it.
    const excerptBlock = (key: string, label: string, text: string, color?: string) => (
      <Box key={key} flexDirection="column" marginTop={1}>
        <Text color={MUTED}>{`${label}:`}</Text>
        <Box marginLeft={2}>
          <Text color={color} wrap="wrap">
            {printable(text)}
          </Text>
        </Box>
      </Box>
    )

    // ‹ Back
    // ✗ PowerShell
    // Status: error · Time: 2s · Result: 1.2k chars
    // In: … Out: …
    const detailScreen = (c: Call) => {
      // The whole texts from the call's file; until it is read, or without one, the first lines.
      const isRead = shownBody?.id === c.id
      const whole = isRead && shownBody.isWhole ? shownBody : undefined
      // A call made before input was kept still shows what its row named.
      const input = whole ? whole.input : (c.input ?? (c.target || undefined))
      const answer = whole ? whole.output : (c.error ?? c.output)
      const isRunning = c.status === 'running'
      const isCut = isRead && !whole && !isRunning && (input ?? answer) !== undefined
      const ms = (c.endedAt ?? at) - c.startedAt
      return (
        <Box flexDirection="column">
          <Button key={BACK} label="‹ Back" plain onPress={() => closeDetail(c.id)} />
          <Box marginTop={1}>
            <Text>
              <Text color={CALL_COLOR[c.status]}>{c.status === 'running' ? frame : CALL_GLYPH[c.status]}</Text>
              <Text bold color={TOOL}>{` ${c.tool}`}</Text>
            </Text>
          </Box>
          {items('facts', [
            item('status', 'Status', MUTED, c.status, CALL_COLOR[c.status]),
            item('time', 'Time', TIME, fmtDuration(ms)),
            c.endedAt !== undefined && item('result', 'Result', REQUEST, `${fmtTokens(c.resultChars)} chars`),
          ])}
          {isCut && (
            <Box marginTop={1}>
              <Text color={WARN} wrap="wrap">
                Only the first lines are shown: the call's file could not be read (made before this
                version of the mod, or over 4 MiB).
              </Text>
            </Box>
          )}
          {input && excerptBlock('in', 'In', input, SUB)}
          {answer &&
            excerptBlock(
              'out',
              c.isRecord ? 'Out (no text: the result record the tool returned)' : 'Out',
              answer,
              c.error !== undefined ? ALERT : undefined,
            )}
          {/* No answer to show: still to come, none given, or none kept. Nothing while it is read. */}
          {!answer && (isRunning || isRead) && (
            <Box marginTop={1}>
              <Text color={MUTED} wrap="wrap">
                {isRunning
                  ? 'Out: still running; its answer shows here once it ends.'
                  : whole
                    ? 'Out: none; the tool answered with no text.'
                    : 'Out: not kept; the call ran before this version of the mod loaded.'}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    const callRow = (c: Call) => {
      const isRunning = c.status === 'running'
      const run = runOf(c)
      // An Agent call opens on its subagent in place; any other call opens its own screen.
      const key = `a:${c.id}`
      const isOpen = run !== undefined && v.expanded.includes(key)
      const ms = (c.endedAt ?? at) - c.startedAt
      // Texts alone: a Fragment draws as a Box, which a Text may not hold.
      const head = [
        <Text key="mark" color={MUTED}>
          {!run ? '› ' : isOpen ? '▾ ' : '▸ '}
        </Text>,
        <Text key="glyph" color={CALL_COLOR[c.status]}>
          {isRunning ? frame : CALL_GLYPH[c.status]}
        </Text>,
        <Text key="tool" bold color={TOOL}>{` ${toolName(c.tool)}`}</Text>,
        c.target ? (
          <Text key="target" color={SUB}>{` ${c.target}`}</Text>
        ) : null,
      ]
      return (
        <Box key={c.id} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Button key={key} plain onPress={() => (run ? toggle(key) : openDetail(c.id))}>
              {head}
            </Button>
            {metrics([
              <Text key="took" color={isRunning ? YELLOW : ms >= SLOW_MS ? WARN : MUTED}>
                {timeCell(ms)}
              </Text>,
            ])}
          </Box>
          {run && isOpen && (
            <Box flexDirection="column" marginLeft={2}>
              {ctxLine(run)}
              {callsOf(run).length > 0 ? (
                callList(`ac:${c.id}`, callsOf(run))
              ) : (
                <Text color={MUTED}>no tool calls yet</Text>
              )}
            </Box>
          )}
        </Box>
      )
    }

    // A folded line that opens its list whole: `all:<list>` in the expanded keys.
    const unfold = (list: string, label: string) => (
      <Button key={allKey(list)} label={label} plain dimColor onPress={() => toggle(allKey(list))} />
    )

    // The latest calls, the earlier ones folded into a line that shows them.
    const callList = (key: string, list: Call[]) => {
      const shown = v.expanded.includes(allKey(key)) ? list : list.slice(-MAX_ROWS)
      const hidden = list.length - shown.length
      return (
        <Box key={key} flexDirection="column">
          {hidden > 0 && unfold(key, `… ${hidden} earlier tool calls`)}
          {shown.map(callRow)}
        </Box>
      )
    }

    const detailed = v.detail !== undefined ? allCalls.find(c => c.id === v.detail) : undefined
    if (detailed) return detailScreen(detailed)

    // A subagent's transcript in view: its own calls.
    const viewed = e.props.view.agentId
    if (viewed !== undefined) {
      const run = agentList.find(a => a.agentId === viewed)
      const own = allCalls.filter(c => c.agentId === viewed)
      const failed = failedOf(own)
      return (
        <Box flexDirection="column">
          <Text bold color={REQUEST} wrap="truncate-end">
            {run ? `${run.type} · ${run.description}` : 'Subagent'}
          </Text>
          {items('sum', [
            run ? item('model', 'Model', SUB, runModel(run)) : false,
            item('tools', 'Tool', TOOL, String(own.length)),
            failed > 0 && item('failed', 'Failed', ALERT, String(failed)),
            run ? item('time', 'Time', TIME, fmtDuration((run.endedAt ?? at) - run.startedAt)) : false,
          ])}
          <Box marginTop={1} flexDirection="column">
            {own.length ? callList('own', own) : <Text color={MUTED}>No tool calls yet.</Text>}
          </Box>
        </Box>
      )
    }

    // A collapsed row keeps its name and time; the rest waits for it to open. ⚠ says
    // something there is worth a look: a failed call, a cache written again.
    // ▸ #67 Bash                               18s
    // ▾ #13 2× Edit, Bash                    ⚠ 16s
    //     ✓ Edit ContactList.tsx            0s
    //     In: 19k · Out: 474
    //     Wait: 1s · Write: 5s
    //     ⚠ cache written again 19k
    const stepBlock = (s: Step, own: Call[]) => {
      const key = stepKey(s.n)
      const isOpen = v.expanded.includes(key)
      const isRunning = s.status === 'streaming'
      const after = s.input !== undefined ? s.input + (s.output ?? 0) : undefined
      const percent = after !== undefined ? (after / windowOf(s.model)) * 100 : 0
      // From the request sent to its last tool's answer: the model's reply, then the tools.
      const isBusy = isRunning || own.some(c => c.status === 'running')
      const endedAt = Math.max(s.endedAt ?? at, ...own.map(c => c.endedAt ?? at))
      const took = timeCell((isBusy ? at : endedAt) - s.startedAt)
      const needsLook = s.status === 'failed' || isCacheRewrite(s) || failedOf(own) > 0
      // The context the request left, beside its time.
      const context = after !== undefined ? fmtTokens(after) : ''
      const label = fit(`${isOpen ? '▾' : '▸'} #${s.n} ${gist(s)}`, leftColumns(2))
      // Before the first item the wait (network, queue, reading the input), after it the writing.
      const timing =
        s.endedAt === undefined
          ? []
          : s.firstChunkAt === undefined
            ? [item('model', 'Model', TIME, fmtDuration(s.endedAt - s.startedAt))]
            : [
                item('wait', 'Wait', TIME, fmtDuration(s.firstChunkAt - s.startedAt)),
                item('write', 'Write', TIME, fmtDuration(s.endedAt - s.firstChunkAt)),
              ]
      return (
        <Box key={key} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Button key={key} label={label} plain dimColor={!isOpen && !isRunning} onPress={() => toggle(key)} />
            {metrics([
              needsLook && <Text key="look" color={WARN}>⚠ </Text>,
              context && <Text key="context" color={usedLevel(percent)}>{context}</Text>,
              context && <Text key="dot" color={MUTED}>{' · '}</Text>,
              <Text key="took" color={isBusy ? YELLOW : TIME}>
                {took}
              </Text>,
            ])}
          </Box>
          {isOpen && (
            <Box flexDirection="column" marginLeft={2} marginBottom={1}>
              {own.length > 0 && callList(`c${s.n}`, own)}
              {items('io', [
                item('in', 'In', CONTEXT, s.input !== undefined ? fmtTokens(s.input) : '…'),
                item('out', 'Out', REQUEST, s.output !== undefined ? fmtTokens(s.output) : '…'),
              ])}
              {timing.length > 0 && items('time', timing)}
              {isCacheRewrite(s) && <Text color={WARN}>{`⚠ cache written again ${fmtTokens(s.cacheWrite ?? 0)}`}</Text>}
              {s.isCompacted && <Text color={WARN}>compacted before this request</Text>}
            </Box>
          )}
        </Box>
      )
    }

    // The main loop's requests and every subagent its Agent calls spawned. A prompt kept
    // by the version that dropped cost has none: it counts nothing rather than NaN.
    const promptCost = (p: Prompt): number =>
      allCalls
        .filter(c => c.turnId === p.turnId)
        .reduce(
          (sum, c) => {
            const run = runOf(c)
            return run ? sum + runCost(run) : sum
          },
          Number.isFinite(p.costUsd) ? p.costUsd : 0,
        )

    // The row tells prompts apart by what each cost; the context, which only grows from one
    // to the next, waits in the summary.
    // ▸ ❯ change the button icon    │   ≈$0.12 · 35s
    // ▾ ❯ fix the contact list scroll │ ⚠ ≈$0.31 · 01:20
    //   Req: 3 · Tool: 5 · Failed: 1 · Context: 19k
    const promptBlock = (p: Prompt) => {
      const own = allCalls.filter(c => c.turnId === p.turnId)
      const ownSteps = stepList.filter(s => s.turnId === p.turnId)
      // Calls no listed request claims: made before the mod loaded, mid-turn.
      const loose = own.filter(c => c.step === undefined || !ownSteps.some(s => s.n === c.step))
      const isOpen = v.expanded.includes(p.turnId)
      const isRunning = p.endedAt === undefined
      const time = timeCell((p.endedAt ?? at) - p.startedAt)
      const failed = failedOf(own)
      const cost = promptCost(p)
      const needsLook = failed > 0 || p.isAborted || ownSteps.some(s => s.status === 'failed' || isCacheRewrite(s))
      // The context the prompt left: its last answered request's input and output.
      const lastDone = ownSteps.findLast(s => s.input !== undefined)
      const after = lastDone?.input !== undefined ? lastDone.input + (lastDone.output ?? 0) : undefined
      const price = cost > 0 ? `≈${fmtCost(cost)}` : ''
      const text = p.text ? oneLine(p.text) : '(continuation)'
      const label = fit(`${isOpen ? '▾' : '▸'} ❯ ${text}`, leftColumns(0))
      return (
        <Box key={p.turnId} flexDirection="column" marginBottom={isOpen ? 1 : 0}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Button
              key={p.turnId}
              label={label}
              plain
              dimColor={!isOpen && !isRunning}
              onPress={() => toggle(p.turnId)}
            />
            {metrics([
              needsLook && <Text key="look" color={WARN}>⚠ </Text>,
              price && <Text key="price" color={COST}>{price}</Text>,
              price && <Text key="dot" color={MUTED}>{' · '}</Text>,
              <Text key="time" color={isRunning ? YELLOW : TIME}>
                {time}
              </Text>,
            ])}
          </Box>
          {isOpen && (
            <Box flexDirection="column" marginLeft={2}>
              {items('sum', [
                item('req', 'Req', REQUEST, String(ownSteps.length)),
                item('tools', 'Tool', TOOL, String(own.length)),
                failed > 0 && item('failed', 'Failed', ALERT, String(failed)),
                after !== undefined &&
                  item(
                    'context',
                    'Context',
                    CONTEXT,
                    fmtTokens(after),
                    usedLevel((after / windowOf(lastDone?.model ?? '')) * 100),
                  ),
                p.isAborted && <Text key="aborted" color={ALERT}>stopped</Text>,
              ])}
              {ownSteps.map(s =>
                stepBlock(
                  s,
                  own.filter(c => c.step === s.n),
                ),
              )}
              {loose.length > 0 && callList(`l:${p.turnId}`, loose)}
            </Box>
          )}
        </Box>
      )
    }

    // ⠋ Explore · Haiku 5.5                42s
    //   find callers of scrollToTop
    //   Ctx: ▰▱▱▱▱▱▱▱▱▱ 12% · 120k tok · ≈$0.05
    const agentCard = (a: AgentRun) => {
      return (
        <Box key={a.id} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Text wrap="truncate-end">
              <Text color={YELLOW}>{frame}</Text>
              <Text bold color={REQUEST}>{` ${a.type}`}</Text>
              <Text color={MUTED}>{` · ${runModel(a)}`}</Text>
            </Text>
            <Text color={YELLOW}>{fmtDuration((a.endedAt ?? at) - a.startedAt)}</Text>
          </Box>
          <Box flexDirection="column" marginLeft={2}>
            <Text color={SUB} wrap="truncate-end">
              {a.description || '—'}
            </Text>
            {ctxLine(a)}
          </Box>
        </Box>
      )
    }

    // ✓ Explore find callers                  01:10
    const agentLine = (a: AgentRun) => (
      <Box key={a.id} flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Text wrap="truncate-end">
          <Text color={AGENT_COLOR[a.status]}>{AGENT_GLYPH[a.status] ?? '•'}</Text>
          <Text color={REQUEST}>{` ${a.type}`}</Text>
          <Text color={SUB}>{` ${a.description || '—'}`}</Text>
        </Text>
        <Text color={MUTED}>{fmtDuration((a.endedAt ?? at) - a.startedAt)}</Text>
      </Box>
    )

    const running = agentList.filter(a => a.status === 'running').reverse()
    const finished = agentList.filter(a => a.status !== 'running').reverse()
    const agentCost = agentList.reduce((s, a) => s + a.costUsd, 0)

    const subagents = agentList.length > 0 && (
      <Box key="agents" flexDirection="column" marginBottom={1}>
        {items('agents', [
          item('sub', 'Subagent', TIME, running.length ? `${running.length} running` : `${finished.length} done`),
          item('cost', 'Cost', COST, `≈${fmtCost(agentCost)}`),
        ])}
        {running.map(agentCard)}
        {finished.length > 0 && running.length > 0 && (
          <Button
            key="done"
            label={`${v.isDoneCollapsed ? '▸' : '▾'} Done: ${finished.length}`}
            plain
            dimColor
            onPress={() => update($, view, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
          />
        )}
        {(running.length === 0 || !v.isDoneCollapsed) && finished.map(agentLine)}
      </Box>
    )

    // Newest first: the pane opens at its top.
    const newest = [...promptList].reverse()
    const shownPrompts = v.expanded.includes(allKey('prompts')) ? newest : newest.slice(0, MAX_PROMPTS_SHOWN)
    const hiddenPrompts = newest.length - shownPrompts.length
    // Over the prompts kept, in two lines:
    // Session: 71 req · 214 tool · 3✗
    // Time: 1:32:10 · Cost: ≈$4.20
    // Token: 8.3M · Out: 42k · Cache hit: 97%
    const mainCalls = allCalls.filter(c => c.agentId === undefined)
    const sessionFailed = failedOf(mainCalls)
    // Every token the API processed, the main loop's requests and the subagents': input with
    // its cache reads, and output. Each request sends the conversation again, so it far
    // outgrows the context. The cache hit is the main loop's input read from the cache.
    const mainIn = stepList.reduce((sum, s) => sum + (s.input ?? 0), 0)
    const mainOut = stepList.reduce((sum, s) => sum + (s.output ?? 0), 0)
    const cacheRead = stepList.reduce((sum, s) => sum + (s.cacheRead ?? 0), 0)
    const totalTokens = mainIn + mainOut + agentList.reduce((sum, a) => sum + a.tokens, 0)
    const totalOut = mainOut + agentList.reduce((sum, a) => sum + a.output, 0)
    const cacheHit = mainIn > 0 ? Math.round((cacheRead / mainIn) * 100) : undefined
    const session = promptList.length > 0 && (
      <Box key="session" flexDirection="column" marginBottom={1}>
        {items('count', [
          item('req', 'Session', PROMPT, `${stepList.length} req`),
          <Text key="tools" bold color={TOOL}>{`${mainCalls.length} tool`}</Text>,
          sessionFailed > 0 && <Text key="failed" bold color={ALERT}>{`${sessionFailed}✗`}</Text>,
        ])}
        {items('spent', [
          item('time', 'Time', TIME, fmtDuration(promptList.reduce((sum, p) => sum + (p.endedAt ?? at) - p.startedAt, 0))),
          item('cost', 'Cost', COST, `≈${fmtCost(promptList.reduce((sum, p) => sum + promptCost(p), 0))}`),
        ])}
        {totalTokens > 0 &&
          items('tokens', [
            item('tokens', 'Token', CONTEXT, fmtTokens(totalTokens)),
            item('out', 'Out', REQUEST, fmtTokens(totalOut)),
            cacheHit !== undefined &&
              item('hit', 'Cache hit', TOOL, `${cacheHit}%`, cacheHit >= 80 ? OK : cacheHit >= 50 ? YELLOW : WARN),
          ])}
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1}>
        {session}
        {subagents}
        {promptList.length === 0 && <Text color={MUTED}>No prompts yet: send one to start.</Text>}
        {shownPrompts.map(promptBlock)}
        {hiddenPrompts > 0 && unfold('prompts', `… ${hiddenPrompts} older prompts`)}
        {promptList.length > 0 && (
          // A rule, then the one button: ▴ in the separator's blue, its words in lavender,
          // dim while nothing is open.
          <Box key="footer" flexDirection="column" marginTop={1}>
            <Text color={RULE}>{'─'.repeat(cols)}</Text>
            <Button
              key="collapse"
              plain
              dimColor={v.expanded.length === 0}
              onPress={() => update($, view, prev => ({ ...prev, isFollowing: false, expanded: [] }))}
            >
              <Text bold color={SEPARATOR}>
                ▴{' '}
              </Text>
              <Text color={REQUEST}>Collapse all</Text>
            </Button>
          </Box>
        )}
      </Box>
    )
  })
}
