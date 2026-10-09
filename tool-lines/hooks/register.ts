import type { BoxProps, ButtonProps, ElementConstructor, Register, RenderElement, RenderNode, TextProps } from 'claude-code'

// MARK: Layout

// Wide terminals fit the whole line on one row; narrow ones may wrap, up to MAX_ROWS.
const MIN_CHARS = 120
const MAX_ROWS = 3
// The engine indents transcript rows, so a line sized to the full width would spill onto a second row.
const GUTTER = 4
// The viewport is absent until the terminal has been measured.
const FALLBACK_COLUMNS = 120

// MARK: Row facts

type ToolRow = {
  tool: string
  input: unknown
  output?: unknown
  isRunning: boolean
  isErrored: boolean
  isInterrupted: boolean
}

// Input fields that name what a call acts on, most telling first; add a key here to cover a new tool.
const SUBJECT_KEYS = [
  'command',
  'file_path',
  'notebook_path',
  'pattern',
  'url',
  'query',
  'skill',
  'description',
  'path',
  'action',
  'prompt',
]

// Input fields holding a path: drawn short, and cut from the front so the file name stays.
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path'])

type Subject = { text: string; isPath: boolean }

// This extracts the main argument of a tool call. Tools with no known key fall back to their raw
// JSON so the line is never blank, and whitespace is collapsed so a multi-line command can't break
// the line apart.
function subjectOf(input: unknown): Subject {
  if (typeof input !== 'object' || input === null) return { text: '', isPath: false }
  const fields = input as Record<string, unknown>
  const key = SUBJECT_KEYS.find(name => typeof fields[name] === 'string' && fields[name] !== '')
  if (key !== undefined && PATH_KEYS.has(key)) return { text: shortPath(String(fields[key])), isPath: true }
  const raw =
    key !== undefined ? String(fields[key]) : Object.keys(fields).length > 0 ? JSON.stringify(fields) : ''
  return { text: shortPathsIn(raw.replace(/\s+/g, ' ').trim()), isPath: false }
}

// MARK: Paths

// The session's folder, learned at session.start; a path under it draws relative to it.
let sessionCwd: string | undefined

// Home is read off the session's folder, so the mod needs no access to the environment.
function homeOf(cwd: string | undefined): string | undefined {
  return cwd?.match(/^\/(?:Users|home)\/[^/]+(?=\/|$)/)?.[0]
}

// Claude Code's scratchpad, /tmp/claude-<uid>/<project>/<session>/scratchpad, says only that it is the scratchpad.
const SCRATCHPAD = /(?:\/private)?\/tmp\/claude-\d+\/[^/\s]+\/[0-9a-f-]{36}\/scratchpad(?=\/|\s|$)/g

// A path draws the way a person would type it in the session: relative to its folder, else from ~.
function shortPath(path: string): string {
  const scratch = path.replace(SCRATCHPAD, 'scratchpad')
  if (scratch !== path) return scratch
  if (sessionCwd !== undefined) {
    if (path === sessionCwd) return '.'
    if (path.startsWith(sessionCwd + '/')) return path.slice(sessionCwd.length + 1)
  }
  const home = homeOf(sessionCwd)
  if (home !== undefined && (path === home || path.startsWith(home + '/'))) return '~' + path.slice(home.length)
  return path
}

// Paths inside a command or any other argument shorten the same way, so a grep over the folder's files reads short.
function shortPathsIn(text: string): string {
  const scratch = text.replace(SCRATCHPAD, 'scratchpad')
  const inFolder = sessionCwd !== undefined && sessionCwd !== '/' ? scratch.split(sessionCwd + '/').join('') : scratch
  const home = homeOf(sessionCwd)
  return home === undefined ? inFolder : inFolder.split(home + '/').join('~/')
}

// MARK: Tool names

// An MCP tool is named mcp__<server>__<tool>; it draws as "server › tool".
function displayName(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return mcp === null ? tool : `${mcp[1]} › ${mcp[2]}`
}

// An errored call's output is the plain text the model read, so only an object carries result fields.
function resultField(row: ToolRow, name: string): unknown {
  return typeof row.output === 'object' && row.output !== null
    ? (row.output as Record<string, unknown>)[name]
    : undefined
}

