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
function engine(on: On) {
  on('session.messages', () => ({ value: TRANSCRIPT }) as never)
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
