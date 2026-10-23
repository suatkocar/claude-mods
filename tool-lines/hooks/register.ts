import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  EngineInterface,
  Register,
  RenderElement,
  RenderNode,
  TextProps,
} from 'claude-code'

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
  return (key: string, label: string, dimColor = false, children?: RenderNode[]): RenderElement =>
    Button({
      key,
      label,
      plain: true,
      dimColor,
      // A styled line keeps its colors as children; the label stays its plain text, the control's name.
      ...(children === undefined ? {} : { children }),
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
// The plain text of drawn nodes: strings, and the children of the elements around them.
function textOf(nodes: readonly unknown[]): string {
  return nodes
    .map(node => {
      if (typeof node === 'string') return node
      if (typeof node !== 'object' || node === null) return ''
      const { children, props } = node as { children?: unknown[]; props?: { children?: unknown[] } }
      return textOf(children ?? props?.children ?? [])
    })
    .join('')
}

// The rest of a row is one press target too: a click opens or shuts it, a drag still selects its text.
function pressableLine(pressable: ReturnType<typeof pressableOf>, line: RenderNode[]): RenderNode[] {
  return [pressable('line', textOf(line), false, line)]
}

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
      // The line is a Button of its own now, so it sits in the row as it is, not inside a Text.
      Box({ flexShrink: 1, children: line }),
    ],
  })
}

// MARK: Message fold

// Each tool call belongs to the reply text the model wrote just before it; the text's row folds its calls
// under one dim summary line, and a click on that line lays them out again, each of which unfolds in turn.

type OwnedCall = { tool_use_id: string; tool: string; row: ToolRow }

// A reply's text as a key: its blocks as stored and as drawn differ only in spacing.
function textKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// Reply texts in transcript order, each with the calls the model made after it and before its next text.
let owners: { key: string; calls: OwnedCall[] }[] = []
// The owner key of every call that has one; a call made before any reply text has none and draws as before.
const ownerOfCall = new Map<string, string>()
// Message rows matched to an owner, by the row's requestId.
const ownerOfRow = new Map<string, string>()
// Owners whose text row drew the summary line, so hiding their calls never strands them out of reach.
const drawnOwners = new Set<string>()
// Owners the person opened.
const openOwners = new Set<string>()
// Replies the person opened with their bullet: only these show the summary line, and only an open summary shows the calls.
const openMessages = new Set<string>()

type Messages = readonly {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool_use_id: string; tool: string; input: unknown; result?: unknown; isError?: true }[]
  toolResults?: readonly unknown[]
}[]

// Calls that are a talk with the person, not work: the question and its answer stay as the engine draws them, never folded.
const SHOWN_AS_IS = new Set(['AskUserQuestion'])

// Calls drawn right under a typed prompt, with no reply text between: they keep the blank line the engine's rows open with.
const firstAfterPrompt = new Set<string>()

// Walks the transcript once: a reply text opens an owner, a call joins the latest, a typed prompt closes it.
function indexOf(messages: Messages): void {
  const next: { key: string; calls: OwnedCall[] }[] = []
  let current: { key: string; calls: OwnedCall[] } | undefined
  let isAfterPrompt = false
  ownerOfCall.clear()
  firstAfterPrompt.clear()
  for (const message of messages) {
    if (message.role === 'user') {
      if ((message.toolResults ?? []).length === 0 && message.text.trim() !== '') {
        current = undefined
        isAfterPrompt = true
      }
      continue
    }
    const key = textKey(message.text)
    if (key !== '') {
      current = { key, calls: [] }
      next.push(current)
      isAfterPrompt = false
    }
    for (const use of message.toolUses) {
      if (isAfterPrompt) {
        firstAfterPrompt.add(use.tool_use_id)
        isAfterPrompt = false
      }
      if (current === undefined || SHOWN_AS_IS.has(use.tool)) continue
      const finished = use.result !== undefined || use.isError === true
      current.calls.push({
        tool_use_id: use.tool_use_id,
        tool: use.tool,
        row: {
          tool: use.tool,
          input: use.input,
          output: use.result,
          isRunning: !finished,
          isErrored: use.isError === true,
          isInterrupted: false,
        },
      })
      ownerOfCall.set(use.tool_use_id, current.key)
    }
  }
  owners = next
}

// A drawn block is one text block of a reply; the stored message joins its blocks, so the latest owner holding it wins.
function ownerForText(text: string): string | undefined {
  const key = textKey(text)
  if (key === '') return undefined
  for (let i = owners.length - 1; i >= 0; i--) {
    const owner = owners[i]
    if (owner !== undefined && (owner.key === key || owner.key.endsWith(key))) return owner.key
  }
  return undefined
}

