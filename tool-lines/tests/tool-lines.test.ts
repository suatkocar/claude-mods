import { expect, test } from 'claude-code/testing'

// MARK: Fixtures

const BASH_ROW = {
  tool_use_id: 'toolu_1',
  tool: 'Bash',
  input: { command: 'cd /Users/arya/repo && grep -rn "needle" packages' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { stdout: 'a\nb\nc', stderr: 'Shell cwd was reset to /Users/arya/repo', interrupted: false },
}

// Nested Text children read as one line, the way the terminal paints them.
function shown(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  // A Button is a leaf whose text is its label.
  const { type, props } = node as { type?: string; props?: { label?: string } }
  if (type === 'Button') return props?.label ?? ''
  const children = (node as { children?: unknown[] }).children ?? []
  return children.map(shown).join('')
}

// The summary as drawn, apart from the toggle's and the dot's columns.
async function lineOf(ui: { drawn: () => Promise<unknown> }): Promise<string> {
  return shown(await ui.drawn()).replace(/^[▸▾]●/, '')
}

// MARK: ToolUse

test('draws a tool call as one compact line with its meta', async $ => {
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: BASH_ROW,
    viewport: { columns: 200, rows: 50 },
  })
  expect(await lineOf(ui)).toBe(
    'tool_call: Bash(cd /Users/arya/repo && grep -rn "needle" packages) - shell cwd was reset',
  )
})

test('cuts only the input so the line fits a wide terminal', async $ => {
  const long = { ...BASH_ROW, input: { command: 'echo ' + 'x'.repeat(400) } }
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: long,
    viewport: { columns: 150, rows: 50 },
  })
  const line = await lineOf(ui)
  expect(line.length).toBe(150 - 4 - 2)
  expect(line).toMatch(/…\) - shell cwd was reset$/)
})

test('lets a narrow terminal wrap to a few rows', async $ => {
  const long = { ...BASH_ROW, input: { command: 'echo ' + 'x'.repeat(400) } }
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: long,
    viewport: { columns: 60, rows: 40 },
  })
  expect((await lineOf(ui)).length).toBe(120)
})

test('colors the dot yellow while running, green when done, red when errored', async $ => {
  const dotColor = async (props: typeof BASH_ROW) => {
    const ui = await $.ui.mount({
      plugin: 'tool-lines',
      surface: 'terminal',
      component: 'ToolUse',
      props,
      viewport: { columns: 200, rows: 50 },
    })
    return (await ui.find({ type: 'Text', text: '●' }))?.props.color
  }
  expect(await dotColor({ ...BASH_ROW, isRunning: true })).toBe('warning')
  // Written by the model but not started yet: no result, not flagged running.
  expect(await dotColor({ ...BASH_ROW, output: undefined } as never)).toBe('warning')
  expect(await dotColor(BASH_ROW)).toBe('success')
  expect(await dotColor({ ...BASH_ROW, isErrored: true })).toBe('error')
})

test('leaves running to the dot and marks errored calls', async $ => {
  const running = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: { ...BASH_ROW, isRunning: true, output: undefined },
    viewport: { columns: 200, rows: 50 },
  })
  expect(await lineOf(running)).toBe('tool_call: Bash(cd /Users/arya/repo && grep -rn "needle" packages)')

  const failed = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: { ...BASH_ROW, isErrored: true, output: 'Exit code 1' },
    viewport: { columns: 200, rows: 50 },
  })
  expect(await lineOf(failed)).toMatch(/\) - error$/)
})

test('names a file tool by its path', async $ => {
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: {
      ...BASH_ROW,
      tool: 'Read',
      input: { file_path: '/Users/arya/notes.md', limit: 20 },
      output: { type: 'text' },
    },
    viewport: { columns: 200, rows: 50 },
  })
  expect(await lineOf(ui)).toBe('tool_call: Read(/Users/arya/notes.md)')
})

// MARK: Paths and diffstat

