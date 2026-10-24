import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cache, Limit, Stats, Usage } from '../types'
import {
  activityStepEnd,
  activityStepStart,
  activityTurnComplete,
  activityTurnStart,
  registerActivity,
  startActivity,
  togglePane,
} from './activity.tsx'

// Adapted from JohnnyVizz/claude-kit session-band. Draws the band above the prompt in two
// rows: turn, prompt cache countdown and speed beside the 5h limit; context beside the weekly
// limit, the limits as Codex writes them. The status line, ../statusline.js, keeps one line
// (model, cwd, title) and relays what this API lacks (the native prompt_cache deadline, the
// turn count from the transcript) through a temp file. Context and limits come from
// $.session.usage(), the status line's own figures. It measures output speed itself, and
// notifies as the prompt cache runs out. The button beside Context opens the full view, the
// activity pane (hooks/activity.tsx).

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

// The activity pane is open (hooks/activity.tsx writes it): the button's label.
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
    // thinking that streams hidden or in one late burst is still timed.
    let startedAt: number | null = null

    try {
      for await (const chunk of stream) {
        if (isMain && startedAt === null) {
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
