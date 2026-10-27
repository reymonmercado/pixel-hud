import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pixel-hud',
  component: 'Pane',
  requestId: 'pixel-hud',
  props: {
    title: 'Pixel HUD',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the pane shows a task, its plan and a subagent, on every surface', async ($, on) => {
  let usd = 0.1
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2030-01-01T00:00:00Z' }, { kind: 'seven_day', percentUsed: 75 }], cost: { usd } } }))
  let t = 1_000_000
  on('clock.now', () => ({ value: (t += 5000) }))
  on('clock.every', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Build the thing', turnId: 't1' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read code', status: 'completed', activeForm: 'Reading code' },
      { content: 'Write code', status: 'in_progress', activeForm: 'Writing code' },
    ],
  } as never)
  await $.agent.spawn({ tool_use_id: 'u1', prompt: 'look', description: 'Search the repo', subagentType: 'Explore' } as never)
  usd = 0.35
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 's1', agentId: 'a1', reason: 'answer' } as never)

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /Search the repo/ }))?.text).toContain('✓')
  expect(await term.find({ type: 'Text', text: /Writing code/ })).toBeTruthy()
  expect((await term.find({ type: 'Text', text: /^\$0\.25$/ }))?.text).toBe('$0.25')
  expect((await term.find({ type: 'Text', text: /^WEEK/ }))?.text).toContain('75%')
  await term.unmount()

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(2)
    await ui.unmount()
  }
})