test('draws a path under the session folder relative to it, with the lines a created file added', async ($, on) => {
  // Stands for core beneath the mod, echoing the session's folder as session.start does.
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: {
      ...BASH_ROW,
      tool_use_id: 'toolu_write',
      tool: 'Write',
      input: { file_path: '/work/app/src/hesap.py', content: 'a\nb\n' },
      output: { type: 'create', filePath: '/work/app/src/hesap.py', content: 'a\nb\n', structuredPatch: [] },
    },
    viewport: { columns: 200, rows: 50 },
  })
  expect(await lineOf(ui)).toBe('tool_call: Write(src/hesap.py) +2')
})

test('draws a path outside the folder from ~, and a cut path keeps its file name', async ($, on) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/Users/sam/project' })
  const mountRead = (file_path: string, columns: number) =>
    $.ui.mount({
      plugin: 'tool-lines',
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...BASH_ROW, tool_use_id: 'toolu_read', tool: 'Read', input: { file_path }, output: { type: 'text' } },
      viewport: { columns, rows: 50 },
    })
  expect(await lineOf(await mountRead('/Users/sam/notes/todo.md', 200))).toBe('tool_call: Read(~/notes/todo.md)')
  const deep = '/Users/sam/' + 'nested/'.repeat(30) + 'todo.md'
  expect(await lineOf(await mountRead(deep, 60))).toMatch(/^tool_call: Read\(…[^…]*\/todo\.md\)$/)
})

test('shortens paths inside a command the same way', async ($, on) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const mountBash = (command: string) =>
    $.ui.mount({
      plugin: 'tool-lines',
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...BASH_ROW, tool_use_id: 'toolu_cmd', input: { command }, output: { stdout: '', stderr: '', interrupted: false } },
      viewport: { columns: 200, rows: 50 },
    })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/Users/sam/project' })
  expect(await lineOf(await mountBash("grep -n 'def ' /Users/sam/project/hesap.py /Users/sam/project/test_hesap.py"))).toBe(
    "tool_call: Bash(grep -n 'def ' hesap.py test_hesap.py)",
  )
  expect(await lineOf(await mountBash('cat /Users/sam/notes/todo.md'))).toBe('tool_call: Bash(cat ~/notes/todo.md)')
})

test('adds what an edit changed, the added lines green and the removed red', async $ => {
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: {
      ...BASH_ROW,
      tool_use_id: 'toolu_edit',
      tool: 'Edit',
      input: { file_path: '/elsewhere/hesap.py', old_string: 'return a / b', new_string: 'raise ValueError' },
      output: {
        filePath: '/elsewhere/hesap.py',
        structuredPatch: [
          { lines: [' def bol(a, b):', '-    return a / b', '+    if b == 0:', '+        raise ValueError', '+    return a / b'] },
        ],
      },
    },
    viewport: { columns: 200, rows: 50 },
  })
  expect(await lineOf(ui)).toBe('tool_call: Edit(/elsewhere/hesap.py) +3 -1')
  expect((await ui.find({ type: 'Text', text: /^ \+3$/ }))?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: /^ -1$/ }))?.props.color).toBe('error')
})

// MARK: Read, subagents and MCP tools

test('says how much of a file a Read took', async $ => {
  const mountRead = (file: object) =>
    $.ui.mount({
      plugin: 'tool-lines',
      surface: 'terminal',
      component: 'ToolUse',
      props: {
        ...BASH_ROW,
        tool_use_id: 'toolu_lines',
        tool: 'Read',
        input: { file_path: '/elsewhere/hesap.py' },
        output: { type: 'text', file: { filePath: '/elsewhere/hesap.py', content: '', startLine: 1, ...file } },
      },
      viewport: { columns: 200, rows: 50 },
    })
  expect(await lineOf(await mountRead({ numLines: 14, totalLines: 14 }))).toBe('tool_call: Read(/elsewhere/hesap.py) - 14 lines')
  expect(await lineOf(await mountRead({ numLines: 40, totalLines: 200 }))).toBe('tool_call: Read(/elsewhere/hesap.py) - 40/200 lines')
})

