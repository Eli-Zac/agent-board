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
