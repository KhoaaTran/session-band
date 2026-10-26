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

import type {
  AgentBody,
  AgentRun,
  Cache,
  Call,
  CallBody,
  CallStatus,
  Limit,
  Prompt,
  Stats,
  Step,
  Totals,
  Usage,
  View,
} from '../types'

// Adapted from JohnnyVizz/claude-kit session-band. Draws the band above the prompt in two
// rows: turn, prompt cache countdown and speed beside the 5h limit; context beside the weekly
// limit, the limits as Codex writes them. The status line, ../statusline.js, keeps one line
// (model, cwd, title) and relays what this API lacks (the native prompt_cache deadline, the
// turn count from the transcript) through a temp file. Context and limits come from
// $.session.usage(), the status line's own figures. It measures output speed itself, and
// notifies as the prompt cache runs out. The button beside Context opens the full view, the
// activity pane, below. One file: the plugin directory reads $ passed only to a function of
// the same file.

// Responses shorter than this are mostly tool-call stubs: their timing is noise.
const MIN_TOKENS = 20
// A response that arrived in one burst cannot be timed; such readings are dropped.
const MIN_SECONDS = 0.5
const MAX_SPEED = 1000

// Used until the status line relays the real deadline (ENABLE_PROMPT_CACHING_1H).
const CACHE_TTL_S = 60 * 60
// Minutes left at which a 1h cache's expiry is announced, once each per answer.
const CACHE_NOTIFY_MINUTES = [10, 5] as const

// Catppuccin Mocha, as statusline.js.
const TURN = '#f5c2e7'
const SPEED = '#b4befe'
const CACHE = '#94e2d5'
const CONTEXT = '#74c7ec'
const FIVE_HOUR = '#cba6f7'
const WEEKLY = '#eba0ac'
const SUB = '#a6adc8'
const OK = '#a6e3a1'
const YELLOW = '#f9e2af'
const WARN = '#fab387'
const ALERT = '#f38ba8'
const MUTED = '#7f849c'

const pad = (n: number) => String(n).padStart(2, '0')

// The status line's old steps, by the share used: context and limits alike.
const usedLevel = (used: number) => (used >= 85 ? ALERT : used >= 70 ? WARN : used >= 50 ? YELLOW : OK)

// A bar of cells: the terminal draws no Svg.
const BAR_CELLS = 10
const textBar = (percent: number) => {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS)))
  return { filled: '▰'.repeat(filled), empty: '▱'.repeat(BAR_CELLS - filled) }
}

// One decimal, a trailing .0 dropped: 289.1k, 300k, 1m.
const oneDecimal = (n: number) => n.toFixed(1).replace(/\.0$/, '')
// From 999,950 the k form would round to "1000k".
const tokens = (n: number) => (n >= 999_950 ?`${oneDecimal(n / 1e6)}m` : `${oneDecimal(n / 1e3)}k`)

// Local time: "13:00 24/10".
const resetText = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
}

const stats = atom({ plugin: 'session-band', key: 'stats' } as const, {
  turn: 0,
  speed: null,
} as Stats)

const cache = atom({ plugin: 'session-band', key: 'cache' } as const, {
  ttlSeconds: CACHE_TTL_S,
  expiresAt: null,
  secondsLeft: null,
} as Cache)

// A turn is running: the cache stays warm, so no countdown warnings.
const isBusy = atom({ plugin: 'session-band', key: 'isBusy' } as const, false)

// The smallest CACHE_NOTIFY_MINUTES already announced since the last answer; 0 none.
const warned = atom({ plugin: 'session-band', key: 'warned' } as const, 0)

// Context and the 5h and weekly windows: this session's last API response, or another
// session's newer figures from the shared cache.
const usage = atom({ plugin: 'session-band', key: 'usage' } as const, {
  context: null,
  fiveHour: null,
  weekly: null,
} as Usage)

// The activity pane is open (the pane writes it): the button's label.
const isPaneOpen = atom({ plugin: 'session-band', key: 'isPaneOpen' } as const, false)

const limitOf = (limits: { kind: string; percentUsed: number; resetsAt?: string }[], kind: string): Limit | null => {
  const l = limits.find(x => x.kind === kind)
  return l ? { percentUsed: l.percentUsed, resetsAt: l.resetsAt ?? null } : null
}

// The limits every session's status line last wrote to ~/.claude/rate-limits-cache.json;
// $.session.usage() only moves when this session calls the API.
type SharedLimits = Record<string, { used_percentage?: number; resets_at?: number }>

// Never throws: the file is rewritten every second, so a read can catch it half written,
// and a failure here must not stop the cache countdown below it.
const readSharedLimits = async ($: EngineInterface): Promise<SharedLimits> => {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) return {}
    const text = await $.fs.read(`${home.replace(/\\/g, '/')}/.claude/rate-limits-cache.json`)
    return (JSON.parse(text) as { rate_limits?: SharedLimits }).rate_limits ?? {}
  } catch {
    return {}
  }
}

const sharedLimitOf = (limits: SharedLimits, kind: string): Limit | null => {
  const l = limits[kind]
  if (typeof l?.used_percentage !== 'number') return null
  const resetsAt = typeof l.resets_at === 'number' ? new Date(l.resets_at * 1000).toISOString() : null
  return { percentUsed: l.used_percentage, resetsAt }
}

// The later window wins; within one window use only grows, so the higher share is the newer.
const newerLimit = (a: Limit | null, b: Limit | null): Limit | null => {
  if (!a || !b) return a ?? b
  const resetsA = a.resetsAt ? Date.parse(a.resetsAt) : NaN
  const resetsB = b.resetsAt ? Date.parse(b.resetsAt) : NaN
  if (!Number.isNaN(resetsA) && !Number.isNaN(resetsB) && Math.abs(resetsA - resetsB) > 60_000) {
    return resetsA > resetsB ? a : b
  }
  return a.percentUsed >= b.percentUsed ? a : b
}

// The system temp folder, where the status line's node process (os.tmpdir()) looks too.
const tempFile = async ($: EngineInterface, name: string) => {
  const tmp = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
  return `${tmp.replace(/\\/g, '/')}/${name}-${await $.session.id()}.json`
}

type Bridge = {
  ttl?: string
  expires_at?: number | null
  warm?: boolean
  caching_observed?: boolean
  turns?: number | null
}

// What the status line relays per session; null until it has run once.
// A half-written file reads as null too: the rejection handler of .then does not catch
// a JSON.parse that throws in the fulfilment handler.
const readBridge = async ($: EngineInterface): Promise<Bridge | null> => {
  try {
    return JSON.parse(await $.fs.read(await tempFile($, 'claude-prompt-cache'))) as Bridge
  } catch {
    return null
  }
}

// Claude Code's own notification (desktop and phone over Remote Control); when it is
// skipped because the person is at this session, a toast says it instead.
const notifyCacheExpiry = async ($: EngineInterface, minutes: number) => {
  const project = (await $.session.cwd()).split(/[\\/]/).filter(Boolean).pop() ?? 'session'
  const text = `${project}: the prompt cache expires in ${minutes} min`

  const sent = await $.tool
    .call({ tool: 'PushNotification', message: text, status: 'proactive' })
    .catch(() => null)
  const isDelivered =
    sent !== null &&
    sent.deny === undefined &&
    sent.isError !== true &&
    (sent.result.pushSent === true || sent.result.localSent === true)

  if (!isDelivered) $.ui.toast(`⏳ ${text}`, { timeoutMs: 30000 })
}