test('tells what a finished subagent took, and where a launched one runs', async $ => {
  const mountAgent = (output: object) =>
    $.ui.mount({
      plugin: 'tool-lines',
      surface: 'terminal',
      component: 'ToolUse',
      props: {
        ...BASH_ROW,
        tool_use_id: 'toolu_agent',
        tool: 'Agent',
        input: { description: 'Auth akışını incele', prompt: 'Read the auth flow', subagent_type: 'Explore' },
        output,
      },
      viewport: { columns: 200, rows: 50 },
    })
  const done = { status: 'completed', agentId: 'a1', content: [], totalToolUseCount: 23, totalDurationMs: 72_000, totalTokens: 9_000 }
  expect(await lineOf(await mountAgent(done))).toBe('tool_call: Agent(Auth akışını incele) - Explore, 23 tools, 1m 12s')
  const launched = { status: 'async_launched', isAsync: true, agentId: 'a2', description: 'Auth akışını incele', prompt: '' }
  expect(await lineOf(await mountAgent(launched))).toBe('tool_call: Agent(Auth akışını incele) - background')
})

test('names an MCP tool by its server and tool', async $ => {
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: { ...BASH_ROW, tool_use_id: 'toolu_mcp', tool: 'mcp__slack__conversations_history', input: { query: 'deploy' }, output: [] },
    viewport: { columns: 200, rows: 50 },
  })
  expect(await lineOf(ui)).toBe('tool_call: slack › conversations_history(deploy)')
})

// MARK: UserMessage

// The tool block still starts apart from the prompt: the first call under it opens with a blank line (message-fold.test.ts).
test('adds no space below the prompt, so a reply under it keeps the one blank line the engine gives it', async ($, on) => {
  // Stands for what the engine draws at any site the mod passes on.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: 'find the costs', origin: { kind: 'composer' }, isExpanded: false },
    viewport: { columns: 200, rows: 50 },
  } as never)
  const root = (await ui.drawn()) as { type: string; props?: { marginBottom?: number } }
  expect(root.type).toBe('Text')
  expect(root.props?.marginBottom).toBeUndefined()
  expect(shown(root)).toBe('engine')
})

// MARK: Expanded view

test('leaves tool rows to the engine while ctrl+o is open', async ($, on) => {
  // Stands for what the engine draws at any site the mod passes on.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const mountOn = (component: 'UserMessage' | 'ToolUse' | 'ToolResult', props: object) =>
    $.ui.mount({ plugin: 'tool-lines', surface: 'terminal', component, props, viewport: { columns: 200, rows: 50 } } as never)
  const prompt = { text: 'find the costs', origin: { kind: 'composer' } }

  await mountOn('UserMessage', { ...prompt, isExpanded: true })
  expect(shown(await (await mountOn('ToolUse', BASH_ROW)).drawn())).toBe('engine')
  const result = { tool_use_id: 'toolu_1', tool: 'Bash', output: BASH_ROW.output, isErrored: false }
  expect(shown(await (await mountOn('ToolResult', result)).drawn())).toBe('engine')

  await mountOn('UserMessage', { ...prompt, isExpanded: false })
  expect(shown(await (await mountOn('ToolUse', BASH_ROW)).drawn())).toMatch(/^▸●tool_call: Bash/)
})

// MARK: ToolGroup

