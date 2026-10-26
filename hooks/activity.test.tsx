import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-band',
  component: 'Pane',
  requestId: 'activity',
  props: {
    title: 'Activity',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const USAGE = {
  input_tokens: 200,
  output_tokens: 300,
  cache_read_input_tokens: 40_000,
  cache_creation_input_tokens: 800,
  model: 'claude-opus-5-5',
}

test('a prompt lists its request, and the request its tool calls, on every surface', async ($, on) => {
  // Nothing sits beneath the plugin: each hook here stands for the engine.
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [{ name: 'Read', input: { file_path: 'src/app/App.tsx' } }],
      stopReason: 'tool_use' as const,
      usage: USAGE,
    }
  })
  on('tool.call', () => ({ result: {}, text: 'file body' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'fix the scroll' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // drained: the step ends with its result
  }
  await stream.result
  await $.tool.call({ tool: 'Read', file_path: 'C:/repo/src/app/App.tsx' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer', usage: USAGE })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Req:\s1\s·\sTool:\s1/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /^▾ \d{2}:\d{2} fix the scroll$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^── \d{2}\/\d{2} ─/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /In:\s41k\s·\sOut:\s300/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /App\.tsx/ })).toBeDefined()
    await ui.unmount()
  }

  // Every call opens its own screen, on what it was given and what it answered; Back
  // returns to the list.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /file body/ })).toBeUndefined()
  const readKey = (await ui.find({ type: 'Button', text: /App\.tsx/ }))?.key
  expect(readKey).toBeDefined()
  await ui.press({ key: readKey! })
  expect(await ui.find({ type: 'Text', text: /"file_path": "C:\/repo\/src\/app\/App\.tsx"/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^file body$/m })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Req:\s1/ })).toBeUndefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /file body/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Req:\s1/ })).toBeDefined()
  await ui.unmount()
})

test("a resumed session's header goes on from its saved figures; its rows are only counted", async ($, on) => {
  mock.clock(on)
  const store = new Map<string, unknown>()
  store.set('totals:sess-1', {
    sessionId: 'sess-1',
    prompts: 3,
    requests: 5,
    tools: 7,
    failed: 1,
    durationMs: 60_000,
    costUsd: 1,
    tokens: 50_000,
    output: 1000,
    mainInput: 40_000,
    cacheRead: 30_000,
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [{ name: 'Read', input: { file_path: 'src/app/App.tsx' } }],
      stopReason: 'tool_use' as const,
      usage: USAGE,
    }
  })
  on('tool.call', () => ({ result: {}, text: 'file body' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Session:\s5\sreq\s·\s7\stool\s·\s1✗/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3 prompts before the resume/ })).toBeDefined()
  await ui.unmount()

  await $.turn.start({ turnId: 't1', text: 'fix the scroll' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // drained: the step ends with its result
  }
  await stream.result
  await $.tool.call({ tool: 'Read', file_path: 'C:/repo/src/app/App.tsx' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer', usage: USAGE })

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Session:\s6\sreq\s·\s8\stool\s·\s1✗/ })).toBeDefined()
  await ui.unmount()
  // Saved at the answer: a later resume goes on from these.
  expect(store.get('totals:sess-1')).toMatchObject({ prompts: 4, requests: 6, tools: 8, failed: 1 })

  // A resume in this process: the pane starts over until the next session's figures are read.
  await $.session.end({ reason: 'resume', sessionId: 'sess-1', resume: { id: 'sess-1' } } as Parameters<
    typeof $.session.end
  >[0])
  expect(store.get('totals:sess-1')).toMatchObject({ prompts: 4, requests: 6 })
})

test('a rule names the day where the prompts listed cross midnight', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const ask = async (turnId: string) => {
    await $.turn.start({ turnId, text: turnId })
    await $.turn.complete({ turnId, answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
  }

  await ask('yesterday')
  // No session started: no timer runs on the way to the next day.
  await clock.set(clock.now() + 24 * 60 * 60_000)
  await ask('today')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const pad = (n: number) => String(n).padStart(2, '0')
  const before = new Date(clock.now() - 24 * 60 * 60_000)
  const day = `${pad(before.getDate())}/${pad(before.getMonth() + 1)}`
  expect(await ui.find({ type: 'Text', text: new RegExp(`^── ${escapeRe(day)} ─+$`) })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^▾ \d{2}:\d{2} today$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^▸ \d{2}:\d{2} yesterday$/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent shows as a card while it runs', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'find callers',
    description: 'find callers',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Explore/ })).toBeDefined()
    await ui.unmount()
  }
})