export const register: Register = (on, options) => {
  registerActivity(on, options)

  // Set by `/session-band demo`, cleared by the next answer.
  let isDemo = false
  // Output tokens and streaming seconds of the main thread's current turn.
  let turnTokens = 0
  let turnSeconds = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)

    await startActivity($)
    await $.command.register({
      name: 'session-band',
      description: '`demo <minutes>` previews the prompt cache expiry notification',
    })

    $.clock.every(1000, async () => {
      const { context, rateLimits } = await $.session.usage()
      const shared = await readSharedLimits($)
      const nextUsage: Usage = {
        context:
          context.percent === undefined
            ? null
            : { percent: context.percent, tokens: context.tokens ?? null, window: context.window },
        fiveHour: newerLimit(limitOf(rateLimits, 'five_hour'), sharedLimitOf(shared, 'five_hour')),
        weekly: newerLimit(limitOf(rateLimits, 'seven_day'), sharedLimitOf(shared, 'seven_day')),
      }
      if (JSON.stringify(nextUsage) !== JSON.stringify(await read($, usage))) {
        await update($, usage, () => nextUsage)
      }

      const bridge = isDemo ? null : await readBridge($)
      // The status line counts the prompts the person sent from the transcript, so the
      // count survives a reload; our own count stands in until it has drawn.
      const turns = bridge?.turns
      if (typeof turns === 'number' && turns !== (await read($, stats)).turn) {
        await update($, stats, s => ({ ...s, turn: turns }))
      }
      const now = await $.clock.now()
      const current = await read($, cache)
      const ttlSeconds = bridge?.ttl === '5m' ? 300 : CACHE_TTL_S
      const expiresAt = !bridge
        ? current.expiresAt
        : bridge.caching_observed === false || bridge.warm === false
          ? null
          : typeof bridge.expires_at === 'number'
            ? bridge.expires_at * 1000
            : current.expiresAt
      if (expiresAt === null) {
        if (current.secondsLeft !== null) await update($, cache, () => ({ ttlSeconds, expiresAt: null, secondsLeft: null }))
        return
      }

      const left = Math.max(0, Math.floor((expiresAt - now) / 1000))
      if (left !== current.secondsLeft || expiresAt !== current.expiresAt || ttlSeconds !== current.ttlSeconds) {
        await update($, cache, () => ({ ttlSeconds, expiresAt, secondsLeft: left }))
      }

      // A 5m cache runs out between most turns: no notifications for it.
      if (ttlSeconds !== CACHE_TTL_S) return
      const due = CACHE_NOTIFY_MINUTES.filter(m => left > 0 && left <= m * 60)
      if (due.length === 0 || (await read($, isBusy))) return

      const minutes = Math.min(...due)
      const last = await read($, warned)
      if (last !== 0 && last <= minutes) return

      await update($, warned, () => minutes)
      await notifyCacheExpiry($, Math.ceil(left / 60))
    })

    return result
  })

  on('command.run', { command: 'session-band' }, async ($, e) => {
    // `/session-band demo <minutes>` fakes the cache deadline to preview the notification;
    // the next answer resets it.
    const demo = e.args.trim().match(/^demo\s+(\d+(?:\.\d+)?)$/)
    if (!demo) return { text: 'Usage: /session-band demo <minutes>, e.g. /session-band demo 10.5' }

    const seconds = Math.round(Number(demo[1]) * 60)
    const now = await $.clock.now()
    isDemo = true
    await update($, cache, () => ({ ttlSeconds: CACHE_TTL_S, expiresAt: now + seconds * 1000, secondsLeft: seconds }))
    await update($, warned, () => 0)

    return { text: `Cache demo: ${demo[1]} min left; the next answer resets it.` }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnTokens = 0
      turnSeconds = 0
      await update($, stats, s => ({ ...s, turn: s.turn + 1 }))
      await update($, isBusy, () => true)
    }
    await activityTurnStart($, e)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    const step = await activityStepStart($, e)
    const stream = next(e)

    // Measured from the response's first item, so time-to-first-token is excluded but
    // thinking that streams hidden or in one late burst is still timed. Every loop's request
    // rows show it; the band's speed is the main loop's alone.
    let startedAt: number | null = null

    try {
      for await (const chunk of stream) {
        if (startedAt === null) {
          startedAt = await $.clock.now()
        }

        if (isMain && startedAt !== null && chunk.kind === 'stop' && chunk.usage !== null) {
          // Averaged over every request of the turn, so a short tool-call stub at the
          // end does not stand for the whole reply.
          turnTokens += chunk.usage.output_tokens
          turnSeconds += ((await $.clock.now()) - startedAt) / 1000
          const speed = turnTokens / turnSeconds
          if (turnTokens >= MIN_TOKENS && turnSeconds >= MIN_SECONDS && speed <= MAX_SPEED) {
            await update($, stats, s => ({ ...s, speed: Math.round(speed) }))
          }
        }

        yield chunk
      }
    } catch (err) {
      await activityStepEnd($, e, step, null, startedAt)
      throw err
    }

    const result = await stream.result
    await activityStepEnd($, e, step, result, startedAt)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      isDemo = false
      // Until the status line relays the real deadline, estimate it from this answer.
      const now = await $.clock.now()
      await update($, cache, c => ({ ...c, expiresAt: now + c.ttlSeconds * 1000, secondsLeft: c.ttlSeconds }))
      await update($, isBusy, () => false)
      await update($, warned, () => 0)
    }
    await activityTurnComplete($, e)

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, stats)
    const { ttlSeconds, secondsLeft } = await read($, cache)
    // Always drawn, except while Claude Code's own survey takes this row.
    if (e.props.hasSurvey) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)

    // Amber at a third of the TTL left, red at a sixth: 20 and 10 minutes for a 1h cache.
    // While a reply streams every request rewrites the cache: no countdown to show.
    const level =
      e.props.isWorking || secondsLeft === null || secondsLeft === 0 ? null
      : secondsLeft <= ttlSeconds / 6 ? ALERT
      : secondsLeft <= ttlSeconds / 3 ? WARN
      : null
    const cacheColor =
      e.props.isWorking || secondsLeft === null ? MUTED : secondsLeft === 0 ? ALERT : (level ?? OK)
    const cacheText =
      e.props.isWorking ? '…'
      : secondsLeft === null ? '—'
      : secondsLeft === 0 ? 'expired'
      : `${pad(Math.floor(secondsLeft / 60))}:${pad(secondsLeft % 60)}`

    const u = await read($, usage)
    const dot = <Text color={MUTED}>{'  ·  '}</Text>
    const ctxColor = u.context ? usedLevel(u.context.percent) : MUTED
    const bar = textBar(u.context?.percent ?? 0)

    // "⚠ 5h limit: 59% left · resets at 13:00 24/10", as Codex writes it.
    const limitParts = (label: string, limit: Limit | null) => {
      const value = limit ? `${Math.round(100 - limit.percentUsed)}% left` : '—'
      const resets = limit?.resetsAt ? resetText(limit.resetsAt) : null
      const suffix = resets ? ` · resets at ${resets}` : ''
      return { value, suffix, text: `⚠ ${label}: ${value}${suffix}` }
    }
    const limitRow = (label: string, hue: string, limit: Limit | null) => {
      const color = limit ? usedLevel(limit.percentUsed) : MUTED
      const { value, suffix } = limitParts(label, limit)
      return (
        <Text wrap="truncate-end">
          <Text color={color}>⚠ </Text>
          <Text color={hue}>{`${label}: `}</Text>
          <Text bold color={color}>{value}</Text>
          {suffix ? <Text color={MUTED}>{suffix}</Text> : null}
        </Text>
      )
    }

    const speedText = s.speed === null ? '—' : `${s.speed} tok/s`
    // A 5m cache on a subscription means ENABLE_PROMPT_CACHING_1H is not taking effect.
    const cacheNote = ttlSeconds !== CACHE_TTL_S ? ' (5m, 1h off)' : ''
    const ctxValue = u.context ? ` ${Math.round(u.context.percent)}%` : ' —'
    const ctxTokens = u.context?.tokens != null ? ` (${tokens(u.context.tokens)}/${tokens(u.context.window)})` : ''

    // Each limit stays beside its left item while both fit with the gap between them;
    // otherwise the limits take rows of their own under the left items instead of being cut.
    // Beside Context: opens the activity pane, the full view; again closes it.
    const isOpen = await read($, isPaneOpen)
    // A symbol of the same block as the limits' ⚠ (Miscellaneous Symbols), which the
    // terminal draws. One icon either way; its color says whether the pane is open.
    const detailLabel = '☰'
    const where = { isFullscreen: e.viewport?.isFullscreen ?? false, columns: e.viewport?.columns ?? 80 }
    const detailButton = (
      <Button
        key="detail"
        plain
        onPress={async () => {
          // The button says the rest by its color; a pane that could not be shown, by a toast.
          const toggled = await togglePane($, where)
          if (!toggled.isShown && isOpen === false) $.ui.toast(toggled.text)
        }}
      >
        {/* Colored as the limits' ⚠: Context's hue while closed, the OK green while open. */}
        <Text bold color={isOpen ? OK : CONTEXT}>
          {detailLabel}
        </Text>
      </Button>
    )

    const GAP = 3
    const inner = e.props.bodyColumns - 2 - (level ? 2 : 0)
    const left1 = `Turn: ${s.turn}  ·  Cache: ${cacheText}${cacheNote}  ·  Speed: ${speedText}`
    const left2 = `Context: ${bar.filled}${bar.empty}${ctxValue}${ctxTokens}  ${detailLabel}`
    const isSideBySide =
      left1.length + GAP + limitParts('5h limit', u.fiveHour).text.length <= inner &&
      left2.length + GAP + limitParts('Weekly limit', u.weekly).text.length <= inner

    const turnRow = (
      <Text wrap="truncate-end">
        <Text color={TURN}>Turn: </Text>
        <Text bold color={TURN}>{String(s.turn)}</Text>
        {dot}
        <Text color={CACHE}>Cache: </Text>
        <Text bold color={cacheColor}>{cacheText}</Text>
        {cacheNote ? <Text color={WARN}>{cacheNote}</Text> : null}
        {dot}
        <Text color={SPEED}>Speed: </Text>
        <Text bold color={SPEED}>{speedText}</Text>
      </Text>
    )
    const contextRow = (
      <Text wrap="truncate-end">
        <Text color={CONTEXT}>Context: </Text>
        <Text color={ctxColor}>{bar.filled}</Text>
        <Text color={MUTED}>{bar.empty}</Text>
        <Text bold color={ctxColor}>{ctxValue}</Text>
        {ctxTokens ? <Text color={SUB}>{ctxTokens}</Text> : null}
      </Text>
    )

    return (
      <Box
        flexDirection="column"
        overflow="hidden"
        paddingX={1}
        {...(level ? { borderStyle: 'round', borderColor: level } : {})}
      >
        {/* Every item "Label: value", the label in the item's hue, the value bold in its
            state's. Left: turn, cache and speed, then context; right: one limit a row. */}
        {isSideBySide ? (
          <>
            <Box flexDirection="row" alignItems="center" flexWrap="nowrap">
              {turnRow}
              <Box flexGrow={1} flexShrink={1} minWidth={GAP} />
              {limitRow('5h limit', FIVE_HOUR, u.fiveHour)}
            </Box>
            <Box flexDirection="row" alignItems="center" flexWrap="nowrap" columnGap={2}>
              {contextRow}
              {detailButton}
              <Box flexGrow={1} flexShrink={1} minWidth={GAP} />
              {limitRow('Weekly limit', WEEKLY, u.weekly)}
            </Box>
          </>
        ) : (
          <>
            {turnRow}
            <Box flexDirection="row" alignItems="center" flexWrap="nowrap" columnGap={2}>
              {contextRow}
              {detailButton}
            </Box>
            {limitRow('5h limit', FIVE_HOUR, u.fiveHour)}
            {limitRow('Weekly limit', WEEKLY, u.weekly)}
          </>
        )}
      </Box>
    )
  })
}

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