function callsOf(key: string): OwnedCall[] {
  return owners.findLast(owner => owner.key === key)?.calls ?? []
}

// A call is hidden while the reply it belongs to is drawn folded.
function isFolded(toolUseId: string): boolean {
  const owner = ownerOfCall.get(toolUseId)
  return owner !== undefined && drawnOwners.has(owner) && !(openMessages.has(owner) && openOwners.has(owner))
}

// Prose with no block markdown: no list, table, fence, heading, quote or link, which only the engine's Markdown draws.
function isPlainProse(text: string): boolean {
  return !/^\s*(?:[-*+]\s|\d+[.)]\s|#|>|\||```)/m.test(text) && !/\[[^\]]*\]\([^)]*\)/.test(text)
}

// Inline `code` and **bold**, drawn as the engine draws them in a reply; the rest is plain text.
function inlineOf(text: string, Text: ElementConstructor<TextProps>): RenderNode[] {
  return text
    .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)
    .filter(part => part !== '')
    .map(part => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return Text({ color: 'permission', children: [part.slice(1, -1)] })
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return Text({ bold: true, children: [part.slice(2, -2)] })
      return part
    })
}

// An opened reply's calls sit under its summary line's count, one level into the tree.
const CHILD_INDENT = 4

// The width a call's line may take: the screen's, less the indent of an opened reply's children.
// Calls drawn inside a group of several: the group's row carries the reply's indent, so they add none of their own.
const groupedCalls = new Set<string>()

// The indent a call's own row adds: the reply's, unless its group already gave it.
function indentOf(toolUseId: string): number {
  return isUnderOpenOwner(toolUseId) && !groupedCalls.has(toolUseId) ? CHILD_INDENT : 0
}

// The width a line may take, less every indent it sits under: the reply's, and a group's on top for a grouped call.
function columnsFor(columns: number | undefined, toolUseId: string, isGroupRow = false): number {
  const reply = isUnderOpenOwner(toolUseId) ? CHILD_INDENT : 0
  const group = !isGroupRow && groupedCalls.has(toolUseId) ? 2 : 0
  return (columns ?? FALLBACK_COLUMNS) - reply - group
}

function isUnderOpenOwner(toolUseId: string): boolean {
  const owner = ownerOfCall.get(toolUseId)
  return owner !== undefined && drawnOwners.has(owner) && openMessages.has(owner) && openOwners.has(owner)
}

// The folded reply's one line: how many calls, which tools, what they changed, and what is still running or failed.
function foldSummary(calls: readonly OwnedCall[], isOpen: boolean): { label: string; stat: StatPart[]; meta: string; metaColor?: string } {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(displayName(call.tool), (counts.get(displayName(call.tool)) ?? 0) + 1)
  const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
  const shownNames = names.length > 5 ? [...names.slice(0, 5), `+${names.length - 5}`] : names
  const changes = calls.map(call => diffstatOf(call.row)).filter((change): change is Diffstat => change !== undefined)
  const stat = statParts(
    changes.length === 0
      ? undefined
      : changes.reduce((sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed })),
  )
  const failed = calls.filter(call => call.row.isErrored).length
  const running = calls.filter(call => call.row.isRunning).length
  const meta = [running > 0 ? `${running} running` : undefined, failed > 0 ? `${failed} ${failed === 1 ? 'error' : 'errors'}` : undefined]
    .filter(part => part !== undefined)
    .join(', ')
  const count = `${calls.length} tool ${calls.length === 1 ? 'call' : 'calls'}`
  return {
    label: `${isOpen ? '▾' : '▸'} ${count} · ${shownNames.join(', ')}`,
    stat,
    meta,
    ...(failed > 0 ? { metaColor: 'error' } : running > 0 ? { metaColor: 'warning' } : {}),
  }
}

// The index is rebuilt from the transcript after each new reply or result row; a rebuild asked for mid-flight runs once more after.
let indexing: Promise<void> | undefined
let again = false
// A text row drawn before its message reached the index asks again, at most once a second.
let lastMiss = 0

async function reindex($: EngineInterface): Promise<void> {
  if (indexing !== undefined) {
    again = true
    return indexing
  }
  indexing = (async () => {
    do {
      again = false
      indexOf((await $.session.messages()) as unknown as Messages)
    } while (again)
    indexing = undefined
    $.ui.invalidate('ui.render')
  })().catch(() => {
    indexing = undefined
  })
  return indexing
}

// MARK: Hooks