test("a subagent's row opens its screen: the prompt it was given, its calls and its answer", async ($, on) => {
  mock.clock(on)
  const files = new Map<string, string>()
  on('session.id', () => ({ value: 's1' }))
  on('env.get', (_, e) => ({ value: e.name === 'TEMP' ? 'C:\\tmp' : undefined }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('tool.call', () => ({ result: {}, text: 'src/a.ts:3' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'Find every caller of scrollToTop.\nReport the files and lines.',
    description: 'find callers',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  await $.tool.call({ tool: 'Grep', pattern: 'scrollToTop', agentId: 'a1' } as Parameters<typeof $.tool.call>[0])

  // Opened while it runs: its prompt, its call, and no answer yet.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'g:a1' })
  expect(await ui.find({ type: 'Text', text: /^Report the files and lines\.$/m })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Grep scrollToTop/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /still running/ })).toBeDefined()

  // Its run ends: the screen left open gets the whole report, past the lines the state keeps.
  const report = ['Callers:', 'src/a.ts:3', 'src/b.ts:9', 'src/c.ts:12', 'src/d.ts:20'].join('\n')
  await $.turn.complete({ turnId: 's1', agentId: 'a1', answer: report, durationMs: 1000, isAborted: false, reason: 'answer' })
  expect(await ui.find({ type: 'Text', text: /^src\/d\.ts:20$/m })).toBeDefined()

  // A call opened from it goes back to it; its Back lands on the list.
  const grepKey = (await ui.find({ type: 'Button', text: /Grep scrollToTop/ }))?.key
  await ui.press({ key: grepKey! })
  expect(await ui.find({ type: 'Text', text: /"pattern": "scrollToTop"/ })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /^Report the files and lines\.$/m })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /1 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Report the files/ })).toBeUndefined()
  await ui.unmount()
})

test("a subagent's screen is drawn as the session's list: its header, its runs, their requests", async ($, on) => {
  mock.clock(on)
  // Its task and report on disk, held in memory.
  const files = new Map<string, string>()
  on('session.id', () => ({ value: 's1' }))
  on('env.get', (_, e) => ({ value: e.name === 'TEMP' ? 'C:\tmp' : undefined }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [{ name: 'Grep', input: { pattern: 'scrollToTop' } }],
      stopReason: 'tool_use' as const,
      usage: USAGE,
    }
  })
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('tool.call', () => ({ result: {}, text: 'src/a.ts:3' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'find callers' })
  const main = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, effort: 'high' })
  for await (const _ of main) {
    // drained
  }
  await main.result
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'Find every caller of scrollToTop.',
    description: 'find callers',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  // The subagent's run: one request, one call, then its report.
  await $.turn.start({ turnId: 's1', text: 'Find every caller of scrollToTop.', agentId: 'a1' })
  const sub = $.turn.step({ turnId: 's1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1', effort: 'low' })
  for await (const _ of sub) {
    // drained
  }
  await sub.result
  await $.tool.call({ tool: 'Grep', pattern: 'scrollToTop', agentId: 'a1' } as Parameters<typeof $.tool.call>[0])
  await $.turn.complete({ turnId: 's1', agentId: 'a1', answer: 'src/a.ts:3', durationMs: 1000, isAborted: false, reason: 'answer', usage: USAGE })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer', usage: USAGE })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 100 } })
  // The session counts its own request; the subagent's run is no prompt of its list.
  expect(await ui.find({ type: 'Text', text: /Session:\s1\sreq\s·\s0\stool/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Find every caller/ })).toBeUndefined()
  // Its row names its model (USAGE names Opus 5.5) and effort, with its cost and time in the
  // figures' column.
  expect(await ui.find({ type: 'Button', text: /✓ Explore · Opus 5\.5 · low · find callers$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^≈\$0\.02\s·\s{4}0s$/ })).toBeDefined()
  // The main loop's request names its own.
  expect(await ui.find({ type: 'Text', text: /Model:\sOpus 5\.5\s·\shigh/ })).toBeDefined()

  await ui.press({ key: 'g:a1' })
  expect(await ui.find({ type: 'Text', text: /Subagent:\s1\sreq\s·\s1\stool/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Time:\s0s\s·\sCost:\s≈\$0\.02/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Token:\s41k\s·\sOut:\s300\s·\sCache hit:\s98%/ })).toBeDefined()
  // Its run opens as the session's newest prompt does, on its numbered request.
  expect(await ui.find({ type: 'Button', text: /▾ \d{2}:\d{2} Find every caller of scrollToTop\.$/ })).toBeDefined()
  const request = await ui.find({ type: 'Button', text: /^▸ #1 1× Grep$/ })
  expect(request).toBeDefined()
  await ui.press({ key: request!.key! })
  expect(await ui.find({ type: 'Text', text: /Model:\sOpus 5\.5\s·\slow/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Grep scrollToTop/ })).toBeDefined()
  await ui.unmount()
})