// Prompts and requests count the subagents' runs and requests too.
const MAX_CALLS = 1000
const MAX_PROMPTS = 200
const MAX_STEPS = 1000
const MAX_AGENTS = 100
// A tool call that ran this long is drawn in the warning hue.
const SLOW_MS = 30_000
// Calls listed under one request, and prompts listed; the earlier ones fold into a line.
const MAX_ROWS = 12
const MAX_PROMPTS_SHOWN = 15
const CHARS_PER_TOKEN = 4
// A prompt's title as kept: wider than any row draws.
const PROMPT_TITLE_CHARS = 300

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
// The whole task and report of the subagent whose screen is open, read from its files.
const agentBody = atom({ plugin: 'session-band', key: 'agentBody' } as const, null)
// The header's figures a resumed session showed before, from `$.store`.
const carried = atom({ plugin: 'session-band', key: 'carried' } as const, null)


// The pane's own hues beside the band's: every item "Label: value", the label in the item's
// hue, the value bold, items split by a muted " · ".
const PROMPT = '#f5c2e7'
const REQUEST = '#b4befe'
const TOOL = '#94e2d5'
const TIME = '#cba6f7'
const COST = '#eba0ac'
const SEPARATOR = '#89b4fa'
const RULE = '#45475a'

// Glyphs Claude Code draws itself, so the terminal's font has them.
const CALL_GLYPH: Record<CallStatus, string> = { running: '●', background: '●', ok: '✓', error: '✗', denied: '✗' }
const CALL_COLOR: Record<CallStatus, string> = {
  running: YELLOW,
  background: YELLOW,
  ok: OK,
  error: ALERT,
  denied: WARN,
}
const AGENT_GLYPH: Record<string, string> = { done: '✓', failed: '✗' }
const AGENT_COLOR: Record<string, string> = { running: YELLOW, done: OK, failed: ALERT }
// The pane redraws once a second while something runs: one frame per redraw.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

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