// A duration as a person reads it: 45s, 1m 12s, 1h 3m.
function durationOf(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// Each probe surfaces one fact the hidden result block would have shown; add one here to extend the meta.
type MetaProbe = (row: ToolRow) => string | undefined

const META_PROBES: MetaProbe[] = [
  row => (row.isInterrupted ? 'interrupted' : undefined),
  row => (row.isErrored && !row.isInterrupted ? 'error' : undefined),
  row => (resultField(row, 'backgroundTaskId') !== undefined ? 'background' : undefined),
  row => (resultField(row, 'timedOutAfterMs') !== undefined ? 'timed out' : undefined),
  row => {
    const printed = `${resultField(row, 'stdout') ?? ''}\n${resultField(row, 'stderr') ?? ''}`
    return /Shell cwd was reset/.test(printed) ? 'shell cwd was reset' : undefined
  },
  row => {
    const note = resultField(row, 'returnCodeInterpretation')
    return typeof note === 'string' && note !== '' ? note : undefined
  },
  // A Read says how much of the file it took: all of it, or a slice of a longer one.
  row => {
    const file = resultField(row, 'file')
    if (resultField(row, 'type') !== 'text' || typeof file !== 'object' || file === null) return undefined
    const { numLines, totalLines } = file as { numLines?: unknown; totalLines?: unknown }
    if (typeof numLines !== 'number') return undefined
    return typeof totalLines === 'number' && totalLines > numLines ? `${numLines}/${totalLines} lines` : `${numLines} lines`
  },
  // A subagent says where it went when it runs elsewhere, and once done, its type, its tool calls and its time.
  row => {
    const status = resultField(row, 'status')
    if (status === 'async_launched') return 'background'
    if (status === 'remote_launched') return 'remote'
    const tools = resultField(row, 'totalToolUseCount')
    const ms = resultField(row, 'totalDurationMs')
    if (typeof tools !== 'number' || typeof ms !== 'number') return undefined
    const type = (row.input as { subagent_type?: unknown } | null)?.subagent_type ?? resultField(row, 'agentType')
    return [typeof type === 'string' ? type : undefined, `${tools} ${tools === 1 ? 'tool' : 'tools'}`, durationOf(ms)]
      .filter(part => part !== undefined)
      .join(', ')
  },
]

// MARK: Diffstat

// What an edit changed, in lines, as the engine's own patch counts them; a created file is all added.
type Diffstat = { added: number; removed: number }

function diffstatOf(row: ToolRow): Diffstat | undefined {
  const patch = resultField(row, 'structuredPatch')
  if (Array.isArray(patch) && patch.length > 0) {
    const lines = patch.flatMap(hunk => {
      const hunkLines = (hunk as { lines?: unknown }).lines
      return Array.isArray(hunkLines) ? hunkLines.filter((line): line is string => typeof line === 'string') : []
    })
    return {
      added: lines.filter(line => line.startsWith('+')).length,
      removed: lines.filter(line => line.startsWith('-')).length,
    }
  }
  const content = resultField(row, 'content')
  if (resultField(row, 'type') !== 'create' || typeof content !== 'string' || content === '') return undefined
  return { added: content.split('\n').length - (content.endsWith('\n') ? 1 : 0), removed: 0 }
}

type StatPart = { text: string; color: string }

// Added lines in the theme's green, removed in its red; a side with nothing to count is left out.
function statParts(stat: Diffstat | undefined): StatPart[] {
  if (stat === undefined) return []
  return [
    ...(stat.added > 0 ? [{ text: ` +${stat.added}`, color: 'success' }] : []),
    ...(stat.removed > 0 ? [{ text: ` -${stat.removed}`, color: 'error' }] : []),
  ]
}

// MARK: Line

type ToolLine = { tool: string; subject: string; stat: StatPart[]; meta: string }

// A cut path keeps its end, where the file name is; any other subject keeps its start.
function clip(text: string, room: number, keepEnd = false): string {
  if (text.length <= room) return text
  if (room <= 1) return '…'
  return keepEnd ? '…' + text.slice(text.length - (room - 1)) : text.slice(0, room - 1) + '…'
}

// The characters a line may take: one row on a wide terminal, up to MAX_ROWS on a narrow one.
function budgetOf(columns: number): number {
  // 2 is the dot's column, which the summary text sits beside.
  const width = Math.max(columns - GUTTER - 2, 20)
  return Math.min(Math.max(width, MIN_CHARS), width * MAX_ROWS)
}

// The subject is the only part cut, so the tool name, diffstat and meta always stay readable.
function lineFor(row: ToolRow, columns: number): ToolLine {
  const meta = META_PROBES.map(probe => probe(row))
    .filter(note => note !== undefined)
    .join(', ')
  const tool = displayName(row.tool)
  const stat = statParts(diffstatOf(row))
  const frame =
    `tool_call: ${tool}()`.length +
    stat.reduce((length, part) => length + part.text.length, 0) +
    (meta === '' ? 0 : ` - ${meta}`.length)
  const subject = subjectOf(row.input)
  return { tool, subject: clip(subject.text, budgetOf(columns) - frame, subject.isPath), stat, meta }
}

// MARK: Status

// The dot alone carries the call's state, so the line needs no "running" text. Theme keys follow
// the person's theme: warning is its yellow, success its green, error its red.
function dotStyle(row: ToolRow): { color: string } {
  if (row.isErrored || row.isInterrupted) return { color: 'error' }
  // isRunning is false while a call waits its turn or its approval, so only a stored result marks it done.
  return row.isRunning || row.output === undefined ? { color: 'warning' } : { color: 'success' }
}

// MARK: Groups

type GroupLine = { names: string; subjects: string; stat: StatPart[]; meta: string }

// A group of reads and searches is one line: each tool once with its count, then the calls' subjects, cut to fit.
function groupLineFor(calls: readonly ToolRow[], columns: number): GroupLine {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(displayName(call.tool), (counts.get(displayName(call.tool)) ?? 0) + 1)
  const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ')
  const failed = calls.filter(call => call.isErrored || call.isInterrupted).length
  const meta = failed === 0 ? '' : `${failed} ${failed === 1 ? 'error' : 'errors'}`
  const subjects = [...new Set(calls.map(call => subjectOf(call.input).text).filter(text => text !== ''))].join(', ')
  // What the group's edits changed together, so a write that joined a group still shows its lines.
  const changes = calls.map(diffstatOf).filter((change): change is Diffstat => change !== undefined)
  const stat = statParts(
    changes.length === 0
      ? undefined
      : changes.reduce((sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed })),
  )
  // A space sets the subjects apart from the names, since they belong to every call, not the last tool named.
  const frame =
    `tool_call: ${names} ()`.length +
    stat.reduce((length, part) => length + part.text.length, 0) +
    (meta === '' ? 0 : ` - ${meta}`.length)
  return { names, subjects: clip(subjects, budgetOf(columns) - frame), stat, meta }
}

