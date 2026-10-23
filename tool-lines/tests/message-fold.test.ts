import type { TestBody } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// MARK: Fixtures

// A turn as `$.session.messages()` hands it: a prompt, a reply text with two calls, their results, a closing text.
const DONE = { stdout: 'ok', stderr: '', interrupted: false }
const TRANSCRIPT = [
  { role: 'user', text: 'make two files', toolUses: [] },
  {
    role: 'assistant',
    text: 'First I write `a.txt`, then I list the folder.',
    toolUses: [
      { tool_use_id: 'toolu_w', tool: 'Write', input: { file_path: '/repo/a.txt', content: 'hi' }, result: { type: 'create', content: 'hi\n' } },
      { tool_use_id: 'toolu_l', tool: 'Bash', input: { command: 'ls' }, result: DONE },
    ],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_w' }, { tool_use_id: 'toolu_l' }] },
  {
    role: 'assistant',
    text: 'Then a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    toolUses: [{ tool_use_id: 'toolu_t', tool: 'Bash', input: { command: 'pwd' }, result: DONE }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_t' }] },
  { role: 'assistant', text: 'All done.', toolUses: [] },
]

const PROSE = TRANSCRIPT[1]!.text
const TABLE = TRANSCRIPT[3]!.text

// Nested Text children read as one line; a Button reads as its label, a Markdown as its text.
function shown(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  const { type, props } = node as { type?: string; props?: { label?: string; text?: string } }
  if (type === 'Button') return props?.label ?? ''
  if (type === 'Markdown') return props?.text ?? ''
  const children = (node as { children?: unknown[] }).children ?? []
  return children.map(shown).join('')
}

// The engine beneath: the transcript above, and a plain "engine" wherever the mod passes a site on.
function engine(on: On, transcript: readonly object[] = TRANSCRIPT) {
  on('session.messages', () => ({ value: transcript }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  clocks.set(on, mock.clock(on))
}

// One mocked clock per test, made with the test's other hooks before it first calls $.
const clocks = new Map<On, ReturnType<typeof mock.clock>>()

function mountReply($: Dollar, text: string, requestId: string) {
  return $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    props: { text, isFirstOfReply: true },
    viewport: { columns: 200, rows: 50 },
  } as never)
}

function mountCall($: Dollar, id: string, tool: string, input: object) {
  return $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolUse',
    props: { tool_use_id: id, tool, input, isRunning: false, isErrored: false, isInterrupted: false, output: DONE },
    viewport: { columns: 200, rows: 50 },
  } as never)
}

// The first drawing of a reply asks for the transcript; once that settles, the mod redraws it indexed.
async function indexed($: Dollar, on: On, text: string, requestId: string) {
  const reply = await mountReply($, text, requestId)
  await clocks.get(on)?.settle()
  return reply
}

// MARK: Folding

test("a reply with calls draws its bullet as ▸ and hides its calls", async ($, on) => {
  engine(on)
  const reply = await indexed($, on, PROSE, 'msg_fold')
  expect(shown(await reply.drawn())).toBe(`▸${PROSE}`)
  expect(shown(await (await mountCall($, 'toolu_w', 'Write', { file_path: '/repo/a.txt' })).drawn())).toBe('')
  expect(shown(await (await mountCall($, 'toolu_l', 'Bash', { command: 'ls' })).drawn())).toBe('')
})

test('a reply with no calls, and a call made before any reply text, draw as before', async ($, on) => {
  engine(on)
  expect(shown(await (await indexed($, on, 'All done.', 'msg_plain')).drawn())).toBe('engine')
  expect(shown(await (await mountCall($, 'toolu_orphan', 'Bash', { command: 'date' })).drawn())).toMatch(/^▸●tool_call: Bash\(date\)/)
})

test('the bullet opens the summary line, and the summary opens the calls one level in', async ($, on) => {
  engine(on)
  const reply = await indexed($, on, PROSE, 'msg_open')
  await reply.press({ key: 'message-toggle' })
  expect(shown(await reply.drawn())).toBe(`▾${PROSE}▸ 2 tool calls · Write, Bash +1`)
  // The summary is open only once pressed; the calls stay hidden until then.
  expect(shown(await (await mountCall($, 'toolu_l', 'Bash', { command: 'ls' })).drawn())).toBe('')
  await reply.press({ key: 'fold' })
  expect(shown(await reply.drawn())).toBe(`▾${PROSE}▾ 2 tool calls · Write, Bash +1`)
  const call = await mountCall($, 'toolu_l', 'Bash', { command: 'ls' })
  expect(shown(await call.drawn())).toBe('▸●tool_call: Bash(ls)')
  expect(((await call.drawn()) as { props?: { marginLeft?: number } }).props?.marginLeft).toBe(4)
  // Shutting the reply hides its calls again.
  await reply.press({ key: 'message-toggle' })
  expect(shown(await (await mountCall($, 'toolu_l', 'Bash', { command: 'ls' })).drawn())).toBe('')
})

// MARK: Space under the prompt