const BAND = {
  plugin: 'session-band',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('the band keeps its rows and its button opens the pane, on every surface', async ($, on) => {
  mock.clock(on)
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Context:/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h limit/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /☰/ })).toBeDefined()
    await ui.unmount()
  }

  // The open state is the session's, shared by every surface: pressed once.
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'detail' })
  // Open, the same icon turns green.
  expect((await ui.find({ type: 'Text', text: /☰/ }))?.props.color).toBe('#a6e3a1')
  await ui.unmount()
})

test('an Agent call opens on its subagent, whose cost the prompt adds', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: USAGE }
  })
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  // The Agent tool spawns its subagent, which greps and makes one request.
  on('tool.call', async (_, e) => {
    if (e.tool === 'Agent') {
      await $.agent.spawn({
        tool_use_id: e.tool_use_id,
        prompt: 'find callers',
        description: 'find callers',
        subagentType: 'Explore',
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'claude-opus-5-5',
        background: false,
        fork: false,
      })
      await $.tool.call({ tool: 'Grep', pattern: 'scrollToTop', agentId: 'a1' } as Parameters<typeof $.tool.call>[0])
      const sub = $.turn.step({ turnId: 's1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' })
      for await (const _ of sub) {
        // drained
      }
      await sub.result
    }
    return { result: {}, text: 'done' }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'find callers' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // drained
  }
  await stream.result
  await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'find callers', prompt: 'find callers' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer', usage: USAGE })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The prompt's row: the main turn ($0.0212) and the subagent's request, which USAGE names
  // Opus 5.5 too ($0.0212), together, then its time padded to the column's width.
  expect(await ui.find({ type: 'Text', text: /^≈\$0\.04\s·\s{4}0s$/ })).toBeDefined()
  // Its summary: the context it left.
  expect(await ui.find({ type: 'Text', text: /Req:\s1\s·\sTool:\s1\s·\sContext:\s41k/ })).toBeDefined()
  const agentKey = (await ui.find({ type: 'Button', text: /Agent/ }))?.key
  expect(agentKey).toBeDefined()
  await ui.press({ key: agentKey! })
  expect(await ui.find({ type: 'Text', text: /Ctx:/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /scrollToTop/ })).toBeDefined()
  await ui.unmount()
})

