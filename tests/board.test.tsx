import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-board',
  component: 'Pane',
  requestId: 'agent-board',
  props: {
    title: 'Agent Board',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('two subagents each get a card with their live activity', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'agent-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++n}` }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'Look at the repo', description: 'Scan repo' })
  await $.agent.spawn({ prompt: 'Write tests', description: 'Write tests' })
  await $.tool.call({ tool: 'Bash', command: 'ls -la', agentId: 'a1' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Scan repo/ }))?.text).toContain('Scan repo')
    expect((await ui.find({ type: 'Text', text: /Write tests/ }))?.text).toContain('Write tests')
    expect((await ui.find({ type: 'Text', text: /Bash ls -la/ }))?.text).toContain('Bash ls -la')
    await ui.unmount()
  }
})

test('the empty board says so', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No subagents yet/ }))?.text).toContain('No subagents')
  await ui.unmount()
})

test('Clear completed removes finished agents and keeps running ones', async ($, on) => {
  const clock = mock.clock(on)
  let live: { id: string; status: string; description: string; type: string }[] = []
  on('agent.list', () => ({ value: live }))
  on('command.register', () => ({ value: { command: 'agent-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  live = [
    { id: 'a1', status: 'running', description: 'Still going', type: 'agent' },
    { id: 'a2', status: 'completed', description: 'All done', type: 'agent' },
    { id: 'a3', status: 'failed', description: 'Broke', type: 'agent' },
  ]
  await clock.advance(1100)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /All done/ })).toBeDefined()
    expect(await ui.find({ key: 'clear-completed' })).toBeDefined()
    await ui.unmount()
  }

  live = [live[0]!]
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'clear-completed' })
  await ui.unmount()

  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /Still going/ })).toBeDefined()
  expect(await after.find({ type: 'Text', text: /All done/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /Broke/ })).toBeUndefined()
  expect(await after.find({ key: 'clear-completed' })).toBeUndefined()
  await after.unmount()
})

test('View switches the main view to that agent, and Back returns', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'agent-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++n}` }))
  const views: (string | undefined)[] = []
  on('ui.view', (_, e) => {
    views.push(e.agentId)
    return { value: {} }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'Look at the repo', description: 'Scan repo' })
  await $.agent.spawn({ prompt: 'Write tests', description: 'Write tests' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'view-a2' })
    await ui.unmount()
  }
  expect(views).toEqual(['a2', 'a2'])

  const viewed = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, view: { agentId: 'a2' } } })
  expect((await viewed.find({ key: 'view-a2' }))?.text).toContain('Back')
  expect((await viewed.find({ key: 'view-a1' }))?.text).toContain('View')
  await viewed.press({ key: 'view-a2' })
  await viewed.unmount()
  expect(views).toEqual(['a2', 'a2', undefined])
})

test('a tool call shows its output under the command, and errors show too', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'agent-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('tool.call', (_, e) =>
    e.tool === 'Bash'
      ? { result: {}, text: 'README.md\nsrc\npackage.json' }
      : { isError: true, result: 'File does not exist.', text: 'File does not exist.' },
  )

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'Look around', description: 'Look around' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/nope.txt', agentId: 'a1' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const i = texts.indexOf('▸ Bash ls')
    expect(i).toBeGreaterThan(-1)
    expect(texts.slice(i + 1, i + 4)).toEqual(['  README.md', '  src', '  package.json'])
    expect(texts).toContain('  ✗ File does not exist.')
    await ui.unmount()
  }
})

const boot = async ($: any, on: any, toolText = '') => {
  mock.clock(on)
  on('tool.call', () => ({ result: {}, text: toolText }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'agent-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

test('the hand-back report shows as the answer, not as a tool call', async ($, on) => {
  await boot($, on, 'Only parts.tsx changed.')
  await $.agent.spawn({ prompt: 'Test models', description: 'Test models' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'SubagentHandback', agentId: 'a1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.some(t => /SubagentHandback/.test(t))).toBe(false)
  expect(texts).toContain('Only parts.tsx changed.')
  expect(texts.some(t => /1 tool(?!s)/.test(t))).toBe(true)
  await ui.unmount()
})

test('long text wraps at spaces, not mid-word', async ($, on) => {
  const words = 'there is nothing further to do here and the report has been delivered already'
  await boot($, on, words)
  await $.agent.spawn({ prompt: 'x', description: 'Wrap' })
  await $.tool.call({ tool: 'SubagentHandback', agentId: 'a1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 24 } })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const body = texts.filter(t => words.includes(t.trim()) && t.trim().length > 0)
  expect(body.join(' ')).toBe(words)
  await ui.unmount()
})

test('a resumed agent keeps its title and tool count and runs again', async ($, on) => {
  await boot($, on)
  await $.agent.spawn({ prompt: 'Browser-test the models', description: 'Browser-test 3D models' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'a1' } as never)
  await $.agent.spawn({ prompt: 'ok you are done', resume: { agentId: 'a1' } } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.some(t => /Browser-test 3D models/.test(t))).toBe(true)
  expect(texts.some(t => /2 tools/.test(t))).toBe(true)
  expect(texts).toContain('↪ ok you are done')
  await ui.unmount()
})

test('cleared agents stay cleared while the engine still lists them', async ($, on) => {
  const clock = mock.clock(on)
  let live = [{ id: 'a2', status: 'completed', description: 'All done', type: 'agent' }]
  on('agent.list', () => ({ value: live }))
  on('command.register', () => ({ value: { command: 'agent-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1100)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'clear-completed' })
  await ui.unmount()
  await clock.advance(3100)

  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /All done/ })).toBeUndefined()
  await after.unmount()

  // It comes back if it runs again.
  live = [{ ...live[0]!, status: 'running' }]
  await clock.advance(1100)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /All done/ })).toBeDefined()
  await again.unmount()
})

test('each card shows its model and tokens', async ($, on) => {
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    yield { kind: 'text', index: 0, text: 'Looking.' } as never
    return {
      turnId: e.turnId, index: e.index, answer: 'Looking.', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'claude-sonnet-5-5', input_tokens: 1200, output_tokens: 300,
        cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 },
    } as never
  })
  await boot($, on)
  await $.agent.spawn({ prompt: 'x', description: 'Scan' })
  for await (const _ of $.turn.step({ turnId: 't', index: 0, agentId: 'a1', model: 'claude-sonnet-5-5' } as never)) void _

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 40 } })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const meta = texts.find(t => /sonnet-5-5/.test(t))
  expect(meta).toContain('41.5k tokens')
  await ui.unmount()
})
