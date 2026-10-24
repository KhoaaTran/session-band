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
    expect(await ui.find({ type: 'Text', text: /In:\s41k\s·\sOut:\s300/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /App\.tsx/ })).toBeDefined()
    await ui.unmount()
  }
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