type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const promptOf = (u: ApiUsage): number =>
  (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

const priceOf = (model: string, prompt: number): Price => {
  const id = model.toLowerCase()
  if (prompt > HAIKU_LONG_PROMPT && /haiku-5-5/.test(id)) return HAIKU_LONG
  return PRICES.find(([re]) => re.test(id))?.[1] ?? [4, 20, 0.2, 8]
}

/**
 * What the next request pays to send a context again: read from the prompt cache while it
 * holds, written to it again once it expired.
 */
const cacheTaxOf = (model: string, context: number): { warm: number; expired: number } => {
  const [, , r, w] = priceOf(model, context)
  return { warm: (context * r) / 1e6, expired: (context * w) / 1e6 }
}

// `isRequest` says the usage is one model request, which is what a prompt-length price
// is set by; a turn's sum is priced at the model's ordinary prices.
const costOf = (model: string, u: ApiUsage, isRequest: boolean): number => {
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

// When a prompt was sent, in local time, always five cells so the prompts' text lines up:
// "14:32". Its day is a rule above the prompts of another day than the one above them.
const fmtSentAt = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fmtDay = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
}
const dayOf = (ms: number): string => new Date(ms).toDateString()

const estimate = (chars: number): number => (chars <= 0 ? 0 : Math.max(1, Math.round(chars / CHARS_PER_TOKEN)))

const ctxOf = (a: AgentRun): number =>
  a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0

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

// The background task a shell call left running (`run_in_background`, ctrl+b, a timeout,
// a message queued for the model). None when the command ends with the caller's final
// response: no notification follows it.
const taskOf = (result: unknown): string | undefined => {
  if (typeof result !== 'object' || result === null) return undefined
  const r = result as { backgroundTaskId?: unknown; backgroundEndsWithFinalResponse?: unknown }
  return typeof r.backgroundTaskId === 'string' && r.backgroundEndsWithFinalResponse !== true
    ? r.backgroundTaskId
    : undefined
}

// A background task's end, as its notification writes it:
// <task-notification><task-id>…</task-id><tool-use-id>…</tool-use-id>…<status>completed</status>
// <summary>Background command "…" completed (exit code 0)</summary></task-notification>
type TaskEnd = { taskId?: string; toolUseId?: string; status?: string; summary?: string }
const TASK_NOTIFICATION = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g
const tagOf = (block: string, tag: string): string | undefined =>
  block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() || undefined
const taskEndsOf = (text: string): TaskEnd[] =>
  [...text.matchAll(TASK_NOTIFICATION)].map(([, block = '']) => ({
    taskId: tagOf(block, 'task-id'),
    toolUseId: tagOf(block, 'tool-use-id'),
    status: tagOf(block, 'status'),
    summary: tagOf(block, 'summary'),
  }))

/** A prompt's row text: a task notification reads as its summary, not its markup. */
const promptTitle = (text: string): string => {
  const ends = taskEndsOf(text)
  if (!ends.length) return oneLine(text)
  return ends.map(t => oneLine(t.summary ?? `Task ${t.taskId ?? ''} ${t.status ?? 'ended'}`)).join(' · ')
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

// A subagent's task and report, each in its own file beside the calls': the task written
// at its spawn, the report at each end of its run.
type AgentPart = 'prompt' | 'answer'
async function agentPath($: EngineInterface, id: string, part: AgentPart): Promise<string> {
  return bodyPath($, `agent-${id}-${part}`)
}

async function writeAgentPart($: EngineInterface, id: string, part: AgentPart, text: string): Promise<void> {
  try {
    await markAlive($)
    await $.fs.write(await agentPath($, id, part), JSON.stringify(text))
  } catch {
    // Its screen keeps to the first lines the state holds.
  }
}

async function readAgentPart($: EngineInterface, id: string, part: AgentPart): Promise<string | undefined> {
  try {
    const text = JSON.parse(await $.fs.read(await agentPath($, id, part))) as unknown
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

async function readAgentBody($: EngineInterface, id: string): Promise<AgentBody> {
  const prompt = await readAgentPart($, id, 'prompt')
  const answer = await readAgentPart($, id, 'answer')
  // The task first, up to half the room; the report in the rest.
  const shownPrompt = cutAt(prompt, SCREEN_CHARS / 2, await agentPath($, id, 'prompt'))
  const shownAnswer = cutAt(answer, SCREEN_CHARS - (shownPrompt?.length ?? 0), await agentPath($, id, 'answer'))
  return { id, prompt: shownPrompt, answer: shownAnswer, isWhole: prompt !== undefined }
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
async function togglePane(
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

const failedOf = (list: Call[]) => list.filter(c => c.status === 'error' || c.status === 'denied').length
// Still at work: answering, or its command running on in the background.
const isLive = (c: Call) => c.status === 'running' || c.status === 'background'
// How long a call ran: a background command's, until its task ended.
const callMs = (c: Call, at: number) => ((c.taskId === undefined ? c.endedAt : c.taskEndedAt) ?? at) - c.startedAt

/** The subagent an Agent call spawned, and what a subagent or a prompt cost with every subagent under it. */
const costsOf = (allCalls: Call[], agentList: AgentRun[]) => {
  // Matched by the call's id.
  const runOf = (c: Call): AgentRun | undefined =>
    c.tool === 'Agent' ? agentList.find(a => a.toolUseId === c.id) : undefined
  const callsOf = (a: AgentRun): Call[] => (a.agentId ? allCalls.filter(c => c.agentId === a.agentId) : [])
  const runCost = (a: AgentRun): number =>
    callsOf(a).reduce((sum, c) => {
      const child = runOf(c)
      return child ? sum + runCost(child) : sum
    }, a.costUsd)
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
  return { runOf, callsOf, runCost, promptCost }
}

const noTotals = (sessionId: string): Totals => ({
  sessionId,
  prompts: 0,
  requests: 0,
  tools: 0,
  failed: 0,
  durationMs: 0,
  costUsd: 0,
  tokens: 0,
  output: 0,
  mainInput: 0,
  cacheRead: 0,
})

/**
 * The header's figures over the rows the pane keeps, on top of `base`, what the session
 * showed before this process. Every token the API processed, the loop's requests and the
 * subagents' under it: input with its cache reads, and output.
 *
 * `loop` is a subagent's id for its own screen, absent for the session; `agents` the
 * subagents its calls spawned.
 */
const totalsOf = (
  base: Totals,
  lists: { prompts: Prompt[]; steps: Step[]; calls: Call[]; agents: AgentRun[] },
  at: number,
  loop?: string,
): Totals => {
  const { promptCost } = costsOf(lists.calls, lists.agents)
  const own = <T extends { agentId?: string }>(list: T[]) => list.filter(x => x.agentId === loop)
  const [ownPrompts, ownSteps, ownCalls] = [own(lists.prompts), own(lists.steps), own(lists.calls)]
  const sum = <T,>(list: T[], of: (x: T) => number) => list.reduce((s, x) => s + of(x), 0)
  const mainInput = sum(ownSteps, s => s.input ?? 0)
  const mainOutput = sum(ownSteps, s => s.output ?? 0)
  return {
    sessionId: base.sessionId,
    prompts: base.prompts + ownPrompts.length,
    requests: base.requests + ownSteps.length,
    tools: base.tools + ownCalls.length,
    failed: base.failed + failedOf(ownCalls),
    durationMs: base.durationMs + sum(ownPrompts, p => (p.endedAt ?? at) - p.startedAt),
    costUsd: base.costUsd + sum(ownPrompts, promptCost),
    tokens: base.tokens + mainInput + mainOutput + sum(lists.agents, a => a.tokens),
    output: base.output + mainOutput + sum(lists.agents, a => a.output),
    mainInput: base.mainInput + mainInput,
    cacheRead: base.cacheRead + sum(ownSteps, s => s.cacheRead ?? 0),
  }
}

// One small record per session in `$.store`, the most recently saved kept.
const TOTALS_PREFIX = 'totals:'
const MAX_SAVED_SESSIONS = 50

async function readTotals($: EngineInterface): Promise<Totals> {
  const [prompts_, steps_, calls_, agents_] = [
    await read($, prompts),
    await read($, steps),
    await read($, calls),
    await read($, agents),
  ]
  const base = (await read($, carried)) ?? noTotals(await $.session.id())
  return totalsOf(base, { prompts: prompts_, steps: steps_, calls: calls_, agents: agents_ }, await $.clock.now())
}

/** Saves the header's figures under the session's id; a session with none saves nothing. */
async function saveTotals($: EngineInterface, sessionId?: string): Promise<void> {
  try {
    const totals = await readTotals($)
    const id = sessionId ?? totals.sessionId
    if (totals.prompts === 0 && totals.tools === 0) return
    const key = `${TOTALS_PREFIX}${id}`
    // Removed first so it moves to the end of the store's insertion order: the oldest go.
    await $.store.delete(key)
    await $.store.set(key, { ...totals, sessionId: id })
    const saved = (await $.store.keys()).filter(k => k.startsWith(TOTALS_PREFIX))
    for (const old of saved.slice(0, Math.max(0, saved.length - MAX_SAVED_SESSIONS))) await $.store.delete(old)
  } catch {
    // The next turn's end saves them again.
  }
}

/** The figures saved for this session, once per session id: a resume's, or none. */
async function restoreTotals($: EngineInterface): Promise<void> {
  try {
    const id = await $.session.id()
    if ((await read($, carried))?.sessionId === id) return
    let saved: Totals | undefined
    try {
      const value = (await $.store.get(`${TOTALS_PREFIX}${id}`)) as Totals | undefined
      if (value && typeof value === 'object' && value.sessionId === id) saved = { ...noTotals(id), ...value }
    } catch {
      // None to read: the header counts from now.
    }
    await update($, carried, () => saved ?? noTotals(id))
  } catch {
    // No id to read yet: the next second tries again.
  }
}

// The band's own hooks call these on the events both parts follow: a plugin hooks an event
// once without a matcher, in one hooks module.

/** `session.start`, after the engine's: the command and the clock of the running rows. */
async function startActivity($: EngineInterface): Promise<void> {
  await update($, isPaneOpen, () => false)
  await restoreTotals($)
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

  // Ticks the running clocks; quiet when nothing runs. A /resume in this process goes on
  // under another id: its saved figures are read in the next second.
  $.clock.every(1000, async () => {
    await restoreTotals($)
    const [c, a, p] = [await read($, calls), await read($, agents), await read($, prompts)]
    const isRunning =
      c.some(isLive) ||
      a.some(x => x.status === 'running') ||
      (p.length > 0 && p.at(-1)?.endedAt === undefined)
    if (isRunning) await tick($)
  })
}

/** `turn.start`: a prompt opens a row, the main loop's or a subagent's run. */
async function activityTurnStart($: EngineInterface, e: TurnStartInput): Promise<void> {
  const at = await $.clock.now()
  // The main loop's turns are numbered across the session, those before a resume counted.
  let n: number | undefined
  if (e.agentId === undefined) {
    const main = (await read($, prompts)).filter(p => p.agentId === undefined)
    const last = main.at(-1)?.n
    n = last !== undefined ? last + 1 : ((await read($, carried))?.prompts ?? 0) + main.length + 1
  }
  const prompt: Prompt = {
    turnId: e.turnId,
    n,
    agentId: e.agentId,
    // Only its row's title is drawn: a long paste or brief is not kept whole in the state,
    // which every event reads (a subagent's task is whole in its file).
    text: fit(promptTitle(e.text), PROMPT_TITLE_CHARS),
    startedAt: at,
    isAborted: false,
    costUsd: 0,
  }
  await update($, prompts, list => [...list.filter(p => p.turnId !== e.turnId), prompt].slice(-MAX_PROMPTS))
  // A new main-loop prompt is followed again, whatever was opened by hand before it.
  if (e.agentId === undefined) await update($, view, v => ({ ...v, isFollowing: true, expanded: [e.turnId] }))
  await update($, now, () => at)
}

/** `turn.step` as it is sent: a request opens a row, the main loop's or a subagent's; its `n`. */
async function activityStepStart($: EngineInterface, e: TurnStepInput): Promise<number> {
  const startedAt = await $.clock.now()
  const list = await read($, steps)
  const n = (list.at(-1)?.n ?? 0) + 1
  const last = list.findLast(s => s.agentId === e.agentId)
  const step: Step = {
    n,
    seq: (last ? (last.seq ?? last.n) : 0) + 1,
    effort: typeof e.effort === 'string' ? e.effort : undefined,
    agentId: e.agentId,
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
  if (e.agentId === undefined) {
    await update($, view, v => (v.isFollowing ? { ...v, expanded: [e.turnId, stepKey(n)] } : v))
  }
  await update($, now, () => startedAt)
  return n
}

/**
 * `turn.step` once its response is whole (`result` null when it threw): the request's row
 * gets its usage and when its first item came (`firstChunkAt`, null when none did); a
 * subagent's live context and output move too.
 */
async function activityStepEnd(
  $: EngineInterface,
  e: TurnStepInput,
  n: number,
  result: TurnStepResult | null,
  firstChunkAt: number | null,
): Promise<void> {
  const endedAt = await $.clock.now()
  await update($, steps, list => {
    // Compared with the request before it in the same loop: another loop's context is not its own.
    const prev = list.findLast(s => s.n < n && s.agentId === e.agentId)
    return list.map((s): Step => {
      if (s.n !== n) return s
      const ended: Step = result ? endStep(s, result, endedAt, prev) : { ...s, status: 'failed', endedAt }
      return firstChunkAt === null ? ended : { ...ended, firstChunkAt }
    })
  })
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
async function activityTurnComplete($: EngineInterface, e: TurnCompleteInput): Promise<void> {
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
          answer: excerpt(e.answer) ?? a.answer,
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
    await update($, prompts, list =>
      list.map(p =>
        p.turnId !== e.turnId
          ? p
          : {
              ...p,
              endedAt: at,
              isAborted: e.isAborted,
              costUsd: e.usage ? costOf(e.usage.model, e.usage, false) : p.costUsd,
            },
      ),
    )
    const run = (await read($, agents)).find(a => a.agentId === agentId)
    if (run && e.answer) {
      await writeAgentPart($, run.id, 'answer', e.answer)
      // Its screen was opened while it ran: it now has the report.
      if ((await read($, view)).agent === run.id) {
        const whole = await readAgentBody($, run.id)
        await update($, agentBody, () => whole)
      }
    }
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
    // Saved at each answer too, so a session the process lost before its end keeps them.
    await saveTotals($)
  }
  await update($, now, () => at)
}

/** The hooks of events only the activity pane follows. */
const registerActivity: Register = on => {
  on('command.run', { command: 'activity' }, async ($, e) => {
    if ((e.args ?? '').trim() === 'clear') {
      const last = (await read($, prompts)).findLast(p => p.agentId === undefined)
      const keep = last?.endedAt === undefined ? last?.turnId : undefined
      // A running subagent keeps its rows too.
      const live = new Set((await read($, agents)).filter(a => a.status === 'running').map(a => a.agentId))
      const isKept = (x: { turnId?: string; agentId?: string }) =>
        (keep !== undefined && x.turnId === keep) || (x.agentId !== undefined && live.has(x.agentId))
      await update($, prompts, list => list.filter(isKept))
      await update($, steps, list => list.filter(isKept))
      await update($, calls, list => list.filter(c => isLive(c) || isKept(c)))
      await update($, agents, list => list.filter(a => a.status === 'running'))
      $.ui.toast('Cleared what is done from the pane.')
      return {}
    }
    // A toast, not a transcript line: the model would read the line as context.
    $.ui.toast((await togglePane($, e.presentation)).text)
    return {}
  })

  // Exit, /clear, a resume: what the session showed is gone from view, so are its files;
  // only the header's figures are saved, for a resume of it. A /clear or a /resume goes on
  // in this process under another id: the pane starts over.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    await saveTotals($, e.sessionId)
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
      await update($, view, v => ({ ...v, expanded: [], isFollowing: true, detail: undefined, agent: undefined }))
      await update($, body, () => null)
      await update($, agentBody, () => null)
      await update($, carried, () => null)
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
    // Under its loop's latest prompt and request: the main loop's, or its subagent's.
    const turnId = (await read($, prompts)).findLast(p => p.agentId === e.agentId)?.turnId
    const step = turnId !== undefined ? (await read($, steps)).findLast(s => s.turnId === turnId)?.n : undefined
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
    // `taskId`: the command runs on in the background; its notification ends the row.
    const finish = async (status: CallStatus, text: string, isRecord = false, taskId?: string) => {
      const endedAt = await $.clock.now()
      const error = status === 'ok' ? undefined : excerpt(text)
      const output = status === 'ok' ? excerpt(text) : undefined
      const ended = { status: taskId ? ('background' as const) : status, taskId, endedAt }
      await update($, calls, list =>
        list.map(c => (c.id === id ? { ...c, ...ended, resultChars: text.length, error, output, isRecord } : c)),
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
      await finish(status, record ?? text, record !== undefined, status === 'ok' ? taskOf(ran.result) : undefined)
      return ran
    } catch (err) {
      await finish('error', String(err))
      throw err
    }
  })

  // A background task's notification, as it starts a turn or reaches a running one: the
  // call that left the task running ends with it.
  on('prompt.submit', async ($, e, next) => {
    const ends = e.origin.kind === 'task-notification' ? taskEndsOf(e.text) : []
    if (ends.length) {
      const at = await $.clock.now()
      await update($, calls, list =>
        list.map((c): Call => {
          const end = ends.find(t => t.toolUseId === c.id || (t.taskId !== undefined && t.taskId === c.taskId))
          if (!end || c.status !== 'background') return c
          return { ...c, status: end.status === 'completed' ? 'ok' : 'error', taskEndedAt: at }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
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
      prompt: excerpt(e.prompt),
    }
    await update($, agents, list => [...list.filter(a => a.id !== run.id), run].slice(-MAX_AGENTS))
    await writeAgentPart($, run.id, 'prompt', e.prompt)
    await update($, now, () => at)
    return started
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const allCalls = await read($, calls)
    const promptList = await read($, prompts)
    // The main loop's prompts: a subagent's runs are on its own screen.
    const mainPrompts = promptList.filter(p => p.agentId === undefined)
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

    const { runOf, callsOf, runCost, promptCost } = costsOf(allCalls, agentList)

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
    // A subagent's row opens its own screen; Back lands on its row again.
    const agentKey = (id: string) => `g:${id}`
    const runKey = (id: string) => `run:${id}`
    const openAgent = async (id: string) => {
      // Its latest run opens, as the session's newest prompt does.
      const loop = agentList.find(a => a.id === id)?.agentId
      const latest = (loop !== undefined && promptList.findLast(p => p.agentId === loop)?.turnId) || runKey(id)
      await update($, view, prev => ({
        ...prev,
        isFollowing: false,
        agent: id,
        expanded: prev.expanded.includes(latest) ? prev.expanded : [...prev.expanded, latest],
      }))
      await reveal(BACK)
      const whole = await readAgentBody($, id)
      await update($, agentBody, () => whole)
    }
    const closeAgent = async (id: string) => {
      await update($, view, prev => ({ ...prev, agent: undefined }))
      await update($, agentBody, () => null)
      await reveal(agentKey(id))
    }
    const shownAgentBody = await read($, agentBody)

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
      const isRunning = isLive(c)
      const isCut = isRead && !whole && !isRunning && (input ?? answer) !== undefined
      const ms = callMs(c, at)
      return (
        <Box flexDirection="column">
          <Button key={BACK} label="‹ Back" plain onPress={() => closeDetail(c.id)} />
          <Box marginTop={1}>
            <Text>
              <Text color={CALL_COLOR[c.status]}>{isRunning ? frame : CALL_GLYPH[c.status]}</Text>
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

    // `prefix`: a call listed twice (under its request and under Background) keys each row apart.
    const callRow = (c: Call, prefix = 'a') => {
      const isRunning = isLive(c)
      const run = runOf(c)
      // An Agent call opens on its subagent in place; any other call opens its own screen.
      const key = `${prefix}:${c.id}`
      const isOpen = run !== undefined && v.expanded.includes(key)
      const ms = callMs(c, at)
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
              <Button
                key={`${key}:open`}
                label="› Prompt and answer"
                plain
                dimColor
                onPress={() => openAgent(run.id)}
              />
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
          {shown.map(c => callRow(c))}
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
      const label = fit(`${isOpen ? '▾' : '▸'} #${s.seq ?? s.n} ${gist(s)}`, leftColumns(2))
      // Before the first item the wait (network, queue, reading the input), after it the writing.
      const timing =
        s.endedAt === undefined
          ? []
          : s.firstChunkAt === undefined
            ? [item('took', 'Time', TIME, fmtDuration(s.endedAt - s.startedAt))]
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
              {items('model', [item('model', 'Model', SUB, s.effort ? `${modelName(s.model)} · ${s.effort}` : modelName(s.model))])}
              {isCacheRewrite(s) && <Text color={WARN}>{`⚠ cache written again ${fmtTokens(s.cacheWrite ?? 0)}`}</Text>}
              {s.isCompacted && <Text color={WARN}>compacted before this request</Text>}
            </Box>
          )}
        </Box>
      )
    }

    // The row tells prompts apart by what each cost; the context, which only grows from one
    // to the next, waits in the summary.
    // ▸ ❯ change the button icon    │   ≈$0.12 · 35s
    // ▾ ❯ fix the contact list scroll │ ⚠ ≈$0.31 · 01:20
    //   Req: 3 · Tool: 5 · Failed: 1 · Context: 19k
    // `own`: a subagent's run whose turn went unheard lists every call of the subagent.
    const promptBlock = (p: Prompt, own = allCalls.filter(c => c.turnId === p.turnId)) => {
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
      const text = p.text ? promptTitle(p.text) : '(continuation)'
      // When it was sent stands where the prompt mark was: "▸ 14:32 fix the scroll", the
      // arrow in the separator's blue as the footer's ▴, the time lit while the prompt is
      // open or runs.
      const head = `${isOpen ? '▾' : '▸'} `
      const sent = `${fmtSentAt(p.startedAt)} `
      const label = fit(text, leftColumns(0) - head.length - sent.length)
      return (
        <Box key={p.turnId} flexDirection="column" marginBottom={isOpen ? 1 : 0}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Button key={p.turnId} plain dimColor={!isOpen && !isRunning} onPress={() => toggle(p.turnId)}>
              <Text bold color={SEPARATOR}>
                {head}
              </Text>
              <Text color={isOpen || isRunning ? TIME : MUTED}>{sent}</Text>
              <Text>{label}</Text>
            </Button>
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
                p.n !== undefined && item('turn', 'Turn', PROMPT, String(p.n)),
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

    // A subagent's figures, as a prompt's: what it cost with its own subagents, and its time.
    const agentMetrics = (a: AgentRun) => {
      const cost = runCost(a)
      const isRunning = a.status === 'running'
      return metrics([
        a.status === 'failed' && <Text key="look" color={WARN}>⚠ </Text>,
        cost > 0 && <Text key="price" color={COST}>{`≈${fmtCost(cost)}`}</Text>,
        cost > 0 && <Text key="dot" color={MUTED}>{' · '}</Text>,
        <Text key="time" color={isRunning ? YELLOW : TIME}>
          {timeCell((a.endedAt ?? at) - a.startedAt)}
        </Text>,
      ])
    }

    // ⠋ Explore · Haiku 5.5 · low          │ ≈$0.01 · 42s
    //   find callers of scrollToTop
    //   Ctx: ▰▱▱▱▱▱▱▱▱▱ 12% · 120k tok · ≈$0.05
    const agentCard = (a: AgentRun) => {
      return (
        <Box key={a.id} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Button key={agentKey(a.id)} plain onPress={() => openAgent(a.id)}>
              <Text color={MUTED}>› </Text>
              <Text color={YELLOW}>{frame}</Text>
              <Text bold color={REQUEST}>{` ${a.type}`}</Text>
              <Text color={MUTED}>{fit(` · ${runModel(a)}`, leftColumns(0) - 4 - a.type.length)}</Text>
            </Button>
            {agentMetrics(a)}
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

    // › ✓ Explore · Haiku 5.5 · low · find callers │ ≈$0.05 · 01:10
    const agentLine = (a: AgentRun) => {
      const model = ` · ${runModel(a)} · `
      const room = leftColumns(0) - 4 - a.type.length - model.length
      return (
        <Box key={a.id} flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Button key={agentKey(a.id)} plain onPress={() => openAgent(a.id)}>
            <Text color={MUTED}>› </Text>
            <Text color={AGENT_COLOR[a.status]}>{AGENT_GLYPH[a.status] ?? '•'}</Text>
            <Text bold color={REQUEST}>{` ${a.type}`}</Text>
            <Text color={MUTED}>{model}</Text>
            <Text color={SUB}>{fit(a.description || '—', room)}</Text>
          </Button>
          {agentMetrics(a)}
        </Box>
      )
    }

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

    // The commands still running in the background, whatever prompt started them: their
    // prompt's row may be folded away long before they end.
    // Background: 1 running
    // ⠋ PowerShell gradlew clean               09:19
    const background = allCalls.filter(c => c.status === 'background')
    const backgroundBlock = background.length > 0 && (
      <Box key="background" flexDirection="column" marginBottom={1}>
        {items('background', [item('bg', 'Background', TIME, `${background.length} running`, YELLOW)])}
        {background.map(c => callRow(c, 'b'))}
      </Box>
    )

    // Newest first: the pane opens at its top.
    const newest = [...mainPrompts].reverse()
    const shownPrompts = v.expanded.includes(allKey('prompts')) ? newest : newest.slice(0, MAX_PROMPTS_SHOWN)
    const hiddenPrompts = newest.length - shownPrompts.length
    // Cache tax: ≈$0.03 · expired: ≈$1.00
    const taxLine = (tax: { warm: number; expired: number }) =>
      items('tax', [
        item('tax', 'Cache tax', COST, `≈${fmtCost(tax.warm)}`),
        item('expired', 'expired', WARN, `≈${fmtCost(tax.expired)}`),
      ])

    // Three lines over a loop's rows, the session's or a subagent's, and the session's
    // cache tax under them:
    // Session: 71 req · 214 tool · 3✗
    // Time: 1:32:10 · Cost: ≈$4.20
    // Token: 8.3M · Out: 42k · Cache hit: 97%
    // Each request sends the conversation again, so the tokens far outgrow the context. The
    // cache hit is the loop's input read from the cache.
    // `tax`: what going on from the main loop's context costs a request: one for the session,
    // whose context every prompt shares.
    const header = (key: string, label: string, t: Totals, tax?: { warm: number; expired: number }) => {
      const cacheHit = t.mainInput > 0 ? Math.round((t.cacheRead / t.mainInput) * 100) : undefined
      return (
        <Box key={key} flexDirection="column" marginBottom={1}>
          {items('count', [
            item('req', label, PROMPT, `${t.requests} req`),
            <Text key="tools" bold color={TOOL}>{`${t.tools} tool`}</Text>,
            t.failed > 0 && <Text key="failed" bold color={ALERT}>{`${t.failed}✗`}</Text>,
          ])}
          {items('spent', [
            item('time', 'Time', TIME, fmtDuration(t.durationMs)),
            item('cost', 'Cost', COST, `≈${fmtCost(t.costUsd)}`),
          ])}
          {t.tokens > 0 &&
            items('tokens', [
              item('tokens', 'Token', CONTEXT, fmtTokens(t.tokens)),
              item('out', 'Out', REQUEST, fmtTokens(t.output)),
              cacheHit !== undefined &&
                item('hit', 'Cache hit', TOOL, `${cacheHit}%`, cacheHit >= 80 ? OK : cacheHit >= 50 ? YELLOW : WARN),
            ])}
          {tax && taxLine(tax)}
        </Box>
      )
    }

    // A subagent's own screen, drawn as the session's list is: its header, then each run of
    // it as a prompt row, newest first, with its requests and their calls. Below them, whole,
    // the task its spawner gave it and the report it handed back. Its time, cost and tokens
    // are the run's own, every request counted even when its turn went unheard.
    // ‹ Back
    // ✓ Explore · Haiku 5.5 · low
    //   find callers
    // Subagent: 3 req · 5 tool
    // Time: 01:10 · Cost: ≈$0.05
    // Token: 120k · Out: 2k · Cache hit: 90%
    // ▾ 10:02 Find every caller of scrollToTop… │ ≈$0.05 · 01:10
    const agentScreen = (a: AgentRun, hasBack: boolean) => {
      const isRead = shownAgentBody?.id === a.id
      const whole = isRead && shownAgentBody.isWhole ? shownAgentBody : undefined
      const prompt = whole ? whole.prompt : a.prompt
      const answer = whole ? (whole.answer ?? a.answer) : a.answer
      const isRunning = a.status === 'running'
      const own = callsOf(a)
      const runs = a.agentId === undefined ? [] : promptList.filter(p => p.agentId === a.agentId)
      // No turn of it heard (its spawn ran inside another hook's): one row stands for the run.
      const rows: Prompt[] = runs.length
        ? [...runs].reverse()
        : [
            {
              turnId: runKey(a.id),
              agentId: a.agentId,
              text: a.prompt ?? a.description,
              startedAt: a.startedAt,
              endedAt: a.endedAt,
              isAborted: a.status === 'failed',
              costUsd: a.costUsd,
            },
          ]
      // Calls made before its turn was heard.
      const loose = runs.length ? own.filter(c => !runs.some(p => p.turnId === c.turnId)) : []
      const children = agentList.filter(x => own.some(c => c.id === x.toolUseId))
      const counted = totalsOf(
        noTotals(''),
        { prompts: runs, steps: a.agentId === undefined ? [] : stepList, calls: own, agents: children },
        at,
        a.agentId,
      )
      const sum = (of: (x: AgentRun) => number) => children.reduce((n, x) => n + of(x), 0)
      const t: Totals = {
        ...counted,
        durationMs: (a.endedAt ?? at) - a.startedAt,
        costUsd: runCost(a),
        tokens: a.tokens + sum(x => x.tokens),
        output: a.output + sum(x => x.output),
      }
      return (
        <Box flexDirection="column">
          {hasBack && <Button key={BACK} label="‹ Back" plain onPress={() => closeAgent(a.id)} />}
          <Box marginTop={hasBack ? 1 : 0} marginBottom={1} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={AGENT_COLOR[a.status]}>{isRunning ? frame : (AGENT_GLYPH[a.status] ?? '•')}</Text>
              <Text bold color={REQUEST}>{` ${a.type}`}</Text>
              <Text color={MUTED}>{` · ${runModel(a)}`}</Text>
            </Text>
            {a.description && (
              <Box marginLeft={2}>
                <Text color={SUB} wrap="truncate-end">
                  {a.description}
                </Text>
              </Box>
            )}
          </Box>
          {header('agent', 'Subagent', t)}
          {rows.map(p => promptBlock(p, runs.length ? undefined : own))}
          {loose.length > 0 && callList(`l:${a.id}`, loose)}
          {isRead && !whole && prompt !== undefined && (
            <Box marginTop={1}>
              <Text color={WARN} wrap="wrap">
                Only the first lines are shown: the subagent's files could not be read.
              </Text>
            </Box>
          )}
          {prompt ? (
            excerptBlock('prompt', 'Prompt', prompt, SUB)
          ) : (
            <Box marginTop={1}>
              <Text color={MUTED} wrap="wrap">
                Prompt: not kept; the subagent started before this version of the mod loaded.
              </Text>
            </Box>
          )}
          {answer ? (
            excerptBlock('answer', 'Answer', answer, a.status === 'failed' ? ALERT : undefined)
          ) : (
            <Box marginTop={1}>
              <Text color={MUTED} wrap="wrap">
                {isRunning ? 'Answer: still running; its report shows here once it ends.' : 'Answer: none kept.'}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    const detailed = v.detail !== undefined ? allCalls.find(c => c.id === v.detail) : undefined
    if (detailed) return detailScreen(detailed)
    const opened = v.agent !== undefined ? agentList.find(a => a.id === v.agent) : undefined
    if (opened) return agentScreen(opened, true)

    // A subagent's transcript in view: its own screen, with no way back to the session's.
    const viewed = e.props.view.agentId
    if (viewed !== undefined) {
      const run = agentList.find(a => a.agentId === viewed)
      if (run) return agentScreen(run, false)
      const own = allCalls.filter(c => c.agentId === viewed)
      return (
        <Box flexDirection="column">
          <Text bold color={REQUEST}>
            Subagent
          </Text>
          <Box marginTop={1} flexDirection="column">
            {own.length ? callList('own', own) : <Text color={MUTED}>No tool calls yet.</Text>}
          </Box>
        </Box>
      )
    }

    // Over the prompts kept, and what a resumed session showed before this process.
    const before = (await read($, carried)) ?? noTotals('')
    const t = totalsOf(before, { prompts: promptList, steps: stepList, calls: allCalls, agents: agentList }, at)
    // Going on from the main loop's context now: its last answered request's.
    const current = stepList.findLast(s => s.agentId === undefined && s.input !== undefined)
    const tax = current?.input !== undefined ? cacheTaxOf(current.model, current.input + (current.output ?? 0)) : undefined
    const session =
      (mainPrompts.length > 0 || before.prompts > 0 || before.tools > 0) && header('session', 'Session', t, tax)

    return (
      <Box flexDirection="column" paddingX={1}>
        {session}
        {backgroundBlock}
        {subagents}
        {mainPrompts.length === 0 && before.prompts === 0 && <Text color={MUTED}>No prompts yet: send one to start.</Text>}
        {shownPrompts.flatMap((p, i) => {
          // Newest first: a rule names the day of the prompts below it, where it changes.
          const above = i === 0 ? at : shownPrompts[i - 1]!.startedAt
          if (dayOf(p.startedAt) === dayOf(above)) return [promptBlock(p)]
          const day = `── ${fmtDay(p.startedAt)} `
          return [
            <Text key={`day:${p.turnId}`} wrap="truncate-end">
              <Text color={RULE}>── </Text>
              <Text color={MUTED}>{fmtDay(p.startedAt)}</Text>
              <Text color={RULE}>{` ${'─'.repeat(Math.max(0, cols - day.length))}`}</Text>
            </Text>,
            promptBlock(p),
          ]
        })}
        {hiddenPrompts > 0 && unfold('prompts', `… ${hiddenPrompts} older prompts`)}
        {before.prompts > 0 && (
          <Text key="before" color={MUTED}>{`… ${before.prompts} prompts before the resume, counted above, not listed`}</Text>
        )}
        {mainPrompts.length > 0 && (
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