test('folds a group of reads and searches into one line, and a click unfolds it into one row per call', async ($, on) => {
  let isExpanded: boolean | undefined
  // Stands in for the engine beneath the mod, recording what it was asked to draw.
  on('ui.render', { component: 'ToolGroup' }, async ($, e) => {
    isExpanded = e.props.isExpanded
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['engine'] })
  })
  const call = { isRunning: false, isErrored: false, isInterrupted: false, output: { type: 'text' } }
  const mountGroup = () =>
    $.ui.mount({
      plugin: 'tool-lines',
      surface: 'terminal',
      component: 'ToolGroup',
      props: {
        calls: [
          { ...call, tool_use_id: 'toolu_g1', tool: 'Read', input: { file_path: '/a.md' } },
          { ...call, tool_use_id: 'toolu_g2', tool: 'Read', input: { file_path: '/b.md' } },
          { ...call, tool_use_id: 'toolu_g3', tool: 'Bash', input: { command: 'rg -n needle' }, output: { stdout: '' } },
        ],
        isActive: false,
        isExpanded: false,
      },
      viewport: { columns: 200, rows: 50 },
    })

  const folded = await mountGroup()
  expect(await lineOf(folded)).toBe('tool_call: Read ×2, Bash (/a.md, /b.md, rg -n needle)')
  expect(isExpanded).toBeUndefined()
  await folded.press({ key: 'toggle' })

  expect(shown(await (await mountGroup()).drawn())).toBe('▾●tool_call: Read ×2, Bash (/a.md, /b.md, rg -n needle)engine')
  expect(isExpanded).toBe(true)
  await (await mountGroup()).press({ key: 'prefix' })
  expect(await lineOf(await mountGroup())).toBe('tool_call: Read ×2, Bash (/a.md, /b.md, rg -n needle)')
})

test('leaves a group of thinking alone, with no calls in it, to the engine', async ($, on) => {
  // Stands for the engine's own "Thought for 12s" row.
  on('ui.render', { component: 'ToolGroup' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['engine'] })
  })
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolGroup',
    props: { calls: [], isActive: true, isExpanded: false },
    viewport: { columns: 200, rows: 50 },
  })
  expect(shown(await ui.drawn())).toBe('engine')
})

test('a group of one call draws as that call does', async ($, on) => {
  let isExpanded: boolean | undefined
  on('ui.render', { component: 'ToolGroup' }, async ($, e) => {
    isExpanded = e.props.isExpanded
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['engine'] })
  })
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [{ tool_use_id: 'toolu_one', tool: 'Bash', input: { command: 'ls -la' }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: '' } }],
      isActive: false,
      isExpanded: false,
    },
    viewport: { columns: 200, rows: 50 },
  })
  expect(shown(await ui.drawn())).toBe('engine')
  expect(isExpanded).toBe(true)
})

test('a group adds up what its calls changed', async $ => {
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [
        { tool_use_id: 'toolu_s1', tool: 'Write', input: { file_path: '/elsewhere/a.py' }, isRunning: false, isErrored: false, isInterrupted: false, output: { type: 'create', content: 'x\ny\n', structuredPatch: [] } },
        { tool_use_id: 'toolu_s2', tool: 'Bash', input: { command: 'python3 a.py' }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: '' } },
      ],
      isActive: false,
      isExpanded: false,
    },
    viewport: { columns: 200, rows: 50 },
  })
  expect(await lineOf(ui)).toBe('tool_call: Write, Bash (/elsewhere/a.py, python3 a.py) +2')
})

test("draws Claude Code's scratchpad as scratchpad/, in a path and inside a command", async $ => {
  const scratch = '/private/tmp/claude-501/-Users-sam-project/85f4f3b4-d4b1-4485-bc3c-8bfd94bcfecb/scratchpad'
  const mountCall = (tool: string, input: object) =>
    $.ui.mount({
      plugin: 'tool-lines',
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...BASH_ROW, tool_use_id: `toolu_scratch_${tool}`, tool, input, output: { stdout: '', stderr: '', interrupted: false } },
      viewport: { columns: 200, rows: 50 },
    })
  expect(await lineOf(await mountCall('Read', { file_path: `${scratch}/mutate.py` }))).toBe('tool_call: Read(scratchpad/mutate.py)')
  expect(await lineOf(await mountCall('Bash', { command: `python3 ${scratch}/mutate.py` }))).toBe('tool_call: Bash(python3 scratchpad/mutate.py)')
})