// The group's dot sums up its calls' dots: red if any failed, yellow while any is unfinished, green once all are done.
function groupDotStyle(calls: readonly ToolRow[]): { color: string } {
  const colors = calls.map(call => dotStyle(call).color)
  if (colors.includes('error')) return { color: 'error' }
  return colors.includes('warning') ? { color: 'warning' } : { color: 'success' }
}

// MARK: View

// Tool rows don't say whether the ctrl+o transcript (or --verbose) is open, but the person's own
// prompt rows do; their flag is mirrored here so every tool site leaves that view to the engine.
let isExpandedView = false

function isCompact(surface: string): boolean {
  return surface === 'terminal' && !isExpandedView
}

// MARK: Unfolded rows

// Calls the person clicked open: each draws as the engine's own row, result block and all, until clicked shut.
const unfolded = new Set<string>()

// Calls whose output the engine draws in a ToolResult block of its own; a grouped read or search draws it inline in its row.
const hasResultBlock = new Set<string>()

type ButtonOf = (props: ButtonProps) => RenderElement

// Only a Button takes a click, so the row's two clickable pieces, the triangle and "tool_call:", are Buttons running one toggle.
// Each reads the set when pressed, not when drawn, so a press on a stale drawing still flips the row.
function pressableOf(id: string, Button: ButtonOf, onToggle: () => void) {
  return (key: string, label: string, dimColor = false): RenderElement =>
    Button({
      key,
      label,
      plain: true,
      dimColor,
      // The row's keyed Box scopes this, so hovering the row underlines both pieces.
      hover: { underline: true },
      onPress: () => {
        if (unfolded.has(id)) unfolded.delete(id)
        else unfolded.add(id)
        onToggle()
      },
    })
}

// Closes an unfolded call from below its output, so a long result needs no scroll back to its ▾.
function hideOf(id: string, Button: ButtonOf, onHide: () => void): RenderElement {
  return Button({
    key: 'hide',
    label: 'hide',
    dimColor: true,
    onPress: () => {
      unfolded.delete(id)
      onHide()
    },
  })
}

// MARK: Drawing

type Draw = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps> }

// One compact row, a call's or a group's: the toggle, the status dot, the "tool_call:" press target, then the line.
function compactRow(draw: Draw, toggle: RenderElement, dot: { color: string }, prefix: RenderElement, line: RenderNode[]) {
  const { Box, Text } = draw
  return Box({
    key: 'row',
    flexDirection: 'row',
    children: [
      toggle,
      // The dot's own column keeps wrapped rows aligned under the text, as the engine's tool rows do.
      Box({ minWidth: 2, flexShrink: 0, children: [Text({ ...dot, children: ['●'] })] }),
      Box({ flexShrink: 0, children: [prefix] }),
      Box({ flexShrink: 1, children: [Text({ wrap: 'wrap', children: line })] }),
    ],
  })
}

// MARK: Hooks