test('a cache rewrite is flagged, a failed call opens on its error, and the session sums up', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  // The cache expired: the request reads nothing from it and writes the whole context.
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [{ name: 'Bash', input: { command: 'yarn type-check' } }],
      stopReason: 'tool_use' as const,
      usage: { ...USAGE, cache_read_input_tokens: 0, cache_creation_input_tokens: 40_800 },
    }
  })
  on('tool.call', () => ({ result: {}, isError: true as const, text: 'error TS2345: bad argument\n\nexit code 2' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'type-check' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // drained
  }
  await stream.result
  await $.tool.call({ tool: 'Bash', command: 'yarn type-check' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer', usage: USAGE })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Session:\s1 req\s·\s1 tool\s·\s1✗/ })).toBeDefined()
  // 41k in (none of it from the cache) and 300 out.
  expect(await ui.find({ type: 'Text', text: /Token:\s41k\s·\sOut:\s300\s·\sCache hit:\s0%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚠ cache written again 41k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /error TS2345/ })).toBeUndefined()
  const failedKey = (await ui.find({ type: 'Button', text: /yarn type-check/ }))?.key
  expect(failedKey).toBeDefined()
  await ui.press({ key: failedKey! })
  expect(await ui.find({ type: 'Text', text: /error TS2345/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /exit code 2/ })).toBeDefined()
  await ui.unmount()
})

test('a failed call whose output carries escape sequences still opens on its error', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [{ name: 'Bash', input: { command: 'npx skills --help' } }],
      stopReason: 'tool_use' as const,
      usage: USAGE,
    }
  })
  // Colours, a terminal link (OSC 8), a tab and a progress line redrawn with \r.
  on('tool.call', () => ({
    result: {},
    isError: true as const,
    text: 'Exit code 255\n\x1b[1mUsage:\x1b[0m skills <command>\r\n\x1b]8;;https://x.dev\x07docs\x1b]8;;\x07 and\tadd <package>\n10%\r100%',
  }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'install' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // drained
  }
  await stream.result
  await $.tool.call({ tool: 'Bash', command: 'npx skills --help' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer', usage: USAGE })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const failedKey = (await ui.find({ type: 'Button', text: /npx skills --help/ }))?.key
  expect(failedKey).toBeDefined()
  await ui.press({ key: failedKey! })
  expect(await ui.find({ type: 'Text', text: /^Usage: skills <command>$/m })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^docs and add <package>$/m })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^100%$/m })).toBeDefined()
  await ui.unmount()
})

test('an error stored with escape sequences by an earlier version still opens', async ($, on) => {
  mock.clock(on)
  // What the code before the fix wrote stays through the reload.
  on('state.get', { plugin: 'session-band', key: 'calls' }, () => ({
    value: {
      version: 1,
      value: {
        shape: 'calls-1',
        value: [
          {
            id: 'c1',
            tool: 'PowerShell',
            target: 'npx skills --help',
            turnId: 't1',
            status: 'error',
            startedAt: 0,
            endedAt: 1000,
            resultChars: 40,
            error: 'Exit code 255\n\x1b[1mUsage:\x1b[0m skills <command>',
          },
        ],
      },
    },
  }))
  on('state.get', { plugin: 'session-band', key: 'prompts' }, () => ({
    value: {
      version: 1,
      value: {
        shape: 'prompts-1',
        value: [{ turnId: 't1', text: 'install', startedAt: 0, endedAt: 1000, isAborted: false, costUsd: 0 }],
      },
    },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 't1' })
  await ui.press({ key: 'a:c1' })
  expect(await ui.find({ type: 'Text', text: /^Usage: skills <command>$/m })).toBeDefined()
  await ui.unmount()
})

test("a call's screen holds its whole input and output, past the lines the list keeps", async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [{ name: 'Grep', input: { pattern: 'x' } }],
      stopReason: 'tool_use' as const,
      usage: USAGE,
    }
  })
  // The call's file: the session's folder under TEMP, held in memory.
  const files = new Map<string, string>()
  on('session.id', () => ({ value: 's1' }))
  on('env.get', (_, e) => ({ value: e.name === 'TEMP' ? 'C:\\tmp' : undefined }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  const lines = Array.from({ length: 60 }, (_, i) => `match ${i + 1}`)
  on('tool.call', () => ({ result: {}, text: lines.join('\n') }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'search' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // drained
  }
  await stream.result
  const pattern = 'const targetOf|MAX_CALLS =|e\\.tool_use_id|ENVELOPE|const toolName'.repeat(3)
  await $.tool.call({ tool: 'Grep', pattern, output_mode: 'content' } as Parameters<typeof $.tool.call>[0])
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer', usage: USAGE })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The call's row, not its request's (#1 1× Grep).
  const key = (await ui.find({ type: 'Button', text: /✓ Grep/ }))?.key
  expect(key).toBeDefined()
  await ui.press({ key: key! })
  expect(await ui.find({ type: 'Text', text: new RegExp(escapeRe(`  "pattern": ${JSON.stringify(pattern)},`)) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^match 60$/m })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Only the first lines/ })).toBeUndefined()
  await ui.unmount()
})