test("a group's dot and meta sum up its calls", async $ => {
  const call = { isRunning: false, isErrored: false, isInterrupted: false, output: { type: 'text' } }
  const mountGroup = (calls: object[]) =>
    $.ui.mount({
      plugin: 'tool-lines',
      surface: 'terminal',
      component: 'ToolGroup',
      props: { calls, isActive: true, isExpanded: false },
      viewport: { columns: 200, rows: 50 },
    } as never)
  const dotOf = async (ui: Awaited<ReturnType<typeof mountGroup>>) => (await ui.find({ type: 'Text', text: '●' }))?.props.color

  const running = await mountGroup([
    { ...call, tool_use_id: 'toolu_d1', tool: 'Read', input: { file_path: '/a.md' } },
    { ...call, tool_use_id: 'toolu_d2', tool: 'Read', input: { file_path: '/b.md' }, isRunning: true, output: undefined },
  ])
  expect(await dotOf(running)).toBe('warning')

  const failed = await mountGroup([
    { ...call, tool_use_id: 'toolu_d3', tool: 'Read', input: { file_path: '/a.md' } },
    { ...call, tool_use_id: 'toolu_d4', tool: 'Read', input: { file_path: '/missing.md' }, isErrored: true, output: 'File does not exist.' },
  ])
  expect(await dotOf(failed)).toBe('error')
  expect(await lineOf(failed)).toBe('tool_call: Read ×2 (/a.md, /missing.md) - 1 error')
  expect((await failed.find({ type: 'Text', text: /^ - 1 error$/ }))?.props.color).toBe('error')
})

// MARK: ToolResult

test('hides the result block', async $ => {
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'toolu_1', tool: 'Bash', output: BASH_ROW.output, isErrored: false },
    viewport: { columns: 200, rows: 50 },
  })
  expect(shown(await ui.drawn())).toBe('')
})

// MARK: Unfolding one call

// Unfolded, a standalone call keeps its own pressable line on top, so a second click on that line folds it; its output is its result block.
test('a click unfolds one call into its line and its result, and a second folds it', async ($, on) => {
  // Stands for what the engine draws at any site the mod passes on.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const row = { ...BASH_ROW, tool_use_id: 'toolu_unfold' }
  const result = { tool_use_id: 'toolu_unfold', tool: 'Bash', output: BASH_ROW.output, isErrored: false }
  const mountOn = (component: 'ToolUse' | 'ToolResult', props: object) =>
    $.ui.mount({ plugin: 'tool-lines', surface: 'terminal', component, props, viewport: { columns: 200, rows: 50 } } as never)

  // The engine draws the folded result block alongside the row, before any click.
  await mountOn('ToolResult', result)
  const use = await mountOn('ToolUse', row)
  expect((await use.find({ key: 'toggle' }))?.props.label).toBe('▸')
  await use.press({ key: 'toggle' })

  expect(shown(await (await mountOn('ToolUse', row)).drawn())).toMatch(/^▾●tool_call: Bash\(.*\) - shell cwd was reset$/)
  expect(shown(await (await mountOn('ToolResult', result)).drawn())).toBe('enginehide')
  const open = await mountOn('ToolUse', row)
  expect((await open.find({ key: 'toggle' }))?.props.label).toBe('▾')
  await open.press({ key: 'toggle' })

  expect(shown(await (await mountOn('ToolUse', row)).drawn())).toMatch(/^▸●tool_call: Bash/)
  expect(shown(await (await mountOn('ToolResult', result)).drawn())).toBe('')
})

test('unfolding one call leaves the others compact', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const mountRow = (id: string) =>
    $.ui.mount({
      plugin: 'tool-lines',
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...BASH_ROW, tool_use_id: id },
      viewport: { columns: 200, rows: 50 },
    })
  await (await mountRow('toolu_a')).press({ key: 'toggle' })
  expect(shown(await (await mountRow('toolu_a')).drawn())).toMatch(/^▾●tool_call: Bash\(.*\) - shell cwd was resetenginehide$/)
  expect(shown(await (await mountRow('toolu_b')).drawn())).toMatch(/^▸●tool_call: Bash/)
})