test('the first call right under a prompt starts apart from it; later calls and calls after reply text do not', async ($, on) => {
  const transcript = [
    { role: 'user', text: 'look around', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'toolu_first', tool: 'Bash', input: { command: 'ls' }, result: DONE },
        { tool_use_id: 'toolu_second', tool: 'Bash', input: { command: 'pwd' }, result: DONE },
      ],
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_first' }, { tool_use_id: 'toolu_second' }] },
    { role: 'user', text: 'now explain', toolUses: [] },
    { role: 'assistant', text: 'Checking one thing.', toolUses: [{ tool_use_id: 'toolu_owned', tool: 'Bash', input: { command: 'date' }, result: DONE }] },
  ]
  engine(on, transcript)
  // Any reply drawing asks for the index; this one has no calls of its own.
  await indexed($, on, 'nothing matches this', 'msg_none')
  const first = (await (await mountCall($, 'toolu_first', 'Bash', { command: 'ls' })).drawn()) as { props?: { marginTop?: number } }
  expect(first.props?.marginTop).toBe(1)
  expect(shown(first)).toBe('▸●tool_call: Bash(ls)')
  const second = (await (await mountCall($, 'toolu_second', 'Bash', { command: 'pwd' })).drawn()) as { props?: { marginTop?: number } }
  expect(second.props?.marginTop).toBeUndefined()
  // A call after reply text belongs to that reply, which already opens with its blank line.
  const reply = await indexed($, on, 'Checking one thing.', 'msg_owned')
  await reply.press({ key: 'message-toggle' })
  await reply.press({ key: 'fold' })
  const owned = (await (await mountCall($, 'toolu_owned', 'Bash', { command: 'date' })).drawn()) as { props?: { marginTop?: number } }
  expect(owned.props?.marginTop).toBeUndefined()
})

// MARK: Questions to the person

// A reply that runs a command and asks a question; the answer comes back as the question's result.
const ASKED = 'I check the folder, then ask you one thing.'
const QUESTION = { questions: [{ question: 'Which color do you prefer?', header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] }
const ASK_TRANSCRIPT = [
  { role: 'user', text: 'ask me a color', toolUses: [] },
  {
    role: 'assistant',
    text: ASKED,
    toolUses: [
      { tool_use_id: 'toolu_ls', tool: 'Bash', input: { command: 'ls' }, result: DONE },
      { tool_use_id: 'toolu_ask', tool: 'AskUserQuestion', input: QUESTION, result: { answers: { 'Which color do you prefer?': 'Blue' } } },
    ],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_ls' }, { tool_use_id: 'toolu_ask' }] },
  { role: 'assistant', text: 'You chose Blue.', toolUses: [] },
]

test('a question and its answer stay as the engine draws them while the reply folds its other calls', async ($, on) => {
  engine(on, ASK_TRANSCRIPT)
  const reply = await indexed($, on, ASKED, 'msg_ask')
  // Only the command folds: the summary counts it alone.
  await reply.press({ key: 'message-toggle' })
  expect(shown(await reply.drawn())).toBe(`▾${ASKED}▸ 1 tool call · Bash`)
  await reply.press({ key: 'message-toggle' })
  expect(shown(await (await mountCall($, 'toolu_ls', 'Bash', { command: 'ls' })).drawn())).toBe('')
  // Folded or not, the question row and the answer row are the engine's own.
  expect(shown(await (await mountCall($, 'toolu_ask', 'AskUserQuestion', QUESTION)).drawn())).toBe('engine')
  const answer = await $.ui.mount({
    plugin: 'tool-lines',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'toolu_ask', tool: 'AskUserQuestion', output: { answers: { 'Which color do you prefer?': 'Blue' } } },
    viewport: { columns: 200, rows: 50 },
  } as never)
  expect(shown(await answer.drawn())).toBe('engine')
})

test('a reply whose only call is a question draws as before', async ($, on) => {
  const transcript = [
    ASK_TRANSCRIPT[0]!,
    { role: 'assistant', text: 'One question first.', toolUses: [ASK_TRANSCRIPT[1]!.toolUses[1]!] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_ask' }] },
  ]
  engine(on, transcript)
  expect(shown(await (await indexed($, on, 'One question first.', 'msg_only_ask')).drawn())).toBe('engine')
})

test('plain prose is one press target with its inline code styled; block markdown keeps the engine Markdown', async ($, on) => {
  engine(on)
  const prose = await indexed($, on, PROSE, 'msg_prose')
  const text = await prose.find({ key: 'message-text' })
  expect(text?.props.label).toBe(PROSE)
  expect((await prose.find({ type: 'Text', text: /^a\.txt$/ }))?.props.color).toBe('permission')
  await prose.press({ key: 'message-text' })
  expect(shown(await prose.drawn())).toMatch(/^▾/)

  const table = await indexed($, on, TABLE, 'msg_table')
  expect(await table.find({ key: 'message-text' })).toBeUndefined()
  expect(shown(await table.drawn())).toBe(`▸${TABLE}`)
  expect(shown(await (await mountCall($, 'toolu_t', 'Bash', { command: 'pwd' })).drawn())).toBe('')
})
