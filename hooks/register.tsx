import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { AgentCard, AgentStatusWord, BoardLine } from '../types'

const PANE = 'agent-board'
const TITLE = 'Agent Board'
const MAX_LOG = 300 // entries kept per card
const CARD_CHARS = 120_000 // total text kept per card; oldest entries go first
const OUT_MAX = 4000 // one tool output: head and tail kept past this
const TEXT_MAX = 8000 // one block of streamed text or thinking
const MIN_CARD_ROWS = 4

// Bump the tag whenever AgentCard's fields change: stored values outlive a reload.
const agents = atom({ plugin: 'agent-board', key: 'agents' } as const, [], {
  shape: 'agents-1',
})

// Per-card scroll position (see the contract). Not stored across sessions.
const scrollTop = atom({ plugin: 'agent-board', key: 'scrollTop' } as const, {})

// What each card last drew: its wrapped line count and body rows, for the scroll hook.
const geometry = new Map<string, { total: number; rows: number }>()

// ---------- helpers ----------

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function summarizeTool(tool: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const detail =
    pick('description') && tool === 'Bash'
      ? `${pick('description')}  $ ${pick('command')}`
      : pick('command') ??
        pick('file_path') ??
        pick('path') ??
        pick('pattern') ??
        pick('url') ??
        pick('query') ??
        pick('description') ??
        pick('prompt') ??
        ''
  return `${tool}${detail ? ' ' + oneLine(detail) : ''}`
}

function wrap(text: string, width: number): string[] {
  const w = Math.max(8, width)
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ')
    if (line.length === 0) continue
    for (let i = 0; i < line.length; i += w) out.push(line.slice(i, i + w))
  }
  return out
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const isActive = (st: AgentStatusWord) => st === 'running' || st === 'waiting' || st === 'idle'

const clearFinished = ($: EngineInterface) =>
  update($, agents, list => list.filter(c => isActive(c.status)))

// Switch the main view to an agent's transcript, or back to the main conversation.
async function viewAgent($: EngineInterface, agentId: string | undefined) {
  const r = await $.ui.view(agentId === undefined ? {} : { agentId })
  if (r.deny) $.ui.toast(`Agent Board: can't open that agent (${r.deny})`)
}

function mapStatus(s: string): AgentStatusWord {
  switch (s) {
    case 'pending':
    case 'running':
      return 'running'
    case 'waiting':
      return 'waiting'
    case 'idle':
      return 'idle'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'killed'
    default:
      return 'running'
  }
}

function newCard(id: string, now: number, fields: Partial<AgentCard> = {}): AgentCard {
  return {
    id,
    description: 'subagent',
    type: 'agent',
    status: 'running',
    startedAt: now,
    tools: 0,
    log: [],
    live: '',
    liveKind: 'none',
    ...fields,
  }
}

async function patch(
  $: EngineInterface,
  id: string,
  fn: (c: AgentCard) => AgentCard,
  create?: Partial<AgentCard>,
) {
  const now = await $.clock.now()
  await update($, agents, list => {
    const i = list.findIndex(c => c.id === id)
    if (i === -1) return [...list, fn(newCard(id, now, create))]
    const next = list.slice()
    next[i] = fn(list[i]!)
    return next
  })
}

const pushLog = (c: AgentCard, line: BoardLine): AgentCard => {
  let log = [...c.log, line].slice(-MAX_LOG)
  let size = log.reduce((n, l) => n + l.text.length, 0)
  while (size > CARD_CHARS && log.length > 1) {
    size -= log[0]!.text.length
    log = log.slice(1)
  }
  return { ...c, log }
}

// A tool's output as the agent read it; very long output keeps its head and tail.
function shapeOutput(text: string): string {
  const t = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  if (t.length <= OUT_MAX) return t
  const half = Math.floor(OUT_MAX / 2)
  return `${t.slice(0, half)}\n… ${t.length - OUT_MAX} characters cut …\n${t.slice(-half)}`
}

// Move the streaming buffer into the log as a finished line.
const settleLive = (c: AgentCard): AgentCard => {
  if (c.liveKind === 'none' || c.live.trim() === '') return { ...c, live: '', liveKind: 'none' }
  const kind = c.liveKind === 'think' ? 'think' : 'text'
  return { ...pushLog(c, { kind, text: c.live.trim().slice(-TEXT_MAX) }), live: '', liveKind: 'none' }
}

// Module-level buffers for streaming text (flushed to state on a throttle).
const buf = new Map<string, { kind: 'text' | 'think'; text: string }>()
let lastFlush = 0