// The whole row is pressable: the triangle, "tool_call:" and the rest of the line, whose parts keep their own styles.
// A drag over a Button still selects its text (measured in the terminal, 2026-10-22), so copying is not lost.
test('the triangle, "tool_call:" and the rest of the line unfold the call; the line keeps its styles', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const mountRow = (id: string) =>
    $.ui.mount({
      plugin: 'tool-lines',
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...BASH_ROW, tool_use_id: id },
      viewport: { columns: 200, rows: 50 },
    })
  const folded = await mountRow('toolu_plain')
  expect(await folded.find({ key: 'call' })).toBeUndefined()
  expect(await folded.find({ key: 'meta' })).toBeUndefined()
  expect((await folded.find({ type: 'Text', text: /^Bash$/ }))?.props.bold).toBe(true)
  expect((await folded.find({ key: 'line' }))?.props.label).toBe(
    'Bash(cd /Users/arya/repo && grep -rn "needle" packages) - shell cwd was reset',
  )
  for (const key of ['toggle', 'prefix', 'line']) {
    const id = `toolu_${key}`
    await (await mountRow(id)).press({ key })
    expect(shown(await (await mountRow(id)).drawn())).toMatch(/^▾●tool_call: Bash\(.*\) - shell cwd was resetenginehide$/)
  }
  // The line stays on top once unfolded, and a press on it folds the call again.
  await (await mountRow('toolu_line')).press({ key: 'line' })
  expect(shown(await (await mountRow('toolu_line')).drawn())).toMatch(/^▸●tool_call: Bash/)
})

test('keeps an error red', async $ => {
  const ui = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: { ...BASH_ROW, tool_use_id: 'toolu_err', isErrored: true, output: 'Exit code 1' },
    viewport: { columns: 200, rows: 50 },
  })
  expect((await ui.find({ type: 'Text', text: /^ - error$/ }))?.props.color).toBe('error')
})

// MARK: Hide button

test('hide under an unfolded result block folds the call', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const row = { ...BASH_ROW, tool_use_id: 'toolu_hide' }
  const result = { tool_use_id: 'toolu_hide', tool: 'Bash', output: BASH_ROW.output, isErrored: false }
  const mountOn = (component: 'ToolUse' | 'ToolResult', props: object) =>
    $.ui.mount({ plugin: 'tool-lines', surface: 'terminal', component, props, viewport: { columns: 200, rows: 50 } } as never)

  await mountOn('ToolResult', result)
  await (await mountOn('ToolUse', row)).press({ key: 'prefix' })
  expect(await (await mountOn('ToolUse', row)).find({ key: 'hide' })).toBeUndefined()
  await (await mountOn('ToolResult', result)).press({ key: 'hide' })

  expect(shown(await (await mountOn('ToolUse', row)).drawn())).toMatch(/^▸●tool_call: Bash/)
  expect(shown(await (await mountOn('ToolResult', result)).drawn())).toBe('')
})

test('a grouped call, whose output draws inline, gets hide at the end of its row', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const mountRow = () =>
    $.ui.mount({
      plugin: 'tool-lines',
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...BASH_ROW, tool_use_id: 'toolu_grouped', tool: 'Read', input: { file_path: '/a.md' }, output: { type: 'text' } },
      viewport: { columns: 200, rows: 50 },
    })
  await (await mountRow()).press({ key: 'prefix' })
  const open = await mountRow()
  expect(shown(await open.drawn())).toBe('▾●tool_call: Read(/a.md)enginehide')
  await open.press({ key: 'hide' })
  expect(shown(await (await mountRow()).drawn())).toMatch(/^▸●tool_call: Read/)
})