// Each tool's input and answer as the session hands them over, with the texts a pane
// cannot draw as they are: tabs, ANSI colours, a bell, an image's base64, no text at all.
const TOOL_CASES = [
  {
    args: { tool: 'Read', file_path: 'C:/probe/tool-probe.txt' },
    row: /Read tool-probe\.txt/,
    answer: { result: {}, text: '1\tline one\n2\ttiếng Việt có dấu 🙂\n3\t\ttab-indented line' },
    shows: [/"file_path": "C:\/probe\/tool-probe\.txt"/, /^2 tiếng Việt có dấu 🙂$/m, /^3  tab-indented line$/m],
  },
  {
    args: { tool: 'Read', file_path: 'C:/probe/shot.png' },
    row: /Read shot\.png/,
    answer: { result: { type: 'image', file: { base64: 'iVBORw0KGgo'.repeat(400), type: 'image/png' } }, text: '' },
    shows: [/Out \(no text/, /"base64": "<4400 characters of base64 data>"/, /"type": "image\/png"/],
  },
  {
    args: { tool: 'ToolSearch', query: 'select:WebSearch', max_results: 1 },
    row: /ToolSearch select:WebSearch/,
    answer: { result: { matches: ['WebSearch'], query: 'select:WebSearch' }, text: '' },
    shows: [/Out \(no text/, /^\s*"WebSearch"$/m],
  },
  {
    // The command as written to copy, then what changes its run; never its description.
    args: { tool: 'Bash', command: "printf 'bash ok\\n\\033[32mgreen\\033[0m\\n'", description: 'Print', timeout: 5000 },
    row: /Bash printf/,
    // Colours, a bell, a terminal link (OSC 8) and a progress line redrawn with \r.
    answer: {
      result: {},
      text: 'bash ok\n\x1b[32mgreen\x1b[0m\x07\n\x1b]8;;https://x.dev\x07link\x1b]8;;\x07\n10%\r50%\r100%',
    },
    shows: [
      /^printf 'bash ok\\n\\033\[32mgreen\\033\[0m\\n'\n\n\{\n {2}"timeout": 5000\n\}$/,
      /^green$/m,
      /^link$/m,
      /^100%$/m,
    ],
  },
  {
    args: { tool: 'Edit', file_path: 'C:/probe/a.ts', old_string: 'const a = 1\nconst b = 2', new_string: 'const a = 3' },
    row: /Edit a\.ts/,
    answer: { result: {}, text: 'The file C:/probe/a.ts has been updated successfully.' },
    shows: [/"old_string": "const a = 1\\nconst b = 2"/, /has been updated successfully/],
  },
  {
    args: { tool: 'WebFetch', url: 'https://example.com', prompt: 'What is the title?' },
    row: /WebFetch https:\/\/example\.com/,
    answer: { result: {}, text: '**Page title:** "Example Domain"' },
    shows: [/"prompt": "What is the title\?"/, /Example Domain/],
  },
  {
    args: { tool: 'WebSearch', query: 'Claude Code plugins', mode: 'standard' },
    row: /WebSearch Claude Code plugins/,
    answer: { result: {}, text: 'Web search results for query: "Claude Code plugins"\n\nLinks: [{"title":"Plugins"}]' },
    shows: [/"mode": "standard"/, /^Links: \[\{"title":"Plugins"\}\]$/m],
  },
  {
    args: { tool: 'Glob', pattern: 'hooks/*.tsx', path: 'C:/mod' },
    row: /Glob hooks\/\*\.tsx/,
    answer: { result: {}, text: 'C:/mod/hooks/register.tsx\nC:/mod/hooks/activity.tsx' },
    shows: [/"pattern": "hooks\/\*\.tsx"/, /^C:\/mod\/hooks\/activity\.tsx$/m],
  },
  {
    args: { tool: 'Grep', pattern: 'const BODY_ROOT', path: 'C:/mod/hooks', output_mode: 'content', '-n': true },
    row: /Grep const BODY_ROOT/,
    answer: { result: {}, text: "activity.tsx:292:const BODY_ROOT = 'session-band'" },
    shows: [/"-n": true/, /^activity\.tsx:292:const BODY_ROOT = 'session-band'$/m],
  },
  {
    args: { tool: 'mcp__claude_ai_Claude_Docs__guide', items: ['topic.index'] },
    row: /guide/,
    // Past what a pane draws: the screen ends on how much is left and the file that holds it.
    answer: { result: {}, text: `# topic.index\n${'Docs are living documents.\n'.repeat(5000)}` },
    shows: [/^\s*"topic\.index"$/m, /^# topic\.index$/m, /^… \d+ more characters, whole in .+\/session-band\/s1\/.+\.json$/m],
  },
  {
    args: { tool: 'Write', file_path: 'C:/probe/denied.txt', content: 'x' },
    row: /Write denied\.txt/,
    answer: { deny: 'Permission to write denied.txt was refused' },
    shows: [/Status: denied/, /^Permission to write denied\.txt was refused$/m],
  },
] as const

test('every kind of tool opens on its whole input and output', async ($, on) => {
  mock.clock(on)
  const files = new Map<string, string>()
  on('session.id', () => ({ value: 's1' }))
  on('env.get', (_, e) => ({ value: e.name === 'TEMP' ? 'C:\\tmp' : undefined }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // The case whose every argument the call carries.
  on('tool.call', (_, e) => {
    const args = e as unknown as Record<string, unknown>
    const found = TOOL_CASES.find(c => Object.entries(c.args).every(([k, v]) => JSON.stringify(args[k]) === JSON.stringify(v)))
    if (!found) throw new Error(`no case for ${e.tool}`)
    return found.answer as never
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'every tool' })
  for (const c of TOOL_CASES) await $.tool.call(c.args as unknown as Parameters<typeof $.tool.call>[0])
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const c of TOOL_CASES) {
      const key = (await ui.find({ type: 'Button', text: c.row }))?.key
      expect({ tool: c.args.tool, key }).toEqual({ tool: c.args.tool, key: expect.any(String) })
      await ui.press({ key: key! })
      for (const shown of c.shows) {
        expect({ tool: c.args.tool, shown: String(shown), found: Boolean(await ui.find({ type: 'Text', text: shown })) }).toEqual({
          tool: c.args.tool,
          shown: String(shown),
          found: true,
        })
      }
      await ui.press({ key: 'back' })
    }
    await ui.unmount()
  }
})

// What each OS sets: Windows TEMP and TMP, macOS a TMPDIR ending in a slash, Linux often none.
const OS_ENVS = [
  {
    os: 'windows',
    env: { OS: 'Windows_NT', TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp', TMP: 'C:\\Users\\me\\AppData\\Local\\Temp' },
    dir: 'C:/Users/me/AppData/Local/Temp',
  },
  { os: 'macos', env: { TMPDIR: '/var/folders/x1/abc/T/' }, dir: '/var/folders/x1/abc/T' },
  // Linux's /tmp is every user's: the user's runtime folder first, then their cache.
  { os: 'linux', env: { HOME: '/home/me', XDG_RUNTIME_DIR: '/run/user/1000' }, dir: '/run/user/1000' },
  { os: 'linux without a runtime folder', env: { HOME: '/home/me' }, dir: '/home/me/.cache' },
  { os: 'a system with no folder set', env: {}, dir: '/tmp' },
] as const

for (const { os, env, dir } of OS_ENVS) {
  test(`a call's file goes in the temporary folder on ${os}`, async ($, on) => {
    mock.clock(on)
    const files = new Map<string, string>()
    on('session.id', () => ({ value: 'sess-1' }))
    on('env.get', (_, e) => ({ value: (env as Record<string, string>)[e.name] }))
    on('fs.write', (_, e) => {
      files.set(e.path, e.text)
      return { value: undefined }
    })
    on('fs.read', (_, e) => {
      const text = files.get(e.path)
      if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
      return { value: text }
    })
    on('tool.call', () => ({ result: {}, text: 'line 1\nline 2' }))

    await $.tool.call({ tool: 'Bash', command: 'echo "a b" | wc -w' })

    // The engine resolves the path on the OS the test runs on: on Windows `/tmp` is `C:\tmp`.
    // Beside the call's file, the folder's alive mark.
    const written = [...files.entries()].map(([p, text]) => [p.replace(/\\/g, '/'), text] as const)
    const drive = /^[A-Za-z]:/.test(dir) ? '' : '(?:[A-Za-z]:)?'
    const folder = `^${drive}${escapeRe(dir)}/session-band/sess-1/`
    expect(written.map(([p]) => p.split('/').at(-1)?.replace(/^[\w-]+\.json$/, '<call>.json')).sort()).toEqual([
      '<call>.json',
      'alive',
    ])
    for (const [p] of written) expect(p).toMatch(new RegExp(folder))
    const [, text] = written.find(([p]) => p.endsWith('.json')) ?? []
    const kept = JSON.parse(text ?? '{}') as { input?: string; output?: string }
    expect(kept.input).toBe('echo "a b" | wc -w')
    expect(kept.output).toBe('line 1\nline 2')
  })

  test(`only the files of calls still in view are kept, on ${os}`, async ($, on) => {
    const clock = mock.clock(on)
    // A temporary folder in memory, keyed by the mod's own spelling: the engine resolves a
    // path on the OS the test runs on (on Windows `/tmp` is `C:\tmp`), so the drive goes.
    const native = /^[A-Za-z]:/.test(dir)
    const norm = (p: string) => {
      const slashed = p.replace(/\\/g, '/')
      return native ? slashed : slashed.replace(/^[A-Za-z]:(?=\/)/, '')
    }
    const files = new Map<string, string>()
    const removed: string[][] = []
    on('session.id', () => ({ value: 'sess-1' }))
    on('env.get', (_, e) => ({ value: (env as Record<string, string>)[e.name] }))
    on('fs.write', (_, e) => {
      files.set(norm(e.path), e.text)
      return { value: undefined }
    })
    on('fs.read', (_, e) => {
      const text = files.get(norm(e.path))
      if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
      return { value: text }
    })
    on('fs.list', (_, e) => {
      const parent = norm(e.path)
      const names = new Set([...files.keys()].filter(p => p.startsWith(`${parent}/`)).map(p => p.slice(parent.length + 1).split('/')[0]!))
      return {
        value: [...names].map(name => ({
          name,
          kind: files.has(`${parent}/${name}`) ? ('file' as const) : ('dir' as const),
          size: 0,
          mtimeMs: 0,
          isLink: false,
        })),
      }
    })
    on('process.run', (_, e) => {
      removed.push([...e.argv])
      const target = norm(e.argv.at(-1)!)
      for (const p of [...files.keys()]) if (p.startsWith(`${target}/`)) files.delete(p)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: { command: 'activity' } }))
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    on('tool.call', () => ({ result: {}, text: 'done' }))
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    on('agent.spawn', (_, e) => ({ model: 'claude-haiku-5-5', agentId: `a-${e.tool_use_id}` }))
    // A subagent's run: its task and report go to files in the session's folder.
    const runAgent = async (id: string) => {
      const agentId = `a-${id}`
      await $.agent.spawn({
        tool_use_id: id,
        prompt: 'find callers',
        description: 'find callers',
        subagentType: 'Explore',
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'claude-opus-5-5',
        background: true,
        fork: false,
      })
      await $.turn.start({ turnId: `s-${id}`, text: 'find callers', agentId })
      await $.tool.call({ tool: 'Grep', pattern: 'x', agentId } as Parameters<typeof $.tool.call>[0])
      await $.turn.complete({ turnId: `s-${id}`, agentId, answer: 'two callers', durationMs: 1, isAborted: false, reason: 'answer' })
    }

    const root = `${dir}/session-band`
    const now = clock.now()
    // A session that ended long ago, one that still runs in another window, one whose end
    // marked it but could not remove it, and a file of another app's beside the mod's folder.
    files.set(`${root}/gone/a.json`, '{}')
    files.set(`${root}/gone/alive`, String(now - 60 * 60_000))
    files.set(`${root}/live/b.json`, '{}')
    files.set(`${root}/live/alive`, String(now - 60_000))
    files.set(`${root}/ended/c.json`, '{}')
    files.set(`${root}/ended/alive`, '0')
    files.set(`${dir}/other-app/d.txt`, 'kept')
    // This session's own, from before a resume in a new process: the pane shows none of it.
    files.set(`${root}/sess-1/old.json`, '{}')

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const rm = (name: string) =>
      os === 'windows'
        ? ['cmd', '/c', 'rmdir', '/s', '/q', `${root}/${name}`.replace(/\//g, '\\')]
        : ['rm', '-rf', '--', `${root}/${name}`]
    expect(removed).toEqual(expect.arrayContaining([rm('gone'), rm('ended'), rm('sess-1')]))
    expect(removed).toHaveLength(3)
    expect(files.has(`${root}/live/b.json`)).toBe(true)
    expect(files.has(`${dir}/other-app/d.txt`)).toBe(true)
    // This session marks its own folder alive.
    expect(files.has(`${root}/sess-1/alive`)).toBe(true)

    // A /clear: the pane starts over and the folder goes with what it showed, a subagent's
    // task, report and rows with it.
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await runAgent('tu1')
    expect([...files.keys()].some(p => p.startsWith(`${root}/sess-1/toolu`))).toBe(true)
    expect(files.has(`${root}/sess-1/agent-a-tu1-prompt.json`)).toBe(true)
    expect(files.has(`${root}/sess-1/agent-a-tu1-answer.json`)).toBe(true)
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } } as Parameters<
      typeof $.session.end
    >[0])
    expect(removed.at(-1)).toEqual(rm('sess-1'))
    expect([...files.keys()].some(p => p.startsWith(`${root}/sess-1/`))).toBe(false)
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Button', text: /Bash/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: /Explore/ })).toBeUndefined()
    await ui.unmount()

    // A /resume after it: the same again.
    await runAgent('tu2')
    expect(files.has(`${root}/sess-1/agent-a-tu2-answer.json`)).toBe(true)
    await $.session.end({ reason: 'resume', sessionId: 'sess-1', resume: { id: 'sess-1' } } as Parameters<
      typeof $.session.end
    >[0])
    expect(removed.at(-1)).toEqual(rm('sess-1'))
    expect([...files.keys()].some(p => p.startsWith(`${root}/sess-1/`))).toBe(false)
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Button', text: /Explore/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Subagent:/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('the folded older prompts open when pressed', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 1; i <= 16; i++) {
    await $.turn.start({ turnId: `t${i}`, text: `prompt number ${i}` })
    await $.turn.complete({ turnId: `t${i}`, answer: '', durationMs: 10, isAborted: false, reason: 'answer' })
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /prompt number 1$/ })).toBeUndefined()
  await ui.press({ key: 'all:prompts' })
  expect(await ui.find({ type: 'Button', text: /prompt number 1$/ })).toBeDefined()
  // One button closes the pane's list: Collapse all; no follow toggle.
  expect((await ui.find({ type: 'Button', text: /Collapse all/ }))?.key).toBe('collapse')
  expect(await ui.find({ type: 'Button', text: /follow/ })).toBeUndefined()
  await ui.unmount()
})

test('a shell moved to the background runs on under Background until its notification ends it', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' },
    text: 'Command running in background with ID: bg1',
  }))

  // A started session ticks the clocks of what still runs.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'build it' })
  await $.tool.call({ tool: 'PowerShell', command: './gradlew clean', run_in_background: true })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
  await clock.set(clock.now() + 6 * 60_000)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Background:\s1 running/ })).toBeDefined()
  expect((await ui.find({ type: 'Button', text: /gradlew clean/ }))?.key).toMatch(/^b:/)
  expect(await ui.find({ type: 'Text', text: /06:00/ })).toBeDefined()
  await ui.unmount()

  const notification = [
    '<task-notification>',
    '<task-id>bg1</task-id>',
    '<tool-use-id>toolu_unknown</tool-use-id>',
    '<status>completed</status>',
    '<summary>Background command "gradlew clean" completed (exit code 0)</summary>',
    '</task-notification>',
  ].join('\n')
  await $.prompt.submit({ text: notification, origin: { kind: 'task-notification' }, wait: false, isMeta: true })
  await $.turn.start({ turnId: 't2', text: notification })

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Background:/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /\d{2}:\d{2} Background command "gradlew/})).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /task-notification/ })).toBeUndefined()
  await ui.unmount()
})