async function flush($: EngineInterface, id: string, force = false) {
  const now = await $.clock.now()
  if (!force && now - lastFlush < 120) return
  lastFlush = now
  const b = buf.get(id)
  buf.delete(id)
  if (!b) return
  await patch($, id, c => {
    let card = c
    if (card.liveKind !== 'none' && card.liveKind !== b.kind) card = settleLive(card)
    return {
      ...card,
      liveKind: b.kind,
      live: (card.live + b.text).slice(-TEXT_MAX),
    }
  })
}

// Which cards show and how tall each is, for a pane body of `paneRows` rows.
function layout(list: readonly AgentCard[], paneRows: number) {
  // Active agents first (oldest first), then finished (newest first).
  const active = list.filter(c => isActive(c.status)).sort((a, b) => a.startedAt - b.startedAt)
  const done = list
    .filter(c => !isActive(c.status))
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  const ordered = [...active, ...done]
  const hasHeader = done.length > 0
  const rows = hasHeader ? paneRows - 1 : paneRows

  const fit = Math.max(1, Math.floor(rows / MIN_CARD_ROWS))
  let shown = ordered
  let room = rows
  if (ordered.length > fit) {
    shown = ordered.slice(0, fit)
    // Reserve one row for the "+n more" footer.
    while (shown.length > 1 && shown.length * MIN_CARD_ROWS > rows - 1) shown = shown.slice(0, -1)
    room = rows - 1
  }
  // Split the height evenly; hand the remainder out one row at a time.
  const base = Math.floor(room / Math.max(1, shown.length))
  const extra = room - base * shown.length
  const heights = shown.map((_, i) => base + (i < extra ? 1 : 0))
  return { active, done, shown, heights, hidden: ordered.length - shown.length, hasHeader }
}

const paneRowsOf = (bodyRows: number | undefined) => Math.max(MIN_CARD_ROWS + 1, bodyRows ?? 24)