export const register: Register = on => {
  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (e.door === 'response' || e.door === 'tool-result')) void reindex($)
    return result
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!isCompact(e.surface)) return next(e)
    let key = ownerOfRow.get(e.requestId) ?? ownerForText(e.props.text)
    if (key === undefined) {
      const now = Date.now()
      if (now - lastMiss > 1000) {
        lastMiss = now
        void reindex($)
      }
      return next(e)
    }
    ownerOfRow.set(e.requestId, key)
    const calls = callsOf(key)
    if (calls.length === 0) return next(e)
    if (!drawnOwners.has(key)) {
      drawnOwners.add(key)
      // Its calls drew before the summary existed; they fold now.
      $.ui.invalidate('ui.render')
    }
    const { Box, Button, Text, Markdown } = $.ui.resolve(e)
    const ownerKey = key
    // The reply's own bullet becomes its toggle: shut, the text alone; open, the summary line under it.
    const isMessageOpen = openMessages.has(key)
    const bullet = Box({
      minWidth: 2,
      flexShrink: 0,
      children: [
        Button({
          key: 'message-toggle',
          label: isMessageOpen ? '▾' : '▸',
          plain: true,
          hover: { underline: true },
          onPress: () => {
            if (openMessages.has(ownerKey)) openMessages.delete(ownerKey)
            else openMessages.add(ownerKey)
            $.ui.invalidate('ui.render')
          },
        }),
      ],
    })
    // A reply in plain prose is one press target, as its bullet is; a drag over it still selects. Block
    // markdown (lists, tables, fences, headings) needs the engine's Markdown, which a Button cannot hold.
    const body = isPlainProse(e.props.text)
      ? Button({
          key: 'message-text',
          label: e.props.text,
          plain: true,
          hover: { underline: true },
          children: inlineOf(e.props.text, Text),
          onPress: () => {
            if (openMessages.has(ownerKey)) openMessages.delete(ownerKey)
            else openMessages.add(ownerKey)
            $.ui.invalidate('ui.render')
          },
        })
      : Markdown({ text: e.props.text })
    const message = Box({
      key: 'message',
      flexDirection: 'row',
      children: [bullet, Box({ flexGrow: 1, flexShrink: 1, children: [body] })],
    })
    // The engine's reply row opens with a blank line; this one keeps that rhythm.
    if (!isMessageOpen) return Box({ flexDirection: 'column', marginTop: 1, children: [message] })
    const isOpen = openOwners.has(key)
    const summary = foldSummary(calls, isOpen)
    // The whole summary line, its counts and meta included, is the one press target.
    const parts: RenderNode[] = [
      Text({ dimColor: true, children: [summary.label] }),
      ...summary.stat.map(part => Text({ color: part.color, children: [part.text] })),
      ...(summary.meta === '' ? [] : [Text({ color: summary.metaColor, dimColor: summary.metaColor === undefined, children: [` - ${summary.meta}`] })]),
    ]
    const toggle = Button({
      key: 'fold',
      label: textOf(parts),
      plain: true,
      hover: { underline: true },
      children: parts,
      onPress: () => {
        if (openOwners.has(ownerKey)) openOwners.delete(ownerKey)
        else openOwners.add(ownerKey)
        $.ui.invalidate('ui.render')
      },
    })
    const line = Box({ key: 'fold-line', flexDirection: 'row', marginLeft: 2, children: [toggle] })
    return Box({ flexDirection: 'column', marginTop: 1, children: [message, line] })
  })

  // Paths draw against the session's folder; a reload fires session.start again, so it is learned anew.
  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    const result = await next(e)
    // A resumed session's transcript is already there; index it so its replies draw folded.
    void reindex($)
    return result
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => {
    if (e.surface === 'terminal' && e.props.isExpanded !== isExpandedView) {
      isExpandedView = e.props.isExpanded
      // Tool rows keep their last answer until asked again, so the switch has to redraw them.
      $.ui.invalidate('ui.render')
    }
    // The prompt adds no space of its own: the reply under it, or the first call (see firstAfterPrompt), brings the blank line.
    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!isCompact(e.surface) || SHOWN_AS_IS.has(e.props.tool)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    if (isFolded(e.props.tool_use_id)) return Box({})
    const draw = async () => {
    const pressable = pressableOf(e.props.tool_use_id, Button, () => $.ui.invalidate('ui.render'))
    const isOpen = unfolded.has(e.props.tool_use_id)
    const toggle = Box({ minWidth: 2, flexShrink: 0, children: [pressable('toggle', isOpen ? '▾' : '▸', true)] })
    const line = lineFor(e.props, columnsFor(e.viewport?.columns, e.props.tool_use_id))
    const metaStyle = e.props.isErrored ? { color: 'error' } : { dimColor: true }
    // Open or shut, the call keeps its own line on top, so a click on it shuts what a click on it opened.
    const compact = compactRow({ Box, Text }, toggle, dotStyle(e.props), pressable('prefix', 'tool_call: ', true), pressableLine(pressable, [
      Text({ bold: true, children: [line.tool] }),
      `(${line.subject})`,
      ...line.stat.map(part => Text({ color: part.color, children: [part.text] })),
      ...(line.meta === '' ? [] : [Text({ ...metaStyle, children: [` - ${line.meta}`] })]),
    ]))
    if (!isOpen) return compact
    // A standalone call's output is its own result block, drawn right under this line.
    if (hasResultBlock.has(e.props.tool_use_id)) return compact
    // A grouped call's output draws inside the engine's row, which follows the line, then the hide button.
    const hide = hideOf(e.props.tool_use_id, Button, () => $.ui.invalidate('ui.render'))
    return Box({
      flexDirection: 'column',
      children: [compact, Box({ marginLeft: 2, children: [await next(e)] }), Box({ marginLeft: 4, children: [hide] })],
    })
    }
    const drawn = await draw()
    // Under an opened reply, its calls step in one level, as children of the summary line.
    const indent = indentOf(e.props.tool_use_id)
    const isFirst = firstAfterPrompt.has(e.props.tool_use_id)
    if (indent === 0 && !isFirst) return drawn
    return Box({ ...(indent > 0 ? { marginLeft: indent } : {}), ...(isFirst ? { marginTop: 1 } : {}), children: [drawn] })
  })

  // A group of reads and searches folds to one line; a click unfolds it into one line per call, each of which unfolds in turn.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    // A group with no calls holds only thinking: the engine's own row says how long it took and unfolds it on a click.
    if (!isCompact(e.surface) || e.props.calls.length === 0) return next(e)
    // A group of one is no group: unfolded, its call draws as a line of its own, meta and all, like any other call.
    if (e.props.calls.length === 1) return next({ ...e, props: { ...e.props, isExpanded: true } })
    for (const call of e.props.calls) if (call.tool_use_id !== undefined) groupedCalls.add(call.tool_use_id)
    const { Box, Button, Text } = $.ui.resolve(e)
    const firstId = e.props.calls[0]?.tool_use_id ?? ''
    if (isFolded(firstId)) return Box({})
    const drawn = await drawGroup()
    const isUnder = isUnderOpenOwner(firstId)
    const isFirst = firstAfterPrompt.has(firstId)
    if (!isUnder && !isFirst) return drawn
    return Box({ ...(isUnder ? { marginLeft: CHILD_INDENT } : {}), ...(isFirst ? { marginTop: 1 } : {}), children: [drawn] })
    async function drawGroup() {
    // The first call stays first as later calls join, so its id names the group for as long as it is drawn.
    const id = `group:${e.props.calls[0]?.tool_use_id ?? e.requestId}`
    const pressable = pressableOf(id, Button, () => $.ui.invalidate('ui.render'))
    const isOpen = unfolded.has(id)
    const toggle = Box({ minWidth: 2, flexShrink: 0, children: [pressable('toggle', isOpen ? '▾' : '▸', true)] })
    const line = groupLineFor(e.props.calls, columnsFor(e.viewport?.columns, firstId, true))
    const row = compactRow({ Box, Text }, toggle, groupDotStyle(e.props.calls), pressable('prefix', 'tool_call: ', true), pressableLine(pressable, [
      Text({ bold: true, children: [line.names] }),
      ` (${line.subjects})`,
      ...line.stat.map(part => Text({ color: part.color, children: [part.text] })),
      ...(line.meta === '' ? [] : [Text({ color: 'error', children: [` - ${line.meta}`] })]),
    ]))
    if (!isOpen) return row
    // Unfolded, the engine draws each call as its own ToolUse row, which the ToolUse hook draws as one line.
    const calls = await next({ ...e, props: { ...e.props, isExpanded: true } })
    return Box({ flexDirection: 'column', children: [row, Box({ marginLeft: 2, children: [calls] })] })
    }
  })

  // The compact line already carries what the result block would say, unless the call was clicked open.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!isCompact(e.surface) || SHOWN_AS_IS.has(e.props.tool)) return next(e)
    // Recorded while still folded, so the row knows to leave the hide button to this block once unfolded.
    hasResultBlock.add(e.props.tool_use_id)
    const { Box, Button } = $.ui.resolve(e)
    if (!unfolded.has(e.props.tool_use_id) || isFolded(e.props.tool_use_id)) return Box({})
    const hide = hideOf(e.props.tool_use_id, Button, () => $.ui.invalidate('ui.render'))
    const block = Box({ flexDirection: 'column', children: [await next(e), Box({ marginLeft: 4, children: [hide] })] })
    const indent = indentOf(e.props.tool_use_id)
    return indent > 0 ? Box({ marginLeft: indent, children: [block] }) : block
  })
}