export const register: Register = on => {
  // Paths draw against the session's folder; a reload fires session.start again, so it is learned anew.
  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    return next(e)
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => {
    if (e.surface === 'terminal' && e.props.isExpanded !== isExpandedView) {
      isExpandedView = e.props.isExpanded
      // Tool rows keep their last answer until asked again, so the switch has to redraw them.
      $.ui.invalidate('ui.render')
    }
    if (!isCompact(e.surface)) return next(e)
    const { Box } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', marginBottom: 1, children: [await next(e)] })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!isCompact(e.surface)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const pressable = pressableOf(e.props.tool_use_id, Button, () => $.ui.invalidate('ui.render'))
    const isOpen = unfolded.has(e.props.tool_use_id)
    const toggle = Box({ minWidth: 2, flexShrink: 0, children: [pressable('toggle', isOpen ? '▾' : '▸', true)] })
    if (isOpen) {
      // The engine's row opens with a blank line, so the triangle steps down one to sit beside its ⏺.
      const openToggle = Box({ minWidth: 2, flexShrink: 0, marginTop: 1, children: [pressable('toggle', '▾', true)] })
      const row = Box({ key: 'row', flexDirection: 'row', children: [openToggle, Box({ flexGrow: 1, flexShrink: 1, children: [await next(e)] })] })
      if (hasResultBlock.has(e.props.tool_use_id)) return row
      const hide = hideOf(e.props.tool_use_id, Button, () => $.ui.invalidate('ui.render'))
      return Box({ flexDirection: 'column', children: [row, Box({ marginLeft: 4, children: [hide] })] })
    }
    const line = lineFor(e.props, e.viewport?.columns ?? FALLBACK_COLUMNS)
    const metaStyle = e.props.isErrored ? { color: 'error' } : { dimColor: true }
    return compactRow({ Box, Text }, toggle, dotStyle(e.props), pressable('prefix', 'tool_call: ', true), [
      Text({ bold: true, children: [line.tool] }),
      `(${line.subject})`,
      ...line.stat.map(part => Text({ color: part.color, children: [part.text] })),
      ...(line.meta === '' ? [] : [Text({ ...metaStyle, children: [` - ${line.meta}`] })]),
    ])
  })

  // A group of reads and searches folds to one line; a click unfolds it into one line per call, each of which unfolds in turn.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    // A group with no calls holds only thinking: the engine's own row says how long it took and unfolds it on a click.
    if (!isCompact(e.surface) || e.props.calls.length === 0) return next(e)
    // A group of one is no group: unfolded, its call draws as a line of its own, meta and all, like any other call.
    if (e.props.calls.length === 1) return next({ ...e, props: { ...e.props, isExpanded: true } })
    const { Box, Button, Text } = $.ui.resolve(e)
    // The first call stays first as later calls join, so its id names the group for as long as it is drawn.
    const id = `group:${e.props.calls[0]?.tool_use_id ?? e.requestId}`
    const pressable = pressableOf(id, Button, () => $.ui.invalidate('ui.render'))
    const isOpen = unfolded.has(id)
    const toggle = Box({ minWidth: 2, flexShrink: 0, children: [pressable('toggle', isOpen ? '▾' : '▸', true)] })
    const line = groupLineFor(e.props.calls, e.viewport?.columns ?? FALLBACK_COLUMNS)
    const row = compactRow({ Box, Text }, toggle, groupDotStyle(e.props.calls), pressable('prefix', 'tool_call: ', true), [
      Text({ bold: true, children: [line.names] }),
      ` (${line.subjects})`,
      ...line.stat.map(part => Text({ color: part.color, children: [part.text] })),
      ...(line.meta === '' ? [] : [Text({ color: 'error', children: [` - ${line.meta}`] })]),
    ])
    if (!isOpen) return row
    // Unfolded, the engine draws each call as its own ToolUse row, which the ToolUse hook draws as one line.
    const calls = await next({ ...e, props: { ...e.props, isExpanded: true } })
    return Box({ flexDirection: 'column', children: [row, Box({ marginLeft: 2, children: [calls] })] })
  })

  // The compact line already carries what the result block would say, unless the call was clicked open.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!isCompact(e.surface)) return next(e)
    // Recorded while still folded, so the row knows to leave the hide button to this block once unfolded.
    hasResultBlock.add(e.props.tool_use_id)
    const { Box, Button } = $.ui.resolve(e)
    if (!unfolded.has(e.props.tool_use_id)) return Box({})
    const hide = hideOf(e.props.tool_use_id, Button, () => $.ui.invalidate('ui.render'))
    return Box({ flexDirection: 'column', children: [await next(e), Box({ marginLeft: 4, children: [hide] })] })
  })
}