async function openBoard($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE })
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-board',
      description: 'Open the Agent Board (args: "clear" removes finished agents)',
    })
    void openBoard($)

    // Tick: refresh elapsed timers and sync statuses with the engine's agent list.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        let live: Awaited<ReturnType<typeof $.agent.list>> = []
        try {
          live = await $.agent.list()
        } catch {
          live = []
        }
        const now = await $.clock.now()
        const known = new Set(list.map(c => c.id))
        const fresh = live.filter(a => !known.has(a.id))
        const changed = live.some(a => {
          const c = list.find(x => x.id === a.id)
          return c !== undefined && c.status !== mapStatus(a.status)
        })
        if (fresh.length > 0 || changed) {
          await update($, agents, cur => {
            let out = cur.map(c => {
              const a = live.find(x => x.id === c.id)
              if (!a) return c
              const st = mapStatus(a.status)
              if (st === c.status) return c
              return {
                ...c,
                status: st,
                endedAt: isActive(st) ? undefined : (c.endedAt ?? now),
              }
            })
            for (const a of fresh) {
              out = [
                ...out,
                newCard(a.id, now, {
                  description: a.description || a.name || 'subagent',
                  type: a.type,
                  status: mapStatus(a.status),
                }),
              ]
            }
            return out
          })
        }
        if (list.some(c => isActive(c.status))) $.ui.invalidate('ui.render')
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'agent-board' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await clearFinished($)
      await openBoard($)
      return { text: 'Agent Board: cleared finished agents.' }
    }
    await openBoard($)
    return { text: 'Agent Board opened.' }
  })

  // A subagent starts.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const id = r.agentId
      const now = await $.clock.now()
      await update($, agents, list => {
        const card = newCard(id, now, {
          description: e.description || clip(oneLine(e.prompt), 60),
          type: e.subagentType || 'general-purpose',
          model: r.model,
          log: [{ kind: 'info', text: clip(oneLine(e.prompt), 300) }],
        })
        const i = list.findIndex(c => c.id === id)
        if (i === -1) return [...list, card]
        const out = list.slice()
        const prev = list[i]!
        out[i] = { ...prev, ...card, startedAt: prev.startedAt, log: [...prev.log, ...card.log] }
        return out
      })
      void openBoard($)
    }
    return r
  })

  // Streaming model output inside a subagent.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined) return yield* next(e)

    const stream = next(e)
    let result
    for (;;) {
      const step = await stream.next()
      if (step.done) {
        result = step.value
        break
      }
      const chunk = step.value
      if (chunk.kind === 'text' || chunk.kind === 'thinking') {
        const kind = chunk.kind === 'text' ? 'text' : 'think'
        const b = buf.get(id)
        if (b && b.kind === kind) b.text += chunk.text
        else {
          if (b) await flush($, id, true)
          buf.set(id, { kind, text: chunk.text })
        }
        await flush($, id)
      } else if (chunk.kind === 'tool') {
        await flush($, id, true)
        await patch($, id, c => settleLive(c))
      } else if (chunk.kind === 'stop') {
        await flush($, id, true)
        await patch($, id, c => settleLive(c))
      }
      yield chunk
    }
    await flush($, id, true)
    await patch($, id, c => settleLive(c))
    return result
  })

  // Tool calls inside a subagent.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined) return next(e)
    const input = e as unknown as Record<string, unknown>
    const label = clip(summarizeTool(e.tool, input), 400)
    await patch($, id, c =>
      pushLog({ ...settleLive(c), tools: c.tools + 1, status: 'running' }, { kind: 'tool', text: '▸ ' + label }),
    )
    const ran = await next(e)
    if (ran.deny !== undefined) {
      await patch($, id, c => pushLog(c, { kind: 'err', text: `✗ refused: ${shapeOutput(ran.deny)}` }))
    } else if (ran.isError) {
      const why = ran.text ?? (typeof ran.result === 'string' ? ran.result : '')
      await patch($, id, c => pushLog(c, { kind: 'err', text: `✗ ${shapeOutput(why) || e.tool + ' failed'}` }))
    } else if (ran.text && ran.text.trim() !== '') {
      const out = shapeOutput(ran.text)
      await patch($, id, c => pushLog(c, { kind: 'out', text: out }))
    }
    return ran
  })

  // A subagent's turn ends.
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      buf.delete(id)
      const now = await $.clock.now()
      const status: AgentStatusWord =
        e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'killed' : 'failed'
      await patch($, id, c => {
        let card = settleLive(c)
        const ans = e.answer.trim()
        const last = card.log[card.log.length - 1]
        if (ans && !(last && last.kind === 'text' && ans.endsWith(last.text.slice(-50)))) {
          card = pushLog(card, { kind: 'text', text: ans.slice(-TEXT_MAX) })
        }
        return { ...card, status, endedAt: now }
      })
    }
    return next(e)
  })

  // ---------- scrolling ----------

  // The wheel over a card scrolls that card's own history. Scrolling down past
  // the newest line goes back to following live output.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!e.pointer) return next(e)
    const L = layout(await read($, agents), paneRowsOf(e.bodyRows))
    let row = e.pointer.row - (L.hasHeader ? 1 : 0)
    const i = L.heights.findIndex(h => (row < h ? true : ((row -= h), false)))
    const card = i === -1 ? undefined : L.shown[i]
    const g = card && geometry.get(card.id)
    if (!card || !g || g.total <= g.rows) return {}
    const id = card.id
    await update($, scrollTop, m => {
      const follow = g.total - g.rows
      const top = (m[id] ?? follow) + e.by
      const out = { ...m }
      if (top > follow) delete out[id]
      else out[id] = Math.max(0, top)
      return out
    })
    return {}
  })

  // ---------- drawing ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    const scrolled = await read($, scrollTop)
    const now = await $.clock.now()

    const paneRows = paneRowsOf(e.props.scroll?.bodyRows ?? e.viewport?.rows)
    const cols = Math.max(20, e.props.bodyColumns ?? e.viewport?.columns ?? 50)

    if (list.length === 0) {
      return (
        <Box flexDirection="column" height={paneRows}>
          <Text bold>Agent Board</Text>
          <Text dimColor>No subagents yet. They appear here as soon as one starts.</Text>
        </Box>
      )
    }

    const { active, done, shown, heights, hidden, hasHeader } = layout(list, paneRows)

    // Header row with the clear button, only while something finished is on the board.
    const header = hasHeader ? (
      <Box flexDirection="row">
        <Text dimColor>{`${active.length} running · ${done.length} finished  `}</Text>
        <Button
          key="clear-completed"
          label="Clear completed"
          hotkey="c"
          onPress={() => clearFinished($)}
        />
      </Box>
    ) : null

    const statusLook = (c: AgentCard) => {
      switch (c.status) {
        case 'running':
          return { icon: '●', color: 'green' }
        case 'waiting':
          return { icon: '◐', color: 'yellow' }
        case 'idle':
          return { icon: '○', color: 'cyan' }
        case 'done':
          return { icon: '✓', color: 'gray' }
        case 'failed':
          return { icon: '✗', color: 'red' }
        case 'killed':
          return { icon: '■', color: 'red' }
      }
    }

    const viewing = e.props.view?.agentId

    const cards = shown.map((c, i) => {
      const cardH = heights[i]!
      const inner = cols - 4 // border + padding
      const isViewed = viewing === c.id
      const viewLabel = isViewed ? 'Back' : 'View'
      const head = inner - (viewLabel.length + 5) // room left beside the "[ View ]" button
      const bodyRows = Math.max(0, cardH - 3) // two border rows + header
      const look = statusLook(c)
      const active = isActive(c.status)
      const elapsed = fmtElapsed((c.endedAt ?? now) - c.startedAt)
      // Description gets priority; metadata pieces drop off as the pane narrows.
      const model = c.model ? c.model.replace(/^claude-/, '') : ''
      const metaParts = [elapsed, `${c.tools} tools`, c.type, model].filter(Boolean)
      let meta = ''
      for (let k = metaParts.length; k >= 1; k--) {
        const m = metaParts.slice(0, k).reverse().join(' · ')
        if (head - 2 - m.length - 2 >= Math.min(c.description.length, 24)) {
          meta = m
          break
        }
      }
      const descMax = Math.max(8, head - 2 - (meta ? meta.length + 2 : 0))

      // Every line of the card's history, wrapped to the card's width.
      const all: { kind: BoardLine['kind']; text: string }[] = []
      const entries: BoardLine[] =
        c.liveKind !== 'none' && c.live.trim() !== ''
          ? [...c.log, { kind: c.liveKind === 'think' ? 'think' : 'text', text: c.live }]
          : c.log
      for (const ent of entries) {
        if (ent.kind === 'tool') all.push({ kind: 'tool', text: clip(ent.text, inner) })
        else if (ent.kind === 'out' || ent.kind === 'err') {
          for (const t of wrap(ent.text, inner - 2)) all.push({ kind: ent.kind, text: '  ' + t })
        } else for (const t of wrap(ent.text, inner)) all.push({ kind: ent.kind, text: t })
      }
      geometry.set(c.id, { total: all.length, rows: bodyRows })

      // Follow the newest lines, or show where the person scrolled to (one row
      // then goes to the "newer lines" bar).
      const top = scrolled[c.id]
      const isBack = top !== undefined && all.length > bodyRows && bodyRows >= 2
      const windowRows = isBack ? bodyRows - 1 : bodyRows
      const start = isBack
        ? Math.min(Math.max(0, top), all.length - windowRows)
        : Math.max(0, all.length - bodyRows)
      const lines = all.slice(start, start + windowRows)
      const newer = all.length - (start + lines.length)

      return (
        <Box
          flexDirection="column"
          height={cardH}
          borderStyle="round"
          borderColor={isViewed ? 'magenta' : active ? look.color : 'gray'}
          paddingX={1}
          overflow="hidden"
        >
          <Box flexDirection="row">
            <Text color={look.color} bold>
              {look.icon}{' '}
            </Text>
            <Text bold={active} dimColor={!active} wrap="truncate-end">
              {clip(c.description, descMax)}
            </Text>
            <Text dimColor wrap="truncate-end">
              {meta ? '  ' + meta : ''}
            </Text>
            <Box flexGrow={1} />
            <Button
              key={`view-${c.id}`}
              label={viewLabel}
              onPress={() => viewAgent($, isViewed ? undefined : c.id)}
            />
          </Box>
          {lines.map(l => (
            <Text
              wrap="truncate-end"
              color={
                l.kind === 'tool' ? 'cyan' : l.kind === 'info' ? 'yellow' : l.kind === 'err' ? 'red' : undefined
              }
              dimColor={l.kind === 'think' || l.kind === 'out' || !active}
              italic={l.kind === 'think'}
            >
              {l.text}
            </Text>
          ))}
          {isBack && (
            <Box flexDirection="row">
              <Text color="magenta">{`↓ ${newer} newer line${newer === 1 ? '' : 's'}  `}</Text>
              <Button
                key={`latest-${c.id}`}
                label="Latest"
                onPress={() =>
                  update($, scrollTop, m => {
                    const out = { ...m }
                    delete out[c.id]
                    return out
                  })
                }
              />
            </Box>
          )}
        </Box>
      )
    })

    return (
      <Box flexDirection="column" height={paneRows}>
        {header}
        {cards}
        {hidden > 0 && <Text dimColor>{`+${hidden} more`}</Text>}
      </Box>
    )
  })
}
